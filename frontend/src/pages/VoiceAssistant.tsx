import { Fragment, useEffect, useRef, useState } from 'react';
import { getVoiceAiHealth, processVoice, voiceAiAudioUrl } from '../api';

// Push-to-talk against the Colab voice AI: record → NestJS → Colab (Whisper → Llama → XTTS-v2) → play the reply

type Phase = 'idle' | 'recording' | 'processing' | 'playing';

interface Turn {
  you?: string;
  ai?: string;
  audioUrl?: string;
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
];

const MAX_RECORDING_MS = 60_000; // keeps uploads well under the backend's 10 MB limit
const MIN_RECORDING_MS = 500;

// Field names the Colab response may use for the recognised speech and the AI's reply
const TRANSCRIPT_KEYS = ['transcript', 'transcription', 'user_text', 'input_text', 'text'];
const REPLY_KEYS = ['response', 'response_text', 'ai_response', 'reply', 'ai_text', 'llm_response'];

function pickText(result: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key].trim();
  }
  return undefined;
}

export default function VoiceAssistant() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [language, setLanguage] = useState('en');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState('');
  const [online, setOnline] = useState<boolean | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const checkHealth = () => {
    setOnline(null);
    getVoiceAiHealth()
      .then((h) => setOnline(h.status === 'healthy'))
      .catch(() => setOnline(false));
  };

  useEffect(() => {
    checkHealth();
    return () => {
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
      player.current?.pause();
      if (stopTimer.current) clearTimeout(stopTimer.current);
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const startRecording = async () => {
    setError('');
    player.current?.pause();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      setError(`Microphone access denied: ${err.message}. Allow the microphone for localhost and try again.`);
      return;
    }

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks.current, { type: rec.mimeType });
      if (Date.now() - startedAt.current < MIN_RECORDING_MS || blob.size === 0) {
        setError('That was too short. Click the mic, speak, then click again to send.');
        setPhase('idle');
        return;
      }
      send(blob);
    };

    recorder.current = rec;
    startedAt.current = Date.now();
    rec.start();
    setPhase('recording');
    stopTimer.current = setTimeout(stopRecording, MAX_RECORDING_MS);
  };

  const stopRecording = () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  const send = async (recording: Blob) => {
    setPhase('processing');
    try {
      const result = await processVoice(recording, language);
      const requestId = result.request_id ?? result.requestId;
      const turn: Turn = {
        you: pickText(result, TRANSCRIPT_KEYS),
        ai: pickText(result, REPLY_KEYS),
        audioUrl: requestId ? voiceAiAudioUrl(String(requestId)) : undefined,
      };
      setTurns((t) => [...t, turn]);
      setOnline(true);

      if (!turn.audioUrl) {
        setError('The AI replied without audio.');
        setPhase('idle');
        return;
      }
      play(turn.audioUrl);
    } catch (err: any) {
      setError(err.message);
      if (/offline|unavailable|timed out/i.test(err.message)) setOnline(false);
      setPhase('idle');
    }
  };

  const play = (url: string) => {
    player.current?.pause();
    const audio = new Audio(url);
    player.current = audio;
    audio.onended = () => setPhase('idle');
    audio.onerror = () => {
      setError('Could not play the AI reply.');
      setPhase('idle');
    };
    setPhase('playing');
    audio.play().catch(() => {
      // Autoplay blocked: the turn's replay button still works
      setPhase('idle');
    });
  };

  const handleMic = () => {
    if (phase === 'recording') stopRecording();
    else if (phase === 'idle' || phase === 'playing') startRecording();
  };

  const statusText: Record<Phase, string> = {
    idle: 'Click the mic and ask a question',
    recording: '🔴 Listening... click again to send',
    processing: '💭 Thinking... (Whisper → Llama → XTTS on Colab can take a while)',
    playing: '🗣️ Speaking...',
  };

  return (
    <div className="card voice-card">
      <div className="call-header">
        <h2>Voice Assistant</h2>
        <button
          type="button"
          className={`status-pill voice-health ${online === false ? 'status-pill-offline' : ''}`}
          onClick={checkHealth}
          title="Check again"
        >
          {online === null ? '🔄 Checking Colab...' : online ? '🟢 Colab online' : '🔴 Colab offline'}
        </button>
      </div>
      <p className="muted">
        Talk to the AI running on Google Colab. Your recording goes to the backend, never to Colab directly.
      </p>

      {error && <p className="inline-error">{error}</p>}

      <div className="voice-controls">
        <button
          type="button"
          className={`btn-mic ${phase === 'recording' ? 'btn-mic-recording' : ''}`}
          onClick={handleMic}
          disabled={phase === 'processing'}
          title={phase === 'recording' ? 'Stop and send' : 'Start recording'}
        >
          {phase === 'processing' ? '⏳' : phase === 'recording' ? '⏹️' : '🎤'}
        </button>
        <p className="voice-status">{statusText[phase]}</p>
        <label className="voice-language">
          Reply language
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={phase !== 'idle'}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="transcript">
        {turns.length === 0 && <p className="muted transcript-empty">Your conversation will appear here...</p>}
        {turns.map((turn, i) => (
          <Fragment key={i}>
            <div className="transcript-entry transcript-customer">
              <span className="transcript-role">👤 You</span>
              <span className="transcript-text">{turn.you ?? <em className="muted">(voice message)</em>}</span>
            </div>
            <div className="transcript-entry transcript-agent">
              <span className="transcript-role">🤖 AI</span>
              <span className="transcript-text">
                {turn.ai ?? <em className="muted">(spoken reply)</em>}
                {turn.audioUrl && (
                  <button
                    type="button"
                    className="btn-small voice-replay"
                    onClick={() => play(turn.audioUrl!)}
                    disabled={phase === 'recording' || phase === 'processing'}
                  >
                    ▶ Replay
                  </button>
                )}
              </span>
            </div>
          </Fragment>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
