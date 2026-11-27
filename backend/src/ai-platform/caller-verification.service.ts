import { Injectable, Logger } from '@nestjs/common';
import { Appointment } from '../clinic/clinic.service';

const SESSION_TTL_MS = 30 * 60_000;
const MAX_FAILURES_PER_SESSION = 3;
// Across all sessions, so opening new chats doesn't give a guesser fresh attempts at one patient
const MAX_FAILURES_PER_NAME = 5;
const NAME_LOCK_WINDOW_MS = 15 * 60_000;
// New-patient bookings: one per conversation, plus a clinic-wide hourly cap so fake bookings
// can't fill every free slot
const MAX_CREATES_PER_SESSION = 1;
const MAX_CREATES_PER_HOUR = 20;

export type VerifyOutcome = { ok: true; appointments: Appointment[] } | { ok: false; reason: 'locked' | 'no_match' };

interface SessionState {
  appointmentIds: Set<string>;
  failures: number;
  created: number;
  expiresAt: number;
}

// Remembers which appointments each AI session has proved it owns (exact name + last 4 phone digits,
// or it just created them), and limits how many new appointments the AI can create.
// In memory: a backend restart forgets verifications, and callers just verify again.
// PRODUCTION TODO: move to Redis/DB if the backend runs more than one instance.
@Injectable()
export class CallerVerificationService {
  private readonly logger = new Logger(CallerVerificationService.name);
  private readonly sessions = new Map<string, SessionState>();
  private readonly nameFailures = new Map<string, number[]>();
  private createdAt: number[] = [];

  verify(sessionId: string, customerName: string, phoneLast4: string, all: Appointment[]): VerifyOutcome {
    const session = this.session(sessionId);
    const name = normalizeName(customerName);
    if (session.failures >= MAX_FAILURES_PER_SESSION || this.recentNameFailures(name) >= MAX_FAILURES_PER_NAME) {
      this.logger.warn(`Verification locked for session ${sessionId}`);
      return { ok: false, reason: 'locked' };
    }

    const matches = all.filter((a) => normalizeName(a.customerName) === name && phoneLast4Of(a.phone) === phoneLast4);
    if (matches.length === 0) {
      session.failures++;
      this.nameFailures.set(name, [...this.nameFailureTimes(name), Date.now()]);
      this.logger.warn(
        `Verification failed for session ${sessionId} (${session.failures}/${MAX_FAILURES_PER_SESSION})`,
      );
      return { ok: false, reason: 'no_match' };
    }

    matches.forEach((a) => session.appointmentIds.add(a.id));
    return { ok: true, appointments: matches };
  }

  isVerified(sessionId: string, appointmentId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.expiresAt > Date.now() && session.appointmentIds.has(appointmentId);
  }

  creationBlocked(sessionId: string): 'session' | 'clinic' | null {
    if (this.session(sessionId).created >= MAX_CREATES_PER_SESSION) return 'session';
    this.createdAt = this.createdAt.filter((t) => t > Date.now() - 60 * 60_000);
    return this.createdAt.length >= MAX_CREATES_PER_HOUR ? 'clinic' : null;
  }

  // The caller who just booked owns the new appointment, so they can manage it in the same conversation
  recordCreated(sessionId: string, appointmentId: string): void {
    const session = this.session(sessionId);
    session.created++;
    session.appointmentIds.add(appointmentId);
    this.createdAt.push(Date.now());
  }

  private session(sessionId: string): SessionState {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { appointmentIds: new Set(), failures: 0, created: 0, expiresAt: now + SESSION_TTL_MS };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private nameFailureTimes(name: string): number[] {
    const cutoff = Date.now() - NAME_LOCK_WINDOW_MS;
    return (this.nameFailures.get(name) ?? []).filter((t) => t > cutoff);
  }

  private recentNameFailures(name: string): number {
    return this.nameFailureTimes(name).length;
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function phoneLast4Of(phone: string): string {
  return phone.replace(/\D/g, '').slice(-4);
}
