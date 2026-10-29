"use client";
import { tokenCostLabel } from "@backend/domain/text-usage";
import { useState } from "react";
import type { AiReview } from "@backend/domain/schema";

export default function AiReviewPanel({ stage, review, studio, configured, disabled, reviewer, onRun, onManual, onDismiss, guided = false }: {
  stage: "note" | "sheet"; review: AiReview | null | undefined; studio: boolean; configured: boolean; disabled: boolean;
  reviewer: string; guided?: boolean;
  onRun: () => void; onManual: (reviewer: string, reason: string) => void; onDismiss: (id: string, reviewer: string, reason: string) => void;
}) {
  const [reason, setReason] = useState(""), [findingReasons, setFindingReasons] = useState<Record<string, string>>({});
  const open = review?.findings.filter(f => !f.dismissal) ?? [];
  return <section id={`${stage}-comparison`} tabIndex={-1} className="ai-review" aria-label={`${stage} discrepancy review`}>
    <div className="review-heading"><h3>Source comparison</h3><span className={`pill ${review && !open.length ? "success" : "neutral"}`}>{!review ? "Review needed" : open.length ? `${open.length} to resolve` : "Analysis recorded"}</span></div>
    <p>{review?.status === "saved" ? "This saved comparison is a demonstration. Compare each instruction with its source before approving." : open.length ? "Correct the content and rerun review, or dismiss each flag with a reason. Human approval follows." : "Compare the instructions with their sources before approving. Automated analysis supports your review."}</p>
    {review ? <div className="source-note">{review.status === "saved" ? "Saved synthetic review · no model call." : review.status === "manual" ? `Manual fallback · ${review.reviewer}: ${review.reason}` : `Live analysis · ${review.findings.length ? `${review.findings.length} possible discrepancies` : "No possible discrepancies flagged"}. Human review still required.`}</div> : <div className="source-note">Run the comparison or document a manual review to enable approval.</div>}
    {review?.status === "live" && <details className="review-metadata"><summary>Model and usage details</summary><p>{review.model} · {review.promptVersion} · {review.latencyMs} ms · {tokenCostLabel(review.costUsd, review.costBasis)}</p></details>}
    {review?.findings.map(f => <div className="ai-finding" key={f.id}>
      <strong>{f.category}: {f.explanation}</strong><p>Source {f.sourceIds.join(", ")}: “{f.sourceQuote}”</p>{f.targetId && <p>Target {f.targetId}: “{f.targetQuote}”</p>}
      {f.dismissal ? <small>Dismissed by {f.dismissal.reviewer}: {f.dismissal.reason}</small> : <details open><summary>Dismiss this flag with a reason</summary><label className="field">Why does this flag not apply? (at least 8 characters)<textarea value={findingReasons[f.id] ?? ""} onChange={event => setFindingReasons({ ...findingReasons, [f.id]: event.target.value })} maxLength={500} disabled={disabled} /></label>{!reviewer.trim() && <p className="small">Enter reviewer initials above the workflow first.</p>}<button className="button secondary" disabled={disabled || !reviewer.trim() || (findingReasons[f.id]?.trim().length ?? 0) < 8} onClick={() => onDismiss(f.id, reviewer, findingReasons[f.id])}>Dismiss as {reviewer.trim() || "reviewer"}</button></details>}
    </div>)}
    <div className="ai-actions">
      {studio && <>{(!guided || review) && <button className="button secondary" disabled={disabled || !configured || open.length > 0} onClick={onRun}>{review ? "Run comparison again" : `Compare ${stage} with source`} · paid call</button>}{!configured && <span className="small muted">Live models are unavailable. Document a manual review below.</span>}</>}
      {(!review || studio) && <details><summary>Document a manual review instead</summary><p className="small">This records a human review and cannot clear unresolved model findings.</p><label className="field">Why was AI review unavailable? (at least 8 characters)<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={disabled} /></label>{!reviewer.trim() && <p className="small">Enter reviewer initials above the workflow first.</p>}<button className="button secondary" disabled={disabled || open.length > 0 || !reviewer.trim() || reason.trim().length < 8} onClick={() => onManual(reviewer, reason)}>Record manual review as {reviewer.trim() || "reviewer"}</button></details>}
    </div>
    {open.length > 0 && <p className="amber-text">{open.length} unresolved finding{open.length === 1 ? "" : "s"} block approval and export.</p>}
  </section>;
}
