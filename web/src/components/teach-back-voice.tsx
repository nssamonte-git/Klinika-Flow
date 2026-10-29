"use client";
import { tokenCostLabel } from "@backend/domain/text-usage";
import { useEffect, useRef, useState } from "react";
import type { TeachBack } from "@backend/domain/schema";
import Recorder from "./recorder";

export default function TeachBackVoice({ question, encounterId, studio, configured, disabled, reviewer, onUpload, onAction, onError, onRecordingChange, onDirtyChange }: {
  question: TeachBack; encounterId: string; studio: boolean; configured: boolean; disabled: boolean; reviewer: string;
  onUpload: (blob: Blob) => Promise<void>; onAction: (name: string, body: Record<string, unknown>) => Promise<void>;
  onError: (message: string) => void; onRecordingChange?: (recording: boolean) => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [transcript, setTranscript] = useState(question.transcript ?? ""), [reason, setReason] = useState("");
  useEffect(() => setTranscript(question.transcript ?? ""), [question.transcript, question.sheetFingerprint, question.activeAttemptId]);
  const dirty = transcript !== (question.transcript ?? "");
  const dirtyChange = useRef(onDirtyChange); dirtyChange.current = onDirtyChange;
  useEffect(() => { dirtyChange.current?.(dirty); }, [dirty]);
  useEffect(() => () => dirtyChange.current?.(false), []);
  const recorder = <Recorder primary={!question.audioAvailable && question.transcript === undefined && !question.analysis} disabled={disabled || dirty} maxSeconds={120} maxBytes={6_000_000} prompt="Record only this actor’s answer." label="Record answer" onUpload={onUpload} onError={onError} onRecordingChange={onRecordingChange} />;
  return <div className="voice-teach-back">
    {studio && <>
      <p className="answer-guide">{!question.audioAvailable ? "1. Record the answer" : question.transcript === undefined ? "2. Transcribe the answer" : !question.analysis ? "3. Review and compare the answer" : "4. Choose the review outcome below"}</p>
      {question.audioAvailable ? <details><summary>Replace this answer recording</summary><p>A replacement clears this answer’s transcript, analysis and outcome.</p>{recorder}</details> : recorder}
      {question.audioAvailable && <audio controls src={`/api/encounters/${encounterId}/teach-back/${question.id}/audio`} aria-label="Synthetic teach-back answer" />}
      {question.audioAvailable && question.transcript === undefined && <button className="button primary" disabled={disabled || !configured} onClick={() => void onAction("transcribe-teach-back", { questionId: question.id })}>Transcribe answer · paid call</button>}
      {question.transcript !== undefined && <>
        <label className="field">Check the answer transcript<textarea value={transcript} onChange={event => setTranscript(event.target.value)} maxLength={3000} disabled={disabled} /></label>
        {dirty ? <><p className="small amber-text">Save this correction before comparing or recording an outcome.</p><button className="button primary" disabled={disabled || !transcript.trim()} onClick={() => void onAction("edit-teach-back-transcript", { questionId: question.id, transcript })}>Save transcript correction</button></> : !question.analysis ? <button className="button primary" disabled={disabled || !configured || !transcript.trim()} onClick={() => void onAction("analyze-teach-back", { questionId: question.id })}>Compare with instructions · paid call</button> : <details><summary>Run another comparison</summary><button className="button secondary" disabled={disabled || !configured} onClick={() => void onAction("analyze-teach-back", { questionId: question.id })}>Compare again · paid call</button></details>}
        <details><summary>Transcript and model details</summary><p>{question.transcriptSource === "human-corrected" ? "Human-corrected transcript" : "Automated transcript"}{question.transcription && ` · ${question.transcription.model} · ${question.transcription.latencyMs} ms · estimated $${question.transcription.costUsd.toFixed(5)}`}</p><button className="button secondary" disabled={disabled || !configured || dirty} onClick={() => void onAction("transcribe-teach-back", { questionId: question.id })}>Transcribe again · paid call</button></details>
      </>}
      {!configured && <p className="small amber-text">Live models are unavailable. You can document a manual analysis below.</p>}
      <details><summary>Document a manual analysis instead</summary><label className="field">Why is manual analysis needed?<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={disabled} /></label><button className="button secondary" disabled={disabled || dirty || !reviewer.trim() || reason.trim().length < 8 || (question.analysis?.status === "live" && question.analysis.findings.length > 0)} onClick={() => void onAction("manual-teach-back", { questionId: question.id, reviewer, reason })}>Record manual analysis</button></details>
    </>}
    {question.analysis ? <div className="source-note">
      <strong>{question.analysis.status === "saved" ? "Saved example answer · simulated comparison" : question.analysis.status === "manual" ? "Manual analysis" : "Answer comparison"}</strong>
      {question.analysis.transcript && <p>Response: “{question.analysis.transcript}”</p>}
      {question.analysis.findings.length ? question.analysis.findings.map((f, i) => <div className="answer-finding" key={i}><strong className="amber-text">{f.explanation}</strong><p>Expected: “{f.expectedQuote}”</p>{f.responseQuote && <p>Heard: “{f.responseQuote}”</p>}<small>Source: {f.sourceLineIds.join(", ")}</small></div>) : <p>No possible misunderstanding flagged. Choose the human review outcome below.</p>}
      <details><summary>Analysis details</summary><p>{question.analysis.status === "saved" ? "Labelled synthetic fixture · no recording or model call" : question.analysis.status === "manual" ? `${question.analysis.reviewer}: ${question.analysis.reason}` : `${question.analysis.model} · ${question.analysis.latencyMs} ms · ${tokenCostLabel(question.analysis.costUsd, question.analysis.costBasis)}`}</p></details>
    </div> : <p className="small muted">Complete the answer analysis before recording an outcome.</p>}
  </div>;
}
