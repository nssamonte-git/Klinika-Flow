class KlinikaPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.phase = 0; this.sum = 0; this.count = 0; this.frame = new Int16Array(1280); this.used = 0;
    this.port.onmessage = event => { if (event.data?.type === "flush") { this.emit(); this.port.postMessage({ type: "flushed" }); } };
  }
  emit() {
    if (!this.used) return;
    const bytes = this.frame.slice(0, this.used).buffer;
    this.port.postMessage({ type: "frame", bytes }, [bytes]);
    this.frame = new Int16Array(1280); this.used = 0;
  }
  process(inputs, outputs) {
    const samples = inputs[0]?.[0];
    if (samples) for (const sample of samples) {
      this.sum += sample; this.count++; this.phase += 16000 / sampleRate;
      if (this.phase >= 1) {
        const averaged = Math.max(-1, Math.min(1, this.sum / this.count));
        this.frame[this.used++] = Math.round(averaged * 32767);
        this.sum = 0; this.count = 0; this.phase -= 1;
        if (this.used === this.frame.length) this.emit();
      }
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor("klinika-pcm", KlinikaPcmProcessor);
