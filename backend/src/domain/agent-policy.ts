import type { Encounter, TeachBack } from "./schema";
import type { AgentCapability, AgentMode, AgentPlan, AgentRun, ReviewerHandoff } from "./agent-contract";
import { AgentPlanSchema } from "./agent-contract";
import { checkEncounter, currentPrintException, exportReasons, fingerprint, hasCurrentNoteApproval, hasCurrentSheetApproval, normalizeAttempts, noteFingerprint, sheetFingerprint, transcriptFingerprint, WorkflowError } from "./workflow";

export function agentFingerprint(e: Encounter, mode: AgentMode, questionId: string | null) {
  if (mode === "source_review") return fingerprint({ consent: e.consent, source: transcriptFingerprint(e), claims: e.claims, confirmed: e.transcriptConfirmation });
  const q = e.teachBack.find(q => q.id === questionId), attempt = q?.attempts?.find(a => a.id === q.activeAttemptId);
  return fingerprint({ consent: e.consent, sheet: sheetFingerprint(e), approved: hasCurrentSheetApproval(e), question: q?.id ?? null, attempt: attempt?.id ?? null, text: attempt?.correctedTranscript ?? attempt?.rawTranscript ?? q?.transcript ?? null });
}
export function agentAnswer(q: TeachBack) {
  const a = q.attempts?.find(a => a.id === q.activeAttemptId);
  return a?.correctedTranscript ?? a?.rawTranscript ?? q.transcript ?? q.analysis?.transcript ?? "";
}
export function requireAgentStart(e: Encounter, mode: AgentMode, questionId?: string) {
  if (!e.consent) throw new WorkflowError("Confirm synthetic-data permission first.");
  if (mode === "source_review" && !e.claims.length) throw new WorkflowError("Prepare the note before starting source review.");
  if (mode === "teach_back" && (!hasCurrentSheetApproval(e) || !e.teachBack.some(q => q.id === questionId && agentAnswer(q).trim() && q.sheetFingerprint === sheetFingerprint(e)))) throw new WorkflowError("Approve the current sheet and save an answer transcript first.");
}
export function agentCapabilities(e: Encounter, mode: AgentMode, questionId: string | null, correction: boolean, fixture: boolean): AgentCapability[] {
  const capabilities: AgentCapability[] = [{ tool: "reviewer_help", targetId: questionId ?? "", sourceIds: [], paid: false }];
  if (!e.consent) return capabilities;
  if (mode === "teach_back") {
    const q = e.teachBack.find(q => q.id === questionId);
    if (!q || !agentAnswer(q) || !hasCurrentSheetApproval(e) || q.sheetFingerprint !== sheetFingerprint(e)) return capabilities;
    capabilities.push({ tool: "prior_attempts", targetId: q.id, sourceIds: [], paid: false });
    if (!q.analysis || q.analysis.sheetFingerprint !== sheetFingerprint(e)) capabilities.push({ tool: "compare_answer", targetId: q.id, sourceIds: [], paid: !fixture });
    else if (q.analysis.findings.length) {
      const ids = [...new Set(q.analysis.findings.flatMap(f => f.sourceLineIds))].sort();
      if (ids.length && ids.every(id => e.lines.some(l => l.id === id))) capabilities.push({ tool: "approved_lines", targetId: q.id, sourceIds: ids, paid: false });
      capabilities.push({ tool: "repeat_answer", targetId: q.id, sourceIds: [], paid: false });
    }
    return capabilities;
  }
  for (const claim of e.claims) capabilities.push({ tool: "note_sources", targetId: claim.id, sourceIds: [...claim.sourceTurnIds].sort(), paid: false });
  const review = e.noteReview?.fingerprint === noteFingerprint(e) ? e.noteReview : null;
  const confirmed = fixture || (e.transcriptConfirmation?.fingerprint === transcriptFingerprint(e) && e.turns.every(t => t.speaker !== "unknown"));
  if (confirmed && (!review || !review.findings.some(f => !f.dismissal))) capabilities.push({ tool: "compare_note", targetId: "", sourceIds: [], paid: !fixture });
  if (confirmed && correction && review?.status === "live") for (const finding of review.findings.filter(f => !f.dismissal && f.category !== "omission")) {
    const claim = e.claims.find(c => c.id === finding.targetId);
    if (claim && !e.noteProposals?.some(p => p.status === "pending" && p.findingId === finding.id && p.sourceFingerprint === noteFingerprint(e))) capabilities.push({ tool: "propose_correction", targetId: finding.id, sourceIds: [...claim.sourceTurnIds].sort(), paid: !fixture });
  }
  return capabilities;
}
const reasons: Record<AgentPlan["tool"], AgentPlan["reason"][]> = {
  compare_answer: ["comparison_needed"], compare_note: ["comparison_needed"],
  approved_lines: ["changed_or_missing", "inspect_evidence"], note_sources: ["inspect_evidence"],
  prior_attempts: ["review_history"], repeat_answer: ["repeat_needed"],
  reviewer_help: ["human_review", "source_unclear"], propose_correction: ["supported_correction"],
};
export function validateAgentPlan(input: unknown, capabilities: AgentCapability[]): AgentPlan {
  const plan = AgentPlanSchema.parse(input);
  const capability = capabilities.find(c => c.tool === plan.tool && c.targetId === plan.targetId);
  if (!capability || !reasons[plan.tool].includes(plan.reason) || new Set(plan.sourceIds).size !== plan.sourceIds.length || fingerprint([...plan.sourceIds].sort()) !== fingerprint([...capability.sourceIds].sort())) throw new WorkflowError("The agent selected an unavailable action or unsupported evidence. Nothing was applied.", 502);
  return plan;
}
export function fixtureAgentPlan(e: Encounter, run: AgentRun, capabilities: AgentCapability[]): AgentPlan {
  const executed = run.events.filter(v => v.kind === "execute" && v.status === "done").map(v => v.plan?.tool);
  let selected: AgentCapability | undefined;
  if (run.mode === "teach_back") selected = e.teachBack.find(q => q.id === run.questionId)?.analysis?.findings.some(f => f.category === "unclear") ? capabilities[0] : capabilities.find(c => c.tool === "compare_answer") ?? capabilities.find(c => c.tool === "approved_lines" && !executed.includes("approved_lines")) ?? capabilities.find(c => c.tool === "repeat_answer");
  else {
    const issue = checkEncounter(e)[0];
    selected = capabilities.find(c => c.tool === "note_sources" && c.targetId === (issue?.target ?? e.claims[0]?.id) && !executed.includes("note_sources"));
    if (!selected && !issue && !executed.includes("compare_note")) selected = capabilities.find(c => c.tool === "compare_note");
  }
  selected ??= capabilities[0];
  return { tool: selected.tool, targetId: selected.targetId, sourceIds: selected.sourceIds, reason: reasons[selected.tool][0] };
}
export function reviewerHandoff(e: Encounter): ReviewerHandoff {
  const sheet = sheetFingerprint(e);
  return {
    version: e.version, noteApproved: hasCurrentNoteApproval(e), sheetApproved: hasCurrentSheetApproval(e),
    reviews: (["note", "sheet"] as const).map(stage => { const review = stage === "note" ? e.noteReview : e.sheetReview, approval = stage === "note" ? e.noteApproval : e.sheetApproval;
      return { stage, status: review?.status ?? "pending", current: !!review && review.fingerprint === (stage === "note" ? noteFingerprint(e) : sheet), reviewer: approval?.reviewer ?? review?.reviewer ?? null, at: approval?.at ?? null }; }),
    instructions: e.lines.map(l => ({ id: l.id, text: l.text, approved: hasCurrentSheetApproval(e), sourceIds: l.sourceClaimIds })),
    unresolved: [...checkEncounter(e).map(c => ({ id: c.id, stage: "structural check", text: c.message })), ...(["note", "sheet"] as const).flatMap(stage => (stage === "note" ? e.noteReview : e.sheetReview)?.findings.filter(f => !f.dismissal).map(f => ({ id: f.id, stage, text: f.explanation })) ?? [])],
    answers: [...e.teachBack, ...(e.teachBackArchive ?? [])].map(original => { const q = normalizeAttempts(original), current = e.teachBack.includes(original) && q.sheetFingerprint === sheet;
      return { id: q.id, question: q.question, current, outcome: q.outcome, attempts: (q.attempts ?? []).map(a => ({ id: a.id, outcome: a.outcome, reviewer: a.reviewer, at: a.decidedAt, analysis: a.analysis?.status ?? "pending", current: current && a.id === q.activeAttemptId && a.sheetFingerprint === sheet })) }; }),
    nextCheckpoints: exportReasons(e), exception: e.printException ? { current: currentPrintException(e), reviewer: e.printException.reviewer, reason: e.printException.reason } : null,
  };
}
