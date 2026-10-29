import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { normalizeAccountEmail, normalizeAccountName, accountDirectory, accountSession, assertActive, changePassword, createAccountSession, createReset, importLegacy, manageUser, registerAccount, resetPassword, signIn, userById, verifyPassword } from "../src/server/accounts";
import { closeDb, createSession, db, insertEncounter, listEncounters, loadEncounter, modelUsageSummary, recordEstimatedCost, saveEncounter, beginJob, endJob, loadAudio } from "../src/server/db-core";
import { cases } from "../src/domain/cases";
import { createEncounter } from "../src/domain/workflow";
import { createStudio } from "./account-fixture";
import { POST as authPost } from "../src/routes/auth/route";
import { GET as directoryGet, POST as adminPost } from "../src/routes/admin/users/route";
import { POST as sessionPost } from "../src/routes/session/route";
import { POST as importPost } from "../src/routes/account/import/route";
import { GET as encounterGet, POST as encounterPost } from "../src/routes/encounters/[id]/route";
import { sessionFromCookie, requireStudio } from "../src/server/auth-core";
import { act } from "../src/server/actions";
vi.setConfig({ testTimeout: 20000 });
const password = "synthetic password for testing";
beforeEach(() => { closeDb(); vi.stubEnv("DATABASE_PATH", ":memory:"); vi.stubEnv("ALLOW_LIVE_MODE", "true"); });
afterEach(() => { closeDb(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function admin() { const account = createStudio(); db().prepare("UPDATE users SET role='admin' WHERE id=?").run(account.userId); return { ...account, user: userById(account.userId)! }; }
function request(path: string, token?: string, body?: unknown, extra = "") { return new NextRequest(`http://localhost:3000${path}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", cookie: `${token ? `klinikaflow_account=${token};` : ""}${extra}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
describe("individual accounts", () => {
  it("identifies blank names and invalid emails before password hashing or database writes", async () => {
    expect(normalizeAccountEmail("admin@klinikaflow.com")).toBe("admin@klinikaflow.com");
    expect(normalizeAccountName(" KlinikaFlow Admin ")).toBe("KlinikaFlow Admin");
    expect(() => normalizeAccountName(" ")).toThrow("Enter a display name between 1 and 80 characters.");
    expect(() => normalizeAccountEmail("admin@invalid")).toThrow(/valid email address/);
    await expect(registerAccount("", "admin@klinikaflow.com", password, true)).rejects.toThrow(/display name/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(0);
  });
  it("registers only pending members, normalizes email and hashes salted passwords", async () => {
    const user = await registerAccount("Actor", " ACTOR@Example.test ", password);
    expect(user).toMatchObject({ name: "Actor", email: "actor@example.test", role: "member", status: "pending", approvedBy: null, approvedAt: null });
    const row = db().prepare("SELECT password FROM users WHERE id=?").get(user.id)!;
    expect(row.password).not.toContain(password); expect(await verifyPassword(password, String(row.password))).toBe(true);
    expect(await verifyPassword("wrong", String(row.password))).toBe(false);
    await expect(registerAccount("Other", "actor@example.test", password)).rejects.toThrow(/could not be created/);
    expect(JSON.stringify(user)).not.toContain("scrypt");
  });
  it("enforces length without silently truncating or trimming passwords", async () => {
    await expect(registerAccount("A", "a@example.test", "short")).rejects.toThrow(/15 and 128/);
    await expect(registerAccount("A", "a@example.test", "x".repeat(129))).rejects.toThrow(/15 and 128/);
    const user = await registerAccount("A", "a@example.test", ` ${password} `);
    const row = db().prepare("SELECT password FROM users WHERE id=?").get(user.id)!;
    expect(await verifyPassword(password, String(row.password))).toBe(false);
  });
  it("uses generic failed sign-in responses and never accepts role/status registration fields", async () => {
    const response = await authPost(request("/api/auth", undefined, { action: "register", name: "A", email: "a@example.test", password, role: "admin" })); expect(response.status).toBe(400);
    await expect(signIn("absent@example.test", password)).rejects.toThrow("Email or password is incorrect.");
  });
  it("rotates hashed session tokens and persists work across logout and session expiry", () => {
    const first = createStudio(), e = createEncounter("permanent", "case-01"); insertEncounter(first.id, e);
    const next = createAccountSession(first.userId); expect(next.token).not.toBe(first.token);
    expect(db().prepare("SELECT id FROM account_sessions WHERE id=?").get(first.token)).toBeUndefined();
    db().prepare("DELETE FROM account_sessions WHERE user_id=?").run(first.userId);
    const after = createAccountSession(first.userId); expect(loadEncounter(after.session.id, e.id).id).toBe(e.id);
    vi.useFakeTimers(); vi.advanceTimersByTime(86400001); expect(accountSession(after.token)).toBeNull();
    createSession(); expect(db().prepare("SELECT id FROM encounters WHERE id=?").get(e.id)).toBeDefined();
  });
  it("sets protected cookies and revokes the previous browser session on successful sign-in", async () => {
    const user = await registerAccount("Actor", "actor@example.test", password, true), old = createAccountSession(user.id);
    const response = await authPost(request("/api/auth", old.token, { action: "login", email: user.email, password }));
    expect(response.status).toBe(200); expect(accountSession(old.token)).toBeNull();
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=strict"); expect(cookie).toContain("Max-Age=86400");
    expect(await response.text()).not.toContain(password);
  });
  it("throttles repeated authentication attempts without accepting untrusted forwarding headers", async () => {
    for (let i = 0; i < 20; i++) await authPost(request("/api/auth", undefined, { action: "invalid" }));
    const response = await authPost(request("/api/auth", undefined, { action: "invalid" })); expect(response.status).toBe(429);
  });
  it("keeps pending accounts away from HTTP, print helper and studio access", () => {
    const pending = createStudio(); db().prepare("UPDATE users SET status='pending' WHERE id=?").run(pending.userId);
    expect(() => sessionFromCookie(`klinikaflow_account=${pending.token}`)).toThrow(/awaiting/);
    expect(() => requireStudio(pending)).toThrow(/awaiting/);
  });
  it("approves, suspends and restores with audit records; old sessions stay revoked", () => {
    const owner = admin(), target = createStudio(); db().prepare("UPDATE users SET status='pending' WHERE id=?").run(target.userId);
    expect(manageUser(owner, target.userId, "approve")).toMatchObject({ status: "active", approvedBy: owner.userId });
    expect(assertActive(target).user.status).toBe("active"); manageUser(owner, target.userId, "suspend");
    expect(accountSession(target.token)).toBeNull(); expect(() => loadEncounter(target.id, "anything")).toThrow(/access/);
    manageUser(owner, target.userId, "restore"); expect(accountSession(target.token)).toBeNull();
    expect(db().prepare("SELECT COUNT(*) AS n FROM account_audit WHERE target=?").get(target.userId)?.n).toBe(3);
    expect(() => manageUser(owner, owner.userId, "suspend")).toThrow(/sole active/);
  });
  it("isolates member and admin content and usage", async () => {
    const owner = admin(), member = createStudio(), e = createEncounter("private-text", "case-01"); insertEncounter(member.id, e);
    recordEstimatedCost("note", 0.1, member.userId); recordEstimatedCost("note", 0.2, owner.userId); recordEstimatedCost("historical", 0.3);
    expect(modelUsageSummary(member.userId).estimatedUsd).toBe(0.1); expect(modelUsageSummary(null).estimatedUsd).toBe(0);
    const directory = accountDirectory(owner); expect(directory.unattributedUsage?.calls).toBe(1);
    expect(JSON.stringify(directory)).not.toContain("private-text"); expect(JSON.stringify(directory)).not.toContain("Paracetamol");
    expect(() => loadEncounter(owner.id, e.id)).toThrow(/not found/);
    expect((await directoryGet(request("/api/admin/users", member.token))).status).toBe(403);
    expect((await directoryGet(request("/api/admin/users", owner.token))).status).toBe(200);
  });
  it("requires same origin and confirmation on sensitive admin changes", async () => {
    const owner = admin(), target = createStudio();
    expect((await adminPost(request("/api/admin/users", owner.token, { userId: target.userId, action: "suspend" }))).status).toBe(400);
    const cross = new NextRequest("http://localhost:3000/api/auth", { method: "POST", headers: { Origin: "https://evil.test" }, body: JSON.stringify({ action: "logout" }) }); expect((await authPost(cross)).status).toBe(403);
  });
  it("issues one-time expiring resets without storing raw tokens and revokes every session", async () => {
    const owner = admin(), target = createStudio(), reset = createReset(owner, target.userId);
    expect(JSON.stringify(db().prepare("SELECT * FROM password_resets").all())).not.toContain(reset.token);
    await resetPassword(reset.token, password); expect(accountSession(target.token)).toBeNull();
    await expect(resetPassword(reset.token, password)).rejects.toThrow(/invalid or expired/);
    expect((await signIn(target.user.email, password)).session.user.id).toBe(target.userId);
    const expired = createReset(owner, target.userId); vi.useFakeTimers(); vi.advanceTimersByTime(1800001);
    await expect(resetPassword(expired.token, password)).rejects.toThrow(/invalid or expired/);
  });
  it("changes password only with the current password and revokes all sessions", async () => {
    const user = await registerAccount("A", "a@example.test", password, true), session = createAccountSession(user.id);
    await expect(changePassword(session.session, "wrong", "another synthetic password")).rejects.toThrow(/incorrect/);
    await changePassword(session.session, password, "another synthetic password"); expect(accountSession(session.token)).toBeNull();
    await expect(signIn(user.email, password)).rejects.toThrow(/incorrect/);
    expect((await signIn(user.email, "another synthetic password")).session.user.id).toBe(user.id);
  });
});
describe("legacy migration and import", () => {
  it("only imports a valid owned browser workspace, exactly once, retaining idempotency and audio", async () => {
    const member = createStudio(), legacy = createSession(), other = createStudio(), e = createEncounter("legacy-case", "case-01");
    insertEncounter(legacy.id, e); db().prepare("UPDATE encounters SET audio=? WHERE id=?").run(Buffer.from("saved audio"), e.id);
    const job = beginJob(legacy.id, "old-key", "original-signature"); endJob(job.id, e);
    expect((await importPost(request("/api/account/import", member.token, { confirmed: true }))).status).toBe(409);
    importLegacy(member, legacy.id); expect(listEncounters(member.id)).toHaveLength(1); expect(loadAudio(member.id, e.id)?.toString()).toBe("saved audio");
    expect(beginJob(legacy.id, "old-key", "original-signature").cached?.id).toBe(e.id);
    expect(() => importLegacy(other, legacy.id)).toThrow(/already been imported/); expect(() => loadEncounter(other.id, e.id)).toThrow(/not found/);
    expect(db().prepare("SELECT user_id FROM reservations").all()).toEqual([]);
  });
  it("saved demo never inherits a signed-in account's live access or global usage", async () => {
    const member = createStudio(), demo = createSession(); recordEstimatedCost("historical", 1);
    const response = await sessionPost(request("/api/session", member.token, { mode: "demo" }, `klinikaflow_session=${demo.token}`)); const body = await response.json();
    expect(body.role).toBe("judge"); expect(body.modelUsage.actualUsd).toBe(0); expect(body.modelUsage.estimatedUsd).toBe(0);
    const context = sessionFromCookie(`klinikaflow_account=${member.token}; klinikaflow_session=${demo.token}; klinikaflow_mode=demo`); expect(context.role).toBe("judge"); expect(() => requireStudio(context)).toThrow(/approved account/);
    expect((await sessionPost(request("/api/session", undefined, { studioToken: "old-shared-secret" }))).status).toBe(400);
  });
  it("derives new reviewer identity from the account while retaining explicit approval", async () => {
    const owner = createStudio(), e = createEncounter("actor-case", "case-01"); insertEncounter(owner.id, e);
    const result = await act(owner, e.id, randomUUID(), { action: "consent", expectedVersion: 1, value: true, reviewer: "Impersonation" });
    expect(result.audit.at(-1)?.actorId).toBe(owner.userId);
    await expect(act(owner, e.id, randomUUID(), { action: "confirm-transcript", expectedVersion: result.version, confirmed: false, reviewer: "Impersonation" })).rejects.toThrow(/confirm/i);
    const confirmed = await act(owner, e.id, randomUUID(), { action: "confirm-transcript", expectedVersion: result.version, confirmed: true, reviewer: "Impersonation" }); expect(confirmed.transcriptConfirmation?.reviewer).toBe(owner.user.name);
  });
  it("checks ownership before cached results and rejects direct routes for another account", async () => {
    const owner = createStudio(), other = createStudio(), e = createEncounter("route-case", "case-01"); insertEncounter(owner.id, e);
    const context = { params: Promise.resolve({ id: e.id }) };
    expect((await encounterGet(request(`/api/encounters/${e.id}`, other.token), context)).status).toBe(404);
    expect((await encounterPost(request(`/api/encounters/${e.id}`, other.token, { action: "consent", expectedVersion: 1, value: true }), context)).status).toBe(404);
    expect(loadEncounter(owner.id, e.id).version).toBe(1);
  });
  it("rechecks access after an in-flight provider operation and still records attributed usage", async () => {
    const owner = admin(), target = createStudio(), e = createEncounter("suspend-inflight", "case-01"); e.consent = true; insertEncounter(target.id, e);
    const confirmed = await act(target, e.id, randomUUID(), { action: "confirm-transcript", expectedVersion: 1, confirmed: true });
    vi.stubEnv("MODEL_API_KEY", "mock-key"); vi.stubGlobal("fetch", vi.fn(async () => { manageUser(owner, target.userId, "suspend"); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: cases[0].claims }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })); }));
    await expect(act(target, e.id, randomUUID(), { action: "generate-note", expectedVersion: confirmed.version, provider: "live" })).rejects.toThrow(/access|session/);
    expect(db().prepare("SELECT user_id FROM reservations").get()?.user_id).toBe(target.userId);
    expect(db().prepare("SELECT version FROM encounters WHERE id=?").get(e.id)?.version).toBe(confirmed.version);
  });
});
