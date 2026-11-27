/**
 * VoiceService — all AI voice logic lives here.
 *
 * PRODUCTION REWRITE CHECKLIST (mark each before go-live):
 *   [ ] Phone provider: swap WebSocket audio path for Exotel/Sarvam PSTN bridge
 *   [ ] Auth: add JWT/session auth before accepting WebSocket connections
 *   [ ] Consent & DNC: check Do-Not-Call registry before dialling
 *   [ ] Calling hours: enforce local time restrictions (e.g. 9 AM–7 PM)
 *   [ ] Call recording: add disclosure message + storage with retention policy
 *   [ ] Tamil / regional language: test STT accuracy; Gemini Live may be weak
 *   [ ] Rate limits: replace in-process queue with Redis + exponential backoff
 *   [ ] Audit log: write every tool call and transcript to append-only storage
 */

import { Injectable, Logger } from '@nestjs/common';
import * as WebSocket from 'ws';
import { ClinicService } from '../clinic/clinic.service';
import { VoiceAiService } from '../voice-ai/voice-ai.service';
import { SUPPORTED_LANGUAGES } from '../voice-ai/dto/process-voice.dto';

// Gemini Live API takes 16 kHz 16-bit PCM input (it replies with 24 kHz PCM, played by the browser)
const INPUT_SAMPLE_RATE = 16000;

// Colab mode (push-to-talk): limits on one customer turn of 16 kHz PCM16
const MIN_UTTERANCE_BYTES = INPUT_SAMPLE_RATE * 2 * 0.3; // under 0.3 s is a mis-tap
const MAX_UTTERANCE_BYTES = INPUT_SAMPLE_RATE * 2 * 30; // 30 s
const SILENCE_RMS = 100; // a whole turn this quiet means the mic heard nothing; Whisper would invent words

const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Tool definitions sent to Gemini at session setup (OPENAI_TOOLS below is the same list for Groq)
const TOOL_DECLARATIONS = [
  {
    name: 'get_free_slots',
    description: 'Returns a list of available appointment slots.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'book_appointment',
    description: 'Books (reschedules) an appointment to a given free slot.',
    parameters: {
      type: 'OBJECT',
      properties: {
        appointmentId: { type: 'STRING', description: 'The ID of the appointment to reschedule.' },
        slotId: {
          type: 'STRING',
          description: 'The exact id of the free slot from get_free_slots, e.g. "SLOT002". Not the time.',
        },
      },
      required: ['appointmentId', 'slotId'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancels an existing appointment.',
    parameters: {
      type: 'OBJECT',
      properties: {
        appointmentId: { type: 'STRING', description: 'The ID of the appointment to cancel.' },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: 'request_staff_callback',
    description:
      'Flags the appointment so clinic staff call the customer back. Call this whenever you tell the customer staff will contact them.',
    parameters: {
      type: 'OBJECT',
      properties: {
        appointmentId: { type: 'STRING', description: 'The ID of the appointment.' },
        reason: {
          type: 'STRING',
          description:
            'Short note for staff, e.g. "asked for a person", "upset about cancellation", "wants a Saturday slot".',
        },
      },
      required: ['appointmentId', 'reason'],
    },
  },
  {
    name: 'end_call',
    description: 'Hangs up after your current reply has been spoken. Call it in the same turn as your goodbye.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
];

const OPENAI_TOOLS = TOOL_DECLARATIONS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) },
}));

// 'default' = whatever .env configures (browser speech or Gemini Live); 'colab' = Whisper + XTTS on Colab, Groq thinks
export type VoiceMode = 'default' | 'colab';

export interface VoiceCallbacks {
  onAudio: (chunk: Buffer) => void;
  onTranscript: (role: 'agent' | 'customer', text: string) => void;
  onStatus: (status: string) => void;
  onToolAction: (tool: string, args: any, result: any) => void;
  onError: (message: string) => void;
}

interface Session {
  sessionId: string;
  systemPrompt: string;
  callbacks: VoiceCallbacks;
  geminiWs?: WebSocket;
  answered: boolean;
  pendingAudio: Buffer[]; // Buffer audio until answered
  isBrowserSpeech: boolean; // fallback mode
  agentTextBuffer: string; // accumulate streamed text for transcript
  history: { role: 'user' | 'assistant'; text: string }[];
  turnQueue: Promise<void>; // browser-speech turns run one at a time so replies don't overlap
  endAfterSpeaking: boolean; // set by the end_call tool; the browser hangs up once the goodbye finishes playing
  isColab: boolean;
  colab: {
    utterance: Buffer[]; // mic audio since the talk button went on
    utteranceBytes: number;
    busy: boolean; // a turn is running; mic audio is ignored
    language: string; // language of the agent's last reply; XTTS speaks in it
  };
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly useBrowserSpeech = process.env.USE_BROWSER_SPEECH === 'true';

