"use client";
import type { Encounter } from "@backend/domain/schema";
import { workflowGuidance, type Guidance, type WorkflowView } from "../lib/workflow-guidance";

export default function GuidedPreparation({ encounter, view, studio, configured, disabled, unsaved, onAction, onTranscribe, onGo, guidance, currentStep }: {
  encounter: Encounter; view: WorkflowView; studio: boolean; configured: boolean; disabled: boolean; unsaved: boolean;
  onAction: (name: string, body?: Record<string, unknown>) => void; onTranscribe: () => void; onGo: (step: number, target?: string) => void;
  guidance?: Guidance; currentStep?: number;
}) {
  const next = guidance ?? workflowGuidance(encounter, view, { studio, configured });
  const elsewhere = currentStep !== undefined && currentStep !== next.step;
  // Fields and recording controls are the action when the current checkpoint needs input.
  const destinationLabel = `Go to ${next.step === 0 ? "consultation" : next.step === 1 ? "note review" : next.step === 2 ? "sheet review" : "teach-back"}`;
  const showButton = (currentStep === undefined && Boolean(next.label)) || elsewhere || Boolean(next.action) || Boolean(next.label && !next.target);
  return <section className="next-step-guide" aria-label="Guided preparation">
    <div><span className="eyebrow">{next.action || next.target || elsewhere ? "NEXT STEP" : "CURRENT STATUS"}</span><h2>{next.title}</h2><p>{next.detail}</p>{next.paid && <p className="small paid-label">Paid model call · starts only when selected</p>}{next.blocked && !elsewhere && <p className="guidance-blocker">{next.blocked}</p>}</div>
    {showButton ? <button className="button primary" disabled={disabled || (!elsewhere && Boolean(next.blocked)) || (unsaved && !["transcript", "edit-note"].includes(next.action ?? ""))} onClick={() => {
      if (elsewhere || !next.action) onGo(next.step, next.target);
      else if (next.action === "transcribe") onTranscribe();
      else onAction(next.action, next.body);
    }}>{elsewhere && next.action ? destinationLabel : next.label ?? destinationLabel}{next.paid && !elsewhere ? " · paid call" : ""}</button> : null}
  </section>;
}
