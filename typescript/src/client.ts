import { HashlockError } from './errors.js';
import type {
  Asset,
  BtcPresignBuild,
  BtcPresignInput,
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
  /** API base URL. Default: the production API (https://api.hashlock.markets/v1). Point at another deployment as needed. */
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

const DEFAULT_BASE = 'https://api.hashlock.markets/v1';

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
  /** Verify the key and see its scopes and the account name (`handle`, `handlePublic`). */
  me(): Promise<Me> {
    return this.request<Me>('/me');
  }
  /**
   * Set the account's username (`handle`) and/or whether the accounts it trades with see it (`handlePublic`); needs the
   * `taker` or `maker` scope. An account is anonymous until `handlePublic` is true. While it is public, every account it
   * has a thread with — past deals included — sees the username and, beside it, the account's record over all its swaps.
   * `handlePublic: false` hides both again and keeps the username; `handle: null` removes it, makes the account
   * anonymous and frees the name. A username is 3 to 24 characters (a–z, digits, `_`), stored in lowercase; a taken one
   * is refused with 409, and it can be set ten times an hour, attempts refused as taken included (429). Returns the two
   * fields as they now stand.
   */
  setProfile(patch: { handle?: string | null; handlePublic?: boolean }, idempotencyKey?: string): Promise<Pick<Me, 'handle' | 'handlePublic'>> {
    return this.request('/me/profile', { method: 'PATCH', body: patch, idempotencyKey });
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
  /** Quote an RFQ (requires the `maker` scope) — opens a settlement thread. `quoteAmount` keeps at most 8 decimals of
   *  its asset (fewer if it has fewer). The quote is the maker's acceptance of that price; `makerAccepted: false` on the
   *  returned thread means the maker is the initiator and accepts right away with `acceptTerms` and its hashlock. */
  quoteRfq(rfqId: string, quoteAmount: string, idempotencyKey?: string): Promise<{ thread: Thread }> {
    return this.request(`/rfqs/${rfqId}/quotes`, { method: 'POST', body: { quoteAmount }, idempotencyKey });
  }

  // ── negotiation thread ───────────────────────────────────────────────────────
  /** `swap` is the swap once both sides accepted, else null. */
  getThread(id: string): Promise<{ thread: Thread; rfq: Rfq; messages: unknown[]; swap: Swap | null }> {
    return this.request(`/threads/${id}`);
  }
  /** Counter with a new price (at most 8 decimals of its asset) — proposing it is agreeing to it, so it is refused when
   *  you cannot fund your own leg at that price (see {@link acceptTerms}). The initiator agrees only with its hashlock,
   *  so it passes it here (the same one it uses on every accept in this thread); the API ignores it from the other side. */
  proposeTerms(threadId: string, quoteAmount: string, opts: { hashlock?: string } = {}): Promise<{ thread: Thread }> {
    return this.request(`/threads/${threadId}/propose`, { method: 'POST', body: { quoteAmount, hashlock: opts.hashlock } });
  }
  /**
   * Accept the counterparty's pending price. `quoteAmount` is the `pendingAmount` you read from
   * {@link getThread}; the server refuses if a newer counter has replaced it, or if you cannot fund your own leg
   * at that price (see {@link acceptTerms}).
   */
  acceptProposal(threadId: string, quoteAmount: string, opts: { accept?: boolean; hashlock?: string } = {}): Promise<{ thread: Thread; swap?: Swap }> {
    // `accept: true` also accepts the deal at that price in the same server transaction; only the counterparty's
    // acceptTerms is then left. The initiator passes its hashlock here (the server refuses one without accept).
    if (opts.hashlock && !opts.accept) throw new Error('hashlock is only taken with accept: true');
    const body = opts.accept ? { quoteAmount, accept: true, hashlock: opts.hashlock } : { quoteAmount };
    return this.request<{ thread: Thread; swap?: Swap }>(`/threads/${threadId}/accept-proposal`, { method: 'POST', body }).then((res) =>
      // An API older than the one-step take ignores `accept`: it took the price and nobody has accepted. Accept it
      // now — the same price, the same hashlock — so the result is the same either way.
      opts.accept && !res.swap && !res.thread.takerAccepted && !res.thread.makerAccepted
        ? this.acceptTerms(threadId, { quoteAmount, hashlock: opts.hashlock })
        : res,
    );
  }
  /**
   * Accept the current terms. When BOTH sides have accepted, the swap is created. `quoteAmount` is the
   * `currentQuoteAmount` you read from {@link getThread} — refused if the price moved since. The
   * initiator (funds the long leg) MUST also pass `hashlock` = sha256(secret) — see {@link newSecret}.
   * Refused ("Not enough X to fund this: … Top up first.") when your wallet cannot fund your own leg at that price:
   * the amount, the protocol fee if you are the taker, and the chain's coin reserve when the leg is that coin.
   */
  acceptTerms(threadId: string, opts: { quoteAmount: string; hashlock?: string }): Promise<{ thread: Thread; swap?: Swap }> {
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
  /**
   * Set your receive (payout) / refund address for a leg. Bitcoin: the compressed pubkey (hex) — or, as the
   * leg's receiver, a Bitcoin ADDRESS, which sets where your claim
   * pays (`aClaimTo` / `bClaimTo`; the escrow stays on your key) and is accepted only while no leg is funded.
   * Over an API key, an address that receives money must be a wallet this account signed in with, or one proven with
   * the login wallet's authorisation or from a web wallet session — a key-only proof does not count. A payout change
   * is refused (409) while the other side's funding of the leg that pays you is on its way. When both legs are on the same chain, pass `leg` ('a' or 'b') — the maker funds leg a and receives on leg b, the
   * taker the reverse; the API refuses the call without it then.
   */
  async setSwapAddress(swapId: string, chain: string, address: string, leg?: 'a' | 'b'): Promise<Swap> {
    return (await this.request<{ swap: Swap }>(`/swaps/${swapId}/address`, { method: 'POST', body: { chain, address, leg } })).swap;
  }

  // ── settlement builders (UNSIGNED — sign with your own key/HSM, then broadcast) ─
  /** A Solana funding the wallet cannot cover (amount, fee, rent) is refused (400) with the reason, before anyone signs. */
  buildFund(swapId: string, leg: LegKey): Promise<SettlementBuild> {
    return this.request(`/swaps/${swapId}/legs/${leg}/fund`, { method: 'POST' });
  }
  /**
   * Sends the secret. On every chain but Bitcoin a claim closes at the leg's timelock, and the initiator's is
   * refused (409) from 10 minutes before it — unless the secret is already out, when it is still built. Bitcoin: `to` is where the claim
   * pays — default the leg's `claimTo`, and any other address is refused (409) while one is set.
   */
  buildClaim(swapId: string, leg: LegKey, secret: string, opts: { to?: string } = {}): Promise<SettlementBuild> {
    return this.request(`/swaps/${swapId}/legs/${leg}/claim`, { method: 'POST', body: { secret, to: opts.to } });
  }
  /**
   * Only after the leg's timelock. Bitcoin: `to` is where the refund pays — default the refund key's P2WPKH;
   * `escrow` refunds an escrow this leg moved off (after a pubkey correction) instead of its current one.
   */
  buildRefund(swapId: string, leg: LegKey, opts: { to?: string; escrow?: string } = {}): Promise<SettlementBuild> {
    return this.request(`/swaps/${swapId}/legs/${leg}/refund`, {
      method: 'POST',
      query: { escrow: opts.escrow },
      body: opts.to ? { to: opts.to } : undefined,
    });
  }
  /**
   * Bitcoin leg: its claim (`kind: 'claim'`, the default — the leg's receiver, once the escrow is recorded) or the
   * initiator's refund (`kind: 'refund'`, its funder) at up to three fee levels, to sign now and hand to
   * {@link storePresign}. `to` as in {@link buildClaim} / {@link buildRefund}.
   */
  buildPresign(swapId: string, leg: LegKey, opts: { kind?: 'claim' | 'refund'; to?: string } = {}): Promise<BtcPresignBuild> {
    return this.request(`/swaps/${swapId}/legs/${leg}/presign`, { query: { kind: opts.kind, to: opts.to } });
  }
  /** Store the signed levels from {@link buildPresign}; each is verified against the escrow and the script's key. */
  async storePresign(swapId: string, leg: LegKey, input: BtcPresignInput): Promise<Swap> {
    return (await this.request<{ swap: Swap }>(`/swaps/${swapId}/legs/${leg}/presign`, { method: 'POST', body: input })).swap;
  }
/**
   * Relay a transaction you signed yourself:
   *   - `evm` — a raw `0x…` transaction;
   *   - `tron` — the signed transaction object;
   *   - `solana` — the base64 transaction from the build step, with your signature in it;
   *   - `bitcoin` — either a raw hex transaction, or `{ psbtBase64, signaturesHex, preimageHex? }`
   *     from a `btc-sighash` build, in which case the witness is assembled for you (omit
   *     `preimageHex` to take the refund branch).
   */
  // `'tron'` here, not the `'tvm'` a build's `family` carries: this is the broadcast route's own
  // vocabulary, and the two really do differ.
  broadcast(chain: 'evm' | 'tron' | 'bitcoin' | 'solana', signed: unknown, idempotencyKey?: string): Promise<{ txid: string }> {
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
