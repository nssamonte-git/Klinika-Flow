import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEncounter } from "../src/domain/workflow";
import { act } from "../src/server/actions";
import { closeDb, createSession, insertEncounter } from "../src/server/db";

beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => closeDb());

describe("recording speaker mapping", () => {
  it("applies confirmed labels, preserves turn overrides, and isolates recordings", async () => {
    const owner = createSession(), first = createEncounter("map-first", "case-01");
    first.recordingFingerprint = "recording-one";
    first.turns = [
      { id: "t1", text: "clinician instruction", startMs: 0, endMs: 100, speaker: "unknown", providerSpeaker: "A" },
      { id: "t2", text: "patient answer", startMs: 100, endMs: 200, speaker: "patient", providerSpeaker: "A", roleOverride: true },
      { id: "t3", text: "another voice", startMs: 200, endMs: 300, speaker: "unknown", providerSpeaker: "B" },
      { id: "t4", text: "unlabelled", startMs: 300, endMs: 400, speaker: "unknown" },
    ];
    insertEncounter(owner.id, first);
    await expect(act(owner, first.id, "mapping-invalid", { action: "map-speakers", expectedVersion: first.version, speakerRoles: { A: "clinician" }, reviewer: "DR" })).rejects.toThrow(/Confirm speaker roles/);
    const mapped = await act(owner, first.id, "mapping-valid", { action: "map-speakers", expectedVersion: first.version, speakerRoles: { A: "clinician", B: "patient" }, reviewer: "DR", confirmed: true });
    expect(mapped.turns.map(t => t.speaker)).toEqual(["clinician", "patient", "patient", "unknown"]);
    expect(mapped.speakerMapping?.recordingFingerprint).toBe("recording-one");
    const second = createEncounter("map-second", "case-01"); second.recordingFingerprint = "recording-two"; insertEncounter(owner.id, second);
    expect(second.speakerMapping).toBeUndefined();
    expect(second.turns.every(t => !t.providerSpeaker)).toBe(true);
  });
});
