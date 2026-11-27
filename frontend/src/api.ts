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

// Colab test call (separate route; the AI listens with Whisper and speaks with XTTS on Colab)
export async function startColabCall(customerName: string, appointmentId: string, reason: string) {
  const res = await fetch(`${BASE}/colab-calls/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerName, appointmentId, reason }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to start Colab call'));
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

// ─── Voice AI (NestJS proxies these to the Colab service; the Colab URL never reaches the browser) ───

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const err = await res.json().catch(() => null);
  // ValidationPipe errors carry an array of messages
  const message = Array.isArray(err?.message) ? err.message.join(', ') : err?.message;
  return message || fallback;
}

export async function getVoiceAiHealth() {
  const res = await fetch(`${BASE}/api/v1/voice-ai/health`);
  if (!res.ok) throw new Error(await errorMessage(res, 'Voice AI service is unavailable'));
  return res.json() as Promise<{ status: string; whisper?: boolean; llama?: boolean; xtts?: boolean }>;
}

// Sends one recording; the backend adds its authorised voice sample, so none is uploaded here
export async function processVoice(recording: Blob, language: string) {
  const extension = recording.type.includes('ogg') ? 'ogg' : recording.type.includes('mp4') ? 'm4a' : 'webm';
  const form = new FormData();
  form.append('audio', recording, `recording.${extension}`);
  form.append('language', language);

  const res = await fetch(`${BASE}/api/v1/voice-ai/process`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await errorMessage(res, 'Voice AI request failed'));
  return res.json() as Promise<Record<string, any>>;
}

export function voiceAiAudioUrl(requestId: string) {
  return `${BASE}/api/v1/voice-ai/audio/${encodeURIComponent(requestId)}`;
}

// ─── AI Platform (NestJS forwards to the local AI Platform; its API key never reaches the browser) ───

export interface AiTurn {
  transcript: string;
  reply: string;
  tool_calls: Array<Record<string, any>>;
  audio: { media_type: string; data_base64: string };
}

// Sends one text message. speak = true also gets the reply spoken (the voice opening line, or chat with
// "read replies aloud"); without it the reply is text only, which skips Piper and comes back faster.
export async function chatWithAi(message: string, sessionId: string, speak = true) {
  const res = await fetch(`${BASE}/ai-platform/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, ...(speak ? { replyAudio: 'wav' } : {}) }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, 'AI Platform request failed'));
  return res.json() as Promise<Omit<AiTurn, 'transcript' | 'audio'> & { audio?: AiTurn['audio'] }>;
}

// Sends one recording as the raw body; a turn takes 15-30 s on a laptop CPU
export async function talkToAi(recording: Blob, sessionId: string) {
  const res = await fetch(`${BASE}/ai-platform/voice?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': recording.type || 'application/octet-stream' },
    body: recording,
  });
  if (!res.ok) throw new Error(await errorMessage(res, 'AI Platform request failed'));
  return res.json() as Promise<AiTurn>;
}

export async function getResult(sessionId: string) {
  const res = await fetch(`${BASE}/calls/result/${sessionId}`);
  if (!res.ok) throw new Error('Failed to load result');
  return res.json();
}
