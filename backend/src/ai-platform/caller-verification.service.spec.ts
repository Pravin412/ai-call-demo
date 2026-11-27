import { Appointment } from '../clinic/clinic.service';
import { CallerVerificationService } from './caller-verification.service';

const appointments: Appointment[] = [
  { id: 'APT001', customerName: 'Ravi Kumar', phone: '+91-9876543210', time: 't1', status: 'scheduled' },
  { id: 'APT002', customerName: 'Priya Sharma', phone: '+91-9876543211', time: 't2', status: 'scheduled' },
];

describe('CallerVerificationService', () => {
  let service: CallerVerificationService;
  beforeEach(() => (service = new CallerVerificationService()));

  it('verifies an exact name + last 4 digits and returns only that caller', () => {
    const outcome = service.verify('s1', '  ravi   KUMAR ', '3210', appointments);
    expect(outcome).toEqual({ ok: true, appointments: [appointments[0]] });
    expect(service.isVerified('s1', 'APT001')).toBe(true);
    expect(service.isVerified('s1', 'APT002')).toBe(false);
    expect(service.isVerified('s2', 'APT001')).toBe(false);
  });

  it('rejects partial names and wrong digits', () => {
    expect(service.verify('s1', 'a', '3210', appointments)).toEqual({ ok: false, reason: 'no_match' });
    expect(service.verify('s1', 'Ravi', '3210', appointments)).toEqual({ ok: false, reason: 'no_match' });
    expect(service.verify('s1', 'Ravi Kumar', '3211', appointments)).toEqual({ ok: false, reason: 'no_match' });
    expect(service.isVerified('s1', 'APT001')).toBe(false);
  });

  it('locks a session after 3 failures, even for correct details', () => {
    for (let i = 0; i < 3; i++) service.verify('s1', 'Ravi Kumar', '0000', appointments);
    expect(service.verify('s1', 'Ravi Kumar', '3210', appointments)).toEqual({ ok: false, reason: 'locked' });
  });

  it('allows one new appointment per session and verifies the creator for it', () => {
    expect(service.creationBlocked('s1')).toBeNull();
    service.recordCreated('s1', 'APT009');
    expect(service.isVerified('s1', 'APT009')).toBe(true);
    expect(service.creationBlocked('s1')).toBe('session');
    expect(service.creationBlocked('s2')).toBeNull();
  });

  it('pauses new appointments clinic-wide after 20 in an hour', () => {
    for (let i = 0; i < 20; i++) service.recordCreated(`s${i}`, `APT${100 + i}`);
    expect(service.creationBlocked('fresh')).toBe('clinic');
  });

  it('locks a name after 5 failures across sessions', () => {
    for (let i = 0; i < 5; i++) service.verify(`s${i}`, 'Ravi Kumar', '0000', appointments);
    expect(service.verify('fresh', 'Ravi Kumar', '3210', appointments)).toEqual({ ok: false, reason: 'locked' });
    expect(service.verify('fresh', 'Priya Sharma', '3211', appointments).ok).toBe(true);
  });
});
