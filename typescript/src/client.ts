import { HashlockError } from './errors.js';
import type {
  Asset,
  CreateRfqInput,
  LegKey,
  Me,
  Page,
  Rfq,
  SettlementBuild,
  Swap,
  Thread,
  Webhook,
  WebhookEvent,
} from './types.js';

export interface HashlockClientOptions {
  /** Your API key: `hk_test_…` (testnet) or `hk_live_…` (mainnet). */
  apiKey: string;
  /** API base URL. Default: the public sandbox. Point at your own env / the prod host as needed. */
  baseUrl?: string;
  /** Override the fetch implementation (e.g. a custom agent). Defaults to global fetch. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Idempotency-Key — a retried unsafe request with the same key executes at most once. */
  idempotencyKey?: string;
}

const DEFAULT_BASE = 'https://api-dev.hashlock.markets/v1';

/**
 * Thin, typed client for the Hashlock Markets developer API (/v1). Custody-agnostic: the settlement
 * endpoints return UNSIGNED transactions you sign with your own key/HSM (see the examples), then hand
 * back to {@link HashlockClient.broadcast}. The server never holds your keys.
 */
export class HashlockClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HashlockClientOptions) {
    if (!opts.apiKey) throw new Error('HashlockClient: apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error('HashlockClient: no fetch available — pass options.fetch');
  }

  // ── core ───────────────────────────────────────────────────────────────────
  /** Verify the key and see its scopes. */
  me(): Promise<Me> {
    return this.request<Me>('/me');
  }
  /** The asset registry (chain, token|native, decimals, symbol). */
  async assets(): Promise<Asset[]> {
    return (await this.request<{ assets: Asset[] }>('/assets')).assets;
  }

  // ── RFQs ─────────────────────────────────────────────────────────────────────
  /** One page of the public order book. Pass `cursor`/`limit` to page. */
  listRfqs(params: { baseAssetId?: string; quoteAssetId?: string; direction?: string; limit?: number; cursor?: string } = {}): Promise<Page<Rfq>> {
    return this.page<Rfq>('/rfqs', 'rfqs', params);
  }
  /** Async-iterate the whole order book, following the cursor automatically. */
  rfqs(params: { baseAssetId?: string; quoteAssetId?: string; direction?: string; limit?: number } = {}): AsyncGenerator<Rfq> {
    return this.iterate<Rfq>('/rfqs', 'rfqs', params);
  }
  async getRfq(id: string): Promise<Rfq> {
    return (await this.request<{ rfq: Rfq }>(`/rfqs/${id}`)).rfq;
  }
  /** Create an RFQ (requires the `taker` scope). */
  async createRfq(input: CreateRfqInput, idempotencyKey?: string): Promise<Rfq> {
    return (await this.request<{ rfq: Rfq }>('/rfqs', { method: 'POST', body: input, idempotencyKey })).rfq;
  }
  /** Quote an RFQ (requires the `maker` scope) — opens a settlement thread. */
  quoteRfq(rfqId: string, quoteAmount: string, idempotencyKey?: string): Promise<{ thread: { id: string } }> {
    return this.request(`/rfqs/${rfqId}/quotes`, { method: 'POST', body: { quoteAmount }, idempotencyKey });
  }

  // ── negotiation thread ───────────────────────────────────────────────────────
  getThread(id: string): Promise<{ thread: Thread; rfq: Rfq; messages: unknown[] }> {
    return this.request(`/threads/${id}`);
  }
  proposeTerms(threadId: string, quoteAmount: string): Promise<{ thread: Thread }> {
    return this.request(`/threads/${threadId}/propose`, { method: 'POST', body: { quoteAmount } });
  }
  acceptProposal(threadId: string): Promise<{ thread: Thread }> {
    return this.request(`/threads/${threadId}/accept-proposal`, { method: 'POST' });
  }
  /**
   * Accept the current terms. When BOTH sides have accepted, the swap is created. The initiator (funds
   * the long leg) MUST pass `hashlock` = sha256(secret) — see {@link newSecret}.
   */
  acceptTerms(threadId: string, opts: { hashlock?: string } = {}): Promise<{ thread: Thread; swap?: Swap }> {
    return this.request(`/threads/${threadId}/accept`, { method: 'POST', body: opts });
  }

