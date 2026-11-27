import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { VoiceAiService, MAX_UPLOAD_BYTES } from './voice-ai.service';
import { ProcessVoiceDto } from './dto/process-voice.dto';
import { VoiceAiUploads } from './interfaces/voice-ai.interfaces';

// PRODUCTION TODO: guard these routes once the app has authentication (none exists yet).
@Controller('api/v1/voice-ai')
export class VoiceAiController {
  constructor(private readonly voiceAiService: VoiceAiService) {}

  // GET /api/v1/voice-ai/health
  @Get('health')
  health() {
    return this.voiceAiService.checkHealth();
  }

  // POST /api/v1/voice-ai/process — multipart: audio, voice_sample, language
  @Post('process')
  @HttpCode(200)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'audio', maxCount: 1 },
        { name: 'voice_sample', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 5 } },
    ),
  )
  process(@UploadedFiles() files: VoiceAiUploads, @Body() dto: ProcessVoiceDto) {
    return this.voiceAiService.processVoice(files?.audio?.[0], files?.voice_sample?.[0], dto.language);
  }

  // GET /api/v1/voice-ai/audio/:requestId — streams the generated speech
  @Get('audio/:requestId')
  async audio(@Param('requestId') requestId: string): Promise<StreamableFile> {
    const audio = await this.voiceAiService.getAudio(requestId);
    return new StreamableFile(audio.stream, { type: audio.contentType, length: audio.contentLength });
  }
}
