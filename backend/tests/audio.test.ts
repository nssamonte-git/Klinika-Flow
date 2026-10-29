import { describe, expect, it } from "vitest";
import { validateWav } from "../src/server/audio";
export function sampleWav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 32000); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
describe("WAV validation", () => {
  it("accepts 16-bit mono PCM", () => expect(validateWav(sampleWav()).durationSeconds).toBe(1));
  it("rejects renamed non-WAV audio", () => expect(() => validateWav(Buffer.alloc(100))).toThrow(/WAVE/));
  it("rejects stereo", () => { const b = sampleWav(); b.writeUInt16LE(2, 22); expect(() => validateWav(b)).toThrow(/mono/); });
  it("rejects a truncated container", () => expect(() => validateWav(sampleWav().subarray(0, 50))).toThrow(/length/));
  it("rejects audio longer than 10 minutes", () => expect(() => validateWav(sampleWav(601))).toThrow(/10 minutes/));
  it("rejects unsupported sample rates", () => { const b = sampleWav(); b.writeUInt32LE(48000, 24); expect(() => validateWav(b)).toThrow(/kHz/); });
});
