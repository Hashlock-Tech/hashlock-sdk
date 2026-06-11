import { describe, it, expect, vi } from 'vitest';
import { HashLock } from '../hashlock.js';
import { GraphQLError, AuthError, NetworkError } from '../errors.js';
import {
  policyPresets,
  sanitizeAgentPolicy,
  classifyInstantFillError,
  InstantFillOrphanedError,
  TRUST_LEVEL_TO_SCORE,
} from '../instant.js';
import type {
  InstantFill,
  InstantFillRequestedEvent,
  InstantFillFrontedEvent,
} from '../instant.js';
import type { WebSocketConstructor } from '../ws.js';
import { deriveWsEndpoint } from '../ws.js';

// ─── Helpers ─────────────────────────────────────────────────

type GqlBody = { data?: unknown; errors?: unknown[]; status?: number };

/** Mock fetch returning a different GraphQL response per call, in order. */
function mockFetchSequence(...responses: GqlBody[]) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      status: r.status ?? 200,
      statusText: 'OK',
      json: () => Promise.resolve({ data: r.data, errors: r.errors }),
    });
  }
  return fn;
}

function createClient(fetchFn: ReturnType<typeof vi.fn>) {
  return new HashLock({
    endpoint: 'http://localhost:4000/graphql',
    accessToken: 'test-token',
    fetch: fetchFn as unknown as typeof fetch,
    retries: 0,
  });
}

