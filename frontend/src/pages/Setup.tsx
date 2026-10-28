import { useState, useEffect } from 'react';
import { getAppointments, markCallbackDone } from '../api';
import { Appointment } from '../types';

interface Props {
  onStart: (customerName: string, appointmentId: string, reason: string) => void;
}

const REASONS = [
  'Doctor is unavailable due to an emergency',
  'Doctor is on leave',
  'Clinic maintenance closure',
  'System maintenance',
];

export default function Setup({ onStart }: Props) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [appointmentId, setAppointmentId] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [customReason, setCustomReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [callbacks, setCallbacks] = useState<Appointment[]>([]);

  useEffect(() => {
    getAppointments()
      .then((appts) => {
        setCallbacks(appts.filter((a: Appointment) => a.callbackRequest));
        const active = appts.filter((a: Appointment) => a.status === 'scheduled');
        setAppointments(active);
        if (active.length > 0) setAppointmentId(active[0].id);
        setLoading(false);
      })
      .catch(() => {
        setError('Could not load appointments. Is the backend running?');
        setLoading(false);
      });
  }, []);

  const selected = appointments.find((a) => a.id === appointmentId);
  const finalReason = reason === 'custom' ? customReason : reason;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (!finalReason.trim()) {
      setError('Please enter a reason.');
      return;
    }
    setSubmitting(true);
    setError('');
    onStart(selected.customerName, appointmentId, finalReason);
  };

  const handleCallbackDone = async (id: string) => {
    try {
      await markCallbackDone(id);
      setCallbacks((cs) => cs.filter((c) => c.id !== id));
    } catch {
      setError('Could not update the callback. Is the backend running?');
    }
  };

  if (loading)
    return (
      <div className="card">
        <p className="muted">Loading appointments...</p>
      </div>
    );

  return (
    <div className="card setup-card">
      <h2>Start a Call</h2>
      <p className="muted">
        The AI agent will call the customer to inform them about the cancellation and help them rebook.
      </p>

      {error && <p className="inline-error">{error}</p>}

      {callbacks.length > 0 && (
        <section className="callback-list">
          <h3>📞 Staff callbacks to make ({callbacks.length})</h3>
          {callbacks.map((c) => (
            <div key={c.id} className="callback-item">
              <div>
                <strong>{c.customerName}</strong> — {c.phone}
                <div className="muted">{c.callbackRequest!.reason}</div>
              </div>
              <button type="button" className="btn-small" onClick={() => handleCallbackDone(c.id)}>
                ✓ Called
              </button>
            </div>
          ))}
        </section>
      )}

      {appointments.length === 0 ? (
        <p className="muted">
          No scheduled appointments found. Check <code>backend/data/clinic.json</code>.
        </p>
      ) : (
        <form onSubmit={handleSubmit}>
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

          {selected && (
            <div className="appt-preview">
              <span>
                Patient: <strong>{selected.customerName}</strong>
              </span>
              <span>
                Phone: <strong>{selected.phone}</strong>
              </span>
              <span>
                Time: <strong>{selected.time}</strong>
              </span>
            </div>
          )}

          <label>
            Reason for cancellation
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="custom">Custom reason...</option>
            </select>
          </label>

          {reason === 'custom' && (
            <label>
              Custom reason
              <input
                type="text"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Enter the reason..."
                required
              />
            </label>
          )}

          <button className="btn-primary" type="submit" disabled={submitting || !appointmentId}>
            {submitting ? 'Starting...' : '📞 Doctor cancels — call customer'}
          </button>
        </form>
      )}
    </div>
  );
}
