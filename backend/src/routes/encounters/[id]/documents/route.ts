import { NextRequest } from "next/server";
import { envelope, errorResponse, json, protectMutation, readLimited, requireSession, requireStudio } from "../../../../server/http";
import { DOCUMENT_LIMIT, uploadDocument } from "../../../../server/documents";
import { WorkflowError } from "../../../../domain/workflow";
export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    protectMutation(request); const owner = requireSession(request); requireStudio(owner);
    if (request.headers.get("x-synthetic-document") !== "true") throw new WorkflowError("Confirm synthetic document permission.", 400);
    const data = await readLimited(request, DOCUMENT_LIMIT);
    return json(envelope(await uploadDocument(owner, (await context.params).id, Number(request.headers.get("x-encounter-version")), request.headers.get("idempotency-key") ?? "", request.headers.get("x-document-name") ?? "Synthetic document", request.headers.get("content-type") ?? "", data)));
  } catch (error) { return errorResponse(error); }
}
