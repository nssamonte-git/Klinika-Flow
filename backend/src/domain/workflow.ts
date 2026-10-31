import { illustrationMatches } from "./illustrations";
import { createHash, randomUUID } from "node:crypto";
import type { Encounter, Check, Claim, Fact, Respondent, SheetLine, TeachBack, TeachBackAttempt, AiReview } from "./schema";
import { compareAnswer, factKindsFor, numeralize, RULE_CHECK_VERSION } from "./taglish";
import { respondentMatches } from "./comprehension";
export { respondentMatches };
import { getCase } from "./cases";
import { renderEnglish, renderFilipino, templateSheet } from "./render";

export class WorkflowError extends Error { constructor(message: string, public status = 409) { super(message); } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const noteFingerprint = (e: Encounter) => fingerprint({ turns: e.turns, claims: e.claims });
export const transcriptFingerprint = (e: Encounter) => fingerprint({ turns: e.turns, recording: e.recordingFingerprint ?? null });
export const sheetFingerprint = (e: Encounter) => fingerprint({ note: noteFingerprint(e), lines: e.lines, ...(e.illustrations?.length ? { illustrations: e.illustrations } : {}) });
export const checkFingerprint = (e: Encounter) => fingerprint({ note: noteFingerprint(e), lines: e.lines, ...(e.illustrations?.length ? { illustrations: e.illustrations } : {}), mode: e.sheetMode });
export const reviewFingerprint = (e: Encounter, stage: "note" | "sheet") => stage === "note" ? noteFingerprint(e) : sheetFingerprint(e);
export function unresolvedTeachBack(e: Encounter): string[] {
  const current = sheetFingerprint(e);
  if (!e.teachBack.length) return ["teach-back"];
  return e.teachBack.filter(q => {
    const normalized = normalizeAttempts(q), active = normalized.attempts?.find(a => a.id === normalized.activeAttemptId);
    return !!e.teachBackSkip.trim() || q.sheetFingerprint !== current || !active || active.sheetFingerprint !== current || active.outcome !== "understood" || !active.reviewer || !active.analysis || active.analysis.sheetFingerprint !== current ||
      (!!active.ruleCheck?.findings.length && !active.overrideReason) || !respondentMatches(e, q, active);
  }).map(q => q.id).sort();
}
export function teachBackStateFingerprint(e: Encounter): string {
  return fingerprint({ sheet: sheetFingerprint(e), skip: e.teachBackSkip, ...(e.companion ? { companion: e.companion } : {}),
    questions: e.teachBack.map(q => { const normalized = normalizeAttempts(q), active = normalized.attempts?.find(a => a.id === normalized.activeAttemptId);
      return { id: q.id, sheet: q.sheetFingerprint, active, ...(q.requiredRespondent ? { required: q.requiredRespondent } : {}) }; }) });
}
export const questionLines = (e: Encounter, questionId: string) => e.lines.filter(l => (factKindsFor[questionId] ?? []).includes(l.fact.kind));
/** Runs the free deterministic Taglish check on the attempt's current transcript. */
export function applyRuleCheck(e: Encounter, q: TeachBack, attempt: TeachBackAttempt): TeachBackAttempt {
  const transcript = attempt.correctedTranscript ?? attempt.rawTranscript;
  attempt.ruleCheck = transcript?.trim() ? { parserVersion: RULE_CHECK_VERSION, findings: compareAnswer(questionLines(e, q.id), transcript), sheetFingerprint: q.sheetFingerprint } : null;
  attempt.overrideReason = null;
  return attempt;
}
export function currentPrintException(e: Encounter): boolean {
  const x = e.printException, unresolved = unresolvedTeachBack(e);
  return !!x && !!unresolved.length && !!x.reviewer.trim() && x.reason.trim().length >= 8 && !!x.at &&
    x.sheetFingerprint === sheetFingerprint(e) && x.attemptFingerprint === teachBackStateFingerprint(e) &&
    fingerprint(x.unresolvedQuestionIds) === fingerprint(unresolved);
}
export function normalizeAttempts(q: TeachBack): TeachBack {
  if (q.attempts?.length) return q;
  const legacy: TeachBackAttempt = { id: "legacy-1", sheetFingerprint: q.sheetFingerprint, createdAt: null,
    audioAvailable: !!q.audioAvailable, rawTranscript: q.transcriptSource === "live" ? q.transcript ?? null : q.analysis?.status === "saved" ? q.analysis.transcript : null,
    correctedTranscript: q.transcriptSource === "human-corrected" ? q.transcript ?? null : null,
    transcription: q.transcription ?? null, analysis: q.analysis ?? null, outcome: q.outcome, reviewer: null, decidedAt: null };
  return { ...q, attempts: [legacy], activeAttemptId: legacy.id };
}
export function activeAttempt(q: TeachBack): TeachBackAttempt {
  const normalized = normalizeAttempts(q);
  if (!q.attempts) { q.attempts = normalized.attempts; q.activeAttemptId = normalized.activeAttemptId; }
  const attempt = q.attempts!.find(a => a.id === q.activeAttemptId);
  if (!attempt) throw new WorkflowError("The active answer attempt is missing.");
  return attempt;
}
export function projectAttempt(q: TeachBack) {
  const a = activeAttempt(q);
  q.audioAvailable = a.audioAvailable; q.transcript = a.correctedTranscript ?? a.rawTranscript ?? undefined;
  q.transcriptSource = a.correctedTranscript ? "human-corrected" : a.rawTranscript ? "live" : undefined;
  q.transcription = a.transcription ?? undefined; q.analysis = a.analysis; q.outcome = a.outcome;
}
export function startAttempt(q: TeachBack, respondent: Respondent = q.requiredRespondent ?? "patient"): TeachBackAttempt {
  activeAttempt(q);
  const attempt: TeachBackAttempt = { id: randomUUID(), sheetFingerprint: q.sheetFingerprint, createdAt: new Date().toISOString(), audioAvailable: false,
    rawTranscript: null, correctedTranscript: null, transcription: null, analysis: null, outcome: "pending", reviewer: null, decidedAt: null, respondent };
  q.attempts!.push(attempt); q.activeAttemptId = attempt.id; projectAttempt(q); return attempt;
}
export function reviewReady(review: AiReview | null | undefined, current: string) {
  return !!review && review.fingerprint === current && review.findings.every(f => !!f.dismissal);
}
export function savedReview(e: Encounter, stage: "note" | "sheet"): AiReview {
  return { status: "saved", fingerprint: reviewFingerprint(e, stage), findings: [], model: "none", promptVersion: "saved-synthetic@1", latencyMs: null, costUsd: null };
}
const equalFact = (a: Fact, b: Fact) => fingerprint(a) === fingerprint(b);
export function normalize(s: string): string {
  const phrases = s.toLowerCase().replace(/limang daan/g, "500").replace(/tatlong beses sa isang araw/g, "3 times daily")
    .replace(/tatlong araw/g, "3 days").replace(/pagkatapos kumain/g, "after meals")
    .replace(/hindi bumababa ang lagnat/g, "fever does not go down").replace(/nahihirapang? huminga/g, "difficulty breathing")
    .replace(/bumalik agad/g, "return immediately").replace(/magpahinga at uminom ng tubig/g, "rest and drink water")
    .replace(/huwag uminom ng antibiotic/g, "do not take antibiotics").replace(/huwag uminom ng ibuprofen o aspirin/g, "do not take ibuprofen or aspirin")
    .replace(/(?:may )?matinding pananakit ng tiyan/g, "severe abdominal pain").replace(/tuloy-tuloy ang pagsusuka/g, "persistent vomiting")
    .replace(/(?:may )?pagdurugo ng gilagid o ilong/g, "bleeding gums or nose").replace(/uminom ng maraming tubig o likido/g, "drink plenty of fluids")
    .replace(/kung may lagnat/g, "if fever");
  // Remaining Filipino, English and Spanish-derived number words become digits through the shared Taglish reader.
  return numeralize(phrases).replace(/\bkada (\d+) na oras\b/g, "every $1 hours").replace(/\b(\d+) beses sa 1 araw\b/g, "$1 times daily")
    .replace(/\bsa loob ng (\d+) araw\b/g, "$1 days").replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}
const includes = (text: string, value: string) => value.length > 0 && ` ${normalize(text)} `.includes(` ${normalize(value)} `);
export function checkEncounter(e: Encounter): Check[] {
  const issues: Check[] = [];
  const add = (id: string, target: string, message: string, severity: Check["severity"] = "error") => issues.push({ id, target, message, severity });
  if (!e.claims.length) add("note-empty", "note", "Generate and review the note first.");
  if (new Set(e.turns.map(t => t.id)).size !== e.turns.length || new Set(e.claims.map(c => c.id)).size !== e.claims.length || new Set(e.lines.map(l => l.id)).size !== e.lines.length) add("duplicate-ids", "note", "Source IDs must be unique.");
  for (const t of e.turns.filter(t => t.documentSource)) {
    const ref = t.documentSource!, doc = e.documents?.find(d => d.id === ref.documentId);
    if (!doc?.accepted || !doc.accepted.decisions.some(d => d.lineId === ref.lineId) || !doc.extraction?.lines.some(l => l.id === ref.lineId && l.page === ref.page)) add(`document-${t.id}`, t.id, "Imported source reference requires a confirmed original document line.");
  }
  for (const c of e.claims) {
    const turns = c.sourceTurnIds.map(id => e.turns.find(t => t.id === id));
    if (!turns.length || turns.some(t => !t)) { add(`source-${c.id}`, c.id, "A source turn is missing."); continue; }
    if (turns.some(t => t!.speaker !== "clinician")) add(`speaker-${c.id}`, c.id, "Confirm a clinician source; patient or unknown speech cannot authorize an instruction.");
    let source = turns.map(t => t!.text).join(" ");
    const f = c.fact;
    if (f.kind === "medication") {
      // Scope quantities to this medicine rather than accepting a number anywhere in a multi-drug turn.
      const normalized = normalize(source), own = normalize(f.medicine), start = normalized.indexOf(own);
      if (start >= 0 && own) {
        const otherStarts = e.claims.filter(other => other.id !== c.id && other.fact.kind === "medication" && normalize(other.fact.medicine) !== own)
          .map(other => normalized.indexOf(normalize(other.fact.medicine), start + own.length)).filter(index => index >= 0);
        const end = otherStarts.length ? Math.min(...otherStarts) : normalized.length;
        source = normalized.slice(start, end);
        const preceding = normalized.slice(Math.max(0, start - 40), start);
        if (/\b(do not|huwag|stop|avoid)\b/.test(preceding)) add(`med-negation-${c.id}`, c.id, "Medication appears in a negative instruction. Confirm its exact meaning with the source.");
      }
    }
    const values = f.kind === "medication" ? [f.medicine, f.dose, f.quantity, f.frequency, f.duration, f.timing] : f.kind === "warning" ? [f.condition] : f.kind === "followup" ? [f.date] : [f.action];
    for (const v of values) if (!includes(source, v)) add(`ground-${c.id}-${v}`, c.id, `Source does not support “${v || "missing value"}”. Correct the transcript or note; do not infer it.`);
    if (f.kind === "warning" && f.urgency === "immediate" && !includes(source, "return immediately")) add(`urgency-${c.id}`, c.id, "Immediate return is not supported by the cited turn.");
    if (f.kind === "warning" && f.urgency !== "immediate" && includes(source, "return immediately")) add(`delay-${c.id}`, c.id, "Immediate warning changed to a delayed return.");
    if (f.kind === "warning" && f.urgency === "immediate" && f.delayDays !== 0) add(`delay-value-${c.id}`, c.id, "An immediate warning cannot contain a waiting period.");
    if (f.kind === "negation" && f.negated !== /\b(do not|huwag)\b/.test(normalize(source))) add(`negation-${c.id}`, c.id, "The instruction's negation changed.");
    if (/\b(pasma|usog|binat)\b/i.test(renderEnglish(f))) add(`folk-${c.id}`, c.id, "A folk term must not become a clinical instruction or diagnosis.");
  }
  // Conservative completeness: every clinician turn with an instruction cue must be represented.
  for (const t of e.turns.filter(t => t.speaker === "clinician")) {
    if (/\b(mg|return|follow-up|bumalik|huwag|magpahinga|take|uminom)\b/i.test(t.text) && !e.claims.some(c => c.sourceTurnIds.includes(t.id))) add(`omission-${t.id}`, t.id, "A clinician instruction turn is missing from the note.");
    for (const cue of ["fever does not go down", "difficulty breathing", "do not take antibiotics", "do not take ibuprofen or aspirin", "severe abdominal pain", "persistent vomiting", "bleeding gums or nose"]) {
      if (includes(t.text, cue) && !e.claims.some(c => c.sourceTurnIds.includes(t.id) && includes(renderEnglish(c.fact), cue))) add(`omission-${t.id}-${cue}`, t.id, `Possibly omitted instruction: ${cue}.`);
    }
    if (/\b(follow-up|followup)\b/i.test(t.text) && !e.claims.some(c => c.fact.kind === "followup" && c.sourceTurnIds.includes(t.id))) add(`followup-${t.id}`, t.id, "Follow-up instruction is missing.");
  }
  if (e.claims.length && !e.claims.some(c => c.fact.kind === "warning")) add("missing-warning", "note", "No warning instruction is recorded. Confirm with the clinician and add it to the source; do not invent one.", "review");
  if (e.claims.length && !e.claims.some(c => c.fact.kind === "followup")) add("missing-followup", "note", "No follow-up instruction is recorded. Confirm with the clinician and add it to the source; do not infer a date.", "review");
  for (const image of e.illustrations ?? []) {
    const line = e.lines.find(l => l.id === image.lineId);
    if (!illustrationMatches(image, line) || image.lineFingerprint !== fingerprint(line)) add(`illustration-${image.lineId}`, image.lineId, "Remove or review the illustration against the current source line.");
  }
  for (const l of e.lines) {
    const sources = l.sourceClaimIds.map(id => e.claims.find(c => c.id === id));
    if (!sources.length || sources.some(s => !s)) { add(`untraced-${l.id}`, l.id, "Sheet line has no valid source claim."); continue; }
    if (!sources.some(s => equalFact(s!.fact, l.fact))) add(`meaning-${l.id}`, l.id, "Sheet meaning differs from its source: check medicine, dose, frequency, duration, negation and return timing.");
    // Critical content is rendered from facts. A model's matching metadata cannot authorize different visible text.
    if (l.text !== renderFilipino(l.fact)) add(`wording-${l.id}`, l.id, "Wording differs from the controlled Filipino template. Regenerate the sheet; free-form wording requires a separate human quality review.");
  }
  if (e.lines.length) for (const c of e.claims) if (!e.lines.some(l => l.sourceClaimIds.includes(c.id) && equalFact(l.fact, c.fact))) add(`sheet-omission-${c.id}`, c.id, `The sheet is missing: ${renderEnglish(c.fact)}`);
  return issues;
}
export function runChecks(e: Encounter): Encounter {
  return { ...e, checks: checkEncounter(e), checkedFingerprint: checkFingerprint(e) };
}
export function hasCurrentNoteApproval(e: Encounter) { return e.noteApproval?.fingerprint === noteFingerprint(e) && reviewReady(e.noteReview, noteFingerprint(e)); }
export function hasCurrentSheetApproval(e: Encounter) { return hasCurrentNoteApproval(e) && e.sheetApproval?.fingerprint === sheetFingerprint(e) && reviewReady(e.sheetReview, sheetFingerprint(e)); }
export function exportReasons(e: Encounter): string[] {
  const r: string[] = [];
  if (!e.consent) r.push("Confirm synthetic-data consent.");
  if (!hasCurrentNoteApproval(e)) r.push("Approve the current note.");
  if (!e.lines.length || !hasCurrentSheetApproval(e)) r.push("Approve the current instruction sheet.");
  if (!reviewReady(e.noteReview, noteFingerprint(e))) r.push("Resolve or manually review the current note discrepancy analysis.");
  if (!reviewReady(e.sheetReview, sheetFingerprint(e))) r.push("Resolve or manually review the current sheet discrepancy analysis.");
  if (e.checkedFingerprint !== checkFingerprint(e) || checkEncounter(e).length) r.push("Resolve checks on the current content.");
  if (unresolvedTeachBack(e).length && !currentPrintException(e)) r.push("Confirm understanding for every current answer, or record a named reviewer exception covering unresolved questions.");
  return r;
}
export function invalidate(e: Encounter, level: "transcript" | "note" | "sheet"): Encounter {
  return { ...e, illustrations: [], noteApproval: level === "sheet" ? e.noteApproval : null, sheetApproval: null,
    noteReview: level === "sheet" ? e.noteReview : null, sheetReview: null,
    teachBack: [], teachBackArchive: [...(e.teachBackArchive ?? []), ...e.teachBack.map(normalizeAttempts)].slice(-100), teachBackSkip: "", printException: null, checkedFingerprint: null, checks: [],
    audioReviewed: level === "sheet" ? e.audioReviewed : [], transcriptConfirmation: level === "transcript" ? null : e.transcriptConfirmation,
    ...(level === "transcript" ? { claims: [], lines: [] } : level === "note" ? { lines: [] } : {}) };
}
export function approveNote(e: Encounter, reviewer: string, audioReviewed: boolean): Encounter {
  if (!e.consent) throw new WorkflowError("Confirm synthetic-data consent first.");
  if (e.checkedFingerprint !== checkFingerprint(e) || checkEncounter(e).length) throw new WorkflowError("Run current checks and resolve every discrepancy first.");
  if (!reviewReady(e.noteReview, noteFingerprint(e))) throw new WorkflowError("Resolve the current note discrepancy review first.");
  if (!reviewer.trim()) throw new WorkflowError("Enter the reviewer's name or initials.", 400);
  if (e.claims.some(c => c.fact.kind === "medication") && !audioReviewed) throw new WorkflowError("Confirm each medication against the source audio, or the saved reference in demonstration mode.");
  return { ...e, noteApproval: { fingerprint: noteFingerprint(e), reviewer: reviewer.trim(), at: new Date().toISOString() }, audioReviewed: e.claims.filter(c => c.fact.kind === "medication").map(c => c.id) };
}
export function approveSheet(e: Encounter, reviewer: string, wordingReviewed: boolean): Encounter {
  if (!hasCurrentNoteApproval(e)) throw new WorkflowError("Approve the current note first.");
  if (!e.lines.length || checkEncounter(e).length || e.checkedFingerprint !== checkFingerprint(e)) throw new WorkflowError("Resolve current sheet checks before approval.");
  if (!reviewReady(e.sheetReview, sheetFingerprint(e))) throw new WorkflowError("Resolve the current sheet discrepancy review first.");
  if (!reviewer.trim() || !wordingReviewed) throw new WorkflowError("Confirm every Filipino line against its source and enter reviewer initials.", 400);
  return { ...e, sheetApproval: { fingerprint: sheetFingerprint(e), reviewer: reviewer.trim(), at: new Date().toISOString() } };
}
export function makeTeachBack(e: Encounter, savedDemo = e.mode === "saved"): TeachBack[] {
  if (!hasCurrentSheetApproval(e)) throw new WorkflowError("Approve the instruction sheet first.");
  const groups: [string, string][] = [
    ["medicine", "Ano ang inyong mga bilin tungkol sa gamot?"],
    ["warning", "Kailan kayo dapat bumalik agad?"],
    ["followup", "Kailan ang susunod ninyong balik?"],
  ];
  const c = getCase(e.caseId);
  return groups.filter(([id]) => questionLines(e, id).length).map(([id, question]) => {
    const relevant = questionLines(e, id);
    const expected = relevant.map(l => l.text).join(" ");
    const current = sheetFingerprint(e);
    const requiredRespondent: Respondent = e.companion?.present && c?.companion?.answers.includes(id) ? "companion" : "patient";
    const planted = savedDemo ? c?.plantedAnswers ? c.plantedAnswers[id] : id === "warning" && relevant.some(l => l.fact.urgency === "immediate") ? { transcript: "Babalik ako pagkatapos ng tatlong araw kung may babala.", respondent: "patient" as const } : undefined : undefined;
    const answer = planted?.transcript ?? expected;
    const q: TeachBack = { id, question, expected, outcome: "pending", sheetFingerprint: current, audioAvailable: false, analysis: null, attempts: [], requiredRespondent };
    const attempt: TeachBackAttempt = { id: randomUUID(), sheetFingerprint: current, createdAt: new Date().toISOString(), audioAvailable: false,
      rawTranscript: savedDemo ? answer : null, correctedTranscript: null, transcription: null, analysis: null, outcome: "pending", reviewer: null, decidedAt: null,
      respondent: planted?.respondent ?? requiredRespondent };
    applyRuleCheck(e, q, attempt);
    if (savedDemo) {
      // The simulated comparison is a labelled fixture. Case-01-style plants keep their original wording; newer plants mirror the real rule check.
      const findings = !planted ? [] : c?.plantedAnswers ? attempt.ruleCheck?.findings ?? [] : [{ category: "changed" as const, sourceLineIds: relevant.filter(l => l.fact.urgency === "immediate").map(l => l.id), expectedQuote: relevant.find(l => l.fact.urgency === "immediate")!.text, responseQuote: "pagkatapos ng tatlong araw", explanation: "Saved synthetic answer delays an immediate return. Reviewer must explain the correct timing and record the outcome." }];
      attempt.analysis = { status: "saved", transcript: answer, findings, model: "none", promptVersion: "saved-synthetic@1", latencyMs: null, costUsd: null, sheetFingerprint: current };
    }
    return { ...q, analysis: attempt.analysis, attempts: [attempt], activeAttemptId: attempt.id };
  });
}
export function createEncounter(id: string, caseId: string): Encounter {
  const c = getCase(caseId); if (!c) throw new WorkflowError("Unknown synthetic case.", 404);
  return { id, caseId, title: c.title, version: 1, createdAt: new Date().toISOString(), consent: false, synthetic: true, mode: "saved", ...(c.companion ? { companion: { present: true, relation: c.companion.relation } } : {}), turns: structuredClone(c.turns), claims: [], lines: [], checks: [], checkedFingerprint: null, noteApproval: null, sheetApproval: null, noteReview: null, sheetReview: null, teachBack: [], teachBackArchive: [], teachBackSkip: "", printException: null, transcriptConfirmation: null, preparation: { completed: [] }, audit: [], audioAvailable: false, audioReviewed: [], sheetMode: "template", lastError: null, provenance: { transcript: "Saved, human-authored synthetic reference. No model call.", note: "Not generated", sheet: "Not generated" } };
}
export function savedNote(e: Encounter): Claim[] {
  const c = getCase(e.caseId)!;
  if (fingerprint(c.turns) !== fingerprint(e.turns)) throw new WorkflowError("Saved drafts apply only to the unchanged reference transcript. Restore the reference or use live generation.");
  return structuredClone(c.claims);
}
export function buildSheet(e: Encounter): SheetLine[] {
  if (!hasCurrentNoteApproval(e)) throw new WorkflowError("Approve the current note before creating a sheet.");
  return templateSheet(e.claims);
}
