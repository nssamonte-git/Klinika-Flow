// Synthetic, author-written teach-back answers for the deterministic rule check.
// Written alongside the parser, so this is a development set, not held-out or native-speaker evidence.
// `contradicts: true` means the answer changes or reverses an approved instruction and should get a "changed" finding.
import { getCase } from "../src/domain/cases";
import { templateSheet } from "../src/domain/render";
import { compareAnswer, factKindsFor } from "../src/domain/taglish";

export type AnswerSample = { id: string; caseId: string; questionId: "medicine" | "warning" | "followup"; transcript: string; contradicts: boolean };

export const teachBackAnswers: AnswerSample[] = [
  // case-01 · medicine
  { id: "c1-med-ok-1", caseId: "case-01", questionId: "medicine", contradicts: false, transcript: "Paracetamol, limang daan, isang tableta, tatlong beses sa isang araw pagkatapos kumain, sa loob ng tatlong araw. Huwag akong iinom ng antibiotic." },
  { id: "c1-med-ok-2", caseId: "case-01", questionId: "medicine", contradicts: false, transcript: "Iinom po ako ng paracetamol 500 mg, 3 times a day after meals, for 3 days. Bawal ang antibiotic." },
  { id: "c1-med-ok-3", caseId: "case-01", questionId: "medicine", contradicts: false, transcript: "Isang tableta ng paracetamol sa umaga, tanghali at gabi, pagkatapos kumain. Wag daw uminom ng antibiotiko." },
  { id: "c1-med-ok-4", caseId: "case-01", questionId: "medicine", contradicts: false, transcript: "Paracetamol po, tres beses sa isang araw, busog dapat. Hindi ako iinom ng antibiotic." },
  { id: "c1-med-bad-dose", caseId: "case-01", questionId: "medicine", contradicts: true, transcript: "Paracetamol dalawang daan at limampung mg, tatlong beses sa isang araw. Walang antibiotic." },
  { id: "c1-med-bad-freq", caseId: "case-01", questionId: "medicine", contradicts: true, transcript: "Paracetamol isang beses sa isang araw lang po, pagkatapos kumain. Huwag uminom ng antibiotic." },
  { id: "c1-med-bad-meal", caseId: "case-01", questionId: "medicine", contradicts: true, transcript: "Paracetamol 500, tatlong beses sa isang araw, bago kumain. Huwag ang antibiotic." },
  { id: "c1-med-bad-days", caseId: "case-01", questionId: "medicine", contradicts: true, transcript: "Paracetamol tatlong beses sa isang araw sa loob ng isang linggo. Huwag uminom ng antibiotic." },
  { id: "c1-med-bad-neg", caseId: "case-01", questionId: "medicine", contradicts: true, transcript: "Paracetamol tatlong beses sa isang araw, at iinom din ako ng antibiotic para mabilis gumaling." },
  { id: "c1-med-bad-every", caseId: "case-01", questionId: "medicine", contradicts: true, transcript: "Paracetamol kada apat na oras po. Huwag uminom ng antibiotic." },
  // case-01 · warning
  { id: "c1-warn-ok-1", caseId: "case-01", questionId: "warning", contradicts: false, transcript: "Babalik po ako agad kung hindi bumaba ang lagnat o kung nahihirapan akong huminga." },
  { id: "c1-warn-ok-2", caseId: "case-01", questionId: "warning", contradicts: false, transcript: "Kapag hirap huminga o tuloy pa rin ang lagnat, babalik kaagad, hindi na maghihintay." },
  { id: "c1-warn-ok-3", caseId: "case-01", questionId: "warning", contradicts: false, transcript: "Right away po kung may fever pa rin o difficulty breathing." },
  { id: "c1-warn-bad-1", caseId: "case-01", questionId: "warning", contradicts: true, transcript: "Babalik ako pagkatapos ng tatlong araw kung may babala." },
  { id: "c1-warn-bad-2", caseId: "case-01", questionId: "warning", contradicts: true, transcript: "Kung hirap huminga, maghihintay muna ako ng dalawang araw bago bumalik." },
  { id: "c1-warn-bad-3", caseId: "case-01", questionId: "warning", contradicts: true, transcript: "Babalik agad kung hirap huminga, pero kung may lagnat pa, babalik ako pagkatapos ng limang araw." },
  { id: "c1-warn-bad-4", caseId: "case-01", questionId: "warning", contradicts: true, transcript: "Kung hindi bumaba ang lagnat, babalik po ako bukas." },
  // case-01 · follow-up
  { id: "c1-fu-ok-1", caseId: "case-01", questionId: "followup", contradicts: false, transcript: "Sa ika-10 ng Nobyembre po ang balik ko." },
  { id: "c1-fu-ok-2", caseId: "case-01", questionId: "followup", contradicts: false, transcript: "November 10 po." },
  { id: "c1-fu-bad-1", caseId: "case-01", questionId: "followup", contradicts: true, transcript: "Sa Nobyembre 17 po ako babalik." },
  { id: "c1-fu-bad-2", caseId: "case-01", questionId: "followup", contradicts: true, transcript: "Ika-1 ng Disyembre." },
  // case-02
  { id: "c2-med-ok-1", caseId: "case-02", questionId: "medicine", contradicts: false, transcript: "Cetirizine 10 mg, isang beses sa isang araw sa gabi, limang araw. Huwag uminom ng antibiotic." },
  { id: "c2-med-ok-2", caseId: "case-02", questionId: "medicine", contradicts: false, transcript: "Isang tableta ng cetirizine bago matulog sa gabi sa loob ng limang araw. Bawal ang antibiotic." },
  { id: "c2-med-bad-time", caseId: "case-02", questionId: "medicine", contradicts: true, transcript: "Cetirizine po sa umaga. Wag uminom ng antibiotic." },
  { id: "c2-med-bad-count", caseId: "case-02", questionId: "medicine", contradicts: true, transcript: "Cetirizine dalawang tableta isang beses sa isang araw. Huwag uminom ng antibiotic." },
  { id: "c2-warn-ok", caseId: "case-02", questionId: "warning", contradicts: false, transcript: "Kaagad po kung nahihirapang huminga." },
  { id: "c2-warn-bad", caseId: "case-02", questionId: "warning", contradicts: true, transcript: "Kung hirap huminga, after 3 days po ako babalik." },
  { id: "c2-fu-ok", caseId: "case-02", questionId: "followup", contradicts: false, transcript: "Sa 2026-11-12 po." },
  // case-03
  { id: "c3-med-ok", caseId: "case-03", questionId: "medicine", contradicts: false, transcript: "Wala pong gamot. Huwag daw akong uminom ng antibiotic." },
  { id: "c3-med-bad", caseId: "case-03", questionId: "medicine", contradicts: true, transcript: "Iinom po ako ng antibiotic na tira sa bahay." },
  { id: "c3-warn-ok", caseId: "case-03", questionId: "warning", contradicts: false, transcript: "Babalik agad kung hirap akong huminga." },
  { id: "c3-warn-bad", caseId: "case-03", questionId: "warning", contradicts: true, transcript: "Hihintayin ko muna ang isang linggo kahit hirap huminga." },
  // case-04 · companion answers
  { id: "c4-med-ok-1", caseId: "case-04", questionId: "medicine", contradicts: false, transcript: "Paracetamol 500, isang tableta kada anim na oras kung may lagnat, tatlong araw. Huwag ibibigay ang ibuprofen o aspirin." },
  { id: "c4-med-ok-2", caseId: "case-04", questionId: "medicine", contradicts: false, transcript: "Every 6 hours po ang paracetamol kapag may lagnat. Bawal ang aspirin at ibuprofen." },
  { id: "c4-med-bad-neg-1", caseId: "case-04", questionId: "medicine", contradicts: true, transcript: "Bibigyan ko si Nanay ng Paracetamol 500 mg, isang tableta, kada anim na oras kung may lagnat. Kung sumakit ang tiyan niya, ibuprofen ang ibibigay ko." },
  { id: "c4-med-bad-neg-2", caseId: "case-04", questionId: "medicine", contradicts: true, transcript: "Paracetamol kada anim na oras, tapos aspirin kung masakit ang ulo niya." },
  { id: "c4-med-bad-freq", caseId: "case-04", questionId: "medicine", contradicts: true, transcript: "Paracetamol kada dalawang oras po. Huwag ang ibuprofen at aspirin." },
  { id: "c4-warn-ok-1", caseId: "case-04", questionId: "warning", contradicts: false, transcript: "Dadalhin ko po siya agad kung sumakit nang husto ang tiyan, kung nagsusuka, o kung dumudugo ang gilagid o ilong." },
  { id: "c4-warn-ok-2", caseId: "case-04", questionId: "warning", contradicts: false, transcript: "Kaagad po kami babalik kapag may pagdurugo, pagsusuka o matinding sakit ng tiyan." },
  { id: "c4-warn-bad-1", caseId: "case-04", questionId: "warning", contradicts: true, transcript: "Kung dumudugo ang gilagid niya, babalik kami pagkatapos ng dalawang araw." },
  { id: "c4-warn-bad-2", caseId: "case-04", questionId: "warning", contradicts: true, transcript: "Babalik agad kung sumakit ang tiyan, pero kung nagsusuka, hihintayin ko muna ang tatlong araw." },
  { id: "c4-fu-ok", caseId: "case-04", questionId: "followup", contradicts: false, transcript: "Sa ika-4 ng Nobyembre po kami babalik." },
  { id: "c4-fu-bad", caseId: "case-04", questionId: "followup", contradicts: true, transcript: "Sa Nobyembre 10 na po kami babalik." },
];

/** Scores the rule check on the corpus: caught contradictions, misses and false alarms ("changed" findings on a correct answer). */
export function scoreRuleCheck(samples = teachBackAnswers) {
  const results = samples.map(sample => {
    const lines = templateSheet(getCase(sample.caseId)!.claims).filter(l => factKindsFor[sample.questionId].includes(l.fact.kind));
    const findings = compareAnswer(lines, sample.transcript), flagged = findings.some(f => f.category === "changed");
    return { id: sample.id, contradicts: sample.contradicts, flagged, correct: flagged === sample.contradicts, categories: findings.map(f => f.category) };
  });
  const contradictions = results.filter(r => r.contradicts), clean = results.filter(r => !r.contradicts);
  return { samples: results.length, contradictions: contradictions.length, caught: contradictions.filter(r => r.flagged).length,
    clean: clean.length, falseAlarms: clean.filter(r => r.flagged).length, otherFindingsOnClean: clean.filter(r => !r.flagged && r.categories.length).length,
    incorrect: results.filter(r => !r.correct) };
}
