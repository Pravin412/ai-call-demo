import { CallResult } from '../types';

interface Props {
  result: CallResult;
  onReset: () => void;
}

export default function Result({ result, onReset }: Props) {
  const { transcript, toolActions, bookingChange, summary, callbackRequest } = result;

  const statusLabel = (s: string) => {
    if (s === 'rebooked') return '✅ Rebooked';
    if (s === 'cancelled') return '❌ Cancelled';
    return s;
  };

  return (
    <div className="card result-card">
      <h2>Call Complete</h2>

      {callbackRequest && (
        <div className="callback-alert">
          <strong>📞 Staff callback needed</strong>
          <span>{callbackRequest.reason}</span>
        </div>
      )}

      <section className="result-section">
        <h3>Summary</h3>
        <p className="summary-text">{summary || 'No summary available.'}</p>
      </section>

      {bookingChange.before && (
        <section className="result-section">
          <h3>Booking Change</h3>
          <table className="booking-table">
            <thead>
              <tr>
                <th></th>
                <th>Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>Before</strong>
                </td>
                <td>{bookingChange.before.time}</td>
                <td>{statusLabel(bookingChange.before.status)}</td>
              </tr>
              {bookingChange.after && (
                <tr>
                  <td>
                    <strong>After</strong>
                  </td>
                  <td>{bookingChange.after.time}</td>
                  <td>{statusLabel(bookingChange.after.status)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {toolActions.length > 0 && (
        <section className="result-section">
          <h3>Tool Actions</h3>
          <div className="tool-list">
            {toolActions.map((action, i) => (
              <div key={i} className="tool-item">
                <span className="tool-name">🔧 {action.tool}</span>
                <span className="tool-args">{JSON.stringify(action.args)}</span>
                <span className={`tool-result ${action.result?.success === false ? 'tool-result-error' : ''}`}>
                  {action.result?.message ?? JSON.stringify(action.result)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="result-section">
        <h3>Transcript ({transcript.length} lines)</h3>
        <div className="transcript result-transcript">
          {transcript.map((entry, i) => (
            <div key={i} className={`transcript-entry transcript-${entry.role}`}>
              <span className="transcript-role">{entry.role === 'agent' ? '🤖 Agent' : '👤 Customer'}</span>
              <span className="transcript-text">{entry.text}</span>
            </div>
          ))}
        </div>
      </section>

      <button className="btn-primary" onClick={onReset}>
        ↩ Start another call
      </button>
    </div>
  );
}
