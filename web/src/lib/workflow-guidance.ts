import type { Encounter } from "@backend/domain/schema";

export type WorkflowView = { noteApproved: boolean; sheetApproved: boolean; exportReasons?: string[] };
export type Guidance = {
  step: number; title: string; detail: string; label?: string; action?: string;
  target?: string; paid?: boolean; blocked?: string; body?: Record<string, unknown>;
};
export type GuidanceOptions = {
  step?: number; studio: boolean; configured: boolean; referenceSelected?: boolean;
  transcriptDirty?: boolean; noteDirty?: boolean; answerDirty?: boolean; reviewer?: string; confirmed?: boolean;
  transcriptChecked?: boolean; speakerConfirmed?: boolean; speakerRolesReady?: boolean;
};
export function resumeStep(e: Encounter, view: WorkflowView) {
  if (!e.consent || !e.claims.length) return 0;
  if (!view.noteApproved) return 1;
  if (!view.sheetApproved) return 2;
  return 3;
}

// Presentation guidance only. Server responses continue to authorize every action.
export function workflowGuidance(e: Encounter, view: WorkflowView, options: GuidanceOptions): Guidance {
  const { studio, configured } = options;
  const step = options.step ?? resumeStep(e, view);
  const named = options.reviewer?.trim();
  const approvalBlock = !named ? "Enter a reviewer name above." : !options.confirmed ? "Confirm your review using the checkbox before approving." : undefined;
  const paidBlock = configured ? undefined : "Live models are unavailable. Use the manual review option below.";
  const go = (destination: number, title: string, label: string): Guidance => ({ step: destination, title, detail: "Complete this checkpoint before continuing.", label });
  if (options.transcriptDirty) return { step: 0, title: "Save your transcript edits", detail: "Saving clears dependent drafts, reviews and approvals.", label: "Save transcript edits", action: "transcript" };
  if (options.noteDirty) return { step: 1, title: "Save your note edits", detail: "The changed note will need fresh review.", label: "Save note edits", action: "edit-note" };
  if (options.answerDirty) return { step: 3, title: "Save your answer correction", detail: "Save the edited transcript before comparing, choosing an outcome or printing.", target: "teach-questions" };
  if (!e.consent) return { step: 0, title: "Confirm synthetic-data permission", detail: "Confirm the permission below before using this example or recording actors.", label: "Go to consultation", target: "synthetic-consent" };
  if (step === 0) {
    if (studio && !e.audioAvailable && !options.referenceSelected && !e.transcriptConfirmation && !e.claims.length)
      return { step, title: "Record the consultation", detail: "Record two actors using the fictional script, or choose another source below.", target: "consultation-recorder" };
    if (studio && e.audioAvailable && !e.turns.length)
      return { step, title: "Transcribe the recorded consultation", detail: "Review the transcript before preparing a note.", label: "Transcribe consultation", action: "transcribe", paid: true, blocked: configured ? undefined : "Live transcription is unavailable. Your recording stays saved." };
    const labels = e.turns.some(t => t.providerSpeaker);
    if (studio && labels && e.speakerMapping?.recordingFingerprint !== e.recordingFingerprint)
      return { step, title: "Assign recording speakers", detail: "Choose who is the clinician and who is the patient, then confirm against the recording.", label: "Confirm speaker mapping", action: "map-speakers", target: "speaker-mapping", blocked: !named ? "Enter a reviewer name above." : !options.speakerConfirmed || !options.speakerRolesReady ? "Assign each voice and confirm the roles below." : undefined };
    if (e.turns.some(t => t.speaker === "unknown")) return { step, title: "Assign every speaker", detail: "Correct unassigned roles in the transcript, then save your edits.", target: "consultation-transcript" };
    if (studio && !e.transcriptConfirmation)
      return { step, title: "Confirm the transcript and speakers", detail: "Listen, correct any errors, then confirm the saved source below.", label: "Confirm transcript", action: "confirm-transcript", target: "transcript-checkpoint", blocked: !named ? "Enter a reviewer name above." : !options.transcriptChecked ? "Confirm that you reviewed the transcript and speaker roles." : undefined };
    if (!e.claims.length) return { step, title: "Prepare the clinical note", detail: studio ? "Generate a draft from the confirmed source. Human review follows." : "Load the labelled synthetic reference. No model call.", label: studio ? "Generate note" : "Load saved note", action: "generate-note", body: { provider: studio ? "live" : "saved" }, paid: studio, blocked: studio && !configured ? options.referenceSelected ? "Live models are unavailable. You can use the labelled saved note alternative below." : "Live models are unavailable. Your confirmed source stays saved." : undefined };
    return { step: 1, title: "Your note is ready to review", detail: "Compare each instruction with the consultation.", label: "Continue to note review" };
  }
  if (!e.claims.length) return go(0, "Prepare the clinical note first", "Go to consultation");
  if (step === 1 || !view.noteApproved) {
    if (e.checks.length && !view.noteApproved) return { step: 1, title: "Resolve source checks", detail: "Correct the flagged instruction or source below before approving.", label: "Go to note review", target: "instruction-checks" };
    if (!e.noteReview) return { step: 1, title: "Compare note with transcript", detail: "Review the sources and run a comparison, or document a manual review below.", label: "Compare note with source", action: "run-note-review", paid: studio, blocked: studio ? paidBlock : "Document a manual review below." };
    if (e.noteReview.findings.some(f => !f.dismissal)) return { step: 1, title: "Resolve comparison findings", detail: "Correct the content, or dismiss each flag with a documented reason.", target: "note-comparison" };
    if (!view.noteApproved) return { step: 1, title: "Review and approve the clinical note", detail: "Check each source, then explicitly confirm your review.", label: "Approve reviewed note", action: "approve-note", blocked: approvalBlock };
    return { step: 2, title: "The note is approved", detail: "Continue to the Filipino instruction sheet.", label: "Continue to instructions" };
  }
  if (step === 2 || !view.sheetApproved) {
    if (!e.lines.length) return { step: 2, title: "Prepare the controlled instruction sheet", detail: "Create the Filipino template draft from the approved note. No model call.", label: "Create instruction sheet", action: "generate-sheet" };
    if (e.checks.length) return { step: 2, title: "Resolve sheet checks", detail: "Restore changed wording or correct the approved source before reviewing again.", label: "Go to sheet review", target: "instruction-checks" };
    if (!e.sheetReview) return { step: 2, title: "Compare sheet with approved note", detail: "Check every Filipino line against the approved English source.", label: "Compare sheet with source", action: "run-sheet-review", paid: studio, blocked: studio ? paidBlock : "Document a manual review below." };
    if (e.sheetReview.findings.some(f => !f.dismissal)) return { step: 2, title: "Resolve comparison findings", detail: "Review each flagged difference before approving the sheet.", target: "sheet-comparison" };
    if (!view.sheetApproved) return { step: 2, title: "Review and approve the instruction sheet", detail: "Check medicine details, timing and negation, then confirm your review.", label: "Approve instruction sheet", action: "approve-sheet", blocked: approvalBlock };
    return { step: 3, title: "The instructions are approved", detail: "Ask the actor to explain the plan in their own words.", label: "Continue to teach-back" };
  }
  if (!e.teachBack.length) return { step: 3, title: "Start teach-back", detail: "Review one answer at a time against the approved sheet.", label: "Create teach-back questions", action: "teach-back" };
  if (view.exportReasons?.length === 0) return { step: 3, title: "Approved documents are ready to print", detail: e.printException ? "A named exception permits printing. Some understanding remains unconfirmed." : "Current reviews, approvals and understanding are recorded." };
  if (e.teachBackSkip) return { step: 3, title: "Teach-back was skipped", detail: "Printing requires a named reviewer exception. Open the exception option below.", target: "print-options" };
  if (e.teachBack.some(q => q.outcome === "not-understood" || q.outcome === "reexplained")) return { step: 3, title: "Follow up on unclear answers", detail: "Use the approved wording to explain again, then record another answer. Both attempts remain saved.", target: "teach-questions" };
  return { step: 3, title: "Review the next answer", detail: "Record, transcribe and compare the answer, then choose the human review outcome.", target: "teach-questions" };
}
