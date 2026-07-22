// Maker feed over WebSocket (/v1/ws). Authenticate with an API key that has the `maker` scope, receive a
// snapshot of the public order book, then a live stream of quotable RFQs; submit quotes on the same socket.
// Uses the global WebSocket (Node 22+, browsers, edge). In older Node, pass one via `options.WebSocket`.

import type { Rfq } from './types.js';

export interface MakerFeedOptions {
  apiKey: string;
  /** WS URL. Default derives from the REST base: wss://api-dev.hashlock.markets/v1/ws */
  url?: string;
  WebSocket?: typeof WebSocket;
  onSnapshot?: (rfqs: Rfq[]) => void;
  onRfq?: (rfq: Rfq, kind: string) => void;
  onQuoted?: (msg: { rfqId: string; threadId: string }) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

const DEFAULT_WS = 'wss://api-dev.hashlock.markets/v1/ws';

export class MakerFeed {
  private ws?: WebSocket;
  private readonly opts: MakerFeedOptions;
  constructor(opts: MakerFeedOptions) {
    this.opts = opts;
  }

  connect(): Promise<void> {
    const Ctor = this.opts.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Ctor) throw new Error('MakerFeed: no WebSocket available — pass options.WebSocket');
    const ws = new Ctor(this.opts.url ?? DEFAULT_WS);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ apiKey: this.opts.apiKey }));
      ws.onerror = () => { this.opts.onError?.('websocket error'); reject(new Error('websocket error')); };
      ws.onclose = () => this.opts.onClose?.();
      ws.onmessage = (ev: MessageEvent) => {
        let m: { type?: string; rfqs?: Rfq[]; rfq?: Rfq; kind?: string; rfqId?: string; threadId?: string; error?: string };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        switch (m.type) {
          case 'snapshot': this.opts.onSnapshot?.(m.rfqs ?? []); break;
          case 'ready': resolve(); break;
          case 'rfq': if (m.rfq) this.opts.onRfq?.(m.rfq, m.kind ?? 'created'); break;
          case 'quoted': this.opts.onQuoted?.({ rfqId: m.rfqId!, threadId: m.threadId! }); break;
          case 'error': this.opts.onError?.(m.error ?? 'error'); break;
        }
      };
    });
  }

  /** Submit a quote for an RFQ over the socket. */
  quote(rfqId: string, quoteAmount: string): void {
    this.ws?.send(JSON.stringify({ quote: { rfqId, quoteAmount } }));
  }

  close(): void {
    this.ws?.close();
  }
}
