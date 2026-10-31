import type { Fact, SheetLine, TeachBackFinding } from "./schema";

// Deterministic Taglish reading of dose, frequency, duration, urgency and negation.
// It flags contradictions against structured sheet facts; it never judges wording or decides understanding.
export const RULE_CHECK_VERSION = "taglish@1";

const UNITS: Record<string, number> = {
  isa: 1, isang: 1, dalawa: 2, dalawang: 2, tatlo: 3, tatlong: 3, apat: 4, lima: 5, limang: 5, anim: 6, pito: 7, pitong: 7, walo: 8, walong: 8, siyam: 9, sampu: 10, sampung: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, labindalawa: 12, labindalawang: 12,
  uno: 1, dos: 2, tres: 3, kwatro: 4, kuwatro: 4, singko: 5, sinko: 5, sais: 6, siyete: 7, otso: 8, nuwebe: 9, diyes: 10,
};
const TENS: Record<string, number> = {
  dalawampu: 20, dalawampung: 20, tatlumpu: 30, tatlumpung: 30, apatnapu: 40, apatnapung: 40, limampu: 50, limampung: 50,
  animnapu: 60, pitumpu: 70, walumpu: 80, siyamnapu: 90, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const HUNDRED = new Set(["daan", "raan", "hundred"]);
const MULTIPLES: Record<string, string> = { once: "1 times", twice: "2 times", thrice: "3 times", makalawa: "2 beses", makatlo: "3 beses" };

type Token = { text: string; start: number; end: number };
type View = { normalized: string; spans: { from: number; to: number; start: number; end: number }[]; source: string };

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)].map(m => ({ text: m[0].toLowerCase().replace(/’/g, "'"), start: m.index!, end: m.index! + m[0].length }));
}
function readNumber(list: Token[], i: number): { value: number; next: number } | null {
  const t = list[i]?.text;
  if (!t) return null;
  if (/^\d+$/.test(t)) return { value: Number(t), next: i + 1 };
  const tensJoined = t.match(/^(\p{L}+)'t$/u);
  if (tensJoined && TENS[tensJoined[1]] !== undefined) {
    const unit = UNITS[list[i + 1]?.text ?? ""];
    return unit !== undefined && unit < 10 ? { value: TENS[tensJoined[1]] + unit, next: i + 2 } : { value: TENS[tensJoined[1]], next: i + 1 };
  }
  if (TENS[t] !== undefined) {
    const joined = ["at", "and"].includes(list[i + 1]?.text ?? "") ? UNITS[list[i + 2]?.text ?? ""] : undefined;
    return joined !== undefined && joined < 10 ? { value: TENS[t] + joined, next: i + 3 } : { value: TENS[t], next: i + 1 };
  }
  if (UNITS[t] === undefined) return null;
  let value = UNITS[t], next = i + 1;
  if (list[next]?.text === "na" && HUNDRED.has(list[next + 1]?.text ?? "")) next++;
  if (HUNDRED.has(list[next]?.text ?? "")) {
    value *= 100; next++;
    if (["at", "and"].includes(list[next]?.text ?? "")) { const rest = readNumber(list, next + 1); if (rest && rest.value < 100) return { value: value + rest.value, next: rest.next }; }
  }
  return { value, next };
}
/** Lower-cases text and rewrites Filipino, English and Spanish-derived number words as digits, keeping a map back to the original words. */
export function view(source: string): View {
  const list = tokens(source), spans: View["spans"] = [];
  let normalized = "";
  for (let i = 0; i < list.length;) {
    const number = readNumber(list, i);
    const text = number ? String(number.value) : MULTIPLES[list[i].text] ?? list[i].text, next = number ? number.next : i + 1;
    if (normalized) normalized += " ";
    spans.push({ from: normalized.length, to: normalized.length + text.length, start: list[i].start, end: list[next - 1].end });
    normalized += text; i = next;
  }
  return { normalized, spans, source };
}
export const numeralize = (text: string) => view(text).normalized;
/** Returns the exact original words behind a match in the normalized view. */
function quote(v: View, from: number, to: number): string {
  const covered = v.spans.filter(s => s.to > from && s.from < to);
  return covered.length ? v.source.slice(covered[0].start, covered[covered.length - 1].end) : "";
}

const IMMEDIATE = /\b(?:agad|kaagad|agad-agad|kaagad-agad|ngayon din|ngayon mismo|immediately|right away|at once|diretso)\b/g;
const DELAY = /\b(?:pagkatapos ng|pagkalipas ng|makalipas ang|makalipas ng|after|(?:wait|maghintay|maghihintay|hihintayin|hintayin)(?:\s+(?:muna|ko|namin|ako|kami|po|ng|ang|lang|for))*)\s+(\d+)\s+(araw|days?|linggo|weeks?)\b|\b(bukas|tomorrow|sa makalawa)\b/g;
const NEGATION = /\b(?:huwag|wag|hwag|bawal|walang(?! laman)|hindi dapat|hindi pwede|hindi puwede|do not|don't|dont|never|avoid|iwasan|hindi(?: ko| namin| siya| kami| ako)? (?:iinumin|iinom|uminom|ibibigay|bibigyan|painumin|papainumin|gagamit|gamitin))\b/;
const GIVE_OR_TAKE = /\b(?:iinom|iinumin|uminom|inumin|painumin|papainumin|ibigay|ibibigay|bibigyan|binigyan|gagamit|gamitin|take|takes|taking|give|giving|use)\b/;
const MONTHS: Record<string, number> = { enero: 1, january: 1, pebrero: 2, february: 2, marso: 3, march: 3, abril: 4, april: 4, mayo: 5, hunyo: 6, june: 6, hulyo: 7, july: 7, agosto: 8, august: 8, setyembre: 9, september: 9, oktubre: 10, october: 10, nobyembre: 11, november: 11, disyembre: 12, december: 12 };
const MONTH = Object.keys(MONTHS).join("|");
// Warning-sign concepts in Filipino and English. Any shared word links an answer to a warning line.
const CONCEPTS = [
  ["lagnat", "nilalagnat", "fever"], ["huminga", "paghinga", "hinga", "hingal", "breath"], ["tiyan", "sikmura", "abdominal", "stomach"],
  ["suka", "vomit"], ["dugo", "durugo", "bleed", "blood"], ["gilagid", "gums"], ["ilong", "nose"], ["antok", "drowsy"], ["dumi", "stool"],
];
const STOPWORDS = new Set(["take", "uminom", "inumin", "ng", "or", "o", "and", "at", "the", "a", "mga", "do", "any", "of", "kung", "ang", "sa", "na"]);

type Window = { from: number; to: number };
type Hit = { at: number; text: string; days?: number };
const hits = (v: View, pattern: RegExp, within: Window = { from: 0, to: v.normalized.length }): Hit[] =>
  [...v.normalized.matchAll(new RegExp(pattern.source, "g"))].filter(m => m.index! >= within.from && m.index! < within.to)
    .map(m => ({ at: m.index!, text: quote(v, m.index!, m.index! + m[0].length), days: m[3] ? (m[3] === "bukas" || m[3] === "tomorrow" ? 1 : 2) : m[1] ? Number(m[1]) * (/linggo|week/.test(m[2]) ? 7 : 1) : undefined }));
function sentences(v: View): Window[] {
  const ends = [...v.source.matchAll(/[.;!?\n]+/g)].map(m => m.index!);
  const windows: Window[] = []; let start = 0;
  for (const end of [...ends, v.source.length]) {
    const covered = v.spans.filter(s => s.start >= start && s.end <= end);
    if (covered.length) windows.push({ from: covered[0].from, to: covered[covered.length - 1].to });
    start = end;
  }
  return windows;
}
function clauseAt(v: View, at: number): Window {
  const span = v.spans.find(s => s.from <= at && at < s.to) ?? v.spans[0];
  const before = v.source.slice(0, span.start).search(/[^.;!?,\n]*$/), after = v.source.slice(span.end).search(/[.;!?,\n]|\s(?:pero|but|tapos)\s/i);
  const start = before < 0 ? 0 : before, end = after < 0 ? v.source.length : span.end + after;
  const covered = v.spans.filter(s => s.start >= start && s.end <= end);
  return { from: covered[0].from, to: covered[covered.length - 1].to };
}
const stem = (word: string) => word.toLowerCase().replace(/c/g, "k").replace(/s$/, "");
const termKey = (word: string) => { const s = stem(word); return s.length > 7 ? s.slice(0, 7) : s; };
function termHits(v: View, terms: string[], within?: Window): Hit[] {
  const keys = terms.map(termKey).filter(k => k.length >= 3);
  return v.spans.filter(s => (!within || (s.from >= within.from && s.from < within.to)) && keys.some(k => stem(v.normalized.slice(s.from, s.to)).startsWith(k)))
    .map(s => ({ at: s.from, text: v.source.slice(s.start, s.end) }));
}
const contentWords = (text: string) => (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter(w => w.length >= 3 && !STOPWORDS.has(w));
const lineConcepts = (line: SheetLine) => { const text = `${line.text} ${line.fact.condition}`.toLowerCase(); return CONCEPTS.filter(group => group.some(word => text.includes(word))); };
const conceptHits = (v: View, groups: string[][], within: Window) => v.spans.filter(s => s.from >= within.from && s.from < within.to && groups.some(g => g.some(word => v.normalized.slice(s.from, s.to).includes(word))))
  .map(s => ({ at: s.from, text: v.source.slice(s.start, s.end) }));

export type ParsedInstruction = { doseMg: number | null; count: number | null; timesPerDay: number | null; durationDays: number | null; timesOfDay: ("morning" | "noon" | "night")[]; meal: "before" | "after" | null; urgency: { kind: "immediate" } | { kind: "delayed"; days: number } | { kind: "none" }; negated: boolean };
type Found<T> = { value: T; text: string } | null;
function first<T>(v: View, pattern: RegExp, read: (m: RegExpMatchArray) => T, within?: Window): Found<T> {
  for (const m of v.normalized.matchAll(new RegExp(pattern.source, "g"))) if (!within || (m.index! >= within.from && m.index! < within.to)) return { value: read(m), text: quote(v, m.index!, m.index! + m[0].length) };
  return null;
}
const fields = (v: View, within?: Window) => {
  const slots = (["morning", "noon", "night"] as const).map(slot => ({ slot, found: first(v, slot === "morning" ? /\b(?:umaga|morning|almusal)\b/ : slot === "noon" ? /\b(?:tanghali|noon|lunch|tanghalian)\b/ : /\b(?:gabi|night|evening|bedtime|hapunan)\b/, () => true, within) })).filter(s => s.found);
  const timesOfDay = slots.map(s => s.slot);
  const every = first(v, /\b(?:kada|tuwing|every)\s+(\d+)\s+(?:na\s+)?(?:oras|hours?)\b/, m => Math.round(24 / Number(m[1])), within);
  return {
    dose: first(v, /\b(\d+)\s*(?:mg|milligrams?|milligramo)\b/, m => Number(m[1]), within),
    count: first(v, /\b(\d+)\s+(?:na\s+)?(?:tableta|tabletas|tablets?|tabs?|kapsula|capsules?|piraso|pirasong)\b/, m => Number(m[1]), within),
    perDay: first(v, /\b(\d+)\s*(?:beses|times?|x)\s*(?:sa\s+(?:1|isang)\s+araw|a day|per day|daily|araw-araw|kada araw)\b/, m => Number(m[1]), within) ?? every,
    duration: first(v, /\b(?:sa loob ng|for|within|hanggang)\s+(\d+)\s+(araw|days?|linggo|weeks?)\b/, m => Number(m[1]) * (/linggo|week/.test(m[2]) ? 7 : 1), within),
    meal: first(v, /\b(?:pagkatapos(?: ng)? (?:kumain|kain|almusal|tanghalian|hapunan)|after (?:meals?|eating|food)|busog)\b|\b(?:bago (?:kumain|kain)|before (?:meals?|eating)|walang laman ang tiyan|empty stomach)\b/, m => /bago|before|walang|empty/.test(m[0]) ? "before" as const : "after" as const, within),
    timesOfDay, timesOfDayText: slots[0]?.found?.text ?? "",
  };
};
export function parseInstruction(text: string): ParsedInstruction {
  const v = view(text), f = fields(v), delay = hits(v, DELAY)[0];
  return {
    doseMg: f.dose?.value ?? null, count: f.count?.value ?? null, durationDays: f.duration?.value ?? null, meal: f.meal?.value ?? null, timesOfDay: f.timesOfDay,
    timesPerDay: f.perDay?.value ?? (f.timesOfDay.length > 1 ? f.timesOfDay.length : null),
    urgency: hits(v, IMMEDIATE).length ? { kind: "immediate" } : delay ? { kind: "delayed", days: delay.days! } : { kind: "none" },
    negated: NEGATION.test(v.normalized),
  };
}

type Finding = TeachBackFinding;
const expected = (line: SheetLine, preferred?: string) => (preferred && line.text.includes(preferred) ? preferred : line.text).slice(0, 400);
function medicationFindings(v: View, line: SheetLine, others: string[], single: boolean): Finding[] {
  const f = line.fact, mentions = termHits(v, [f.medicine.split(/\s+/)[0]]);
  let window: Window | null = null;
  if (mentions.length) {
    const start = mentions[0].at, next = termHits(v, others).map(h => h.at).filter(at => at > start);
    window = { from: start, to: next.length ? Math.min(...next) : v.normalized.length };
    const clause = clauseAt(v, start);
    if (NEGATION.test(v.normalized.slice(clause.from, clause.to))) return [{ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: quote(v, clause.from, clause.to), explanation: `The answer says not to take ${f.medicine}, which the approved line prescribes.` }];
  } else if (single) {
    const other = termHits(v, others)[0];
    window = { from: 0, to: other ? clauseAt(v, other.at).from : v.normalized.length };
    const g = fields(v, window);
    if (!g.dose && !g.perDay && !g.duration && !g.count && !g.timesOfDay.length) window = null;
  }
  if (!window) return [{ category: "missing", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: "", explanation: `The answer does not mention ${f.medicine}.` }];
  const heard = fields(v, window), want = parseInstruction(`${f.dose} ${f.quantity} ${f.frequency} ${f.timing}`);
  const days = numeralize(f.duration).match(/(\d+)\s+(araw|days?|linggo|weeks?)/), wantDays = days ? Number(days[1]) * (/linggo|week/.test(days[2]) ? 7 : 1) : null;
  const out: Finding[] = [];
  const differ = (label: string, got: Found<number | string>, value: number | string | null, phrase: string) => {
    if (got && value !== null && got.value !== value) out.push({ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line, phrase), responseQuote: got.text, explanation: `The answer changes the ${label}: the approved line says ${phrase}.` });
  };
  differ("dose", heard.dose, want.doseMg, f.dose);
  differ("number of tablets", heard.count, want.count, line.text.match(/\d+\s+tableta/)?.[0] ?? f.quantity);
  const perDay = heard.perDay ?? (heard.timesOfDay.length > 1 ? { value: heard.timesOfDay.length, text: quote(v, window.from, window.to) } : null);
  differ("times per day", perDay, want.timesPerDay, line.text.match(/\d+\s+beses sa isang araw/)?.[0] ?? f.frequency);
  differ("number of days", heard.duration, wantDays, line.text.match(/sa loob ng [^.·]+/)?.[0]?.trim() ?? f.duration);
  differ("meal timing", heard.meal, want.meal, line.text.match(/(pagkatapos|bago) kumain/)?.[0] ?? f.timing);
  if (want.timesOfDay.length && heard.timesOfDay.length && !heard.timesOfDay.some(slot => want.timesOfDay.includes(slot))) out.push({ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line, line.text.match(/sa (umaga|tanghali|gabi)/)?.[0]), responseQuote: heard.timesOfDayText, explanation: `The answer moves ${f.medicine} to a different time of day.` });
  return out;
}
function negationFindings(v: View, line: SheetLine): Finding[] {
  const terms = [...new Set([...contentWords(line.fact.action), ...contentWords(line.text.replace(/^(huwag|maaari)\s+/i, ""))])].filter(w => !["uminom", "huwag", "maaari"].includes(w));
  const mentions = termHits(v, terms);
  const describe = (h: Hit) => { const clause = clauseAt(v, h.at), text = v.normalized.slice(clause.from, clause.to); return { clause, negated: NEGATION.test(text), acts: GIVE_OR_TAKE.test(text) }; };
  const read = mentions.map(h => ({ hit: h, ...describe(h) }));
  if (line.fact.negated) {
    const broken = read.find(r => !r.negated && r.acts);
    if (broken) return [{ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: quote(v, broken.clause.from, broken.clause.to), explanation: `The answer plans to use what the approved line says not to (“${broken.hit.text}”); the “huwag” is lost.` }];
    if (read.some(r => r.negated)) return [];
    if (read.length) return [{ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: quote(v, read[0].clause.from, read[0].clause.to), explanation: `The answer names “${read[0].hit.text}” without saying to avoid it.` }];
    return [{ category: "missing", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: "", explanation: "The answer does not mention what to avoid." }];
  }
  const reversed = read.find(r => r.negated);
  return reversed ? [{ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: quote(v, reversed.clause.from, reversed.clause.to), explanation: "The answer turns a permitted action into a prohibition." }] : read.length ? [] : [{ category: "missing", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: "", explanation: "The answer does not mention this instruction." }];
}
function warningFindings(v: View, lines: SheetLine[]): Finding[] {
  const out: Finding[] = [], unattributedDelays: Hit[] = [];
  const perLine = new Map(lines.map(l => [l.id, { delayed: [] as Hit[], immediate: false, mentioned: false }]));
  for (const sentence of sentences(v)) {
    const cues = [...hits(v, IMMEDIATE, sentence).map(h => ({ ...h, kind: "immediate" as const })), ...hits(v, DELAY, sentence).map(h => ({ ...h, kind: "delayed" as const }))];
    let attributed = false;
    for (const line of lines) {
      const groups = lineConcepts(line), mentions = groups.length ? conceptHits(v, groups, sentence) : termHits(v, contentWords(line.text.split(/\bkung\b/i)[1] ?? line.fact.condition).filter(w => w.length >= 5), sentence);
      const state = perLine.get(line.id)!;
      for (const mention of mentions) {
        state.mentioned = true; attributed = true;
        const nearest = cues.sort((a, b) => Math.abs(a.at - mention.at) - Math.abs(b.at - mention.at))[0];
        if (nearest?.kind === "immediate") state.immediate = true; else if (nearest) state.delayed.push(nearest);
      }
    }
    if (!attributed) unattributedDelays.push(...cues.filter(c => c.kind === "delayed"));
  }
  const generic: SheetLine[] = [];
  for (const line of lines) {
    const state = perLine.get(line.id)!, immediate = line.fact.urgency === "immediate", phrase = immediate ? "Bumalik agad" : undefined;
    const wrong = state.delayed.find(d => immediate || d.days !== line.fact.delayDays);
    if (wrong) out.push({ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line, phrase), responseQuote: wrong.text, explanation: immediate ? `The answer delays an immediate return (“${wrong.text}”).` : "The answer changes the waiting period." });
    else if (state.immediate || (!immediate && state.mentioned)) continue;
    else if (state.mentioned) out.push({ category: "unclear", sourceLineIds: [line.id], expectedQuote: expected(line, phrase), responseQuote: "", explanation: "The answer names this warning sign but not when to return." });
    else if (immediate && unattributedDelays.length) generic.push(line);
    else out.push({ category: "missing", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: "", explanation: "The answer does not mention this warning sign." });
  }
  if (generic.length) out.push({ category: "changed", sourceLineIds: generic.map(l => l.id), expectedQuote: expected(generic[0], "Bumalik agad"), responseQuote: unattributedDelays[0].text, explanation: `The answer applies a waiting period (“${unattributedDelays[0].text}”) to warnings that need an immediate return.` });
  return out;
}
function followupFindings(v: View, line: SheetLine): Finding[] {
  const iso = line.fact.date.match(/(\d{4})-(\d{2})-(\d{2})/), want = iso ? { month: Number(iso[2]), day: Number(iso[3]) } : null;
  const dates = [
    ...[...v.normalized.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)].map(m => ({ month: Number(m[2]), day: Number(m[3]), at: m.index!, len: m[0].length })),
    ...[...v.normalized.matchAll(new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})\\b`, "g"))].map(m => ({ month: MONTHS[m[1]], day: Number(m[2]), at: m.index!, len: m[0].length })),
    ...[...v.normalized.matchAll(new RegExp(`\\b(?:ika-?)?(\\d{1,2})\\s+(?:ng\\s+|of\\s+)?(${MONTH})\\b`, "g"))].map(m => ({ month: MONTHS[m[2]], day: Number(m[1]), at: m.index!, len: m[0].length })),
  ];
  if (want && dates.length) {
    if (dates.some(d => d.month === want.month && d.day === want.day)) return [];
    return [{ category: "changed", sourceLineIds: [line.id], expectedQuote: expected(line, line.fact.date), responseQuote: quote(v, dates[0].at, dates[0].at + dates[0].len), explanation: `The answer gives a different follow-up date; the approved line says ${line.fact.date}.` }];
  }
  const relative = first(v, /\b(?:bukas|tomorrow|sa makalawa|next week|sa susunod na linggo|sa (?:1|isang) linggo|after \d+ days?|pagkatapos ng \d+ (?:araw|linggo))\b/, m => m[0]);
  if (relative) return [{ category: "unclear", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: relative.text, explanation: "The answer gives a relative day; the reviewer confirms it matches the approved date." }];
  return [{ category: "missing", sourceLineIds: [line.id], expectedQuote: expected(line), responseQuote: "", explanation: "The answer does not mention the follow-up visit." }];
}
/** Compares a teach-back answer with the approved lines for one question. Every quote is an exact substring of its source. */
export function compareAnswer(lines: SheetLine[], transcript: string): Finding[] {
  const v = view(transcript);
  if (!v.spans.length) return lines.length ? [{ category: "missing", sourceLineIds: lines.map(l => l.id), expectedQuote: expected(lines[0]), responseQuote: "", explanation: "No answer was recorded." }] : [];
  const meds = lines.filter(l => l.fact.kind === "medication"), negations = lines.filter(l => l.fact.kind === "negation" && l.fact.negated);
  const drugTerms = (except: SheetLine) => [...meds.filter(m => m !== except).map(m => m.fact.medicine.split(/\s+/)[0]), ...negations.flatMap(n => contentWords(n.fact.action))];
  return [
    ...meds.flatMap(l => medicationFindings(v, l, drugTerms(l), meds.length === 1)),
    ...lines.filter(l => l.fact.kind === "negation").flatMap(l => negationFindings(v, l)),
    ...(lines.some(l => l.fact.kind === "warning") ? warningFindings(v, lines.filter(l => l.fact.kind === "warning")) : []),
    ...lines.filter(l => l.fact.kind === "followup").flatMap(l => followupFindings(v, l)),
  ];
}
export const factKindsFor: Record<string, Fact["kind"][]> = { medicine: ["medication", "negation"], warning: ["warning"], followup: ["followup"] };
