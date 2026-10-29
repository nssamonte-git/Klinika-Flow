import { createStudio } from "./account-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEncounter } from "../src/domain/workflow";
import { act } from "../src/server/actions";
import { closeDb, createSession, insertEncounter, loadEncounter } from "../src/server/db";

beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => closeDb());
describe("guided preparation checkpoints", () => {
  it("requires explicit transcript confirmation and persists completed request keys", async () => {
    const owner = createStudio(), e = createEncounter("prep-case", "case-01"); e.consent = true; insertEncounter(owner.id, e);
    await expect(act(owner, e.id, "draft-too-early", { action: "generate-note", expectedVersion: e.version, provider: "saved" })).rejects.toThrow(/Confirm the current transcript/);
    const confirmed = await act(owner, e.id, "confirm-current", { action: "confirm-transcript", expectedVersion: e.version, reviewer: "DR", confirmed: true });
    expect(confirmed.preparation?.completed.at(-1)).toMatchObject({ action: "confirm-transcript", requestKey: "confirm-current" });
    const draft = await act(owner, e.id, "draft-current", { action: "generate-note", expectedVersion: confirmed.version, provider: "saved" });
    expect(loadEncounter(owner.id, e.id).preparation?.completed.map(p => p.action)).toEqual(["confirm-transcript", "generate-note"]);
    const repeated = await act(owner, e.id, "lost-response-new-key", { action: "generate-note", expectedVersion: confirmed.version, provider: "saved" });
    expect(repeated.version).toBe(draft.version);
    const edited = await act(owner, e.id, "edit-transcript", { action: "transcript", expectedVersion: draft.version, turns: draft.turns.map((t, i) => i === 0 ? { ...t, text: `${t.text} correction` } : t) });
    expect(edited.transcriptConfirmation).toBeNull();
    await expect(act(owner, e.id, "draft-after-edit", { action: "generate-note", expectedVersion: edited.version, provider: "saved" })).rejects.toThrow(/Confirm the current transcript/);
  });
});
