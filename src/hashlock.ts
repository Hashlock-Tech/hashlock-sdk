import { GraphQLClient } from './client.js';
import { warnIfExperimental } from './experimental.js';
import { HashLockError } from './errors.js';
import {
  INSTANT_FILL_FIELDS,
  INSTANT_FILL_REQUESTED_FIELDS,
  INSTANT_FILL_FRONTED_FIELDS,
  InstantFillOrphanedError,
  classifyInstantFillError,
  sanitizeAgentPolicy,
} from './instant.js';
import type {
  AgentPolicy,
  InstantFill,
  InstantFillRequestedEvent,
  InstantFillFrontedEvent,
  InstantTakerResult,
} from './instant.js';
import {
  deriveWsEndpoint,
  subscribeOverWebSocket,
} from './ws.js';
import type { SubscriptionHandle, WebSocketConstructor } from './ws.js';
import type {
  HashLockConfig,
  RFQ,
  Quote,
  Trade,
  HTLC,
  HTLCStatusResult,
  FundHTLCResult,
  FundHTLCInput,
  ClaimHTLCInput,
  RefundHTLCInput,
  CreateRFQInput,
  SubmitQuoteInput,
  ConfirmDirectTradeInput,
  ConfirmSettlementWalletsInput,
  PrepareBitcoinHTLCInput,
  BitcoinHTLCPrepareResult,
  BuildBitcoinClaimPSBTInput,
  BitcoinClaimPSBTResult,
  BroadcastBitcoinTxInput,
  BitcoinBroadcastResult,
  TradeStatus,
  RFQStatus,
} from './types.js';

/**
 * Canonical Hashlock Markets production endpoint.
 *
 * Points at api-gateway's /graphql (not /api/graphql — that path is a
 * browser-only Next.js SSR proxy that reads the httpOnly api-token cookie
 * and ignores the Authorization header, so it rejects every SDK call
 * with `Unauthorized — missing api-token`).
 *
 * /graphql is served directly by the Apollo gateway and accepts
 * `Authorization: Bearer <accessToken>`, which matches how this SDK
 * constructs its requests (see makeRequest in this file).
 *
 * Superseded: `http://142.93.106.129/api/graphql` (old DigitalOcean
 * droplet IP, compromised 2026-04-22, now unreachable and possibly
 * attacker-controlled — never restore).
 */
export const MAINNET_ENDPOINT = 'https://hashlock.markets/graphql';

/**
 * HashLock SDK — TypeScript client for HashLock OTC trading platform.
 *
 * @example
 * ```ts
 * import { HashLock } from '@hashlock-tech/sdk';
 *
 * const hl = new HashLock({
 *   endpoint: 'https://hashlock.markets/graphql',
 *   accessToken: 'your-jwt-token',
 * });
 *
 * const rfq = await hl.createRFQ({
 *   baseToken: 'ETH',
 *   quoteToken: 'USDT',
 *   side: 'SELL',
 *   amount: '1.0',
 * });
 * ```
 */
export class HashLock {
  private client: GraphQLClient;
  private config: HashLockConfig;

  constructor(config: HashLockConfig) {
    this.config = config;
    this.client = new GraphQLClient(config);
  }

  /** Update the access token (e.g., after login or token refresh) */
  setAccessToken(token: string): void {
    this.client.setAccessToken(token);
  }

  // ─── RFQ ─────────────────────────────────────────────────

  /**
   * Create a Request for Quote (RFQ).
   * Broadcasts to market makers who can respond with prices.
   *
   * @example
   * ```ts
   * const rfq = await hl.createRFQ({
   *   baseToken: 'ETH',
   *   quoteToken: 'USDT',
   *   side: 'SELL',
   *   amount: '10.0',
   *   expiresIn: 300, // 5 minutes
   * });
   * console.log(`RFQ created: ${rfq.id}`);
   * ```
   */
  async createRFQ(input: CreateRFQInput): Promise<RFQ> {
    warnIfExperimental('createRFQ', input as unknown as Record<string, unknown>);
    const { createRFQ } = await this.client.mutate<{ createRFQ: RFQ }>(`
      mutation CreateRFQ($baseToken: String!, $quoteToken: String!, $side: Side!, $amount: String!, $expiresIn: Int, $isBlind: Boolean, $baseChain: String, $quoteChain: String) {
        createRFQ(baseToken: $baseToken, quoteToken: $quoteToken, side: $side, amount: $amount, expiresIn: $expiresIn, isBlind: $isBlind, baseChain: $baseChain, quoteChain: $quoteChain) {
          id userId baseToken quoteToken side amount isBlind status expiresAt createdAt quotesCount
        }
      }
    `, input);
    return createRFQ;
  }

