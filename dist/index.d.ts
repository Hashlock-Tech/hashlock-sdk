type Side = 'BUY' | 'SELL';
type RFQStatus = 'ACTIVE' | 'QUOTES_RECEIVED' | 'ACCEPTED' | 'FILLED' | 'EXPIRED' | 'CANCELLED';
type QuoteStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
type HTLCRole = 'INITIATOR' | 'COUNTERPARTY';
type TradeStatus = 'PROPOSED' | 'ACCEPTED' | 'FUNDING' | 'FUNDED' | 'INITIATOR_LOCKED' | 'BOTH_LOCKED' | 'EXECUTING' | 'SETTLING' | 'COMPLETED' | 'REFUNDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
type HTLCStatus = 'PENDING' | 'ACTIVE' | 'WITHDRAWN' | 'REFUNDED' | 'EXPIRED' | 'INVALIDATED' | 'UNDER_FUNDED';
interface RFQ {
    id: string;
    userId: string;
    baseToken: string;
    quoteToken: string;
    side: Side;
    amount: string;
    isBlind: boolean;
    status: RFQStatus;
    expiresAt: string | null;
    createdAt: string;
    quotesCount: number | null;
    quotes: Quote[] | null;
}
interface Quote {
    id: string;
    rfqId: string;
    marketMakerId: string;
    price: string;
    amount: string;
    expiresAt: string | null;
    status: QuoteStatus;
    createdAt: string;
    deliveryDelayHours: number | null;
    collateralBtcSats: string | null;
    isCollateralBacked: boolean;
}
interface Trade {
    id: string;
    initiatorId: string;
    counterpartyId: string;
    baseToken: string | null;
    quoteToken: string | null;
    side: Side | null;
    baseAmount: string | null;
    quoteAmount: string | null;
    price: string;
    status: TradeStatus;
    createdAt: string;
}
interface HTLC {
    id: string;
    tradeId: string;
    role: HTLCRole;
    status: HTLCStatus;
    contractAddress: string | null;
    hashlock: string | null;
    timelock: number | null;
    amount: string | null;
    txHash: string | null;
    chainType: string | null;
    preimage: string | null;
}
interface HTLCStatusResult {
    tradeId: string;
    status: string;
    initiatorHTLC: HTLC | null;
    counterpartyHTLC: HTLC | null;
}
interface CreateRFQInput {
    /** Base asset symbol (e.g., 'ETH', 'BTC') */
    baseToken: string;
    /** Quote asset symbol (e.g., 'USDT', 'USDC') */
    quoteToken: string;
    /** BUY or SELL */
    side: Side;
    /** Amount in base token units (e.g., '1.5') */
    amount: string;
    /** Expiration time in seconds (default: server-configured) */
    expiresIn?: number;
    /** Hide counterparty identity in blind auction mode */
    isBlind?: boolean;
}
interface SubmitQuoteInput {
    /** ID of the RFQ to respond to */
    rfqId: string;
    /** Price per unit of base token in quote token terms */
    price: string;
    /** Amount of base token */
    amount: string;
    /** Expiration time in seconds */
    expiresIn?: number;
}
interface FundHTLCInput {
    /** Trade ID */
    tradeId: string;
    /** Transaction hash from on-chain HTLC creation */
    txHash: string;
    /** Your role in this trade */
    role: HTLCRole;
    /** Timelock as Unix timestamp */
    timelock?: number;
    /** SHA-256 hashlock (0x-prefixed) */
    hashlock?: string;
    /** 'evm', 'bitcoin', or 'sui' */
    chainType?: string;
    /** Compressed public key (BTC only) */
    senderPubKey?: string;
    /** Compressed public key (BTC only) */
    receiverPubKey?: string;
    /** Hex-encoded redeem script (BTC only) */
    redeemScript?: string;
    /** Pre-signed refund tx hex (BTC only) */
    refundTxHex?: string;
    /** Preimage for initiator (kept encrypted server-side) */
    preimage?: string;
}
interface ClaimHTLCInput {
    /** Trade ID */
    tradeId: string;
    /** Transaction hash of the on-chain claim tx */
    txHash: string;
    /** The 32-byte preimage (0x-prefixed hex) */
    preimage: string;
    /** Chain type ('evm' | 'bitcoin' | 'sui') */
    chainType?: string;
}
interface RefundHTLCInput {
    /** Trade ID */
    tradeId: string;
    /** Transaction hash of the on-chain refund tx */
    txHash: string;
    /** Chain type ('evm' | 'bitcoin' | 'sui') */
    chainType?: string;
}
interface PrepareBitcoinHTLCInput {
    tradeId: string;
    role: HTLCRole;
    senderPubKey: string;
    receiverPubKey: string;
    /** Unix timestamp for HTLC expiry */
    timelock: number;
    /** Amount in satoshis */
    amountSats: string;
}
interface BitcoinHTLCPrepareResult {
    tradeId: string;
    htlcId: string;
    htlcAddress: string;
    redeemScript: string;
    hashlock: string;
    preimageHash: string | null;
    timelock: number;
    amountSats: string;
    estimatedClaimFee: number;
    estimatedRefundFee: number;
    refundPsbt: string;
}
interface BuildBitcoinClaimPSBTInput {
    tradeId: string;
    htlcId: string;
    /** 32-byte preimage (hex) */
    preimage: string;
    /** Claimer's compressed public key */
    destinationPubKey: string;
    /** Fee rate in sat/vB (default: 10) */
    feeRate?: number;
}
interface BitcoinClaimPSBTResult {
    tradeId: string;
    htlcId: string;
    psbtBase64: string;
    fee: number;
    utxoTxid: string;
    utxoVout: number;
}
interface BroadcastBitcoinTxInput {
    tradeId: string;
    txHex: string;
}
interface BitcoinBroadcastResult {
    txid: string;
    success: boolean;
}
interface FundHTLCResult {
    tradeId: string;
    txHash: string;
    status: string;
}
interface ConfirmDirectTradeInput {
    counterpartyId: string;
    baseToken: string;
    quoteToken: string;
    side: Side;
    baseAmount: string;
    price: string;
    chainId: string;
    broadcastRfqId?: string;
    conversationId?: string;
}
interface ConfirmSettlementWalletsInput {
    tradeId: string;
    sendWalletId: string;
    receiveWalletId: string;
}
interface HashLockConfig {
    /** GraphQL endpoint URL */
    endpoint: string;
    /** JWT access token for authentication */
    accessToken?: string;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Number of retry attempts for failed requests (default: 3) */
    retries?: number;
    /** Custom fetch implementation (for Node.js < 18 or testing) */
    fetch?: typeof fetch;
}

