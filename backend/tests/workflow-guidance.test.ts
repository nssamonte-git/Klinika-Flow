import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { workflowGuidance, resumeStep, type GuidanceOptions, type WorkflowView } from "../../web/src/lib/workflow-guidance";
import GuidedPreparation from "../../web/src/components/guided-preparation";
import TeachBackVoice from "../../web/src/components/teach-back-voice";
import { approveNote, approveSheet, createEncounter, exportReasons, makeTeachBack, runChecks, savedNote, savedReview } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import type { Encounter } from "../src/domain/schema";
const options: GuidanceOptions = { studio: true, configured: true, reviewer: "Fixture QA", confirmed: true, referenceSelected: true };
const view = { noteApproved: false, sheetApproved: false };
function source() { const e = createEncounter("guidance-fixture", "case-01"); e.consent = true; return e; }
function note() { let e = source(); e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); return runChecks(e); }
function sheet() { let e = approveNote(note(), "Fixture QA", true); e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet"); return runChecks(e); }
function approved() { const e = approveSheet(sheet(), "Fixture QA", true); e.teachBack = makeTeachBack(e); return e; }
function guide(e: Encounter, overrides: Partial<GuidanceOptions> = {}, v: WorkflowView = view) { return workflowGuidance(e, v, { ...options, ...overrides }); }
describe("guided workspace next action", () => {
  it("requires explicit consent before another step", () => {
    const e = createEncounter("consent", "case-01");
    expect(guide(e, { step: 3 })).toMatchObject({ step: 0, target: "synthetic-consent" });
  });
  it("leads with recording in a fresh account, but saved fixtures in Demo", () => {
    expect(guide(source(), { referenceSelected: false })).toMatchObject({ title: "Record the consultation", target: "consultation-recorder" });
    expect(guide(source(), { studio: false })).toMatchObject({ action: "generate-note", paid: false, body: { provider: "saved" } });
  });
  it("does not generate a note before audio transcription", () => {
    const e = source(); e.audioAvailable = true; e.turns = [];
    expect(guide(e)).toMatchObject({ action: "transcribe", paid: true });
    expect(guide(e, { configured: false }).blocked).toBeTruthy();
  });
  it("requires the current recording speaker map before transcript confirmation", () => {
    const e = source(); e.recordingFingerprint = "new"; e.turns[0].providerSpeaker = "A";
    e.speakerMapping = { recordingFingerprint: "old", roles: { A: "patient" }, reviewer: "QA", confirmedAt: "" };
    expect(guide(e)).toMatchObject({ action: "map-speakers", blocked: expect.any(String) });
    e.speakerMapping.recordingFingerprint = "new";
    expect(guide(e, { transcriptChecked: true })).toMatchObject({ action: "confirm-transcript", blocked: undefined });
  });
  it("pauses for explicit transcript confirmation, then a separate paid generation", () => {
    const e = source(); expect(guide(e).action).toBe("confirm-transcript");
    e.transcriptConfirmation = { fingerprint: "fixture", reviewer: "QA", at: "", recordingFingerprint: null };
    expect(guide(e)).toMatchObject({ action: "generate-note", paid: true, body: { provider: "live" } });
  });
  it("routes dirty content to its save checkpoint, even from a different step", () => {
    expect(guide(source(), { step: 3, transcriptDirty: true })).toMatchObject({ action: "transcript", step: 0 });
    expect(guide(note(), { step: 2, noteDirty: true })).toMatchObject({ action: "edit-note", step: 1 });
  });
  it("offers a source comparison before approval and makes unavailable/manual paths explicit", () => {
    const e = note(); e.noteReview = null;
    expect(guide(e)).toMatchObject({ action: "run-note-review", paid: true });
    expect(guide(e, { configured: false }).blocked).toContain("manual");
    expect(guide(e, { studio: false }).paid).toBe(false);
  });
  it("keeps unresolved model findings visible instead of offering approval", () => {
    const e = note(); e.noteReview!.findings.push({ id: "flag", category: "other", sourceIds: ["t1"], targetId: "c1", sourceQuote: "fixture", targetQuote: "fixture", explanation: "Review fixture" });
    expect(guide(e)).toMatchObject({ target: "note-comparison" }); expect(guide(e).action).toBeUndefined();
  });
  it("requires reviewer identity and a fresh checkbox for each approval", () => {
    expect(guide(note(), { confirmed: false }).blocked).toContain("Confirm");
    expect(guide(note(), { reviewer: "" }).blocked).toContain("reviewer");
    expect(guide(note())).toMatchObject({ action: "approve-note", blocked: undefined });
    expect(guide(sheet(), {}, { ...view, noteApproved: true })).toMatchObject({ action: "approve-sheet" });
  });
  it("resumes at instruction creation after approving a note", () => {
    const e = approveNote(note(), "QA", true); const v = { ...view, noteApproved: true };
    expect(resumeStep(e, v)).toBe(2); expect(guide(e, {}, v).action).toBe("generate-sheet");
  });
  it("routes a sheet defect to sheet review with the note still approved", () => {
    const e = sheet(); e.checks = [{ id: "sheet", target: e.lines[0].id, severity: "error", message: "Changed wording" }];
    expect(guide(e, { step: 3 }, { ...view, noteApproved: true })).toMatchObject({ step: 2, title: "Resolve sheet checks" });
  });
  it("requires another answer after re-explanation and respects server print eligibility", () => {
    const e = approved(), v = { noteApproved: true, sheetApproved: true, exportReasons: exportReasons(e) };
    e.teachBack[0].outcome = "reexplained";
    expect(guide(e, {}, v).title).toContain("Follow up");
    expect(guide(e, {}, { ...v, exportReasons: [] }).title).toContain("ready to print");
    e.teachBackSkip = "Fixture skip";
    expect(guide(e, {}, v).target).toBe("print-options");
  });
  it("renders only one main action and disables approval until confirmed", () => {
    const e = note(), next = guide(e, { confirmed: false });
    const html = renderToStaticMarkup(createElement(GuidedPreparation, { encounter: e, view, studio: true, configured: true, disabled: false, unsaved: false, currentStep: 1, guidance: next, onAction() {}, onGo() {}, onTranscribe() {} }));
    expect(html.match(/<button/g)).toHaveLength(1); expect(html).toContain("disabled"); expect(html).toContain("Confirm your review");
  });
  it("prioritizes an unsaved answer over a previously print-ready server snapshot", () => {
    const e = approved();
    const next = guide(e, { step: 3, answerDirty: true }, { noteApproved: true, sheetApproved: true, exportReasons: [] });
    expect(next.title).toBe("Save your answer correction"); expect(next.target).toBe("teach-questions");
  });
  it("shows one paid answer operation at a time and labels it", () => {
    const e = approved(), q = e.teachBack[0]; q.audioAvailable = true; q.analysis = null;
    const render = () => renderToStaticMarkup(createElement(TeachBackVoice, { question: q, encounterId: e.id, studio: true, configured: true, disabled: false, reviewer: "QA", async onUpload() {}, async onAction() {}, onError() {} }));
    let html = render(); expect(html).toContain("Transcribe answer · paid call"); expect(html).not.toContain("Compare with instructions · paid call");
    q.transcript = "Synthetic answer"; html = render(); expect(html).toContain("Compare with instructions · paid call"); expect(html).not.toContain(">Transcribe answer · paid call");
  });
});
