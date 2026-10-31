import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createStudio } from "./account-fixture";
import { closeDb, db, insertEncounter, recordEstimatedCost, recordCost } from "../src/server/db-core";
import { createEncounter } from "../src/domain/workflow";
import { compareEvidence, snapshotEvidence } from "../src/server/acceptance-evidence";

afterEach(() => { closeDb(); vi.unstubAllEnvs(); });
it("backs up schema v5 once, preserves all existing rows/bytes and keeps old snapshots readable", () => {
  const directory = mkdtempSync(join(tmpdir(), "klinikaflow-agent-migration-")), path = join(directory, "fixture.sqlite");
  try {
    closeDb(); vi.stubEnv("DATABASE_PATH", path);
    const owner = createStudio(); insertEncounter(owner.id, createEncounter("migration-case", "case-01"));
    db().prepare("UPDATE encounters SET audio=?").run(Buffer.from("original consultation"));
    db().prepare("INSERT INTO teach_back_attempt_audio VALUES(?,?,?,?,?)").run("migration-case", "warning", "old-attempt", "fp", Buffer.from("original answer"));
    db().prepare("INSERT INTO source_documents VALUES(?,?,?,?)").run("migration-case", "old-document", "image/png", Buffer.from("original document"));
    const reservation = recordEstimatedCost("note", 0.3, owner.userId); recordCost(reservation, 0.02);
    db().exec("DROP TABLE agent_events; DROP TABLE agent_runs; PRAGMA user_version=5");
    const names = db().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => String(r.name));
    const original = Object.fromEntries(names.map(name => [name, db().prepare(`SELECT * FROM "${name}"`).all()])); closeDb();
    const before = snapshotEvidence(path, "migration-case"); expect(before.schemaVersion).toBe(5);
    const current = db(); expect(current.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
    for (const name of names) expect(current.prepare(`SELECT * FROM "${name}"`).all()).toEqual(original[name]);
    expect(current.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(current.prepare("SELECT count(*) AS n FROM agent_runs").get()?.n).toBe(0);
    closeDb(); const after = snapshotEvidence(path, "migration-case"); expect(after.schemaVersion).toBe(6);
    expect(() => compareEvidence(before, after)).toThrow(/schema migration/);
    expect(compareEvidence(before, before).attempts).toBe(0);
    const backups = readdirSync(directory).filter(name => name.includes(".backup-")); expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(directory, backups[0]), { readOnly: true });
    expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(5); backup.close();
    db(); closeDb(); expect(readdirSync(directory).filter(name => name.includes(".backup-"))).toHaveLength(1);
  } finally { closeDb(); rmSync(directory, { recursive: true, force: true }); }
});
