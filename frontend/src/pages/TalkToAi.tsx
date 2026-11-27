import { FormEvent, Fragment, useEffect, useRef, useState } from 'react';
import { chatWithAi, talkToAi } from '../api';

// Conversation with the local AI Platform (Whisper → Qwen → Piper), through NestJS. Two modes:
// Voice: hands-free. Start: the AI greets you, then the page listens, sends what you said once you pause, plays the
// reply and listens again, until End. The mic is not recorded while the AI is thinking or speaking.
// Voice, manual: you press Record and Stop, can play your recording back, then Send or record again.
// Either way, "My voice" next to each of your turns replays what was sent, to compare with what Whisper heard.
// Chat: type a message, the AI replies in text (optionally read aloud). Same AI, same tools, its own session.
// The AI acts on the clinic through the backend's signed tool endpoints; ClinicService decides what actually happens.

type Mode = 'voice' | 'chat';
type Phase = 'off' | 'listening' | 'hearing' | 'ready' | 'recording' | 'review' | 'thinking' | 'speaking';

interface Turn {
  you?: string;
  yourAudioUrl?: string; // your recording, as sent to Whisper
  ai?: string;
  tools: string[];
  audioUrl?: string;
  pending?: boolean; // chat: sent, waiting for the reply
}

const CHECK_MS = 50;
const SPEECH_CONFIRM_MS = 250; // this much continuous sound counts as speech, not a click or cough
const SILENCE_END_MS = 1200; // pause this long after speaking and the turn is sent
const MAX_UTTERANCE_MS = 30_000;
const IDLE_RESTART_MS = 20_000; // nothing said: start a fresh recording so it stays small
const MIN_THRESHOLD = 0.015;

// The opening line the AI answers with its greeting; it is not shown as one of your turns
const OPENING_MESSAGE = 'Hello';

const STATUS: Record<Phase, string> = {
  off: 'Press Start to begin the conversation',
  listening: '👂 Listening... just talk',
  hearing: '🔴 Hearing you... pause when you are done',
  ready: '🎙️ Press Record, then speak',
  recording: '🔴 Recording... press Stop when you are done',
  review: '🎧 Play it back to check, then Send or record again',
  thinking: '💭 Thinking... (a turn takes 15-30 s on this laptop)',
  speaking: '🗣️ AI is speaking...',
};

function toolName(call: Record<string, any>): string {
  return String(call.name ?? call.tool ?? call.function?.name ?? 'tool');
}

function newRecorder(stream: MediaStream): MediaRecorder {
  return new MediaRecorder(stream, {
    mimeType: ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    ),
  });
}

function audioUrlOf(audio?: { media_type: string; data_base64: string } | null): string | undefined {
  return audio?.data_base64 ? `data:${audio.media_type};base64,${audio.data_base64}` : undefined;
}

