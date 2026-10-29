import type { AiReview, Claim, Fact, ReviewFinding, SheetLine, Turn, Encounter } from "../domain/schema";
import { renderEnglish } from "../domain/render";
import { checkEncounter, fingerprint, WorkflowError } from "../domain/workflow";

export function verifyCorrectionProposal(e: Encounter, claim: Claim, sourceQuote: string, correctedFact: Fact): Claim {
  const sources = claim.sourceTurnIds.map(id => e.turns.find(t => t.id === id));
  if (sources.some(t => !t || t.speaker !== "clinician") || !sources.some(t => t!.text.includes(sourceQuote))) throw new WorkflowError("The correction cited unsupported clinician evidence.", 502);
  if (fingerprint(claim.fact) === fingerprint(correctedFact)) throw new WorkflowError("The proposal did not change the flagged claim.", 502);
  const after = { ...claim, fact: correctedFact };
  const candidate: Encounter = { ...e, claims: e.claims.map(c => c.id === claim.id ? after : c) };
  if (checkEncounter(candidate).some(c => c.target === claim.id && c.severity === "error")) throw new WorkflowError("The proposed correction is not supported by its cited source.", 502);
  return after;
}

type Candidate = Omit<ReviewFinding, "id" | "dismissal">;
export function verifyReviewFindings(stage: "note" | "sheet", findings: Candidate[], turns: Turn[], claims: Claim[], lines: SheetLine[]): ReviewFinding[] {
  const sources = new Map(stage === "note"
    ? turns.filter(t => t.speaker === "clinician").map(t => [t.id, t.text] as const)
    : claims.map(c => [c.id, renderEnglish(c.fact)] as const));
  const targets = new Map(stage === "note"
    ? claims.map(c => [c.id, renderEnglish(c.fact)] as const)
    : lines.map(l => [l.id, l.text] as const));
  const verified = findings.map(f => {
    if (new Set(f.sourceIds).size !== f.sourceIds.length || !f.sourceIds.every(id => sources.has(id)) || !f.sourceIds.some(id => sources.get(id)!.includes(f.sourceQuote))) throw new WorkflowError("The model review cited invalid source evidence. Use documented manual review or retry.", 502);
    if (f.category === "omission") {
      if (f.targetId || f.targetQuote) throw new WorkflowError("The model review returned an invalid omission target.", 502);
    } else if (!f.targetId || !targets.get(f.targetId)?.includes(f.targetQuote) || !f.targetQuote) {
      throw new WorkflowError("The model review cited invalid target evidence. Use documented manual review or retry.", 502);
    }
    return { ...f, id: fingerprint({ stage, ...f }).slice(0, 16) };
  });
  if (new Set(verified.map(f => f.id)).size !== verified.length) throw new WorkflowError("The model review returned duplicate findings. Retry or use documented manual review.", 502);
  return verified;
}

export function verifyTeachBackFindings(
  findings: { category: "missing" | "changed" | "unclear"; sourceLineIds: string[]; expectedQuote: string; responseQuote: string; explanation: string }[],
  lines: SheetLine[], transcript: string,
) {
  const source = new Map(lines.map(l => [l.id, l.text] as const));
  for (const f of findings) {
    if (new Set(f.sourceLineIds).size !== f.sourceLineIds.length || !f.sourceLineIds.every(id => source.has(id)) || !f.sourceLineIds.some(id => source.get(id)!.includes(f.expectedQuote))) throw new WorkflowError("Teach-back analysis cited invalid sheet evidence. Use documented manual review or retry.", 502);
    if (f.responseQuote && !transcript.includes(f.responseQuote)) throw new WorkflowError("Teach-back analysis quoted words absent from the response.", 502);
    if (f.category !== "missing" && !f.responseQuote) throw new WorkflowError("Teach-back analysis omitted its response quote.", 502);
  }
  return findings;
}

export function dismissReviewFinding(review: AiReview, id: string, reviewer: string, reason: string): AiReview {
  if (!reviewer.trim() || reason.trim().length < 8) throw new WorkflowError("Enter reviewer initials and a reason of at least 8 characters.", 400);
  const finding = review.findings.find(f => f.id === id);
  if (!finding) throw new WorkflowError("Review finding not found.", 404);
  return { ...review, findings: review.findings.map(f => f.id === id ? { ...f, dismissal: { reviewer: reviewer.trim(), reason: reason.trim(), at: new Date().toISOString() } } : f) };
}
