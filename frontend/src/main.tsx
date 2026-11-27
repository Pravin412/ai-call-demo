import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ColabCall from './pages/ColabCall';
import VoiceAssistant from './pages/VoiceAssistant';
import TalkToAi from './pages/TalkToAi';
import TestLayout from './pages/TestLayout';
import './App.css';

// Colab test pages live on their own URLs so the call demo at / stays exactly as it was
function Root() {
  switch (window.location.pathname) {
    case '/colab-call':
      return (
        <TestLayout>
          <ColabCall />
        </TestLayout>
      );
    case '/voice-assistant':
      return (
        <TestLayout>
          <VoiceAssistant />
        </TestLayout>
      );
    case '/talk-to-ai':
      return (
        <TestLayout>
          <TalkToAi />
        </TestLayout>
      );
    default:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
