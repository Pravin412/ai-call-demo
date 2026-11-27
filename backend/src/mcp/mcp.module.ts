import { Module } from '@nestjs/common';
import { AiPlatformModule } from '../ai-platform/ai-platform.module';
import { ClinicModule } from '../clinic/clinic.module';
import { McpController } from './mcp.controller';

@Module({
  imports: [ClinicModule, AiPlatformModule],
  controllers: [McpController],
})
export class McpModule {}