export default function TalkToAi() {
  const [mode, setMode] = useState<Mode>('voice');
  const [phase, setPhase] = useState<Phase>('off');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [manual, setManual] = useState(false);
  const [review, setReview] = useState<{ blob: Blob; url: string } | null>(null);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Bumped on every Start and End, so replies from an ended conversation are ignored
  const conversation = useRef(0);
  const sessionId = useRef('');
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const vadTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const noiseFloor = useRef(0.01);
  const player = useRef<HTMLAudioElement | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => end(), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const isCurrent = (id: number) => conversation.current === id;

  // Your recordings are blob URLs; free them along with the transcript
  const clearTurns = () =>
    setTurns((t) => {
      t.forEach((turn) => turn.yourAudioUrl && URL.revokeObjectURL(turn.yourAudioUrl));
      return [];
    });

  const stopListening = () => {
    if (vadTimer.current) clearInterval(vadTimer.current);
    vadTimer.current = null;
    const rec = recorder.current;
    recorder.current = null;
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.stop();
    }
  };

  const start = async () => {
    setError('');
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      });
    } catch (err: any) {
      setError(`Microphone access denied: ${err.message}. Allow the microphone for localhost and try again.`);
      return;
    }
    const id = ++conversation.current;
    stream.current = mic;
    audioCtx.current = new AudioContext();
    analyser.current = audioCtx.current.createAnalyser();
    analyser.current.fftSize = 2048;
    audioCtx.current.createMediaStreamSource(mic).connect(analyser.current);
    sessionId.current = `web:${crypto.randomUUID()}`;
    clearTurns();

    // The AI speaks first
    setPhase('thinking');
    try {
      const result = await chatWithAi(OPENING_MESSAGE, sessionId.current);
      if (!isCurrent(id)) return;
      const turn: Turn = { ai: result.reply?.trim(), tools: (result.tool_calls ?? []).map(toolName) };
      turn.audioUrl = audioUrlOf(result.audio);
      setTurns([turn]);
      playThenListen(id, turn.audioUrl);
    } catch (err: any) {
      if (!isCurrent(id)) return;
      setError(err.message);
      end();
    }
  };

  const listen = (id: number) => {
    if (!isCurrent(id) || !stream.current || !analyser.current) return;
    if (manual) {
      setPhase('ready');
      return;
    }
    setPhase('listening');

    const rec = newRecorder(stream.current);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => send(id, new Blob(chunks, { type: rec.mimeType }));
    recorder.current = rec;
    rec.start();

    const samples = new Float32Array(analyser.current.fftSize);
    const recordStart = Date.now();
    let speechStart = 0;
    let lastVoice = 0;
    let speaking = false;

    vadTimer.current = setInterval(() => {
      if (!analyser.current) return;
      analyser.current.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const level = Math.sqrt(sum / samples.length);
      const threshold = Math.max(MIN_THRESHOLD, noiseFloor.current * 3);
      const now = Date.now();

      if (level > threshold) {
        if (!speechStart) speechStart = now;
        lastVoice = now;
        if (!speaking && now - speechStart >= SPEECH_CONFIRM_MS) {
          speaking = true;
          setPhase('hearing');
        }
      } else if (!speaking) {
        // Learn the room's background level while nobody is talking
        noiseFloor.current = noiseFloor.current * 0.95 + level * 0.05;
        if (speechStart && now - lastVoice > 300) speechStart = 0;
      }

      if (speaking && (now - lastVoice >= SILENCE_END_MS || now - speechStart >= MAX_UTTERANCE_MS)) {
        if (vadTimer.current) clearInterval(vadTimer.current);
        vadTimer.current = null;
        recorder.current = null;
        rec.stop(); // onstop sends it
      } else if (!speaking && !speechStart && now - recordStart >= IDLE_RESTART_MS) {
        stopListening();
        listen(id);
      }
    }, CHECK_MS);
  };

  // Manual mode: Record → Stop → review (play back) → Send or record again
  const startRecording = () => {
    const id = conversation.current;
    if (!stream.current) return;
    setError('');
    const rec = newRecorder(stream.current);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (!isCurrent(id)) return;
      const blob = new Blob(chunks, { type: rec.mimeType });
      setReview({ blob, url: URL.createObjectURL(blob) });
      setPhase('review');
    };
    recorder.current = rec;
    rec.start();
    setRecordedSeconds(0);
    setPhase('recording');

    const started = Date.now();
    vadTimer.current = setInterval(() => {
      const elapsed = Date.now() - started;
      setRecordedSeconds(Math.floor(elapsed / 1000));
      if (elapsed >= MAX_UTTERANCE_MS) stopRecording();
    }, CHECK_MS);
  };

  const stopRecording = () => {
    if (vadTimer.current) clearInterval(vadTimer.current);
    vadTimer.current = null;
    const rec = recorder.current;
    recorder.current = null;
    if (rec && rec.state !== 'inactive') rec.stop(); // onstop opens the review
  };

  const sendReview = () => {
    if (!review) return;
    setReview(null);
    send(conversation.current, review.blob, review.url);
  };

  const recordAgain = () => {
    if (review) URL.revokeObjectURL(review.url);
    setReview(null);
    startRecording();
  };

  const send = async (id: number, recording: Blob, yourAudioUrl = URL.createObjectURL(recording)) => {
    if (!isCurrent(id)) return;
    setPhase('thinking');
    setError('');
    try {
      const result = await talkToAi(recording, sessionId.current);
      if (!isCurrent(id)) return;
      const turn: Turn = {
        you: result.transcript?.trim() || undefined,
        yourAudioUrl,
        ai: result.reply?.trim() || undefined,
        tools: (result.tool_calls ?? []).map(toolName),
        audioUrl: audioUrlOf(result.audio),
      };
      setTurns((t) => [...t, turn]);
      playThenListen(id, turn.audioUrl);
    } catch (err: any) {
      URL.revokeObjectURL(yourAudioUrl);
      if (!isCurrent(id)) return;
      // e.g. nothing understood: say so and keep listening
      setError(err.message);
      listen(id);
    }
  };

  const playThenListen = (id: number, url?: string) => {
    if (!url) {
      listen(id);
      return;
    }
    player.current?.pause();
    const audio = new Audio(url);
    player.current = audio;
    const next = () => {
      if (player.current === audio) listen(id);
    };
    audio.onended = next;
    audio.onerror = next;
    setPhase('speaking');
    audio.play().catch(next);
  };

  // Ends any voice conversation and clears the transcript; the next message starts a new AI session
  const reset = () => {
    end();
    sessionId.current = '';
    clearTurns();
    setError('');
    setDraft('');
    setSending(false);
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    reset();
    setMode(next);
  };

  const sendText = async (e: FormEvent) => {
    e.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    const id = conversation.current;
    if (!sessionId.current) sessionId.current = `web:${crypto.randomUUID()}`;
    setDraft('');
    setError('');
    setSending(true);
    setTurns((t) => [...t, { you: message, tools: [], pending: true }]);
    try {
      const result = await chatWithAi(message, sessionId.current, speakReplies);
      if (!isCurrent(id)) return;
      const turn: Turn = {
        you: message,
        // Qwen likes **bold**; the transcript shows plain text (line breaks are kept by CSS)
        ai: result.reply?.replace(/\*\*/g, '').trim() || undefined,
        tools: (result.tool_calls ?? []).map(toolName),
        audioUrl: audioUrlOf(result.audio),
      };
      setTurns((t) => [...t.slice(0, -1), turn]);
      if (turn.audioUrl) {
        player.current?.pause();
        player.current = new Audio(turn.audioUrl);
        player.current.play().catch(() => undefined);
      }
    } catch (err: any) {
      if (!isCurrent(id)) return;
      // Drop the unanswered message and put it back in the box to retry
      setTurns((t) => t.slice(0, -1));
      setDraft(message);
      setError(err.message);
    } finally {
      if (isCurrent(id)) {
        setSending(false);
        inputRef.current?.focus();
      }
    }
  };

  const replay = (url: string) => {
    const audio = new Audio(url);
    audio.play().catch(() => setError('Could not play the recording.'));
  };

  function end() {
    conversation.current++;
    stopListening();
    setReview((r) => {
      if (r) URL.revokeObjectURL(r.url);
      return null;
    });
    player.current?.pause();
    player.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    analyser.current = null;
    setPhase('off');
  }

  // Playing audio now would be picked up by the mic
  const recording = phase === 'listening' || phase === 'hearing' || phase === 'recording';

  return (
    <div className="card voice-card">
      <div className="call-header">
        <h2>Talk to AI</h2>
        {phase !== 'off' && (
          <button className="btn-end" onClick={end} title="End conversation">
            📴 End
          </button>
        )}
        {mode === 'chat' && turns.length > 0 && (
          <button type="button" className="btn-small" onClick={reset} disabled={sending}>
            🗑️ New chat
          </button>
        )}
      </div>

      <div className="mode-toggle" role="tablist" aria-label="Conversation mode">
        {(['voice', 'chat'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? 'mode-toggle-active' : ''}
            onClick={() => switchMode(m)}
          >
            {m === 'voice' ? '🎙️ Voice' : '💬 Chat'}
          </button>
        ))}
      </div>

      <p className="muted">
        {mode === 'voice'
          ? manual
            ? 'Talk to the local AI Platform (Whisper, Qwen 2.5 3B, Piper) one recording at a time. Press Record, speak, press Stop, play it back to check it, then Send.'
            : 'A hands-free conversation with the local AI Platform (Whisper, Qwen 2.5 3B, Piper). Press Start, the AI greets you, then just talk and pause when you are done.'
          : 'Type to the same AI (Qwen 2.5 3B on the local AI Platform). A reply takes a few seconds on this laptop.'}{' '}
        It can book new appointments, move or cancel existing ones and ask staff to call back. Check the Call demo page for the real
        booking state; the AI's reply can be wrong.
      </p>

      {error && <p className="inline-error">{error}</p>}

      {mode === 'voice' && (
        <div className="voice-controls">
          {phase === 'off' ? (
            <button type="button" className="btn-primary" onClick={start}>
              📞 Start conversation
            </button>
          ) : (
            <span className="status-pill">
              {STATUS[phase]}
              {phase === 'recording' && ` (${recordedSeconds} s)`}
            </span>
          )}
          {phase === 'off' && (
            <>
              <p className="voice-status">{STATUS.off}</p>
              <label className="chat-speak">
                <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
                🎛️ Manual: I press Record and Stop, and check my recording before it is sent
              </label>
            </>
          )}
          {phase === 'ready' && (
            <button type="button" className="btn-primary" onClick={startRecording}>
              🎙️ Record
            </button>
          )}
          {phase === 'recording' && (
            <button type="button" className="btn-primary" onClick={stopRecording}>
              ⏹️ Stop
            </button>
          )}
          {phase === 'review' && review && (
            <div className="voice-review">
              <audio src={review.url} controls autoPlay />
              <div className="voice-review-actions">
                <button type="button" className="btn-small" onClick={recordAgain}>
                  🔁 Record again
                </button>
                <button type="button" className="btn-primary" onClick={sendReview}>
                  📤 Send
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="transcript">
        {turns.length === 0 && (
          <p className="muted transcript-empty">
            {mode === 'voice' ? 'Your conversation will appear here...' : 'Type a message below to start chatting...'}
          </p>
        )}
        {turns.map((turn, i) => (
          <Fragment key={i}>
            {/* The voice greeting (turn 0) answers a hidden opening line, so it has no "You" entry */}
            {(turn.you || i > 0) && (
              <div className="transcript-entry transcript-customer">
                <span className="transcript-role">👤 You</span>
                <span className="transcript-text">
                  {turn.you ?? <em className="muted">(voice message)</em>}
                  {turn.yourAudioUrl && (
                    <button
                      type="button"
                      className="btn-small voice-replay"
                      onClick={() => replay(turn.yourAudioUrl!)}
                      disabled={recording}
                      title="Play what was sent, to compare with what the AI heard"
                    >
                      ▶ My voice
                    </button>
                  )}
                </span>
              </div>
            )}
            <div className="transcript-entry transcript-agent">
              <span className="transcript-role">🤖 AI</span>
              <span className="transcript-text">
                {turn.pending ? (
                  <em className="muted">💭 Thinking...</em>
                ) : (
                  turn.ai ?? <em className="muted">(spoken reply)</em>
                )}
                {turn.tools.length > 0 && <small className="muted"> · used {turn.tools.join(', ')}</small>}
                {turn.audioUrl && (
                  <button
                    type="button"
                    className="btn-small voice-replay"
                    onClick={() => replay(turn.audioUrl!)}
                    disabled={recording}
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

      {mode === 'chat' && (
        <>
          <form className="chat-form" onSubmit={sendText}>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message, e.g. Any free slots tomorrow?"
              maxLength={2000}
              autoFocus
            />
            <button type="submit" className="btn-primary" disabled={sending || !draft.trim()}>
              {sending ? '...' : 'Send'}
            </button>
          </form>
          <label className="chat-speak">
            <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} />
            🔊 Read replies aloud (slower)
          </label>
        </>
      )}
    </div>
  );
}
