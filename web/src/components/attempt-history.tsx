"use client";
import type { SheetLine, TeachBack } from "@backend/domain/schema";

export default function AttemptHistory({ question, encounterId, lines, current, disabled, onRepeat }: {
  question: TeachBack; encounterId: string; lines: SheetLine[]; current: boolean; disabled: boolean; onRepeat?: () => void;
}) {
  const relevantIds = new Set(question.analysis?.findings.flatMap(f => f.sourceLineIds) ?? []);
  const approved = lines.filter(line => relevantIds.has(line.id));
  return <div className="attempt-history">
    {current && (question.outcome === "reexplained" || question.outcome === "not-understood") && <section className="source-note">
      <strong>Explain again using the approved instructions</strong>
      <p>Review these exact source lines with the actor. The comparison flags where another explanation is needed; it does not write new advice.</p>
      <ul>{(approved.length ? approved : lines.filter(line => question.expected.includes(line.text))).map(line => <li key={line.id}><span className="source-id">{line.id}</span> <span lang="fil">{line.text}</span></li>)}</ul>
      <button type="button" className="button secondary" disabled={disabled} onClick={onRepeat}>Explained again · record another answer</button>
    </section>}
    <details><summary>{current ? "Answer attempt history" : "Historical answers from an earlier sheet"} · {question.attempts?.length ?? 1}</summary>
      {!current && <p className="small amber-text">Superseded by changed instructions. These answers cannot authorize the current printout.</p>}
      <ol>{question.attempts?.map((attempt, index) => <li key={attempt.id}>
        <strong>Attempt {index + 1}</strong> · {attempt.outcome === "reexplained" ? "Re-explained; understanding unconfirmed" : attempt.outcome === "not-understood" ? "Not yet understood" : attempt.outcome === "understood" ? "Understood" : "Pending"}
        {attempt.reviewer && <span> · {attempt.reviewer}</span>}{attempt.decidedAt && <time dateTime={attempt.decidedAt}> · {new Date(attempt.decidedAt).toLocaleString()}</time>}
        {attempt.audioAvailable && <audio controls preload="none" src={`/api/encounters/${encounterId}/teach-back/${question.id}/attempts/${attempt.id}/audio`} />}
        {attempt.rawTranscript && <p><strong>Raw transcript:</strong> {attempt.rawTranscript}</p>}
        {attempt.correctedTranscript && <p><strong>Reviewer correction:</strong> {attempt.correctedTranscript}</p>}
        {attempt.analysis && <p>Comparison: {attempt.analysis.findings.length ? `${attempt.analysis.findings.length} finding(s)` : "No finding in this comparison"} · {attempt.analysis.status === "saved" ? "labelled synthetic fixture" : attempt.analysis.status}</p>}
      </li>)}</ol>
    </details>
  </div>;
}
