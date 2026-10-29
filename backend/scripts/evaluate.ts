import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { cases } from "../src/domain/cases";
import { checkEncounter, createEncounter, normalize, runChecks } from "../src/domain/workflow";
import { templateSheet, renderFilipino } from "../src/domain/render";
import { modelUsageSummary, closeDb } from "../src/server/db";
import { analyzeTeachBack, generateCandidateSheet, generateNote, MODEL, PRICING, PROMPT_VERSION, REVIEW_PROMPT_VERSION, reviewNote, reviewSheet, TEACH_BACK_PROMPT_VERSION, transcribe } from "../src/server/meta";
import { promptVersionFor, requestProfile } from "../src/server/text-call";
import { verifyReviewFindings, verifyTeachBackFindings } from "../src/server/review";

const live = process.argv.includes("--live");
const datasetVersion = "synthetic-three-cases@1";
const datasetHash = createHash("sha256").update(JSON.stringify(cases)).digest("hex");
const implementationHash = createHash("sha256").update(["backend/src/domain/schema.ts", "backend/src/domain/workflow.ts", "backend/src/domain/render.ts", "backend/src/server/meta.ts", "backend/src/server/text-call.ts", "backend/src/domain/text-usage.ts", "backend/src/domain/model-ids.ts"].map(p => readFileSync(p, "utf8")).join("\n")).digest("hex");
const audioPath = (caseId: string, kind: "consultation" | "teach-back") => resolve("backend/eval/audio", `${caseId}${kind === "teach-back" ? "-teach-back-warning" : ""}.wav`);
const missingLiveInputs = live ? [!process.env.MODEL_API_KEY ? "MODEL_API_KEY" : "", ...cases.flatMap(c => [audioPath(c.id, "consultation"), audioPath(c.id, "teach-back")].filter(p => !existsSync(p)))].filter(Boolean) : [];
const liveReady = live && missingLiveInputs.length === 0;
const report: Record<string, unknown> = { at: new Date().toISOString(), implementationHash, mode: liveReady ? "live" : live ? "live-blocked" : "offline-fixtures", datasetVersion, datasetHash, requestProfile: requestProfile(), promptVersions: { core: promptVersionFor("note"), review: promptVersionFor("note_review"), teachBack: promptVersionFor("teach_back_analysis") }, models: MODEL, pricing: PRICING, humanReview: "pending: clinician and native speaker", selectedSheetMode: "template-draft", missingLiveInputs, cases: [] };
const results: Record<string, unknown>[] = [];
for (const c of cases) {
  const e = createEncounter("evaluation", c.id); e.consent = true; e.claims = structuredClone(c.claims); e.lines = templateSheet(e.claims);
  const baseline = checkEncounter(e);
  const warning = e.lines.find(l => l.fact.kind === "warning");
  const damaged = structuredClone(e);
  const target = damaged.lines.find(l => l.id === warning?.id);
  if (target) { target.fact.urgency = "scheduled"; target.fact.delayDays = 3; target.text = renderFilipino(target.fact); }
  const regressionCaught = checkEncounter(damaged).some(c => c.id.startsWith("meaning"));
  const result: Record<string, unknown> = { caseId: c.id, source: "human-authored synthetic reference", referenceIssues: baseline, timingRegressionCaught: regressionCaught, transcription: { status: "pending", reason: "Requires actor WAVs and a configured server API key." }, note: { status: "pending" }, noteReview: { status: "pending" }, filipinoSheet: { status: "pending" }, sheetReview: { status: "pending" }, teachBack: { status: "pending" } };
  if (liveReady) {
    // No retries: each explicit run has its own durable usage record.
    try {
      const note = await generateNote(c.turns);
      const candidate = { ...e, claims: note.data.claims, lines: [] };
      result.note = { status: "completed", latencyMs: note.latencyMs, costUsd: note.costUsd, costBasis: note.costBasis, usage: note.usage, issues: checkEncounter(candidate), output: note.data, requiresHumanReview: true };
      try { const review = await reviewNote(c.turns, note.data.claims); result.noteReview = { status: "completed", latencyMs: review.latencyMs, costUsd: review.costUsd, costBasis: review.costBasis, usage: review.usage, findings: verifyReviewFindings("note", review.data.findings, c.turns, note.data.claims, []), requiresHumanReview: true }; }
      catch (err) { result.noteReview = { status: "failed", error: err instanceof Error ? err.message : "Request failed" }; }
    } catch (err) { result.note = { status: "failed", error: err instanceof Error ? err.message : "Request failed" }; }
    try {
      const sheet = await generateCandidateSheet(c.claims);
      const candidate = runChecks({ ...e, lines: sheet.data.lines, sheetMode: "model" });
      result.filipinoSheet = { status: "completed", latencyMs: sheet.latencyMs, costUsd: sheet.costUsd, costBasis: sheet.costBasis, usage: sheet.usage, structuralIssues: candidate.checks, output: sheet.data, languageQuality: "unscored: clinician/native-speaker review required" };
      try { const review = await reviewSheet(c.claims, sheet.data.lines); result.sheetReview = { status: "completed", latencyMs: review.latencyMs, costUsd: review.costUsd, costBasis: review.costBasis, usage: review.usage, findings: verifyReviewFindings("sheet", review.data.findings, c.turns, c.claims, sheet.data.lines), requiresHumanReview: true }; }
      catch (err) { result.sheetReview = { status: "failed", error: err instanceof Error ? err.message : "Request failed" }; }
    } catch (err) { result.filipinoSheet = { status: "failed", error: err instanceof Error ? err.message : "Request failed" }; }
      try {
        const transcription = await transcribe(readFileSync(audioPath(c.id, "consultation")));
        const reference = normalize(c.turns.map(t => t.text).join(" "));
        const actual = normalize(transcription.turns.map(t => t.text).join(" "));
        const terms = ["500", "10", "1", "3", "5", "paracetamol", "cetirizine", "do not take antibiotics", "return immediately", "difficulty breathing", "fever does not go down"].filter(term => reference.includes(term));
        result.transcription = { status: "completed", latencyMs: transcription.latencyMs, estimatedCostUsd: transcription.costUsd, output: transcription, missingReferenceTerms: terms.filter(term => !actual.includes(term)), exactNormalizedMatch: reference === actual, categoryErrorCounts: "pending manual alignment and role review; term presence is only a diagnostic" };
      } catch (err) { result.transcription = { status: "failed", error: err instanceof Error ? err.message : "Request failed" }; }
    try {
      const warningLines = e.lines.filter(l => l.fact.kind === "warning");
      const answer = await transcribe(readFileSync(audioPath(c.id, "teach-back")), "PUSH_TO_TALK");
      const analysis = await analyzeTeachBack("Kailan kayo dapat bumalik agad?", warningLines.map(l => ({ id: l.id, text: l.text })), answer.transcript);
      result.teachBack = { status: "completed", voiceModel: MODEL.voice, textModel: MODEL.text, transcriptionLatencyMs: answer.latencyMs, analysisLatencyMs: analysis.latencyMs, transcriptionEstimatedCostUsd: answer.costUsd, analysisCostUsd: analysis.costUsd, analysisCostBasis: analysis.costBasis, usage: analysis.usage, answerTranscript: answer.transcript, findings: verifyTeachBackFindings(analysis.data.findings, warningLines, answer.transcript), outcome: "pending human reviewer" };
    } catch (err) { result.teachBack = { status: "failed", error: err instanceof Error ? err.message : "Request failed" }; }
  } else if (live) result.liveBlocked = `Missing live inputs: ${missingLiveInputs.join(", ")}. No paid calls made.`;
  results.push(result);
}
report.cases = results; report.modelUsage = modelUsageSummary();
const directory = resolve("backend/eval/runs"); mkdirSync(directory, { recursive: true });
const destination = resolve(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "offline"}.json`);
writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
const good = results.every(r => (r.referenceIssues as unknown[]).length === 0 && r.timingRegressionCaught);
console.log(`Reference fixtures: ${good ? "PASS" : "FAIL"} (${cases.length} cases). Immediate-versus-delayed regression: ${results.filter(r => r.timingRegressionCaught).length}/${cases.length} caught.`);
console.log(live && !liveReady ? `Live capability tests: NOT RUN (missing ${missingLiveInputs.join(", ")}).` : live ? "Live results saved. Clinical and Filipino language review remain pending." : "Offline fixtures only. No transcription or language-quality evidence was produced; no paid calls made.");
console.log(`Report: ${destination}`);
console.log(`Known model cost: $${modelUsageSummary().actualUsd.toFixed(5)}; attempted estimate: $${modelUsageSummary().estimatedUsd.toFixed(5)}. Template draft mode remains selected.`);
closeDb();
if (!good || (live && !liveReady)) process.exitCode = 1;
