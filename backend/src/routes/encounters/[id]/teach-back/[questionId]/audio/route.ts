import { NextRequest, NextResponse } from "next/server";
import { loadEncounter, loadTeachBackAudio, loadTeachBackAttemptAudio, rateLimit, saveTeachBackAudio } from "../../../../../../server/db";
import { envelope, errorResponse, json, protectMutation, readLimited, requireSession, requireStudio } from "../../../../../../server/http";
import { activeAttempt, hasCurrentSheetApproval, projectAttempt, sheetFingerprint, startAttempt, WorkflowError } from "../../../../../../domain/workflow";
import { validateWav } from "../../../../../../server/audio";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; questionId: string }> };
export async function POST(request: NextRequest, context: Context) {
  try {
    protectMutation(request);
    const owner = requireSession(request); requireStudio(owner); rateLimit(owner.id, 60);
    const { id, questionId } = await context.params, previous = loadEncounter(owner.id, id);
    if (!previous.consent || request.headers.get("x-synthetic-audio") !== "true") throw new WorkflowError("Confirm synthetic audio only before uploading.", 400);
    if (!hasCurrentSheetApproval(previous)) throw new WorkflowError("Approve the current sheet first.");
    if (Number(request.headers.get("x-encounter-version")) !== previous.version) throw new WorkflowError("Reload before replacing the answer recording.");
    const q = previous.teachBack.find(t => t.id === questionId && t.sheetFingerprint === sheetFingerprint(previous));
    if (!q) throw new WorkflowError("Current teach-back question not found.", 404);
    const audio = await readLimited(request, 6_000_000), parsed = validateWav(audio);
    if (parsed.durationSeconds > 120) throw new WorkflowError("Keep each synthetic teach-back answer within two minutes.", 400);
    const e = structuredClone(previous), current = e.teachBack.find(t => t.id === questionId)!;
    let attempt = activeAttempt(current);
    if (attempt.audioAvailable || attempt.rawTranscript || attempt.correctedTranscript || attempt.analysis || attempt.outcome !== "pending") attempt = startAttempt(current);
    attempt.audioAvailable = true; projectAttempt(current); e.printException = null;
    e.version++; e.audit = [...e.audit, { ...(owner.userId ? { actorId: owner.userId } : {}), action: "teach-back-audio", at: new Date().toISOString(), version: e.version }].slice(-100);
    saveTeachBackAudio(owner.id, previous.version, e, questionId, current.sheetFingerprint, audio, attempt.id);
    return json(envelope(e));
  } catch (error) { return errorResponse(error); }
}
export async function GET(request: NextRequest, context: Context) {
  try {
    const owner = requireSession(request), { id, questionId } = await context.params, e = loadEncounter(owner.id, id);
    const q = e.teachBack.find(t => t.id === questionId && t.sheetFingerprint === sheetFingerprint(e));
    if (!q?.audioAvailable) throw new WorkflowError("No current answer recording.", 404);
    const audio = loadTeachBackAttemptAudio(owner.id, id, questionId, activeAttempt(q).id) ?? loadTeachBackAudio(owner.id, id, questionId, q.sheetFingerprint);
    if (!audio) throw new WorkflowError("No current answer recording.", 404);
    return new NextResponse(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", "Content-Length": String(audio.length), "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
