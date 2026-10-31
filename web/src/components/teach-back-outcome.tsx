"use client";
import { useEffect, useState } from "react";
import type { Encounter, Respondent, TeachBack } from "@backend/domain/schema";

const categoryLabel = { changed: "Contradicts the sheet", missing: "Not mentioned", unclear: "Unclear" };
export const respondentLabel = (respondent: Respondent | null | undefined, relation?: string) => respondent === "companion" ? `companion${relation ? ` (${relation})` : ""}` : respondent === "patient" ? "patient" : "not recorded";

export default function TeachBackOutcome({ encounter: e, question: q, reviewer, disabled, outcomeDisabled, onAction }: {
  encounter: Encounter; question: TeachBack; reviewer: string; disabled: boolean; outcomeDisabled: boolean;
  onAction: (name: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const attempt = q.attempts?.find(a => a.id === q.activeAttemptId), rule = attempt?.ruleCheck, findings = rule?.findings ?? [];
  const companion = e.companion?.present ? e.companion : null, required = q.requiredRespondent ?? "patient";
  const [overriding, setOverriding] = useState(false), [reason, setReason] = useState("");
  useEffect(() => { setOverriding(false); setReason(""); }, [attempt?.id, rule?.findings.length]);
  const record = (outcome: TeachBack["outcome"], overrideReason?: string) => void onAction("record-teach-back", { outcomes: { [q.id]: outcome }, reviewer, ...(overrideReason ? { overrideReasons: { [q.id]: overrideReason } } : {}) });
  return <div className="teach-outcome">
    <section className="rule-check" aria-label="Rule check">
      <strong>Rule check · no model call</strong>
      {!rule ? <p className="small muted">Runs as soon as this answer has a transcript.</p> : findings.length ? findings.map((f, i) => <div className={`rule-finding ${f.category}`} key={i}>
        <span className="rule-tag">{categoryLabel[f.category]}</span><p>{f.explanation}</p>
        <p className="small">Sheet: <span lang="fil">“{f.expectedQuote}”</span>{f.responseQuote && <> · Heard: <span lang="fil">“{f.responseQuote}”</span></>}</p><small className="source-id">{f.sourceLineIds.join(", ")}</small>
      </div>) : <p className="small">No contradiction found for dose, frequency, days, timing, “huwag” or return timing. The reviewer still decides.</p>}
    </section>
    {companion && <div className="respondent-row">
      <label className="field">Who must say this back?<select value={required} disabled={disabled} onChange={event => void onAction("set-required-respondent", { questionId: q.id, respondent: event.target.value })}><option value="patient">Patient</option><option value="companion">{respondentLabel("companion", companion.relation)}</option></select></label>
      <label className="field">Who gave this answer?<select value={attempt?.respondent ?? ""} disabled={disabled} onChange={event => void onAction("set-respondent", { questionId: q.id, respondent: event.target.value })}>{!attempt?.respondent && <option value="" disabled>Not recorded</option>}<option value="patient">Patient</option><option value="companion">{respondentLabel("companion", companion.relation)}</option></select></label>
    </div>}
    {companion && attempt?.respondent && attempt.respondent !== required && <p className="small amber-text">This answer is from the {respondentLabel(attempt.respondent, companion.relation)}. The {respondentLabel(required, companion.relation)} must say this back before printing.</p>}
    <fieldset disabled={outcomeDisabled}><legend className="sr-only">Outcome for this question</legend>{(["understood", "reexplained", "not-understood"] as const).map(outcome => <label key={outcome} className={`outcome ${q.outcome === outcome ? "chosen" : ""}`}><input type="radio" name={q.id} checked={q.outcome === outcome} onChange={() => { if (outcome === "understood" && findings.length) setOverriding(true); else { setOverriding(false); record(outcome); } }} />{outcome === "understood" ? "Understood" : outcome === "reexplained" ? "Re-explained" : "Not yet understood"}</label>)}</fieldset>
    {overriding && <div className="override-box">
      <label className="field">The rule check flagged this answer. Why is it understood anyway?<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} placeholder="For example: the transcript misheard the answer; the actor said “agad” clearly." disabled={outcomeDisabled} /></label>
      <p className="small">Usually it is better to explain again and record another answer. This reason is saved with the attempt and shown in the comprehension map.</p>
      <div className="button-row"><button type="button" className="button primary" disabled={outcomeDisabled || reason.trim().length < 8} onClick={() => record("understood", reason.trim())}>Mark understood with this reason</button><button type="button" className="text-link" onClick={() => setOverriding(false)}>Cancel</button></div>
    </div>}
    {q.outcome === "understood" && attempt?.overrideReason && <p className="small">Override recorded by {attempt.reviewer}: {attempt.overrideReason}</p>}
  </div>;
}
