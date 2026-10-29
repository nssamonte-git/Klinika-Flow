import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { insertEncounter, rateLimit } from "../../server/db";
import { envelope, errorResponse, json, protectMutation, readJson, requireSession } from "../../server/http";
import { createEncounter } from "../../domain/workflow";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    protectMutation(request); const owner = requireSession(request); rateLimit(owner.id, 30);
    const { caseId } = z.object({ caseId: z.string().max(40) }).strict().parse(await readJson(request));
    const e = createEncounter(randomUUID(), caseId); insertEncounter(owner.id, e); return json(envelope(e), 201);
  } catch (e) { return errorResponse(e); }
}
