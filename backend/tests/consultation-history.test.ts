import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createStudio } from "./account-fixture";
import { createEncounter, invalidate } from "../src/domain/workflow";
import { act, transcribeEncounter } from "../src/server/actions";
import { closeDb, insertEncounter, loadEncounter, saveEncounterWithAudio } from "../src/server/db";

beforeEach(() => { closeDb(); vi.stubEnv("DATABASE_PATH", ":memory:"); vi.stubEnv("ALLOW_LIVE_MODE", "true"); vi.stubEnv("MODEL_API_KEY", "synthetic-test-key"); });
afterEach(() => { closeDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function wav() {
  const b = Buffer.alloc(32044); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(32000, 40); return b;
}
function setup() {
  const owner = createStudio(), e = createEncounter("history-case", "case-01"); e.consent = true; insertEncounter(owner.id, e);
  e.version++; e.recordingFingerprint = "recording-original"; e.audioAvailable = true;
  saveEncounterWithAudio(owner.id, 1, e, wav());
  return { owner, e };
}
function provider() {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ transcript: "Raw actor words", turns: [{ turnId: "a", transcript: "Raw actor words", speaker: "A", startMs: 0, endMs: 900 }] })));
  vi.stubGlobal("fetch", fetch); return fetch;
}

it("preserves raw consultation text across human edits, invalidation, reload and idempotent replay", async () => {
  const { owner, e } = setup(), fetch = provider();
  const first = await transcribeEncounter(owner, e.id, e.version, "transcribe-original");
  expect(first.consultationTranscriptions).toHaveLength(1);
  expect(first.consultationTranscriptions![0]).toMatchObject({ transcript: "Raw actor words", providerLabels: ["A"], recordingFingerprint: "recording-original", model: "muse-voice-transcribe-1.0", requestKey: "transcribe-original", latencyMs: expect.any(Number), estimatedCostUsd: expect.any(Number), at: expect.any(String) });
  const edited = await act(owner, e.id, "transcript-correction", { action: "transcript", expectedVersion: first.version, turns: first.turns.map(t => ({ ...t, text: "Human corrected text", speaker: "clinician" })) });
  const replay = await transcribeEncounter(owner, e.id, e.version, "transcribe-original");
  expect(fetch).toHaveBeenCalledTimes(1); expect(replay.turns[0].text).toBe("Human corrected text");
  expect(loadEncounter(owner.id, e.id).consultationTranscriptions![0].turns[0]).toMatchObject({ text: "Raw actor words", speaker: "unknown", providerSpeaker: "A" });
  for (const level of ["transcript", "note", "sheet"] as const) expect(invalidate(edited, level).consultationTranscriptions).toEqual(first.consultationTranscriptions);
  await transcribeEncounter(owner, e.id, edited.version, "transcribe-second");
  expect(loadEncounter(owner.id, e.id).consultationTranscriptions).toHaveLength(2);
});

it("keeps old encounters without invented history and rejects access from another account", async () => {
  const { owner, e } = setup(), other = createStudio(), fetch = provider();
  expect(loadEncounter(owner.id, e.id).consultationTranscriptions).toBeUndefined();
  await expect(transcribeEncounter(other, e.id, e.version, "transcribe-other")).rejects.toThrow(/not found/);
  expect(() => loadEncounter(other.id, e.id)).toThrow(/not found/); expect(fetch).not.toHaveBeenCalled();
});

it("retains prior history and audio state when a new provider attempt fails", async () => {
  const { owner, e } = setup(); provider();
  const first = await transcribeEncounter(owner, e.id, e.version, "transcribe-good");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
  await expect(transcribeEncounter(owner, e.id, first.version, "transcribe-failed")).rejects.toThrow(/network failed/);
  expect(loadEncounter(owner.id, e.id)).toEqual(first);
});