  /**
   * Get a single RFQ by ID.
   */
  async getRFQ(id: string): Promise<RFQ | null> {
    const { rfq } = await this.client.query<{ rfq: RFQ | null }>(`
      query GetRFQ($id: ID!) {
        rfq(id: $id) {
          id userId baseToken quoteToken side amount isBlind status expiresAt createdAt quotesCount
          quotes { id rfqId marketMakerId price amount status createdAt }
        }
      }
    `, { id });
    return rfq;
  }

  /**
   * List RFQs with optional status filter and pagination.
   */
  async listRFQs(params?: { status?: RFQStatus; page?: number; pageSize?: number }) {
    const { rfqs } = await this.client.query<{ rfqs: { rfqs: RFQ[]; total: number; page: number; pageSize: number } }>(`
      query ListRFQs($status: RFQStatus, $page: Int, $pageSize: Int) {
        rfqs(status: $status, page: $page, pageSize: $pageSize) {
          rfqs { id userId baseToken quoteToken side amount isBlind status expiresAt createdAt quotesCount }
          total page pageSize
        }
      }
    `, params);
    return rfqs;
  }

  /**
   * Cancel an active RFQ.
   */
  async cancelRFQ(id: string): Promise<RFQ> {
    const { cancelRFQ } = await this.client.mutate<{ cancelRFQ: RFQ }>(`
      mutation CancelRFQ($id: ID!) {
        cancelRFQ(id: $id) {
          id status
        }
      }
    `, { id });
    return cancelRFQ;
  }

  // ─── Quotes ──────────────────────────────────────────────

  /**
   * Submit a price quote in response to an RFQ.
   *
   * @example
   * ```ts
   * const quote = await hl.submitQuote({
   *   rfqId: 'rfq-uuid',
   *   price: '3450.00',
   *   amount: '10.0',
   * });
   * ```
   */
  async submitQuote(input: SubmitQuoteInput): Promise<Quote> {
    warnIfExperimental('submitQuote', input as unknown as Record<string, unknown>);
    const { submitQuote } = await this.client.mutate<{ submitQuote: Quote }>(`
      mutation SubmitQuote($rfqId: ID!, $price: String!, $amount: String!, $expiresIn: Int, $instantFill: Boolean, $solverVaultAddr: String) {
        submitQuote(rfqId: $rfqId, price: $price, amount: $amount, expiresIn: $expiresIn, instantFill: $instantFill, solverVaultAddr: $solverVaultAddr) {
          id rfqId marketMakerId price amount status createdAt expiresAt instantFill solverVaultAddr
        }
      }
    `, input);
    return submitQuote;
  }

  /**
   * Accept a quote — creates a trade from the RFQ flow.
   *
   * @param policy Optional settlement PREFERENCE (`AgentPolicy`). A
   * policy never causes the accept to fail: the SDK sanitizes it
   * (invalid fields are dropped; nothing valid left → omitted
   * entirely) and the backend treats it as routing advice only.
   * Use `policyPresets.instant / .balanced / .trustless` or spread
   * your own: `{ ...policyPresets.balanced, maxFeeBps: 30 }`.
   *
   * WIRE NOTE: the schema's `AgentPolicyInput.minTrust` is `Int`
   * (a 0-100 trust score) — a `TrustLevel` string is converted via
   * `TRUST_LEVEL_TO_SCORE` (low→0, med→50, max→100) before sending;
   * raw 0-100 numbers are floored/clamped. See `sanitizeAgentPolicy`.
   */
  async acceptQuote(quoteId: string, policy?: AgentPolicy): Promise<Quote> {
    const sanitized = sanitizeAgentPolicy(policy);
    if (sanitized) {
      const { acceptQuote } = await this.client.mutate<{ acceptQuote: Quote }>(`
        mutation AcceptQuote($quoteId: ID!, $policy: AgentPolicyInput) {
          acceptQuote(quoteId: $quoteId, policy: $policy) {
            id rfqId status trade { id status }
          }
        }
      `, { quoteId, policy: sanitized });
      return acceptQuote;
    }
    const { acceptQuote } = await this.client.mutate<{ acceptQuote: Quote }>(`
      mutation AcceptQuote($quoteId: ID!) {
        acceptQuote(quoteId: $quoteId) {
          id rfqId status trade { id status }
        }
      }
    `, { quoteId });
    return acceptQuote;
  }