/** Mainnet endpoint */
declare const MAINNET_ENDPOINT = "http://142.93.106.129/graphql";
/**
 * HashLock SDK — TypeScript client for HashLock OTC trading platform.
 *
 * @example
 * ```ts
 * import { HashLock } from '@hashlock/sdk';
 *
 * const hl = new HashLock({
 *   endpoint: 'http://142.93.106.129/graphql',
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
declare class HashLock {
    private client;
    constructor(config: HashLockConfig);
    /** Update the access token (e.g., after login or token refresh) */
    setAccessToken(token: string): void;
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
    createRFQ(input: CreateRFQInput): Promise<RFQ>;
    /**
     * Get a single RFQ by ID.
     */
    getRFQ(id: string): Promise<RFQ | null>;
    /**
     * List RFQs with optional status filter and pagination.
     */
    listRFQs(params?: {
        status?: RFQStatus;
        page?: number;
        pageSize?: number;
    }): Promise<{
        rfqs: RFQ[];
        total: number;
        page: number;
        pageSize: number;
    }>;
    /**
     * Cancel an active RFQ.
     */
    cancelRFQ(id: string): Promise<RFQ>;
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
    submitQuote(input: SubmitQuoteInput): Promise<Quote>;
    /**
     * Accept a quote — creates a trade from the RFQ flow.
     */
    acceptQuote(quoteId: string): Promise<Quote>;
    /**
     * Get all quotes for an RFQ.
     */
    getQuotes(rfqId: string): Promise<Quote[]>;
    /**
     * Get a single trade by ID.
     */
    getTrade(id: string): Promise<Trade | null>;
    /**
     * List trades with optional status filter.
     */
    listTrades(params?: {
        status?: TradeStatus;
        page?: number;
        pageSize?: number;
    }): Promise<{
        trades: Trade[];
        total: number;
    }>;
    /**
     * Create a direct trade from 1-on-1 chat (skips RFQ flow).
     */
    confirmDirectTrade(input: ConfirmDirectTradeInput): Promise<Trade>;
    /**
     * Accept a proposed trade.
     */
    acceptTrade(tradeId: string): Promise<Trade>;
    /**
     * Cancel a trade.
     */
    cancelTrade(tradeId: string): Promise<Trade>;
    /**
     * Confirm settlement wallets for a trade.
     */
    confirmSettlementWallets(input: ConfirmSettlementWalletsInput): Promise<Trade>;
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
    fundHTLC(input: FundHTLCInput): Promise<FundHTLCResult>;
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
    claimHTLC(input: ClaimHTLCInput): Promise<HTLCStatusResult>;
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
    refundHTLC(input: RefundHTLCInput): Promise<HTLCStatusResult>;
    /**
     * Get HTLC status for a trade (both initiator and counterparty HTLCs).
     */
    getHTLCStatus(tradeId: string): Promise<HTLCStatusResult | null>;
    /**
     * Get all HTLCs for a trade.
     */
    getHTLCs(tradeId: string): Promise<HTLC[]>;
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
    prepareBitcoinHTLC(input: PrepareBitcoinHTLCInput): Promise<BitcoinHTLCPrepareResult>;
    /**
     * Build an unsigned claim PSBT for a Bitcoin HTLC.
     * The client signs with their wallet, then broadcasts via broadcastBitcoinTx.
     */
    buildBitcoinClaimPSBT(input: BuildBitcoinClaimPSBTInput): Promise<BitcoinClaimPSBTResult>;
    /**
     * Broadcast a signed Bitcoin transaction.
     */
    broadcastBitcoinTx(input: BroadcastBitcoinTxInput): Promise<BitcoinBroadcastResult>;
}

