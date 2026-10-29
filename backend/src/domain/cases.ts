import { Case, Claim, Fact, Turn, emptyFact } from "./schema";
const fact = (values: Partial<Fact>): Fact => ({ ...emptyFact, ...values });
const turn = (id: string, speaker: Turn["speaker"], text: string, start: number): Turn => ({ id, speaker, text, startMs: start * 1000, endMs: (start + 8) * 1000 });
const claim = (id: string, turnId: string, values: Partial<Fact>): Claim => ({ id, sourceTurnIds: [turnId], fact: fact(values) });
// Human-authored synthetic fixtures. These are reference material, never model results or clinical advice.
export const cases: Case[] = [
  {
    id: "case-01", title: "Clear instructions, before she leaves", subtitle: "Taglish · fever · immediate warning signs", patient: "Patient A · synthetic adult",
    turns: [
      turn("t1", "patient", "Dok, may lagnat ako. Wala akong allergy. This is a fictional consultation.", 0),
      turn("t2", "clinician", "For this synthetic plan: Paracetamol limang daan mg, 1 tablet, tatlong beses sa isang araw, pagkatapos kumain, sa loob ng tatlong araw.", 8),
      turn("t3", "clinician", "Bumalik agad kung hindi bumababa ang lagnat. Bumalik agad kung nahihirapang huminga. Do not wait three days for these warning signs.", 16),
      turn("t4", "clinician", "Magpahinga at uminom ng tubig. Huwag uminom ng antibiotic.", 24),
      turn("t5", "clinician", "For this fictional visit on 2026-11-03, return for follow-up on 2026-11-10.", 32),
    ],
    claims: [
      claim("c1", "t2", { kind: "medication", medicine: "Paracetamol", dose: "500 mg", quantity: "1 tablet", frequency: "3 times daily", duration: "3 days", timing: "after meals" }),
      claim("c2", "t3", { kind: "warning", condition: "fever does not go down", urgency: "immediate", delayDays: 0 }),
      claim("c3", "t3", { kind: "warning", condition: "difficulty breathing", urgency: "immediate", delayDays: 0 }),
      claim("c4", "t4", { kind: "advice", action: "rest and drink water" }),
      claim("c5", "t4", { kind: "negation", action: "take antibiotics", negated: true }),
      claim("c6", "t5", { kind: "followup", date: "2026-11-10", urgency: "scheduled" }),
    ],
  },
  {
    id: "case-02", title: "Keep every number attached", subtitle: "English + Filipino · medication fields · follow-up", patient: "Patient B · synthetic adult",
    turns: [
      turn("t1", "patient", "This is a synthetic test, dok. I need clear instructions for the fictional medicine.", 0),
      turn("t2", "clinician", "Synthetic instructions only: Cetirizine 10 mg, 1 tablet, 1 time daily, at night, for 5 days.", 8),
      turn("t3", "clinician", "Bumalik agad kung nahihirapang huminga. Huwag uminom ng antibiotic.", 16),
      turn("t4", "clinician", "Follow-up on 2026-11-12.", 24),
    ],
    claims: [
      claim("c1", "t2", { kind: "medication", medicine: "Cetirizine", dose: "10 mg", quantity: "1 tablet", frequency: "1 time daily", duration: "5 days", timing: "at night" }),
      claim("c2", "t3", { kind: "warning", condition: "difficulty breathing", urgency: "immediate", delayDays: 0 }),
      claim("c3", "t3", { kind: "negation", action: "take antibiotics", negated: true }),
      claim("c4", "t4", { kind: "followup", date: "2026-11-12", urgency: "scheduled" }),
    ],
  },
  {
    id: "case-03", title: "Preserve the word “huwag”", subtitle: "Negation · no medicine · warning signs", patient: "Patient C · synthetic adult",
    turns: [
      turn("t1", "patient", "Fictional case po ito. Wala akong lagnat. May pasma daw ako, sabi ng kapitbahay.", 0),
      turn("t2", "clinician", "Magpahinga at uminom ng tubig. Huwag uminom ng antibiotic. No medicine is prescribed in this synthetic case; pasma is the patient's word, not a diagnosis.", 8),
      turn("t3", "clinician", "Bumalik agad kung nahihirapang huminga.", 16),
      turn("t4", "clinician", "Follow-up on 2026-11-14.", 24),
    ],
    claims: [
      claim("c1", "t2", { kind: "advice", action: "rest and drink water" }),
      claim("c2", "t2", { kind: "negation", action: "take antibiotics", negated: true }),
      claim("c3", "t3", { kind: "warning", condition: "difficulty breathing", urgency: "immediate", delayDays: 0 }),
      claim("c4", "t4", { kind: "followup", date: "2026-11-14", urgency: "scheduled" }),
    ],
  },
];
export const getCase = (id: string) => cases.find(c => c.id === id);
