import { ClinicData, ClinicService } from './clinic.service';

describe('ClinicService.createAppointment', () => {
  let data: ClinicData;
  let service: ClinicService;

  beforeEach(() => {
    data = {
      clinic: { name: 'City Care Clinic', phone: '+91-44-12345678' },
      doctor: { name: 'Dr. Meena', specialty: 'General Physician' },
      appointments: [
        { id: 'APT001', customerName: 'Ravi Kumar', phone: '+91-9876543210', time: 't1', status: 'scheduled' },
        { id: 'APT007', customerName: 'Old Patient', phone: '+91-9000000000', time: 't0', status: 'cancelled' },
      ],
      freeSlots: [{ id: 'SLOT003', time: '2026-11-02 11:00 AM' }],
    };
    service = new ClinicService();
    // Work on in-memory data instead of data/clinic.json
    jest.spyOn(service as any, 'load').mockImplementation(() => data);
    jest.spyOn(service as any, 'save').mockImplementation((d) => (data = d as ClinicData));
  });

  it('creates the appointment with the next id and takes the slot', () => {
    const outcome = service.createAppointment('Anu Das', '98765 11111', 'SLOT003');
    expect(outcome.success).toBe(true);
    expect(outcome.appointment).toEqual({
      id: 'APT008',
      customerName: 'Anu Das',
      phone: '+919876511111',
      time: '2026-11-02 11:00 AM',
      status: 'scheduled',
    });
    expect(data.freeSlots).toEqual([]);
  });

  it('refuses a phone number that already has an active appointment', () => {
    const outcome = service.createAppointment('Someone Else', '+91 98765 43210', 'SLOT003');
    expect(outcome.success).toBe(false);
    expect(data.freeSlots).toHaveLength(1);
  });

  it('allows a phone number whose only appointment was cancelled', () => {
    expect(service.createAppointment('Old Patient', '9000000000', 'SLOT003').success).toBe(true);
  });

  it('refuses a slot that is not free', () => {
    expect(service.createAppointment('Anu Das', '9876511111', 'SLOT999').success).toBe(false);
  });
});
