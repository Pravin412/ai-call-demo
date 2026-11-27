import { Controller, Post, Body, Logger } from '@nestjs/common';
import { CallsService } from '../calls/calls.service';
import { StartCallDto } from '../calls/dto/start-call.dto';

// Test calls voiced by Google Colab (Whisper hears, XTTS speaks, Groq thinks and runs the tools).
// Separate from /calls so the browser-speech call flow is untouched. Results: GET /calls/result/:sessionId.
@Controller('colab-calls')
export class ColabCallsController {
  private readonly logger = new Logger(ColabCallsController.name);

  constructor(private readonly callsService: CallsService) {}

  // POST /colab-calls/start
  @Post('start')
  start(@Body() dto: StartCallDto) {
    this.logger.log(`POST /colab-calls/start for ${dto.customerName}, appt ${dto.appointmentId}`);
    const session = this.callsService.createSession(dto.customerName, dto.appointmentId, dto.reason);
    const port = process.env.PORT || 3005;
    return {
      sessionId: session.sessionId,
      wsUrl: `ws://localhost:${port}/colab-calls/stream?sessionId=${session.sessionId}`,
    };
  }
}
