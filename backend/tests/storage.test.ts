import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "../src/server/actions";
import { beginJob, modelUsageSummary, closeDb, createSession, deleteEncounter, endJob, getSession, insertEncounter, listEncounters, loadEncounter, rateLimit, recordCost, recordEstimatedCost, saveEncounter, saveEncounterWithAudio, loadAudio } from "../src/server/db";
import { createEncounter } from "../src/domain/workflow";
beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => { closeDb(); vi.useRealTimers(); });
describe("ownership and durable state", () => {
  it("isolates encounters between sessions", () => { const a = createSession(), b = createSession(); insertEncounter(a.id, createEncounter("e1", "case-01")); expect(() => loadEncounter(b.id, "e1")).toThrow(/not found/); expect(listEncounters(b.id)).toEqual([]); });
  it("rejects unknown and malformed session tokens", () => { expect(getSession(undefined)).toBeNull(); expect(getSession("invalid")).toBeNull(); });
  it("resumes a session using its opaque cookie", () => { const a = createSession(); expect(getSession(a.token)?.id).toBe(a.id); expect(a.id).not.toBe(a.token); });
  it("rejects expired sessions", () => { vi.useFakeTimers(); const a = createSession(); vi.advanceTimersByTime(86400001); expect(getSession(a.token)).toBeNull(); });
  it("rejects stale concurrent writes", () => { const a = createSession(), e = createEncounter("e1", "case-01"); insertEncounter(a.id, e); e.version++; saveEncounter(a.id, 1, e); expect(() => saveEncounter(a.id, 1, e)).toThrow(/another tab/); });
  it("stores recording and content atomically", () => { const a = createSession(), e = createEncounter("e1", "case-01"); insertEncounter(a.id, e); e.version++; saveEncounterWithAudio(a.id, 1, e, Buffer.from("first")); expect(() => saveEncounterWithAudio(a.id, 1, e, Buffer.from("wrong"))).toThrow(); expect(loadAudio(a.id, e.id)?.toString()).toBe("first"); });
  it("deletes only the owner's encounter", () => { const a = createSession(), b = createSession(); insertEncounter(a.id, createEncounter("e1", "case-01")); expect(() => deleteEncounter(b.id, "e1")).toThrow(/not found/); expect(loadEncounter(a.id, "e1")).toBeDefined(); deleteEncounter(a.id, "e1"); expect(() => loadEncounter(a.id, "e1")).toThrow(); });
});
describe("idempotency and failed requests", () => {
  it("returns the same result without another mutation", async () => { const a = createSession(), e = createEncounter("e1", "case-01"); insertEncounter(a.id, e); const input = { action: "consent" as const, expectedVersion: 1, value: true }; const first = await act(a, "e1", "request-001", input), second = await act(a, "e1", "request-001", input); expect(first).toEqual(second); expect(loadEncounter(a.id, "e1").version).toBe(2); });
  it("rejects reuse with different content", () => { const a = createSession(); beginJob(a.id, "key", "a"); expect(() => beginJob(a.id, "key", "b")).toThrow(/different content/); });
  it("rejects duplicate in-flight generation", () => { const a = createSession(); beginJob(a.id, "key", "a"); expect(() => beginJob(a.id, "key", "a")).toThrow(/already processing/); });
  it("deduplicates equivalent requests even when a response is lost and a new key is used", () => { const a = createSession(), e = createEncounter("equivalent", "case-01"); const job = beginJob(a.id, "original-key", "same-signature"); endJob(job.id, e); expect(beginJob(a.id, "new-key", "same-signature").cached).toEqual(e); });
  it("preserves the encounter on a failed action", async () => { const a = createSession(), e = createEncounter("e1", "case-01"); insertEncounter(a.id, e); await expect(act(a, "e1", "request-001", { action: "generate-note", expectedVersion: 1, provider: "saved" })).rejects.toThrow(/synthetic/); expect(loadEncounter(a.id, e.id)).toEqual(e); });
  it("keeps a failed request explicit", () => { const a = createSession(), job = beginJob(a.id, "key", "a"); endJob(job.id); expect(() => beginJob(a.id, "key", "a")).toThrow(/failed/); });
  it("judge sessions cannot generate live calls", async () => { const a = createSession(), e = createEncounter("e1", "case-01"); e.consent = true; insertEncounter(a.id, e); await expect(act(a, "e1", "request-001", { action: "generate-note", expectedVersion: 1, provider: "live" })).rejects.toThrow(/approved account/); });
});
describe("model usage and rate limits", () => {
  it("records estimated usage without a local spending cap", () => { recordEstimatedCost("test", 0.7); recordEstimatedCost("test", 0.31); expect(modelUsageSummary()).toMatchObject({ estimatedUsd: 1.01, actualUsd: 0, unknownCalls: 2 }); });
  it("retains unknown attempts and known actual cost", () => { const id = recordEstimatedCost("test", 0.8); recordCost(id, 0.01); recordEstimatedCost("failed", 0.3); expect(modelUsageSummary()).toMatchObject({ estimatedUsd: 1.1, actualUsd: 0.01, unknownCalls: 1 }); });
  it("enforces a request window and recovers", () => { vi.useFakeTimers(); rateLimit("a", 2); rateLimit("a", 2); expect(() => rateLimit("a", 2)).toThrow(/Too many/); vi.advanceTimersByTime(60001); expect(() => rateLimit("a", 2)).not.toThrow(); });
});
