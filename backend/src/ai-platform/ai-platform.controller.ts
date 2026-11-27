import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { AiPlatformClient, AudioFormat, Channel } from './ai-platform.client';

const SESSION_ID = /^[A-Za-z0-9._:+@-]{1,128}$/;
const AUDIO_FORMATS: AudioFormat[] = ['wav', 'ogg_opus', 'mp3'];

function checkSession(sessionId: string | undefined): string {
  if (!sessionId || !SESSION_ID.test(sessionId)) throw new BadRequestException('Invalid sessionId.');
  return sessionId;
}

// What your frontend (or a WhatsApp/Telegram webhook) calls. It forwards to the AI Platform.
@Controller('ai-platform')
export class AiPlatformController {
  constructor(private readonly ai: AiPlatformClient) {}

  // { "sessionId": "...", "message": "...", "channel"?: "whatsapp", "replyAudio"?: "wav" }
  @Post('chat')
  @HttpCode(200)
  chat(@Body() body: { sessionId?: string; message?: string; channel?: Channel; replyAudio?: AudioFormat }) {
    if (!body?.message?.trim()) throw new BadRequestException('message is required.');
    return this.ai.chat(checkSession(body.sessionId), body.message, body.channel, body.replyAudio);
  }

  // Raw recording as the body (Content-Type: audio/webm, audio/wav, audio/ogg, ...).
  // Returns { transcript, reply, tool_calls, audio: { data_base64, media_type, ... } }.
  @Post('voice')
  @HttpCode(200)
  voice(
    @Body() audio: Buffer,
    @Headers('content-type') contentType: string,
    @Query('sessionId') sessionId?: string,
    @Query('format') format?: AudioFormat,
  ) {
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw new BadRequestException('Send the recording as the request body with an audio/* Content-Type.');
    }
    const audioFormat = format && AUDIO_FORMATS.includes(format) ? format : 'wav';
    return this.ai.voice(checkSession(sessionId), audio, contentType, audioFormat);
  }
}
