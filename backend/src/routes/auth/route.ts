import { NextRequest } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, MODE_COOKIE, accountSession, changePassword, createAccountSession, logout, registerAccount, resetPassword, signIn } from "../../server/accounts";
import { modelUsageSummary, rateLimit } from "../../server/db";
import { errorResponse, json, protectMutation, readJson } from "../../server/http";
import { WorkflowError } from "../../domain/workflow";
const credentials = { email: z.string().max(254), password: z.string().max(512) };
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("register"), name: z.string().max(80), ...credentials }).strict(),
  z.object({ action: z.literal("login"), ...credentials }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
  z.object({ action: z.literal("change-password"), currentPassword: z.string().max(512), password: z.string().max(512) }).strict(),
  z.object({ action: z.literal("reset-password"), token: z.string().max(128), password: z.string().max(512) }).strict(),
]);
export function requireAccount(request: NextRequest) {
  const session = accountSession(request.cookies.get(ACCOUNT_COOKIE)?.value);
  if (!session) throw new WorkflowError("Sign in to continue.", 401);
  return session;
}
export async function GET(request: NextRequest) {
  try { const session = requireAccount(request); return json({ user: session.user, usage: modelUsageSummary(session.userId) }); } catch(e) { return errorResponse(e); }
}
export async function POST(request: NextRequest) {
  try {
    protectMutation(request); rateLimit("authentication-global", 60);
    // Only trust forwarding headers when the operator explicitly configures a proxy.
    const ip = process.env.TRUST_PROXY === "true" ? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown" : "local";
    rateLimit(`authentication-ip:${ip}`, 20);
    const body = input.parse(await readJson(request));
    const response = json({ ok: true });
    const options = { httpOnly: true, sameSite: "strict" as const, secure: request.nextUrl.protocol === "https:", maxAge: 86400, path: "/" };
    if (body.action === "register" || body.action === "login") {
      rateLimit(`authentication-email:${body.email.trim().toLowerCase()}`, 10, 900000);
      const created = body.action === "register" ? createAccountSession((await registerAccount(body.name, body.email, body.password)).id) : await signIn(body.email, body.password);
      const previous = accountSession(request.cookies.get(ACCOUNT_COOKIE)?.value);
      if (previous) logout(previous.sessionId);
      response.cookies.set(ACCOUNT_COOKIE, created.token, options); response.cookies.set(MODE_COOKIE, "account", options);
    } else if (body.action === "reset-password") {
      rateLimit("password-reset-global", 10); await resetPassword(body.token, body.password);
      response.cookies.set(ACCOUNT_COOKIE, "", { ...options, maxAge: 0 });
    } else {
      const session = requireAccount(request);
      if (body.action === "change-password") await changePassword(session, body.currentPassword, body.password); else logout(session.sessionId);
      response.cookies.set(ACCOUNT_COOKIE, "", { ...options, maxAge: 0 }); response.cookies.set(MODE_COOKIE, "demo", options);
    }
    return response;
  } catch(e) { return errorResponse(e); }
}
