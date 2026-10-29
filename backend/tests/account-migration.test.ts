import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { closeDb, createSession, db, getSession } from "../src/server/db-core";
import { createEncounter } from "../src/domain/workflow";
afterEach(() => { closeDb(); vi.unstubAllEnvs(); });
it("backs up and migrates a populated v4 file without changing content, children, jobs or costs", () => {
  const directory = mkdtempSync(join(tmpdir(), "klinikaflow-accounts-")), path = join(directory, "legacy.sqlite");
  try {
    closeDb(); vi.stubEnv("DATABASE_PATH", path);
    const old = new DatabaseSync(path), token = "a".repeat(64), owner = createHash("sha256").update(token).digest("hex"), e = createEncounter("legacy-record", "case-01"), body = JSON.stringify(e);
    old.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sessions(id TEXT PRIMARY KEY,role TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE encounters(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,version INTEGER NOT NULL,body TEXT NOT NULL,audio BLOB,created INTEGER NOT NULL);
      CREATE TABLE teach_back_audio(encounter TEXT REFERENCES encounters(id) ON DELETE CASCADE,question TEXT,sheet_fingerprint TEXT,audio BLOB,PRIMARY KEY(encounter,question));
      CREATE TABLE teach_back_attempt_audio(encounter TEXT REFERENCES encounters(id) ON DELETE CASCADE,question TEXT,attempt TEXT,sheet_fingerprint TEXT,audio BLOB,PRIMARY KEY(encounter,question,attempt));
      CREATE TABLE plan_question_audio(encounter TEXT REFERENCES encounters(id) ON DELETE CASCADE,question_id TEXT,audio BLOB,PRIMARY KEY(encounter,question_id));
      CREATE TABLE source_documents(encounter TEXT REFERENCES encounters(id) ON DELETE CASCADE,document_id TEXT,mime TEXT,data BLOB,PRIMARY KEY(encounter,document_id));
      CREATE TABLE reservations(id TEXT PRIMARY KEY,purpose TEXT NOT NULL,reserved REAL NOT NULL,actual REAL,created INTEGER NOT NULL);
      CREATE TABLE text_calls(reservation TEXT PRIMARY KEY REFERENCES reservations(id),metadata TEXT NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,signature TEXT,status TEXT,result TEXT,created INTEGER);
      PRAGMA user_version=4;`);
    old.prepare("INSERT INTO sessions VALUES(?,'studio',?)").run(owner, Date.now() + 86400000);
    old.prepare("INSERT INTO encounters VALUES(?,?,1,?,?,123)").run(e.id, owner, body, Buffer.from("consultation"));
    old.prepare("INSERT INTO teach_back_attempt_audio VALUES(?,?,?,?,?)").run(e.id, "q1", "attempt1", "fp", Buffer.from("attempt audio"));
    old.prepare("INSERT INTO source_documents VALUES(?,?,?,?)").run(e.id, "doc1", "image/png", Buffer.from("document bytes"));
    old.prepare("INSERT INTO plan_question_audio VALUES(?,?,?)").run(e.id, "question1", Buffer.from("question audio"));
    old.prepare("INSERT INTO reservations VALUES('historical','note',0.5,0.01,123)").run();
    old.prepare("INSERT INTO text_calls VALUES('historical',?)").run('{"original":"metadata"}');
    old.prepare("INSERT INTO jobs VALUES('old-job',?,'sig','done',?,123)").run(owner, body); old.close();
    expect(db().prepare("PRAGMA user_version").get()?.user_version).toBe(5);
    expect(db().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db().prepare("SELECT body,audio FROM encounters").get()).toMatchObject({ body, audio: new Uint8Array(Buffer.from("consultation")) });
    expect(Buffer.from(db().prepare("SELECT audio FROM teach_back_attempt_audio").get()!.audio as Uint8Array).toString()).toBe("attempt audio");
    expect(Buffer.from(db().prepare("SELECT data FROM source_documents").get()!.data as Uint8Array).toString()).toBe("document bytes");
    expect(Buffer.from(db().prepare("SELECT audio FROM plan_question_audio").get()!.audio as Uint8Array).toString()).toBe("question audio");
    expect(db().prepare("SELECT * FROM reservations").get()).toMatchObject({ actual: 0.01, reserved: 0.5, created: 123, user_id: null });
    expect(db().prepare("SELECT metadata FROM text_calls").get()?.metadata).toBe('{"original":"metadata"}');
    expect(db().prepare("SELECT result,owner FROM jobs").get()).toMatchObject({ result: body, owner });
    expect(getSession(token)?.role).toBe("judge"); // Old bearer token never retains live authority.
    db().prepare("UPDATE sessions SET expires=0").run(); createSession();
    expect(db().prepare("SELECT id FROM encounters WHERE id=?").get(e.id)).toBeDefined();
    expect(readdirSync(directory).filter(name => name.includes(".backup-"))).toHaveLength(1);
  } finally { closeDb(); rmSync(directory, { recursive: true, force: true }); }
});
