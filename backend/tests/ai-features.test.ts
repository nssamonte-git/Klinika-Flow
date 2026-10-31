import { createStudio } from "./account-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cases } from "../src/domain/cases";
import { templateSheet } from "../src/domain/render";
import { approveNote, approveSheet, createEncounter, exportReasons, invalidate, makeTeachBack, noteFingerprint, runChecks, savedNote, savedReview, sheetFingerprint } from "../src/domain/workflow";
import { act } from "../src/server/actions";
import { closeDb, createSession, insertEncounter, loadEncounter, loadTeachBackAudio, saveEncounter, saveTeachBackAudio } from "../src/server/db";
import { dismissReviewFinding, verifyCorrectionProposal, verifyReviewFindings, verifyTeachBackFindings } from "../src/server/review";

beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => { closeDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function note() { const e = createEncounter("e1", "case-01"); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); return runChecks(e); }
function sheet() { const e = approveNote(note(), "Demo", true); e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet"); return runChecks(e); }
const warningFinding = { category: "warning" as const, sourceIds: ["t3"], targetId: "c2", sourceQuote: "Bumalik agad", targetQuote: "Return immediately", explanation: "Check immediate timing." };

describe("source-linked model review", () => {
  it("requires a cited and reviewer-accepted correction, then clears dependent approvals", async () => {
    const owner = createStudio(), e = note();
    const claim = e.claims.find(c => c.id === "c2")!; claim.fact.urgency = "scheduled"; claim.fact.delayDays = 3;
    e.noteReview = { status: "live", fingerprint: noteFingerprint(e), findings: [{ id: "finding-c2", category: "warning", sourceIds: ["t3"], targetId: "c2", sourceQuote: "Bumalik agad", targetQuote: "", explanation: "Immediate timing was delayed." }], model: "muse-spark-1.3", promptVersion: "test", latencyMs: 5, costUsd: 0.001 };
    insertEncounter(owner.id, e);
    const corrected = structuredClone(claim.fact); corrected.urgency = "immediate"; corrected.delayDays = 0;
    expect(() => verifyCorrectionProposal(e, claim, "fabricated quote", corrected)).toThrow(/unsupported clinician evidence/);
    vi.stubEnv("ALLOW_LIVE_MODE", "true"); vi.stubEnv("MODEL_API_KEY", "test-model-key"); vi.stubEnv("ENABLE_NOTE_CORRECTIONS", "true");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sourceQuote: "Bumalik agad", correctedFact: corrected, explanation: "Restore immediate timing from the cited turn." }) } }], usage: { prompt_tokens_details: { cached_tokens: 0 }, prompt_tokens: 50, completion_tokens: 20 } }))));
    const proposed = await act(owner, e.id, "proposal-c2", { action: "propose-note-correction", expectedVersion: e.version, findingId: "finding-c2" });
    expect(proposed.claims.find(c => c.id === "c2")?.fact.urgency).toBe("scheduled");
    const accepted = await act(owner, e.id, "accept-c2", { action: "accept-note-proposal", expectedVersion: proposed.version, proposalId: proposed.noteProposals![0].id, reviewer: "DR", confirmed: true });
    expect(accepted.claims.find(c => c.id === "c2")?.fact.urgency).toBe("immediate");
    expect(accepted.noteReview).toBeNull(); expect(accepted.noteApproval).toBeNull();
    expect(accepted.noteProposals![0].status).toBe("accepted");
  });
  it("requires a disposition for every model finding", () => {
    const e = note(), finding = verifyReviewFindings("note", [warningFinding], e.turns, e.claims, e.lines)[0];
    e.noteReview = { status: "live", fingerprint: noteFingerprint(e), findings: [finding], model: "muse-spark-1.3", promptVersion: "test", latencyMs: 10, costUsd: 0.01 };
    expect(() => approveNote(e, "Demo", true)).toThrow(/discrepancy review/);
    e.noteReview = dismissReviewFinding(e.noteReview, finding.id, "DR", "Checked the cited audio and immediate timing.");
    expect(approveNote(e, "Demo", true).noteApproval).not.toBeNull();
  });
  it("rejects invented source IDs, target IDs, and quotes", () => {
    const e = note();
    expect(() => verifyReviewFindings("note", [{ ...warningFinding, sourceIds: ["made-up"] }], e.turns, e.claims, e.lines)).toThrow(/source evidence/);
    expect(() => verifyReviewFindings("note", [{ ...warningFinding, targetId: "made-up" }], e.turns, e.claims, e.lines)).toThrow(/target evidence/);
    expect(() => verifyReviewFindings("note", [{ ...warningFinding, sourceQuote: "after three days" }], e.turns, e.claims, e.lines)).toThrow(/source evidence/);
  });
  it("validates sheet citations and invalidates both stages after content changes", () => {
    const e = sheet(), line = e.lines.find(l => l.sourceClaimIds.includes("c2"))!;
    const finding = verifyReviewFindings("sheet", [{ category: "warning", sourceIds: ["c2"], targetId: line.id, sourceQuote: "Return immediately", targetQuote: line.text.slice(0, 10), explanation: "Check timing." }], e.turns, e.claims, e.lines);
    e.sheetReview = { status: "live", fingerprint: sheetFingerprint(e), findings: finding, model: "muse-spark-1.3", promptVersion: "test", latencyMs: 10, costUsd: 0.01 };
    expect(() => approveSheet(e, "Demo", true)).toThrow(/discrepancy review/);
    const changed = invalidate(e, "sheet"); expect(changed.noteReview).not.toBeNull(); expect(changed.sheetReview).toBeNull();
    const upstream = invalidate(e, "note"); expect(upstream.noteReview).toBeNull(); expect(upstream.sheetReview).toBeNull();
  });
  it("blocks stale reviews even if an edit bypasses invalidation", () => {
    const e = note(); e.turns[1].text += " changed";
    expect(() => approveNote(e, "Demo", true)).toThrow();
  });
  it("does not duplicate a successful studio review request", async () => {
    const owner = createStudio(), e = note(); e.noteReview = null; insertEncounter(owner.id, e);
    vi.stubEnv("ALLOW_LIVE_MODE", "true"); vi.stubEnv("MODEL_API_KEY", "test-model-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }], usage: { prompt_tokens_details: { cached_tokens: 0 }, prompt_tokens: 50, completion_tokens: 10 } })));
    vi.stubGlobal("fetch", fetchMock);
    const input = { action: "run-note-review" as const, expectedVersion: e.version };
    const first = await act(owner, e.id, "review-live-01", input);
    const repeated = await act(owner, e.id, "review-live-01", input);
    expect(repeated).toEqual(first); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.noteReview?.status).toBe("live");
  });
});

