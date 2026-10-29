import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { loadEncounter, rateLimit, saveSpokenQuestionAudio } from "../../../../../server/db";
import { envelope, errorResponse, json, protectMutation, readLimited, requireSession, requireStudio } from "../../../../../server/http";
import { hasCurrentSheetApproval, sheetFingerprint, WorkflowError } from "../../../../../domain/workflow";
import { validateWav } from "../../../../../server/audio";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    protectMutation(request); const owner = requireSession(request); requireStudio(owner); rateLimit(owner.id, 60);
    if (process.env.ENABLE_PLAN_QUESTIONS !== "true" || process.env.ENABLE_SPOKEN_QUESTIONS !== "true") throw new WorkflowError("Spoken plan questions are disabled.", 403);
    const id = (await context.params).id, previous = loadEncounter(owner.id, id);
    if (!previous.consent || request.headers.get("x-synthetic-audio") !== "true") throw new WorkflowError("Confirm synthetic actor audio only.", 400);
    if (!hasCurrentSheetApproval(previous)) throw new WorkflowError("Approve the current sheet first.");
    if (Number(request.headers.get("x-encounter-version")) !== previous.version) throw new WorkflowError("Reload before saving this question recording.");
    if ((previous.spokenQuestionDrafts?.length ?? 0) >= 100) throw new WorkflowError("This encounter has reached its question recording limit.", 429);
    const audio = await readLimited(request, 6_000_000), parsed = validateWav(audio);
    if (parsed.durationSeconds > 120) throw new WorkflowError("Keep a spoken question within two minutes.", 400);
    const e = structuredClone(previous), questionId = randomUUID();
    e.spokenQuestionDrafts ??= [];
    e.spokenQuestionDrafts.push({ id: questionId, sheetFingerprint: sheetFingerprint(e), createdAt: new Date().toISOString(), rawTranscript: null, correctedTranscript: null, transcription: null, confirmedBy: null, confirmedAt: null, confirmedFingerprint: null, answered: false });
    e.activeSpokenQuestionId = questionId; e.version++;
    e.audit = [...e.audit, { ...(owner.userId ? { actorId: owner.userId } : {}), action: "spoken-question-audio", at: new Date().toISOString(), version: e.version }].slice(-100);
    saveSpokenQuestionAudio(owner.id, previous.version, e, questionId, audio);
    return json(envelope(e));
  } catch (error) { return errorResponse(error); }
}
