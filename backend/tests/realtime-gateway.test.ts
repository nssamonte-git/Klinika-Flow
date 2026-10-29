import { createStudio } from "./account-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { createEncounter } from "../src/domain/workflow";
import { createRealtimeGateway } from "../src/server/realtime";
import { closeDb, createSession, db, insertEncounter, loadEncounter, modelUsageSummary } from "../src/server/db";
import { ACCOUNT_COOKIE as COOKIE } from "../src/server/accounts";

let server: Server, provider: WebSocketServer, gateway: ReturnType<typeof createRealtimeGateway>;
let origin: string, providerUrl: string;
beforeEach(async () => {
  closeDb(); process.env.DATABASE_PATH = ":memory:";
  vi.stubEnv("ALLOW_LIVE_MODE", "true"); vi.stubEnv("ENABLE_REALTIME_TRANSCRIPTION", "true"); vi.stubEnv("MODEL_API_KEY", "test-model-key");
  provider = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => provider.once("listening", resolve));
  providerUrl = `ws://127.0.0.1:${(provider.address() as { port: number }).port}`;
  provider.on("connection", socket => socket.on("message", (data, binary) => {
    if (binary) return;
    const message = JSON.parse(data.toString());
    if (message.authorization) socket.send(JSON.stringify({ sessionId: "synthetic-provider" }));
    if (message.type === "endStream") {
      for (const event of [
        { type: "speechStart", turnId: 1, audioProcessedMs: 0 },
        { type: "speaker", label: "A", audioProcessedMs: 20 },
        { type: "transcript", transcript: "partial words", final: false, audioProcessedMs: 50 },
        { type: "speechEnd", turnId: 1, audioProcessedMs: 100 },
        { type: "speechComplete", turnId: 1, transcript: "Final synthetic words.", audioProcessedMs: 100 },
      ]) socket.send(JSON.stringify(event));
      socket.close(1000);
    }
  }));
  server = createServer((_req, res) => { res.writeHead(200); res.end("HTTP remains available"); });
  gateway = createRealtimeGateway(server, { connectUpstream: () => new WebSocket(providerUrl), maxDurationMs: 1500 });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { gateway?.close(); if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); if (provider) await new Promise<void>(resolve => provider.close(() => resolve())); closeDb(); vi.unstubAllEnvs(); });
function connect(token: string, id: string, version: number, suppliedOrigin = origin) {
  return new WebSocket(`${origin.replace("http", "ws")}/api/realtime/transcribe?encounterId=${id}&expectedVersion=${version}&synthetic=true`, { headers: { Origin: suppliedOrigin, Cookie: `${COOKIE}=${token}` } });
}
function event(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${type}`)), 3000);
    const handler = (data: WebSocket.RawData) => { const message = JSON.parse(data.toString()); if (message.type === type) { clearTimeout(timer); socket.off("message", handler); resolve(message); } };
    socket.on("message", handler);
  });
}
describe("same-origin realtime gateway", () => {
  it("rejects cross-origin and unauthorized upgrades", async () => {
    const owner = createStudio(), e = createEncounter("stream-owner", "case-01"); e.consent = true; insertEncounter(owner.id, e);
    await expect(new Promise((_, reject) => connect(owner.token, e.id, e.version, "https://evil.example").once("error", reject))).rejects.toThrow(/403/);
    const other = createStudio();
    await expect(new Promise((_, reject) => connect(other.token, e.id, e.version).once("error", reject))).rejects.toThrow(/404|403/);
    db().prepare("UPDATE account_sessions SET expires=? WHERE id=?").run(Date.now() - 1, owner.sessionId);
    await expect(new Promise((_, reject) => connect(owner.token, e.id, e.version).once("error", reject))).rejects.toThrow(/401/);
  });
  it("preserves finalized turns and audio atomically while leaving HTTP available", async () => {
    const owner = createStudio(), e = createEncounter("stream-valid", "case-01"); e.consent = true; insertEncounter(owner.id, e);
    const socket = connect(owner.token, e.id, e.version), ready = event(socket, "ready"); await ready;
    expect(gateway.activeCount()).toBe(1);
    const partial = event(socket, "transcript"), saved = event(socket, "saved");
    socket.send(Buffer.alloc(3200)); socket.send(JSON.stringify({ type: "endStream" }));
    expect((await partial).transcript).toBe("partial words");
    expect((await saved).finalizedTurns).toBe(1);
    const current = loadEncounter(owner.id, e.id);
    expect(current.version).toBe(e.version + 1); expect(current.turns[0]).toMatchObject({ speaker: "unknown", providerSpeaker: "A", text: "Final synthetic words." });
    expect(current.audioAvailable).toBe(true);
    expect(modelUsageSummary().unknownCalls).toBeGreaterThan(0);
    expect(await (await fetch(origin)).text()).toBe("HTTP remains available");
  });
  it("rejects a second concurrent stream and leaves the encounter untouched on disconnect", async () => {
    const owner = createStudio(), e = createEncounter("stream-disconnect", "case-01"); e.consent = true; insertEncounter(owner.id, e);
    const socket = connect(owner.token, e.id, e.version); await event(socket, "ready");
    await expect(new Promise((_, reject) => connect(owner.token, e.id, e.version).once("error", reject))).rejects.toThrow(/429/);
    socket.send(Buffer.alloc(3200)); socket.close();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(loadEncounter(owner.id, e.id).version).toBe(e.version);
  });
  it("stops active streams when account sessions are revoked and preserves recoverable work", async () => {
    const owner = createStudio(), e = createEncounter("stream-revoked", "case-01"); e.consent = true; insertEncounter(owner.id, e);
    const socket = connect(owner.token, e.id, e.version); await event(socket, "ready");
    const failure = event(socket, "stream-error");
    db().prepare("DELETE FROM account_sessions WHERE user_id=?").run(owner.userId);
    expect((await failure).code).toBe("access-revoked");
    expect(loadEncounter(owner.id, e.id).version).toBe(e.version);
    expect(db().prepare("SELECT user_id FROM reservations").get()?.user_id).toBe(owner.userId);
  });
  it("stops at the duration limit without saving partial speech", async () => {
    const owner = createStudio(), e = createEncounter("stream-duration", "case-01"); e.consent = true; insertEncounter(owner.id, e);
    const socket = connect(owner.token, e.id, e.version); await event(socket, "ready");
    const failure = await event(socket, "stream-error");
    expect(failure.code).toBe("duration-limit");
    expect(loadEncounter(owner.id, e.id).version).toBe(e.version);
  });
});
