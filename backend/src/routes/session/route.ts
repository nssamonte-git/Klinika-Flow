import { NextRequest } from "next/server";
import { z } from "zod";
import { modelUsageSummary, createSession, getSession, listEncounters } from "../../server/db";
import { COOKIE, errorResponse, json, protectMutation, readJson } from "../../server/http";
import { ACCOUNT_COOKIE, MODE_COOKIE, accountSession } from "../../server/accounts";
import { cases } from "../../domain/cases";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    protectMutation(request);
    const body = z.object({ mode: z.enum(["demo", "account"]).optional() }).strict().parse(await readJson(request));
    const account = accountSession(request.cookies.get(ACCOUNT_COOKIE)?.value);
    const mode = body.mode ?? request.cookies.get(MODE_COOKIE)?.value ?? "account";
    const studio = mode !== "demo" && account?.user.status === "active";
    const existing = getSession(request.cookies.get(COOKIE)?.value);
    const created = !studio && !existing ? createSession() : null;
    const session = studio ? account! : created ?? existing!;
    const response = json({ role: studio ? "studio" : "judge", user: account?.user ?? null, mode: studio ? "account" : "demo", cases: cases.map(({ id, title, subtitle, patient }) => ({ id, title, subtitle, patient })), encounters: listEncounters(session.id).map(e => ({ id: e.id, title: e.title })), modelUsage: modelUsageSummary(studio ? account!.userId : null), liveConfigured: Boolean(process.env.MODEL_API_KEY), studioEnabled: process.env.ALLOW_LIVE_MODE === "true", features: { documentImport: process.env.ENABLE_DOCUMENT_IMPORT === "true", noteCorrections: process.env.ENABLE_NOTE_CORRECTIONS === "true", planQuestions: process.env.ENABLE_PLAN_QUESTIONS === "true", spokenQuestions: process.env.ENABLE_SPOKEN_QUESTIONS === "true", streaming: process.env.ENABLE_REALTIME_TRANSCRIPTION === "true" && Boolean(process.env.MODEL_API_KEY) } });
    const options = { httpOnly: true, sameSite: "strict" as const, secure: request.nextUrl.protocol === "https:", maxAge: 86400, path: "/" };
    response.cookies.set(MODE_COOKIE, studio ? "account" : "demo", options);
    if (created) response.cookies.set(COOKIE, created.token, options);
    return response;
  } catch (e) { return errorResponse(e); }
}