  constructor(
    private readonly clinicService: ClinicService,
    private readonly voiceAiService: VoiceAiService,
  ) {}

  startSession(sessionId: string, systemPrompt: string, callbacks: VoiceCallbacks, mode: VoiceMode = 'default'): void {
    const isColab = mode === 'colab';
    const session: Session = {
      sessionId,
      systemPrompt,
      callbacks,
      answered: false,
      pendingAudio: [],
      isBrowserSpeech: !isColab && this.useBrowserSpeech,
      agentTextBuffer: '',
      history: [],
      turnQueue: Promise.resolve(),
      endAfterSpeaking: false,
      isColab,
      colab: { utterance: [], utteranceBytes: 0, busy: false, language: 'en' },
    };
    this.sessions.set(sessionId, session);
    this.logger.log(
      `Voice session started: ${sessionId} (${isColab ? 'colab' : `browser-speech: ${this.useBrowserSpeech}`})`,
    );

    if (isColab) {
      // Nothing to connect up front; Colab is called per turn once the customer answers
      session.callbacks.onStatus('ringing');
    } else if (this.useBrowserSpeech) {
      this.initBrowserSpeechSession(session);
    } else {
      this.initGeminiLiveSession(session);
    }
  }

  answerCall(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.answered) return;

    session.answered = true;
    session.callbacks.onStatus('active');
    this.logger.log(`Call answered: ${sessionId}`);

    if (session.isBrowserSpeech) {
      // Trigger agent to greet the customer first
      this.callGeminiText(session, 'Hello, please greet the customer and introduce yourself.');
      return;
    }

    if (session.isColab) {
      this.runColabTurn(session, null);
      return;
    }

