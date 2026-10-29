import { NextRequest } from "next/server";
import { act, ActionSchema } from "../../../server/actions";
import { deleteEncounter, loadEncounter, rateLimit } from "../../../server/db";
import { envelope, errorResponse, json, protectMutation, readJson, requireSession } from "../../../server/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try { const owner = requireSession(request); return json(envelope(loadEncounter(owner.id, (await context.params).id))); } catch (e) { return errorResponse(e); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    protectMutation(request); const owner = requireSession(request); rateLimit(owner.id, 60);
    const input = ActionSchema.parse(await readJson(request));
    const e = await act(owner, (await context.params).id, request.headers.get("idempotency-key") ?? "", input);
    return json(envelope(e));
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(request: NextRequest, context: Context) {
  try { protectMutation(request); const owner = requireSession(request); deleteEncounter(owner.id, (await context.params).id); return json({ deleted: true }); } catch (e) { return errorResponse(e); }
}
