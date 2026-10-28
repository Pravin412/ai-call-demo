import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface Appointment {
  id: string;
  customerName: string;
  phone: string;
  time: string;
  status: 'scheduled' | 'cancelled' | 'rebooked';
  // Set when the AI promised the customer a call back from a person; staff clear it once they've called
  callbackRequest?: { reason: string; requestedAt: string };
}

export interface FreeSlot {
  id: string;
  time: string;
}

export interface ClinicData {
  clinic: { name: string; phone: string };
  doctor: { name: string; specialty: string };
  appointments: Appointment[];
  freeSlots: FreeSlot[];
}

// PRODUCTION TODO: Replace with a real database (PostgreSQL/MySQL via TypeORM or Prisma)
@Injectable()
export class ClinicService {
  private readonly logger = new Logger(ClinicService.name);
  private readonly dataPath = path.join(__dirname, '..', '..', 'data', 'clinic.json');

  private load(): ClinicData {
    const raw = fs.readFileSync(this.dataPath, 'utf-8');
    return JSON.parse(raw);
  }

  private save(data: ClinicData): void {
    fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  getClinicInfo(): { clinicName: string; doctorName: string } {
    const data = this.load();
    return { clinicName: data.clinic.name, doctorName: data.doctor.name };
  }

  getAppointment(id: string): Appointment | null {
    const data = this.load();
    return data.appointments.find((a) => a.id === id) ?? null;
  }

  listAppointments(): Appointment[] {
    return this.load().appointments;
  }

  // Tool: get_free_slots
  getFreeSlots(): FreeSlot[] {
    this.logger.log('[TOOL] get_free_slots called');
    return this.load().freeSlots;
  }

  // Tool: book_appointment
  bookAppointment(
    appointmentId: string,
    slotId: string,
  ): { success: boolean; message: string; appointment?: Appointment } {
    this.logger.log(`[TOOL] book_appointment(appointmentId=${appointmentId}, slotId=${slotId})`);

    if (!appointmentId || !slotId) {
      return { success: false, message: 'appointmentId and slotId are required.' };
    }

    const data = this.load();
    const apptIdx = data.appointments.findIndex((a) => a.id === appointmentId);
    if (apptIdx === -1) {
      return { success: false, message: `Appointment ${appointmentId} not found.` };
    }

    const slotIdx = data.freeSlots.findIndex((s) => s.id === slotId);
    if (slotIdx === -1) {
      const valid = data.freeSlots.map((s) => `${s.id} (${s.time})`).join(', ');
      return { success: false, message: `Slot ${slotId} is not available. Valid slot ids: ${valid}.` };
    }

    const slot = data.freeSlots[slotIdx];
    const appt = data.appointments[apptIdx];
    const oldTime = appt.time;

    appt.time = slot.time;
    appt.status = 'rebooked';
    data.freeSlots.splice(slotIdx, 1); // Remove booked slot

    this.save(data);
    this.logger.log(`[TOOL] Rebooked ${appointmentId}: ${oldTime} → ${slot.time}`);
    return {
      success: true,
      message: `Appointment rebooked from ${oldTime} to ${slot.time}.`,
      appointment: appt,
    };
  }

  // Tool: request_staff_callback
  requestStaffCallback(appointmentId: string, reason: string): { success: boolean; message: string } {
    this.logger.log(`[TOOL] request_staff_callback(appointmentId=${appointmentId}, reason=${reason})`);

    const data = this.load();
    const appt = data.appointments.find((a) => a.id === appointmentId);
    if (!appt) {
      return { success: false, message: `Appointment ${appointmentId} not found.` };
    }

    appt.callbackRequest = { reason: reason || 'Not specified', requestedAt: new Date().toISOString() };
    this.save(data);
    this.logger.warn(`[STAFF CALLBACK] ${appt.customerName} (${appt.phone}): ${appt.callbackRequest.reason}`);
    return {
      success: true,
      message: `Staff will call ${appt.customerName} back. Reason noted: ${appt.callbackRequest.reason}.`,
    };
  }

  // Staff marks a callback as done
  clearStaffCallback(appointmentId: string): boolean {
    const data = this.load();
    const appt = data.appointments.find((a) => a.id === appointmentId);
    if (!appt?.callbackRequest) return false;
    delete appt.callbackRequest;
    this.save(data);
    return true;
  }

  // Tool: cancel_appointment
  cancelAppointment(appointmentId: string): { success: boolean; message: string; appointment?: Appointment } {
    this.logger.log(`[TOOL] cancel_appointment(appointmentId=${appointmentId})`);

    if (!appointmentId) {
      return { success: false, message: 'appointmentId is required.' };
    }

    const data = this.load();
    const apptIdx = data.appointments.findIndex((a) => a.id === appointmentId);
    if (apptIdx === -1) {
      return { success: false, message: `Appointment ${appointmentId} not found.` };
    }

    const appt = data.appointments[apptIdx];
    if (appt.status === 'cancelled') {
      return { success: false, message: `Appointment ${appointmentId} is already cancelled.` };
    }

    appt.status = 'cancelled';
    this.save(data);
    this.logger.log(`[TOOL] Cancelled ${appointmentId}`);
    return {
      success: true,
      message: `Appointment on ${appt.time} has been cancelled.`,
      appointment: appt,
    };
  }
}
