import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "../src/routes/encounters/[id]/agent/route";
import { closeDb, createSession, db, insertEncounter } from "../src/server/db-core";
import { createEncounter, savedNote } from "../src/domain/workflow";
import { reviewerHandoff } from "../src/domain/agent-policy";
import { createStudio } from "./account-fixture";
import { COOKIE } from "../src/server/auth-core";
import { ACCOUNT_COOKIE } from "../src/server/accounts";
import { HandoffCard } from "../../web/src/components/agent-panel";

beforeEach(() => { closeDb(); vi.stubEnv("DATABASE_PATH", ":memory:"); });
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const context = { params: Promise.resolve({ id: "route-case" }) };
const url = "http://localhost:3000/api/encounters/route-case/agent";
it("protects the agent API from cross-origin, missing sessions, other accounts and forbidden commands", async () => {
  const owner = createStudio(), admin = createStudio(), e = createEncounter("route-case", "case-01"); e.consent = true; e.claims = savedNote(e); insertEncounter(owner.id, e);
  db().prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.userId!);
  expect((await GET(new NextRequest(url), context)).status).toBe(401);
  expect((await GET(new NextRequest(url, { headers: { Cookie: `${ACCOUNT_COOKIE}=${admin.token}` } }), context)).status).toBe(404);
  const headers = { Cookie: `${ACCOUNT_COOKIE}=${owner.token}`, Origin: "http://localhost:3000", "Content-Type": "application/json", "Idempotency-Key": "agent-http-request" };
  expect((await POST(new NextRequest(url, { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body: JSON.stringify({ command: "start", mode: "source_review", expectedVersion: 1 }) }), context)).status).toBe(403);
  expect((await POST(new NextRequest(url, { method: "POST", headers, body: JSON.stringify({ command: "approve-note", expectedVersion: 1 }) }), context)).status).toBe(400);
  const result = await GET(new NextRequest(url, { headers }), context); expect(result.status).toBe(200);
  const json = await result.json(); expect(json.capabilities.enabled).toBe(false); expect(json.handoff.noteApproved).toBe(false);
});
it("serves labelled Saved Demo runs without a key or inference", async () => {
  const owner = createSession(), e = createEncounter("route-case", "case-01"); e.consent = true; e.claims = savedNote(e); insertEncounter(owner.id, e);
  vi.stubEnv("MODEL_API_KEY", ""); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const result = await POST(new NextRequest(url, { method: "POST", headers: { Cookie: `${COOKIE}=${owner.token}`, Origin: "http://localhost:3000", "Content-Type": "application/json", "Idempotency-Key": "demo-http-start" }, body: JSON.stringify({ command: "start", mode: "source_review", expectedVersion: 1 }) }), context);
  expect(result.status).toBe(200); const json = await result.json(); expect(json.runs[0].fixture).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
it("renders an incomplete owner handoff with exact evidence and without invented decisions", () => {
  const e = createEncounter("route-case", "case-01"); e.consent = true; e.claims = savedNote(e);
  const html = renderToStaticMarkup(createElement(HandoffCard, { handoff: reviewerHandoff(e) }));
  expect(html).toContain("No model call"); expect(html).toContain("review needed"); expect(html).toContain("No answers recorded");
  expect(html).toContain("Required next checkpoints"); expect(html).not.toContain("current approved wording");
});
