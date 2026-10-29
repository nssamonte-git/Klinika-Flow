"use client";
import { tokenCostLabel } from "@backend/domain/text-usage";
import { useState } from "react";
import type { Encounter } from "@backend/domain/schema";
import SpokenQuestionPanel from "./spoken-question-panel";

export default function PlanQuestionPanel({ encounter: e, enabled, spokenEnabled, configured, approved, disabled, studio, reviewer, onAsk, onUpload, onAction, onError, onRecordingChange }: {
  encounter: Encounter; enabled: boolean; spokenEnabled: boolean; configured: boolean; approved: boolean; disabled: boolean; studio: boolean; reviewer: string;
  onAsk: (question: string) => void; onUpload: (audio: Blob) => Promise<void>; onAction: (name: string, body: Record<string, unknown>) => void; onError: (message: string) => void; onRecordingChange?: (recording: boolean) => void;
}) {
  const [question, setQuestion] = useState("");
  if (!enabled) return null;
  return <section className="source-note" aria-label="Questions about approved plan"><strong>Questions about the approved plan</strong><p>Ask about these instructions. Spark selects approved line IDs; the exact saved wording appears below. Missing or unclear details go to the reviewer.</p>
    {approved && <form onSubmit={event => { event.preventDefault(); onAsk(question); }}><label className="field">Actor question<textarea value={question} onChange={event => setQuestion(event.target.value)} minLength={4} maxLength={500} required placeholder="What would you like to clarify?" /></label><button className="button secondary" disabled={disabled || question.trim().length < 4}>Check approved lines{studio ? " · paid call" : " · labelled fixture"}</button></form>}
    {approved && studio && spokenEnabled && <SpokenQuestionPanel encounterId={e.id} draft={e.spokenQuestionDrafts?.find(d => d.id === e.activeSpokenQuestionId)} reviewer={reviewer} disabled={disabled} configured={configured} onRecordingChange={onRecordingChange} onUpload={onUpload} onAction={onAction} onError={onError} />}
    {e.planQuestions?.length ? <details open><summary>Question history · {e.planQuestions.length}</summary><ol>{e.planQuestions.map(item => { const current = approved && item.sheetFingerprint === e.sheetApproval?.fingerprint;
      return <li key={item.id}><strong>{item.question}</strong> <span className="pill neutral">{current ? "Current approved sheet" : "Historical · earlier sheet"}</span>{item.audioAvailable && <audio controls preload="none" src={`/api/encounters/${e.id}/plan-questions/${item.id}/audio`} />}{item.rawTranscript && item.rawTranscript !== item.question && <p>Raw transcript: {item.rawTranscript}</p>}<p>{item.needsReviewer ? "Reviewer help needed. The approved sheet does not establish this detail." : "Relevant approved wording:"}</p>{!item.needsReviewer && <ul>{item.answerLines.map(line => <li key={line.id}><span className="source-id">{line.id}</span> <span lang="fil">{line.text}</span></li>)}</ul>}<p className="small muted">{item.model === "none" ? "Labelled synthetic fixture · no model call" : `${item.model} · ${item.promptVersion} · ${item.latencyMs} ms · ${tokenCostLabel(item.costUsd, item.costBasis)}`} · {new Date(item.askedAt).toLocaleString()}</p></li>; })}</ol></details> : null}
  </section>;
}
