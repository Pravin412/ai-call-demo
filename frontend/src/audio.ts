/**
 * audio.ts — browser-side audio I/O
 *
 * Input:  microphone → AudioWorklet (16 kHz PCM16) → WebSocket
 * Output: WebSocket PCM24 chunks → AudioContext playback queue
 *
 * PRODUCTION TODO: For phone lines, swap AudioWorklet for an RTP/WebRTC track.
 */

const OUTPUT_SAMPLE_RATE = 24000; // Gemini Live outputs 24 kHz PCM16

export class AudioIO {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private playQueue: AudioBuffer[] = [];
  private playing = false;
  private interrupted = false;
  private muted = false;

  // Called when a PCM chunk is ready to send to the backend
  onMicChunk: ((buf: ArrayBuffer) => void) | null = null;

  async init(): Promise<void> {
    if (this.audioCtx) return;

    this.audioCtx = new AudioContext({ sampleRate: 48000 }); // Standard browser rate

    // Request microphone
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // Load the AudioWorklet processor
    await this.audioCtx.audioWorklet.addModule('/audio-processor.js');

    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'mic-processor');

    // Receive downsampled PCM16 chunks from the worklet
    this.workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!this.muted && this.onMicChunk) {
        this.onMicChunk(e.data);
      }
    };

    source.connect(this.workletNode);
    // Don't connect workletNode to destination — we only need the mic, not echo
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Queue a raw Int16 PCM buffer at OUTPUT_SAMPLE_RATE for gapless playback */
  queueAudio(raw: ArrayBuffer): void {
    if (!this.audioCtx) return;
    if (this.interrupted) return;

    const int16 = new Int16Array(raw);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = this.audioCtx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    this.playQueue.push(buffer);
    if (!this.playing) this.drainQueue();
  }

  private drainQueue(): void {
    if (!this.audioCtx || this.playQueue.length === 0 || this.interrupted) {
      this.playing = false;
      return;
    }

    this.playing = true;
    const buffer = this.playQueue.shift()!;
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);
    source.onended = () => this.drainQueue();
    source.start();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Stop all playback immediately (Gemini interruption signal) */
  interrupt(): void {
    this.interrupted = true;
    this.playQueue = [];
    this.playing = false;
    // Resume after a short gap so new audio can play
    setTimeout(() => {
      this.interrupted = false;
    }, 300);
  }

  destroy(): void {
    this.workletNode?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();
    this.audioCtx = null;
    this.stream = null;
    this.workletNode = null;
    this.playQueue = [];
    this.playing = false;
  }
}

/** Browser speech fallback — Web Speech API */
export class BrowserSpeech {
  private recognition: any = null;
  private suppressRestart = false;
  onResult: ((text: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  isSupported(): boolean {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  }

  start(): void {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return;

    this.suppressRestart = false;

    if (!this.recognition) {
      this.recognition = new Ctor();
      this.recognition.continuous = true;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-IN';

      this.recognition.onresult = (e: any) => {
        const text = e.results[e.results.length - 1][0].transcript.trim();
        if (text && this.onResult) this.onResult(text);
      };

      this.recognition.onerror = (e: any) => {
        // 'no-speech' just means a silent stretch; recognition restarts in onend
        if (e.error !== 'aborted' && e.error !== 'no-speech') console.error('[SpeechRecognition] error:', e.error);
      };

      this.recognition.onend = () => {
        if (this.onEnd) this.onEnd();
        if (!this.suppressRestart) {
          try {
            this.recognition?.start();
          } catch {
            /* already started */
          }
        }
      };
    }

    try {
      this.recognition.start();
    } catch {
      /* already started */
    }
    console.log('[SpeechRecognition] started, lang:', this.recognition.lang);
  }

  stop(): void {
    this.suppressRestart = true;
    this.recognition?.stop();
  }

  speak(text: string, onEnd?: () => void): void {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-IN';
    utter.rate = 0.95;
    if (onEnd) utter.onend = onEnd;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }
}