  /**
   * Get all quotes for an RFQ.
   */
  async getQuotes(rfqId: string): Promise<Quote[]> {
    const { quotes } = await this.client.query<{ quotes: Quote[] }>(`
      query GetQuotes($rfqId: ID!) {
        quotes(rfqId: $rfqId) {
          id rfqId marketMakerId price amount status createdAt expiresAt
          deliveryDelayHours collateralBtcSats isCollateralBacked
        }
      }
    `, { rfqId });
    return quotes;
  }

  // ─── Instant Settlement (Lane A) ─────────────────────────

  /**
   * Request an instant fill for a quote that carries an instant-fill
   * commitment (`quote.instantFill === true`). Taker side.
   *
   * CANONICAL ORDER: call this FIRST; only after it succeeds call
   * `acceptQuote`. Prefer `requestInstantFillAndAccept` which
   * enforces the order and maps the typed failure modes for you.
   *
   * Typed failures (see `classifyInstantFillError`):
   * - `INSTANT_FILL_DISABLED` — feature flag off
   * - 409 with `extensions.metadata.lane` — lane conflict
   * - 409 without lane — fill already requested for this quote
   */
  async requestInstantFill(rfqId: string, quoteId: string): Promise<InstantFill> {
    const { requestInstantFill } = await this.client.mutate<{ requestInstantFill: InstantFill }>(`
      mutation RequestInstantFill($rfqId: ID!, $quoteId: ID!) {
        requestInstantFill(rfqId: $rfqId, quoteId: $quoteId) {
          ${INSTANT_FILL_FIELDS}
        }
      }
    `, { rfqId, quoteId });
    return requestInstantFill;
  }

  /**
   * Mark an instant fill as fronted — solver side (must be the
   * market maker of the underlying quote). Call after the vault's
   * fronting payment tx is sent on-chain.
   */
  async markInstantFillFronted(fillId: string, frontTxHash: string): Promise<InstantFill> {
    const { markInstantFillFronted } = await this.client.mutate<{ markInstantFillFronted: InstantFill }>(`
      mutation MarkInstantFillFronted($fillId: ID!, $frontTxHash: String!) {
        markInstantFillFronted(fillId: $fillId, frontTxHash: $frontTxHash) {
          ${INSTANT_FILL_FIELDS}
        }
      }
    `, { fillId, frontTxHash });
    return markInstantFillFronted;
  }

  /**
   * Taker flow helper — the canonical instant-fill sequence in one
   * call, with typed fallbacks (see `InstantTakerResult`):
   *
   * 1. `requestInstantFill(rfqId, quoteId)`
   *    - SUCCESS → 2
   *    - typed refusal (disabled / lane conflict / already requested)
   *      → standard `acceptQuote` fallback → `{ kind: 'standard', reason }`
   *    - any other error (auth/network/validation) → THROWN
   * 2. `acceptQuote(quoteId, policy)`
   *    - SUCCESS → `{ kind: 'instant', fill, quote }`
   *    - FAILURE → `{ kind: 'fill_orphaned', fill, error }` — the fill
   *      is committed server-side; recover with
   *      `retryAcceptAfterInstantFill(result.fill)`.
   *
   * @example
   * ```ts
   * const res = await hl.requestInstantFillAndAccept(rfqId, quoteId, {
   *   policy: policyPresets.instant,
   * });
   * if (res.kind === 'instant') console.log('fronting incoming', res.fill.amountWei);
   * if (res.kind === 'standard') console.log('standard path:', res.reason);
   * if (res.kind === 'fill_orphaned') await hl.retryAcceptAfterInstantFill(res.fill);
   * ```
   */
  async requestInstantFillAndAccept(
    rfqId: string,
    quoteId: string,
    options?: { policy?: AgentPolicy },
  ): Promise<InstantTakerResult> {
    let fill: InstantFill;
    try {
      fill = await this.requestInstantFill(rfqId, quoteId);
    } catch (err) {
      const fallback = classifyInstantFillError(err);
      if (!fallback) throw err; // unexpected — do not swallow
      const quote = await this.acceptQuote(quoteId, options?.policy);
      return { kind: 'standard', reason: fallback.reason, lane: fallback.lane, quote };
    }

    try {
      const quote = await this.acceptQuote(quoteId, options?.policy);
      return { kind: 'instant', fill, quote };
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      return { kind: 'fill_orphaned', fill, error: new InstantFillOrphanedError(fill, cause) };
    }
  }

