import { Module } from '@nestjs/common';
import { VoiceAiController } from './voice-ai.controller';
import { VoiceAiService } from './voice-ai.service';

@Module({
  controllers: [VoiceAiController],
  providers: [VoiceAiService],
  exports: [VoiceAiService],
})
export class VoiceAiModule {}
