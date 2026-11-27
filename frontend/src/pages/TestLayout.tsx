import { ReactNode } from 'react';

// Shell for the test pages (/colab-call, /voice-assistant, /talk-to-ai)
export default function TestLayout({ children }: { children: ReactNode }) {
  const path = window.location.pathname;
  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo">🧪</span>
        <span>Voice Tests — City Care Clinic</span>
        <nav className="view-tabs">
          <a href="/">📞 Call demo</a>
          <a href="/colab-call" className={path === '/colab-call' ? 'active' : ''}>
            🧪 Colab call
          </a>
          <a href="/voice-assistant" className={path === '/voice-assistant' ? 'active' : ''}>
            🎤 Voice assistant
          </a>
          <a href="/talk-to-ai" className={path === '/talk-to-ai' ? 'active' : ''}>
            🤖 Talk to AI
          </a>
        </nav>
      </header>
      {children}
    </div>
  );
}
