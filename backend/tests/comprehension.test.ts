import { describe, expect, it } from "vitest";
import { approveNote, approveSheet, createEncounter, invalidate, makeTeachBack, runChecks, savedNote, savedReview, sheetFingerprint, startAttempt } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import { comprehensionMap, comprehensionSummary } from "../src/domain/comprehension";
import { reviewerHandoff } from "../src/domain/agent-policy";

function approved(caseId: string) {
  let e = createEncounter("map-encounter", caseId); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); e = approveNote(runChecks(e), "DR", true);
  e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet"); e = approveSheet(runChecks(e), "DR", true); e.teachBack = makeTeachBack(e);
  return e;
}
const status = (e: ReturnType<typeof approved>) => Object.fromEntries(comprehensionMap(e).map(r => [r.lineId, r.status]));

describe("comprehension map", () => {
  it("shows the contradicted warning lines and the advice line that teach-back never asks about", () => {
    const e = approved("case-01");
    expect(status(e)).toEqual({ l1: "pending", l2: "contradicted", l3: "contradicted", l4: "not-asked", l5: "pending", l6: "pending" });
    const warning = comprehensionMap(e).find(r => r.lineId === "l2")!;
    expect(warning.attempts[0].findings.map(f => f.source).sort()).toEqual(["model", "rule"]);
  });
  it("moves a line from re-explained to confirmed across attempts and keeps the history", () => {
    const e = approved("case-01"), q = e.teachBack.find(t => t.id === "warning")!;
    Object.assign(q.attempts![0], { outcome: "reexplained", reviewer: "DR" });
    expect(status(e).l2).toBe("awaiting-repeat");
    const repeat = startAttempt(q); repeat.rawTranscript = q.expected; Object.assign(repeat, { outcome: "understood", reviewer: "DR", analysis: q.attempts![0].analysis, ruleCheck: { parserVersion: "taglish@1", findings: [], sheetFingerprint: q.sheetFingerprint } });
    const row = comprehensionMap(e).find(r => r.lineId === "l2")!;
    expect(row.status).toBe("confirmed"); expect(row.attempts.map(a => a.outcome)).toEqual(["reexplained", "understood"]);
  });
  it("labels a reviewer override and an answer from the wrong person", () => {
    const e = approved("case-04"), medicine = e.teachBack.find(t => t.id === "medicine")!;
    Object.assign(medicine.attempts![0], { outcome: "understood", reviewer: "DR", overrideReason: "Synthetic QA override reason" });
    expect(status(e).l2).toBe("overridden");
    medicine.attempts![0].respondent = "patient";
    expect(status(e).l2).toBe("wrong-respondent");
    expect(comprehensionMap(e).find(r => r.lineId === "l2")!.required).toBe("companion");
  });
  it("has no current questions after the sheet changes and appears in the read-only handoff", () => {
    const e = approved("case-04");
    expect(comprehensionSummary(comprehensionMap(e))).toMatchObject({ contradicted: 1, "not-asked": 1 });
    expect(reviewerHandoff(e).comprehension.find(r => r.lineId === "l2")).toMatchObject({ status: "contradicted", required: "companion", respondent: "companion" });
    const changed = invalidate(e, "sheet");
    expect(comprehensionMap(changed, sheetFingerprint(changed)).every(r => r.status === "not-asked" && !r.attempts.length)).toBe(true);
  });
});
