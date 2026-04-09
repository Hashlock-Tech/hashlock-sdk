// ─── Enums ───────────────────────────────────────────────────

export type Side = 'BUY' | 'SELL';

export type RFQStatus =
  | 'ACTIVE'
  | 'QUOTES_RECEIVED'
  | 'ACCEPTED'
  | 'FILLED'
  | 'EXPIRED'
  | 'CANCELLED';

export type QuoteStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export type HTLCRole = 'INITIATOR' | 'COUNTERPARTY';

export type TradeStatus =
  | 'PROPOSED'
  | 'ACCEPTED'
  | 'FUNDING'
  | 'FUNDED'
  | 'INITIATOR_LOCKED'
  | 'BOTH_LOCKED'
  | 'EXECUTING'
  | 'SETTLING'
  | 'COMPLETED'
  | 'REFUNDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export type HTLCStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'WITHDRAWN'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'UNDER_FUNDED';

// ─── Domain Objects ──────────────────────────────────────────

export interface RFQ {
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

export interface Quote {
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

export interface Trade {
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

export interface HTLC {
  id: string;
  tradeId: string;
  role: HTLCRole;
  status: HTLCStatus;
  contractAddress: string | null;
  hashlock: string | null;
  timelock: number | null;
  amount: string | null;
  txHash: string | null;
  chainId: number | null;
  preimage: string | null;
}

export interface HTLCStatusResult {
  tradeId: string;
  status: string;
  initiatorHTLC: HTLC | null;
  counterpartyHTLC: HTLC | null;
}

// ─── Mutation Inputs ─────────────────────────────────────────

export interface CreateRFQInput {
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

export interface SubmitQuoteInput {
  /** ID of the RFQ to respond to */
  rfqId: string;
  /** Price per unit of base token in quote token terms */
  price: string;
  /** Amount of base token */
  amount: string;
  /** Expiration time in seconds */
  expiresIn?: number;
}

export interface FundHTLCInput {
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

export interface ClaimHTLCInput {
  /** Trade ID */
  tradeId: string;
  /** Transaction hash of the on-chain claim tx */
  txHash: string;
  /** The 32-byte preimage (0x-prefixed hex) */
  preimage: string;
  /** Chain type ('evm' | 'bitcoin' | 'sui') */
  chainType?: string;
}

export interface RefundHTLCInput {
  /** Trade ID */
  tradeId: string;
  /** Transaction hash of the on-chain refund tx */
  txHash: string;
  /** Chain type ('evm' | 'bitcoin' | 'sui') */
  chainType?: string;
}

export interface PrepareBitcoinHTLCInput {
  tradeId: string;
  role: HTLCRole;
  senderPubKey: string;
  receiverPubKey: string;
  /** Unix timestamp for HTLC expiry */
  timelock: number;
  /** Amount in satoshis */
  amountSats: string;
}

export interface BitcoinHTLCPrepareResult {
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

export interface BuildBitcoinClaimPSBTInput {
  tradeId: string;
  htlcId: string;
  /** 32-byte preimage (hex) */
  preimage: string;
  /** Claimer's compressed public key */
  destinationPubKey: string;
  /** Fee rate in sat/vB (default: 10) */
  feeRate?: number;
}

export interface BitcoinClaimPSBTResult {
  tradeId: string;
  htlcId: string;
  psbtBase64: string;
  fee: number;
  utxoTxid: string;
  utxoVout: number;
}

export interface BroadcastBitcoinTxInput {
  tradeId: string;
  txHex: string;
}

export interface BitcoinBroadcastResult {
  txid: string;
  success: boolean;
}

export interface FundHTLCResult {
  tradeId: string;
  txHash: string;
  status: string;
}

// ─── Mutation Results ────────────────────────────────────────

export interface ConfirmDirectTradeInput {
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

export interface ConfirmSettlementWalletsInput {
  tradeId: string;
  sendWalletId: string;
  receiveWalletId: string;
}

// ─── SDK Config ──────────────────────────────────────────────

export interface HashLockConfig {
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
