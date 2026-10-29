import { createStudio } from "./account-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveNote, approveSheet, createEncounter, runChecks, savedNote, savedReview, sheetFingerprint } from "../src/domain/workflow";
import { templateSheet } from "../src/domain/render";
import { act } from "../src/server/actions";
import { closeDb, createSession, insertEncounter, loadSpokenQuestionAudio, saveSpokenQuestionAudio } from "../src/server/db";
import { sampleWav } from "./audio.test";

beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; vi.stubEnv("ENABLE_PLAN_QUESTIONS", "true"); vi.stubEnv("ENABLE_SPOKEN_QUESTIONS", "true"); vi.stubEnv("ALLOW_LIVE_MODE", "true"); vi.stubEnv("MODEL_API_KEY", "test-model-key"); });
afterEach(() => { closeDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function ready() { let e = createEncounter("spoken-case", "case-01"); e.consent = true; e.claims = savedNote(e); e.noteReview = savedReview(e, "note"); e = approveNote(runChecks(e), "DR", true); e.lines = templateSheet(e.claims); e.sheetReview = savedReview(e, "sheet"); return approveSheet(runChecks(e), "DR", true); }
describe("spoken plan question", () => {
  it("keeps question audio separate and requires corrected transcript confirmation before Spark", async () => {
    const owner = createStudio(), e = ready(); insertEncounter(owner.id, e);
    const recorded = structuredClone(e); recorded.version++; recorded.spokenQuestionDrafts = [{ id: "spoken-1", sheetFingerprint: sheetFingerprint(e), createdAt: new Date().toISOString(), rawTranscript: null, correctedTranscript: null, transcription: null, confirmedBy: null, confirmedAt: null, confirmedFingerprint: null, answered: false }]; recorded.activeSpokenQuestionId = "spoken-1";
    saveSpokenQuestionAudio(owner.id, e.version, recorded, "spoken-1", sampleWav());
    expect(loadSpokenQuestionAudio(owner.id, e.id, "spoken-1")).not.toBeNull();
    const other = createStudio(); expect(loadSpokenQuestionAudio(other.id, e.id, "spoken-1")).toBeNull();
    await expect(act(owner, e.id, "question-before-confirm", { action: "ask-spoken-plan-question", expectedVersion: recorded.version, questionId: "spoken-1" })).rejects.toThrow(/enter a question|Confirm/);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ transcript: "Ano ang gamat ko?" }))).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lineIds: [e.lines[0].id], needsReviewer: false }) } }], usage: { prompt_tokens_details: { cached_tokens: 0 }, prompt_tokens: 20, completion_tokens: 10 } })));
    vi.stubGlobal("fetch", fetchMock);
    const transcribed = await act(owner, e.id, "transcribe-spoken", { action: "transcribe-spoken-question", expectedVersion: recorded.version, questionId: "spoken-1" });
    const corrected = await act(owner, e.id, "correct-spoken", { action: "edit-spoken-question-transcript", expectedVersion: transcribed.version, questionId: "spoken-1", transcript: "Ano ang gamot ko?" });
    await expect(act(owner, e.id, "question-still-unconfirmed", { action: "ask-spoken-plan-question", expectedVersion: corrected.version, questionId: "spoken-1" })).rejects.toThrow(/Confirm/);
    const confirmed = await act(owner, e.id, "confirm-spoken", { action: "confirm-spoken-question", expectedVersion: corrected.version, questionId: "spoken-1", confirmed: true, reviewer: "DR" });
    const answered = await act(owner, e.id, "ask-spoken", { action: "ask-spoken-plan-question", expectedVersion: confirmed.version, questionId: "spoken-1" });
    expect(answered.planQuestions![0]).toMatchObject({ kind: "spoken", question: "Ano ang gamot ko?", rawTranscript: "Ano ang gamat ko?", audioAvailable: true });
    expect(answered.planQuestions![0].answerLines[0].text).toBe(e.lines[0].text);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
