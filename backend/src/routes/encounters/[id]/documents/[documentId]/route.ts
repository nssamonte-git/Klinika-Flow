import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireSession } from "../../../../../server/http";
import { loadSourceDocument } from "../../../../../server/db";
import { WorkflowError } from "../../../../../domain/workflow";
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    const owner = requireSession(request), { id, documentId } = await context.params, source = loadSourceDocument(owner.id, id, documentId);
    if (!source) throw new WorkflowError("Source document unavailable in this session.", 404);
    return new NextResponse(new Uint8Array(source.data), { headers: { "Content-Type": source.mime, "Content-Length": String(source.data.length), "Content-Disposition": `inline; filename="synthetic-source.${source.mime === "application/pdf" ? "pdf" : source.mime === "image/png" ? "png" : "jpg"}"`, "Cache-Control": "no-store", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'" } });
  } catch (error) { return errorResponse(error); }
}
