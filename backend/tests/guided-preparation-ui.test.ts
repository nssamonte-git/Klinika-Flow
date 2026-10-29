import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import GuidedPreparation from "../../web/src/components/guided-preparation";
import { approveNote, createEncounter, hasCurrentNoteApproval, runChecks, savedNote, savedReview } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import type { Encounter } from "../src/domain/schema";
function render(e: Encounter) {
  return renderToStaticMarkup(createElement(GuidedPreparation, { encounter: e, view: { noteApproved: hasCurrentNoteApproval(e), sheetApproved: false }, studio: false, configured: false, disabled: false, unsaved: false, onAction: vi.fn(), onTranscribe: vi.fn(), onGo: vi.fn() }));
}
it("routes a planted sheet-timing error to sheet review while preserving note approval", () => {
  let e = createEncounter("sheet-guide", "case-01"); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); e = approveNote(runChecks(e), "Fixture reviewer", true);
  e.lines = templateSheet(e.claims); const warning = e.lines.find(line => line.fact.kind === "warning")!;
  warning.fact = { ...warning.fact, urgency: "scheduled", delayDays: 3 }; warning.text = "Bumalik pagkalipas ng 3 araw kung may babala."; e = runChecks(e);
  expect(e.checks.length).toBeGreaterThan(0); expect(hasCurrentNoteApproval(e)).toBe(true);
  const html = render(e); expect(html).toContain("Resolve sheet checks"); expect(html).toContain("Go to sheet review"); expect(html).not.toContain("Go to note review");
});
it("keeps source-claim errors directed to note review", () => {
  let e = createEncounter("note-guide", "case-01"); e.consent = true; e.claims = savedNote(e); e.claims[0].fact.dose = "999 mg"; e = runChecks(e);
  expect(e.checks.length).toBeGreaterThan(0);
  const html = render(e); expect(html).toContain("Resolve source checks"); expect(html).toContain("Go to note review");
});
