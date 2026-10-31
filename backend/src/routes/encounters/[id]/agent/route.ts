import { NextRequest } from "next/server";
import { getAgentView, agentCommand } from "../../../../server/agent";
import { AgentCommandSchema } from "../../../../domain/agent-contract";
import { errorResponse, json, protectMutation, readJson, requireSession } from "../../../../server/http";
import { rateLimit } from "../../../../server/db";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try { return json(getAgentView(requireSession(request), (await context.params).id)); } catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    protectMutation(request); const owner = requireSession(request); rateLimit(`agent:${owner.id}`, 60);
    return json(await agentCommand(owner, (await context.params).id, request.headers.get("idempotency-key") ?? "", AgentCommandSchema.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
