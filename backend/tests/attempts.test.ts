import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEncounter, makeTeachBack, normalizeAttempts, runChecks, savedNote, savedReview, approveNote, approveSheet, invalidate, sheetFingerprint } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import { act } from "../src/server/actions";
import { closeDb, createSession, db, insertEncounter, loadEncounter, loadTeachBackAttemptAudio, saveTeachBackAudio } from "../src/server/db";

let directory: string | null = null;
beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => { closeDb(); if (directory) { rmSync(directory, { recursive: true, force: true }); directory = null; } });
function approved() {
  let e = createEncounter("attempt-encounter", "case-01"); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); e = approveNote(runChecks(e), "DR", true);
  e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet"); e = approveSheet(runChecks(e), "DR", true); e.teachBack = makeTeachBack(e);
  return e;
}
describe("teach-back attempt history", () => {
  it("keeps first and repeated saved answers, then archives them after changed instructions", async () => {
    const owner = createSession(), e = approved(); insertEncounter(owner.id, e);
    const first = await act(owner, e.id, "first-outcome", { action: "record-teach-back", expectedVersion: e.version, outcomes: { warning: "reexplained" }, reviewer: "DR" });
    const repeated = await act(owner, e.id, "second-attempt", { action: "start-teach-back-attempt", expectedVersion: first.version, questionId: "warning" });
    const q = repeated.teachBack.find(t => t.id === "warning")!;
    expect(q.attempts).toHaveLength(2);
    expect(q.attempts![0].analysis?.findings).toHaveLength(1);
    expect(q.attempts![0].outcome).toBe("reexplained");
    expect(q.attempts![1].analysis?.findings).toHaveLength(0);
    const second = await act(owner, e.id, "second-outcome", { action: "record-teach-back", expectedVersion: repeated.version, outcomes: { warning: "understood" }, reviewer: "DR" });
    expect(second.teachBack.find(t => t.id === "warning")?.attempts?.map(a => a.outcome)).toEqual(["reexplained", "understood"]);
    const changed = invalidate(second, "sheet");
    expect(changed.teachBack).toEqual([]);
    expect(changed.teachBackArchive?.find(t => t.id === "warning")?.attempts).toHaveLength(2);
  });
  it("backs up a legacy database and preserves its answer audio and usage history", () => {
    directory = mkdtempSync(join(tmpdir(), "klinikaflow-migration-"));
    const path = join(directory, "legacy.sqlite"), old = new DatabaseSync(path);
    old.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,role TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE encounters(id TEXT PRIMARY KEY,owner TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,audio BLOB,created INTEGER NOT NULL); CREATE TABLE reservations(id TEXT PRIMARY KEY,purpose TEXT NOT NULL,reserved REAL NOT NULL,actual REAL,created INTEGER NOT NULL); CREATE TABLE teach_back_audio(encounter TEXT NOT NULL,question TEXT NOT NULL,sheet_fingerprint TEXT NOT NULL,audio BLOB NOT NULL,PRIMARY KEY(encounter,question))");
    const e = approved(), q = e.teachBack.find(t => t.id === "warning")!;
    delete q.attempts; delete q.activeAttemptId; q.audioAvailable = true; q.transcript = "legacy answer"; q.transcriptSource = "human-corrected";
    old.prepare("INSERT INTO sessions VALUES(?,?,?)").run("legacy-owner", "judge", Date.now() + 60_000);
    old.prepare("INSERT INTO encounters(id,owner,version,body,created) VALUES(?,?,?,?,?)").run(e.id, "legacy-owner", e.version, JSON.stringify(e), Date.now());
    old.prepare("INSERT INTO teach_back_audio VALUES(?,?,?,?)").run(e.id, q.id, sheetFingerprint(e), Buffer.from("old-audio"));
    old.prepare("INSERT INTO reservations VALUES(?,?,?,?,?)").run("usage-1", "legacy-model", 0.02, 0.01, Date.now()); old.close();
    closeDb(); process.env.DATABASE_PATH = path;
    const loaded = loadEncounter("legacy-owner", e.id), imported = loaded.teachBack.find(t => t.id === "warning")!;
    expect(imported.attempts).toHaveLength(1); expect(imported.attempts![0].id).toBe("legacy-1");
    expect(imported.attempts![0].reviewer).toBeNull(); expect(imported.attempts![0].createdAt).toBeNull();
    expect(loadTeachBackAttemptAudio("legacy-owner", e.id, q.id, "legacy-1")?.toString()).toBe("old-audio");
    expect(db().prepare("SELECT COUNT(*) AS n FROM reservations").get()?.n).toBe(1);
    expect(readdirSync(directory).filter(name => name.includes(".backup-"))).toHaveLength(1);
    expect(normalizeAttempts(imported)).toEqual(imported);
  });
});
