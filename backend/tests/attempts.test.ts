import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRuleCheck, createEncounter, exportReasons, makeTeachBack, normalizeAttempts, runChecks, savedNote, savedReview, approveNote, approveSheet, invalidate, sheetFingerprint, unresolvedTeachBack } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import { act } from "../src/server/actions";
import { closeDb, createSession, db, insertEncounter, loadEncounter, loadTeachBackAttemptAudio, saveTeachBackAudio } from "../src/server/db";

let directory: string | null = null;
beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => { closeDb(); if (directory) { rmSync(directory, { recursive: true, force: true }); directory = null; } });
function approved(caseId = "case-01") {
  let e = createEncounter("attempt-encounter", caseId); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); e = approveNote(runChecks(e), "DR", true);
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

describe("rule check and companion answers", () => {
  const understood = (q: string) => ({ action: "record-teach-back" as const, outcomes: { [q]: "understood" as const }, reviewer: "DR" });
  it("requires a reason to mark a flagged answer understood and keeps it on the attempt", async () => {
    const owner = createSession(), e = approved(); insertEncounter(owner.id, e);
    expect(e.teachBack.find(q => q.id === "warning")!.attempts![0].ruleCheck?.findings[0].responseQuote).toBe("pagkatapos ng tatlong araw");
    await expect(act(owner, e.id, "rule-no-reason-key", { ...understood("warning"), expectedVersion: e.version })).rejects.toThrow(/rule check flagged/);
    await expect(act(owner, e.id, "rule-short-reason-key", { ...understood("warning"), expectedVersion: e.version, overrideReasons: { warning: "ok" } })).rejects.toThrow(/rule check flagged/);
    const overridden = await act(owner, e.id, "rule-reason-key", { ...understood("warning"), expectedVersion: e.version, overrideReasons: { warning: "Actor misspoke; repeated correctly aloud" } });
    expect(overridden.teachBack.find(q => q.id === "warning")!.attempts![0].overrideReason).toBe("Actor misspoke; repeated correctly aloud");
    expect(unresolvedTeachBack(overridden)).not.toContain("warning");
  });
  it("reruns the rule check when a reviewer corrects the transcript", () => {
    const e = approved(), q = e.teachBack.find(t => t.id === "warning")!, attempt = q.attempts![0];
    attempt.overrideReason = "Earlier override reason"; attempt.correctedTranscript = "Babalik agad kung hindi bumaba ang lagnat o kung hirap huminga.";
    applyRuleCheck(e, q, attempt);
    expect(attempt.ruleCheck?.findings).toEqual([]); expect(attempt.overrideReason).toBeNull();
  });
  it("requires the bantay to say back the medicine in the dengue case", async () => {
    const owner = createSession(), e = approved("case-04"); insertEncounter(owner.id, e);
    const medicine = e.teachBack.find(q => q.id === "medicine")!;
    expect(e.companion).toEqual({ present: true, relation: "anak" });
    expect(medicine.requiredRespondent).toBe("companion");
    expect(medicine.attempts![0]).toMatchObject({ respondent: "companion", ruleCheck: { findings: [expect.objectContaining({ responseQuote: "ibuprofen ang ibibigay ko" })] } });
    const reexplained = await act(owner, e.id, "rule-reexplain-key", { action: "record-teach-back", expectedVersion: e.version, outcomes: { medicine: "reexplained" }, reviewer: "DR" });
    const byPatient = await act(owner, e.id, "rule-patient-repeat-key", { action: "start-teach-back-attempt", expectedVersion: reexplained.version, questionId: "medicine", respondent: "patient" });
    const patientUnderstood = await act(owner, e.id, "rule-patient-ok-key", { ...understood("medicine"), expectedVersion: byPatient.version });
    expect(unresolvedTeachBack(patientUnderstood)).toContain("medicine");
    // Correcting who answered relabels the current attempt and clears its outcome; it does not create a new answer.
    const switched = await act(owner, e.id, "rule-switch-key", { action: "set-respondent", expectedVersion: patientUnderstood.version, questionId: "medicine", respondent: "companion" });
    expect(switched.teachBack.find(q => q.id === "medicine")!.outcome).toBe("pending");
    const done = await act(owner, e.id, "rule-companion-ok-key", { ...understood("medicine"), expectedVersion: switched.version });
    expect(unresolvedTeachBack(done)).not.toContain("medicine");
    expect(done.teachBack.find(q => q.id === "medicine")!.attempts!.map(a => a.respondent)).toEqual(["companion", "companion"]);
  });
  it("returns questions to the patient when the companion is removed and expires exceptions on requirement changes", async () => {
    const owner = createSession(), e = approved("case-04"); insertEncounter(owner.id, e);
    const exception = await act(owner, e.id, "rule-exception-key", { action: "record-print-exception", expectedVersion: e.version, confirmed: true, reviewer: "DR", reason: "Synthetic QA exception" });
    expect(exportReasons(exception).some(r => r.includes("Confirm understanding"))).toBe(false);
    const changed = await act(owner, e.id, "rule-require-patient-key", { action: "set-required-respondent", expectedVersion: exception.version, questionId: "medicine", respondent: "patient" });
    expect(changed.printException).toBeNull();
    const removed = await act(owner, e.id, "rule-no-companion-key", { action: "set-companion", expectedVersion: changed.version, value: false });
    expect(removed.companion).toBeNull();
    expect(removed.teachBack.every(q => q.requiredRespondent === "patient")).toBe(true);
    await expect(act(owner, e.id, "rule-bad-companion-key", { action: "set-respondent", expectedVersion: removed.version, questionId: "medicine", respondent: "companion" })).rejects.toThrow(/companion first/);
  });
  it("lets legacy answers without a respondent count only when no companion is recorded", () => {
    const e = approved();
    for (const q of e.teachBack) { const a = q.attempts![q.attempts!.length - 1]; delete a.respondent; a.outcome = "understood"; a.reviewer = "DR"; a.overrideReason = a.ruleCheck?.findings.length ? "Synthetic QA override" : null; }
    expect(unresolvedTeachBack(e)).toEqual([]);
    e.companion = { present: true, relation: "asawa" };
    expect(unresolvedTeachBack(e)).toEqual(["followup", "medicine", "warning"]);
  });
});
