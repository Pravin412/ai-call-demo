/**
 * AudioWorklet processor — runs on the audio rendering thread.
 * Downsamples from browser sample rate to 16 kHz and converts Float32 → Int16 PCM.
 * Sends raw PCM chunks to the main thread via MessagePort.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._targetRate = 16000;
    this._ratio = sampleRate / this._targetRate;
    this._sampleCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];

    // Simple decimation: pick every ratio-th sample
    for (let i = 0; i < channel.length; i++) {
      this._sampleCount++;
      if (this._sampleCount >= this._ratio) {
        this._sampleCount -= this._ratio;
        // Clamp and convert Float32 to Int16
        const s = Math.max(-1, Math.min(1, channel[i]));
        this._buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
    }

    // Send in ~20 ms chunks (320 samples at 16 kHz)
    if (this._buffer.length >= 320) {
      const chunk = new Int16Array(this._buffer.splice(0, 320));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
