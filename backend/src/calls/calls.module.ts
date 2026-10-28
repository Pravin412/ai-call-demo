import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { CallsGateway } from './calls.gateway';
import { ClinicModule } from '../clinic/clinic.module';
import { VoiceModule } from '../voice/voice.module';

@Module({
  imports: [ClinicModule, VoiceModule],
  controllers: [CallsController],
  providers: [CallsService, CallsGateway],
})
export class CallsModule {}
