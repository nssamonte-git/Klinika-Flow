import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveNote, approveSheet, createEncounter, exportReasons, makeTeachBack, runChecks, savedNote, savedReview } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import { act } from "../src/server/actions";
import { closeDb, createSession, insertEncounter } from "../src/server/db";

beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => closeDb());
function ready() {
  let e = createEncounter("exception-case", "case-01"); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); e = approveNote(runChecks(e), "DR", true);
  e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet"); e = approveSheet(runChecks(e), "DR", true); e.teachBack = makeTeachBack(e); return e;
}
describe("named print exception", () => {
  it("permits unresolved answers only with current reviewer evidence and expires after another answer", async () => {
    const owner = createSession(), e = ready(); insertEncounter(owner.id, e);
    expect(exportReasons(e).join()).toMatch(/named reviewer exception/);
    await expect(act(owner, e.id, "blank-exception", { action: "record-print-exception", expectedVersion: e.version, reviewer: "DR", reason: "", confirmed: true })).rejects.toThrow(/reason/);
    const excepted = await act(owner, e.id, "valid-exception", { action: "record-print-exception", expectedVersion: e.version, reviewer: "DR", reason: "Actor stopped before all answers could be reviewed.", confirmed: true });
    expect(exportReasons(excepted)).toEqual([]);
    expect(excepted.printException?.unresolvedQuestionIds).toEqual(["followup", "medicine", "warning"]);
    const repeated = await act(owner, e.id, "repeat-warning", { action: "start-teach-back-attempt", expectedVersion: excepted.version, questionId: "warning" });
    expect(repeated.printException).toBeNull(); expect(exportReasons(repeated).join()).toMatch(/named reviewer exception/);
  });
  it("never bypasses sheet approval or accepts a stale legacy exception", async () => {
    const owner = createSession(), e = ready(); insertEncounter(owner.id, e);
    const excepted = await act(owner, e.id, "valid-exception-2", { action: "record-print-exception", expectedVersion: e.version, reviewer: "DR", reason: "Synthetic actor could not finish questions.", confirmed: true });
    const stale = structuredClone(excepted); stale.printException!.attemptFingerprint = "old";
    expect(exportReasons(stale).join()).toMatch(/named reviewer exception/);
    const blank = structuredClone(excepted); blank.printException!.reviewer = "";
    expect(exportReasons(blank).join()).toMatch(/named reviewer exception/);
    const unapproved = structuredClone(excepted); unapproved.sheetApproval = null;
    expect(exportReasons(unapproved).join()).toMatch(/Approve the current instruction sheet/);
  });
});
