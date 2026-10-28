# clinic-voice-agent

An AI voice agent that "phones" a clinic patient when their doctor cancels, explains what happened, and helps them
rebook, cancel, or get a call back from staff. Everything runs in the browser against a NestJS backend. **No real
phone calls, no real patients.**

![CI](https://github.com/<your-github-username>/clinic-voice-agent/actions/workflows/ci.yml/badge.svg)

---

## How it works

```
Customer speaks ─► speech-to-text ─► AI model ─► reply text ─► text-to-speech ─► customer hears it
                                        │
                              needs data? calls a tool
                                        ▼
                                  ClinicService ─► backend/data/clinic.json
```

The AI is a general model. It is never trained on the clinic. Every call it gets three things:

1. **Instructions (system prompt)** — who it is, what happened, and the rules for the call. Built per call in
   [`backend/src/calls/calls.service.ts`](backend/src/calls/calls.service.ts) (`createSession()`). Edit this text to
   change how the agent talks.
2. **Tools** — functions it can call to read or change real data. Declared in
   [`backend/src/voice/voice.service.ts`](backend/src/voice/voice.service.ts) (`TOOL_DECLARATIONS`), implemented in
   [`backend/src/clinic/clinic.service.ts`](backend/src/clinic/clinic.service.ts).
3. **Conversation history** — everything said so far in the call.

### Tools

| Tool                     | What it does                                                                    |
| ------------------------ | ------------------------------------------------------------------------------- |
| `get_free_slots`         | Lists open slots from `clinic.json`                                             |
| `book_appointment`       | Moves the appointment to a chosen slot and removes that slot                    |
| `cancel_appointment`     | Marks the appointment cancelled                                                 |
| `request_staff_callback` | Flags the appointment so staff call the customer back (shown on the start page) |
| `end_call`               | Hangs up once the agent's goodbye has finished playing                          |

### Voice modes

| Mode                                | Speech-to-text        | AI (thinking)             | Text-to-speech            |
| ----------------------------------- | --------------------- | ------------------------- | ------------------------- |
| **Browser speech + Groq** (default) | Chrome Web Speech API | Groq `openai/gpt-oss-20b` | Browser `speechSynthesis` |
| Browser speech + Gemini             | Chrome Web Speech API | Gemini text model         | Browser `speechSynthesis` |
| Gemini Live                         | Gemini                | Gemini                    | Gemini (natural voice)    |

In browser-speech modes the voice you hear is the browser's built-in voice, not the AI's.

---

## Setup

Requires **Node.js 22** and **Chrome** (Web Speech API and AudioWorklet).

### 1. API keys

- **Groq** (default, free): <https://console.groq.com/keys>
- **Gemini** (optional, for Gemini modes): <https://aistudio.google.com/app/apikey>

### 2. Backend

```bash
cd backend
cp .env.example .env      # then fill in your keys and pick a mode
npm install
npm run start:dev         # http://localhost:3005
```

Key settings in `backend/.env`:

| Variable             | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `USE_BROWSER_SPEECH` | `true` = browser does speech; `false` = Gemini Live does it all |
| `USE_GROQ`           | `true` = Groq answers (browser-speech mode only)                |
| `GROQ_API_KEY`       | Groq key                                                        |
| `GEMINI_API_KEY`     | Gemini key                                                      |
| `PORT`               | Backend port, keep `3005` (the frontend calls it)               |

### 3. Frontend

```bash
cd frontend
cp .env.example .env      # VITE_USE_BROWSER_SPEECH must match the backend
npm install
npm run dev               # http://localhost:5173
```

Open <http://localhost:5173> in Chrome.

---

## Try it

Pick an appointment, click **Doctor cancels — call customer**, then **Answer**.

| Say                               | Expected                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| "What times do you have?"         | Offers up to three free slots                                  |
| "29th October at 10:30" → "Yes"   | Confirms, then books it                                        |
| "Just cancel it"                  | Confirms, then cancels                                         |
| "I want to talk to a real person" | Flags a staff callback, says goodbye, hangs up                 |
| "This is not a good time"         | Offers a callback, flags it with your preferred time, hangs up |

After the call, the result screen shows the summary, booking change, tool calls and transcript. Staff callbacks also
appear at the top of the start page; click **✓ Called** once done.

To reset the demo data, restore `backend/data/clinic.json` from git: `git checkout backend/data/clinic.json`.

---

## Project structure

```
backend/                 NestJS API + WebSocket
  src/calls/             REST endpoints, WebSocket gateway, per-call session and AI instructions
  src/voice/             All AI logic: Gemini Live, Gemini text, Groq, tool calling
  src/clinic/            Tool implementations over data/clinic.json
  data/clinic.json       Demo clinic, appointments and free slots (changed by the tools)
frontend/                React + Vite
  src/App.tsx            Screens, WebSocket and audio wiring
  src/audio.ts           Mic/speaker (Gemini Live) and browser speech
  src/pages/             Setup, Ringing, Call, Result screens
  public/audio-processor.js  AudioWorklet that turns mic input into 16 kHz PCM
```

### API

| Method | Path                                   | Purpose                                |
| ------ | -------------------------------------- | -------------------------------------- |
| POST   | `/calls/start`                         | Create a call session                  |
| GET    | `/calls/result/:sessionId`             | Transcript, tool calls, booking change |
| GET    | `/calls/appointments`                  | Appointments (incl. staff callbacks)   |
| POST   | `/calls/callbacks/:appointmentId/done` | Staff marks a callback as done         |
| WS     | `/calls/stream?sessionId=…`            | Live audio/text and call events        |

---

## Development

```bash
npm install            # at the repo root, installs Prettier
npm run format         # format everything
npm run format:check   # what CI runs
```

CI (`.github/workflows/ci.yml`) checks formatting and builds the backend and frontend on every push and pull request.

---

## Known limits

- Demo only: names, phones and appointments are fictional.
- Sessions live in memory and `clinic.json` is a plain file, so this is single-user only.
- Free tiers have rate limits (Groq ≈ 8k tokens/minute). On a 429 the agent asks the customer to repeat.
- Smaller models sometimes skip a tool call; check the backend log (`[TOOL CALL]`, `[STAFF CALLBACK]`).
- Gemini free tier may use prompts to improve Google products; use a paid key for anything real.
- Regional languages (e.g. Tamil) are untested.

## Before production

Items are also marked `PRODUCTION TODO` in the code.

- [ ] Real phone line (Exotel, Sarvam or Twilio) instead of the browser
- [ ] Database instead of `clinic.json`; Redis for sessions
- [ ] Authentication on all endpoints and the WebSocket
- [ ] Do-Not-Call checks, calling-hours limits, recording disclosure
- [ ] Staff alerts (SMS/email) for callback requests
- [ ] Append-only audit log of tool calls and transcripts
