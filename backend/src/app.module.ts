import { Module } from '@nestjs/common';
import { CallsModule } from './calls/calls.module';
import { ClinicModule } from './clinic/clinic.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [ClinicModule, VoiceModule, CallsModule],
})
export class AppModule {}
