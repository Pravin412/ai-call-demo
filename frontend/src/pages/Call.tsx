import { useEffect, useRef } from 'react';
import { TranscriptEntry } from '../types';

interface Props {
  transcript: TranscriptEntry[];
  status: string;
  muted: boolean;
  onMute: () => void;
  onEnd: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  connecting: '🔄 Connecting...',
  ringing: '📞 Ringing...',
  active: '✅ Connected',
  listening: '👂 Listening...',
  thinking: '💭 Thinking...',
  speaking: '🗣️ Speaking...',
  ending: '👋 Ending call...',
  interrupted: '⚡ Interrupted',
  error: '❌ Error',
  ended: '📴 Call ended',
};

export default function Call({ transcript, status, muted, onMute, onEnd }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  return (
    <div className="card call-card">
      <div className="call-header">
        <span className="status-pill">{STATUS_LABELS[status] ?? status}</span>
        <div className="call-controls">
          <button className={`btn-icon ${muted ? 'btn-muted' : ''}`} onClick={onMute} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? '🔇' : '🎤'}
          </button>
          <button className="btn-end" onClick={onEnd} title="End call">
            📴 End call
          </button>
        </div>
      </div>

      <div className="transcript">
        {transcript.length === 0 && <p className="muted transcript-empty">Conversation will appear here...</p>}
        {transcript.map((entry, i) => (
          <div key={i} className={`transcript-entry transcript-${entry.role}`}>
            <span className="transcript-role">
              {entry.role === 'agent' ? '🤖 Agent' : entry.role === 'customer' ? '👤 Customer' : '⚙️ System'}
            </span>
            <span className="transcript-text">{entry.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
