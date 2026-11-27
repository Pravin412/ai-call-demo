/**
 * VoiceAiService — client for the Python voice AI service (Whisper + Llama 3.2 + XTTS-v2 on Google Colab).
 *
 * The service URL and key stay on the backend; the frontend only ever talks to /api/v1/voice-ai/*.
 * Uploaded audio is held in memory for the duration of the request and never written to disk.
 * The voice sample is optional per request when VOICE_AI_VOICE_SAMPLE_PATH points at an authorised sample on the server.
 */

import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { Readable } from 'stream';
import { UploadedAudioFile, VoiceAiAudio, VoiceAiHealth } from './interfaces/voice-ai.interfaces';

const HEALTH_TIMEOUT_MS = 10_000;
const PROCESS_TIMEOUT_MS = 180_000; // Whisper + Llama + XTTS on a Colab GPU can take a while
const AUDIO_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const SPEAK_TIMEOUT_MS = 120_000;

const MISSING_ENDPOINT_MESSAGE =
  'Voice AI service does not support Colab calls yet. Add the /transcribe and /speak endpoints to the notebook.';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // per file

// Request IDs go into the upstream URL path, so only allow plain ID characters
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ALLOWED_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
  'audio/mp4',
  'audio/x-m4a',
  // Generic label from clients that don't know the extension (curl.exe sends this for .wav); the header bytes decide
  'application/octet-stream',
]);

// MIME type to send upstream for each format detectAudioFormat() recognises
const AUDIO_MIME_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
};

@Injectable()
export class VoiceAiService {
  private readonly logger = new Logger(VoiceAiService.name);

  async checkHealth(): Promise<VoiceAiHealth> {
    const res = await this.request('/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
    if (!res.ok) throw new ServiceUnavailableException('Voice AI service is unhealthy.');

    const body = await this.readJson(res);
    if (typeof body?.status !== 'string') throw new BadGatewayException('Invalid response from voice AI service.');
    return body;
  }

  async processVoice(
    audio: UploadedAudioFile | undefined,
    voiceSample: UploadedAudioFile | undefined,
    language = 'en',
  ): Promise<any> {
    this.validateAudioFile(audio, 'audio');
    voiceSample ??= await this.loadDefaultVoiceSample();
    this.validateAudioFile(voiceSample, 'voice_sample');

    const form = new FormData();
    form.append('audio', toBlob(audio), audio.originalname || 'audio');
    form.append('voice_sample', toBlob(voiceSample), voiceSample.originalname || 'voice_sample');
    form.append('language', language);

    this.logger.log(
      `Processing voice: audio ${audio.size} B, voice sample ${voiceSample.size} B, language ${language}`,
    );
    const res = await this.request('/api/v1/voice/process', { method: 'POST', body: form }, PROCESS_TIMEOUT_MS);

    if (res.status === 400 || res.status === 422) {
      throw new BadRequestException('Voice AI service rejected the request. Check the audio files and language.');
    }
    if (!res.ok) throw new BadGatewayException('Voice AI processing failed.');

    // The Python service reports failures as 200 {"error": "..."}
    const body = await this.readJson(res);
    if (typeof body?.error === 'string') {
      if (/no speech/i.test(body.error)) throw new BadRequestException('No speech detected in the recording.');
      if (/language/i.test(body.error)) throw new BadRequestException('Unsupported language.');
      this.logger.warn(`Voice AI /process reported: ${body.error}`);
      throw new BadGatewayException('Voice AI processing failed.');
    }
    return body;
  }

  // Colab-voiced calls: speech → text only (Whisper). wav = one customer turn.
  async transcribe(wav: Buffer): Promise<string> {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'turn.wav');

    const res = await this.request('/api/v1/voice/transcribe', { method: 'POST', body: form }, TRANSCRIBE_TIMEOUT_MS);
    if (res.status === 404) throw new ServiceUnavailableException(MISSING_ENDPOINT_MESSAGE);
    if (!res.ok) throw new BadGatewayException('Speech recognition failed.');

    const body = await this.readJson(res);
    if (typeof body?.text !== 'string') {
      if (body?.error) this.logger.warn(`Voice AI /transcribe reported: ${body.error}`);
      throw new BadGatewayException('Speech recognition failed.');
    }
    return body.text;
  }