  /**
   * Accept-only retry for an orphaned instant fill (fill committed,
   * accept failed). NEVER re-requests the fill — a second
   * `requestInstantFill` would 409 on the exactly-once-per-quote
   * guard. Returns the same result union as
   * `requestInstantFillAndAccept`.
   */
  async retryAcceptAfterInstantFill(
    fill: InstantFill,
    policy?: AgentPolicy,
  ): Promise<InstantTakerResult> {
    try {
      const quote = await this.acceptQuote(fill.quoteId, policy);
      return { kind: 'instant', fill, quote };
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      return { kind: 'fill_orphaned', fill, error: new InstantFillOrphanedError(fill, cause) };
    }
  }

  /**
   * Solver side: subscribe to instant-fill requests against YOUR
   * quotes (server scopes the stream by the authenticated maker).
   * Requires a WebSocket-capable runtime (see `HashLockConfig.webSocket`).
   *
   * The payload is `InstantFillRequestedEvent` (fillId/quoteId/rfqId/
   * state/amountWei/createdAt) — NOT the `InstantFill` mutation type;
   * the fill id arrives as `fillId`.
   */
  onInstantFillRequested(
    onFill: (event: InstantFillRequestedEvent) => void,
    opts?: { onError?: (err: Error) => void; onComplete?: () => void },
  ): SubscriptionHandle {
    return this.subscribeInstantFill(
      'instantFillRequested',
      INSTANT_FILL_REQUESTED_FIELDS,
      onFill,
      opts,
    );
  }

  /**
   * Taker side: subscribe to fronting notifications for YOUR
   * instant fills (server scopes the stream by the authenticated taker).
   *
   * The payload is `InstantFillFrontedEvent` (fillId/quoteId/rfqId/
   * tradeId/state/amountWei/frontTxHash/frontedAt).
   */
  onInstantFillFronted(
    onFill: (event: InstantFillFrontedEvent) => void,
    opts?: { onError?: (err: Error) => void; onComplete?: () => void },
  ): SubscriptionHandle {
    return this.subscribeInstantFill(
      'instantFillFronted',
      INSTANT_FILL_FRONTED_FIELDS,
      onFill,
      opts,
    );
  }

  /**
   * Solver flow helper: watch `instantFillRequested`, front each fill
   * via your `front` callback (send the vault payment, return its tx
   * hash), then `markInstantFillFronted` automatically.
   *
   * @example
   * ```ts
   * const handle = hl.serveInstantFills(async (event) => {
   *   const txHash = await vault.front(event.quoteId, BigInt(event.amountWei));
   *   return txHash;
   * }, { onFronted: (f) => console.log('fronted', f.id) });
   * ```
   */
  serveInstantFills(
    front: (event: InstantFillRequestedEvent) => Promise<string>,
    opts?: {
      onFronted?: (fill: InstantFill) => void;
      onError?: (err: Error, event?: InstantFillRequestedEvent) => void;
      onComplete?: () => void;
    },
  ): SubscriptionHandle {
    return this.onInstantFillRequested(
      (event) => {
        void (async () => {
          try {
            const txHash = await front(event);
            const updated = await this.markInstantFillFronted(event.fillId, txHash);
            opts?.onFronted?.(updated);
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            opts?.onError?.(e, event);
          }
        })();
      },
      { onError: (err) => opts?.onError?.(err), onComplete: opts?.onComplete },
    );
  }

