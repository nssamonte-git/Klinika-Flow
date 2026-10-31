import { describe, expect, it } from "vitest";
import { compareAnswer, factKindsFor, numeralize, parseInstruction } from "../src/domain/taglish";
import { templateSheet } from "../src/domain/render";
import { getCase } from "../src/domain/cases";
import { normalize } from "../src/domain/workflow";
import { scoreRuleCheck, teachBackAnswers } from "../eval/teach-back-answers";

const linesFor = (caseId: string, questionId: string) => templateSheet(getCase(caseId)!.claims).filter(l => factKindsFor[questionId].includes(l.fact.kind));

describe("Taglish number and instruction reading", () => {
  it("reads Filipino, English and Spanish-derived numbers", () => {
    expect(numeralize("limang daan, dalawang daan at limampu, dalawampu't lima, apat na raan")).toBe("500 250 25 400");
    expect(numeralize("tres beses, isang linggo, twice")).toBe("3 beses 1 linggo 2 times");
  });
  it("parses dose, count, frequency, duration, meal and urgency", () => {
    expect(parseInstruction("Paracetamol limang daan mg, isang tableta, tatlong beses sa isang araw, pagkatapos kumain, sa loob ng tatlong araw")).toMatchObject({ doseMg: 500, count: 1, timesPerDay: 3, durationDays: 3, meal: "after" });
    expect(parseInstruction("kada anim na oras").timesPerDay).toBe(4);
    expect(parseInstruction("sa umaga at gabi").timesPerDay).toBe(2);
    expect(parseInstruction("bumalik agad").urgency).toEqual({ kind: "immediate" });
    expect(parseInstruction("maghihintay muna ako ng dalawang araw").urgency).toEqual({ kind: "delayed", days: 2 });
    expect(parseInstruction("Huwag uminom ng antibiotic").negated).toBe(true);
    expect(parseInstruction("Bumalik agad kung hindi bumababa ang lagnat").negated).toBe(false);
  });
  it("keeps existing grounding phrases and adds numeral-based ones", () => {
    expect(normalize("Paracetamol limang daan mg, tatlong beses sa isang araw")).toBe("paracetamol 500 mg 3 times daily");
    expect(normalize("dalawang beses sa isang araw, kada anim na oras")).toBe("2 times daily every 6 hours");
  });
});

describe("rule check against approved lines", () => {
  it("flags the case-01 planted delay with exact quotes from both sides", () => {
    const lines = linesFor("case-01", "warning"), transcript = "Babalik ako pagkatapos ng tatlong araw kung may babala.";
    const [finding] = compareAnswer(lines, transcript);
    expect(finding).toMatchObject({ category: "changed", sourceLineIds: lines.map(l => l.id), responseQuote: "pagkatapos ng tatlong araw" });
    expect(lines.some(l => l.text.includes(finding.expectedQuote))).toBe(true);
    expect(transcript.includes(finding.responseQuote)).toBe(true);
  });
  it("flags the bantay planning ibuprofen when the sheet says huwag", () => {
    const c = getCase("case-04")!, transcript = c.plantedAnswers!.medicine.transcript;
    const findings = compareAnswer(linesFor("case-04", "medicine"), transcript);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: "changed", expectedQuote: "Huwag uminom ng ibuprofen o aspirin.", responseQuote: "ibuprofen ang ibibigay ko" });
  });
  it("accepts the approved wording itself for every question of every case", () => {
    for (const c of ["case-01", "case-02", "case-03", "case-04"]) for (const q of ["medicine", "warning", "followup"]) {
      const lines = linesFor(c, q); if (!lines.length) continue;
      expect(compareAnswer(lines, lines.map(l => l.text).join(" ")), `${c}/${q}`).toEqual([]);
    }
  });
  it("reports a missing warning and an unclear one without inventing contradictions", () => {
    const findings = compareAnswer(linesFor("case-01", "warning"), "Kung hirap huminga, babalik po ako.");
    expect(findings.map(f => f.category).sort()).toEqual(["missing", "unclear"]);
  });
  it("matches the labelled synthetic development corpus", () => {
    const score = scoreRuleCheck();
    expect(score.samples).toBe(teachBackAnswers.length);
    expect(score.incorrect).toEqual([]);
    expect(score.falseAlarms).toBe(0);
  });
});
