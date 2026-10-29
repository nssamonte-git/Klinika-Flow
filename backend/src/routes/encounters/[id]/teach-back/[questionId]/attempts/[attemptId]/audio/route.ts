import { NextRequest, NextResponse } from "next/server";
import { loadEncounter, loadTeachBackAttemptAudio } from "../../../../../../../../server/db";
import { errorResponse, requireSession } from "../../../../../../../../server/http";
import { WorkflowError } from "../../../../../../../../domain/workflow";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; questionId: string; attemptId: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const owner = requireSession(request), { id, questionId, attemptId } = await context.params;
    const encounter = loadEncounter(owner.id, id);
    const question = [...encounter.teachBack, ...(encounter.teachBackArchive ?? [])].find(q => q.id === questionId && q.attempts?.some(a => a.id === attemptId));
    if (!question) throw new WorkflowError("Answer attempt not found.", 404);
    const attempt = question.attempts!.find(a => a.id === attemptId)!;
    if (!attempt.audioAvailable) throw new WorkflowError("This answer attempt has no audio.", 404);
    const audio = loadTeachBackAttemptAudio(owner.id, id, questionId, attemptId);
    if (!audio) throw new WorkflowError("Answer audio is missing.", 404);
    return new NextResponse(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", "Content-Length": String(audio.length), "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
