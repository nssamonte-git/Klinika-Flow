import { WorkflowError } from "../domain/workflow";
export function validateWav(buffer: Buffer): { durationSeconds: number; sampleRate: number } {
  if (buffer.length > 20_000_000 || buffer.length < 44) throw new WorkflowError("Use a mono PCM WAV under 10 minutes and 20 MB.", 400);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new WorkflowError("The recording must be a real RIFF/WAVE file.", 400);
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new WorkflowError("The WAV header length does not match the file.", 400);
  let format = false, sampleRate = 0, dataBytes = 0, offset = 12;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > buffer.length) throw new WorkflowError("Truncated WAV data.", 400);
    if (name === "fmt ") {
      if (size < 16) throw new WorkflowError("Invalid WAV format.", 400);
      sampleRate = buffer.readUInt32LE(start + 4);
      if (buffer.readUInt16LE(start) !== 1 || buffer.readUInt16LE(start + 2) !== 1 || buffer.readUInt16LE(start + 14) !== 16 || ![16000, 24000].includes(sampleRate) || buffer.readUInt16LE(start + 12) !== 2 || buffer.readUInt32LE(start + 8) !== sampleRate * 2) throw new WorkflowError("Use 16-bit mono PCM WAV at 16 or 24 kHz.", 400);
      format = true;
    }
    if (name === "data") dataBytes += size;
    offset = start + size + size % 2;
  }
  const durationSeconds = dataBytes / (sampleRate * 2);
  if (!format || !dataBytes || dataBytes % 2 || !Number.isFinite(durationSeconds) || durationSeconds > 600) throw new WorkflowError("The WAV must contain audio of 10 minutes or less.", 400);
  return { durationSeconds, sampleRate };
}
