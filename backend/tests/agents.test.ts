import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStudio } from "./account-fixture";
import { agentCommand, getAgentView } from "../src/server/agent";
import { AgentPlanSchema, type AgentCommand, type AgentPlan } from "../src/domain/agent-contract";
import { agentCapabilities, reviewerHandoff, validateAgentPlan } from "../src/domain/agent-policy";
import { act } from "../src/server/actions";
import { closeDb, createSession, db, insertEncounter, loadEncounter, saveEncounter } from "../src/server/db";
import { approveNote, approveSheet, createEncounter, exportReasons, fingerprint, makeTeachBack, noteFingerprint, projectAttempt, runChecks, savedNote, savedReview, sheetFingerprint, transcriptFingerprint } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import type { WorkspaceSession } from "../src/server/auth-core";

beforeEach(() => { closeDb(); vi.stubEnv("DATABASE_PATH", ":memory:"); vi.stubEnv("ALLOW_LIVE_MODE", "true"); vi.stubEnv("ENABLE_AGENT_REVIEW", "true"); vi.stubEnv("MODEL_API_KEY", "synthetic-test-key"); vi.stubEnv("ENABLE_NOTE_CORRECTIONS", "false"); });
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function ready() {
  let e = createEncounter("agent-case", "case-01"); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); e = approveNote(runChecks(e), "Synthetic QA", true);
  e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet"); e = approveSheet(runChecks(e), "Synthetic QA", true); e.teachBack = makeTeachBack(e);
  e.teachBack.forEach(projectAttempt); return e;
}
let sequence = 0;
async function command(owner: WorkspaceSession, body: Omit<AgentCommand, "expectedVersion">, key = `agent-request-${++sequence}`) {
  return agentCommand(owner, "agent-case", key, { ...body, expectedVersion: loadEncounter(owner.id, "agent-case").version });
}
async function start(owner: WorkspaceSession, mode: "teach_back" | "source_review" = "teach_back") { return (await command(owner, { command: "start", mode, ...(mode === "teach_back" ? { questionId: "warning" } : {}) })).runs[0]; }
function response(data: unknown) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } })); }
function provider(plan: AgentPlan) { const fetch = vi.fn().mockImplementation(async () => response(plan)); vi.stubGlobal("fetch", fetch); return fetch; }

describe("agent policies and read-only handoff", () => {
  it("rejects invented tools, targets, citations, duplicate IDs and incompatible reasons", () => {
    const e = ready(), caps = agentCapabilities(e, "teach_back", "warning", false, true), exact = caps.find(c => c.tool === "approved_lines")!;
    const p = { tool: exact.tool, targetId: exact.targetId, sourceIds: exact.sourceIds, reason: "changed_or_missing" };
    expect(validateAgentPlan(p, caps)).toEqual(p);
    for (const change of [{ tool: "approve-note" }, { targetId: "invented" }, { sourceIds: ["fake"] }, { sourceIds: [...exact.sourceIds, exact.sourceIds[0]] }, { reason: "supported_correction" }]) expect(() => validateAgentPlan({ ...p, ...change }, caps)).toThrow();
    expect(() => AgentPlanSchema.parse({ ...p, reasoning: "Do not store model reasoning" })).toThrow();
    expect(agentCapabilities(e, "teach_back", "warning", false, false).some(c => c.tool === "propose_correction")).toBe(false);
  });
  it("projects exact lines, all unresolved checks, manual provenance and old attempts without mutating", () => {
    const e = ready(); e.sheetReview!.status = "manual"; e.sheetReview!.reviewer = "Actual reviewer";
    const copy = structuredClone(e), handoff = reviewerHandoff(e);
    expect(e).toEqual(copy); expect(handoff.instructions.map(l => l.text)).toEqual(e.lines.map(l => l.text));
    expect(handoff.reviews.find(r => r.stage === "sheet")).toMatchObject({ status: "manual", current: true });
    expect(handoff.answers.find(q => q.id === "warning")?.attempts[0].reviewer).toBeNull();
    expect(handoff.nextCheckpoints.join()).toMatch(/understanding/);
  });
});

