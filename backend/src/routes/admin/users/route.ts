import { NextRequest } from "next/server";
import { z } from "zod";
import { accountDirectory, assertAdmin, createReset, manageUser } from "../../../server/accounts";
import { errorResponse, json, protectMutation, readJson } from "../../../server/http";
import { requireAccount } from "../../auth/route";
import { WorkflowError } from "../../../domain/workflow";
export async function GET(request: NextRequest) {
  try { return json(accountDirectory(requireAccount(request))); } catch(e) { return errorResponse(e); }
}
export async function POST(request: NextRequest) {
  try {
    protectMutation(request); const session = requireAccount(request); assertAdmin(session);
    const body = z.object({ userId: z.string().uuid(), action: z.enum(["approve", "suspend", "restore", "reset-password"]), confirmed: z.boolean().optional() }).strict().parse(await readJson(request));
    if (["suspend", "reset-password"].includes(body.action) && body.confirmed !== true) throw new WorkflowError("Confirm this account action.", 400);
    if (body.action === "reset-password") { const reset = createReset(session, body.userId); return json({ resetUrl: `/reset-password#token=${reset.token}`, expires: reset.expires }); }
    return json({ user: manageUser(session, body.userId, body.action) });
  } catch(e) { return errorResponse(e); }
}
