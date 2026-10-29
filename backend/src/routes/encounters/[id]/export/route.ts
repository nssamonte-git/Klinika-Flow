import { NextRequest } from "next/server";
import { loadEncounter } from "../../../../server/db";
import { errorResponse, json, requireSession } from "../../../../server/http";
import { exportReasons, WorkflowError } from "../../../../domain/workflow";
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const owner = requireSession(request), e = loadEncounter(owner.id, (await context.params).id);
    const reasons = exportReasons(e); if (reasons.length) throw new WorkflowError(reasons.join(" "));
    return json({ encounter: e, disclosure: "Synthetic demonstration only; not for patient care. Human language and clinical validation pending." });
  } catch (e) { return errorResponse(e); }
}
