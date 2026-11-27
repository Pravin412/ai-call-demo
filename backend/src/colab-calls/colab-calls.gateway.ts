import { WebSocketGateway, OnGatewayConnection, OnGatewayInit } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import * as ws from 'ws';
import { CallsService } from '../calls/calls.service';
import { VoiceService } from '../voice/voice.service';

// WebSocket gateway on /colab-calls/stream — push-to-talk calls voiced by Colab
//   Browser → backend: binary 16 kHz PCM16 while the talk button is on; JSON {type: 'answered' | 'end_turn' | 'end'}
//   Backend → browser: binary WAV replies from XTTS; JSON status / transcript / tool / error events
@WebSocketGateway({ path: '/colab-calls/stream' })
export class ColabCallsGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(ColabCallsGateway.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly voiceService: VoiceService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket gateway initialised on /colab-calls/stream');
  }

  handleConnection(client: ws, req: IncomingMessage) {
    const sessionId = new URL(req.url!, 'ws://localhost').searchParams.get('sessionId');
    if (!sessionId) {
      this.sendEvent(client, 'error', { message: 'Missing sessionId query parameter.' });
      client.close(1008, 'Missing sessionId');
      return;
    }

    try {
      const session = this.callsService.getSession(sessionId);
      this.logger.log(`Browser connected (Colab call): session ${sessionId} (${session.customerName})`);
      this.callsService.updateStatus(sessionId, 'ringing');
      this.sendEvent(client, 'status', { status: 'ringing', customerName: session.customerName });

      this.voiceService.startSession(
        sessionId,
        session.systemPrompt,
        {
          onAudio: (wav: Buffer) => {
            if (client.readyState === ws.OPEN) client.send(wav);
          },
          onTranscript: (role: 'agent' | 'customer', text: string) => {
            this.callsService.addTranscript(sessionId, role, text);
            this.sendEvent(client, 'transcript', { role, text });
          },
          onStatus: (status: string) => {
            this.sendEvent(client, 'status', { status });
            if (status === 'ended') {
              this.callsService.updateStatus(sessionId, 'ended');
              client.close(1000, 'Call ended');
            }
          },
          onToolAction: (tool: string, args: any, result: any) => {
            this.callsService.addToolAction(sessionId, tool, args, result);
            this.sendEvent(client, 'tool', { tool, args, result });
          },
          onError: (message: string) => {
            this.logger.error(`Colab call error [${sessionId}]: ${message}`);
            this.callsService.updateStatus(sessionId, 'error');
            this.sendEvent(client, 'error', { message });
            client.close(1011, 'Voice error');
          },
        },
        'colab',
      );

      client.on('message', (data: ws.RawData, isBinary: boolean) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.voiceService.sendAudio(sessionId, buf);
          return;
        }
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'answered') {
            this.callsService.updateStatus(sessionId, 'active');
            this.voiceService.answerCall(sessionId);
          } else if (msg.type === 'end_turn') {
            this.voiceService.endColabTurn(sessionId);
          } else if (msg.type === 'end') {
            this.voiceService.endSession(sessionId);
          }
        } catch {
          this.logger.warn('Unparseable message from browser');
        }
      });

      client.on('close', () => {
        this.logger.log(`Browser disconnected (Colab call): session ${sessionId}`);
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
