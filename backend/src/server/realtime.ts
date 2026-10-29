import { assertActive, type AccountSession } from "./accounts";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { requireStudio, sessionFromCookie } from "./auth-core";
import { loadEncounter, rateLimit, recordEstimatedCost, saveEncounterWithAudio, updateEstimatedCost } from "./db-core";
import { fingerprint, invalidate, WorkflowError } from "../domain/workflow";
import { MODEL, PRICING } from "../domain/model-ids";
import type { Turn } from "../domain/schema";
import { validateWav } from "./audio";

const PATH = "/api/realtime/transcribe";
const SAMPLE_RATE = 16_000, BYTES_PER_SECOND = SAMPLE_RATE * 2, MAX_SECONDS = 600;
type UpstreamFactory = (url: string) => WebSocket;
type Options = { connectUpstream?: UpstreamFactory; maxDurationMs?: number; maxConcurrent?: number };
type FinalTurn = { key: string; startMs: number; endMs: number; text: string; speaker?: string; completed: boolean };

function expectedOrigin(req: IncomingMessage) {
  return process.env.APP_ORIGIN || `${(req.socket as Duplex & { encrypted?: boolean }).encrypted ? "https" : "http"}://${req.headers.host}`;
}
export function validateRealtimeUpgrade(req: IncomingMessage) {
  if (process.env.ENABLE_REALTIME_TRANSCRIPTION !== "true") throw new WorkflowError("Realtime transcription is disabled.", 403);
  if (!process.env.MODEL_API_KEY) throw new WorkflowError("Meta API key is not configured.", 503);
  if (!req.headers.origin || req.headers.origin !== expectedOrigin(req) || req.headers["sec-fetch-site"] === "cross-site") throw new WorkflowError("Only this app may open a stream.", 403);
  const owner = sessionFromCookie(req.headers.cookie);
  requireStudio(owner);
  const url = new URL(req.url || "", expectedOrigin(req));
  if (url.pathname !== PATH || url.searchParams.get("synthetic") !== "true") throw new WorkflowError("Confirm synthetic actor audio before streaming.", 400);
  const encounterId = url.searchParams.get("encounterId") || "", version = Number(url.searchParams.get("expectedVersion"));
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(encounterId) || !Number.isInteger(version) || version < 1) throw new WorkflowError("Select a valid encounter version.", 400);
  const encounter = loadEncounter(owner.id, encounterId);
  if (!encounter.consent || encounter.version !== version) throw new WorkflowError("Confirm consent and reload the current encounter before streaming.");
  rateLimit(`realtime:${owner.id}`, 10, 60_000);
  return { owner, encounterId, version };
}
function reject(socket: Duplex, status: number) {
  const reason = status === 401 ? "Unauthorized" : status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Forbidden";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function wavFromPcm(chunks: Buffer[]): Buffer {
  const bytes = Buffer.concat(chunks), wav = Buffer.alloc(44 + bytes.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24); wav.writeUInt32LE(BYTES_PER_SECOND, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(bytes.length, 40); bytes.copy(wav, 44);
  validateWav(wav); return wav;
}
function safeText(value: unknown, max = 3000) { return typeof value === "string" && value.length <= max ? value : ""; }
function toBuffer(data: RawData) { return Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data); }