describe("teach-back evidence", () => {
  it("does not give studio reference encounters seeded review or answer passes", async () => {
    const owner = createStudio(), e = note(); insertEncounter(owner.id, e);
    const confirmed = await act(owner, e.id, "studio-confirm-01", { action: "confirm-transcript", expectedVersion: e.version, reviewer: "DR", confirmed: true });
    const generated = await act(owner, e.id, "studio-note-01", { action: "generate-note", expectedVersion: confirmed.version });
    expect(generated.noteReview).toBeNull();
    const approved = approveSheet(sheet(), "Demo", true); approved.id = "studio-approved"; insertEncounter(owner.id, approved);
    const answers = await act(owner, approved.id, "studio-teach-01", { action: "teach-back", expectedVersion: approved.version });
    expect(answers.teachBack.every(q => q.analysis === null && q.outcome === "pending")).toBe(true);
    const rebuilt = await act(owner, approved.id, "studio-sheet-01", { action: "generate-sheet", expectedVersion: answers.version });
    expect(rebuilt.sheetReview).toBeNull();
  });
  it("rejects untraced analysis and keeps outcomes human-controlled", () => {
    const e = approveSheet(sheet(), "Demo", true), q = makeTeachBack(e).find(t => t.id === "warning")!;
    const lines = e.lines.filter(l => l.fact.kind === "warning");
    expect(() => verifyTeachBackFindings([{ category: "changed", sourceLineIds: ["fake"], expectedQuote: lines[0].text, responseQuote: "three days", explanation: "Timing changed" }], lines, "after three days")).toThrow(/sheet evidence/);
    expect(q.outcome).toBe("pending");
    expect(q.analysis?.status).toBe("saved");
    expect(q.analysis?.findings[0].responseQuote).toBe("pagkatapos ng tatlong araw");
  });
  it("isolates answer audio and removes it after sheet invalidation", () => {
    const a = createStudio(), b = createStudio(), e = approveSheet(sheet(), "Demo", true);
    e.teachBack = makeTeachBack(e); insertEncounter(a.id, e);
    const updated = structuredClone(e); updated.version++; updated.teachBack[0].audioAvailable = true;
    saveTeachBackAudio(a.id, e.version, updated, updated.teachBack[0].id, sheetFingerprint(updated), Buffer.from("synthetic"));
    expect(loadTeachBackAudio(a.id, e.id, updated.teachBack[0].id, sheetFingerprint(updated))?.toString()).toBe("synthetic");
    expect(loadTeachBackAudio(b.id, e.id, updated.teachBack[0].id, sheetFingerprint(updated))).toBeNull();
    const changed = invalidate(updated, "sheet"); changed.version++;
    saveEncounter(a.id, updated.version, changed);
    expect(loadTeachBackAudio(a.id, e.id, updated.teachBack[0].id, sheetFingerprint(updated))).toBeNull();
  });
  it("finishes a saved judge flow through documented manual review", async () => {
    const owner = createSession(), e = note(); e.noteReview = null; insertEncounter(owner.id, e);
    const manual = await act(owner, e.id, "manual-001", { action: "manual-review", expectedVersion: e.version, stage: "note", reviewer: "DR", reason: "Model unavailable; checked synthetic source." });
    const approvedNote = await act(owner, e.id, "approve-001", { action: "approve-note", expectedVersion: manual.version, reviewer: "DR", confirmed: true });
    const withSheet = await act(owner, e.id, "sheet-001", { action: "generate-sheet", expectedVersion: approvedNote.version });
    const approvedSheet = await act(owner, e.id, "approve-002", { action: "approve-sheet", expectedVersion: withSheet.version, reviewer: "DR", confirmed: true });
    const withQuestions = await act(owner, e.id, "teach-001", { action: "teach-back", expectedVersion: approvedSheet.version });
    const outcomes = Object.fromEntries(withQuestions.teachBack.map(q => [q.id, "understood"])) as Record<string, "understood">;
    const final = await act(owner, e.id, "outcome-001", { action: "record-teach-back", expectedVersion: withQuestions.version, outcomes, reviewer: "DR", overrideReasons: { warning: "Synthetic QA override of planted answer" } });
    expect(exportReasons(final)).toEqual([]);
    expect(final.noteReview?.status).toBe("manual");
    expect(final.teachBack.every(q => q.analysis?.status === "saved")).toBe(true);
    expect(loadEncounter(owner.id, e.id).version).toBe(final.version);
  });
  it("preserves review work on a failed call and makes the same request key idempotent", async () => {
    const owner = createStudio(), e = note(); e.noteReview = null; insertEncounter(owner.id, e);
    vi.stubEnv("MODEL_API_KEY", ""); vi.stubEnv("ALLOW_LIVE_MODE", "true"); 
    const input = { action: "run-note-review" as const, expectedVersion: e.version };
    await expect(act(owner, e.id, "review-0001", input)).rejects.toThrow(/not configured/);
    expect(loadEncounter(owner.id, e.id).claims).toEqual(e.claims);
    expect(loadEncounter(owner.id, e.id).version).toBe(e.version);
    await expect(act(owner, e.id, "review-0001", input)).rejects.toThrow(/attempt failed/);
    const manual = await act(owner, e.id, "manual-0002", { action: "manual-review", expectedVersion: e.version, stage: "note", reviewer: "DR", reason: "Provider unavailable; checked each source." });
    expect(manual.noteReview?.status).toBe("manual");
  });
  it("keeps current model findings when manual fallback is requested", async () => {
    const owner = createStudio(), e = note(), finding = verifyReviewFindings("note", [warningFinding], e.turns, e.claims, e.lines)[0];
    e.noteReview = { status: "live", fingerprint: noteFingerprint(e), findings: [finding], model: "muse-spark-1.3", promptVersion: "test", latencyMs: 10, costUsd: 0.01 };
    insertEncounter(owner.id, e);
    await expect(act(owner, e.id, "manual-0003", { action: "manual-review", expectedVersion: e.version, stage: "note", reviewer: "DR", reason: "Checked all synthetic sources." })).rejects.toThrow(/cannot erase/);
    expect(loadEncounter(owner.id, e.id).noteReview?.findings).toHaveLength(1);
  });
  it("does not reset teach-back answers when the start action is repeated", async () => {
    const owner = createSession(), e = approveSheet(sheet(), "Demo", true); insertEncounter(owner.id, e);
    const started = await act(owner, e.id, "teach-0001", { action: "teach-back", expectedVersion: e.version });
    const recorded = await act(owner, e.id, "outcome-0001", { action: "record-teach-back", expectedVersion: started.version, outcomes: { warning: "reexplained" }, reviewer: "DR" });
    const repeated = await act(owner, e.id, "teach-0002", { action: "teach-back", expectedVersion: recorded.version });
    expect(repeated.teachBack.find(q => q.id === "warning")?.outcome).toBe("reexplained");
  });
});
