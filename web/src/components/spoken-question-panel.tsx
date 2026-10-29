"use client";
import { useEffect, useState } from "react";
import type { SpokenQuestionDraft } from "@backend/domain/schema";
import Recorder from "./recorder";

export default function SpokenQuestionPanel({ encounterId, draft, reviewer, disabled, configured, onUpload, onAction, onError, onRecordingChange }: {
  encounterId: string; draft?: SpokenQuestionDraft; reviewer: string; disabled: boolean; configured: boolean;
  onUpload: (audio: Blob) => Promise<void>; onAction: (name: string, body: Record<string, unknown>) => void; onError: (message: string) => void; onRecordingChange?: (recording: boolean) => void;
}) {
  const [text, setText] = useState(""), [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setText(draft?.correctedTranscript ?? draft?.rawTranscript ?? ""); setConfirmed(false); }, [draft?.id, draft?.rawTranscript, draft?.correctedTranscript]);
  const saved = draft?.correctedTranscript ?? draft?.rawTranscript ?? "";
  return <details className="source-note"><summary>Ask a spoken question</summary><p>Record a short synthetic actor question. Confirm its transcription before Spark checks the approved sheet. Question audio stays separate from teach-back answers.</p>
    <Recorder onRecordingChange={onRecordingChange} disabled={disabled} onUpload={onUpload} onError={onError} prompt="Record a short synthetic actor question. Do not record a real patient." maxSeconds={120} maxBytes={6_000_000} />
    {draft && <div><p>Latest question recording · {draft.answered ? "answered" : "awaiting review"}</p><audio controls preload="none" src={`/api/encounters/${encounterId}/plan-questions/${draft.id}/audio`} />
      {!draft.answered && <>{!draft.rawTranscript && <button className="button secondary" disabled={disabled || !configured} onClick={() => onAction("transcribe-spoken-question", { questionId: draft.id })}>Transcribe question · paid call</button>}
        {draft.rawTranscript && <><p><strong>Raw Voice transcript:</strong> {draft.rawTranscript}</p><label className="field">Correct the question transcript<textarea value={text} onChange={event => setText(event.target.value)} maxLength={500} /></label>{text.trim() !== saved && <button className="button secondary" disabled={disabled || text.trim().length < 4} onClick={() => onAction("edit-spoken-question-transcript", { questionId: draft.id, transcript: text.trim() })}>Save corrected transcript</button>}
          {text.trim() === saved && !draft.confirmedFingerprint && <><label className="checkbox-line"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />I checked this question transcript against the actor audio.</label><button className="button secondary" disabled={disabled || !confirmed || !reviewer.trim()} onClick={() => onAction("confirm-spoken-question", { questionId: draft.id, reviewer, confirmed: true })}>Confirm question transcript</button></>}
          {draft.confirmedFingerprint && <div><p>Confirmed by {draft.confirmedBy}.</p><button className="button secondary" disabled={disabled || !configured} onClick={() => onAction("ask-spoken-plan-question", { questionId: draft.id })}>Check approved lines · paid call</button></div>}</>}
      </>}
    </div>}
  </details>;
}
