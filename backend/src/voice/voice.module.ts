import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { ClinicModule } from '../clinic/clinic.module';
import { VoiceAiModule } from '../voice-ai/voice-ai.module';

@Module({
  imports: [ClinicModule, VoiceAiModule],
  providers: [VoiceService],
  exports: [VoiceService],
})
export class VoiceModule {}
