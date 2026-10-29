import { NextRequest } from "next/server";
import { z } from "zod";
import { assertActive, importLegacy } from "../../../server/accounts";
import { getSession } from "../../../server/db";
import { COOKIE, errorResponse, json, protectMutation, readJson } from "../../../server/http";
import { requireAccount } from "../../auth/route";
import { WorkflowError } from "../../../domain/workflow";
export async function GET(request: NextRequest) {
  try { assertActive(requireAccount(request)); return json({ available: Boolean(getSession(request.cookies.get(COOKIE)?.value)) }); } catch(e) { return errorResponse(e); }
}
export async function POST(request: NextRequest) {
  try {
    protectMutation(request); const session = assertActive(requireAccount(request));
    z.object({ confirmed: z.literal(true) }).strict().parse(await readJson(request));
    const legacy = getSession(request.cookies.get(COOKIE)?.value);
    if (!legacy) throw new WorkflowError("No valid browser workspace is available to import.", 409);
    importLegacy(session, legacy.id); const response = json({ imported: true });
    response.cookies.set(COOKIE, "", { httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 0 }); return response;
  } catch(e) { return errorResponse(e); }
}