function requestBody(fetchFn: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(fetchFn.mock.calls[call][1].body) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

const FILL: InstantFill = {
  id: 'fill-1',
  quoteId: 'q-1',
  tradeId: null,
  state: 'committed',
  amountWei: '1000000000000000000000000000', // > 2^53 — must stay a string
  frontTxHash: null,
  frontedAt: null,
  createdAt: '2026-06-11T00:00:00Z',
};

/** Schema-accurate subscription payloads (InstantFillRequested /
 *  InstantFillFronted are DIFFERENT types from InstantFill — the fill id
 *  arrives as `fillId`, Requested has no tradeId/frontTxHash/frontedAt,
 *  Fronted has no createdAt). */
const REQUESTED_EVENT: InstantFillRequestedEvent = {
  fillId: 'fill-1',
  quoteId: 'q-1',
  rfqId: 'rfq-1',
  state: 'committed',
  amountWei: '1000000000000000000000000000',
  createdAt: '2026-06-11T00:00:00Z',
};

const FRONTED_EVENT: InstantFillFrontedEvent = {
  fillId: 'fill-1',
  quoteId: 'q-1',
  rfqId: 'rfq-1',
  tradeId: 't-1',
  state: 'fronted',
  amountWei: '1000000000000000000000000000',
  frontTxHash: '0xfront',
  frontedAt: '2026-06-11T00:01:00Z',
};

const QUOTE = { id: 'q-1', rfqId: 'rfq-1', status: 'ACCEPTED', trade: { id: 't-1', status: 'PROPOSED' } };

// REAL wire shapes (verified against the backend error pipeline):
// trade-service maskTradeError + the gateway formatter serialize a
// HashlockError as extensions: { ...metadata, code, retryable } —
// metadata FLATTENED, HTTP statusCode never serialized.
const DISABLED_ERR = { message: 'instant fill disabled', extensions: { code: 'INSTANT_FILL_DISABLED' } };
const LANE_ERR = {
  message: 'Instant fill unavailable: the settlement router classified this intent into lane Z',
  extensions: { code: 'INVALID_INPUT', retryable: false, lane: 'Z' },
};
const ALREADY_ERR = {
  message: 'Instant fill already requested for this quote',
  extensions: { code: 'INVALID_STATE_TRANSITION', retryable: false },
};

// ─── Policy presets + sanitization ───────────────────────────

describe('policyPresets', () => {
  it('mirrors the design §13.1 preset table 1:1', () => {
    expect(policyPresets.instant).toEqual({ maxLatencyMs: 3000 });
    expect(policyPresets.balanced).toEqual({ minTrust: 'med' });
    expect(policyPresets.trustless).toEqual({ minTrust: 'max' });
  });
});

describe('sanitizeAgentPolicy', () => {
  it('produces the wire shape — every field an Int (AgentPolicyInput is all Int)', () => {
    expect(sanitizeAgentPolicy({ maxLatencyMs: 3000, maxFeeBps: 30, minTrust: 'med' }))
      .toEqual({ maxLatencyMs: 3000, maxFeeBps: 30, minTrust: 50 });
  });

  it('maps TrustLevel strings to the 0-100 Int score (low→0, med→50, max→100)', () => {
    expect(TRUST_LEVEL_TO_SCORE).toEqual({ low: 0, med: 50, max: 100 });
    expect(sanitizeAgentPolicy({ minTrust: 'low' })).toEqual({ minTrust: 0 });
    expect(sanitizeAgentPolicy({ minTrust: 'med' })).toEqual({ minTrust: 50 });
    expect(sanitizeAgentPolicy({ minTrust: 'max' })).toEqual({ minTrust: 100 });
  });

  it('never lets a TrustLevel string reach the wire for any preset', () => {
    for (const preset of Object.values(policyPresets)) {
      const wire = sanitizeAgentPolicy(preset);
      expect(wire).toBeDefined();
      for (const v of Object.values(wire as Record<string, unknown>)) {
        expect(Number.isInteger(v)).toBe(true); // Int coercion safety
      }
    }
  });

  it('accepts a raw numeric minTrust, flooring and clamping into 0-100', () => {
    expect(sanitizeAgentPolicy({ minTrust: 75 })).toEqual({ minTrust: 75 });
    expect(sanitizeAgentPolicy({ minTrust: 72.9 })).toEqual({ minTrust: 72 });
    expect(sanitizeAgentPolicy({ minTrust: 150 })).toEqual({ minTrust: 100 });
    expect(sanitizeAgentPolicy({ minTrust: -5 })).toEqual({ minTrust: 0 });
  });

  it('floors/clamps maxLatencyMs and maxFeeBps into Int-safe backend ranges', () => {
    expect(sanitizeAgentPolicy({ maxLatencyMs: 2999.9 })).toEqual({ maxLatencyMs: 2999 });
    expect(sanitizeAgentPolicy({ maxLatencyMs: Number.MAX_SAFE_INTEGER }))
      .toEqual({ maxLatencyMs: 2_147_483_647 }); // GraphQL Int is 32-bit
    expect(sanitizeAgentPolicy({ maxFeeBps: 25.7 })).toEqual({ maxFeeBps: 25 });
    expect(sanitizeAgentPolicy({ maxFeeBps: 20_000 })).toEqual({ maxFeeBps: 10_000 });
  });

  it('drops unknown keys and wrongly-typed values instead of throwing', () => {
    expect(sanitizeAgentPolicy({
      maxLatencyMs: 'fast', // wrong type
      maxFeeBps: 25,
      minTrust: 'maximum', // not a TrustLevel
      surprise: true, // unknown key
    })).toEqual({ maxFeeBps: 25 });
  });

  it('returns undefined when nothing valid remains (→ standard path)', () => {
    expect(sanitizeAgentPolicy({ maxLatencyMs: -1, minTrust: 'huge' })).toBeUndefined();
    expect(sanitizeAgentPolicy({ minTrust: NaN })).toBeUndefined();
    expect(sanitizeAgentPolicy('instant')).toBeUndefined();
    expect(sanitizeAgentPolicy(null)).toBeUndefined();
    expect(sanitizeAgentPolicy(undefined)).toBeUndefined();
  });
});

// ─── Maker side: submitQuote instant-fill commitment ─────────

describe('submitQuote (instant fill)', () => {
  it('forwards instantFill + solverVaultAddr and declares them in the operation', async () => {
    const fetch = mockFetchSequence({
      data: { submitQuote: { ...QUOTE, instantFill: true, solverVaultAddr: '0xVault' } },
    });
    const hl = createClient(fetch);

    const quote = await hl.submitQuote({
      rfqId: 'rfq-1',
      price: '3500',
      amount: '10',
      instantFill: true,
      solverVaultAddr: '0xVault',
    });

    const body = requestBody(fetch);
    expect(body.variables.instantFill).toBe(true);
    expect(body.variables.solverVaultAddr).toBe('0xVault');
    expect(body.query).toContain('$instantFill: Boolean');
    expect(body.query).toContain('$solverVaultAddr: String');
    expect(body.query).toContain('instantFill solverVaultAddr');
    expect(quote.instantFill).toBe(true);
    expect(quote.solverVaultAddr).toBe('0xVault');
  });

  it('plain quotes keep working without the new fields (backward compat)', async () => {
    const fetch = mockFetchSequence({ data: { submitQuote: { ...QUOTE, instantFill: false, solverVaultAddr: null } } });
    const hl = createClient(fetch);

    const quote = await hl.submitQuote({ rfqId: 'rfq-1', price: '3500', amount: '10' });
    const body = requestBody(fetch);
    expect('instantFill' in body.variables).toBe(false); // undefined drops in JSON
    expect(quote.id).toBe('q-1');
  });
});

// ─── Taker side: acceptQuote policy ──────────────────────────

describe('acceptQuote (policy)', () => {
  it('without policy keeps the legacy operation (no policy variable)', async () => {
    const fetch = mockFetchSequence({ data: { acceptQuote: QUOTE } });
    const hl = createClient(fetch);

    await hl.acceptQuote('q-1');
    const body = requestBody(fetch);
    expect(body.query).not.toContain('policy');
    expect(body.variables).toEqual({ quoteId: 'q-1' });
  });

  it('with policy declares $policy: AgentPolicyInput and forwards the WIRE policy (minTrust as Int)', async () => {
    const fetch = mockFetchSequence({ data: { acceptQuote: QUOTE } });
    const hl = createClient(fetch);

    await hl.acceptQuote('q-1', { ...policyPresets.balanced, maxFeeBps: 30 });
    const body = requestBody(fetch);
    expect(body.query).toContain('$policy: AgentPolicyInput');
    // 'med' must NOT reach the wire — AgentPolicyInput.minTrust is Int,
    // a string would fail coercion and reject the ENTIRE accept.
    expect(body.variables.policy).toEqual({ minTrust: 50, maxFeeBps: 30 });
  });

  it('a fully broken policy silently falls back to the standard accept (never errors)', async () => {
    const fetch = mockFetchSequence({ data: { acceptQuote: QUOTE } });
    const hl = createClient(fetch);

    const quote = await hl.acceptQuote('q-1', { maxLatencyMs: 'now' } as never);
    const body = requestBody(fetch);
    expect(body.query).not.toContain('policy');
    expect(quote.status).toBe('ACCEPTED');
  });
});

// ─── requestInstantFill / markInstantFillFronted ─────────────

describe('requestInstantFill', () => {
  it('returns the fill; amountWei stays a decimal string (never number)', async () => {
    const fetch = mockFetchSequence({ data: { requestInstantFill: FILL } });
    const hl = createClient(fetch);

    const fill = await hl.requestInstantFill('rfq-1', 'q-1');
    expect(fill.id).toBe('fill-1');
    expect(fill.state).toBe('committed');
    expect(typeof fill.amountWei).toBe('string');
    expect(BigInt(fill.amountWei)).toBe(1000000000000000000000000000n);

    const body = requestBody(fetch);
    expect(body.variables).toEqual({ rfqId: 'rfq-1', quoteId: 'q-1' });
    expect(body.query).toContain('requestInstantFill(rfqId: $rfqId, quoteId: $quoteId)');
  });
});

describe('markInstantFillFronted', () => {
  it('forwards fillId + frontTxHash and returns the fronted fill', async () => {
    const fronted = { ...FILL, state: 'fronted', frontTxHash: '0xfront', frontedAt: '2026-06-11T00:01:00Z' };
    const fetch = mockFetchSequence({ data: { markInstantFillFronted: fronted } });
    const hl = createClient(fetch);

    const fill = await hl.markInstantFillFronted('fill-1', '0xfront');
    expect(fill.state).toBe('fronted');
    expect(fill.frontTxHash).toBe('0xfront');

    const body = requestBody(fetch);
    expect(body.variables).toEqual({ fillId: 'fill-1', frontTxHash: '0xfront' });
  });
});

// ─── Error classification ────────────────────────────────────

describe('classifyInstantFillError', () => {
  it('INSTANT_FILL_DISABLED code → disabled', () => {
    const err = new GraphQLError(DISABLED_ERR.message, [DISABLED_ERR]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'disabled' });
  });

  it('gateway-masked disabled error (message replaced, code preserved) → disabled', () => {
    // In production the gateway masks the message of non-SAFE_CODES errors
    // but PRESERVES extensions.code.
    const err = new GraphQLError('masked', [{
      message: 'An error occurred. Please try again or contact support.',
      extensions: { code: 'INSTANT_FILL_DISABLED' },
    }]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'disabled' });
  });

  it('INVALID_INPUT with flattened extensions.lane → lane_conflict carrying the lane', () => {
    // HashlockError metadata { lane } is FLATTENED into extensions by
    // maskTradeError/formatGraphQLError — the real wire shape.
    const err = new GraphQLError(LANE_ERR.message, [LANE_ERR]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'lane_conflict', lane: 'Z' });
  });

  it('nested extensions.metadata.lane (non-flattening transport) still → lane_conflict', () => {
    const err = new GraphQLError('lane', [{
      message: 'lane', extensions: { code: 'INVALID_INPUT', metadata: { lane: 'B' } },
    }]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'lane_conflict', lane: 'B' });
  });

  it('INVALID_STATE_TRANSITION "already requested" → already_requested', () => {
    const err = new GraphQLError(ALREADY_ERR.message, [ALREADY_ERR]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'already_requested' });
  });

  it('other INVALID_STATE_TRANSITION errors (quote no longer firm / expired) → null', () => {
    // A dead quote would fail the standard accept too — silently falling
    // back would only obscure the real error.
    for (const message of ['Quote is no longer firm (status ACCEPTED)', 'Quote has expired']) {
      const err = new GraphQLError(message, [{
        message, extensions: { code: 'INVALID_STATE_TRANSITION', retryable: false },
      }]);
      expect(classifyInstantFillError(err)).toBeNull();
    }
  });

  it('unrelated GraphQL error → null (must be rethrown by callers)', () => {
    const err = new GraphQLError('Quote not found', [{ message: 'Quote not found' }]);
    expect(classifyInstantFillError(err)).toBeNull();
  });

  it('non-GraphQL errors → null', () => {
    expect(classifyInstantFillError(new NetworkError('boom'))).toBeNull();
    expect(classifyInstantFillError(new AuthError())).toBeNull();
    expect(classifyInstantFillError('nope')).toBeNull();
  });
});