describe("Saved Demo agents", () => {
  it("walks the wrong warning through exact evidence and repeat recommendation without inference or approval", async () => {
    const owner = createSession(), e = ready(); insertEncounter(owner.id, e);
    const fetch = vi.fn(() => { throw new Error("No inference in Saved Demo"); }); vi.stubGlobal("fetch", fetch);
    let run = await start(owner);
    run = (await command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision })).runs[0];
    expect(run.events.at(-1)?.plan?.tool).toBe("approved_lines");
    run = (await command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId! })).runs[0];
    expect(run.events.at(-1)?.evidence?.map(l => l.text)).toEqual(e.lines.filter(l => l.fact.kind === "warning").map(l => l.text));
    run = (await command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision })).runs[0];
    expect(run.events.at(-1)?.plan?.tool).toBe("repeat_answer");
    run = (await command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId! })).runs[0];
    expect(run.status).toBe("paused"); expect(exportReasons(loadEncounter(owner.id, e.id)).join()).toMatch(/understanding/);
    await expect(command(owner, { command: "resume", runId: run.id, expectedRevision: run.revision })).rejects.toThrow(/human review/);
    let current = loadEncounter(owner.id, e.id);
    current = await act(owner, e.id, "actual-qa-reexplained", { action: "record-teach-back", expectedVersion: current.version, reviewer: "Synthetic QA", outcomes: { warning: "reexplained" } });
    expect(exportReasons(current).length).toBeGreaterThan(0);
    current = await act(owner, e.id, "actual-qa-repeat", { action: "start-teach-back-attempt", expectedVersion: current.version, questionId: "warning" });
    const linked = await start(owner); expect(linked.parentId).toBe(run.id);
    expect(getAgentView(owner, e.id).runs.find(r => r.id === run.id)?.status).toBe("stale");
    expect(current.teachBack.find(q => q.id === "warning")?.attempts).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled(); expect(db().prepare("SELECT count(*) AS n FROM reservations").get()?.n).toBe(0);
  });
  it("supports source fixtures, an unsupported claim, unclear answer, stopped and failed timelines", async () => {
    const owner = createSession(), e = ready(); insertEncounter(owner.id, e); vi.stubGlobal("fetch", vi.fn());
    let run = await start(owner, "source_review");
    run = (await command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision })).runs[0];
    await expect(command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId!, fixtureFailure: true })).rejects.toThrow(/simulated/);
    expect(getAgentView(owner, e.id).runs[0].status).toBe("failed");
    await command(owner, { command: "fixture", scenario: "unclear_answer", questionId: "warning" });
    const answer = loadEncounter(owner.id, e.id).teachBack.find(q => q.id === "warning")!;
    expect(answer.attempts).toHaveLength(2); expect(answer.analysis?.findings[0].category).toBe("unclear");
    run = await start(owner); await command(owner, { command: "stop", runId: run.id, expectedRevision: run.revision });
    await command(owner, { command: "fixture", scenario: "unsupported_claim" });
    expect(getAgentView(owner, e.id).handoff.unresolved.length).toBeGreaterThan(0);
    expect(getAgentView(owner, e.id).handoff.sheetApproved).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("live step boundaries, persistence and cost", () => {
  it("requires per-call confirmation, deduplicates replay and links the reservation before the provider request", async () => {
    const owner = createStudio(), e = ready(); insertEncounter(owner.id, e);
    const fetch = provider({ tool: "reviewer_help", targetId: "warning", sourceIds: [], reason: "human_review" });
    fetch.mockImplementation(async () => {
      const event = JSON.parse(String(db().prepare("SELECT body FROM agent_events ORDER BY rowid DESC LIMIT 1").get()?.body));
      expect(event.reservationIds).toHaveLength(1); expect(event.status).toBe("running");
      return response({ tool: "reviewer_help", targetId: "warning", sourceIds: [], reason: "human_review" });
    });
    let run = await start(owner); const input = { command: "plan" as const, runId: run.id, expectedRevision: run.revision, expectedVersion: e.version };
    await expect(agentCommand(owner, e.id, "unconfirmed-plan", input)).rejects.toThrow(/confirm/);
    const body = { ...input, confirmedPaid: true };
    run = (await agentCommand(owner, e.id, "confirmed-plan", body)).runs[0];
    await agentCommand(owner, e.id, "confirmed-plan", body); expect(fetch).toHaveBeenCalledTimes(1);
    expect(run.paidAttempts).toBe(1); expect(run.events.at(-1)?.measurements?.[0]).toMatchObject({ status: "completed", basis: "measured-tokens", calculatedUsd: expect.any(Number) });
    run = (await command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId! })).runs[0];
    expect(run.status).toBe("paused"); expect(fetch).toHaveBeenCalledTimes(1);
    expect(loadEncounter(owner.id, e.id).teachBack[0].outcome).toBe("pending");
  });
  it("executes the existing comparison service as a separately confirmed call", async () => {
    const owner = createStudio(), e = ready(), q = e.teachBack.find(q => q.id === "warning")!;
    q.analysis = null; q.attempts![0].analysis = null; insertEncounter(owner.id, e);
    const fetch = vi.fn().mockImplementationOnce(async () => response({ tool: "compare_answer", targetId: "warning", sourceIds: [], reason: "comparison_needed" })).mockImplementationOnce(async () => response({ findings: [] })); vi.stubGlobal("fetch", fetch);
    let run = await start(owner); run = (await command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true })).runs[0];
    await expect(command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId! })).rejects.toThrow(/confirm/);
    run = (await command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId!, confirmedPaid: true })).runs[0];
    expect(run.status).toBe("ready"); expect(run.paidAttempts).toBe(2); expect(fetch).toHaveBeenCalledTimes(2);
    expect(loadEncounter(owner.id, e.id).teachBack.find(q => q.id === "warning")).toMatchObject({ outcome: "pending", analysis: { status: "live" } });
  });
  it("retains sanitized failed/unknown calls and prevents implicit retry", async () => {
    const owner = createStudio(), e = ready(); insertEncounter(owner.id, e); const fetch = vi.fn().mockRejectedValue(new Error("SECRET-PROVIDER-BODY")); vi.stubGlobal("fetch", fetch);
    const run = await start(owner), input = { command: "plan" as const, runId: run.id, expectedRevision: run.revision, confirmedPaid: true, expectedVersion: e.version };
    await expect(agentCommand(owner, e.id, "failed-agent-plan", input)).rejects.toThrow(/Step failed/);
    const saved = getAgentView(owner, e.id).runs[0]; expect(saved.status).toBe("failed"); expect(saved.paidAttempts).toBe(1);
    expect(saved.events.at(-1)?.measurements?.[0].calculatedUsd).toBeNull(); expect(JSON.stringify(saved)).not.toContain("SECRET-PROVIDER-BODY");
    await expect(agentCommand(owner, e.id, "failed-agent-plan", input)).rejects.toThrow(/failed or interrupted/); expect(fetch).toHaveBeenCalledTimes(1);
    expect(loadEncounter(owner.id, e.id)).toEqual(e);
  });
  it("does not apply paid results after concurrent source edits, stop or session revocation", async () => {
    for (const mutation of ["edit", "stop", "revoke"] as const) {
      closeDb(); const owner = createStudio(), e = ready(); insertEncounter(owner.id, e); const run = await start(owner);
      let release!: (value: Response) => void; vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { release = r; })));
      const pending = command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true });
      const rejected = expect(pending).rejects.toThrow(/Step failed/);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      if (mutation === "edit") { const changed = structuredClone(e); changed.turns[0].text += " source change"; changed.version++; saveEncounter(owner.id, e.version, changed); }
      if (mutation === "stop") { const executing = getAgentView(owner, e.id).runs[0]; await command(owner, { command: "stop", runId: run.id, expectedRevision: executing.revision }); }
      if (mutation === "revoke") db().prepare("DELETE FROM account_sessions WHERE id=?").run(owner.sessionId!);
      release(response({ tool: "reviewer_help", targetId: "warning", sourceIds: [], reason: "human_review" })); await rejected;
      const saved = JSON.parse(String(db().prepare("SELECT body FROM agent_runs WHERE id=?").get(run.id)?.body));
      expect(saved.status).toBe(mutation === "edit" ? "stale" : mutation === "stop" ? "stopped" : "failed"); expect(saved.pendingStepId).toBeNull();
      expect(db().prepare("SELECT count(*) AS n FROM reservations").get()?.n).toBe(1);
    }
  });
  it("enforces ownership, the disabled flag, revision checks and per-run limits", async () => {
    const owner = createStudio(), other = createStudio(), e = ready(); insertEncounter(owner.id, e);
    expect(() => getAgentView(other, e.id)).toThrow(/not found/);
    vi.stubEnv("ENABLE_AGENT_REVIEW", "false"); await expect(start(owner)).rejects.toThrow(/disabled/);
    expect(getAgentView(owner, e.id).handoff.version).toBe(e.version);
    vi.stubEnv("ENABLE_AGENT_REVIEW", "true"); const run = await start(owner);
    await expect(start(owner)).rejects.toThrow(/active/);
    await expect(command(owner, { command: "plan", runId: run.id, expectedRevision: 99, confirmedPaid: true })).rejects.toThrow(/another tab/);
    const capped = { ...run, decisions: 6 }; db().prepare("UPDATE agent_runs SET body=? WHERE id=?").run(JSON.stringify(capped), run.id);
    await expect(command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true })).rejects.toThrow(/limit/);
  });
  it("requires confirmed source and the correction flag, then saves a proposal without accepting it", async () => {
    const owner = createStudio(), e = ready(), claim = e.claims.find(c => c.fact.kind === "warning")!;
    claim.fact.urgency = "scheduled"; claim.fact.delayDays = 3;
    e.noteApproval = null; e.sheetApproval = null;
    e.noteReview = { status: "live", fingerprint: noteFingerprint(e), findings: [{ id: "warning-finding", category: "warning", sourceIds: claim.sourceTurnIds, sourceQuote: "Bumalik agad", targetId: claim.id, targetQuote: "Return", explanation: "Synthetic timing discrepancy." }], model: "muse-spark-1.3", promptVersion: "test", latencyMs: 1, costUsd: 0.001 };
    expect(agentCapabilities(e, "source_review", null, true, false).some(c => c.tool === "propose_correction")).toBe(false);
    e.transcriptConfirmation = { fingerprint: transcriptFingerprint(e), reviewer: "Synthetic QA", at: new Date().toISOString(), recordingFingerprint: null };
    expect(agentCapabilities(e, "source_review", null, false, false).some(c => c.tool === "propose_correction")).toBe(false);
    const capability = agentCapabilities(e, "source_review", null, true, false).find(c => c.tool === "propose_correction")!;
    vi.stubEnv("ENABLE_NOTE_CORRECTIONS", "true"); insertEncounter(owner.id, e);
    const fixed = { ...claim.fact, urgency: "immediate", delayDays: 0 };
    const fetch = vi.fn().mockImplementationOnce(async () => response({ tool: capability.tool, targetId: capability.targetId, sourceIds: capability.sourceIds, reason: "supported_correction" })).mockImplementationOnce(async () => response({ sourceQuote: "Bumalik agad", correctedFact: fixed, explanation: "Restore the cited immediate timing." })); vi.stubGlobal("fetch", fetch);
    let run = await start(owner, "source_review"); run = (await command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true })).runs[0];
    run = (await command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId!, confirmedPaid: true })).runs[0];
    expect(run.status).toBe("paused"); const result = loadEncounter(owner.id, e.id);
    expect(result.claims.find(c => c.id === claim.id)?.fact.delayDays).toBe(3); expect(result.noteProposals?.[0].status).toBe("pending"); expect(result.noteApproval).toBeNull();
  });
  it("rejects an unsupported planner result and preserves a paid tool failure after session revocation", async () => {
    const owner = createStudio(), e = ready(), q = e.teachBack.find(q => q.id === "warning")!; q.analysis = null; q.attempts![0].analysis = null; insertEncounter(owner.id, e);
    provider({ tool: "approved_lines", targetId: "warning", sourceIds: ["invented"], reason: "inspect_evidence" });
    let run = await start(owner);
    await expect(command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true })).rejects.toThrow(/Step failed/);
    expect(getAgentView(owner, e.id).runs[0].status).toBe("failed");
    provider({ tool: "compare_answer", targetId: "warning", sourceIds: [], reason: "comparison_needed" });
    run = await start(owner); run = (await command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true })).runs[0];
    vi.stubGlobal("fetch", vi.fn(async () => { db().prepare("DELETE FROM account_sessions WHERE id=?").run(owner.sessionId!); return response({ findings: [] }); }));
    await expect(command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId!, confirmedPaid: true })).rejects.toThrow(/Step failed/);
    const body = JSON.parse(String(db().prepare("SELECT body FROM encounters WHERE id=?").get(e.id)?.body));
    expect(body.teachBack.find((q: any) => q.id === "warning").analysis).toBeNull();
    expect(db().prepare("SELECT count(*) AS n FROM reservations").get()?.n).toBe(3);
  });
  it("blocks concurrent planning and recovers an expired in-flight record without inference", async () => {
    const owner = createStudio(), e = ready(); insertEncounter(owner.id, e);
    const run = await start(owner), eventId = crypto.randomUUID();
    const running = { ...run, status: "executing", revision: 2, paidAttempts: 1, decisions: 1 };
    db().prepare("UPDATE agent_runs SET body=?,status='executing' WHERE id=?").run(JSON.stringify(running), run.id);
    db().prepare("INSERT INTO agent_events VALUES(?,?,?,?,?,?,?,?)").run(eventId, run.id, e.id, owner.id, "interrupted-request", "signature", JSON.stringify({ id: eventId, kind: "plan", status: "running", at: new Date().toISOString(), reservationIds: [], fixture: false }), Date.now());
    vi.stubGlobal("fetch", vi.fn());
    await expect(command(owner, { command: "plan", runId: run.id, expectedRevision: 2, confirmedPaid: true })).rejects.toThrow(/available agent step/);
    await expect(command(owner, { command: "resume", runId: run.id, expectedRevision: 2 })).rejects.toThrow(/still be running/);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 91_000);
    const recovered = (await command(owner, { command: "resume", runId: run.id, expectedRevision: 2 })).runs[0];
    expect(recovered.status).toBe("failed"); expect(recovered.events.find(e => e.id === eventId)?.status).toBe("failed"); expect(fetch).not.toHaveBeenCalled();
  });
  it("allows the same account's explicitly imported workspace without exposing it to another account", async () => {
    const legacy = createSession(), owner = createStudio(), other = createStudio(), e = ready(); insertEncounter(legacy.id, e);
    db().prepare("UPDATE workspaces SET user_id=?,kind='account' WHERE id=?").run(owner.userId!, legacy.id);
    const run = await start(owner, "source_review");
    expect(db().prepare("SELECT owner FROM agent_runs WHERE id=?").get(run.id)?.owner).toBe(legacy.id);
    expect(getAgentView(owner, e.id).runs[0].id).toBe(run.id);
    expect(() => getAgentView(other, e.id)).toThrow(/not found/);
  });
  it("keeps cache-unknown estimates separate and enforces execution and paid-attempt caps", async () => {
    const owner = createStudio(), e = ready(); insertEncounter(owner.id, e);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tool: "reviewer_help", targetId: "warning", sourceIds: [], reason: "human_review" }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))));
    let run = await start(owner); run = (await command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true })).runs[0];
    expect(run.events.at(-1)?.measurements?.[0]).toMatchObject({ calculatedUsd: null, undiscountedEstimateUsd: expect.any(Number), basis: "cache-unknown-estimate" });
    db().prepare("UPDATE agent_runs SET body=? WHERE id=?").run(JSON.stringify({ ...run, executions: 6 }), run.id);
    await expect(command(owner, { command: "execute", runId: run.id, expectedRevision: run.revision, stepId: run.pendingStepId! })).rejects.toThrow(/limit/);
    db().prepare("UPDATE agent_runs SET body=?,status='ready' WHERE id=?").run(JSON.stringify({ ...run, status: "ready", paidAttempts: 12 }), run.id);
    await expect(command(owner, { command: "plan", runId: run.id, expectedRevision: run.revision, confirmedPaid: true })).rejects.toThrow(/limit/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
