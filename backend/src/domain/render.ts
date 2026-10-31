import type { Fact, SheetLine, Claim } from "./schema";
const filipino: Record<string, string> = {
  "fever does not go down": "hindi bumababa ang lagnat",
  "difficulty breathing": "nahihirapang huminga",
  "rest and drink water": "Magpahinga at uminom ng tubig.",
  "take antibiotics": "uminom ng antibiotic",
  "3 times daily": "3 beses sa isang araw", "1 time daily": "1 beses sa isang araw",
  "after meals": "pagkatapos kumain", "at night": "sa gabi",
  "3 days": "3 araw", "5 days": "5 araw",
  "1 tablet": "1 tableta",
  // Case-04 drafts: pending clinician and native-speaker review like every other entry.
  "every 6 hours": "kada 6 na oras", "if fever": "kung may lagnat",
  "severe abdominal pain": "may matinding pananakit ng tiyan", "persistent vomiting": "tuloy-tuloy ang pagsusuka",
  "bleeding gums or nose": "may pagdurugo ng gilagid o ilong", "take ibuprofen or aspirin": "uminom ng ibuprofen o aspirin",
  "drink plenty of fluids": "Uminom ng maraming tubig o likido.",
};
const translate = (s: string) => filipino[s] ?? s;
export function renderEnglish(f: Fact): string {
  switch (f.kind) {
    case "medication": return `${f.medicine} ${f.dose} · ${f.quantity} · ${f.frequency} · ${f.timing} · ${f.duration}`;
    case "warning": return `Return ${f.urgency === "immediate" ? "immediately" : `after ${f.delayDays ?? "?"} days`} if ${f.condition}.`;
    case "followup": return `Follow-up: ${f.date}.`;
    case "negation": return `${f.negated ? "Do not" : "Do"} ${f.action}.`;
    default: return f.action;
  }
}
export function renderFilipino(f: Fact): string {
  switch (f.kind) {
    case "medication": return `${f.medicine} ${f.dose} · ${translate(f.quantity)} · ${translate(f.frequency)} · ${translate(f.timing)} · sa loob ng ${translate(f.duration)}.`;
    case "warning": return `${f.urgency === "immediate" ? "Bumalik agad" : `Bumalik pagkalipas ng ${f.delayDays ?? "?"} araw`} kung ${translate(f.condition)}.`;
    case "followup": return `Susunod na balik: ${f.date}.`;
    case "negation": return `${f.negated ? "Huwag" : "Maaari"} ${translate(f.action)}.`;
    default: return translate(f.action);
  }
}
export function templateSheet(claims: Claim[]): SheetLine[] {
  return claims.map((c, i) => ({ id: `l${i + 1}`, sourceClaimIds: [c.id], fact: { ...c.fact }, text: renderFilipino(c.fact) }));
}
export const sectionLabel: Record<Fact["kind"], string> = { medication: "Gamot", warning: "Bumalik agad kung", followup: "Susunod na balik", advice: "Gawin", negation: "Paalala" };
