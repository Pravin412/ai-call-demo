import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { ClinicService } from '../clinic/clinic.service';

export interface ToolAction {
  tool: string;
  args: Record<string, any>;
  result: any;
  timestamp: string;
}

export interface TranscriptEntry {
  role: 'agent' | 'customer' | 'system';
  text: string;
  timestamp: string;
}

export interface BookingChange {
  before: { time: string; status: string } | null;
  after: { time: string; status: string } | null;
}

export interface CallSession {
  sessionId: string;
  customerName: string;
  appointmentId: string;
  reason: string;
  systemPrompt: string;
  status: 'pending' | 'ringing' | 'active' | 'ended' | 'error';
  transcript: TranscriptEntry[];
  toolActions: ToolAction[];
  bookingChange: BookingChange;
  summary: string;
  createdAt: string;
  endedAt?: string;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);
  // In-memory session store. PRODUCTION TODO: use Redis or a database.
  private readonly sessions = new Map<string, CallSession>();

  constructor(private readonly clinicService: ClinicService) {}

  createSession(customerName: string, appointmentId: string, reason: string): CallSession {
    const sessionId = uuidv4();
    const { clinicName, doctorName } = this.clinicService.getClinicInfo();
    const appt = this.clinicService.getAppointment(appointmentId);

    if (!appt) {
      throw new NotFoundException(`Appointment ${appointmentId} not found`);
    }

    const systemPrompt = `You are a polite phone assistant for ${clinicName}. You are calling ${customerName} because ${doctorName} had to cancel the appointment on ${appt.time}. Reason: ${reason}.

Goal: tell the customer, apologise briefly, and help them rebook or cancel.

The appointment ID is ${appointmentId}. Use it when calling book_appointment or cancel_appointment. Never ask the customer for it.

Rules:
- Start by saying you are an automated assistant calling from ${clinicName}.
- Speak in short, natural sentences, one or two at a time. Ask one question at a time.
- Use get_free_slots to find times, once per call; reuse that list afterwards instead of calling it again. Offer only slots the tool returns.
- Before booking or cancelling, ask a yes/no confirmation question (e.g. "Shall I book 29 October at 10:30 AM for you?") and end your turn. Only call book_appointment or cancel_appointment after the customer says yes in their next reply. Never book or cancel in the same turn the customer picks a slot. Then repeat the result.
- This is a phone call read aloud: plain spoken sentences only. No Markdown, bold, bullet points, lists or emojis. Offer at most three slots at a time, in one sentence.
- If the customer asks for a person, is upset, or you are unsure, call request_staff_callback with a short reason, then tell them staff will contact them, say goodbye and call end_call. Never promise a staff call without calling request_staff_callback.
- Never invent times, prices or medical advice.
- Reply in the customer's language. If they switch language, switch too.
- If it is a bad time, offer a callback later; if they accept, call request_staff_callback with the time they prefer, then say goodbye and call end_call.
- When the conversation is finished, say goodbye and call end_call in the same turn.`;

    const session: CallSession = {
      sessionId,
      customerName,
      appointmentId,
      reason,
      systemPrompt,
      status: 'pending',
      transcript: [],
      toolActions: [],
      bookingChange: {
        before: appt ? { time: appt.time, status: appt.status } : null,
        after: null,
      },
      summary: '',
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, session);
    this.logger.log(`Session created: ${sessionId} for ${customerName}`);
    return session;
  }

  getSession(sessionId: string): CallSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new NotFoundException(`Session ${sessionId} not found`);
    return s;
  }

  updateStatus(sessionId: string, status: CallSession['status']): void {
    const s = this.getSession(sessionId);
    s.status = status;
    if (status === 'ended' || status === 'error') {
      s.endedAt = new Date().toISOString();
      this.finalizeBookingChange(s);
      this.buildSummary(s);
    }
  }

  addTranscript(sessionId: string, role: TranscriptEntry['role'], text: string): void {
    const s = this.getSession(sessionId);
    s.transcript.push({ role, text, timestamp: new Date().toISOString() });
  }

  addToolAction(sessionId: string, tool: string, args: Record<string, any>, result: any): void {
    const s = this.getSession(sessionId);
    s.toolActions.push({ tool, args, result, timestamp: new Date().toISOString() });
  }

  private finalizeBookingChange(session: CallSession): void {
    const appt = this.clinicService.getAppointment(session.appointmentId);
    if (appt) {
      session.bookingChange.after = { time: appt.time, status: appt.status };
    }
  }

  private buildSummary(session: CallSession): void {
    const changes = session.toolActions
      .map((a) => {
        if (a.tool === 'book_appointment') return `Rebooked to ${a.result?.appointment?.time ?? 'unknown'}`;
        if (a.tool === 'cancel_appointment') return 'Appointment cancelled';
        if (a.tool === 'request_staff_callback') return `Staff callback needed: ${a.args?.reason ?? 'no reason given'}`;
        return null;
      })
      .filter(Boolean);

    if (changes.length > 0) {
      session.summary = changes.join('. ') + '.';
    } else {
      session.summary = 'Call ended with no booking change.';
    }
  }

  getResult(sessionId: string) {
    const s = this.getSession(sessionId);
    return {
      sessionId: s.sessionId,
      status: s.status,
      transcript: s.transcript,
      toolActions: s.toolActions,
      bookingChange: s.bookingChange,
      summary: s.summary,
      callbackRequest: this.clinicService.getAppointment(s.appointmentId)?.callbackRequest ?? null,
    };
  }
}
