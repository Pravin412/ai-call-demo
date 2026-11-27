import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { IncomingMessage } from 'http';
import { ClinicService } from '../clinic/clinic.service';
import { AiPlatformManifest, buildManifest } from './ai-platform.manifest';
import { verifySignature } from './verify-signature';

// Fetched by the AI Platform, signed like tool calls (over an empty body), at startup and
// every few minutes. Built from live clinic data, so a name change applies on the next fetch.
@Controller('ai-platform')
export class AiPlatformManifestController {
  private readonly secret = process.env.AI_CALL_DEMO_CALLBACK_SECRET || '';

  constructor(private readonly clinic: ClinicService) {}

  @Get('manifest')
  manifest(
    @Req() req: RawBodyRequest<IncomingMessage>,
    @Headers('x-ai-platform-signature') signature?: string,
    @Headers('x-ai-platform-application') application?: string,
  ): AiPlatformManifest {
    if (!verifySignature(this.secret, signature, req.rawBody ?? Buffer.alloc(0))) {
      throw new UnauthorizedException('invalid signature');
    }
    if (application !== 'ai-call-demo') throw new ForbiddenException('unknown application');
    return buildManifest(this.clinic.getClinicInfo());
  }
}