// ─── Taker flow helper decision table ────────────────────────

describe('requestInstantFillAndAccept', () => {
  it('fill OK + accept OK → kind instant (canonical order: fill first)', async () => {
    const fetch = mockFetchSequence(
      { data: { requestInstantFill: FILL } },
      { data: { acceptQuote: QUOTE } },
    );
    const hl = createClient(fetch);

    const res = await hl.requestInstantFillAndAccept('rfq-1', 'q-1');
    expect(res.kind).toBe('instant');
    if (res.kind === 'instant') {
      expect(res.fill.id).toBe('fill-1');
      expect(res.quote.status).toBe('ACCEPTED');
    }
    // order: call 0 = requestInstantFill, call 1 = acceptQuote
    expect(requestBody(fetch, 0).query).toContain('requestInstantFill');
    expect(requestBody(fetch, 1).query).toContain('acceptQuote');
  });

  it('forwards the policy to acceptQuote on the instant path', async () => {
    const fetch = mockFetchSequence(
      { data: { requestInstantFill: FILL } },
      { data: { acceptQuote: QUOTE } },
    );
    const hl = createClient(fetch);

    await hl.requestInstantFillAndAccept('rfq-1', 'q-1', { policy: policyPresets.instant });
    expect(requestBody(fetch, 1).variables.policy).toEqual({ maxLatencyMs: 3000 });
  });

  it('fill DISABLED → standard accept fallback with reason disabled', async () => {
    const fetch = mockFetchSequence(
      { errors: [DISABLED_ERR] },
      { data: { acceptQuote: QUOTE } },
    );
    const hl = createClient(fetch);

    const res = await hl.requestInstantFillAndAccept('rfq-1', 'q-1');
    expect(res).toMatchObject({ kind: 'standard', reason: 'disabled' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestBody(fetch, 1).query).toContain('acceptQuote');
  });

  it('fill lane-409 → standard fallback with reason lane_conflict + lane', async () => {
    const fetch = mockFetchSequence(
      { errors: [LANE_ERR] },
      { data: { acceptQuote: QUOTE } },
    );
    const hl = createClient(fetch);

    const res = await hl.requestInstantFillAndAccept('rfq-1', 'q-1');
    expect(res).toMatchObject({ kind: 'standard', reason: 'lane_conflict', lane: 'Z' });
  });

  it('fill already-requested 409 → standard fallback with reason already_requested', async () => {
    const fetch = mockFetchSequence(
      { errors: [ALREADY_ERR] },
      { data: { acceptQuote: QUOTE } },
    );
    const hl = createClient(fetch);

    const res = await hl.requestInstantFillAndAccept('rfq-1', 'q-1');
    expect(res).toMatchObject({ kind: 'standard', reason: 'already_requested' });
  });

  it('unknown GraphQL error on fill → rethrown, accept NOT attempted', async () => {
    const fetch = mockFetchSequence({ errors: [{ message: 'Quote not found' }] });
    const hl = createClient(fetch);

    await expect(hl.requestInstantFillAndAccept('rfq-1', 'q-1')).rejects.toThrow(GraphQLError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('auth error on fill → rethrown as AuthError, no fallback', async () => {
    const fetch = mockFetchSequence({ status: 401 });
    const hl = createClient(fetch);

    await expect(hl.requestInstantFillAndAccept('rfq-1', 'q-1')).rejects.toThrow(AuthError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fill OK + accept FAIL → fill_orphaned with typed InstantFillOrphanedError', async () => {
    const fetch = mockFetchSequence(
      { data: { requestInstantFill: FILL } },
      { errors: [{ message: 'accept blew up' }] },
    );
    const hl = createClient(fetch);

    const res = await hl.requestInstantFillAndAccept('rfq-1', 'q-1');
    expect(res.kind).toBe('fill_orphaned');
    if (res.kind === 'fill_orphaned') {
      expect(res.error).toBeInstanceOf(InstantFillOrphanedError);
      expect(res.error.code).toBe('INSTANT_FILL_ORPHANED');
      expect(res.error.fill.id).toBe('fill-1');
      expect(res.error.acceptError.message).toBe('accept blew up');
      expect(res.fill.amountWei).toBe(FILL.amountWei);
    }
  });
});

describe('retryAcceptAfterInstantFill', () => {
  it('accept-only: succeeds without re-requesting the fill', async () => {
    const fetch = mockFetchSequence({ data: { acceptQuote: QUOTE } });
    const hl = createClient(fetch);

    const res = await hl.retryAcceptAfterInstantFill(FILL);
    expect(res.kind).toBe('instant');
    expect(fetch).toHaveBeenCalledTimes(1); // ONLY acceptQuote, never requestInstantFill
    const body = requestBody(fetch);
    expect(body.query).toContain('acceptQuote');
    expect(body.variables.quoteId).toBe('q-1'); // taken from fill.quoteId
  });

  it('repeated accept failure stays fill_orphaned (retryable again)', async () => {
    const fetch = mockFetchSequence({ errors: [{ message: 'still down' }] });
    const hl = createClient(fetch);

    const res = await hl.retryAcceptAfterInstantFill(FILL, policyPresets.trustless);
    expect(res.kind).toBe('fill_orphaned');
  });
});

// ─── Subscriptions (graphql-transport-ws over fake socket) ───

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  private listeners: Record<string, Listener[]> = {};

  constructor(public url: string, public protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  close(code?: number): void { this.closed = true; this.closeCode = code; }
  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const l of this.listeners[type] ?? []) l(event);
  }
  lastSent(): { type?: string; id?: string; payload?: Record<string, unknown> } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function createWsClient() {
  FakeWebSocket.instances = [];
  return new HashLock({
    endpoint: 'https://hashlock.markets/graphql',
    accessToken: 'test-token',
    fetch: vi.fn() as unknown as typeof fetch,
    webSocket: FakeWebSocket as unknown as WebSocketConstructor,
  });
}

describe('deriveWsEndpoint', () => {
  it('switches http(s) to ws(s) and leaves ws untouched', () => {
    expect(deriveWsEndpoint('https://hashlock.markets/graphql')).toBe('wss://hashlock.markets/graphql');
    expect(deriveWsEndpoint('http://localhost:4000/graphql')).toBe('ws://localhost:4000/graphql');
    expect(deriveWsEndpoint('wss://x/graphql')).toBe('wss://x/graphql');
  });
});

describe('onInstantFillRequested (solver-scoped subscription)', () => {
  it('runs the graphql-transport-ws handshake and delivers events', () => {
    const hl = createWsClient();
    const events: InstantFillRequestedEvent[] = [];
    hl.onInstantFillRequested((e) => events.push(e));

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://hashlock.markets/graphql');
    expect(ws.protocols).toBe('graphql-transport-ws');

    ws.emit('open');
    const init = ws.lastSent();
    expect(init.type).toBe('connection_init');
    expect(init.payload).toEqual({ authorization: 'Bearer test-token' });

    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    const sub = ws.lastSent();
    expect(sub.type).toBe('subscribe');
    const query = String(sub.payload?.query);
    expect(query).toContain('instantFillRequested');
    // InstantFillRequested payload: fillId quoteId rfqId state amountWei createdAt
    expect(query).toContain('fillId');
    expect(query).toContain('rfqId');
    expect(query).toContain('amountWei');
    // Fields that do NOT exist on InstantFillRequested must not be selected
    // (they made the live server reject the subscription).
    expect(query).not.toMatch(/\bid\b/);
    expect(query).not.toContain('tradeId');
    expect(query).not.toContain('frontTxHash');
    expect(query).not.toContain('frontedAt');

    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillRequested: REQUESTED_EVENT } } }),
    });
    expect(events).toHaveLength(1);
    expect(events[0].fillId).toBe('fill-1');
    expect(typeof events[0].amountWei).toBe('string');
  });

  it('unsubscribe sends complete and closes the socket', () => {
    const hl = createWsClient();
    const handle = hl.onInstantFillRequested(() => {});
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });

    handle.unsubscribe();
    expect(ws.lastSent()).toMatchObject({ id: '1', type: 'complete' });
    expect(ws.closed).toBe(true);
  });

  it('protocol error frames surface through onError as GraphQLError', () => {
    const hl = createWsClient();
    const errors: Error[] = [];
    hl.onInstantFillRequested(() => {}, { onError: (e) => errors.push(e) });
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    ws.emit('message', {
      data: JSON.stringify({ type: 'error', id: '1', payload: [{ message: 'forbidden' }] }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GraphQLError);
    expect(errors[0].message).toBe('forbidden');
  });

  it('unexpected close surfaces a NetworkError once', () => {
    const hl = createWsClient();
    const errors: Error[] = [];
    hl.onInstantFillRequested(() => {}, { onError: (e) => errors.push(e) });
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('close', { code: 1006 });
    ws.emit('error'); // must not double-report after close

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NetworkError);
  });

  it('throws a typed error when no WebSocket implementation exists', () => {
    const hl = new HashLock({
      endpoint: 'https://hashlock.markets/graphql',
      fetch: vi.fn() as unknown as typeof fetch,
    });
    const g = globalThis as { WebSocket?: unknown };
    const saved = g.WebSocket;
    delete g.WebSocket;
    try {
      expect(() => hl.onInstantFillRequested(() => {})).toThrow(/WebSocket/);
    } finally {
      if (saved !== undefined) g.WebSocket = saved;
    }
  });
});

