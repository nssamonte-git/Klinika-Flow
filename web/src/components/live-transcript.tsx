"use client";
import { useEffect, useRef, useState } from "react";
import type { Encounter, Turn } from "@backend/domain/schema";

type Phase = "idle" | "connecting" | "recording" | "finishing" | "saved" | "interrupted";
function wav(chunks: Uint8Array[]): Blob {
  const length = chunks.reduce((n, chunk) => n + chunk.length, 0), header = new ArrayBuffer(44), view = new DataView(header);
  const write = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, length + 36, true); write(8, "WAVE"); write(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, length, true);
  return new Blob([header, ...chunks.map(chunk => new Uint8Array(chunk))], { type: "audio/wav" });
}
export default function LiveTranscript({ encounter: e, disabled, onSaved, onUploadFallback, onStreamingChange, onError }: {
  encounter: Encounter; disabled: boolean; onSaved: () => Promise<void>; onUploadFallback: (audio: Blob) => Promise<void>;
  onStreamingChange: (active: boolean) => void; onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle"), [seconds, setSeconds] = useState(0), [partial, setPartial] = useState(""), [finalized, setFinalized] = useState<Turn[]>([]);
  const [localAudio, setLocalAudio] = useState<Blob | null>(null), [localUrl, setLocalUrl] = useState<string | null>(null), [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const socket = useRef<WebSocket | null>(null), media = useRef<MediaStream | null>(null), context = useRef<AudioContext | null>(null), worklet = useRef<AudioWorkletNode | null>(null);
  const frames = useRef<Uint8Array[]>([]), timer = useRef<ReturnType<typeof setInterval> | null>(null), saved = useRef(false), finishing = useRef(false), local = useRef<Blob | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); media.current?.getTracks().forEach(track => track.stop()); socket.current?.close(); }, []);
  useEffect(() => () => { if (localUrl) URL.revokeObjectURL(localUrl); }, [localUrl]);
  useEffect(() => {
    if (!["connecting", "recording", "finishing"].includes(phase)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);
  async function stopMicrophone() {
    media.current?.getTracks().forEach(track => track.stop()); media.current = null;
    const node = worklet.current;
    if (node) await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 500);
      const handler = (event: MessageEvent) => { if (event.data?.type === "flushed") { clearTimeout(timeout); node.port.removeEventListener("message", handler); resolve(); } };
      node.port.addEventListener("message", handler); node.port.start(); node.port.postMessage({ type: "flush" });
    });
    worklet.current?.disconnect(); worklet.current = null;
    if (context.current) { await context.current.close().catch(() => undefined); context.current = null; }
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }
  function preserveAudio() {
    if (!local.current && frames.current.length) {
      local.current = wav(frames.current); setLocalAudio(local.current); setLocalUrl(URL.createObjectURL(local.current));
    }
  }
  async function stop(interrupted = false) {
    if (finishing.current) return; finishing.current = true; setPhase(interrupted ? "interrupted" : "finishing");
    await stopMicrophone(); preserveAudio();
    if (!interrupted && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "endStream" }));
    else { onStreamingChange(false); if (!saved.current) setPhase("interrupted"); }
  }
  async function startMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
    media.current = stream;
    const audioContext = new AudioContext(); context.current = audioContext;
    await audioContext.audioWorklet.addModule("/pcm-worklet.js");
    const source = audioContext.createMediaStreamSource(stream), node = new AudioWorkletNode(audioContext, "klinika-pcm"); worklet.current = node;
    node.port.onmessage = event => {
      if (event.data?.type !== "frame") return;
      const bytes = new Uint8Array(event.data.bytes); frames.current.push(bytes);
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN && !finishing.current) {
        if (ws.bufferedAmount > 160_000) { onError("Streaming fell behind. The local WAV is available for explicit upload."); void stop(true); ws.close(); }
        else ws.send(bytes.buffer);
      }
    };
    source.connect(node); node.connect(audioContext.destination); await audioContext.resume();
    const started = Date.now(); timer.current = setInterval(() => { const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(elapsed); if (elapsed >= 600) void stop(); }, 1000);
    setPhase("recording");
  }
  function start() {
    frames.current = []; local.current = null; saved.current = false; finishing.current = false;
    if (localUrl) URL.revokeObjectURL(localUrl); setLocalUrl(null); setLocalAudio(null); setPartial(""); setFinalized([]); setSeconds(0);
    setPhase("connecting"); onStreamingChange(true);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/api/realtime/transcribe?encounterId=${encodeURIComponent(e.id)}&expectedVersion=${e.version}&synthetic=true`;
    const ws = new WebSocket(url); socket.current = ws;
    ws.onmessage = event => {
      let message: Record<string, unknown>; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "ready") { void startMicrophone().catch(() => { onError("Microphone access is unavailable. Use the recorded WAV path or allow access."); ws.close(); }); }
      else if (message.type === "transcript" && message.final !== true) setPartial(String(message.transcript ?? ""));
      else if (message.type === "speechComplete") {
        setPartial("");
        const turn: Turn = { id: String(message.turnId ?? ""), text: String(message.transcript ?? ""), startMs: Number(message.startMs ?? 0), endMs: Number(message.endMs ?? 0), speaker: "unknown", ...(message.speaker ? { providerSpeaker: String(message.speaker) } : {}) };
        setFinalized(current => [...current.filter(t => t.id !== turn.id), turn].sort((a, b) => a.startMs - b.startMs));
      } else if (message.type === "saved") { saved.current = true; setPhase("saved"); onStreamingChange(false); void onSaved(); }
      else if (message.type === "stream-error") onError("Live transcription was interrupted. The existing encounter is unchanged; save the local WAV to recover.");
    };
    ws.onerror = () => onError("The live connection failed. The recorded WAV path remains available.");
    ws.onclose = () => { if (!saved.current) { if (finishing.current) { preserveAudio(); setPhase("interrupted"); onStreamingChange(false); } else void stop(true); } };
  }
  const active = phase === "connecting" || phase === "recording" || phase === "finishing";
  return <section className="source-note" aria-label="Live transcript"><strong>Live Meta transcription · optional</strong><p>Provisional words are only a preview. Finalized turns and audio save together after Stop; a human must still confirm the transcript and speaker roles.</p>
    {e.claims.length > 0 && <label className="checkbox-line"><input type="checkbox" checked={replaceConfirmed} disabled={active || disabled} onChange={event => setReplaceConfirmed(event.target.checked)} />A successful new recording replaces the current source and clears dependent reviews.</label>}
    <div className="button-row"><button className="button secondary" disabled={disabled || active || (e.claims.length > 0 && !replaceConfirmed)} onClick={start}>Start live microphone · paid stream</button><button className="button secondary" disabled={phase !== "recording"} onClick={() => void stop()}>Stop and save finalized turns</button><span>{seconds}s · {phase}</span></div>
    {partial && <p aria-live="polite"><strong>Provisional:</strong> {partial}</p>}
    {finalized.length > 0 && <ol>{finalized.map(turn => <li key={turn.id}><span className="source-id">{turn.providerSpeaker ? `Voice ${turn.providerSpeaker}` : "Unlabelled"}</span> {turn.text}</li>)}</ol>}
    {localAudio && localUrl && <div><p>Local synthetic WAV retained for recovery. Upload is an explicit action; no paid fallback starts automatically.</p><audio controls src={localUrl} /><div className="button-row"><a className="button secondary" href={localUrl} download={`synthetic-${e.id}.wav`}>Download WAV</a>{phase === "interrupted" && <button className="button secondary" onClick={() => void onUploadFallback(localAudio)}>Save WAV to encounter</button>}</div></div>}
  </section>;
}