  // Colab-voiced calls: text → speech only (XTTS-v2), in the server-side authorised voice. Returns WAV bytes.
  async speak(text: string, language = 'en'): Promise<Buffer> {
    const voiceSample = await this.loadDefaultVoiceSample();
    if (!voiceSample) {
      this.logger.error('VOICE_AI_VOICE_SAMPLE_PATH is not set; Colab-voiced calls need a voice sample');
      throw new ServiceUnavailableException('No voice sample is configured for Colab calls.');
    }
    this.validateAudioFile(voiceSample, 'voice_sample');

    const form = new FormData();
    form.append('text', text);
    form.append('language', language);
    form.append('voice_sample', toBlob(voiceSample), voiceSample.originalname || 'voice_sample');

    const res = await this.request('/api/v1/voice/speak', { method: 'POST', body: form }, SPEAK_TIMEOUT_MS);
    if (res.status === 404) throw new ServiceUnavailableException(MISSING_ENDPOINT_MESSAGE);
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio/')) {
      throw new BadGatewayException('Audio generation failed.');
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async getAudio(requestId: string): Promise<VoiceAiAudio> {
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new BadRequestException('Invalid request ID.');

    const res = await this.request(
      `/api/v1/voice/audio/${encodeURIComponent(requestId)}`,
      { method: 'GET' },
      AUDIO_TIMEOUT_MS,
    );
    if (res.status === 404) throw new NotFoundException('Audio not found.');
    if (!res.ok) throw new BadGatewayException('Audio generation failed.');

    const contentType = res.headers.get('content-type') ?? '';
    // The Python service currently answers a missing ID with 200 {"error": "Audio not found"}
    if (contentType.includes('application/json')) {
      const body = await res.json().catch(() => null);
      if (/not found/i.test(body?.error ?? '')) throw new NotFoundException('Audio not found.');
    }
    if (!contentType.startsWith('audio/') || !res.body) {
      this.logger.warn(`Voice AI audio ${requestId} came back as "${contentType}", not audio`);
      throw new BadGatewayException('Audio generation failed.');
    }

    return {
      stream: Readable.fromWeb(res.body as any),
      contentType,
      contentLength: Number(res.headers.get('content-length')) || undefined,
    };
  }

  // Authorised voice sample kept on the server (VOICE_AI_VOICE_SAMPLE_PATH), used when the request doesn't upload one.
  // Read per request so the file can be swapped without a restart. It goes through the same validation as uploads.
  private async loadDefaultVoiceSample(): Promise<UploadedAudioFile | undefined> {
    const path = process.env.VOICE_AI_VOICE_SAMPLE_PATH;
    if (!path) return undefined;

    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (err: any) {
      this.logger.error(`Cannot read VOICE_AI_VOICE_SAMPLE_PATH: ${err?.code ?? err?.message}`);
      throw new ServiceUnavailableException('Default voice sample is not configured correctly.');
    }
    return {
      fieldname: 'voice_sample',
      originalname: basename(path),
      mimetype: AUDIO_MIME_TYPES[detectAudioFormat(buffer)] ?? 'application/octet-stream',
      size: buffer.length,
      buffer,
    };
  }

  // Multer already enforces MAX_UPLOAD_BYTES; this covers direct callers and checks content
  private validateAudioFile(file: UploadedAudioFile | undefined, field: string): void {
    if (!file) throw new BadRequestException(`${field} file is required.`);
    if (file.size === 0) throw new BadRequestException(`${field} file is empty.`);
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(`${field} file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }

    // The MIME type is whatever the client claims, so also check the file's own header bytes
    const mimeType = file.mimetype.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeType) || !detectAudioFormat(file.buffer)) {
      throw new UnsupportedMediaTypeException(`${field} must be a WAV, MP3, OGG, WebM, FLAC or M4A audio file.`);
    }
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const baseUrl = (process.env.VOICE_AI_BASE_URL ?? '').replace(/\/+$/, '');
    if (!baseUrl) {
      this.logger.error('VOICE_AI_BASE_URL is not set');
      throw new ServiceUnavailableException('Voice AI service is not configured.');
    }

    const headers: Record<string, string> = { 'ngrok-skip-browser-warning': 'true' };
    if (process.env.VOICE_AI_API_KEY) headers['X-API-Key'] = process.env.VOICE_AI_API_KEY;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
      if (err?.name === 'TimeoutError') {
        this.logger.warn(`Voice AI ${path} timed out after ${timeoutMs} ms`);
        throw new GatewayTimeoutException('Voice AI service timed out.');
      }
      this.logger.warn(`Voice AI ${path} unreachable: ${err?.cause?.code ?? err?.message}`);
      throw new ServiceUnavailableException('Voice AI service is unavailable.');
    }

    // ngrok answers by itself when the Colab side is gone, e.g. ERR_NGROK_3200 "endpoint offline"
    const ngrokError = res.headers.get('ngrok-error-code');
    if (ngrokError) {
      this.logger.warn(`Voice AI tunnel error ${ngrokError} on ${path}`);
      throw new ServiceUnavailableException(
        'Voice AI service is offline. The Colab notebook or its ngrok tunnel may have stopped.',
      );
    }

    if (!res.ok) this.logger.warn(`Voice AI ${path} returned ${res.status}`);
    return res;
  }

  private async readJson(res: Response): Promise<any> {
    try {
      return await res.json();
    } catch {
      throw new BadGatewayException('Invalid response from voice AI service.');
    }
  }
}

function toBlob(file: UploadedAudioFile): Blob {
  return new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
}

// Identify an audio container from its first bytes; null if it isn't one we accept
function detectAudioFormat(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null;
  const ascii = (start: number, end: number) => buf.toString('latin1', start, end);

  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm'; // Matroska/WebM (browser MediaRecorder)
  if (ascii(4, 8) === 'ftyp') return 'm4a';
  return null;
}
