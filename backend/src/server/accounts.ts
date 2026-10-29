import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { db, modelUsageSummary } from "./db-core";
import { WorkflowError } from "../domain/workflow";
import { withRequestActor } from "./request-context";

export const ACCOUNT_COOKIE = "klinikaflow_account", MODE_COOKIE = "klinikaflow_mode";
export type User = { id: string; name: string; email: string; role: "admin" | "member"; status: "pending" | "active" | "suspended"; created: number; approvedAt: number | null; approvedBy: string | null; lastLogin: number | null };
export type AccountSession = { sessionId: string; user: User; id: string; role: "studio"; userId: string };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const validToken = (token?: string) => Boolean(token && /^[a-f0-9]{64}$/.test(token));
export function userById(id: string): User | null {
  const row = db().prepare("SELECT id,name,email,role,status,created,approved_at AS approvedAt,approved_by AS approvedBy,last_login AS lastLogin FROM users WHERE id=?").get(id);
  return row ? row as unknown as User : null;
}
export function validatePassword(password: string) {
  if ([...password].length < 15 || [...password].length > 128) throw new WorkflowError("Use a password between 15 and 128 characters.", 400);
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
// Bound expensive hashing independently of HTTP rate limits.
let hashing = 0;
async function hashed<T>(task: () => Promise<T>): Promise<T> {
  if (hashing >= 2) throw new WorkflowError("Sign-in is busy. Please try again shortly.", 429);
  hashing++; try { return await task(); } finally { hashing--; }
}
export async function hashPassword(password: string) {
  validatePassword(password);
  return hashed(async () => { const salt = randomBytes(16), key = await derive(password, salt); return `scrypt-v1$${salt.toString("hex")}$${key.toString("hex")}`; });
}
export async function verifyPassword(password: string, stored: string) {
  if ([...password].length > 128) return false;
  const [version, salt, value] = stored.split("$");
  if (version !== "scrypt-v1" || !/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(value ?? "")) return false;
  return hashed(async () => timingSafeEqual(await derive(password, Buffer.from(salt, "hex")), Buffer.from(value, "hex")));
}
export function normalizeAccountName(name: string) {
  const value = name.trim();
  if (!value || value.length > 80) throw new WorkflowError("Enter a display name between 1 and 80 characters.", 400);
  return value;
}
export function normalizeAccountEmail(email: string) {
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new WorkflowError("Enter a valid email address, for example admin@example.com.", 400);
  return value;
}
export async function registerAccount(name: string, email: string, password: string, admin = false) {
  name = normalizeAccountName(name); email = normalizeAccountEmail(email);
  const encoded = await hashPassword(password), id = randomUUID(), now = Date.now();
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("INSERT INTO users(id,name,email,password,role,status,created,approved_at) VALUES(?,?,?,?,?,?,?,?)").run(id, name, email, encoded, admin ? "admin" : "member", admin ? "active" : "pending", now, admin ? now : null);
    db().prepare("INSERT INTO workspaces(id,user_id,kind) VALUES(?,?,'account')").run(randomUUID(), id);
    if (admin) audit(id, id, "administrator-provisioned");
    db().exec("COMMIT");
  } catch { db().exec("ROLLBACK"); throw new WorkflowError("An account could not be created with these details.", 400); }
  return userById(id)!;
}
export function createAccountSession(userId: string) {
  const token = randomBytes(32).toString("hex"), id = digest(token);
  db().prepare("DELETE FROM account_sessions WHERE expires<=?").run(Date.now());
  db().prepare("INSERT INTO account_sessions(id,user_id,expires) VALUES(?,?,?)").run(id, userId, Date.now() + 86400000);
  return { token, session: accountSession(token)! };
}
export function accountSession(token?: string): AccountSession | null {
  if (!validToken(token)) return null;
  return accountSessionById(digest(token!));
}
export function accountSessionById(id: string): AccountSession | null {
  const row = db().prepare("SELECT user_id FROM account_sessions WHERE id=? AND expires>?").get(id, Date.now());
  const user = row ? userById(String(row.user_id)) : null;
  if (!user) return null;
  const workspace = db().prepare("SELECT id FROM workspaces WHERE user_id=? AND kind='account' ORDER BY rowid LIMIT 1").get(user.id);
  return workspace ? { sessionId: id, user, userId: user.id, id: String(workspace.id), role: "studio" } : null;
}
export function assertActive(session: AccountSession) {
  const current = accountSessionById(session.sessionId);
  if (!current) throw new WorkflowError("Your session expired. Sign in again.", 401);
  if (current.user.status !== "active") throw new WorkflowError(current.user.status === "pending" ? "Your account is awaiting administrator approval." : "Your account is suspended. Contact your administrator.", 403);
  return current;
}
export function assertAdmin(session: AccountSession) {
  const current = assertActive(session);
  if (current.user.role !== "admin") throw new WorkflowError("Administrator access is required.", 403);
  return current;
}
export function runAsAccount<T>(session: AccountSession | { userId?: string; sessionId?: string }, task: () => T): T {
  return withRequestActor(session.userId ?? null, () => { if (session.sessionId) { const current = accountSessionById(session.sessionId); if (!current) throw new WorkflowError("Your session expired. Sign in again.", 401); assertActive(current); } }, task);
}
export async function signIn(email: string, password: string) {
  const row = db().prepare("SELECT id,password FROM users WHERE email=?").get(email.trim().toLowerCase());
  // Do equivalent password work for unknown emails to avoid a cheap timing oracle.
  const dummy = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;
  const valid = await verifyPassword(password, String(row?.password ?? dummy));
  if (!row || !valid) throw new WorkflowError("Email or password is incorrect.", 401);
  const current = db().prepare("SELECT password,status FROM users WHERE id=?").get(row.id);
  if (!current || current.password !== row.password) throw new WorkflowError("Email or password is incorrect.", 401);
  if (current.status === "suspended") throw new WorkflowError("Your account is suspended. Contact your administrator.", 403);
  db().prepare("UPDATE users SET last_login=? WHERE id=?").run(Date.now(), row.id);
  return createAccountSession(String(row.id));
}
export function logout(id: string) { db().prepare("DELETE FROM account_sessions WHERE id=?").run(id); }
export function audit(actor: string, target: string, action: string) { db().prepare("INSERT INTO account_audit(actor,target,action,at) VALUES(?,?,?,?)").run(actor, target, action, Date.now()); }
export function manageUser(session: AccountSession, targetId: string, action: "approve" | "suspend" | "restore") {
  assertAdmin(session); const target = userById(targetId);
  if (!target) throw new WorkflowError("Account unavailable.", 404);
  db().exec("BEGIN IMMEDIATE");
  try {
    if (action === "suspend" && target.role === "admin" && target.status === "active" && Number(db().prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").get()?.n) <= 1) throw new WorkflowError("The sole active administrator cannot be suspended.", 409);
    if ((action === "approve" && target.status !== "pending") || (action === "restore" && target.status !== "suspended")) throw new WorkflowError("Account status changed. Refresh the list.", 409);
    const status = action === "suspend" ? "suspended" : "active";
    db().prepare("UPDATE users SET status=?,approved_at=CASE WHEN ?='active' THEN ? ELSE approved_at END,approved_by=CASE WHEN ?='active' THEN ? ELSE approved_by END WHERE id=?").run(status, status, Date.now(), status, session.userId, targetId);
    if (action === "suspend") db().prepare("DELETE FROM account_sessions WHERE user_id=?").run(targetId);
    db().prepare("DELETE FROM password_resets WHERE user_id=?").run(targetId);
    audit(session.userId, targetId, action); db().exec("COMMIT");
  } catch (e) { db().exec("ROLLBACK"); throw e; }
  return userById(targetId)!;
}
export function createReset(session: AccountSession, userId: string) {
  assertAdmin(session); const user = userById(userId);
  if (!user || user.status === "suspended") throw new WorkflowError("This account cannot receive a reset link.", 400);
  const token = randomBytes(32).toString("hex"), expires = Date.now() + 1800000;
  db().exec("BEGIN IMMEDIATE");
  try { db().prepare("DELETE FROM password_resets WHERE user_id=?").run(userId); db().prepare("INSERT INTO password_resets VALUES(?,?,?)").run(digest(token), userId, expires); audit(session.userId, userId, "password-reset-issued"); db().exec("COMMIT"); } catch(e) { db().exec("ROLLBACK"); throw e; }
  return { token, expires };
}
export async function resetPassword(token: string, password: string) {
  if (!validToken(token)) throw new WorkflowError("Reset link is invalid or expired.", 400);
  const encoded = await hashPassword(password);
  db().exec("BEGIN IMMEDIATE");
  try {
    const row = db().prepare("SELECT user_id FROM password_resets WHERE id=? AND expires>?").get(digest(token), Date.now());
    if (!row || userById(String(row.user_id))?.status === "suspended") throw new WorkflowError("Reset link is invalid or expired.", 400);
    db().prepare("UPDATE users SET password=? WHERE id=?").run(encoded, row.user_id);
    db().prepare("DELETE FROM password_resets WHERE user_id=?").run(row.user_id);
    db().prepare("DELETE FROM account_sessions WHERE user_id=?").run(row.user_id);
    audit(String(row.user_id), String(row.user_id), "password-reset-completed"); db().exec("COMMIT");
  } catch(e) { db().exec("ROLLBACK"); throw e; }
}
export async function changePassword(session: AccountSession, current: string, password: string) {
  const row = db().prepare("SELECT password FROM users WHERE id=?").get(session.userId);
  if (!row || !await verifyPassword(current, String(row.password))) throw new WorkflowError("Current password is incorrect.", 400);
  const encoded = await hashPassword(password);
  const active = accountSessionById(session.sessionId);
  if (!active || active.user.status === "suspended") throw new WorkflowError("Sign in again before changing your password.", 401);
  db().exec("BEGIN IMMEDIATE");
  try {
    const changed = db().prepare("UPDATE users SET password=? WHERE id=? AND password=?").run(encoded, session.userId, row.password);
    if (changed.changes !== 1) throw new WorkflowError("Password changed in another session. Sign in again.", 409);
    db().prepare("DELETE FROM account_sessions WHERE user_id=?").run(session.userId);
    db().prepare("DELETE FROM password_resets WHERE user_id=?").run(session.userId);
    audit(session.userId, session.userId, "password-changed"); db().exec("COMMIT");
  } catch(e) { db().exec("ROLLBACK"); throw e; }
}
export function importLegacy(session: AccountSession, legacyId: string) {
  assertActive(session);
  db().exec("BEGIN IMMEDIATE");
  try {
    const valid = db().prepare("SELECT s.id FROM sessions s JOIN workspaces w ON w.id=s.id WHERE s.id=? AND s.expires>? AND w.user_id IS NULL AND w.kind IN ('legacy','demo')").get(legacyId, Date.now());
    if (!valid) throw new WorkflowError("This browser workspace is unavailable or has already been imported.", 409);
    db().prepare("UPDATE workspaces SET user_id=?,kind='imported' WHERE id=?").run(session.userId, legacyId);
    db().prepare("DELETE FROM sessions WHERE id=?").run(legacyId);
    audit(session.userId, legacyId, "workspace-imported"); db().exec("COMMIT");
  } catch(e) { db().exec("ROLLBACK"); throw e; }
}
export function accountDirectory(session: AccountSession) {
  assertAdmin(session);
  return { users: db().prepare("SELECT id FROM users ORDER BY created DESC").all().map(row => { const user = userById(String(row.id))!; return { ...user, usage: modelUsageSummary(user.id) }; }), usage: modelUsageSummary(), unattributedUsage: unattributedSummary() };
}
function unattributedSummary() {
  const row = db().prepare("SELECT COUNT(*) AS calls,COALESCE(SUM(reserved),0) AS estimatedUsd,COALESCE(SUM(actual),0) AS actualUsd FROM reservations WHERE user_id IS NULL").get();
  return row;
}