describe('onInstantFillFronted (taker-scoped subscription)', () => {
  it('subscribes to instantFillFronted and delivers the fronted event', () => {
    const hl = createWsClient();
    const events: InstantFillFrontedEvent[] = [];
    hl.onInstantFillFronted((e) => events.push(e));
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    const query = String(ws.lastSent().payload?.query);
    expect(query).toContain('instantFillFronted');
    // InstantFillFronted payload: fillId quoteId rfqId tradeId state amountWei frontTxHash frontedAt
    expect(query).toContain('fillId');
    expect(query).toContain('tradeId');
    expect(query).toContain('frontTxHash');
    expect(query).toContain('frontedAt');
    // Fields that do NOT exist on InstantFillFronted must not be selected.
    expect(query).not.toMatch(/\bid\b/);
    expect(query).not.toContain('createdAt');

    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillFronted: FRONTED_EVENT } } }),
    });
    expect(events[0].state).toBe('fronted');
    expect(events[0].frontTxHash).toBe('0xfront');
  });
});

describe('serveInstantFills (solver flow helper)', () => {
  it('fronts each requested fill and auto-marks it fronted', async () => {
    FakeWebSocket.instances = [];
    const fetch = mockFetchSequence({
      data: { markInstantFillFronted: { ...FILL, state: 'fronted', frontTxHash: '0xfront' } },
    });
    const hl = new HashLock({
      endpoint: 'https://hashlock.markets/graphql',
      accessToken: 'test-token',
      fetch: fetch as unknown as typeof fetch,
      retries: 0,
      webSocket: FakeWebSocket as unknown as WebSocketConstructor,
    });

    const frontedFills: InstantFill[] = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    hl.serveInstantFills(
      // The event carries the fill id as `fillId` (no `id` field exists
      // on InstantFillRequested).
      async (event) => `0xfront-for-${event.fillId}`,
      { onFronted: (f) => { frontedFills.push(f); resolveDone(); } },
    );

    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillRequested: REQUESTED_EVENT } } }),
    });
    await done;

    expect(frontedFills).toHaveLength(1);
    expect(frontedFills[0].state).toBe('fronted');
    const body = requestBody(fetch);
    expect(body.query).toContain('markInstantFillFronted');
    expect(body.variables).toEqual({ fillId: 'fill-1', frontTxHash: '0xfront-for-fill-1' });
  });

  it('fronting failure reaches onError with the fill attached, watch continues', async () => {
    FakeWebSocket.instances = [];
    const hl = new HashLock({
      endpoint: 'https://hashlock.markets/graphql',
      accessToken: 'test-token',
      fetch: vi.fn() as unknown as typeof fetch,
      webSocket: FakeWebSocket as unknown as WebSocketConstructor,
    });

    const seen: Array<{ err: Error; event?: InstantFillRequestedEvent }> = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    hl.serveInstantFills(
      async () => { throw new Error('vault empty'); },
      { onError: (err, event) => { seen.push({ err, event }); resolveDone(); } },
    );

    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillRequested: REQUESTED_EVENT } } }),
    });
    await done;

    expect(seen[0].err.message).toBe('vault empty');
    expect(seen[0].event?.fillId).toBe('fill-1');
    expect(ws.closed).toBe(false); // subscription stays alive
  });
});
