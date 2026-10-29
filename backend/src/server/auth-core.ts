import { getSession } from "./db-core";
import { WorkflowError } from "../domain/workflow";
import { ACCOUNT_COOKIE, MODE_COOKIE, accountSession, assertActive, type AccountSession } from "./accounts";
export const COOKIE = "klinikaflow_session";
export type WorkspaceSession = { id: string; role: "judge" | "studio"; userId?: string; sessionId?: string; user?: AccountSession["user"] };
export function requireStudio(session: WorkspaceSession | { role: string }) {
  if (session.role !== "studio" || !("sessionId" in session) || !session.sessionId || process.env.ALLOW_LIVE_MODE !== "true") throw new WorkflowError("Live calls and audio uploads require an approved account in the workspace. Saved Demo uses saved references.", 403);
  assertActive(session as AccountSession);
}
export function cookieValue(header: string | undefined, name: string) { return header?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1); }
export function sessionFromCookie(header: string | undefined): WorkspaceSession {
  if (cookieValue(header, ACCOUNT_COOKIE) && cookieValue(header, MODE_COOKIE) !== "demo") {
    const session = accountSession(cookieValue(header, ACCOUNT_COOKIE));
    if (!session) throw new WorkflowError("Your session expired. Sign in again.", 401);
    return assertActive(session);
  }
  const session = getSession(cookieValue(header, COOKIE));
  if (!session) throw new WorkflowError("Your session expired. Start a new demo or sign in.", 401);
  return session;
}
