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

| Variable                     | Meaning                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `USE_BROWSER_SPEECH`         | `true` = browser does speech; `false` = Gemini Live does it all |
| `USE_GROQ`                   | `true` = Groq answers (browser-speech mode only)                |
| `GROQ_API_KEY`               | Groq key                                                        |
| `GEMINI_API_KEY`             | Gemini key                                                      |
| `PORT`                       | Backend port, keep `3005` (the frontend calls it)               |
| `VOICE_AI_BASE_URL`          | Current ngrok URL of the Colab voice AI service                 |
| `VOICE_AI_API_KEY`           | Sent as `X-API-Key` once the Python service checks it           |
| `VOICE_AI_VOICE_SAMPLE_PATH` | Authorised voice sample used when a request sends none          |

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
  src/colab-calls/       Separate routes for Colab-voiced test calls
  src/voice-ai/          Proxy to the Python voice AI service on Colab (Whisper, Llama, XTTS-v2)
  data/clinic.json       Demo clinic, appointments and free slots (changed by the tools)
frontend/                React + Vite
  src/App.tsx            Screens, WebSocket and audio wiring
  src/audio.ts           Mic/speaker (Gemini Live) and browser speech
  src/pages/             Setup, Ringing, Call, Result screens; VoiceAssistant (Colab push-to-talk)
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
| POST   | `/colab-calls/start`                   | Start a Colab-voiced test call         |
| WS     | `/colab-calls/stream?sessionId=…`      | Push-to-talk audio for that call       |
| GET    | `/api/v1/voice-ai/health`              | Colab voice AI health                  |
| POST   | `/api/v1/voice-ai/process`             | Speech in → AI reply (multipart)       |
| GET    | `/api/v1/voice-ai/audio/:requestId`    | Generated reply audio                  |

### Colab voice AI

`/api/v1/voice-ai/*` forwards to the Python service (FastAPI on Google Colab, exposed by ngrok). The frontend never
sees the Colab URL. Uploads stay in memory and are not saved.

1. Run the Colab notebook and copy its ngrok URL into `VOICE_AI_BASE_URL` in `backend/.env`. Set
   `VOICE_AI_VOICE_SAMPLE_PATH` to the authorised voice the AI should reply in (`.wav` files are gitignored).
2. Restart the backend (`npm run start:dev`). The ngrok URL changes whenever the tunnel restarts.
3. Try it:

```bash
curl http://localhost:3005/api/v1/voice-ai/health

curl -X POST http://localhost:3005/api/v1/voice-ai/process \n  -F audio=@question.wav -F voice_sample=@my-voice.wav -F language=en

curl -o reply.wav http://localhost:3005/api/v1/voice-ai/audio/<request_id from the process response>
```

In the app: open **🎤 Voice assistant** in the header, click the mic, speak, click again. The reply plays
automatically and each turn has a Replay button.

**Colab test call:** open <http://localhost:5173/colab-call> (or **🧪 Test Colab call** on the start page). It runs
the same call (prompt, tools, booking) on separate routes, `POST /colab-calls/start` and `WS /colab-calls/stream`, so
the call demo at `/` is untouched. Push-to-talk: tap Talk, speak, tap again. Whisper on Colab hears you, Groq replies
and runs the tools, XTTS speaks in the `VOICE_AI_VOICE_SAMPLE_PATH` voice. Needs two extra notebook endpoints:
`POST /api/v1/voice/transcribe` (form `audio` → `{"text"}`) and `POST /api/v1/voice/speak` (form `text`, `language`,
`voice_sample` → WAV). The voice assistant page is at <http://localhost:5173/voice-assistant>.

In Postman: `POST` → Body → form-data, keys `audio` and `voice_sample` of type File, `language` as Text.

`audio` is required; `voice_sample` is required unless `VOICE_AI_VOICE_SAMPLE_PATH` is set. Both must be WAV, MP3, OGG, WebM, FLAC or M4A, up to 10 MB each, checked by MIME type
and file header. `language` is optional (default `en`) and must be one XTTS-v2 supports (`en`, `hi`, `es`, …).

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| 400    | Missing file, bad language, bad request ID, or Python rejected it |
| 404    | No audio for that request ID                                      |
| 413    | File over 10 MB                                                   |
| 415    | Not an accepted audio format                                      |
| 502    | Python failed to process or generate audio                        |
| 503    | Colab not reachable, notebook stopped or ngrok tunnel expired     |
| 504    | Colab took too long (limit 3 minutes for processing)              |

---

## Development

```bash
npm install            # at the repo root, installs Prettier
npm run format         # format everything
npm run format:check   # what CI runs

cd backend && npm test # unit tests (the Colab service is mocked)
```

CI (`.github/workflows/ci.yml`) checks formatting, runs backend tests and builds the backend and frontend on every push and pull request.

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

- [ ] Authentication on `/api/v1/voice-ai/*` and an API key check in the Python service
- [ ] Real phone line (Exotel, Sarvam or Twilio) instead of the browser
- [ ] Database instead of `clinic.json`; Redis for sessions
- [ ] Authentication on all endpoints and the WebSocket
- [ ] Do-Not-Call checks, calling-hours limits, recording disclosure
- [ ] Staff alerts (SMS/email) for callback requests
- [ ] Append-only audit log of tool calls and transcripts
