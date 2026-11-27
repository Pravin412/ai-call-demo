import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicService } from '../clinic/clinic.service';
import { CallerVerificationService } from './caller-verification.service';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PHONE_LAST4 = /^\d{4}$/;
// At least two words of letters (any script), e.g. "Ravi Kumar"
const PERSON_NAME = /^[\p{L}][\p{L}'.-]*(\s+[\p{L}][\p{L}'.-]*)+$/u;

// The tools listed in ai-platform.manifest.ts, shared by the AI Platform callback and the MCP server
// so both follow the same rules. The caller decides nothing: this service decides what is allowed.
// Results are read by the AI: a return value = done, a 4xx exception with a message = refused.
// The caller must pass verify_caller (or have just created the appointment with create_appointment)
// before any appointment-specific tool works in that session.
@Injectable()
export class ClinicToolsService {
  constructor(
    private readonly clinic: ClinicService,
    private readonly verification: CallerVerificationService,
  ) {}

  run(tool: string, args: Record<string, unknown>, sessionId: string) {
    switch (tool) {
      case 'verify_caller': {
        const customerName = requireString(args, 'customer_name', 100);
        const phoneLast4 = requireString(args, 'phone_last4', 4);
        if (!PHONE_LAST4.test(phoneLast4)) throw new BadRequestException('phone_last4 must be exactly 4 digits.');

        const outcome = this.verification.verify(sessionId, customerName, phoneLast4, this.clinic.listAppointments());
        if ('reason' in outcome) {
          // Same message whether the name or the digits were wrong, so callers can't probe which names exist
          throw new ForbiddenException(
            outcome.reason === 'locked'
              ? `Too many failed attempts. Do not try again; tell the customer to call the clinic on ${this.clinic.getClinicPhone()}.`
              : 'Those details do not match our records. Ask the customer to check the full name and the last 4 digits of the phone number on their booking.',
          );
        }
        return {
          verified: true,
          appointments: outcome.appointments.map(({ id, customerName: name, time, status }) => ({
            appointment_id: id,
            customerName: name,
            time,
            status,
          })),
        };
      }
      case 'get_free_slots':
        return { free_slots: this.clinic.getFreeSlots().map((s) => ({ slot_id: s.id, time: s.time })) };
      case 'create_appointment': {
        const customerName = requireString(args, 'customer_name', 100);
        if (!PERSON_NAME.test(customerName)) {
          throw new BadRequestException('Ask the customer for their full name (first and last name).');
        }
        const phone = requireString(args, 'phone', 20);
        const digits = phone.replace(/\D/g, '');
        if (!/^[+\d\s-]+$/.test(phone) || digits.length < 10 || digits.length > 13) {
          throw new BadRequestException('Ask the customer for their full mobile number (10 digits).');
        }
        const slotId = requireSlotId(args);

        const blocked = this.verification.creationBlocked(sessionId);
        if (blocked) {
          throw new ForbiddenException(
            blocked === 'session'
              ? 'A new appointment was already booked in this conversation. Only one new booking per conversation.'
              : `New bookings are paused right now. Tell the customer to call the clinic on ${this.clinic.getClinicPhone()}.`,
          );
        }
        const outcome = this.result(this.clinic.createAppointment(customerName.replace(/\s+/g, ' '), phone, slotId));
        this.verification.recordCreated(sessionId, outcome.appointment!.id);
        const { id, customerName: name, time, status } = outcome.appointment!;
        return { success: true, message: outcome.message, appointment: { appointment_id: id, customerName: name, time, status } };
      }
      case 'reschedule_appointment': {
        const appointmentId = this.verifiedAppointment(sessionId, args);
        return this.result(this.clinic.bookAppointment(appointmentId, requireSlotId(args)));
      }
      case 'cancel_appointment':
        return this.result(this.clinic.cancelAppointment(this.verifiedAppointment(sessionId, args)));
      case 'request_staff_callback': {
        const appointmentId = this.verifiedAppointment(sessionId, args);
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 500) : '';
        return this.result(this.clinic.requestStaffCallback(appointmentId, reason || `AI session ${sessionId}`));
      }
      default:
        throw new NotFoundException(`Unknown tool ${tool}.`);
    }
  }

  // Only appointments this session proved it owns via verify_caller can be changed
  private verifiedAppointment(sessionId: string, args: Record<string, unknown>): string {
    const appointmentId = requireString(args, 'appointment_id', 64);
    if (!ID.test(appointmentId)) throw new BadRequestException('Invalid appointment_id.');
    if (!this.verification.isVerified(sessionId, appointmentId)) {
      throw new ForbiddenException(
        'The caller is not verified for this appointment. Call verify_caller with their full name and the last 4 digits of their phone number first.',
      );
    }
    return appointmentId;
  }

  // ClinicService reports failures as { success: false }; turn them into a 422 the AI reads.
  private result<T extends { success: boolean; message: string }>(outcome: T): T {
    if (!outcome.success) throw new UnprocessableEntityException(outcome.message);
    return outcome;
  }
}

function requireSlotId(args: Record<string, unknown>): string {
  const slotId = requireString(args, 'slot_id', 64);
  if (!ID.test(slotId)) throw new BadRequestException('Invalid slot_id.');
  return slotId;
}

function requireString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new BadRequestException(`${key} is required.`);
  }
  return value.trim();
}
