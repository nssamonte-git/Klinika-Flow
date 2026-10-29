"use client";
import { tokenCostLabel } from "@backend/domain/text-usage";
import { useState } from "react";
import type { Claim, Encounter } from "@backend/domain/schema";
import { renderEnglish } from "@backend/domain/render";

export default function NoteCorrectionPanel({ encounter: e, enabled, reviewer, disabled, onAction, onStage }: {
  encounter: Encounter; enabled: boolean; reviewer: string; disabled: boolean;
  onAction: (name: string, body: Record<string, unknown>) => void; onStage: (claims: Claim[]) => void;
}) {
  const [confirmed, setConfirmed] = useState(false), [reason, setReason] = useState("");
  if (!enabled) return null;
  const findings = e.noteReview?.status === "live" ? e.noteReview.findings.filter(f => !f.dismissal && e.claims.some(c => c.id === f.targetId)) : [];
  return <section className="source-note" aria-label="Reviewable note corrections"><strong>Optional Spark correction suggestions</strong><p>Each proposal targets one flagged existing claim. It is a paid call and never changes the note until a reviewer accepts it.</p>
    {findings.map(f => <div key={f.id} className="button-row"><span>{f.category} · claim {f.targetId}: {f.explanation}</span><button className="button secondary" disabled={disabled} onClick={() => onAction("propose-note-correction", { findingId: f.id })}>Suggest correction · paid call</button></div>)}
    {e.noteProposals?.map(p => { const current = e.claims.find(c => c.id === p.claimId), stale = !current || JSON.stringify(current) !== JSON.stringify(p.before) || !e.noteReview;
      return <article key={p.id} className="claim"><h4>Claim {p.claimId} · {p.status}{stale && p.status === "pending" ? " · stale" : ""}</h4><p><strong>Cited source:</strong> “{p.sourceQuote}”</p>{p.before.sourceTurnIds.map(id => <p key={id}><small>{id}: {e.turns.find(t => t.id === id)?.text ?? "Source no longer available"}</small></p>)}<p><strong>Before:</strong> {renderEnglish(p.before.fact)}</p><p><strong>Proposed:</strong> {renderEnglish(p.after.fact)}</p><p>{p.explanation}</p><p className="small muted">{p.model} · {p.promptVersion} · {p.latencyMs} ms · {tokenCostLabel(p.costUsd, p.costBasis)}</p>
        {p.status === "pending" && !stale && <><label className="checkbox-line"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={disabled} />I compared this proposal with the cited source.</label><div className="button-row"><button className="button secondary" disabled={disabled} onClick={() => onStage(e.claims.map(c => c.id === p.claimId ? structuredClone(p.after) : c))}>Edit in note before saving</button><button className="button primary" disabled={disabled || !confirmed || !reviewer.trim()} onClick={() => onAction("accept-note-proposal", { proposalId: p.id, reviewer, confirmed: true })}>Accept and recheck note</button></div><label className="field">Reason to reject<textarea value={reason} onChange={event => setReason(event.target.value)} minLength={8} maxLength={500} /></label><button className="button secondary" disabled={disabled || !confirmed || !reviewer.trim() || reason.trim().length < 8} onClick={() => onAction("reject-note-proposal", { proposalId: p.id, reviewer, confirmed: true, reason })}>Reject proposal</button></>}
      </article>; })}
  </section>;
}
