import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Param,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { IncomingMessage } from 'http';
import { ClinicToolsService } from './clinic-tools.service';
import { verifySignature } from './verify-signature';

// Called by the AI Platform when the AI decides to act. The platform has already checked the
// tool name and argument formats; ClinicToolsService still decides what is allowed and what happens.
// Replies are read by the AI: 2xx = done, 4xx with a message = refused (the AI tells the customer).
@Controller('ai-platform/tools')
export class AiPlatformToolsController {
  private readonly secret = process.env.AI_CALL_DEMO_CALLBACK_SECRET || '';

  constructor(private readonly tools: ClinicToolsService) {}

  @Post(':tool')
  @HttpCode(200)
  handle(
    @Param('tool') tool: string,
    @Req() req: RawBodyRequest<IncomingMessage>,
    @Headers('x-ai-platform-signature') signature?: string,
    @Headers('x-ai-platform-application') application?: string,
  ) {
    if (!verifySignature(this.secret, signature, req.rawBody)) {
      throw new UnauthorizedException('invalid signature');
    }
    if (application !== 'ai-call-demo') throw new ForbiddenException('unknown application');
    const { args, sessionId } = parseBody(req.rawBody!);
    return this.tools.run(tool, args, sessionId);
  }
}

function parseBody(raw: Buffer): { args: Record<string, unknown>; sessionId: string } {
  let body: any;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new BadRequestException('Body must be JSON.');
  }
  const args = body?.arguments;
  const sessionId = body?.session_id;
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new BadRequestException('arguments must be an object.');
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) {
    throw new BadRequestException('session_id is required.');
  }
  return { args, sessionId };
}
