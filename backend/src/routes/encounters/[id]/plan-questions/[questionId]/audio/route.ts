import { NextRequest, NextResponse } from "next/server";
import { loadEncounter, loadSpokenQuestionAudio } from "../../../../../../server/db";
import { errorResponse, requireSession } from "../../../../../../server/http";
import { WorkflowError } from "../../../../../../domain/workflow";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; questionId: string }> }) {
  try {
    const owner = requireSession(request), { id, questionId } = await context.params, e = loadEncounter(owner.id, id);
    if (!e.spokenQuestionDrafts?.some(q => q.id === questionId)) throw new WorkflowError("Question recording not found.", 404);
    const audio = loadSpokenQuestionAudio(owner.id, id, questionId);
    if (!audio) throw new WorkflowError("Question recording is missing.", 404);
    return new NextResponse(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", "Content-Length": String(audio.length), "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
