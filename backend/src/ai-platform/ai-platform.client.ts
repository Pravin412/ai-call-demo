import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

// Calls the AI Platform. The API key stays on the server; the browser never sees it.
// On CPU a voice turn can take 10-60 s, so the timeout is generous.
const TIMEOUT_MS = 180_000;

export type Channel = 'chat' | 'whatsapp' | 'telegram' | 'sms' | 'email' | 'voice';
export type AudioFormat = 'wav' | 'ogg_opus' | 'mp3';

@Injectable()
export class AiPlatformClient {
  private readonly logger = new Logger(AiPlatformClient.name);
  private readonly baseUrl = (process.env.AI_PLATFORM_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  private readonly apiKey = process.env.AI_PLATFORM_API_KEY || '';

  // Text in, reply out. Set replyAudio to also get the reply spoken.
  chat(sessionId: string, message: string, channel: Channel = 'chat', replyAudio?: AudioFormat) {
    return this.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        message,
        channel,
        ...(replyAudio ? { reply_audio: replyAudio } : {}),
      }),
    });
  }

  // Recording in (any common format), transcript + reply + spoken reply out.
  voice(sessionId: string, audio: Buffer, contentType: string, audioFormat: AudioFormat = 'wav') {
    const query = new URLSearchParams({ session_id: sessionId, audio_format: audioFormat });
    return this.request(`/api/v1/audio/chat?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(audio),
    });
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err: any) {
      this.logger.error(`AI Platform unreachable: ${err?.message}`);
      throw new HttpException('The AI service is not reachable.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The AI Platform's error envelope: { error: { code, message, request_id } }
      this.logger.warn(`AI Platform ${response.status}: ${body?.error?.code} ${body?.error?.request_id ?? ''}`);
      throw new HttpException(body?.error?.message || 'The AI service failed.', response.status);
    }
    return body;
  }
}
