"use client";
import { useEffect, useRef, useState } from "react";
import type { Encounter } from "@backend/domain/schema";
import { TOOL_LABELS, type AgentCommand, type AgentMode, type AgentView, type ReviewerHandoff } from "@backend/domain/agent-contract";

const displayTime = (value: string) => `${new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(new Date(value))} PHT`;

export function HandoffCard({ handoff: h }: { handoff: ReviewerHandoff }) {
  return <section className="agent-handoff" aria-label="Reviewer handoff"><h4>Reviewer handoff · version {h.version}</h4>
    <p>Read-only saved evidence. No model call. Current note: {h.noteApproved ? "approved" : "review needed"}; sheet: {h.sheetApproved ? "approved" : "review needed"}.</p>
    {h.reviews.map(r => <p className="small" key={r.stage}>{r.stage}: {r.current ? "current" : "pending or superseded"} · {r.status}{r.reviewer ? ` · recorded reviewer ${r.reviewer}` : " · reviewer not recorded"}{r.at ? ` · ${displayTime(r.at)}` : ""}</p>)}
    {h.instructions.length > 0 && <details><summary>Instruction lines · {h.sheetApproved ? "current approved wording" : "draft; approval pending"}</summary><ul>{h.instructions.map(l => <li key={l.id}><span className="source-id">{l.id}</span> <span lang="fil">{l.text}</span> <small>Source: {l.sourceIds.join(", ")}</small></li>)}</ul></details>}
    <details><summary>Unresolved checks and findings · {h.unresolved.length}</summary>{h.unresolved.length ? <ul>{h.unresolved.map((f, i) => <li key={`${f.id}-${i}`}>{f.stage} · {f.id}: {f.text}</li>)}</ul> : <p>No recorded finding; this is not clinical validation.</p>}</details>
    <details><summary>Current and historical answer decisions</summary>{h.answers.length ? h.answers.map((q, i) => <article key={`${q.id}-${i}`}><strong>{q.question}</strong><p>{q.current ? "Current sheet" : "Superseded sheet"} · {q.outcome}</p><ul>{q.attempts.map(a => <li key={a.id}>{a.current ? "Current attempt" : "Historical attempt"} · {a.outcome} · comparison: {a.analysis} · {a.reviewer ?? "no reviewer decision"}{a.at ? ` · ${displayTime(a.at)}` : ""}</li>)}</ul></article>) : <p>No answers recorded.</p>}</details>
    {h.comprehension.length > 0 && <details><summary>Say-back status by instruction line</summary><ul>{h.comprehension.map(r => <li key={r.lineId}><span className="source-id">{r.lineId}</span> {r.label}{r.required ? ` · must be said back by the ${r.required}` : ""}{r.respondent ? ` · current answer from the ${r.respondent}` : ""}</li>)}</ul></details>}
    {h.exception && <p className="small amber-text">{h.exception.current ? "Current" : "Superseded"} print exception by {h.exception.reviewer}: {h.exception.reason}. An exception does not confirm understanding.</p>}
    <strong>Required next checkpoints</strong>{h.nextCheckpoints.length ? <ul>{h.nextCheckpoints.map(x => <li key={x}>{x}</li>)}</ul> : <p>Current export checks are satisfied. This card does not authorize printing.</p>}
  </section>;
}

