import { runAsAccount } from "./accounts";
import type { WorkspaceSession } from "./auth-core";
import "server-only";
import { compatibleIllustrations, ILLUSTRATION_VERSION } from "../domain/illustrations";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DocumentDecisionSchema, ClaimSchema, LineSchema, TurnSchema, type Encounter } from "../domain/schema";
import { activeAttempt, applyRuleCheck, approveNote, approveSheet, buildSheet, checkEncounter, fingerprint, hasCurrentNoteApproval, hasCurrentSheetApproval, invalidate, makeTeachBack, projectAttempt, questionLines, reviewFingerprint, runChecks, savedNote, savedReview, sheetFingerprint, startAttempt, teachBackStateFingerprint, transcriptFingerprint, unresolvedTeachBack, WorkflowError } from "../domain/workflow";
import { beginJob, endJob, loadAudio, loadSourceDocument, loadEncounter, loadSpokenQuestionAudio, loadTeachBackAudio, saveEncounter, workspaceOwner } from "./db";
import { extractDocument, analyzeTeachBack, generateCandidateSheet, generateNote, MODEL, proposeNoteCorrection, reviewNote, reviewSheet, selectPlanQuestionLines, transcribe } from "./meta";
import { requireStudio } from "./http";
import { dismissReviewFinding, verifyCorrectionProposal, verifyReviewFindings, verifyTeachBackFindings } from "./review";
import type { AiReview } from "../domain/schema";
export const ActionSchema = z.object({
  action: z.enum(["attach-illustration", "remove-illustration", "extract-document", "accept-document", "document-demo", "consent", "transcript", "map-speakers", "confirm-transcript", "generate-note", "edit-note", "checks", "approve-note", "propose-note-correction", "accept-note-proposal", "reject-note-proposal", "generate-sheet", "edit-sheet", "approve-sheet", "ask-plan-question", "transcribe-spoken-question", "edit-spoken-question-transcript", "confirm-spoken-question", "ask-spoken-plan-question", "teach-back", "start-teach-back-attempt", "set-companion", "set-required-respondent", "set-respondent", "record-teach-back", "record-print-exception", "revoke-print-exception", "plant-error", "run-note-review", "run-sheet-review", "dismiss-review", "manual-review", "transcribe-teach-back", "edit-teach-back-transcript", "analyze-teach-back", "manual-teach-back"]),
  lineId: z.string().max(40).optional(), illustrationId: z.string().max(40).optional(),
  documentId: z.string().max(40).optional(), documentDecisions: z.array(DocumentDecisionSchema).min(1).max(40).optional(),
  expectedVersion: z.number().int().positive(), value: z.boolean().optional(),
  turns: z.array(TurnSchema).min(1).max(100).optional(), claims: z.array(ClaimSchema).min(1).max(40).optional(), lines: z.array(LineSchema).min(1).max(40).optional(),
  reviewer: z.string().min(1).max(80).optional(), confirmed: z.boolean().optional(),
  provider: z.enum(["saved", "live"]).optional(),
  speakerRoles: z.record(z.string().min(1).max(40), z.enum(["clinician", "patient", "unknown"])).optional(),
  stage: z.enum(["note", "sheet"]).optional(), findingId: z.string().max(100).optional(), proposalId: z.string().max(100).optional(), questionId: z.string().max(40).optional(), question: z.string().max(500).optional(), transcript: z.string().max(3000).optional(),
  outcomes: z.record(z.string(), z.enum(["pending", "understood", "reexplained", "not-understood"])).optional(), reason: z.string().max(500).optional(),
  overrideReasons: z.record(z.string(), z.string().max(500)).optional(), respondent: z.enum(["patient", "companion"]).optional(), relation: z.string().max(40).optional(),
}).strict();
type Action = z.infer<typeof ActionSchema>;
export async function act(owner: WorkspaceSession, id: string, requestKey: string, input: Action): Promise<Encounter> {
  return runAsAccount(owner, () => performAction(owner, id, requestKey, input));
}
async function performAction(owner: WorkspaceSession, id: string, requestKey: string, input: Action): Promise<Encounter> {
  owner = { ...owner, id: workspaceOwner(owner.id, id) };
  if (owner.user) input = { ...input, reviewer: owner.user.name };
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(requestKey)) throw new WorkflowError("A valid request key is required.", 400);
  // Verify ownership before looking up idempotent results.
  const previous = loadEncounter(owner.id, id);
  const job = beginJob(owner.id, requestKey, fingerprint({ id, input }));
  if (job.cached) return previous.version > job.cached.version ? previous : job.cached;
  try {
    if (previous.version !== input.expectedVersion) throw new WorkflowError("This encounter changed in another tab. Reload before continuing.");
    let e = structuredClone(previous);
    switch (input.action) {
      case "attach-illustration": {
        const line = e.lines.find(l => l.id === input.lineId);
        if (!line || !hasCurrentNoteApproval(e) || !input.confirmed || !input.reviewer?.trim() || !compatibleIllustrations(line).some(item => item.id === input.illustrationId)) throw new WorkflowError("Choose a compatible illustration, review its meaning and enter the reviewer name.", 400);
        const selected = [...(e.illustrations ?? []).filter(item => item.lineId !== line.id), { lineId: line.id, illustrationId: input.illustrationId!, libraryVersion: ILLUSTRATION_VERSION, lineFingerprint: fingerprint(line), reviewer: input.reviewer.trim(), at: new Date().toISOString() }];
        e = invalidate(e, "sheet"); e.illustrations = selected; e = runChecks(e);
        e.sheetReview = owner.role === "judge" ? savedReview(e, "sheet") : null; break;
      }
      case "remove-illustration": {
        const selected = (e.illustrations ?? []).filter(item => item.lineId !== input.lineId);
        if (selected.length === (e.illustrations?.length ?? 0)) throw new WorkflowError("Choose an attached illustration.", 400);
        e = invalidate(e, "sheet"); e.illustrations = selected; e = runChecks(e); e.sheetReview = owner.role === "judge" ? savedReview(e, "sheet") : null; break;
      }
      case "document-demo": {
        if (!e.consent) throw new WorkflowError("Confirm synthetic-data permission first.");
        if (owner.role !== "judge") throw new WorkflowError("Saved document preview is available in Saved Demo only.");
        if ((e.documents?.length ?? 0) >= 6) throw new WorkflowError("This encounter already has six documents.");
        e.documents ??= []; e.documents.push({ id: randomUUID(), name: "Synthetic document preview", mime: "text/plain", hash: fingerprint(e.turns), createdAt: new Date().toISOString(), fixtureText: e.turns.map(t => t.text).join("\n\n"), extraction: { lines: e.turns.map((t, i) => ({ id: `d${i + 1}`, page: 1, text: t.text })), model: "none", promptVersion: "saved-document-fixture@1", latencyMs: 0, costUsd: 0 }, accepted: null }); break;
      }
      case "extract-document": {
        requireStudio(owner);
        if (process.env.ENABLE_DOCUMENT_IMPORT !== "true") throw new WorkflowError("Document import is disabled.", 403);
        const doc = e.documents?.find(d => d.id === input.documentId);
        if (!e.consent || !doc || doc.accepted || doc.extraction) throw new WorkflowError("Choose an uploaded, unprocessed document. Completed extraction is preserved.");
        const attachment = loadSourceDocument(owner.id, e.id, doc.id);
        if (!attachment) throw new WorkflowError("Upload a source document first.");
        const result = await extractDocument({ ...attachment, name: doc.name });
        if (new Set(result.data.lines.map(l => l.id)).size !== result.data.lines.length || (doc.mime !== "application/pdf" && result.data.lines.some(l => l.page !== 1))) throw new WorkflowError("Extraction returned invalid source references. Nothing was applied.", 502);
        doc.extraction = { lines: result.data.lines, model: MODEL.text, promptVersion: result.promptVersion, latencyMs: result.latencyMs, costUsd: result.costUsd, costBasis: result.costBasis }; break;
      }
      case "accept-document": {
        requireStudio(owner);
        const doc = e.documents?.find(d => d.id === input.documentId), decisions = input.documentDecisions;
        if (!e.consent || !doc?.extraction || doc.accepted || !decisions?.length || !input.confirmed || !input.reviewer?.trim()) throw new WorkflowError("Review the original, confirm selected lines and enter the reviewer name.", 400);
        if (new Set(decisions.map(d => d.lineId)).size !== decisions.length || decisions.some(d => !doc.extraction!.lines.some(l => l.id === d.lineId)) || e.turns.length + decisions.length > 100) throw new WorkflowError("Choose unique extracted lines within the 100-turn limit.", 400);
        const accepted = { reviewer: input.reviewer.trim(), at: new Date().toISOString(), decisions };
        doc.accepted = accepted;
        e = invalidate(e, "transcript");
        e.turns = [...previous.turns, ...decisions.map((d, i) => ({ id: `doc-${doc.id.slice(0, 8)}-${i + 1}`, speaker: d.speaker, text: d.text, startMs: 0, endMs: 0, documentSource: { documentId: doc.id, lineId: d.lineId, page: doc.extraction!.lines.find(l => l.id === d.lineId)!.page } }))];
        e.mode = "live"; e.provenance.transcript = "Consultation plus human-confirmed synthetic document lines. Document page references are separate from audio timestamps. Drafts and approvals cleared."; break;
      }
      case "consent": e.consent = input.value === true; if (!e.consent) e = invalidate(e, "note"); break;
      case "transcript":
        if (!input.turns) throw new WorkflowError("Transcript turns are required.", 400);
        if (input.turns.some(t => t.endMs < t.startMs)) throw new WorkflowError("A turn cannot end before it starts.", 400);
        e = invalidate(e, "transcript"); e.turns = input.turns;
        e.provenance.transcript = previous.mode === "saved" ? "Human-corrected saved reference. No transcription model call." : "Human-corrected live transcript.";
        break;
      case "map-speakers": {
        if (!e.recordingFingerprint || !input.speakerRoles || !input.confirmed || !input.reviewer?.trim()) throw new WorkflowError("Confirm speaker roles and enter the reviewer name.", 400);
        const labels = [...new Set(e.turns.map(t => t.providerSpeaker).filter((v): v is string => !!v))];
        if (!labels.length || Object.keys(input.speakerRoles).some(label => !labels.includes(label))) throw new WorkflowError("Map only labels from this recording.", 400);
        e = invalidate(e, "transcript");
        e.turns = previous.turns.map(t => t.providerSpeaker && !t.roleOverride ? { ...t, speaker: input.speakerRoles![t.providerSpeaker] ?? "unknown" } : t);
        e.speakerMapping = { recordingFingerprint: previous.recordingFingerprint!, roles: input.speakerRoles, reviewer: input.reviewer.trim(), confirmedAt: new Date().toISOString() };
        break;
      }
      case "confirm-transcript": {
        if (!input.confirmed || !input.reviewer?.trim() || !e.turns.length || e.turns.some(t => t.speaker === "unknown")) throw new WorkflowError("Review every transcript turn, confirm roles, and enter the reviewer name.", 400);
        if (e.turns.some(t => t.providerSpeaker) && (!e.speakerMapping || e.speakerMapping.recordingFingerprint !== e.recordingFingerprint)) throw new WorkflowError("Confirm this recording's speaker-label mapping first.");
        e.transcriptConfirmation = { fingerprint: transcriptFingerprint(e), reviewer: input.reviewer.trim(), at: new Date().toISOString(), recordingFingerprint: e.recordingFingerprint ?? null };
        break;
      }
      case "generate-note": {
        if (!e.consent) throw new WorkflowError("Confirm that this encounter contains synthetic data only.");
        if (e.turns.some(t => t.speaker === "unknown")) throw new WorkflowError("Assign clinician and patient roles to every transcript turn first.");
        if (owner.role === "studio" && e.transcriptConfirmation?.fingerprint !== transcriptFingerprint(e)) throw new WorkflowError("Confirm the current transcript and speaker roles before drafting.");
        if (input.provider === "live") {
          requireStudio(owner);
          const result = await generateNote(e.turns);
          e = invalidate(e, "note"); e.claims = result.data.claims;
          e.provenance.note = `Live model draft · ${MODEL.text} · ${result.promptVersion} · ${result.latencyMs} ms · $${result.costUsd.toFixed(5)} (${result.costBasis === "measured-tokens" ? "calculated from reported tokens" : "undiscounted estimate; cache unknown"}). Human review required.`;
        } else { const claims = savedNote(e); e = invalidate(e, "note"); e.claims = claims; e.noteReview = owner.role === "judge" ? savedReview(e, "note") : null; e.provenance.note = "Saved, human-authored synthetic draft. No model call."; }
        e = runChecks(e); break;
      }
      case "edit-note":
        if (!input.claims) throw new WorkflowError("Claims are required.", 400);
        e = invalidate(e, "note"); e.claims = input.claims; e.provenance.note = "Human-corrected draft; check current sources before approval."; e = runChecks(e); break;
      case "propose-note-correction": {
        requireStudio(owner);
        if (process.env.ENABLE_NOTE_CORRECTIONS !== "true") throw new WorkflowError("Note correction proposals are disabled.", 403);
        const review = e.noteReview;
        if (!review || review.status !== "live" || review.fingerprint !== reviewFingerprint(e, "note")) throw new WorkflowError("Run a current live note comparison first.");
        const finding = review.findings.find(f => f.id === input.findingId && !f.dismissal);
        const claim = e.claims.find(c => c.id === finding?.targetId);
        if (!finding || !claim) throw new WorkflowError("Select a finding on an existing claim; omissions require human source review.", 400);
        const sources = claim.sourceTurnIds.map(id => e.turns.find(t => t.id === id)!);
        const result = await proposeNoteCorrection(finding, claim, sources);
        const after = verifyCorrectionProposal(e, claim, result.data.sourceQuote, result.data.correctedFact);
        e.noteProposals ??= [];
        e.noteProposals.push({ id: randomUUID(), findingId: finding.id, claimId: claim.id, sourceFingerprint: reviewFingerprint(e, "note"), before: structuredClone(claim), after, sourceQuote: result.data.sourceQuote, explanation: result.data.explanation, model: MODEL.text, promptVersion: result.promptVersion, latencyMs: result.latencyMs, costUsd: result.costUsd, costBasis: result.costBasis, status: "pending" });
        e.noteProposals = e.noteProposals.slice(-20);
        break;
      }
      case "accept-note-proposal":
      case "reject-note-proposal": {
        const proposal = e.noteProposals?.find(p => p.id === input.proposalId);
        if (!proposal || proposal.status !== "pending" || proposal.sourceFingerprint !== reviewFingerprint(e, "note")) throw new WorkflowError("This proposal is stale or unavailable. Review the current note.");
        if (!input.reviewer?.trim() || !input.confirmed) throw new WorkflowError("Name the reviewer and explicitly confirm this decision.", 400);
        if (input.action === "reject-note-proposal") {
          if ((input.reason?.trim().length ?? 0) < 8) throw new WorkflowError("Record why the proposal was rejected.", 400);
          proposal.status = "rejected"; proposal.reviewer = input.reviewer.trim(); proposal.decisionReason = input.reason!.trim(); proposal.decidedAt = new Date().toISOString(); break;
        }
        const current = e.claims.find(c => c.id === proposal.claimId);
        if (!current || fingerprint(current) !== fingerprint(proposal.before)) throw new WorkflowError("The claim changed after this proposal. Review it again.");
        verifyCorrectionProposal(e, current, proposal.sourceQuote, proposal.after.fact);
        e = invalidate(e, "note"); e.claims = e.claims.map(c => c.id === proposal.claimId ? structuredClone(proposal.after) : c); e = runChecks(e);
        const accepted = e.noteProposals!.find(p => p.id === proposal.id)!;
        accepted.status = "accepted"; accepted.reviewer = input.reviewer.trim(); accepted.decidedAt = new Date().toISOString();
        e.provenance.note = "Reviewer-accepted correction; fresh checks and discrepancy review required.";
        break;
      }
      case "checks": e = runChecks(e); break;
      case "run-note-review":
      case "run-sheet-review": {
        requireStudio(owner);
        const stage = input.action === "run-note-review" ? "note" : "sheet";
        if (!e.claims.length || (stage === "sheet" && (!e.lines.length || !hasCurrentNoteApproval(e)))) throw new WorkflowError("Complete the preceding review step first.");
        const old = stage === "note" ? e.noteReview : e.sheetReview;
        if (old?.fingerprint === reviewFingerprint(e, stage) && old.findings.some(f => !f.dismissal)) throw new WorkflowError("Resolve or dismiss current findings before running this review again.");
        const result = stage === "note" ? await reviewNote(e.turns, e.claims) : await reviewSheet(e.claims, e.lines);
        const findings = verifyReviewFindings(stage, result.data.findings, e.turns, e.claims, e.lines);
        const review: AiReview = { status: "live", fingerprint: reviewFingerprint(e, stage), findings, model: MODEL.text, promptVersion: result.promptVersion, latencyMs: result.latencyMs, costUsd: result.costUsd, costBasis: result.costBasis };
        if (stage === "note") e.noteReview = review; else e.sheetReview = review;
        break;
      }
      case "dismiss-review": {
        requireStudio(owner);
        if (!input.stage || !input.findingId) throw new WorkflowError("Select a finding and review stage.", 400);
        const current = input.stage === "note" ? e.noteReview : e.sheetReview;
        if (!current || current.fingerprint !== reviewFingerprint(e, input.stage)) throw new WorkflowError("The review is stale. Run it again.");
        const updated = dismissReviewFinding(current, input.findingId, input.reviewer ?? "", input.reason ?? "");
        if (input.stage === "note") e.noteReview = updated; else e.sheetReview = updated;
        break;
      }
      case "manual-review": {
        if (!input.stage || !input.reviewer?.trim() || (input.reason?.trim().length ?? 0) < 8) throw new WorkflowError("Choose the stage and record reviewer initials plus a reason of at least 8 characters.", 400);
        const current = input.stage === "note" ? e.noteReview : e.sheetReview;
        if (current?.fingerprint === reviewFingerprint(e, input.stage) && current.findings.some(f => !f.dismissal)) throw new WorkflowError("Resolve current model findings; manual fallback cannot erase them.");
        const review: AiReview = { status: "manual", fingerprint: reviewFingerprint(e, input.stage), findings: [], model: "none", promptVersion: "manual-fallback@1", latencyMs: null, costUsd: null, reviewer: input.reviewer.trim(), reason: input.reason!.trim() };
        if (input.stage === "note") e.noteReview = review; else e.sheetReview = review;
        break;
      }
      case "approve-note": e = approveNote(e, input.reviewer ?? "", input.confirmed === true); break;
      case "generate-sheet": {
        const lines = buildSheet(e);
        if (input.provider === "live") {
          requireStudio(owner);
          if (process.env.SHEET_MODE !== "model") throw new WorkflowError("Model sheet mode is gated until clinician and native-speaker review. Use the controlled template.");
          const result = await generateCandidateSheet(e.claims);
          e = invalidate(e, "sheet"); e.lines = result.data.lines; e.sheetMode = "model";
          e.provenance.sheet = `Live candidate · ${MODEL.text} · ${result.promptVersion}. Controlled-template checks and human approval are still required.`;
        } else { e = invalidate(e, "sheet"); e.lines = lines; e.sheetMode = "template"; e.sheetReview = owner.role === "judge" ? savedReview(e, "sheet") : null; e.provenance.sheet = "Controlled Filipino template draft. Not clinician or native-speaker validated."; }
        e = runChecks(e); break;
      }
      case "edit-sheet":
        if (!input.lines) throw new WorkflowError("Sheet lines are required.", 400);
        e = invalidate(e, "sheet"); e.lines = input.lines; e.provenance.sheet = "Human-edited sheet draft. Changed template text must be regenerated before export."; e = runChecks(e); break;
      case "plant-error": {
        const warning = e.lines.find(l => l.fact.kind === "warning" && l.fact.urgency === "immediate");
        if (!warning) throw new WorkflowError("Generate a sheet with an immediate warning first.");
        e = invalidate(e, "sheet");
        const line = e.lines.find(l => l.id === warning.id)!;
        line.fact.urgency = "scheduled"; line.fact.delayDays = 3;
        line.text = `Bumalik pagkalipas ng 3 araw kung ${line.fact.condition}.`;
        e.provenance.sheet = "Labelled planted timing error for demonstration. Export is blocked.";
        e = runChecks(e); break;
      }
      case "approve-sheet": e = approveSheet(e, input.reviewer ?? "", input.confirmed === true); break;
      case "transcribe-spoken-question":
      case "edit-spoken-question-transcript":
      case "confirm-spoken-question": {
        requireStudio(owner);
        if (process.env.ENABLE_PLAN_QUESTIONS !== "true" || process.env.ENABLE_SPOKEN_QUESTIONS !== "true") throw new WorkflowError("Spoken plan questions are disabled.", 403);
        const draft = e.spokenQuestionDrafts?.find(q => q.id === input.questionId && q.id === e.activeSpokenQuestionId);
        if (!draft || draft.answered || draft.sheetFingerprint !== sheetFingerprint(e) || !hasCurrentSheetApproval(e)) throw new WorkflowError("Choose a current unanswered spoken question.");
        if (input.action === "transcribe-spoken-question") {
          const audio = loadSpokenQuestionAudio(owner.id, id, draft.id);
          if (!audio) throw new WorkflowError("The spoken question audio is missing.");
          const result = await transcribe(audio, "PUSH_TO_TALK");
          if (result.transcript.length > 500) throw new WorkflowError("The spoken question is too long. Correct it before asking.", 400);
          draft.rawTranscript = result.transcript; draft.correctedTranscript = null;
          draft.transcription = { model: MODEL.voice, latencyMs: result.latencyMs, costUsd: result.costUsd };
          draft.confirmedBy = null; draft.confirmedAt = null; draft.confirmedFingerprint = null;
        } else if (input.action === "edit-spoken-question-transcript") {
          if (!input.transcript?.trim() || input.transcript.trim().length < 4 || input.transcript.trim().length > 500) throw new WorkflowError("Enter a corrected question from four to 500 characters.", 400);
          draft.correctedTranscript = input.transcript.trim(); draft.confirmedBy = null; draft.confirmedAt = null; draft.confirmedFingerprint = null;
        } else {
          const text = draft.correctedTranscript ?? draft.rawTranscript;
          if (!text || !input.confirmed || !input.reviewer?.trim()) throw new WorkflowError("Review and explicitly confirm the spoken question transcript.", 400);
          draft.confirmedBy = input.reviewer.trim(); draft.confirmedAt = new Date().toISOString(); draft.confirmedFingerprint = fingerprint({ text, sheet: draft.sheetFingerprint });
        }
        break;
      }
      case "ask-plan-question":
      case "ask-spoken-plan-question": {
        if (process.env.ENABLE_PLAN_QUESTIONS !== "true") throw new WorkflowError("Plan questions are disabled.", 403);
        const spoken = input.action === "ask-spoken-plan-question";
        if (spoken && process.env.ENABLE_SPOKEN_QUESTIONS !== "true") throw new WorkflowError("Spoken plan questions are disabled.", 403);
        const draft = spoken ? e.spokenQuestionDrafts?.find(q => q.id === input.questionId && q.id === e.activeSpokenQuestionId) : undefined;
        const question = spoken ? (draft?.correctedTranscript ?? draft?.rawTranscript)?.trim() : input.question?.trim();
        if (!hasCurrentSheetApproval(e) || !question || question.length < 4) throw new WorkflowError("Approve the current sheet and enter a question of at least four characters.", 400);
        if (spoken && (!draft || draft.answered || draft.sheetFingerprint !== sheetFingerprint(e) || draft.confirmedFingerprint !== fingerprint({ text: question, sheet: draft.sheetFingerprint }))) throw new WorkflowError("Confirm the current spoken transcript before asking Spark.");
        const approvedLines = e.lines.map(l => ({ id: l.id, text: l.text }));
        let selected: { lineIds: string[]; needsReviewer: boolean }, model = "none", promptVersion = "saved-question-fixture@1", latencyMs: number | null = null, costUsd: number | null = null, costBasis: "measured-tokens" | "cache-unknown-estimate" | "unknown" | undefined;
        if (owner.role === "studio") {
          requireStudio(owner);
          const result = await selectPlanQuestionLines(question, approvedLines);
          selected = result.data; model = MODEL.text; promptVersion = result.promptVersion; latencyMs = result.latencyMs; costUsd = result.costUsd; costBasis = result.costBasis;
        } else {
          const uncertain = /\b(if|what if|extra|more|missed|allergy|pregnan|increase|other|unknown)\b|paano kung/i.test(question);
          const kind = /gamot|medicine|dose|tablet|antibiotic/i.test(question) ? ["medication", "negation"] : /warning|bumalik|lagnat|hinga/i.test(question) ? ["warning"] : /follow.?up|balik|kailan/i.test(question) ? ["followup"] : [];
          const ids = uncertain ? [] : e.lines.filter(l => kind.includes(l.fact.kind)).map(l => l.id);
          selected = { lineIds: ids, needsReviewer: !ids.length };
        }
        if (selected.needsReviewer ? selected.lineIds.length !== 0 : selected.lineIds.length === 0 || new Set(selected.lineIds).size !== selected.lineIds.length || selected.lineIds.some(lineId => !approvedLines.some(l => l.id === lineId))) throw new WorkflowError("The model cited invalid approved instruction lines. Ask the reviewer to answer.", 502);
        e.planQuestions ??= [];
        e.planQuestions = [...e.planQuestions, { id: draft?.id ?? randomUUID(), kind: spoken ? "spoken" as const : "typed" as const, question, ...(spoken ? { rawTranscript: draft?.rawTranscript ?? undefined, audioAvailable: true } : {}), sheetFingerprint: sheetFingerprint(e), lineIds: selected.lineIds, answerLines: approvedLines.filter(l => selected.lineIds.includes(l.id)), needsReviewer: selected.needsReviewer, model, promptVersion, latencyMs, costUsd, costBasis, askedAt: new Date().toISOString() }].slice(-100);
        if (draft) draft.answered = true;
        break;
      }
      case "teach-back":
        if (!e.teachBack.length || e.teachBack.some(t => t.sheetFingerprint !== sheetFingerprint(e))) { e.teachBack = makeTeachBack(e, owner.role === "judge"); e.teachBackSkip = ""; e.printException = null; }
        break;
      case "start-teach-back-attempt": {
        const q = e.teachBack.find(t => t.id === input.questionId && t.sheetFingerprint === sheetFingerprint(e));
        if (!q || !hasCurrentSheetApproval(e)) throw new WorkflowError("Approve the current sheet and select a question.");
        if (input.respondent === "companion" && !e.companion?.present) throw new WorkflowError("Record the companion before choosing them as the respondent.", 400);
        const attempt = startAttempt(q, input.respondent);
        if (owner.role === "judge") {
          attempt.rawTranscript = q.expected; applyRuleCheck(e, q, attempt);
          attempt.analysis = { status: "saved", transcript: q.expected, findings: [], model: "none", promptVersion: "saved-repeat-fixture@1", latencyMs: null, costUsd: null, sheetFingerprint: q.sheetFingerprint };
          projectAttempt(q);
        }
        e.teachBackSkip = ""; e.printException = null;
        break;
      }
      case "transcribe-teach-back": {
        requireStudio(owner);
        if (!input.questionId || !hasCurrentSheetApproval(e)) throw new WorkflowError("Approve the current sheet and select a question.");
        const q = e.teachBack.find(t => t.id === input.questionId && t.sheetFingerprint === sheetFingerprint(e));
        if (!q?.audioAvailable) throw new WorkflowError("Record this synthetic answer first.");
        const recorded = loadTeachBackAudio(owner.id, id, q.id, q.sheetFingerprint);
        if (!recorded) throw new WorkflowError("The current answer recording is missing.");
        const result = await transcribe(recorded, "PUSH_TO_TALK");
        const attempt = activeAttempt(q); attempt.rawTranscript = result.transcript; attempt.correctedTranscript = null; applyRuleCheck(e, q, attempt); e.printException = null;
        attempt.transcription = { model: MODEL.voice, latencyMs: result.latencyMs, costUsd: result.costUsd }; attempt.analysis = null; attempt.outcome = "pending"; attempt.reviewer = null; attempt.decidedAt = null; projectAttempt(q);
        break;
      }
      case "edit-teach-back-transcript": {
        requireStudio(owner);
        const q = e.teachBack.find(t => t.id === input.questionId && t.sheetFingerprint === sheetFingerprint(e));
        if (!q || !input.transcript?.trim()) throw new WorkflowError("Enter the corrected answer transcript.", 400);
        const attempt = activeAttempt(q); attempt.correctedTranscript = input.transcript.trim(); applyRuleCheck(e, q, attempt); attempt.analysis = null; attempt.outcome = "pending"; attempt.reviewer = null; attempt.decidedAt = null; projectAttempt(q); e.printException = null;
        break;
      }
      case "analyze-teach-back": {
        requireStudio(owner);
        const q = e.teachBack.find(t => t.id === input.questionId && t.sheetFingerprint === sheetFingerprint(e));
        if (!q?.transcript || !hasCurrentSheetApproval(e)) throw new WorkflowError("Transcribe the current answer first.");
        const lines = questionLines(e, q.id);
        const result = await analyzeTeachBack(q.question, lines.map(l => ({ id: l.id, text: l.text })), q.transcript);
        const attempt = activeAttempt(q); e.printException = null;
        attempt.analysis = { status: "live", transcript: q.transcript, findings: verifyTeachBackFindings(result.data.findings, lines, q.transcript), model: MODEL.text, promptVersion: result.promptVersion, latencyMs: result.latencyMs, costUsd: result.costUsd, costBasis: result.costBasis, sheetFingerprint: sheetFingerprint(e) }; attempt.outcome = "pending"; attempt.reviewer = null; attempt.decidedAt = null; projectAttempt(q);
        break;
      }
      case "manual-teach-back": {
        const q = e.teachBack.find(t => t.id === input.questionId && t.sheetFingerprint === sheetFingerprint(e));
        if (!q || !input.reviewer?.trim() || (input.reason?.trim().length ?? 0) < 8) throw new WorkflowError("Select a question and record reviewer initials plus a reason of at least 8 characters.", 400);
        if (q.analysis?.status === "live" && q.analysis.findings.length) throw new WorkflowError("Record the outcome for current model findings; manual fallback cannot erase them.");
        const attempt = activeAttempt(q); e.printException = null;
        attempt.analysis = { status: "manual", transcript: q.transcript ?? "", findings: [], model: "none", promptVersion: "manual-fallback@1", latencyMs: null, costUsd: null, sheetFingerprint: sheetFingerprint(e), reviewer: input.reviewer.trim(), reason: input.reason!.trim() }; attempt.outcome = "pending"; attempt.reviewer = null; attempt.decidedAt = null; projectAttempt(q);
        break;
      }
      case "record-teach-back": {
        if (input.reason?.trim()) { e.teachBackSkip = input.reason.trim(); e.printException = null; break; }
        if (!e.teachBack.length || !input.outcomes) throw new WorkflowError("Create the teach-back questions first.");
        if (!input.reviewer?.trim()) throw new WorkflowError("Enter the reviewer name before recording an outcome.", 400);
        for (const q of e.teachBack) {
          const outcome = input.outcomes[q.id]; if (!outcome) continue;
          const attempt = activeAttempt(q), override = input.overrideReasons?.[q.id]?.trim() ?? "";
          if (outcome !== "pending" && !attempt.analysis) throw new WorkflowError("Compare or manually review this answer before recording its outcome.");
          if (outcome !== "pending" && e.companion?.present && !attempt.respondent) throw new WorkflowError("Record who gave this answer, the patient or the companion, before recording its outcome.", 400);
          if (outcome === "understood" && attempt.ruleCheck?.findings.length && override.length < 8) throw new WorkflowError("The rule check flagged this answer. Explain again and record another answer, or give a reason of at least 8 characters for marking it understood.", 400);
          attempt.outcome = outcome; attempt.reviewer = input.reviewer.trim(); attempt.decidedAt = new Date().toISOString();
          attempt.overrideReason = outcome === "understood" && attempt.ruleCheck?.findings.length ? override : null; projectAttempt(q);
        }
        e.teachBackSkip = ""; e.printException = null; break;
      }
      case "record-print-exception": {
        if (!hasCurrentSheetApproval(e) || checkEncounter(e).length || !e.teachBack.length) throw new WorkflowError("Finish current note and sheet reviews before recording a print exception.");
        const unresolved = unresolvedTeachBack(e);
        if (!unresolved.length) throw new WorkflowError("All current answers are understood; an exception is not needed.");
        if (!input.confirmed || !input.reviewer?.trim() || (input.reason?.trim().length ?? 0) < 8) throw new WorkflowError("Confirm the exception, name the reviewer, and record a reason of at least 8 characters.", 400);
        e.printException = { reviewer: input.reviewer.trim(), reason: input.reason!.trim(), at: new Date().toISOString(), sheetFingerprint: sheetFingerprint(e), attemptFingerprint: teachBackStateFingerprint(e), unresolvedQuestionIds: unresolved };
        break;
      }
      case "revoke-print-exception": e.printException = null; break;
      case "set-companion": {
        const present = !!input.value, relation = input.relation?.trim() ?? "";
        if (present && !relation) throw new WorkflowError("Name the companion's relationship, for example anak or asawa.", 400);
        e.companion = present ? { present, relation } : null;
        // Without a companion, every question returns to the patient; earlier companion answers stay in history but no longer satisfy print.
        if (!present) for (const q of e.teachBack) q.requiredRespondent = "patient";
        e.printException = null; break;
      }
      case "set-required-respondent": {
        const q = e.teachBack.find(t => t.id === input.questionId && t.sheetFingerprint === sheetFingerprint(e));
        if (!q || !input.respondent) throw new WorkflowError("Select a current question and who must answer it.", 400);
        if (input.respondent === "companion" && !e.companion?.present) throw new WorkflowError("Record the companion first.", 400);
        q.requiredRespondent = input.respondent; e.printException = null; break;
      }
      case "set-respondent": {
        const q = e.teachBack.find(t => t.id === input.questionId && t.sheetFingerprint === sheetFingerprint(e));
        if (!q || !input.respondent) throw new WorkflowError("Select a current question and who answered.", 400);
        if (input.respondent === "companion" && !e.companion?.present) throw new WorkflowError("Record the companion first.", 400);
        const attempt = activeAttempt(q);
        if (attempt.respondent !== input.respondent) { attempt.respondent = input.respondent; attempt.outcome = "pending"; attempt.reviewer = null; attempt.decidedAt = null; attempt.overrideReason = null; projectAttempt(q); }
        e.printException = null; break;
      }
    }
    e.version = previous.version + 1; e.lastError = null;
    if (["confirm-transcript", "generate-note", "run-note-review", "approve-note", "generate-sheet", "run-sheet-review", "approve-sheet"].includes(input.action)) {
      e.preparation ??= { completed: [] };
      const source = input.action === "confirm-transcript" ? transcriptFingerprint(e) : ["generate-note", "run-note-review", "approve-note"].includes(input.action) ? reviewFingerprint(e, "note") : reviewFingerprint(e, "sheet");
      e.preparation.completed = [...e.preparation.completed, { action: input.action, requestKey, fingerprint: source, at: new Date().toISOString() }].slice(-50);
    }
    e.audit = [...e.audit, { ...(owner.userId ? { actorId: owner.userId } : {}), action: input.action, at: new Date().toISOString(), version: e.version }].slice(-100);
    saveEncounter(owner.id, previous.version, e); endJob(job.id, e); return e;
  } catch (error) { endJob(job.id); throw error; }
}
export async function transcribeEncounter(owner: WorkspaceSession, id: string, version: number, key: string) {
  return runAsAccount(owner, () => performTranscription(owner, id, version, key));
}
async function performTranscription(owner: WorkspaceSession, id: string, version: number, key: string) {
  owner = { ...owner, id: workspaceOwner(owner.id, id) };
  requireStudio(owner);
  const previous = loadEncounter(owner.id, id);
  const job = beginJob(owner.id, key, fingerprint({ id, version, action: "transcribe" }));
  if (job.cached) return previous.version > job.cached.version ? previous : job.cached;
  try {
    if (previous.version !== version) throw new WorkflowError("Reload the encounter before transcribing.");
    const audio = loadAudio(owner.id, id); if (!audio) throw new WorkflowError("Record or upload a synthetic WAV first.");
    const result = await transcribe(audio);
    let e = invalidate(previous, "transcript"); e.turns = result.turns; e.mode = "live"; e.speakerMapping = null; e.version++;
    e.consultationTranscriptions = [...(previous.consultationTranscriptions ?? []), {
      transcript: result.transcript, turns: structuredClone(result.turns), providerLabels: [...result.labels],
      recordingFingerprint: previous.recordingFingerprint ?? null, model: MODEL.voice, requestKey: key,
      at: new Date().toISOString(), latencyMs: result.latencyMs, estimatedCostUsd: result.costUsd,
    }];
    e.preparation ??= { completed: [] }; e.preparation.completed = [...e.preparation.completed, { action: "transcribe", requestKey: key, fingerprint: transcriptFingerprint(e), at: new Date().toISOString() }].slice(-50);
    e.provenance.transcript = `Live transcription · ${MODEL.voice} · ${result.latencyMs} ms · estimated $${result.costUsd.toFixed(5)}. Speaker labels: ${result.labels.join(", ")}. Assign roles manually.`;
    e.audit = [...e.audit, { ...(owner.userId ? { actorId: owner.userId } : {}), action: "transcribe", at: new Date().toISOString(), version: e.version }].slice(-100);
    saveEncounter(owner.id, previous.version, e); endJob(job.id, e); return e;
  } catch (error) { endJob(job.id); throw error; }
}
