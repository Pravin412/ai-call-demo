import { useEffect, useRef, useState } from 'react';
import { getAppointments, getResult, startColabCall } from '../api';
import { AudioIO } from '../audio';
import { CallWebSocket } from '../websocket';
import { Appointment, CallResult, TranscriptEntry } from '../types';
import Ringing from './Ringing';
import Result from './Result';

// Colab test call: same call flow, prompt and booking tools as the call demo, but voiced by Google Colab.
// Push-to-talk: the mic is streamed to /colab-calls/stream only while Talk is on; Whisper hears it,
// Groq replies and runs the tools, XTTS speaks the reply as a WAV that plays here.

type Screen = 'setup' | 'ringing' | 'call' | 'result';

const REASONS = [
  'Doctor is unavailable due to an emergency',
  'Doctor is on leave',
  'Clinic maintenance closure',
  'System maintenance',
];

const STATUS_LABELS: Record<string, string> = {
  connecting: '🔄 Connecting...',
  ringing: '📞 Ringing...',
  active: '✅ Connected',
  thinking: '💭 Thinking... (Colab can take a few seconds)',
  speaking: '🗣️ Speaking...',
  listening: '👂 Your turn: tap Talk',
  'nothing-heard': "🤷 Didn't catch that. Tap Talk and speak",
  ending: '👋 Ending call...',
  error: '❌ Error',
  ended: '📴 Call ended',
};