export function createRealtimeGateway(server: Server, options: Options = {}) {
  const incoming = new WebSocketServer({ noServer: true, maxPayload: 32_000, perMessageDeflate: false });
  const active = new Map<string, WebSocket>();
  const connect = options.connectUpstream ?? ((url: string) => new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 30_000 }));
  const maxDurationMs = options.maxDurationMs ?? MAX_SECONDS * 1000;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || "", expectedOrigin(req)); } catch { return; }
    if (url.pathname !== PATH) return;
    let authorized: ReturnType<typeof validateRealtimeUpgrade>;
    try {
      authorized = validateRealtimeUpgrade(req);
      if (active.has(authorized.encounterId) || active.size >= maxConcurrent) throw new WorkflowError("A stream is already active or the gateway is full.", 429);
    } catch (error) { reject(socket, error instanceof WorkflowError ? error.status : 403); return; }
    incoming.handleUpgrade(req, socket, head, client => {
      active.set(authorized.encounterId, client);
      handleStream(client, authorized, () => active.delete(authorized.encounterId));
    });
  };
  function handleStream(client: WebSocket, authorized: ReturnType<typeof validateRealtimeUpgrade>, release: () => void) {
    const streamId = randomUUID(), chunks: Buffer[] = [], turns = new Map<string, FinalTurn>();
    let currentTurn: string | null = null, audioBytes = 0, ready = false, ended = false, clean = false, released = false, clientAlive = true;
    const reservation = recordEstimatedCost("realtime-transcription", MAX_SECONDS / 3600 * PRICING.voicePerHour, authorized.owner.userId);
    const upstream = connect("wss://api.meta.ai/v1/asr/realtime");
    const send = (message: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
    const cleanup = () => { if (released) return; released = true; clearTimeout(timer); clearInterval(accessTimer); release(); updateEstimatedCost(reservation, Math.max(0.001, audioBytes / BYTES_PER_SECOND / 3600 * PRICING.voicePerHour)); };
    const stopWithError = (code: string) => { if (released) return; send({ type: "stream-error", code, recoverableAudio: true }); if (upstream.readyState === WebSocket.OPEN) upstream.close(); else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); if (client.readyState === WebSocket.OPEN) client.close(1011, code.slice(0, 60)); cleanup(); };
    const checkAccess = () => { try { assertActive(authorized.owner as AccountSession); return true; } catch { stopWithError("access-revoked"); return false; } };
    const accessTimer = setInterval(checkAccess, 500);
    const timer = setTimeout(() => stopWithError("duration-limit"), maxDurationMs);
    upstream.on("open", () => upstream.send(JSON.stringify({ authorization: { accessToken: `Bearer ${process.env.MODEL_API_KEY}` }, audioEncoding: "PCM_16KHZ", model: MODEL.voice, mode: "DIARIZATION", partialMode: "CUMULATIVE", emitAudioProgress: true, languageBias: ["Tagalog", "English"], keywords: ["Paracetamol", "Cetirizine"] })));
    upstream.on("message", (data, binary) => {
      if (!checkAccess()) return;
      if (binary || toBuffer(data).length > 16_000) return stopWithError("invalid-provider-event");
      let event: Record<string, unknown>;
      try { event = JSON.parse(data.toString()); } catch { return stopWithError("invalid-provider-event"); }
      if (typeof event.sessionId === "string" && !ready) { ready = true; send({ type: "ready", streamId }); return; }
      if (!ready) return stopWithError("invalid-provider-handshake");
      const processed = Number(event.audioProcessedMs);
      const ms = Number.isFinite(processed) && processed >= 0 ? Math.min(processed, MAX_SECONDS * 1000) : 0;
      if (event.type === "error") return stopWithError("provider-error");
      if (event.type === "speechStart") {
        const key = String(event.turnId ?? ""); if (!key || key.length > 40 || turns.size >= 100) return stopWithError("turn-limit");
        currentTurn = key; turns.set(key, { key, startMs: ms, endMs: ms, text: "", completed: false });
        send({ type: "speechStart", turnId: key, audioProcessedMs: ms });
      } else if (event.type === "speaker") {
        const label = safeText(event.label, 40); if (currentTurn && label && turns.has(currentTurn)) turns.get(currentTurn)!.speaker = label;
        if (label) send({ type: "speaker", label, audioProcessedMs: ms });
      } else if (event.type === "transcript") {
        const transcript = safeText(event.transcript); if (transcript) send({ type: "transcript", transcript, final: event.final === true, audioProcessedMs: ms });
      } else if (event.type === "speechEnd") {
        send({ type: "speechEnd", turnId: String(event.turnId ?? ""), audioProcessedMs: ms });
      } else if (event.type === "speechComplete") {
        const key = String(event.turnId ?? ""), turn = turns.get(key), transcript = safeText(event.transcript);
        if (!turn || !transcript) return stopWithError("invalid-final-turn");
        turn.text = transcript; turn.endMs = Math.max(turn.startMs, ms); turn.completed = true;
        if (currentTurn === key) currentTurn = null;
        send({ type: "speechComplete", turnId: key, transcript, speaker: turn.speaker ?? null, startMs: turn.startMs, endMs: turn.endMs });
      } else if (event.type === "audioProgress") send({ type: "audioProgress", audioProcessedMs: ms });
    });
    upstream.on("error", () => stopWithError("provider-connection"));
    upstream.on("close", code => {
      if (released) return;
      if (!ended || code !== 1000 || !clientAlive) return stopWithError("stream-interrupted");
      try {
        const finalized = [...turns.values()].filter(t => t.completed && t.text).sort((a, b) => a.startMs - b.startMs);
        if (!finalized.length || !audioBytes) throw new WorkflowError("No finalized speech was received.");
        assertActive(authorized.owner as AccountSession);
        const previous = loadEncounter(authorized.owner.id, authorized.encounterId);
        if (previous.version !== authorized.version) throw new WorkflowError("This encounter changed during streaming. The local WAV remains available.");
        const audio = wavFromPcm(chunks);
        const e = invalidate(previous, "transcript");
        e.turns = finalized.map((t, i): Turn => ({ id: `t${i + 1}`, speaker: "unknown", text: t.text, startMs: t.startMs, endMs: t.endMs, ...(t.speaker ? { providerSpeaker: t.speaker } : {}) }));
        e.audioAvailable = true; e.mode = "live"; e.recordingFingerprint = fingerprint(audio.toString("base64")); e.speakerMapping = null; e.version++;
        e.provenance.transcript = `Realtime ${MODEL.voice} transcription · stream ${streamId} · estimated $${(audioBytes / BYTES_PER_SECOND / 3600 * PRICING.voicePerHour).toFixed(5)}; actual usage unavailable. Human transcript and role confirmation required.`;
        e.audit = [...e.audit, { actorId: authorized.owner.userId, action: "realtime-transcribe", at: new Date().toISOString(), version: e.version }].slice(-100);
        saveEncounterWithAudio(authorized.owner.id, previous.version, e, audio);
        clean = true; send({ type: "saved", streamId, version: e.version, finalizedTurns: e.turns.length });
        client.close(1000, "saved"); cleanup();
      } catch { stopWithError("save-conflict-or-invalid-audio"); }
    });
    client.on("message", (data, binary) => {
      if (!checkAccess()) return;
      if (binary) {
        if (!ready || ended || upstream.readyState !== WebSocket.OPEN) return stopWithError("not-ready");
        const frame = toBuffer(data);
        audioBytes += frame.length;
        if (!frame.length || frame.length % 2 || audioBytes > MAX_SECONDS * BYTES_PER_SECOND || audioBytes > (Date.now() - startedAt + 5000) / 1000 * BYTES_PER_SECOND) return stopWithError("audio-limit");
        chunks.push(frame); upstream.send(frame, { binary: true });
        return;
      }
      if (toBuffer(data).length > 1000 || ended) return stopWithError("invalid-control");
      try { const control = JSON.parse(data.toString()); if (control.type !== "endStream" || !ready || !audioBytes) throw new Error("invalid"); ended = true; upstream.send(JSON.stringify({ type: "endStream" })); }
      catch { stopWithError("invalid-control"); }
    });
    client.on("close", () => { clientAlive = false; if (!clean && upstream.readyState === WebSocket.OPEN) upstream.close(); cleanup(); });
    client.on("error", () => { clientAlive = false; if (upstream.readyState === WebSocket.OPEN) upstream.close(); cleanup(); });
    const startedAt = Date.now();
  }
  server.on("upgrade", onUpgrade);
  return { activeCount: () => active.size, close: () => { server.off("upgrade", onUpgrade); for (const socket of active.values()) socket.close(1001, "server-stopping"); incoming.close(); } };
}
