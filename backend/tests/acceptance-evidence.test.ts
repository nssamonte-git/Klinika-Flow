import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { snapshotEvidence, compareEvidence } from "../src/server/acceptance-evidence";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "klinikaflow-evidence-")); folders.push(folder);
  const path = join(folder, "fixture.sqlite"), db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=5;
    CREATE TABLE workspaces(id TEXT,user_id TEXT);
    CREATE TABLE encounters(id TEXT,owner TEXT,version INTEGER,body TEXT);
    CREATE TABLE reservations(id TEXT,purpose TEXT,created INTEGER,reserved REAL,actual REAL,user_id TEXT);
    CREATE TABLE text_calls(reservation TEXT,metadata TEXT);
    CREATE TABLE users(id TEXT,email TEXT,password TEXT);
    INSERT INTO workspaces VALUES('workspace-a','account-a'),('workspace-b','account-b'),('legacy',NULL);
    INSERT INTO encounters VALUES('case-a','workspace-a',1,'private transcript'),('case-b','workspace-b',1,'other private text'),('case-legacy','legacy',1,'legacy');
    INSERT INTO users VALUES('account-a','secret@example.test','password-never-export');`);
  const add = (id: string, purpose: string, actual: number | null, text?: object, user = "account-a") => {
    db.prepare("INSERT INTO reservations VALUES(?,?,?,0.1,?,?)").run(id, purpose, Date.now(), actual, user);
    if (text) db.prepare("INSERT INTO text_calls VALUES(?,?)").run(id, JSON.stringify(text));
  };
  return { db, path, add };
}
function metadata(costBasis = "measured-tokens", costUsd = 0.02) {
  return { model: "muse-spark-1.3", operation: "note", promptVersion: "klinikaflow-core@1", profile: "legacy", status: "completed", latencyMs: 45, pricingVersion: "2026-10-29",
    usage: { valid: true, costBasis, costUsd, inputTokens: 10, cachedTokens: 0, outputTokens: 5 }, transcript: "never export private words", apiKey: "secret-key", endpoint: "https://secret-key@example.test" };
}

it("reads only the owning account's usage, leaves the database bytes unchanged and exports an allowlist", () => {
  const { db, path, add } = fixture(); add("reservation-a", "note", 0.02, metadata()); add("reservation-b", "note", 9, metadata(), "account-b"); db.close();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network allowed"); }));
  const bytes = readFileSync(path), snapshot = snapshotEvidence(path, "case-a");
  expect(snapshot.reservations.map(r => r.id)).toEqual(["reservation-a"]);
  expect(readFileSync(path)).toEqual(bytes); expect(fetch).not.toHaveBeenCalled();
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["private transcript", "other private text", "secret@example.test", "password-never-export", "secret-key", "never export private words", "endpoint"]) expect(serialized).not.toContain(secret);
});

it("separates measured cost, estimates, voice unknowns and failed attempts without paid calls", () => {
  const { db, path, add } = fixture(); add("historical", "note", 0.5, metadata());
  const before = snapshotEvidence(path, "case-a");
  add("measured", "note", 0.02, metadata()); add("cache-unknown", "note", null, metadata("cache-unknown-estimate", 0.03));
  add("voice", "transcription", null);
  add("failed", "note", null, { ...metadata(), status: "network-error", usage: undefined });
  const after = snapshotEvidence(path, "case-a"); db.close();
  const report = compareEvidence(before, after, "exclusive");
  expect(report.attempts).toBe(4); expect(report.attribution).toMatch(/operator attests/);
  expect(report.groups.find(g => g.operation === "note")).toMatchObject({ attempts: 3, completedTextCalls: 2, calculatedTextUsd: 0.02, cacheUnknownTextEstimateUsd: 0.03, recordedCalculatedUsd: 0.02, unknownChargeAttempts: 2, measuredTextLatenciesMs: [45, 45, 45] });
  expect(report.groups.find(g => g.operation === "transcription")).toMatchObject({ attempts: 1, unknownChargeAttempts: 1, voiceAttemptsWithoutBilledUsage: 1, measuredTextLatenciesMs: [] });
  expect(report.newReservationIds).not.toContain("historical");
  expect(compareEvidence(before, after).attribution).toBe("inconclusive");
  expect(compareEvidence(before, after, "concurrent").attribution).toBe("inconclusive");
});

it("flags changed or in-flight historical calls instead of silently attributing them", () => {
  const { db, path, add } = fixture(); add("pending", "note", null, { ...metadata(), status: "started" });
  const before = snapshotEvidence(path, "case-a"); db.prepare("UPDATE reservations SET actual=0.02").run();
  const after = snapshotEvidence(path, "case-a"); db.close();
  expect(compareEvidence(before, after, "exclusive")).toMatchObject({ attempts: 0, attribution: "inconclusive", changedExistingReservationIds: ["pending"] });
});

it("rejects mismatched, reversed, duplicate, missing and content-bearing snapshot inputs", () => {
  const { db, path, add } = fixture(); add("historical", "note", null);
  const before = snapshotEvidence(path, "case-a"), other = snapshotEvidence(path, "case-b"); db.close();
  expect(() => compareEvidence(before, other)).toThrow(/same database/);
  expect(() => compareEvidence(before, { ...before, databaseIdentity: "a".repeat(64) })).toThrow(/same database/);
  expect(() => compareEvidence(before, { ...before, at: "2000-01-01T00:00:00.000Z" })).toThrow(/out of order/);
  expect(() => compareEvidence(before, { ...before, reservations: [] })).toThrow(/disappeared/);
  expect(() => compareEvidence(before, { ...before, reservations: [...before.reservations, ...before.reservations] })).toThrow(/Duplicate/);
  expect(() => compareEvidence(before, { ...before, transcript: "private" })).toThrow();
});

it("rejects unknown and legacy encounters and never creates or migrates a database", () => {
  const { db, path } = fixture();
  expect(() => snapshotEvidence(path, "case-legacy")).toThrow(/account-owned/);
  expect(() => snapshotEvidence(path, "missing")).toThrow(/account-owned/);
  db.exec("PRAGMA user_version=4"); db.close(); const bytes = readFileSync(path);
  expect(() => snapshotEvidence(path, "case-a")).toThrow(/schema-v5/); expect(readFileSync(path)).toEqual(bytes);
  expect(() => snapshotEvidence(join(path, "missing"), "case-a")).toThrow();
});

it("runs the CLI snapshot/compare end to end, writes private files, and refuses overwrite or out-of-folder output", () => {
  const { db, path } = fixture(); db.close();
  const cwd = join(path, ".."), script = resolve("backend/scripts/acceptance-evidence.ts"), loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", loader, script, ...args], { cwd, env: { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_PATH: path, META_REQUEST_PROFILE: "legacy" }, encoding: "utf8" });
  const before = "backend/eval/runs/before.json", after = "backend/eval/runs/after.json", comparison = "backend/eval/runs/comparison.json";
  expect(run("snapshot", "--encounter", "case-a", "--out", before).status).toBe(0);
  expect(run("snapshot", "--encounter", "case-a", "--out", after).status).toBe(0);
  expect(run("compare", "--before", before, "--after", after, "--activity", "exclusive", "--out", comparison).status).toBe(0);
  expect(JSON.parse(readFileSync(join(cwd, comparison), "utf8"))).toMatchObject({ attempts: 0, attribution: "account interval; operator attests exclusive activity" });
  expect(statSync(join(cwd, before)).mode & 0o777).toBe(0o600);
  const bytes = readFileSync(join(cwd, before));
  expect(run("snapshot", "--encounter", "case-a", "--out", before).status).toBe(1);
  expect(readFileSync(join(cwd, before))).toEqual(bytes);
  expect(run("snapshot", "--encounter", "case-a", "--out", "elsewhere.json").status).toBe(1);
  const failed = run("snapshot", "--encounter", "private-invalid@example.test", "--out", "backend/eval/runs/invalid.json");
  expect(failed.status).toBe(1); expect(failed.stderr).not.toContain("private-invalid@example.test");
}, 20_000); // Spawns several tsx processes; slow machines exceed the 5s default.