export default function ColabCall() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [appointmentId, setAppointmentId] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<{ sessionId: string; wsUrl: string } | null>(null);
  const [status, setStatus] = useState('idle');
  const [talking, setTalking] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState('');

  const audioIO = useRef(new AudioIO());
  const callWs = useRef(new CallWebSocket());
  const talkingRef = useRef(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const ending = useRef(false);
  const finished = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadAppointments = () => {
    setLoading(true);
    getAppointments()
      .then((appts: Appointment[]) => {
        const active = appts.filter((a) => a.status === 'scheduled');
        setAppointments(active);
        setAppointmentId(active[0]?.id ?? '');
      })
      .catch(() => setError('Could not load appointments. Is the backend running?'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAppointments();
    return () => {
      callWs.current.close();
      audioIO.current.destroy();
      player.current?.pause();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const selected = appointments.find((a) => a.id === appointmentId);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setError('');
    try {
      setSession(await startColabCall(selected.customerName, appointmentId, reason));
      setScreen('ringing');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const finish = async (sessionId: string) => {
    if (finished.current) return;
    finished.current = true;
    talkingRef.current = false;
    setTalking(false);
    player.current?.pause();
    audioIO.current.destroy();
    callWs.current.close();
    try {
      setResult(await getResult(sessionId));
    } catch {
      setResult(null);
    }
    setScreen('result');
  };

  const isReplyPlaying = () => !!player.current && !player.current.paused && !player.current.ended;

  const playReply = (wav: ArrayBuffer) => {
    player.current?.pause();
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const audio = new Audio(url);
    player.current = audio;
    setPlaying(true);
    const done = () => {
      URL.revokeObjectURL(url);
      if (player.current === audio) setPlaying(false);
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  };

  const handleAnswer = async () => {
    if (!session) return;
    try {
      await audioIO.current.init();
    } catch (err: any) {
      setError(`Microphone access denied: ${err.message}. Please allow the microphone in your browser and try again.`);
      return;
    }
    // Only stream the mic while Talk is on, so the AI never hears its own reply
    audioIO.current.onMicChunk = (buf) => {
      if (talkingRef.current) callWs.current.sendAudio(buf);
    };

    const { sessionId, wsUrl } = session;
    setScreen('call');
    setStatus('connecting');

    callWs.current.connect(
      wsUrl,
      {
        onAudioChunk: playReply,
        onEvent: (event) => {
          if (event.type === 'status') {
            setStatus(event.status);
            if (event.status === 'ending') {
              // The agent said goodbye: hang up once it has finished playing
              ending.current = true;
              const hangUp = () => {
                if (isReplyPlaying()) {
                  setTimeout(hangUp, 300);
                  return;
                }
                callWs.current.sendJSON({ type: 'end' });
              };
              setTimeout(hangUp, 500);
            }
            if (event.status === 'ended') finish(sessionId);
          } else if (event.type === 'transcript') {
            setTranscript((t) => [...t, { role: event.role, text: event.text, timestamp: new Date().toISOString() }]);
          } else if (event.type === 'error') {
            setError(event.message);
            setStatus('error');
          }
        },
        onClose: () => finish(sessionId),
      },
      () => callWs.current.sendJSON({ type: 'answered' }),
    );
  };

  const toggleTalk = () => {
    if (talkingRef.current) {
      talkingRef.current = false;
      setTalking(false);
      setStatus('thinking');
      callWs.current.sendJSON({ type: 'end_turn' });
    } else {
      player.current?.pause(); // talking over the agent stops its reply
      setPlaying(false);
      setError('');
      talkingRef.current = true;
      setTalking(true);
    }
  };

  const handleEndCall = () => {
    if (!session) return;
    callWs.current.sendJSON({ type: 'end' });
    setTimeout(() => finish(session.sessionId), 500);
  };

  const handleReset = () => {
    audioIO.current = new AudioIO();
    callWs.current = new CallWebSocket();
    talkingRef.current = false;
    ending.current = false;
    finished.current = false;
    setSession(null);
    setStatus('idle');
    setTalking(false);
    setPlaying(false);
    setTranscript([]);
    setResult(null);
    setError('');
    setScreen('setup');
    loadAppointments();
  };

  const canTalk = ['active', 'listening', 'nothing-heard', 'speaking'].includes(status) && !ending.current;
  const statusText = talking
    ? '🔴 Listening to you... tap again to send'
    : playing
      ? STATUS_LABELS.speaking
      : (STATUS_LABELS[status] ?? status);

  return (
    <>
      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}

      {screen === 'setup' && (
        <div className="card setup-card">
          <h2>Colab Call Test</h2>
          <p className="muted">
            Same call as the call demo (the AI informs the customer and can rebook or cancel), but Colab does the voice:
            Whisper hears the customer and XTTS speaks the replies. Groq decides what to say and runs the booking tools.
            Needs the Colab notebook running.
          </p>

          {loading ? (
            <p className="muted">Loading appointments...</p>
          ) : appointments.length === 0 ? (
            <p className="muted">
              No scheduled appointments found. Check <code>backend/data/clinic.json</code>.
            </p>
          ) : (
            <form onSubmit={handleStart}>
              <label>
                Appointment to cancel
                <select value={appointmentId} onChange={(e) => setAppointmentId(e.target.value)}>
                  {appointments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.customerName} — {a.time} ({a.id})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reason for cancellation
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn-primary" type="submit" disabled={!appointmentId}>
                📞 Doctor cancels — call customer with Colab voice
              </button>
            </form>
          )}
        </div>
      )}

      {screen === 'ringing' && selected && <Ringing customerName={selected.customerName} onAnswer={handleAnswer} />}

      {screen === 'call' && (
        <div className="card call-card">
          <div className="call-header">
            <span className="status-pill">{statusText}</span>
            <button className="btn-end" onClick={handleEndCall} title="End call">
              📴 End call
            </button>
          </div>

          <div className="voice-controls">
            <button
              type="button"
              className={`btn-mic ${talking ? 'btn-mic-recording' : ''}`}
              onClick={toggleTalk}
              disabled={!talking && !canTalk}
              title={talking ? 'Send' : 'Talk'}
            >
              {talking ? '⏹️' : canTalk ? '🎤' : '⏳'}
            </button>
            <p className="voice-status">{talking ? 'Tap to send' : 'Tap Talk, speak, then tap again'}</p>
          </div>

          <div className="transcript">
            {transcript.length === 0 && <p className="muted transcript-empty">Conversation will appear here...</p>}
            {transcript.map((entry, i) => (
              <div key={i} className={`transcript-entry transcript-${entry.role}`}>
                <span className="transcript-role">{entry.role === 'agent' ? '🤖 Agent' : '👤 Customer'}</span>
                <span className="transcript-text">{entry.text}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {screen === 'result' && result && <Result result={result} onReset={handleReset} />}
      {screen === 'result' && !result && (
        <div className="card">
          <p>Call ended. No result data available.</p>
          <button className="btn-primary" onClick={handleReset}>
            Start Over
          </button>
        </div>
      )}
    </>
  );
}
