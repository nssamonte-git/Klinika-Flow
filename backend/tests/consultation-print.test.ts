import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { approveNote, approveSheet, createEncounter, makeTeachBack, runChecks, savedNote, savedReview } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import { act } from "../src/server/actions";
import { closeDb, createSession, insertEncounter } from "../src/server/db";
import { COOKIE } from "../src/server/auth-core";
import PrintPage from "../../web/src/app/print/[id]/page";

const headers = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ toString: () => headers.cookie }) }));
afterEach(() => { closeDb(); vi.unstubAllEnvs(); });
it("prints the approved instruction record without exposing raw consultation history", async () => {
  closeDb(); vi.stubEnv("DATABASE_PATH", ":memory:");
  const owner = createSession(); headers.cookie = `${COOKIE}=${owner.token}`;
  let e = createEncounter("history-print", "case-01"); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note");
  e = approveNote(runChecks(e), "Synthetic QA", true); e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet");
  e = approveSheet(runChecks(e), "Synthetic QA", true); e.teachBack = makeTeachBack(e);
  e.consultationTranscriptions = [{ transcript: "RAW-CONSULTATION-MUST-STAY-PRIVATE", turns: [], providerLabels: [], recordingFingerprint: "original", model: "muse-voice-transcribe-1.0", requestKey: "private-request-key", at: new Date().toISOString(), latencyMs: 1, estimatedCostUsd: 0.001 }];
  insertEncounter(owner.id, e);
  await act(owner, e.id, "print-history-fixture", { action: "record-teach-back", expectedVersion: e.version, reviewer: "Synthetic QA", outcomes: { medicine: "understood", warning: "understood", followup: "understood" } });
  const html = renderToStaticMarkup(await PrintPage({ params: Promise.resolve({ id: e.id }) }));
  expect(html).toContain("Mga Bilin ng Doktor"); expect(html).not.toContain("Export is locked");
  expect(html).not.toContain("RAW-CONSULTATION-MUST-STAY-PRIVATE"); expect(html).not.toContain("private-request-key");
});
