import { NextRequest, NextResponse } from "next/server";
import { loadAudio, loadEncounter, saveEncounterWithAudio } from "../../../../server/db";
import { envelope, errorResponse, json, protectMutation, readLimited, requireSession, requireStudio } from "../../../../server/http";
import { invalidate, WorkflowError } from "../../../../domain/workflow";
import { validateWav } from "../../../../server/audio";
import { fingerprint } from "../../../../domain/workflow";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: NextRequest, context: Context) {
  try {
    protectMutation(request); const owner = requireSession(request); requireStudio(owner);
    const id = (await context.params).id, previous = loadEncounter(owner.id, id);
    if (!previous.consent || request.headers.get("x-synthetic-audio") !== "true") throw new WorkflowError("Confirm synthetic audio only before uploading.", 400);
    if (Number(request.headers.get("x-encounter-version")) !== previous.version) throw new WorkflowError("Reload before replacing audio.");
    const audio = await readLimited(request, 20_000_000); validateWav(audio);
    const e = invalidate(previous, "transcript"); e.turns = []; e.audioAvailable = true; e.mode = "live"; e.version++;
    e.recordingFingerprint = fingerprint(audio.toString("base64")); e.speakerMapping = null;
    e.provenance.transcript = "Synthetic audio saved. Transcription pending.";
    saveEncounterWithAudio(owner.id, previous.version, e, audio);
    return json(envelope(e));
  } catch (e) { return errorResponse(e); }
}
export async function GET(request: NextRequest, context: Context) {
  try {
    const owner = requireSession(request), id = (await context.params).id;
    loadEncounter(owner.id, id); const audio = loadAudio(owner.id, id);
    if (!audio) throw new WorkflowError("No audio recorded for this reference. Saved timestamps are illustrative.", 404);
    return new NextResponse(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", "Content-Length": String(audio.length), "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
