"use client";
import { comprehensionLabels, comprehensionMap, comprehensionSummary, type ComprehensionAttempt } from "@backend/domain/comprehension";
import type { Encounter } from "@backend/domain/schema";
import { respondentLabel } from "./teach-back-outcome";

const chipState = (a: ComprehensionAttempt) => a.outcome === "understood" ? "ok" : a.outcome === "reexplained" || a.outcome === "not-understood" ? "follow" : a.findings.some(f => f.category === "changed") ? "bad" : "neutral";
export default function ComprehensionMap({ encounter: e }: { encounter: Encounter }) {
  if (!e.teachBack.length) return null;
  const rows = comprehensionMap(e), summary = comprehensionSummary(rows), relation = e.companion?.present ? e.companion.relation : undefined;
  return <section className="comprehension-map" id="comprehension-map" tabIndex={-1} aria-label="Comprehension map">
    <div className="map-head"><h3>Comprehension map</h3><p className="small">Every approved line, who must say it back and what each attempt showed. Clinician record only; the reviewer decides every outcome.</p>
      <p className="map-summary">{(Object.keys(comprehensionLabels) as (keyof typeof comprehensionLabels)[]).filter(status => summary[status]).map(status => <span key={status} className={`map-status ${status}`}>{summary[status]} · {comprehensionLabels[status]}</span>)}</p></div>
    <ol className="map-rows">{rows.map(r => <li key={r.lineId} className={`map-row ${r.status}`}>
      <div className="map-line"><span className="source-id">{r.lineId}</span><span lang="fil">{r.text}</span></div>
      <div className="map-meta"><span className={`map-status ${r.status}`}>{comprehensionLabels[r.status]}</span>
        {r.required && relation && <small>Said back by the {respondentLabel(r.required, relation)}</small>}
        {r.attempts.length > 0 && <span className="attempt-chips" aria-label="Attempts">{r.attempts.map(a => <span key={a.attemptId} className={`attempt-chip ${chipState(a)}`} title={`${a.transcript ?? "No transcript"}${a.findings.length ? ` — ${a.findings.map(f => f.explanation).join(" ")}` : ""}`}>#{a.number}{relation ? ` · ${a.respondent === "companion" ? relation : a.respondent ?? "?"}` : ""}</span>)}</span>}
      </div>
      {r.attempts.filter(a => a.findings.length).slice(-1).map(a => <p key={a.attemptId} className="small map-quote">Attempt {a.number}: {a.findings[0].responseQuote ? <>heard <span lang="fil">“{a.findings[0].responseQuote}”</span> · </> : null}{a.findings[0].explanation}</p>)}
    </li>)}</ol>
  </section>;
}
