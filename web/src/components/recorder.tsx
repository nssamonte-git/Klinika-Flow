"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload } from "lucide-react";
async function wav(blob: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const source = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.ceil(source.duration * 16000), 16000);
    const node = offline.createBufferSource(); node.buffer = source; node.connect(offline.destination); node.start();
    const samples = (await offline.startRendering()).getChannelData(0), bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
    const str = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    str(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true));
    return new Blob([bytes], { type: "audio/wav" });
  } finally { await context.close(); }
}
export default function Recorder({ disabled, onUpload, onError, prompt = "Record the synthetic script aloud, with two speakers if possible. Never record a patient.", maxSeconds = 590, maxBytes = 20_000_000, primary = false, label = "Record synthetic audio", onRecordingChange }: { disabled: boolean; onUpload: (blob: Blob) => Promise<void>; onError: (s: string) => void; prompt?: string; maxSeconds?: number; maxBytes?: number; primary?: boolean; label?: string; onRecordingChange?: (recording: boolean) => void }) {
  const [recording, setRecording] = useState(false), [converting, setConverting] = useState(false), [seconds, setSeconds] = useState(0);
  const activeChange = useRef(onRecordingChange); activeChange.current = onRecordingChange;
  const recorder = useRef<MediaRecorder | null>(null), stream = useRef<MediaStream | null>(null), timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(t => t.stop()); if (timer.current) clearInterval(timer.current); setRecording(false); };
  useEffect(() => () => { if (recorder.current) recorder.current.onstop = null; stream.current?.getTracks().forEach(t => t.stop()); if (timer.current) clearInterval(timer.current); activeChange.current?.(false); }, []);
  async function start() {
    try {
      activeChange.current?.(true);
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream.current); recorder.current = r; const chunks: Blob[] = [];
      r.ondataavailable = event => chunks.push(event.data);
      r.onstop = async () => { setConverting(true); try { await onUpload(await wav(new Blob(chunks, { type: r.mimeType }))); } catch { onError("Recording could not be converted. Try uploading a 16 kHz mono WAV."); } finally { setConverting(false); activeChange.current?.(false); } };
      r.start(1000); setSeconds(0); setRecording(true); let elapsed = 0;
      timer.current = setInterval(() => { elapsed++; setSeconds(elapsed); if (elapsed >= maxSeconds) stop(); }, 1000);
    } catch { activeChange.current?.(false); stream.current?.getTracks().forEach(t => t.stop()); onError("Microphone access is unavailable. Allow access on localhost or upload a synthetic WAV."); }
  }
  return <div className="recorder"><p>{prompt}</p><div className="button-row">
    <button className={recording ? "button danger" : primary ? "button primary" : "button secondary"} disabled={disabled || converting} onClick={recording ? stop : start}>{recording ? <Square size={16} /> : <Mic size={16} />}{recording ? `Stop · ${seconds}s` : converting ? "Converting to WAV…" : label}</button>
    <label className="button secondary file-button"><Upload size={16} /> Upload WAV<input type="file" accept=".wav,audio/wav" disabled={disabled || recording || converting} onChange={async event => { const file = event.target.files?.[0]; if (file) { if (file.size > maxBytes) onError(`Use a WAV file smaller than ${Math.floor(maxBytes / 1_000_000)} MB.`); else { activeChange.current?.(true); setConverting(true); try { await onUpload(file); } finally { setConverting(false); activeChange.current?.(false); } } } event.target.value = ""; }} /></label>
  </div></div>;
}
