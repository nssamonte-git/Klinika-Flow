"use client";
import { useState } from "react";
import type { Encounter } from "@backend/domain/schema";

export default function PrintExceptionPanel({ encounter, reviewer, disabled, policySatisfied, onAction }: {
  encounter: Encounter; reviewer: string; disabled: boolean; policySatisfied: boolean; onAction: (name: string, body?: Record<string, unknown>) => void;
}) {
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false);
  const x = encounter.printException;
  return <section className="source-note" aria-label="Print exception">
    <strong>Understanding and print policy</strong>
    <p>Every current answer needs reviewer-confirmed understanding. If a question remains pending, was re-explained, is not understood, or was skipped, a named reviewer can record an exception. The reason appears on the printout.</p>
    {x && policySatisfied ? <div><p><strong>Current exception:</strong> {x.reviewer} · {x.reason} · {new Date(x.at).toLocaleString()}</p><p>Unresolved: {x.unresolvedQuestionIds.join(", ")}</p><button className="button secondary" disabled={disabled} onClick={() => onAction("revoke-print-exception")}>Revoke exception</button></div> : <>
      {x && <p className="amber-text">The earlier exception is stale. Review current answers and record a new one if needed.</p>}
      <form onSubmit={event => { event.preventDefault(); onAction("record-print-exception", { reviewer, reason, confirmed }); }}>
        <label className="field">Reason for unresolved understanding<textarea value={reason} onChange={event => setReason(event.target.value)} minLength={8} maxLength={500} required placeholder="Describe why printing is needed before understanding is confirmed" /></label>
        <label className="checkbox-line"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={disabled} />I reviewed every unresolved question and accept that understanding is unconfirmed.</label>
        <button className="button secondary" disabled={disabled || !confirmed || !reviewer.trim() || reason.trim().length < 8}>Record named print exception</button>
      </form>
    </>}
  </section>;
}