/**
 * Base error class for all HashLock SDK errors.
 */
declare class HashLockError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    constructor(message: string, code: string, details?: unknown | undefined);
}
/**
 * GraphQL returned errors in the response.
 */
declare class GraphQLError extends HashLockError {
    readonly errors: Array<{
        message: string;
        path?: string[];
    }>;
    constructor(message: string, errors: Array<{
        message: string;
        path?: string[];
    }>);
}
/**
 * Network-level error (timeout, DNS failure, etc.).
 */
declare class NetworkError extends HashLockError {
    readonly cause?: Error | undefined;
    constructor(message: string, cause?: Error | undefined);
}
/**
 * Authentication error — token missing or expired.
 */
declare class AuthError extends HashLockError {
    constructor(message?: string);
}

export { AuthError, type BitcoinBroadcastResult, type BitcoinClaimPSBTResult, type BitcoinHTLCPrepareResult, type BroadcastBitcoinTxInput, type BuildBitcoinClaimPSBTInput, type ClaimHTLCInput, type ConfirmDirectTradeInput, type ConfirmSettlementWalletsInput, type CreateRFQInput, type FundHTLCInput, type FundHTLCResult, GraphQLError, type HTLC, type HTLCRole, type HTLCStatus, type HTLCStatusResult, HashLock, type HashLockConfig, HashLockError, MAINNET_ENDPOINT, NetworkError, type PrepareBitcoinHTLCInput, type Quote, type QuoteStatus, type RFQ, type RFQStatus, type RefundHTLCInput, type Side, type SubmitQuoteInput, type Trade, type TradeStatus };
