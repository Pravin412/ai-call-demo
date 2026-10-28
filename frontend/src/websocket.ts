/**
 * websocket.ts — browser ↔ backend WebSocket connection
 *
 * Binary frames: raw PCM audio (backend → browser, or browser → backend)
 * Text frames:   JSON event objects
 */
export type WsEvent =
  | { type: 'status'; status: string; customerName?: string }
  | { type: 'transcript'; role: 'agent' | 'customer'; text: string }
  | { type: 'tool'; tool: string; args: any; result: any }
  | { type: 'error'; message: string };

export interface WsCallbacks {
  onAudioChunk: (buf: ArrayBuffer) => void;
  onEvent: (event: WsEvent) => void;
  onClose: () => void;
}

export class CallWebSocket {
  private ws: WebSocket | null = null;

  connect(wsUrl: string, callbacks: WsCallbacks, onOpen?: () => void): void {
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[WS] connected');
      onOpen?.();
    };

    this.ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        callbacks.onAudioChunk(e.data);
      } else {
        try {
          const event: WsEvent = JSON.parse(e.data);
          callbacks.onEvent(event);
        } catch {
          console.warn('[WS] unparseable message', e.data);
        }
      }
    };

    this.ws.onerror = (e) => {
      console.error('[WS] error', e);
      callbacks.onEvent({ type: 'error', message: 'WebSocket connection error.' });
    };

    this.ws.onclose = () => {
      console.log('[WS] closed');
      callbacks.onClose();
    };
  }

  sendAudio(buf: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
    }
  }

  sendJSON(obj: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      console.warn('[WS] not open, dropped message', obj);
    }
  }

  close(): void {
    if (this.ws) this.ws.onclose = null;
    this.ws?.close();
    this.ws = null;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
