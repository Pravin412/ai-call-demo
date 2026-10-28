const BASE = 'http://localhost:3005';

export async function startCall(customerName: string, appointmentId: string, reason: string) {
  const res = await fetch(`${BASE}/calls/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerName, appointmentId, reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || 'Failed to start call');
  }
  return res.json() as Promise<{ sessionId: string; wsUrl: string }>;
}

export async function getAppointments() {
  const res = await fetch(`${BASE}/calls/appointments`);
  if (!res.ok) throw new Error('Failed to load appointments');
  return res.json();
}

export async function markCallbackDone(appointmentId: string) {
  const res = await fetch(`${BASE}/calls/callbacks/${appointmentId}/done`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to mark callback done');
  return res.json();
}

export async function getResult(sessionId: string) {
  const res = await fetch(`${BASE}/calls/result/${sessionId}`);
  if (!res.ok) throw new Error('Failed to load result');
  return res.json();
}
