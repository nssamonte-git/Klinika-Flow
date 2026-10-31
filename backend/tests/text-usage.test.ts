import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseTextUsage } from "../src/domain/text-usage";
import { generateNote } from "../src/server/meta";
import { cases } from "../src/domain/cases";
import { closeDb, db, modelUsageSummary } from "../src/server/db";
beforeEach(() => { closeDb(); vi.stubEnv("DATABASE_PATH", ":memory:"); vi.stubEnv("MODEL_API_KEY", "mock-key"); });
afterEach(() => { closeDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each([0, 40, 100])("prices cached input correctly for %s tokens", cached => { const u = parseTextUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: cached } }, false); expect(u.valid).toBe(true); expect(u.uncachedTokens).toBe(100 - cached); expect(u.costUsd).toBeCloseTo(((100-cached)*1.25+cached*0.15+20*4.25)/1e6); });
it("keeps missing cached usage unknown with a labelled undiscounted estimate", async () => { const u = parseTextUsage({ input_tokens: 100, output_tokens: 20 }, true); expect(u.cachedTokens).toBeNull(); expect(u.uncachedTokens).toBeNull(); expect(u.costBasis).toBe("cache-unknown-estimate"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: cases[0].claims }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } })))); const result = await generateNote(cases[0].turns); expect(result.costBasis).toBe("cache-unknown-estimate"); const summary = modelUsageSummary(); expect(summary.actualUsd).toBe(0); expect(summary.text.coverage).toBe(0); expect(summary.text.undiscountedEstimateUsd).toBeGreaterThan(0); });
it.each([-1, 1.2, 101, null, "10"])("rejects malformed cached counts %s", cached_tokens => { expect(parseTextUsage({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens } }, true).valid).toBe(false); });
it("records measured charges even when output fails schema validation", async () => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } })))); await expect(generateNote(cases[0].turns)).rejects.toThrow(/invalid structure/); expect(modelUsageSummary().actualUsd).toBeGreaterThan(0); const row = JSON.parse(String(db().prepare("SELECT metadata FROM text_calls").get()?.metadata)); expect(row.status).toBe("invalid-output"); expect(row.requestHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(row)).not.toContain("Paracetamol"); expect(JSON.stringify(row)).not.toContain("mock-key"); });
it("records network failure with unknown usage and no automatic retry", async () => { const fetch = vi.fn().mockRejectedValue(new Error("secret provider error")); vi.stubGlobal("fetch", fetch); await expect(generateNote(cases[0].turns)).rejects.toThrow(/network failed/); expect(fetch).toHaveBeenCalledTimes(1); expect(modelUsageSummary().text.cacheUnknownCalls).toBe(1); expect(modelUsageSummary().text.groups[0].completedCalls).toBe(0); });
it("backs up v3 databases and preserves old usage without fabricating token counts", async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "klinikaflow-token-migration-"));
  try {
    vi.stubEnv("DATABASE_PATH", join(directory, "history.sqlite"));
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(join(directory, "history.sqlite"));
    old.exec("CREATE TABLE reservations (id TEXT PRIMARY KEY,purpose TEXT NOT NULL,reserved REAL NOT NULL,actual REAL,created INTEGER NOT NULL); INSERT INTO reservations VALUES('old-usage','note',0.5,0.1,1234); PRAGMA user_version=3"); old.close();
    expect(db().prepare("PRAGMA user_version").get()?.user_version).toBe(6); expect(db().prepare("SELECT * FROM reservations WHERE id='old-usage'").get()).toMatchObject({ reserved: 0.5, actual: 0.1, created: 1234 });
    expect(modelUsageSummary().text).toMatchObject({ calls: 0, coverage: null, historicalOrNonTextRecords: 1 }); expect(readdirSync(directory).filter(name => name.includes(".backup-"))).toHaveLength(1);
  } finally { closeDb(); rmSync(directory, { recursive: true, force: true }); }
});
