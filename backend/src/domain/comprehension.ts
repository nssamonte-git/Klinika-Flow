import type { Encounter, Fact, Respondent, TeachBack, TeachBackAttempt, TeachBackOutcome } from "./schema";
import { factKindsFor } from "./taglish";

// Kept free of node:crypto so the browser can build the map from the encounter it already has.
/** The person who must say an instruction back. Unknown legacy respondents count only when no companion is recorded. */
export function respondentMatches(e: Encounter, q: TeachBack, attempt: TeachBackAttempt): boolean {
  const required = q.requiredRespondent ?? "patient";
  return attempt.respondent ? attempt.respondent === required : required === "patient" && !e.companion?.present;
}

// Per-line view of every say-back attempt. Clinician record only: it never appears on the patient sheet and decides nothing.
export type ComprehensionStatus = "confirmed" | "overridden" | "contradicted" | "gap" | "awaiting-repeat" | "wrong-respondent" | "pending" | "not-asked";
export type ComprehensionAttempt = {
  attemptId: string; questionId: string; number: number; active: boolean; respondent: Respondent | null; outcome: TeachBackOutcome;
  reviewer: string | null; decidedAt: string | null; transcript: string | null; overrideReason: string | null;
  findings: { source: "rule" | "model"; category: "missing" | "changed" | "unclear"; responseQuote: string; explanation: string }[];
};
export type ComprehensionRow = { lineId: string; text: string; kind: Fact["kind"]; questionId: string | null; required: Respondent | null; status: ComprehensionStatus; attempts: ComprehensionAttempt[] };
export const comprehensionLabels: Record<ComprehensionStatus, string> = {
  confirmed: "Said back correctly", overridden: "Understood · reviewer override", contradicted: "Contradicted", gap: "Missing or unclear",
  "awaiting-repeat": "Re-explained · ask again", "wrong-respondent": "Answered by the wrong person", pending: "Outcome needed", "not-asked": "Not covered by teach-back",
};

/** Pass the current sheet fingerprint on the server; the browser receives only current questions after any edit. */
export function comprehensionMap(e: Encounter, currentSheet?: string): ComprehensionRow[] {
  return e.lines.map(line => {
    const q = e.teachBack.find(q => (!currentSheet || q.sheetFingerprint === currentSheet) && (factKindsFor[q.id] ?? []).includes(line.fact.kind));
    if (!q) return { lineId: line.id, text: line.text, kind: line.fact.kind, questionId: null, required: null, status: "not-asked" as const, attempts: [] };
    const required = q.requiredRespondent ?? "patient";
    const attempts: ComprehensionAttempt[] = (q.attempts ?? []).map((a, index) => ({
      attemptId: a.id, questionId: q.id, number: index + 1, active: a.id === q.activeAttemptId, respondent: a.respondent ?? null, outcome: a.outcome,
      reviewer: a.reviewer, decidedAt: a.decidedAt, transcript: a.correctedTranscript ?? a.rawTranscript, overrideReason: a.overrideReason ?? null,
      findings: [
        ...(a.ruleCheck?.findings ?? []).filter(f => f.sourceLineIds.includes(line.id)).map(f => ({ source: "rule" as const, category: f.category, responseQuote: f.responseQuote, explanation: f.explanation })),
        ...(a.analysis?.findings ?? []).filter(f => f.sourceLineIds.includes(line.id)).map(f => ({ source: "model" as const, category: f.category, responseQuote: f.responseQuote, explanation: f.explanation })),
      ],
    }));
    const active = attempts.find(a => a.active), attempt = q.attempts?.find(a => a.id === q.activeAttemptId);
    let status: ComprehensionStatus = "pending";
    if (active && attempt) {
      if (active.outcome === "understood" && active.reviewer) status = !respondentMatches(e, q, attempt) ? "wrong-respondent" : active.findings.some(f => f.source === "rule") && active.overrideReason ? "overridden" : "confirmed";
      else if (active.outcome === "reexplained" || active.outcome === "not-understood") status = "awaiting-repeat";
      else if (active.findings.some(f => f.category === "changed")) status = "contradicted";
      else if (active.findings.length) status = "gap";
    }
    return { lineId: line.id, text: line.text, kind: line.fact.kind, questionId: q.id, required, status, attempts };
  });
}
export function comprehensionSummary(rows: ComprehensionRow[]): Partial<Record<ComprehensionStatus, number>> {
  return rows.reduce<Partial<Record<ComprehensionStatus, number>>>((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {});
}
