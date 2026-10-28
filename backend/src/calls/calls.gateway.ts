import { WebSocketGateway, OnGatewayConnection, OnGatewayInit } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import * as ws from 'ws';
import { CallsService } from './calls.service';
import { VoiceService } from '../voice/voice.service';

// WebSocket gateway on /calls/stream
@WebSocketGateway({ path: '/calls/stream' })
export class CallsGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(CallsGateway.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly voiceService: VoiceService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket gateway initialised on /calls/stream');
  }

  handleConnection(client: ws, req: IncomingMessage) {
    const url = new URL(req.url!, `ws://localhost`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      this.sendEvent(client, 'error', { message: 'Missing sessionId query parameter.' });
      client.close(1008, 'Missing sessionId');
      return;
    }

    try {
      const session = this.callsService.getSession(sessionId);
      this.logger.log(`Browser connected: session ${sessionId} (${session.customerName})`);
      this.callsService.updateStatus(sessionId, 'ringing');
      this.sendEvent(client, 'status', { status: 'ringing', customerName: session.customerName });

      // Start voice session — voice module handles all Gemini/browser-speech logic
      this.voiceService.startSession(sessionId, session.systemPrompt, {
        onAudio: (chunk: Buffer) => {
          if (client.readyState === ws.OPEN) {
            // Send raw PCM audio to browser
            client.send(chunk);
          }
        },
        onTranscript: (role: 'agent' | 'customer', text: string) => {
          this.callsService.addTranscript(sessionId, role, text);
          this.sendEvent(client, 'transcript', { role, text });
        },
        onStatus: (status: string) => {
          this.sendEvent(client, 'status', { status });
          if (status === 'ended') {
            this.callsService.updateStatus(sessionId, 'ended');
            this.sendEvent(client, 'status', { status: 'ended' });
            client.close(1000, 'Call ended');
          }
        },
        onToolAction: (tool: string, args: any, result: any) => {
          this.callsService.addToolAction(sessionId, tool, args, result);
          this.sendEvent(client, 'tool', { tool, args, result });
        },
        onError: (message: string) => {
          this.logger.error(`Voice error [${sessionId}]: ${message}`);
          this.callsService.updateStatus(sessionId, 'error');
          this.sendEvent(client, 'error', { message });
          client.close(1011, 'Voice error');
        },
      });

      // In browser-speech mode, auto-answer immediately on connect
      if (process.env.USE_BROWSER_SPEECH === 'true') {
        this.callsService.updateStatus(sessionId, 'active');
        this.voiceService.answerCall(sessionId);
      }

      // Browser → backend audio
      // ws v8 delivers text frames as Buffers too, so branch on isBinary
      client.on('message', (data: ws.RawData, isBinary: boolean) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.voiceService.sendAudio(sessionId, buf);
        } else {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'answered') {
              this.callsService.updateStatus(sessionId, 'active');
              this.voiceService.answerCall(sessionId);
            } else if (msg.type === 'end') {
              this.voiceService.endSession(sessionId);
            } else if (msg.type === 'text') {
              // Browser speech fallback: text from Web Speech API
              this.voiceService.sendText(sessionId, msg.text);
            }
          } catch {
            this.logger.warn(`Unparseable message from browser: ${data}`);
          }
        }
      });

      client.on('close', () => {
        this.logger.log(`Browser disconnected: session ${sessionId}`);
        this.voiceService.endSession(sessionId);
      });
    } catch (err) {
      this.sendEvent(client, 'error', { message: err.message });
      client.close(1011, 'Session error');
    }
  }

  private sendEvent(client: ws, type: string, payload: Record<string, any>) {
    if (client.readyState === ws.OPEN) {
      client.send(JSON.stringify({ type, ...payload }));
    }
  }
}
