import { Module } from '@nestjs/common';
import { ClinicModule } from '../clinic/clinic.module';
import { AiPlatformClient } from './ai-platform.client';
import { AiPlatformController } from './ai-platform.controller';
import { AiPlatformManifestController } from './ai-platform-manifest.controller';
import { AiPlatformToolsController } from './ai-platform-tools.controller';
import { CallerVerificationService } from './caller-verification.service';
import { ClinicToolsService } from './clinic-tools.service';

@Module({
  imports: [ClinicModule],
  controllers: [AiPlatformController, AiPlatformManifestController, AiPlatformToolsController],
  providers: [AiPlatformClient, CallerVerificationService, ClinicToolsService],
  // The MCP server reuses the same tools and the same caller verification
  exports: [ClinicToolsService],
})
export class AiPlatformModule {}
