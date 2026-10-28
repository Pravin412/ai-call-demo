export type Screen = 'setup' | 'ringing' | 'call' | 'result';

export interface Appointment {
  id: string;
  customerName: string;
  phone: string;
  time: string;
  status: string;
  callbackRequest?: CallbackRequest;
}

export interface CallbackRequest {
  reason: string;
  requestedAt: string;
}

export interface TranscriptEntry {
  role: 'agent' | 'customer' | 'system';
  text: string;
  timestamp: string;
}

export interface ToolAction {
  tool: string;
  args: Record<string, any>;
  result: any;
  timestamp: string;
}

export interface BookingChange {
  before: { time: string; status: string } | null;
  after: { time: string; status: string } | null;
}

export interface CallResult {
  sessionId: string;
  status: string;
  transcript: TranscriptEntry[];
  toolActions: ToolAction[];
  bookingChange: BookingChange;
  summary: string;
  callbackRequest: CallbackRequest | null;
}

export interface CallState {
  screen: Screen;
  sessionId: string | null;
  wsUrl: string | null;
  customerName: string;
  appointmentId: string;
  reason: string;
  status: string;
  transcript: TranscriptEntry[];
  muted: boolean;
  result: CallResult | null;
  error: string | null;
}
