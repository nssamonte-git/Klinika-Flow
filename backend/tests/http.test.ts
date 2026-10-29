import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDb } from "../src/server/db";
import { errorResponse, protectMutation, requireStudio } from "../src/server/http";
import { POST as sessionPost } from "../src/routes/session/route";
beforeEach(() => { closeDb(); process.env.DATABASE_PATH = ":memory:"; });
afterEach(() => closeDb());
describe("HTTP safety boundary", () => {
  it("rejects a cross-origin mutation", () => expect(() => protectMutation(new NextRequest("http://localhost:3000/api/session", { method: "POST", headers: { Origin: "https://attacker.example" } }))).toThrow(/Only requests/));
  it("rejects a missing origin", () => expect(() => protectMutation(new NextRequest("http://localhost:3000/api/session", { method: "POST" }))).toThrow());
  it("accepts same-origin mutation", () => expect(() => protectMutation(new NextRequest("http://localhost:3000/api/session", { method: "POST", headers: { Origin: "http://localhost:3000" } }))).not.toThrow());
  it("handles Next's loopback URL normalization without rejecting the browser Host", () => expect(() => protectMutation(new NextRequest("http://localhost:3000/api/session", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" } }))).not.toThrow());
  it("rejects anonymous judge access to the studio", () => expect(() => requireStudio({ role: "judge" })).toThrow(/approved account/));
  it("does not expose unknown internal errors", async () => { const result = errorResponse(new Error("secret internal database path")); expect(await result.text()).not.toContain("secret"); expect(result.status).toBe(500); });
  it("returns model usage without a budget or server credential", async () => {
    vi.stubEnv("MODEL_API_KEY", "server-secret-example");
    const result = await sessionPost(new NextRequest("http://localhost:3000/api/session", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: "{}" }));
    const text = await result.text(), body = JSON.parse(text);
    expect(body.modelUsage).toMatchObject({ estimatedUsd: 0, actualUsd: 0, unknownCalls: 0 });
    expect(body).not.toHaveProperty("budget");
    expect(text).not.toContain("server-secret-example");
    vi.unstubAllEnvs();
  });
});
