import { Module } from '@nestjs/common';
import { CallsModule } from './calls/calls.module';
import { ClinicModule } from './clinic/clinic.module';
import { VoiceModule } from './voice/voice.module';
import { VoiceAiModule } from './voice-ai/voice-ai.module';
import { ColabCallsModule } from './colab-calls/colab-calls.module';
import { AiPlatformModule } from './ai-platform/ai-platform.module';
import { McpModule } from './mcp/mcp.module';

@Module({
  imports: [ClinicModule, VoiceModule, CallsModule, VoiceAiModule, ColabCallsModule, AiPlatformModule, McpModule],
})
export class AppModule {}
