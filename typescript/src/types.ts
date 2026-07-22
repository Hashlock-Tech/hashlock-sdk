// Wire types for the Hashlock Markets developer API (/v1). Base-unit amounts are strings (integers in the
// asset's smallest unit — sats for BTC, 1e6 for USDT). Chain families: 'evm' | 'tron' | 'bitcoin'.

export type Scope = 'read' | 'taker' | 'maker';
export type Direction = 'sell_base' | 'buy_base';
export type LegKey = 'a' | 'b';

export interface Me {
  userId: string;
  scopes: Scope[];
}

export interface Asset {
  id: string;
  chain: string; // 'ethereum' | 'tron' | 'bitcoin' | …
  symbol: string;
  decimals: number;
  address: string | null; // token contract; null = native coin
  isNative?: boolean;
  enabled?: boolean;
}

export interface Rfq {
  id: string;
  direction: Direction;
  baseAssetId: string;
  baseAmount: string;
  quoteAssetId: string;
  askAmount?: string | null;
  status: string;
  visibility?: 'public' | 'private';
  targetAddress?: string | null;
  creatorId?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface CreateRfqInput {
  direction: Direction;
  baseAssetId: string;
  baseAmount: string;
  quoteAssetId: string;
  ttlSeconds: number;
  askAmount?: string;
  visibility?: 'public' | 'private';
  targetAddress?: string;
}

export interface Thread {
  id: string;
  rfqId: string;
  makerId: string;
  takerId: string;
  status: string;
  currentQuoteAmount?: string | null;
  pendingAmount?: string | null;
  pendingBy?: string | null;
  takerAccepted?: boolean;
  makerAccepted?: boolean;
  updatedAt?: string;
}

export interface Swap {
  id: string;
  threadId: string;
  status: string; // agreed → initiator_funded → counterparty_funded → initiator_claimed → counterparty_claimed | refunded
  hashlock: string;
  makerId: string;
  takerId: string;
  initiatorUserId: string;
  feeAssetId?: string | null;
  feeAmount?: string | null;
  aChain: string;
  aAssetId: string;
  aAmount: string;
  aHtlcAddress?: string | null;
  aRedeemScript?: string | null;
  aPayoutAddress?: string | null;
  aRefundAddress?: string | null;
  aTimelock: string;
  aFundTx?: string | null;
  aClaimTx?: string | null;
  bChain: string;
  bAssetId: string;
  bAmount: string;
  bHtlcAddress?: string | null;
  bRedeemScript?: string | null;
  bPayoutAddress?: string | null;
  bRefundAddress?: string | null;
  bTimelock: string;
  bFundTx?: string | null;
  bClaimTx?: string | null;
}

/** A page of results plus the opaque cursor for the next page (null = last page). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ── Settlement builders: chain-specific UNSIGNED material. Sign with your own key/HSM, then broadcast. ──

/** EVM: unsigned transactions to sign (eip1559) and send raw. */
export interface EvmBuild {
  chain: string;
  family: 'evm';
  chainId: number | null;
  sign: 'evm-tx';
  txs: Array<{ to: string; data: string; value?: string }>;
}
/** Bitcoin funding: pay this P2WSH exactly `amountSats` from your BTC wallet. */
export interface BtcPaymentBuild {
  chain: string;
  family: 'bitcoin';
  sign: 'btc-payment';
  payTo: string;
  amountSats: string;
}
/** Bitcoin claim/refund: spend the P2WSH. Claim → witness [sig, preimage, 0x01, redeem]; refund → OP_ELSE after the timelock. */
export interface BtcWitnessBuild {
  chain: string;
  family: 'bitcoin';
  sign: 'btc-witness';
  p2wsh: string;
  redeemHex: string;
  preimageHex?: string; // claim only
  timelockUnix?: number; // refund only
  note?: string;
}
/** TRON: unsigned transaction objects — sign each by its txID (secp256k1) and broadcast. */
export interface TronBuild {
  chain: string;
  family: 'tron';
  sign: 'tron-txid';
  transactions: Array<{ transaction: unknown; txID: string }>;
}
export type SettlementBuild = EvmBuild | BtcPaymentBuild | BtcWitnessBuild | TronBuild;

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  lastDeliveryAt?: string | null;
  lastStatus?: number | null;
  createdAt?: string;
}
export type WebhookEvent =
  | 'quote.created'
  | 'swap.agreed'
  | 'swap.funded'
  | 'secret.revealed'
  | 'swap.settled'
  | 'swap.refunded';