    // Flush any audio that arrived before answer
    for (const chunk of session.pendingAudio) {
      this.forwardAudioToGemini(session, chunk);
    }
    session.pendingAudio = [];
  }

  sendAudio(sessionId: string, chunk: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.isBrowserSpeech) return;

    if (session.isColab) {
      this.handleColabAudio(session, chunk);
      return;
    }

    if (!session.answered) {
      session.pendingAudio.push(chunk);
      return;
    }
    this.forwardAudioToGemini(session, chunk);
  }

  // Called by browser-speech fallback: customer text from Web Speech API
  sendText(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isBrowserSpeech || session.endAfterSpeaking) return;

    this.logger.log(`[BrowserSpeech] Customer: ${text}`);
    session.callbacks.onTranscript('customer', text);
    // If the customer speaks while the AI is still thinking, wait for that turn to finish first
    session.turnQueue = session.turnQueue
      .then(() => this.callGeminiText(session, text))
      .catch((err) => this.logger.error(`Turn failed: ${err.message}`));
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.log(`Ending voice session: ${sessionId}`);

    if (session.geminiWs && session.geminiWs.readyState === WebSocket.OPEN) {
      session.geminiWs.close();
    }

    session.callbacks.onStatus('ended');
    this.sessions.delete(sessionId);
  }

  // ─── Gemini Live API ────────────────────────────────────────────────────────

  private initGeminiLiveSession(session: Session): void {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_LIVE_MODEL || 'gemini-2.0-flash-live-001';

    if (!apiKey) {
      session.callbacks.onError('GEMINI_API_KEY is not set. Add it to backend/.env');
      return;
    }

    const url = `${GEMINI_LIVE_WS_URL}?key=${apiKey}`;
    this.logger.log(`Connecting to Gemini Live (${model})...`);

    const geminiWs = new WebSocket(url);
    session.geminiWs = geminiWs;

    geminiWs.on('open', () => {
      this.logger.log(`Gemini Live WS open for session ${session.sessionId}`);
      this.sendGeminiSetup(session, model);
    });

    geminiWs.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleGeminiMessage(session, msg);
      } catch (err) {
        this.logger.error(`Failed to parse Gemini message: ${err.message}`);
      }
    });

    geminiWs.on('error', (err) => {
      this.logger.error(`Gemini WS error [${session.sessionId}]: ${err.message}`);
      // PRODUCTION TODO: Handle 429 (rate limit) with exponential backoff and queue
      const msg = err.message.includes('429')
        ? 'Gemini free-tier rate limit reached. Wait a moment and try again.'
        : `Gemini connection error: ${err.message}`;
      session.callbacks.onError(msg);
    });

    geminiWs.on('close', (code, reason) => {
      this.logger.log(`Gemini WS closed [${session.sessionId}]: ${code} ${reason}`);
      if (this.sessions.has(session.sessionId)) {
        session.callbacks.onStatus('ended');
        this.sessions.delete(session.sessionId);
      }
    });
  }

  private sendGeminiSetup(session: Session, model: string): void {
    // BidiGenerateContentSetup — sent once at the start of the Live API session
    const setup = {
      setup: {
        model: `models/${model}`,
        generation_config: {
          response_modalities: ['AUDIO'],
          speech_config: {
            voice_config: {
              prebuilt_voice_config: { voice_name: 'Aoede' },
            },
          },
        },
        system_instruction: {
          parts: [{ text: session.systemPrompt }],
        },
        tools: [{ function_declarations: TOOL_DECLARATIONS }],
        // Input audio format: 16 kHz 16-bit PCM mono
        realtime_input_config: {
          automatic_activity_detection: {
            disabled: false,
          },
        },
      },
    };

    session.geminiWs!.send(JSON.stringify(setup));
    this.logger.log(`Gemini setup sent for ${session.sessionId}`);
    session.callbacks.onStatus('ringing');
  }

  private forwardAudioToGemini(session: Session, chunk: Buffer): void {
    if (!session.geminiWs || session.geminiWs.readyState !== WebSocket.OPEN) return;

    // Gemini Live expects base64-encoded raw PCM16 at 16 kHz
    const message = {
      realtime_input: {
        media_chunks: [
          {
            mime_type: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
            data: chunk.toString('base64'),
          },
        ],
      },
    };
    session.geminiWs.send(JSON.stringify(message));
  }

  private handleGeminiMessage(session: Session, msg: any): void {
    // setupComplete — model is ready, signal the agent to speak first
    if (msg.setupComplete) {
      this.logger.log(`Gemini setup complete for ${session.sessionId}`);
      session.callbacks.onStatus('listening');
      // Trigger the agent to speak first by sending an empty turn signal
      this.triggerAgentGreeting(session);
      return;
    }

    // serverContent — audio, text, or function calls
    if (msg.serverContent) {
      const content = msg.serverContent;

      // Interruption: stop any current playback
      if (content.interrupted) {
        session.callbacks.onStatus('interrupted');
        return;
      }

      // Turn complete
      if (content.turnComplete) {
        if (session.agentTextBuffer.trim()) {
          session.callbacks.onTranscript('agent', session.agentTextBuffer.trim());
          session.agentTextBuffer = '';
        }
        session.callbacks.onStatus(session.endAfterSpeaking ? 'ending' : 'listening');
        return;
      }

      // Model parts: audio and/or text
      const parts = content.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/')) {
          // Forward audio to browser
          const audioBuf = Buffer.from(part.inlineData.data, 'base64');
          session.callbacks.onAudio(audioBuf);
          session.callbacks.onStatus('speaking');
        }
        if (part.text) {
          session.agentTextBuffer += part.text;
          session.callbacks.onStatus('speaking');
        }
      }

      // Input transcription (customer speech recognised by Gemini)
      if (content.inputTranscription) {
        session.callbacks.onTranscript('customer', content.inputTranscription);
      }

      // Output transcription (what the agent said)
      if (content.outputTranscription) {
        session.callbacks.onTranscript('agent', content.outputTranscription);
        session.agentTextBuffer = '';
      }
    }

    // toolCall — execute and send toolResponse
    if (msg.toolCall) {
      this.handleToolCall(session, msg.toolCall);
    }
  }

  private triggerAgentGreeting(session: Session): void {
    if (!session.geminiWs || session.geminiWs.readyState !== WebSocket.OPEN) return;

    // Send an empty client turn to prompt the model to speak first
    const message = {
      client_content: {
        turns: [
          {
            role: 'user',
            parts: [{ text: '' }],
          },
        ],
        turn_complete: true,
      },
    };
    session.geminiWs.send(JSON.stringify(message));
  }

  private handleToolCall(session: Session, toolCall: any): void {
    const calls = toolCall.functionCalls ?? [];
    const responses: any[] = [];

    for (const call of calls) {
      const { id, name, args } = call;
      this.logger.log(`[TOOL CALL] ${name}(${JSON.stringify(args)})`);

      let result: any;
      try {
        result = this.executeTool(session, name, args ?? {});
      } catch (err) {
        result = { error: err.message };
      }

      this.logger.log(`[TOOL RESULT] ${name}: ${JSON.stringify(result)}`);
      session.callbacks.onToolAction(name, args ?? {}, result);

      responses.push({
        id,
        name,
        response: { output: result },
      });
    }

    // Send all results back in one toolResponse message
    if (session.geminiWs && session.geminiWs.readyState === WebSocket.OPEN) {
      session.geminiWs.send(JSON.stringify({ tool_response: { function_responses: responses } }));
    }
  }

  private executeTool(session: Session, name: string, args: Record<string, any>): any {
    switch (name) {
      case 'request_staff_callback':
        return this.clinicService.requestStaffCallback(args.appointmentId, args.reason);
      case 'end_call':
        session.endAfterSpeaking = true;
        return { success: true, message: 'The call will end after your goodbye is spoken.' };
      case 'get_free_slots':
        return this.clinicService.getFreeSlots();
      case 'book_appointment':
        return this.clinicService.bookAppointment(args.appointmentId, args.slotId);
      case 'cancel_appointment':
        return this.clinicService.cancelAppointment(args.appointmentId);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ─── Browser Speech Fallback (USE_BROWSER_SPEECH=true) ─────────────────────
  // Uses Web Speech API on the browser side; this method handles text-turn exchange.

  private initBrowserSpeechSession(session: Session): void {
    this.logger.log(`Browser speech session ready: ${session.sessionId}`);
    session.callbacks.onStatus('ringing');
    // The agent greeting will be triggered after the user answers
  }

  private async callGeminiText(session: Session, userText: string): Promise<void> {
    const useGroq = process.env.USE_GROQ === 'true';

    if (useGroq) {
      return this.callGroqText(session, userText);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';

    if (!apiKey) {
      session.callbacks.onError('GEMINI_API_KEY is not set.');
      return;
    }

    session.callbacks.onStatus('thinking');

    try {
      // Build tools for text API
      const tools = [{ function_declarations: TOOL_DECLARATIONS }];
      session.history.push({ role: 'user', text: userText });
      const contents = session.history.map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }],
      }));

      const response = await this.fetchGeminiText(apiKey, model, session.systemPrompt, contents, tools);

      // Handle possible tool call in text response
      const candidate = response.candidates?.[0];
      if (!candidate) {
        session.callbacks.onError('No response from Gemini.');
        return;
      }

      let agentText = '';
      const toolCalls = [];

      for (const part of candidate.content?.parts ?? []) {
        if (part.text) agentText += part.text;
        if (part.functionCall) toolCalls.push(part.functionCall);
      }

      // Execute tool calls sequentially
      for (const tc of toolCalls) {
        const result = this.executeTool(session, tc.name, tc.args ?? {});
        session.callbacks.onToolAction(tc.name, tc.args ?? {}, result);

        // Send tool result back for a second turn
        const followUp = await this.fetchGeminiTextWithTool(
          apiKey,
          model,
          session.systemPrompt,
          contents,
          tc,
          result,
          tools,
        );
        const fc = followUp.candidates?.[0];
        for (const part of fc?.content?.parts ?? []) {
          if (part.text) agentText += part.text;
        }
      }

      if (agentText.trim()) {
        session.history.push({ role: 'assistant', text: agentText.trim() });
        session.callbacks.onTranscript('agent', agentText.trim());
        // Signal the browser to speak the text via speechSynthesis
        session.callbacks.onStatus('speaking');
        // The actual TTS happens in the browser; send a 'speak' event via onAudio=null convention
        // We encode agent text as a JSON buffer that the browser parses
        const textPayload = Buffer.from(JSON.stringify({ speakText: agentText.trim() }));
        session.callbacks.onAudio(textPayload);
      }
      if (session.endAfterSpeaking) session.callbacks.onStatus('ending');
    } catch (err) {
      this.logger.error(`Gemini text error: ${err.message}`);
      session.callbacks.onError(`AI error: ${err.message}`);
    }
  }

  private async fetchGeminiText(
    apiKey: string,
    model: string,
    systemPrompt: string,
    contents: any[],
    tools: any[],
  ): Promise<any> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      if (res.status === 429) throw new Error('Gemini free-tier rate limit reached. Wait a moment and try again.');
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }

    return res.json();
  }

  private async fetchGeminiTextWithTool(
    apiKey: string,
    model: string,
    systemPrompt: string,
    contents: any[],
    toolCall: any,
    toolResult: any,
    tools: any[],
  ): Promise<any> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        ...contents,
        { role: 'model', parts: [{ functionCall: toolCall }] },
        {
          role: 'user',
          parts: [{ functionResponse: { name: toolCall.name, response: { output: toolResult } } }],
        },
      ],
      tools,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }

    return res.json();
  }

  // ─── Colab mode: Whisper (ears) + XTTS-v2 (voice) on Colab, Groq thinks and runs the tools ──
  // Push-to-talk: the browser streams raw 16 kHz mic PCM only while its talk button is on, then sends end_turn.
  // Each turn: STT → Groq (+ tools) → TTS.

  private handleColabAudio(session: Session, chunk: Buffer): void {
    const c = session.colab;
    if (!session.answered || session.endAfterSpeaking || c.busy) return;
    if (c.utteranceBytes + chunk.length > MAX_UTTERANCE_BYTES) return; // keep the first 30 s
    c.utterance.push(chunk);
    c.utteranceBytes += chunk.length;
  }

  // The customer released the talk button: send what they said
  endColabTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.isColab || session.colab.busy) return;

    const c = session.colab;
    const pcm = Buffer.concat(c.utterance);
    c.utterance = [];
    c.utteranceBytes = 0;

    if (pcm.length < MIN_UTTERANCE_BYTES || rms(pcm) < SILENCE_RMS) {
      // Too short or silent: Whisper would invent words from it
      session.callbacks.onStatus('nothing-heard');
      return;
    }
    this.runColabTurn(session, pcm);
  }

  // pcm = the customer's utterance (16 kHz PCM16), or null for the agent's opening greeting
  private async runColabTurn(session: Session, pcm: Buffer | null): Promise<void> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      session.callbacks.onError('GROQ_API_KEY is not set.');
      return;
    }

    const c = session.colab;
    c.busy = true;
    try {
      session.callbacks.onStatus('thinking');
      let userText = 'Hello, please greet the customer and introduce yourself.';
      if (pcm) {
        const text = (await this.voiceAiService.transcribe(pcmToWav(pcm, INPUT_SAMPLE_RATE))).trim();
        if (!text) {
          session.callbacks.onStatus('listening');
          return;
        }
        this.logger.log(`[Colab] Customer: ${text}`);
        session.callbacks.onTranscript('customer', text);
        userText = text;
      }

      const agentText = await this.runGroqTurn(session, apiKey, userText);
      session.callbacks.onTranscript('agent', agentText);

      c.language = ttsLanguageFor(agentText);
      const wav = await this.voiceAiService.speak(agentText, c.language);
      if (!this.sessions.has(session.sessionId)) return; // customer hung up while Colab was speaking
      session.callbacks.onStatus('speaking');
      session.callbacks.onAudio(wav);
      // 'ending' tells the browser to hang up once the goodbye has finished playing
      session.callbacks.onStatus(session.endAfterSpeaking ? 'ending' : 'listening');
    } catch (err: any) {
      // VoiceAiService errors carry a safe, user-facing message (e.g. "Voice AI service is offline...")
      this.logger.error(`Colab turn failed: ${err.message}`);
      if (this.sessions.has(session.sessionId)) session.callbacks.onError(err.message);
    } finally {
      c.busy = false;
    }
  }

  // ─── Groq Fallback ─────────────────────────────────────────────────────────

  private async callGroqText(session: Session, userText: string): Promise<void> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      session.callbacks.onError('GROQ_API_KEY is not set.');
      return;
    }

    session.callbacks.onStatus('thinking');
    const agentText = await this.runGroqTurn(session, apiKey, userText);
    session.callbacks.onTranscript('agent', agentText);
    session.callbacks.onStatus('speaking');
    session.callbacks.onAudio(Buffer.from(JSON.stringify({ speakText: agentText })));
    // 'ending' tells the browser to hang up once the goodbye has finished playing
    session.callbacks.onStatus(session.endAfterSpeaking ? 'ending' : 'listening');
  }

  // One customer turn with Groq: runs tools until the model gives its spoken reply, records history, returns the reply.
  // Shared by browser-speech mode (callGroqText) and Colab mode (runColabTurn).
  private async runGroqTurn(session: Session, apiKey: string, userText: string): Promise<string> {
    session.history.push({ role: 'user', text: userText });

    const messages: any[] = [
      { role: 'system', content: session.systemPrompt },
      ...session.history.map((h) => ({ role: h.role, content: h.text })),
    ];

    let agentText = '';
    try {
      // Loop so the model can call tools (get slots → book) before giving its spoken reply
      for (let step = 0; step < 4; step++) {
        const message = await this.fetchGroqWithRetry(apiKey, messages);
        const toolCalls = message.tool_calls ?? [];

        if (toolCalls.length === 0) {
          agentText = (message.content ?? '').trim();
          break;
        }

        messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: toolCalls });
        for (const tc of toolCalls) {
          let args: any = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            /* model sent bad JSON */
          }
          this.logger.log(`[TOOL CALL] ${tc.function.name}(${JSON.stringify(args)})`);
          let result: any;
          try {
            result = this.executeTool(session, tc.function.name, args);
          } catch (err: any) {
            result = { error: err.message };
          }
          this.logger.log(`[TOOL RESULT] ${tc.function.name}: ${JSON.stringify(result)}`);
          session.callbacks.onToolAction(tc.function.name, args, result);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      }
    } catch (err: any) {
      // A single failed AI turn shouldn't hang up the call — ask the customer to repeat instead
      this.logger.error(`Groq text error: ${err.message}`);
      session.history.pop();
      agentText = "Sorry, I didn't catch that. Could you please repeat?";
    }

    agentText = toSpokenText(agentText);
    if (!agentText && session.endAfterSpeaking) {
      agentText = 'Thank you for your time. Goodbye.';
    } else if (!agentText) {
      // Model ran out of tokens or tool-call steps without saying anything; never leave the customer in silence
      this.logger.warn('Groq returned no spoken reply; asking customer to repeat');
      agentText = "Sorry, I didn't catch that. Could you please repeat?";
    }
    session.history.push({ role: 'assistant', text: agentText });
    return agentText;
  }

  private async fetchGroqWithRetry(apiKey: string, messages: any[]): Promise<any> {
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages,
          tools: OPENAI_TOOLS,
          tool_choice: 'auto',
          // Hidden reasoning tokens count toward the free tier's 8k tokens/minute limit
          reasoning_effort: 'low',
          max_completion_tokens: 400,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message ?? {};
      }
      lastError = `Groq API error ${res.status}: ${await res.text()}`;

      if (res.status === 429) {
        // Groq says how long to wait, e.g. "Please try again in 3.3975s"
        const wait = parseFloat(lastError.match(/try again in ([\d.]+)s/)?.[1] ?? '5');
        if (wait > 15) break;
        this.logger.warn(`Groq rate limit hit, retrying in ${wait.toFixed(1)}s`);
        await new Promise((r) => setTimeout(r, wait * 1000 + 500));
        continue;
      }
      // gpt-oss on Groq occasionally emits a malformed tool call (400 tool_use_failed); a retry usually succeeds
      if (res.status === 400 && lastError.includes('tool_use_failed')) continue;
      break;
    }
    throw new Error(lastError);
  }
}

// Loudness of a PCM16 little-endian chunk
function rms(chunk: Buffer): number {
  let sum = 0;
  const n = chunk.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = chunk.readInt16LE(i * 2);
    sum += v * v;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

// Wrap raw mono PCM16 in a WAV header so Whisper on Colab can read it as a file
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// XTTS needs the language up front; the agent replies in the customer's language, so pick it from the script used
function ttsLanguageFor(text: string): string {
  const lang = /[ऀ-ॿ]/.test(text) ? 'hi' : /[぀-ヿ]/.test(text) ? 'ja' : /[一-鿿]/.test(text) ? 'zh-cn' : 'en';
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
}

// The model sometimes replies in Markdown despite instructions; TTS would read the symbols aloud
function toSpokenText(text: string): string {
  return text
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Gemini schema uses upper-case type names ('OBJECT'); OpenAI-style APIs want JSON Schema ('object')
function toJsonSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v);
  }
  return out;
}
