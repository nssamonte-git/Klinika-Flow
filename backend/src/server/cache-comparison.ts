import "server-only";
import { readFileSync } from "node:fs";
import { DocumentExtractionSchema } from "../domain/schema";
import { validateDocument } from "./documents";
import { cases } from "../domain/cases";
import { checkEncounter, createEncounter, fingerprint, WorkflowError } from "../domain/workflow";
import { renderFilipino, templateSheet } from "../domain/render";
import { verifyCorrectionProposal, verifyReviewFindings, verifyTeachBackFindings } from "./review";
import { prepareNote, prepareCandidateSheet, prepareNoteReview, prepareSheetReview, prepareTeachBack, prepareNoteCorrection, preparePlanQuestion, prepareDocument, type TextSpecification, executeText } from "./meta";
import { buildTextRequest, TextRequestError, type RequestProfile } from "./text-call";
import { PRICING } from "../domain/model-ids";
export class ComparisonConfigurationError extends Error {}
export function safeComparisonError(error: unknown): string { return error instanceof ComparisonConfigurationError || error instanceof WorkflowError ? error.message : "Comparison failed. Check synthetic fixture format and file access; request and response bodies were not logged."; }
export type ComparisonOptions = { live: boolean; confirmPaid: boolean; maxCalls: number; operation?: string; caseId?: string; document?: string; expectedDocument?: string; confirmSyntheticDocument?: boolean };
export function parseComparisonOptions(args: string[]): ComparisonOptions {
  const allowed = new Set(["--live", "--confirm-paid", "--max-calls", "--operation", "--case", "--document", "--expected-document", "--confirm-synthetic-document"]);
  for (let i = 0; i < args.length; i++) { if (!allowed.has(args[i])) throw new ComparisonConfigurationError("Unknown comparison option."); if (["--max-calls", "--operation", "--case", "--document", "--expected-document"].includes(args[i])) { if (!args[i + 1] || args[i + 1].startsWith("--")) throw new ComparisonConfigurationError("Comparison option requires a value."); i++; } }
  const value = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  const live = args.includes("--live"), confirmPaid = args.includes("--confirm-paid"), maxCalls = Number(value("--max-calls") ?? 0);
  if (live && (!confirmPaid || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 200)) throw new ComparisonConfigurationError("Live comparison requires --confirm-paid and --max-calls between 1 and 200.");
  return { live, confirmPaid, maxCalls, operation: value("--operation"), caseId: value("--case"), document: value("--document"), expectedDocument: value("--expected-document"), confirmSyntheticDocument: args.includes("--confirm-synthetic-document") };
}
type Workload = { operation: string; caseId: string; phase: "initial" | "identical-repeat" | "changed-tail"; specification: TextSpecification<any>; validate: (data: any) => boolean };
export function comparisonWorkloads(options: ComparisonOptions): Workload[] {
  const workloads: Workload[] = [];
  for (const c of cases.filter(c => !options.caseId || c.id === options.caseId)) {
    const e = createEncounter("cache-comparison", c.id); e.consent = true; e.claims = structuredClone(c.claims); e.lines = templateSheet(e.claims);
    const warning = e.claims.find(claim => claim.fact.kind === "warning")!;
    const badClaims = structuredClone(e.claims), bad = badClaims.find(claim => claim.id === warning.id)!; bad.fact.urgency = "scheduled"; bad.fact.delayDays = 3;
    const badLines = structuredClone(e.lines), badLine = badLines.find(line => line.sourceClaimIds.includes(warning.id))!; badLine.fact.urgency = "scheduled"; badLine.fact.delayDays = 3; badLine.text = renderFilipino(badLine.fact);
    const warningLines = e.lines.filter(line => line.fact.kind === "warning").map(l => ({ id: l.id, text: l.text }));
    const finding = { id: "cache-fixture-finding", category: "warning" as const, sourceIds: warning.sourceTurnIds, targetId: warning.id, sourceQuote: e.turns.find(t => t.id === warning.sourceTurnIds[0])!.text.slice(0, 100), targetQuote: "", explanation: "Synthetic fixture: immediate return changed to a three-day delay." };
    const facts = (claims: typeof e.claims) => claims.map(c => fingerprint(c.fact)).sort();
    const tasks: { spec: TextSpecification<any>; validate: (data: any) => boolean; changed?: TextSpecification<any> }[] = [
      { spec: prepareNote(e.turns), validate: data => !checkEncounter({ ...e, claims: data.claims, lines: [] }).length && fingerprint(facts(data.claims)) === fingerprint(facts(e.claims)) },
      { spec: prepareCandidateSheet(e.claims), validate: data => !checkEncounter({ ...e, lines: data.lines }).length },
      { spec: prepareNoteReview(e.turns, badClaims), validate: data => verifyReviewFindings("note", data.findings, e.turns, badClaims, []).some(f => f.targetId === warning.id) },
      { spec: prepareSheetReview(e.claims, badLines), validate: data => verifyReviewFindings("sheet", data.findings, e.turns, e.claims, badLines).some(f => f.targetId === badLine.id) },
      { spec: prepareTeachBack("When should you return for warning signs?", warningLines, "I will wait three days before returning for the warning signs."), changed: prepareTeachBack("When should you return for warning signs?", warningLines, "I will wait two days before returning for the warning signs."), validate: data => verifyTeachBackFindings(data.findings, e.lines.filter(l => l.fact.kind === "warning"), "I will wait three days before returning for the warning signs.").some(f => f.category === "changed") },
      { spec: prepareNoteCorrection(finding, bad, e.turns.filter(t => warning.sourceTurnIds.includes(t.id))), validate: data => fingerprint(verifyCorrectionProposal({ ...e, claims: badClaims }, bad, data.sourceQuote, data.correctedFact).fact) === fingerprint(warning.fact) },
      { spec: preparePlanQuestion("What should I do if I miss a dose?", e.lines.map(l => ({ id: l.id, text: l.text }))), changed: preparePlanQuestion("Do these instructions explain what happens after a missed dose?", e.lines.map(l => ({ id: l.id, text: l.text }))), validate: data => data.needsReviewer === true && data.lineIds.length === 0 },
    ];
    for (const task of tasks.filter(t => !options.operation || t.spec.operation === options.operation)) {
      for (const phase of ["initial", "identical-repeat", ...(task.changed ? ["changed-tail"] : [])] as Workload["phase"][]) {
        const specification = phase === "changed-tail" ? task.changed! : task.spec;
        const validate = task.spec.operation === "teach_back_analysis" ? (data: any) => verifyTeachBackFindings(data.findings, e.lines.filter(l => l.fact.kind === "warning"), (specification.content as any).transcript).some(f => f.category === "changed") : task.validate;
        workloads.push({ operation: task.spec.operation, caseId: c.id, phase, specification, validate });
      }
    }
  }
  if (options.document || options.expectedDocument) {
    if (!options.document || !options.expectedDocument || !options.confirmSyntheticDocument) throw new ComparisonConfigurationError("Document comparison requires --document, --expected-document and --confirm-synthetic-document.");
    const mime = options.document.toLowerCase().endsWith(".pdf") ? "application/pdf" : /\.jpe?g$/i.test(options.document) ? "image/jpeg" : "image/png";
    const data = readFileSync(options.document); validateDocument(data, mime);
    const expected = DocumentExtractionSchema.parse(JSON.parse(readFileSync(options.expectedDocument, "utf8")));
    const comparable = (lines: typeof expected.lines) => lines.map(l => `${l.page}:${l.text}`).sort();
    if ((!options.operation || options.operation === "document_extraction") && (!options.caseId || options.caseId === "document-fixture")) for (const phase of ["initial", "identical-repeat"] as const) workloads.push({ operation: "document_extraction", caseId: "document-fixture", phase, specification: prepareDocument({ data, mime, name: "synthetic-document" }), validate: value => fingerprint(comparable(value.lines)) === fingerprint(comparable(expected.lines)) });
  }
  if (!workloads.length) throw new ComparisonConfigurationError("No synthetic comparison workloads match those filters. Document extraction is tested separately with paired source/expected-text fixtures.");
  return workloads;
}
export async function runComparison(options: ComparisonOptions, invoke: typeof executeText = executeText) {
  if (options.live && (!options.confirmPaid || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 200)) throw new ComparisonConfigurationError("Explicit paid confirmation and a bounded call count are required.");
  if (options.live && !process.env.MODEL_API_KEY) throw new ComparisonConfigurationError("MODEL_API_KEY is required for a live comparison.");
  const workloads = comparisonWorkloads(options), records: Record<string, any>[] = []; let calls = 0, halted = false;
  attempts: for (const profile of ["legacy", "efficient"] as RequestProfile[]) for (const workload of workloads) {
    const s = workload.specification, request = buildTextRequest(s.schema, s.operation, s.content, s.system, s.attachment, profile);
    const record: Record<string, any> = { caseId: workload.caseId, operation: workload.operation, phase: workload.phase, profile, promptVersion: request.promptVersion, cacheKey: request.cacheKey, retention: request.retention, endpoint: request.endpoint, textBytes: request.textBytes, prefixHash: request.prefixHash, requestHash: fingerprint(request.body), status: "offline-inspection", quality: "not-measured", followUpCalls: null };
    if (options.live) {
      if (calls >= options.maxCalls) break attempts;
      calls++;
      try { const result = await invoke(s, profile); record.status = "completed"; record.usage = result.usage; record.latencyMs = result.latencyMs; record.costUsd = result.costUsd; record.costBasis = result.costBasis; try { record.quality = workload.validate(result.data) ? "pass" : "fail"; record.followUpCalls = record.quality === "pass" ? 0 : null; } catch { record.quality = "fail"; } }
      catch (error) { record.status = "failed"; record.quality = "fail"; record.failure = "request-or-validation-failed";
        if (error instanceof TextRequestError) { record.requestStatus = error.measurement.status; record.latencyMs = error.measurement.latencyMs; record.usage = error.measurement.usage; record.costBasis = error.measurement.usage?.costBasis; record.costUsd = error.measurement.usage?.costUsd; }
      }
    }
    if (record.usage?.valid && record.usage.cachedTokens !== null) record.cacheRatio = record.usage.inputTokens ? record.usage.cachedTokens / record.usage.inputTokens : null;
    records.push(record);
    if (options.live && (record.status === "failed" || record.quality === "fail" || record.costBasis !== "measured-tokens")) { halted = true; break attempts; }
  }
  const totals = (profile: RequestProfile) => {
    const selected = records.filter(r => r.profile === profile && r.usage?.costBasis === "measured-tokens");
    const inputUsd = selected.reduce((n, r) => n + (r.usage.uncachedTokens * PRICING.inputPerMillion + r.usage.cachedTokens * PRICING.cachedInputPerMillion) / 1e6, 0);
    const warm = selected.filter(r => r.phase !== "initial"), warmInput = warm.reduce((n, r) => n + r.usage.inputTokens, 0);
    return { warmCacheRatio: warmInput ? warm.reduce((n, r) => n + r.usage.cachedTokens, 0) / warmInput : null, measuredCalls: selected.length, inputUsd, costUsd: selected.reduce((n, r) => n + r.costUsd, 0), warmInputTokens: selected.filter(r => r.phase !== "initial").reduce((n, r) => n + r.usage.inputTokens, 0), warmUncachedTokens: selected.filter(r => r.phase !== "initial").reduce((n, r) => n + r.usage.uncachedTokens, 0), warmCachedTokens: selected.filter(r => r.phase !== "initial").reduce((n, r) => n + r.usage.cachedTokens, 0) };
  };
  const legacy = totals("legacy"), efficient = totals("efficient"), allMeasured = records.length === workloads.length * 2 && records.every(r => r.status === "completed" && r.quality === "pass" && r.costBasis === "measured-tokens");
  return { at: new Date().toISOString(), mode: options.live ? "live-synthetic-comparison" : "offline-request-inspection", dataset: "synthetic-three-cases@1", pricing: PRICING, paidCalls: calls, plannedCalls: workloads.length * 2, stoppedAtCallLimit: options.live && calls >= options.maxCalls && calls < workloads.length * 2, stoppedAfterFailureOrUnknownUsage: halted, records, totals: { legacy, efficient }, acceptance: { scope: "Selected synthetic workloads only; no clinical/language validation.", allMeasured, qualityAndCostPass: options.live && allMeasured && efficient.inputUsd < legacy.inputUsd && efficient.costUsd <= legacy.costUsd, profileChangedAutomatically: false }, gaps: ["No guaranteed minimum cache prefix or hit ratio", "Retention effect and variant cache sharing unverified", "Document comparison requires explicitly supplied synthetic source and expected-text fixtures", ...(options.live ? [] : ["Billed token savings and output quality are unmeasured offline"])] };
}