  // ── swaps ─────────────────────────────────────────────────────────────────────
  listSwaps(params: { limit?: number; cursor?: string } = {}): Promise<Page<Swap>> {
    return this.page<Swap>('/swaps', 'swaps', params);
  }
  swaps(params: { limit?: number } = {}): AsyncGenerator<Swap> {
    return this.iterate<Swap>('/swaps', 'swaps', params);
  }
  async getSwap(id: string): Promise<Swap> {
    return (await this.request<{ swap: Swap }>(`/swaps/${id}`)).swap;
  }
  /** Set your receive (payout) / refund address for a leg. Bitcoin: the compressed pubkey (hex). */
  async setSwapAddress(swapId: string, chain: string, address: string): Promise<Swap> {
    return (await this.request<{ swap: Swap }>(`/swaps/${swapId}/address`, { method: 'POST', body: { chain, address } })).swap;
  }

  // ── settlement builders (UNSIGNED — sign with your own key/HSM, then broadcast) ─
  buildFund(swapId: string, leg: LegKey): Promise<SettlementBuild> {
    return this.request(`/swaps/${swapId}/legs/${leg}/fund`, { method: 'POST' });
  }
  buildClaim(swapId: string, leg: LegKey, secret: string): Promise<SettlementBuild> {
    return this.request(`/swaps/${swapId}/legs/${leg}/claim`, { method: 'POST', body: { secret } });
  }
  buildRefund(swapId: string, leg: LegKey): Promise<SettlementBuild> {
    return this.request(`/swaps/${swapId}/legs/${leg}/refund`, { method: 'POST' });
  }
  /** Relay a client-signed transaction. `chain`: 'evm' (0x raw tx) | 'tron' (signed tx obj) | 'bitcoin' (raw hex). */
  broadcast(chain: 'evm' | 'tron' | 'bitcoin', signed: unknown, idempotencyKey?: string): Promise<{ txid: string }> {
    return this.request('/tx/broadcast', { method: 'POST', body: { chain, signed }, idempotencyKey });
  }

  // ── webhooks ─────────────────────────────────────────────────────────────────
  async listWebhooks(): Promise<Webhook[]> {
    return (await this.request<{ webhooks: Webhook[] }>('/webhooks')).webhooks;
  }
  /** Register a webhook. Returns the signing `secret` ONCE — store it to verify deliveries. */
  createWebhook(url: string, events?: WebhookEvent[]): Promise<{ webhook: Webhook; secret: string }> {
    return this.request('/webhooks', { method: 'POST', body: { url, events } });
  }
  deleteWebhook(id: string): Promise<{ ok: boolean }> {
    return this.request(`/webhooks/${id}`, { method: 'DELETE' });
  }
  pingWebhook(id: string): Promise<{ ok: boolean; deliveryId: string }> {
    return this.request(`/webhooks/${id}/ping`, { method: 'POST' });
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private async page<T>(path: string, key: string, params: Record<string, string | number | undefined>): Promise<Page<T>> {
    const r = await this.request<Record<string, unknown>>(path, { query: params });
    return { items: (r[key] as T[]) ?? [], nextCursor: (r.nextCursor as string | null) ?? null };
  }
  private async *iterate<T>(path: string, key: string, params: Record<string, string | number | undefined>): AsyncGenerator<T> {
    let cursor: string | null | undefined = undefined;
    do {
      const p: Page<T> = await this.page<T>(path, key, { ...params, cursor });
      for (const item of p.items) yield item;
      cursor = p.nextCursor;
    } while (cursor);
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    const res = await this.fetchImpl(url.toString(), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const msg = (data as { error?: string })?.error ?? `HTTP ${res.status}`;
      const retryAfter = res.headers.get('retry-after');
      throw new HashlockError(res.status, msg, data, retryAfter ? Number(retryAfter) : undefined);
    }
    return data as T;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
