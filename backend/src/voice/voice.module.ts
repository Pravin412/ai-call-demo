import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { ClinicModule } from '../clinic/clinic.module';

@Module({
  imports: [ClinicModule],
  providers: [VoiceService],
  exports: [VoiceService],
})
export class VoiceModule {}