export default function AgentPanel({ encounter: e, disabled, onBusyChange, onRefresh }: { encounter: Encounter; disabled: boolean; onBusyChange: (busy: boolean) => void; onRefresh: () => Promise<void> }) {
  const [data, setData] = useState<AgentView | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [mode, setMode] = useState<AgentMode>(e.teachBack.length ? "teach_back" : "source_review"), [question, setQuestion] = useState(e.teachBack.some(q => q.id === "warning") ? "warning" : e.teachBack[0]?.id ?? "warning");
  const inFlight = useRef(false), uncertain = useRef<{ signature: string; key: string } | null>(null);
  const base = `/api/encounters/${e.id}/agent`;
  async function refresh() { const r = await fetch(base); const body = await r.json(); if (!r.ok) throw new Error(body.error ?? "Agent evidence unavailable."); setData(body); }
  useEffect(() => { let active = true; fetch(base).then(async r => { const body = await r.json(); if (!r.ok) throw new Error(body.error ?? "Agent evidence unavailable."); if (active) { setData(body); setError(""); } }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, [base, e.version]);
  async function send(body: Omit<AgentCommand, "expectedVersion">) {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError("");
    const input = { ...body, expectedVersion: e.version }, signature = JSON.stringify(input);
    const key = uncertain.current?.signature === signature ? uncertain.current.key : crypto.randomUUID(); uncertain.current = { signature, key };
    try {
      const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: signature });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Agent step failed. Inspect the saved timeline.");
      uncertain.current = null; setData(result); await onRefresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Agent step failed."); await refresh().catch(() => undefined); await onRefresh().catch(() => undefined); }
    finally { inFlight.current = false; setBusy(false); onBusyChange(false); }
  }
  const run = data?.runs.find(r => ["ready", "awaiting_tool", "executing", "paused"].includes(r.status)) ?? data?.runs[0];
  const active = !!run && ["ready", "awaiting_tool", "executing", "paused"].includes(run.status);
  const pending = run?.events.find(v => v.id === run.pendingStepId);
  const toolPaid = pending?.plan && ["compare_answer", "compare_note", "propose_correction"].includes(pending.plan.tool) && !data?.capabilities.fixture;
  const blocked = disabled || busy;
  const selectedAnswer = e.teachBack.find(q => q.id === question);
  const canStart = e.consent && (mode === "source_review" ? e.claims.length > 0 : !!data?.handoff.sheetApproved && !!selectedAnswer && !!(selectedAnswer.transcript || selectedAnswer.analysis?.transcript || selectedAnswer.attempts?.some(a => a.rawTranscript || a.correctedTranscript)));
  return <details className="optional-tools agent-panel"><summary>Agent review and reviewer handoff · optional</summary>
    <p>{data?.capabilities.fixture ? "Saved synthetic agent walkthrough. All decisions/results are fixtures; zero model calls." : "Meta-assisted tool selection. Every paid call requires a separate button press. The agent cannot approve content or decide understanding."}</p>
    {error && <p className="inline-warning" role="alert">{error}</p>}
    {!data ? <p>Loading saved evidence…</p> : <>
      {!data.capabilities.enabled && <p>Live agents are disabled. The traditional workflow and read-only handoff remain available.</p>}
      <fieldset disabled={blocked || active || !data.capabilities.enabled}><legend>Start a bounded review</legend>
        <label className="field">Review mode<select value={mode} onChange={v => setMode(v.target.value as AgentMode)}><option value="teach_back">Teach-back review</option><option value="source_review">Note source review</option></select></label>
        {mode === "teach_back" && <label className="field">Answer<select value={question} onChange={v => setQuestion(v.target.value)}>{e.teachBack.length ? e.teachBack.map(q => <option key={q.id} value={q.id}>{q.question}</option>) : <option value="warning">Create teach-back questions first</option>}</select></label>}
        <button type="button" className="button secondary" disabled={!canStart} onClick={() => void send({ command: "start", mode, ...(mode === "teach_back" ? { questionId: question } : {}) })}>Start review · no model call</button>
      </fieldset>
      {!canStart && <p className="small">{mode === "source_review" ? "Confirm permission and prepare the note first." : "Approve the current sheet and save the selected answer transcript first."}</p>}
      {run && <section aria-label="Current agent run"><h4>{run.mode === "teach_back" ? "Teach-back" : "Source"} review · {run.status}</h4><p className="small">{run.fixture ? "Saved fixture" : "Live agent"} · {run.decisions}/6 planner decisions · {run.executions}/6 tools · {run.paidAttempts}/12 paid attempts{run.parentId ? " · linked to an earlier run" : ""}</p>
        {run.status === "ready" && <button type="button" className="button secondary" disabled={blocked || !data.capabilities.enabled || run.decisions >= 6} onClick={() => void send({ command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: !data.capabilities.fixture })}>{data.capabilities.fixture ? "Load next saved decision · no model call" : "Ask agent for next action · paid call"}</button>}
        {run.status === "awaiting_tool" && pending?.plan && <div className="source-note"><strong>Selected: {TOOL_LABELS[pending.plan.tool]}</strong><p>Reason: {pending.plan.reason.replaceAll("_", " ")} · target: {pending.plan.targetId || "current note"} · source IDs: {pending.plan.sourceIds.join(", ") || "none requested"}</p><button type="button" className="button secondary" disabled={blocked || !data.capabilities.enabled || run.executions >= 6} onClick={() => void send({ command: "execute", runId: run.id, expectedRevision: run.revision, stepId: pending.id, confirmedPaid: Boolean(toolPaid) })}>{toolPaid ? "Execute selected tool · paid call" : "Execute selected tool · no model call"}</button>
          {data.capabilities.fixture && <button type="button" className="text-link" disabled={blocked} onClick={() => void send({ command: "execute", runId: run.id, expectedRevision: run.revision, stepId: pending.id, fixtureFailure: true })}>Simulate tool failure · fixture only</button>}
        </div>}
        {run.status === "paused" && <p>Use the normal review/outcome controls for the actual human decision, then resume. A repeated answer needs a new linked review.</p>}
        {["paused", "executing"].includes(run.status) && <button type="button" className="button secondary" disabled={blocked} onClick={() => void send({ command: "resume", runId: run.id, expectedRevision: run.revision })}>{run.status === "executing" ? "Recover interrupted step after 90 seconds" : "Observe saved human decision · resume"}</button>}
        {active && <button type="button" className="text-link" disabled={blocked} onClick={() => void send({ command: "stop", runId: run.id, expectedRevision: run.revision })}>Stop this run</button>}
      </section>}
      {data.capabilities.fixture && <details><summary>Labelled Saved Demo exercises · invalidate affected decisions</summary><p>These exercises change only the synthetic fixture. They are not actor audio or model results.</p><button type="button" className="text-link" disabled={blocked || !e.claims.length} onClick={() => void send({ command: "fixture", scenario: "unsupported_claim" })}>Plant unsupported medication claim · fixture</button><button type="button" className="text-link" disabled={blocked || !e.teachBack.length} onClick={() => void send({ command: "fixture", scenario: "unclear_answer", questionId: question })}>Add unclear answer attempt · fixture</button></details>}
      <details><summary>Agent activity timeline · {data.runs.length} runs</summary>{data.runs.map(r => <article key={r.id}><h4>{r.mode} · {r.status}{r.superseded ? " · superseded evidence" : ""}</h4><p className="small">{displayTime(r.createdAt)} · {r.fixture ? "Saved synthetic fixture; no inference" : "Live run"}</p><ol>{r.events.map(event => <li key={event.id}><strong>{event.kind}{event.plan ? ` · ${TOOL_LABELS[event.plan.tool]}` : ""} · {event.status}</strong><p className="small">{displayTime(event.at)}{event.latencyMs !== undefined ? ` · ${event.latencyMs} ms${event.fixture ? " local fixture processing" : " step elapsed"}` : ""}</p>{event.notice && <p>{event.notice}</p>}{event.evidence?.map((item, i) => <blockquote key={`${item.id}-${i}`}><small>{item.label} · {item.id}</small><p>{item.text}</p></blockquote>)}{event.measurements?.map(m => <p className="small" key={m.reservationId}>Attempt {m.status} · reserved estimate ${m.estimatedUsd.toFixed(5)} · {m.calculatedUsd === null ? "charge unknown" : `calculated $${m.calculatedUsd.toFixed(5)}`} · {m.basis}{m.undiscountedEstimateUsd !== null ? ` · undiscounted estimate $${m.undiscountedEstimateUsd.toFixed(5)} (cache unknown; overlaps reserved estimate)` : ""}{m.latencyMs !== null ? ` · ${m.latencyMs} ms` : ""}</p>)}</li>)}</ol></article>)}</details>
      <HandoffCard handoff={data.handoff} />
    </>}
    {busy && <p role="status">Processing one explicitly requested step. No automatic next call.</p>}
  </details>;
}
