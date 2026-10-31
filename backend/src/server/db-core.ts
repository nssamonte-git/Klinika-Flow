import { assertRequestAccess, usageActor, observeReservation } from "./request-context";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { TextCallRecord } from "../domain/text-usage";
import type { Encounter } from "../domain/schema";
import { normalizeAttempts } from "../domain/workflow";
import { WorkflowError } from "../domain/workflow";

let singleton: DatabaseSync | undefined;
export function db(): DatabaseSync {
  if (singleton) return singleton;
  const path = process.env.DATABASE_PATH || "data/klinikaflow.sqlite";
  const existingFile = path !== ":memory:" && existsSync(path);
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  singleton = new DatabaseSync(path);
  singleton.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS encounters (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, version INTEGER NOT NULL, body TEXT NOT NULL, audio BLOB, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, reserved REAL NOT NULL, actual REAL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS teach_back_audio (encounter TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE, question TEXT NOT NULL, sheet_fingerprint TEXT NOT NULL, audio BLOB NOT NULL, PRIMARY KEY(encounter,question));
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
  `);
  const version = Number(singleton.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version < 6 && existingFile) {
    const backupPath = `${resolve(path)}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    singleton.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    chmodSync(backupPath, 0o600);
  }
  if (version < 1) {
    singleton.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS teach_back_attempt_audio (encounter TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE, question TEXT NOT NULL, attempt TEXT NOT NULL, sheet_fingerprint TEXT NOT NULL, audio BLOB NOT NULL, PRIMARY KEY(encounter,question,attempt));
      INSERT OR IGNORE INTO teach_back_attempt_audio(encounter,question,attempt,sheet_fingerprint,audio) SELECT encounter,question,'legacy-1',sheet_fingerprint,audio FROM teach_back_audio;
      PRAGMA user_version=1; COMMIT;`);
  }
  if (version < 2) singleton.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS plan_question_audio (encounter TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE, question_id TEXT NOT NULL, audio BLOB NOT NULL, PRIMARY KEY(encounter,question_id));
    PRAGMA user_version=2; COMMIT;`);
  if (version < 3) singleton.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS source_documents (encounter TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE, document_id TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(encounter,document_id));
    PRAGMA user_version=3; COMMIT;`);
  if (version < 4) singleton.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS text_calls (reservation TEXT PRIMARY KEY REFERENCES reservations(id), metadata TEXT NOT NULL);
    PRAGMA user_version=4; COMMIT;`);
  if (version < 5) {
    // Workspace ownership outlives authentication. Rebuild only the parent table,
    // leaving every child audio/document foreign key and encounter ID unchanged.
    singleton.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), status TEXT NOT NULL CHECK(status IN ('pending','active','suspended')), created INTEGER NOT NULL, approved_at INTEGER, approved_by TEXT, last_login INTEGER);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), kind TEXT NOT NULL DEFAULT 'legacy');
      INSERT INTO workspaces(id) SELECT id FROM sessions;
      CREATE TABLE account_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE account_audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE encounters_v5 (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES workspaces(id), version INTEGER NOT NULL, body TEXT NOT NULL, audio BLOB, created INTEGER NOT NULL);
      INSERT INTO encounters_v5 SELECT * FROM encounters;
      DROP TABLE encounters; ALTER TABLE encounters_v5 RENAME TO encounters;
      ALTER TABLE reservations ADD COLUMN user_id TEXT REFERENCES users(id);
      CREATE INDEX workspace_user ON workspaces(user_id);
      CREATE INDEX session_user ON account_sessions(user_id);
      PRAGMA user_version=5; COMMIT; PRAGMA foreign_keys=ON;`);
    if (singleton.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Ownership migration integrity check failed.");
  }
  if (version < 6) singleton.exec(`BEGIN IMMEDIATE;
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, encounter TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE, owner TEXT NOT NULL REFERENCES workspaces(id), status TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE UNIQUE INDEX agent_one_active ON agent_runs(encounter) WHERE status IN ('ready','awaiting_tool','executing','paused');
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, encounter TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE, owner TEXT NOT NULL REFERENCES workspaces(id), request_key TEXT NOT NULL, signature TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(owner,encounter,request_key));
    PRAGMA user_version=6; COMMIT;`);
  return singleton;
}
export function closeDb() { singleton?.close(); singleton = undefined; }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function getSession(token: string | undefined): { id: string; role: "judge" | "studio" } | null {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db().prepare("SELECT s.id, s.role FROM sessions s JOIN workspaces w ON w.id=s.id WHERE s.id=? AND s.expires>? AND w.user_id IS NULL").get(hash(token), Date.now());
  return row ? { id: String(row.id), role: "judge" } : null;
}
export function createSession(role: "judge" | "studio" = "judge") {
  const token = randomBytes(32).toString("hex"), id = hash(token);
  db().prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
  db().prepare("DELETE FROM jobs WHERE created<?").run(Date.now() - 24 * 60 * 60 * 1000);
  db().prepare("DELETE FROM limits WHERE reset<?").run(Date.now());
  db().prepare("INSERT INTO workspaces(id,kind) VALUES(?,'demo')").run(id);
  db().prepare("INSERT INTO sessions VALUES(?,?,?)").run(id, role, Date.now() + 24 * 60 * 60 * 1000);
  return { token, id, role };
}
export function workspaceOwner(owner: string, encounter?: string): string {
  const workspace = db().prepare("SELECT w.id,w.user_id,u.status FROM workspaces w LEFT JOIN users u ON u.id=w.user_id WHERE w.id=?").get(owner);
  if (!workspace || (workspace.user_id && workspace.status !== "active")) throw new WorkflowError("Your account does not have workspace access.", 403);
  assertRequestAccess();
  if (!encounter) return owner;
  const target = db().prepare("SELECT e.owner,w.user_id FROM encounters e JOIN workspaces w ON w.id=e.owner WHERE e.id=?").get(encounter);
  if (!target || (target.owner !== owner && (!workspace.user_id || target.user_id !== workspace.user_id))) throw new WorkflowError("Encounter not found in this session.", 404);
  return String(target.owner);
}
export function insertEncounter(owner: string, e: Encounter) {
  owner = workspaceOwner(owner);
  const count = db().prepare("SELECT COUNT(*) AS n FROM encounters WHERE owner=?").get(owner)?.n as number;
  if (count >= 12) throw new WorkflowError("This workspace has reached its 12-encounter limit. Delete an encounter to continue.", 429);
  db().prepare("INSERT INTO encounters(id,owner,version,body,created) VALUES(?,?,?,?,?)").run(e.id, owner, e.version, JSON.stringify(e), Date.now());
}
export function loadEncounter(owner: string, id: string): Encounter {
  owner = workspaceOwner(owner, id);
  const row = db().prepare("SELECT body FROM encounters WHERE id=? AND owner=?").get(id, owner);
  if (!row) throw new WorkflowError("Encounter not found in this session.", 404);
  const value = JSON.parse(row.body as string) as Encounter;
  value.noteReview ??= null; value.sheetReview ??= null; value.teachBackArchive ??= [];
  value.teachBack = value.teachBack.map(normalizeAttempts); value.teachBackArchive = value.teachBackArchive.map(normalizeAttempts);
  return value;
}
export function saveEncounter(owner: string, previousVersion: number, e: Encounter) {
  owner = workspaceOwner(owner, e.id);
  const result = db().prepare("UPDATE encounters SET body=?,version=? WHERE id=? AND owner=? AND version=?").run(JSON.stringify(e), e.version, e.id, owner, previousVersion);
  if (result.changes !== 1) throw new WorkflowError("This encounter changed in another tab. Reload before continuing.");
  if (!e.teachBack.length) db().prepare("DELETE FROM teach_back_audio WHERE encounter=?").run(e.id);
}
export function saveEncounterWithAudio(owner: string, previousVersion: number, e: Encounter, audio: Buffer) {
  owner = workspaceOwner(owner, e.id);
  const result = db().prepare("UPDATE encounters SET body=?,version=?,audio=? WHERE id=? AND owner=? AND version=?").run(JSON.stringify(e), e.version, audio, e.id, owner, previousVersion);
  if (result.changes !== 1) throw new WorkflowError("This encounter changed before the recording finished uploading. Reload and retry.");
  db().prepare("DELETE FROM teach_back_audio WHERE encounter=?").run(e.id);
}
export function saveTeachBackAudio(owner: string, previousVersion: number, e: Encounter, question: string, sheetFp: string, audio: Buffer, attempt = "legacy-1") {
  owner = workspaceOwner(owner, e.id);
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = db().prepare("UPDATE encounters SET body=?,version=? WHERE id=? AND owner=? AND version=?").run(JSON.stringify(e), e.version, e.id, owner, previousVersion);
    if (result.changes !== 1) throw new WorkflowError("This encounter changed before the teach-back recording finished uploading.");
    db().prepare("INSERT INTO teach_back_audio(encounter,question,sheet_fingerprint,audio) VALUES(?,?,?,?) ON CONFLICT(encounter,question) DO UPDATE SET sheet_fingerprint=excluded.sheet_fingerprint,audio=excluded.audio").run(e.id, question, sheetFp, audio);
    db().prepare("INSERT INTO teach_back_attempt_audio(encounter,question,attempt,sheet_fingerprint,audio) VALUES(?,?,?,?,?)").run(e.id, question, attempt, sheetFp, audio);
    db().exec("COMMIT");
  } catch (error) { db().exec("ROLLBACK"); throw error; }
}
export function loadTeachBackAttemptAudio(owner: string, encounter: string, question: string, attempt: string): Buffer | null {
  try { owner = workspaceOwner(owner, encounter); } catch (error) { if (error instanceof WorkflowError && error.status === 404) return null; throw error; }
  const row = db().prepare("SELECT a.audio FROM teach_back_attempt_audio a JOIN encounters e ON e.id=a.encounter WHERE e.id=? AND e.owner=? AND a.question=? AND a.attempt=?").get(encounter, owner, question, attempt);
  return row?.audio ? Buffer.from(row.audio as Uint8Array) : null;
}
export function saveSpokenQuestionAudio(owner: string, previousVersion: number, e: Encounter, questionId: string, audio: Buffer) {
  owner = workspaceOwner(owner, e.id);
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = db().prepare("UPDATE encounters SET body=?,version=? WHERE id=? AND owner=? AND version=?").run(JSON.stringify(e), e.version, e.id, owner, previousVersion);
    if (result.changes !== 1) throw new WorkflowError("This encounter changed before the question recording finished uploading.");
    db().prepare("INSERT INTO plan_question_audio(encounter,question_id,audio) VALUES(?,?,?)").run(e.id, questionId, audio);
    db().exec("COMMIT");
  } catch (error) { db().exec("ROLLBACK"); throw error; }
}
export function loadSpokenQuestionAudio(owner: string, encounter: string, questionId: string): Buffer | null {
  try { owner = workspaceOwner(owner, encounter); } catch (error) { if (error instanceof WorkflowError && error.status === 404) return null; throw error; }
  const row = db().prepare("SELECT a.audio FROM plan_question_audio a JOIN encounters e ON e.id=a.encounter WHERE e.id=? AND e.owner=? AND a.question_id=?").get(encounter, owner, questionId);
  return row?.audio ? Buffer.from(row.audio as Uint8Array) : null;
}
export function loadTeachBackAudio(owner: string, encounter: string, question: string, sheetFp: string): Buffer | null {
  try { owner = workspaceOwner(owner, encounter); } catch (error) { if (error instanceof WorkflowError && error.status === 404) return null; throw error; }
  const row = db().prepare("SELECT a.audio FROM teach_back_audio a JOIN encounters e ON e.id=a.encounter WHERE e.id=? AND e.owner=? AND a.question=? AND a.sheet_fingerprint=?").get(encounter, owner, question, sheetFp);
  return row?.audio ? Buffer.from(row.audio as Uint8Array) : null;
}
export function loadAudio(owner: string, id: string): Buffer | null {
  try { owner = workspaceOwner(owner, id); } catch (error) { if (error instanceof WorkflowError && error.status === 404) return null; throw error; }
  const row = db().prepare("SELECT audio FROM encounters WHERE id=? AND owner=?").get(id, owner);
  return row?.audio ? Buffer.from(row.audio as Uint8Array) : null;
}
export function deleteEncounter(owner: string, id: string) { owner = workspaceOwner(owner, id); db().prepare("DELETE FROM encounters WHERE id=? AND owner=?").run(id, owner); }
export function listEncounters(owner: string): Encounter[] {
  workspaceOwner(owner);
  return db().prepare("SELECT body FROM encounters WHERE owner=? OR owner IN (SELECT id FROM workspaces WHERE user_id=(SELECT user_id FROM workspaces WHERE id=?)) ORDER BY created DESC").all(owner, owner).map(r => JSON.parse(r.body as string));
}
export function rateLimit(key: string, maximum: number, windowMs = 60_000) {
  const now = Date.now();
  const r = db().prepare(`INSERT INTO limits(key,count,reset) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset<? THEN 1 ELSE count+1 END, reset=CASE WHEN reset<? THEN excluded.reset ELSE reset END RETURNING count`).get(key, now + windowMs, now, now);
  if ((r?.count as number) > maximum) throw new WorkflowError("Too many requests. Please wait a minute and retry.", 429);
}
export function beginJob(owner: string, key: string, signature: string): { id: string; cached?: Encounter } {
  const id = hash(`${owner}:${key}`);
  const existing = db().prepare("SELECT signature,status,result FROM jobs WHERE id=? AND owner=?").get(id, owner);
  if (existing) {
    if (existing.signature !== signature) throw new WorkflowError("This request key was already used for different content.");
    if (existing.status === "done") return { id, cached: JSON.parse(existing.result as string) };
    if (existing.status === "running") throw new WorkflowError("This request is already processing. Your work is saved.");
    throw new WorkflowError("This attempt failed. Your work is saved; retry with a new request.");
  }
  // A lost response followed by a new browser request key must not repeat a paid call.
  const equivalent = db().prepare("SELECT status,result FROM jobs WHERE owner=? AND signature=? ORDER BY created DESC LIMIT 1").get(owner, signature);
  if (equivalent?.status === "done") return { id, cached: JSON.parse(equivalent.result as string) };
  if (equivalent?.status === "running") throw new WorkflowError("This request is already processing. Reload to inspect saved work before retrying.");
  db().prepare("INSERT INTO jobs(id,owner,signature,status,created) VALUES(?,?,?,'running',?)").run(id, owner, signature, Date.now());
  return { id };
}
export function endJob(id: string, result?: Encounter) { db().prepare("UPDATE jobs SET status=?,result=? WHERE id=?").run(result ? "done" : "failed", result ? JSON.stringify(result) : null, id); }
export function modelUsageSummary(userId?: string | null) {
  const scope = userId === undefined ? "" : userId === null ? " WHERE 0" : " WHERE user_id=?";
  const params = typeof userId === "string" ? [userId] : [];
  const row = db().prepare("SELECT COALESCE(SUM(reserved),0) AS estimated, COALESCE(SUM(actual),0) AS actual, SUM(CASE WHEN actual IS NULL THEN 1 ELSE 0 END) AS unknown FROM reservations" + scope).get(...params)!;
  return { estimatedUsd: Number(row.estimated), actualUsd: Number(row.actual), unknownCalls: Number(row.unknown), text: textUsageSummary(userId) };
}
export function recordEstimatedCost(purpose: string, amount: number, userId = usageActor()?.userId ?? null): string {
  assertRequestAccess();
  if (!Number.isFinite(amount) || amount <= 0) throw new WorkflowError("Invalid cost estimate.", 500);
  const id = randomBytes(16).toString("hex");
  db().prepare("INSERT INTO reservations(id,purpose,reserved,created,user_id) VALUES(?,?,?,?,?)").run(id, purpose, amount, Date.now(), userId);
  observeReservation(id);
  return id;
}
export function recordCost(id: string, actual: number) {
  // Keep the estimate alongside provider-reported usage for the historical record.
  db().prepare("UPDATE reservations SET actual=? WHERE id=?").run(actual, id);
}
export function updateEstimatedCost(id: string, estimated: number) {
  if (!Number.isFinite(estimated) || estimated <= 0) throw new WorkflowError("Invalid cost estimate.", 500);
  db().prepare("UPDATE reservations SET reserved=? WHERE id=?").run(estimated, id);
}

export function saveSourceDocument(owner: string, previousVersion: number, e: Encounter, documentId: string, mime: string, data: Buffer) {
  owner = workspaceOwner(owner, e.id);
  db().exec("BEGIN IMMEDIATE");
  try {
    saveEncounter(owner, previousVersion, e);
    db().prepare("INSERT INTO source_documents(encounter,document_id,mime,data) VALUES(?,?,?,?)").run(e.id, documentId, mime, data);
    db().exec("COMMIT");
  } catch (error) { db().exec("ROLLBACK"); throw error; }
}
export function loadSourceDocument(owner: string, encounter: string, documentId: string): { mime: string; data: Buffer } | null {
  try { owner = workspaceOwner(owner, encounter); } catch (error) { if (error instanceof WorkflowError && error.status === 404) return null; throw error; }
  const row = db().prepare("SELECT d.mime,d.data FROM source_documents d JOIN encounters e ON e.id=d.encounter WHERE e.id=? AND e.owner=? AND d.document_id=?").get(encounter, owner, documentId);
  return row ? { mime: String(row.mime), data: Buffer.from(row.data as Uint8Array) } : null;
}

export function recordTextCall(id: string, metadata: TextCallRecord) {
  db().prepare("INSERT INTO text_calls(reservation,metadata) VALUES(?,?) ON CONFLICT(reservation) DO UPDATE SET metadata=excluded.metadata").run(id, JSON.stringify(metadata));
  if (metadata.usage?.costBasis === "measured-tokens" && metadata.usage.costUsd !== null) recordCost(id, metadata.usage.costUsd);
}
export function textUsageSummary(userId?: string | null) {
  const scope = userId === undefined ? "" : userId === null ? " AND 0" : " AND r.user_id=?";
  const params = typeof userId === "string" ? [userId] : [];
  const rows = db().prepare("SELECT t.metadata FROM text_calls t JOIN reservations r ON r.id=t.reservation WHERE 1=1" + scope).all(...params).map(row => JSON.parse(String(row.metadata)) as TextCallRecord);
  const aggregate = (calls: TextCallRecord[]) => {
    const known = calls.filter(c => c.usage?.cachedTokens !== null && c.usage?.cachedTokens !== undefined && c.usage.valid);
    const sum = (key: "inputTokens" | "cachedTokens" | "uncachedTokens" | "outputTokens", selected = calls) => selected.reduce((n, c) => n + (c.usage?.[key] ?? 0), 0);
    const denominator = sum("inputTokens", known);
    return { calls: calls.length, completedCalls: calls.filter(c => c.status === "completed").length, inputTokens: sum("inputTokens"), cachedTokens: sum("cachedTokens", known), uncachedTokens: sum("uncachedTokens", known), outputTokens: sum("outputTokens"), cacheRatio: denominator ? sum("cachedTokens", known) / denominator : null, cacheMeasuredCalls: known.length, cacheUnknownCalls: calls.length - known.length, coverage: calls.length ? known.length / calls.length : null, undiscountedEstimateUsd: calls.reduce((n, c) => n + (c.usage?.costBasis === "cache-unknown-estimate" ? c.usage.costUsd ?? 0 : 0), 0) };
  };
  const groups = new Map<string, TextCallRecord[]>();
  for (const call of rows) { const key = JSON.stringify([call.operation, call.promptVersion, call.profile, call.endpoint, call.cacheKey]); groups.set(key, [...(groups.get(key) ?? []), call]); }
  return { ...aggregate(rows), groups: [...groups.values()].map(calls => ({ operation: calls[0].operation, promptVersion: calls[0].promptVersion, profile: calls[0].profile, endpoint: calls[0].endpoint, cacheKey: calls[0].cacheKey, ...aggregate(calls) })), historicalOrNonTextRecords: Number(db().prepare("SELECT COUNT(*) AS n FROM reservations r LEFT JOIN text_calls t ON r.id=t.reservation WHERE t.reservation IS NULL" + scope).get(...params)?.n ?? 0) };
}
