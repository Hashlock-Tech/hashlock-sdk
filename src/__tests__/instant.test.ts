import { describe, it, expect, vi } from 'vitest';
import { HashLock } from '../hashlock.js';
import { GraphQLError, AuthError, NetworkError } from '../errors.js';
import {
  policyPresets,
  sanitizeAgentPolicy,
  classifyInstantFillError,
  InstantFillOrphanedError,
} from '../instant.js';
import type { InstantFill } from '../instant.js';
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

const QUOTE = { id: 'q-1', rfqId: 'rfq-1', status: 'ACCEPTED', trade: { id: 't-1', status: 'PROPOSED' } };

const DISABLED_ERR = { message: 'Instant fill is disabled', extensions: { code: 'INSTANT_FILL_DISABLED' } };
const LANE_ERR = {
  message: 'Quote routed to a non-instant lane',
  extensions: { code: 'CONFLICT', http: { status: 409 }, metadata: { lane: 'Z' } },
};
const ALREADY_ERR = {
  message: 'Instant fill already requested for this quote',
  extensions: { code: 'CONFLICT', http: { status: 409 } },
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
  it('passes a valid policy through', () => {
    expect(sanitizeAgentPolicy({ maxLatencyMs: 3000, maxFeeBps: 30, minTrust: 'med' }))
      .toEqual({ maxLatencyMs: 3000, maxFeeBps: 30, minTrust: 'med' });
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

  it('with policy declares $policy: AgentPolicyInput and forwards the sanitized policy', async () => {
    const fetch = mockFetchSequence({ data: { acceptQuote: QUOTE } });
    const hl = createClient(fetch);

    await hl.acceptQuote('q-1', { ...policyPresets.balanced, maxFeeBps: 30 });
    const body = requestBody(fetch);
    expect(body.query).toContain('$policy: AgentPolicyInput');
    expect(body.variables.policy).toEqual({ minTrust: 'med', maxFeeBps: 30 });
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
  it('INSTANT_FILL_DISABLED → disabled', () => {
    const err = new GraphQLError(DISABLED_ERR.message, [DISABLED_ERR]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'disabled' });
  });

  it('409 with metadata.lane → lane_conflict carrying the lane', () => {
    const err = new GraphQLError(LANE_ERR.message, [LANE_ERR]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'lane_conflict', lane: 'Z' });
  });

  it('409 without lane → already_requested', () => {
    const err = new GraphQLError(ALREADY_ERR.message, [ALREADY_ERR]);
    expect(classifyInstantFillError(err)).toEqual({ reason: 'already_requested' });
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
  it('runs the graphql-transport-ws handshake and delivers fills', () => {
    const hl = createWsClient();
    const fills: InstantFill[] = [];
    hl.onInstantFillRequested((f) => fills.push(f));

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
    expect(String(sub.payload?.query)).toContain('instantFillRequested');
    expect(String(sub.payload?.query)).toContain('amountWei');

    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillRequested: FILL } } }),
    });
    expect(fills).toHaveLength(1);
    expect(typeof fills[0].amountWei).toBe('string');
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
  it('subscribes to instantFillFronted and delivers the fronted fill', () => {
    const hl = createWsClient();
    const fills: InstantFill[] = [];
    hl.onInstantFillFronted((f) => fills.push(f));
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    expect(String(ws.lastSent().payload?.query)).toContain('instantFillFronted');

    const fronted = { ...FILL, state: 'fronted', frontTxHash: '0xfront' };
    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillFronted: fronted } } }),
    });
    expect(fills[0].state).toBe('fronted');
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
      async (fill) => `0xfront-for-${fill.id}`,
      { onFronted: (f) => { frontedFills.push(f); resolveDone(); } },
    );

    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillRequested: FILL } } }),
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

    const seen: Array<{ err: Error; fill?: InstantFill }> = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    hl.serveInstantFills(
      async () => { throw new Error('vault empty'); },
      { onError: (err, fill) => { seen.push({ err, fill }); resolveDone(); } },
    );

    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    ws.emit('message', {
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { instantFillRequested: FILL } } }),
    });
    await done;

    expect(seen[0].err.message).toBe('vault empty');
    expect(seen[0].fill?.id).toBe('fill-1');
    expect(ws.closed).toBe(false); // subscription stays alive
  });
});
