import { useState } from 'react';

interface Props {
  customerName: string;
  onAnswer: () => void;
}

export default function Ringing({ customerName, onAnswer }: Props) {
  const [answering, setAnswering] = useState(false);

  const handleAnswer = async () => {
    setAnswering(true);
    await onAnswer();
    // Screen transition handled by parent
  };

  return (
    <div className="card ringing-card">
      <div className="ring-animation">📱</div>
      <h2>Calling {customerName}...</h2>
      <p className="muted">
        When the customer answers, click the button below to join the call. This also grants microphone access.
      </p>

      <div className="mic-notice">
        <span>🎤</span>
        <span>Your browser will ask for microphone permission when you click Answer.</span>
      </div>

      <button className="btn-answer" onClick={handleAnswer} disabled={answering}>
        {answering ? 'Connecting...' : '✅ Customer answers — join call'}
      </button>

      <p className="small-note">
        If the microphone prompt is blocked, check your browser's address bar and allow microphone access for localhost.
      </p>
    </div>
  );
}