  private subscribeInstantFill<T>(
    field: 'instantFillRequested' | 'instantFillFronted',
    selection: string,
    onFill: (event: T) => void,
    opts?: { onError?: (err: Error) => void; onComplete?: () => void },
  ): SubscriptionHandle {
    const ctor =
      this.config.webSocket ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!ctor) {
      throw new HashLockError(
        'GraphQL subscriptions need a WebSocket implementation — pass ' +
          "`webSocket` in HashLockConfig (e.g. `import WebSocket from 'ws'`) " +
          'or run on a runtime with a global WebSocket (browsers, Node >= 22).',
        'WEBSOCKET_UNAVAILABLE',
      );
    }
    const opName = field === 'instantFillRequested' ? 'InstantFillRequested' : 'InstantFillFronted';
    return subscribeOverWebSocket<Record<string, T>>({
      url: this.config.wsEndpoint ?? deriveWsEndpoint(this.config.endpoint),
      webSocket: ctor,
      token: this.client.getAccessToken(),
      query: `subscription ${opName} { ${field} { ${selection} } }`,
      onData: (data) => {
        const fill = data[field];
        if (fill) onFill(fill);
      },
      onError: opts?.onError,
      onComplete: opts?.onComplete,
    });
  }

  // ─── Trades ──────────────────────────────────────────────

  /**
   * Get a single trade by ID.
   */
  async getTrade(id: string): Promise<Trade | null> {
    const { trade } = await this.client.query<{ trade: Trade | null }>(`
      query GetTrade($id: ID!) {
        trade(id: $id) {
          id initiatorId counterpartyId baseToken quoteToken side baseAmount quoteAmount price status createdAt
        }
      }
    `, { id });
    return trade;
  }

  /**
   * List trades with optional status filter.
   */
  async listTrades(params?: { status?: TradeStatus; page?: number; pageSize?: number }) {
    const { trades } = await this.client.query<{ trades: { trades: Trade[]; total: number } }>(`
      query ListTrades($status: TradeStatus, $page: Int, $pageSize: Int) {
        trades(status: $status, page: $page, pageSize: $pageSize) {
          trades { id initiatorId counterpartyId baseToken quoteToken side baseAmount quoteAmount price status createdAt }
          total
        }
      }
    `, params);
    return trades;
  }

  /**
   * Create a direct trade from 1-on-1 chat (skips RFQ flow).
   */
  async confirmDirectTrade(input: ConfirmDirectTradeInput): Promise<Trade> {
    const { confirmDirectTrade } = await this.client.mutate<{ confirmDirectTrade: Trade }>(`
      mutation ConfirmDirectTrade($counterpartyId: ID!, $baseToken: String!, $quoteToken: String!, $side: Side!, $baseAmount: String!, $price: String!, $chainId: String!, $broadcastRfqId: ID, $conversationId: ID) {
        confirmDirectTrade(counterpartyId: $counterpartyId, baseToken: $baseToken, quoteToken: $quoteToken, side: $side, baseAmount: $baseAmount, price: $price, chainId: $chainId, broadcastRfqId: $broadcastRfqId, conversationId: $conversationId) {
          id initiatorId counterpartyId baseToken quoteToken side baseAmount quoteAmount price status createdAt
        }
      }
    `, input);
    return confirmDirectTrade;
  }

  /**
   * Accept a proposed trade.
   */
  async acceptTrade(tradeId: string): Promise<Trade> {
    const { acceptTrade } = await this.client.mutate<{ acceptTrade: Trade }>(`
      mutation AcceptTrade($tradeId: ID!) {
        acceptTrade(tradeId: $tradeId) { id status }
      }
    `, { tradeId });
    return acceptTrade;
  }

  /**
   * Cancel a trade.
   */
  async cancelTrade(tradeId: string): Promise<Trade> {
    const { cancelTrade } = await this.client.mutate<{ cancelTrade: Trade }>(`
      mutation CancelTrade($tradeId: ID!) {
        cancelTrade(tradeId: $tradeId) { id status }
      }
    `, { tradeId });
    return cancelTrade;
  }

  /**
   * Confirm settlement wallets for a trade.
   */
  async confirmSettlementWallets(input: ConfirmSettlementWalletsInput): Promise<Trade> {
    const { confirmSettlementWallets } = await this.client.mutate<{ confirmSettlementWallets: Trade }>(`
      mutation ConfirmWallets($tradeId: ID!, $sendWalletId: ID!, $receiveWalletId: ID!) {
        confirmSettlementWallets(tradeId: $tradeId, sendWalletId: $sendWalletId, receiveWalletId: $receiveWalletId) {
          id status
        }
      }
    `, input);
    return confirmSettlementWallets;
  }

  // ─── HTLC — EVM (ETH / ERC-20) ──────────────────────────

  /**
   * Record an on-chain HTLC funding transaction.
   * Called after the user sends an ETH/ERC20 lock tx on-chain.
   *
   * @example
   * ```ts
   * // After sending ETH lock tx on-chain via ethers/viem:
   * const result = await hl.fundHTLC({
   *   tradeId: 'trade-uuid',
   *   txHash: '0xabc...',
   *   role: 'INITIATOR',
   *   timelock: Math.floor(Date.now() / 1000) + 3600,
   *   hashlock: '0x...',
   * });
   * ```
   */
  async fundHTLC(input: FundHTLCInput): Promise<FundHTLCResult> {
    warnIfExperimental('fundHTLC', input as unknown as Record<string, unknown>);
    const { fundHTLC } = await this.client.mutate<{ fundHTLC: FundHTLCResult }>(`
      mutation FundHTLC($tradeId: ID!, $txHash: String!, $role: HTLCRole!, $timelock: Int, $hashlock: String, $chainType: String, $senderPubKey: String, $receiverPubKey: String, $redeemScript: String, $refundTxHex: String, $preimage: String) {
        fundHTLC(tradeId: $tradeId, txHash: $txHash, role: $role, timelock: $timelock, hashlock: $hashlock, chainType: $chainType, senderPubKey: $senderPubKey, receiverPubKey: $receiverPubKey, redeemScript: $redeemScript, refundTxHex: $refundTxHex, preimage: $preimage) {
          tradeId txHash status
        }
      }
    `, input);
    return fundHTLC;
  }

  /**
   * Record an on-chain HTLC claim (preimage reveal).
   *
   * @example
   * ```ts
   * const result = await hl.claimHTLC({
   *   tradeId: 'trade-uuid',
   *   txHash: '0xdef...',
   *   preimage: '0x...',
   * });
   * ```
   */
  async claimHTLC(input: ClaimHTLCInput): Promise<HTLCStatusResult> {
    const { claimHTLC } = await this.client.mutate<{ claimHTLC: HTLCStatusResult }>(`
      mutation ClaimHTLC($tradeId: ID!, $txHash: String!, $preimage: String!, $chainType: String) {
        claimHTLC(tradeId: $tradeId, txHash: $txHash, preimage: $preimage, chainType: $chainType) {
          tradeId status
        }
      }
    `, input);
    return claimHTLC;
  }

  /**
   * Record an on-chain HTLC refund (after timelock expiry).
   *
   * @example
   * ```ts
   * const result = await hl.refundHTLC({
   *   tradeId: 'trade-uuid',
   *   txHash: '0x...',
   * });
   * ```
   */
  async refundHTLC(input: RefundHTLCInput): Promise<HTLCStatusResult> {
    const { refundHTLC } = await this.client.mutate<{ refundHTLC: HTLCStatusResult }>(`
      mutation RefundHTLC($tradeId: ID!, $txHash: String!, $chainType: String) {
        refundHTLC(tradeId: $tradeId, txHash: $txHash, chainType: $chainType) {
          tradeId status
        }
      }
    `, input);
    return refundHTLC;
  }

  /**
   * Get HTLC status for a trade (both initiator and counterparty HTLCs).
   */
  async getHTLCStatus(tradeId: string): Promise<HTLCStatusResult | null> {
    const { htlcStatus } = await this.client.query<{ htlcStatus: HTLCStatusResult | null }>(`
      query HTLCStatus($tradeId: ID!) {
        htlcStatus(tradeId: $tradeId) {
          tradeId status
          initiatorHTLC { id tradeId role status contractAddress hashlock timelock amount txHash chainId }
          counterpartyHTLC { id tradeId role status contractAddress hashlock timelock amount txHash chainId }
        }
      }
    `, { tradeId });
    return htlcStatus;
  }

  /**
   * Get all HTLCs for a trade.
   */
  async getHTLCs(tradeId: string): Promise<HTLC[]> {
    const { htlcs } = await this.client.query<{ htlcs: HTLC[] }>(`
      query GetHTLCs($tradeId: ID!) {
        htlcs(tradeId: $tradeId) {
          id tradeId role status contractAddress hashlock timelock amount txHash chainType preimage
        }
      }
    `, { tradeId });
    return htlcs;
  }

  // ─── HTLC — Bitcoin ──────────────────────────────────────

  /**
   * Prepare a Bitcoin HTLC. Returns P2WSH address and redeem script.
   * The client funds this address, then calls fundHTLC with the txHash.
   *
   * @example
   * ```ts
   * const btcHtlc = await hl.prepareBitcoinHTLC({
   *   tradeId: 'trade-uuid',
   *   role: 'INITIATOR',
   *   senderPubKey: '02abc...',
   *   receiverPubKey: '03def...',
   *   timelock: Math.floor(Date.now() / 1000) + 7200,
   *   amountSats: '100000', // 0.001 BTC
   * });
   * console.log(`Fund this address: ${btcHtlc.htlcAddress}`);
   * ```
   */
  async prepareBitcoinHTLC(input: PrepareBitcoinHTLCInput): Promise<BitcoinHTLCPrepareResult> {
    const { prepareBitcoinHTLC } = await this.client.mutate<{ prepareBitcoinHTLC: BitcoinHTLCPrepareResult }>(`
      mutation PrepareBTCHTLC($tradeId: ID!, $role: HTLCRole!, $senderPubKey: String!, $receiverPubKey: String!, $timelock: Int!, $amountSats: String!) {
        prepareBitcoinHTLC(tradeId: $tradeId, role: $role, senderPubKey: $senderPubKey, receiverPubKey: $receiverPubKey, timelock: $timelock, amountSats: $amountSats) {
          tradeId htlcId htlcAddress redeemScript hashlock preimageHash timelock amountSats estimatedClaimFee estimatedRefundFee refundPsbt
        }
      }
    `, input);
    return prepareBitcoinHTLC;
  }

  /**
   * Build an unsigned claim PSBT for a Bitcoin HTLC.
   * The client signs with their wallet, then broadcasts via broadcastBitcoinTx.
   */
  async buildBitcoinClaimPSBT(input: BuildBitcoinClaimPSBTInput): Promise<BitcoinClaimPSBTResult> {
    const { buildBitcoinClaimPSBT } = await this.client.mutate<{ buildBitcoinClaimPSBT: BitcoinClaimPSBTResult }>(`
      mutation BuildClaim($tradeId: ID!, $htlcId: ID!, $preimage: String!, $destinationPubKey: String!, $feeRate: Int) {
        buildBitcoinClaimPSBT(tradeId: $tradeId, htlcId: $htlcId, preimage: $preimage, destinationPubKey: $destinationPubKey, feeRate: $feeRate) {
          tradeId htlcId psbtBase64 fee utxoTxid utxoVout
        }
      }
    `, input);
    return buildBitcoinClaimPSBT;
  }

  /**
   * Broadcast a signed Bitcoin transaction.
   */
  async broadcastBitcoinTx(input: BroadcastBitcoinTxInput): Promise<BitcoinBroadcastResult> {
    const { broadcastBitcoinTx } = await this.client.mutate<{ broadcastBitcoinTx: BitcoinBroadcastResult }>(`
      mutation BroadcastBTC($tradeId: ID!, $txHex: String!) {
        broadcastBitcoinTx(tradeId: $tradeId, txHex: $txHex) { txid success }
      }
    `, input);
    return broadcastBitcoinTx;
  }
}
