import { Controller, Post, Get, Param, Body, Logger } from '@nestjs/common';
import { CallsService } from './calls.service';
import { ClinicService } from '../clinic/clinic.service';
import { StartCallDto } from './dto/start-call.dto';

@Controller('calls')
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly clinicService: ClinicService,
  ) {}

  // POST /calls/start
  @Post('start')
  start(@Body() dto: StartCallDto) {
    this.logger.log(`POST /calls/start for ${dto.customerName}, appt ${dto.appointmentId}`);
    const session = this.callsService.createSession(dto.customerName, dto.appointmentId, dto.reason);
    const port = process.env.PORT || 3005;
    return {
      sessionId: session.sessionId,
      wsUrl: `ws://localhost:${port}/calls/stream?sessionId=${session.sessionId}`,
    };
  }

  // GET /calls/result/:sessionId
  @Get('result/:sessionId')
  result(@Param('sessionId') sessionId: string) {
    return this.callsService.getResult(sessionId);
  }

  // GET /calls/appointments — helper for the frontend dropdown
  @Get('appointments')
  appointments() {
    return this.clinicService.listAppointments();
  }

  // POST /calls/callbacks/:appointmentId/done — staff marks a requested callback as done
  @Post('callbacks/:appointmentId/done')
  callbackDone(@Param('appointmentId') appointmentId: string) {
    const cleared = this.clinicService.clearStaffCallback(appointmentId);
    return { success: cleared };
  }
}
