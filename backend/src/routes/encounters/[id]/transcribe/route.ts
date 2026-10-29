import { NextRequest } from "next/server";
import { z } from "zod";
import { transcribeEncounter } from "../../../../server/actions";
import { rateLimit } from "../../../../server/db";
import { envelope, errorResponse, json, protectMutation, readJson, requireSession } from "../../../../server/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    protectMutation(request); const owner = requireSession(request); rateLimit(owner.id, 10);
    const body = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(await readJson(request));
    const key = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(key)) return json({ error: "A request key is required." }, 400);
    return json(envelope(await transcribeEncounter(owner, (await context.params).id, body.expectedVersion, key)));
  } catch (e) { return errorResponse(e); }
}
