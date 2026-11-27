// What this backend tells the AI Platform about itself: instructions, tools, voice, speech hints.
// The platform fetches it from GET /ai-platform/manifest at startup and every few minutes, so
// edit it here and the AI picks the change up without anything changing on the platform.
// Every tool listed here must be handled in ai-platform-tools.controller.ts.

type Parameter = {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  required?: boolean; // default true
  enum?: (string | number)[];
  pattern?: string; // strings only
  max_length?: number; // strings only
  minimum?: number; // numbers only
  maximum?: number; // numbers only
};

type Tool = { description: string; path: string; parameters: Record<string, Parameter> };

export type AiPlatformManifest = {
  name: string;
  system_prompt: string;
  timezone?: string;
  speech_language?: string;
  voice?: string;
  speech_hints?: string[];
  tools: Record<string, Tool>;
};

const APPOINTMENT_ID: Parameter = {
  type: 'string',
  description: 'From verify_caller or create_appointment, e.g. APT001',
  pattern: '^APT\\d{3,6}$',
};

const SLOT_ID: Parameter = {
  type: 'string',
  description: 'From get_free_slots, e.g. SLOT004',
  pattern: '^SLOT\\d{3,6}$',
};

const tool = (name: string, description: string, parameters: Record<string, Parameter> = {}): Tool => ({
  description,
  path: `/ai-platform/tools/${name}`,
  parameters,
});

export function buildManifest(clinic: { clinicName: string; doctorName: string }): AiPlatformManifest {
  return {
    name: clinic.clinicName,
    timezone: 'Asia/Kolkata',
    voice: 'en_US-lessac-medium',
    speech_language: 'en',
    // Names the speech recogniser should expect; small models otherwise mishear them.
    // Never list patient names here: the manifest goes to the platform whether or not they call.
    speech_hints: [clinic.clinicName, clinic.doctorName, 'appointment', 'reschedule'],
    // Short, explicit rules work best with a small model: tell it which tool to use when.
    system_prompt: `
You are the receptionist of ${clinic.clinicName}. The doctor is ${clinic.doctorName}.
You help customers book a new appointment, or check, move or cancel an existing one, or
arrange a call back from staff. Be friendly and brief.

Rules:
- First ask whether they already have an appointment or want to book a new one.
- Existing appointment: ask for the customer's full name and the last 4 digits of the phone
  number on their booking, then call verify_caller. Never ask for an appointment ID.
- New appointment: ask for their full name (first and last) and their mobile number, call
  get_free_slots, and let them choose a time. If create_appointment says the number already has
  an appointment, switch to the existing-appointment steps.
- To offer times, call get_free_slots and offer at most three of them.
- Before booking, moving or cancelling, repeat the details (name, time) and ask the customer to
  confirm. Only call create_appointment, reschedule_appointment or cancel_appointment after they
  clearly say yes.
- Never read a phone number back to the customer.
- If the customer wants to talk to a person, call request_staff_callback.
- Never give medical advice.
`.trim(),
    tools: {
      verify_caller: tool(
        'verify_caller',
        "Check the customer's identity and get their appointments. Call this once you have their full name and the last 4 digits of their phone number.",
        {
          customer_name: {
            type: 'string',
            description: 'Full name as the customer said it, e.g. Ravi Kumar',
            max_length: 100,
          },
          phone_last4: {
            type: 'string',
            description: 'Last 4 digits of the phone number on the booking',
            pattern: '^\\d{4}$',
          },
        },
      ),
      get_free_slots: tool('get_free_slots', 'List the free appointment slots, each with a slot_id and a time.'),
      create_appointment: tool(
        'create_appointment',
        'Book a new appointment for a customer who does not have one. Only after the customer has confirmed the time.',
        {
          customer_name: { type: 'string', description: 'First and last name, e.g. Ravi Kumar', max_length: 100 },
          phone: {
            type: 'string',
            description: 'Mobile number as the customer said it, e.g. 98765 43210',
            pattern: '^[+0-9 -]{10,20}$',
          },
          slot_id: SLOT_ID,
        },
      ),
      reschedule_appointment: tool(
        'reschedule_appointment',
        'Move an existing appointment to a free slot. Only after the customer has confirmed.',
        { appointment_id: APPOINTMENT_ID, slot_id: SLOT_ID },
      ),
      cancel_appointment: tool('cancel_appointment', 'Cancel an appointment. Only after the customer has confirmed.', {
        appointment_id: APPOINTMENT_ID,
      }),
      request_staff_callback: tool('request_staff_callback', 'Ask clinic staff to call the customer back.', {
        appointment_id: APPOINTMENT_ID,
        reason: {
          type: 'string',
          description: 'Why the customer wants a call back, in a few words',
          required: false,
          max_length: 200,
        },
      }),
    },
  };
}
