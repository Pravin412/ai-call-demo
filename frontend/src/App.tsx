import { useState, useRef, useCallback } from 'react';
import { CallState, TranscriptEntry, CallResult } from './types';
import { startCall, getResult } from './api';
import { AudioIO, BrowserSpeech } from './audio';
import { CallWebSocket } from './websocket';
import Setup from './pages/Setup';
import Ringing from './pages/Ringing';
import Call from './pages/Call';
import Result from './pages/Result';

const USE_BROWSER_SPEECH = (import.meta as any).env?.VITE_USE_BROWSER_SPEECH === 'true';

const initialState: CallState = {
  screen: 'setup',
  sessionId: null,
  wsUrl: null,
  customerName: '',
  appointmentId: '',
  reason: '',
  status: 'idle',
  transcript: [],
  muted: false,
  result: null,
  error: null,
};

export default function App() {
  const [state, setState] = useState<CallState>(initialState);

  const audioIO = useRef<AudioIO>(new AudioIO());
  const browserSpeech = useRef<BrowserSpeech>(new BrowserSpeech());
  const callWs = useRef<CallWebSocket>(new CallWebSocket());
  // True once the AI has called end_call: stop listening and hang up after the goodbye plays
  const ending = useRef(false);

  const update = useCallback((patch: Partial<CallState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);

  const addTranscript = useCallback((entry: TranscriptEntry) => {
    setState((s) => ({ ...s, transcript: [...s.transcript, entry] }));
  }, []);

  // Step 1: user submits setup form → call backend, go to Ringing screen
  const handleStartCall = useCallback(
    async (customerName: string, appointmentId: string, reason: string) => {
      update({ error: null, customerName, appointmentId, reason });
      try {
        const { sessionId, wsUrl } = await startCall(customerName, appointmentId, reason);
        update({ sessionId, wsUrl, screen: 'ringing', status: 'ringing' });
      } catch (err: any) {
        update({ error: err.message });
      }
    },
    [update],
  );

  // Step 2: user clicks Answer → request mic, connect WebSocket
  const handleAnswer = useCallback(async () => {
    if (!state.wsUrl) return;

    // Request microphone before connecting — user gesture needed for AudioContext
    try {
      if (!USE_BROWSER_SPEECH) {
        await audioIO.current.init();
      }
    } catch (err: any) {
      update({
        error: `Microphone access denied: ${err.message}. Please allow the microphone in your browser and try again.`,
      });
      return;
    }

    update({ screen: 'call', status: 'connecting' });

    callWs.current.connect(
      state.wsUrl,
      {
        onAudioChunk: (buf: ArrayBuffer) => {
          if (USE_BROWSER_SPEECH) {
            // Browser speech mode: the server sends JSON with speakText
            try {
              const text = JSON.parse(new TextDecoder().decode(buf)).speakText;
              if (text) {
                // Resume listening only once the agent has finished talking, so the mic doesn't hear the agent
                const resume = () => {
                  if (!callWs.current.isOpen() || ending.current) return;
                  if (window.speechSynthesis.speaking) {
                    setTimeout(resume, 300);
                    return;
                  }
                  browserSpeech.current.start();
                };
                browserSpeech.current.stop();
                browserSpeech.current.speak(text, resume);
                // Fallback in case the utterance's onend never fires
                setTimeout(resume, text.length * 90 + 2000);
              }
            } catch {
              /* raw audio — ignore in browser-speech mode */
            }
          } else {
            audioIO.current.queueAudio(buf);
          }
        },
        onEvent: (event) => {
          if (event.type === 'status') {
            update({ status: event.status });
            if (event.status === 'interrupted') {
              audioIO.current.interrupt();
            }
            if (event.status === 'ending') {
              ending.current = true;
              browserSpeech.current.stop();
              const hangUp = () => {
                if (window.speechSynthesis.speaking || audioIO.current.isPlaying()) {
                  setTimeout(hangUp, 300);
                  return;
                }
                callWs.current.sendJSON({ type: 'end' });
              };
              setTimeout(hangUp, 500);
            }
            if (event.status === 'ended') {
              handleCallEnded();
            }
          } else if (event.type === 'transcript') {
            // In browser-speech mode customer text is already shown locally when recognised
            if (USE_BROWSER_SPEECH && event.role === 'customer') return;
            addTranscript({ role: event.role, text: event.text, timestamp: new Date().toISOString() });
          } else if (event.type === 'error') {
            update({ error: event.message, status: 'error' });
          }
        },
        // Only fires on server-side/unexpected closes; CallWebSocket.close() detaches this handler
        onClose: () => {
          setState((s) => ({
            ...s,
            error: s.error ?? 'Connection to the server was lost. Please start the call again.',
          }));
          handleCallEnded();
        },
      },
      () => {
        // onOpen — tell backend the call is answered only after WS is open
        callWs.current.sendJSON({ type: 'answered' });
      },
    );

    // Wire mic audio to WebSocket
    if (!USE_BROWSER_SPEECH) {
      audioIO.current.onMicChunk = (buf: ArrayBuffer) => {
        callWs.current.sendAudio(buf);
      };
    } else {
      // Browser speech: Web Speech API → send text to backend (debounced)
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let pending: string[] = [];
      browserSpeech.current.onResult = (text: string) => {
        addTranscript({ role: 'customer', text, timestamp: new Date().toISOString() });
        pending.push(text);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          callWs.current.sendJSON({ type: 'text', text: pending.join(' ') });
          pending = [];
        }, 800);
      };
      browserSpeech.current.start();
    }
  }, [state.wsUrl, update, addTranscript]);

  const handleCallEnded = useCallback(async () => {
    audioIO.current.destroy();
    browserSpeech.current.stop();
    callWs.current.close();

    if (state.sessionId) {
      try {
        const result: CallResult = await getResult(state.sessionId);
        update({ screen: 'result', result });
      } catch {
        update({ screen: 'result' });
      }
    }
  }, [state.sessionId, update]);

  const handleMute = useCallback(() => {
    const muted = !state.muted;
    audioIO.current.setMuted(muted);
    if (USE_BROWSER_SPEECH) {
      muted ? browserSpeech.current.stop() : browserSpeech.current.start();
    }
    update({ muted });
  }, [state.muted, update]);

  const handleEndCall = useCallback(() => {
    callWs.current.sendJSON({ type: 'end' });
    setTimeout(handleCallEnded, 500);
  }, [handleCallEnded]);

  const handleReset = useCallback(() => {
    audioIO.current = new AudioIO();
    callWs.current = new CallWebSocket();
    ending.current = false;
    setState(initialState);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo">📞</span>
        <span>AI Call Demo — City Care Clinic</span>
        {USE_BROWSER_SPEECH && <span className="badge">Browser Speech Mode</span>}
        {state.screen === 'setup' && (
          <nav className="view-tabs">
            <a href="/colab-call">🧪 Test Colab call</a>
            <a href="/talk-to-ai">🤖 Talk to AI</a>
          </nav>
        )}
      </header>

      {state.error && (
        <div className="error-banner">
          <strong>Error:</strong> {state.error}
          <button onClick={() => update({ error: null })}>✕</button>
        </div>
      )}

      {state.screen === 'setup' && <Setup onStart={handleStartCall} />}
      {state.screen === 'ringing' && <Ringing customerName={state.customerName} onAnswer={handleAnswer} />}
      {state.screen === 'call' && (
        <Call
          transcript={state.transcript}
          status={state.status}
          muted={state.muted}
          onMute={handleMute}
          onEnd={handleEndCall}
        />
      )}
      {state.screen === 'result' && state.result && <Result result={state.result} onReset={handleReset} />}
      {state.screen === 'result' && !state.result && (
        <div className="card">
          <p>Call ended. No result data available.</p>
          <button className="btn-primary" onClick={handleReset}>
            Start Over
          </button>
        </div>
      )}
    </div>
  );
}
