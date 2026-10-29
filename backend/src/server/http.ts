import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSession, rateLimit } from "./db";
import { exportReasons, hasCurrentNoteApproval, hasCurrentSheetApproval, WorkflowError } from "../domain/workflow";
import type { Encounter } from "../domain/schema";
import { COOKIE, requireStudio, sessionFromCookie } from "./auth-core";
export { COOKIE, requireStudio };
export function requireSession(request: NextRequest) {
  return sessionFromCookie(request.headers.get("cookie") ?? undefined);
}
export function protectMutation(request: NextRequest) {
  const origin = request.headers.get("origin");
  // Next's internal request URL may normalize a loopback hostname. The browser's Host
  // header is the authority it used; browsers cannot spoof Host from cross-origin JS.
  const expectedOrigin = process.env.APP_ORIGIN || `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`;
  if (!origin || origin !== expectedOrigin || request.headers.get("sec-fetch-site") === "cross-site") throw new WorkflowError("Only requests from this app are accepted.", 403);
  rateLimit("global-mutations", 300);
}
export async function readLimited(request: NextRequest, max: number): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > max) throw new WorkflowError("Request too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new WorkflowError("Request too large.", 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson(request: NextRequest) {
  try { return JSON.parse((await readLimited(request, 200_000)).toString("utf8")); }
  catch (e) { if (e instanceof WorkflowError) throw e; throw new WorkflowError("Invalid JSON request.", 400); }
}
export function envelope(e: Encounter) { return { encounter: e, view: { noteApproved: hasCurrentNoteApproval(e), sheetApproved: hasCurrentSheetApproval(e), exportReasons: exportReasons(e) } }; }
export function json(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
export function errorResponse(e: unknown) {
  if (e instanceof WorkflowError) return json({ error: e.message }, e.status);
  if (e instanceof ZodError) return json({ error: "Some fields are invalid. Check the source IDs, required values and field lengths." }, 400);
  return json({ error: "The request could not be completed. Saved work has been preserved." }, 500);
}
