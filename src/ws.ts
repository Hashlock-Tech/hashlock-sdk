// ─── Minimal graphql-transport-ws subscription transport ─────
//
// The SDK keeps zero runtime dependencies, so instead of pulling in
// `graphql-ws` this implements the small client half of the
// graphql-transport-ws protocol (connection_init/ack, subscribe,
// next/error/complete, ping/pong) over an injectable WebSocket
// implementation.
//
// Runtime requirements:
//   - Node >= 22 / browsers: global `WebSocket` is used automatically.
//   - Node 18/20: pass an implementation via `HashLockConfig.webSocket`
//     (e.g. `import WebSocket from 'ws'`).

import { GraphQLError, NetworkError } from './errors.js';

/** Structural WebSocket surface — satisfied by browser WebSocket and `ws`. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
}

export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/** Handle returned by subscription methods. */
export interface SubscriptionHandle {
  unsubscribe(): void;
}

export interface WsSubscribeOptions<T> {
  url: string;
  webSocket: WebSocketConstructor;
  /** Bearer token sent as `connection_init` payload `{ authorization }`. */
  token?: string;
  query: string;
  variables?: Record<string, unknown> | object;
  onData: (data: T) => void;
  onError?: (err: Error) => void;
  onComplete?: () => void;
}

/** Derive the WebSocket endpoint from an http(s) GraphQL endpoint. */
export function deriveWsEndpoint(endpoint: string): string {
  if (endpoint.startsWith('https://')) return `wss://${endpoint.slice('https://'.length)}`;
  if (endpoint.startsWith('http://')) return `ws://${endpoint.slice('http://'.length)}`;
  return endpoint; // already ws:// or wss://
}

const SUBSCRIPTION_ID = '1';

interface WsMessage {
  type?: string;
  id?: string;
  payload?: unknown;
}

/**
 * Open one connection per subscription (no multiplexing — solver and
 * taker watches are long-lived singletons, simplicity wins) and run
 * the graphql-transport-ws handshake.
 */
export function subscribeOverWebSocket<T>(opts: WsSubscribeOptions<T>): SubscriptionHandle {
  const ws = new opts.webSocket(opts.url, 'graphql-transport-ws');
  let settled = false; // errored / completed / unsubscribed

  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    opts.onError?.(err);
    try { ws.close(1000); } catch { /* already closed */ }
  };

  ws.addEventListener('open', () => {
    const payload = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
    ws.send(JSON.stringify({ type: 'connection_init', payload }));
  });

  ws.addEventListener('message', (event) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(String(event.data)) as WsMessage;
    } catch {
      return; // ignore non-JSON frames
    }

    switch (msg.type) {
      case 'connection_ack':
        ws.send(JSON.stringify({
          id: SUBSCRIPTION_ID,
          type: 'subscribe',
          payload: { query: opts.query, variables: opts.variables },
        }));
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'next': {
        const payload = (msg.payload ?? {}) as {
          data?: T;
          errors?: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>;
        };
        if (payload.errors?.length) {
          opts.onError?.(new GraphQLError(payload.errors[0].message, payload.errors));
        } else if (payload.data !== undefined && payload.data !== null) {
          opts.onData(payload.data);
        }
        break;
      }

      case 'error': {
        const errors = (Array.isArray(msg.payload) ? msg.payload : [{ message: 'Subscription error' }]) as
          Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>;
        fail(new GraphQLError(errors[0]?.message ?? 'Subscription error', errors));
        break;
      }

      case 'complete':
        if (!settled) {
          settled = true;
          opts.onComplete?.();
          try { ws.close(1000); } catch { /* already closed */ }
        }
        break;
    }
  });

  ws.addEventListener('close', (event) => {
    if (!settled) {
      fail(new NetworkError(`WebSocket closed before completion (code ${event.code ?? 'unknown'})`));
    }
  });

  ws.addEventListener('error', () => {
    fail(new NetworkError('WebSocket transport error'));
  });

  return {
    unsubscribe(): void {
      if (settled) return;
      settled = true;
      try { ws.send(JSON.stringify({ id: SUBSCRIPTION_ID, type: 'complete' })); } catch { /* best effort */ }
      try { ws.close(1000, 'client unsubscribe'); } catch { /* already closed */ }
    },
  };
}
