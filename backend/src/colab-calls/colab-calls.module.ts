import { Module } from '@nestjs/common';
import { ColabCallsController } from './colab-calls.controller';
import { ColabCallsGateway } from './colab-calls.gateway';
import { CallsModule } from '../calls/calls.module';
import { VoiceModule } from '../voice/voice.module';

@Module({
  imports: [CallsModule, VoiceModule],
  controllers: [ColabCallsController],
  providers: [ColabCallsGateway],
})
export class ColabCallsModule {}
