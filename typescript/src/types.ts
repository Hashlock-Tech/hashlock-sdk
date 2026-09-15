// Wire types for the Hashlock Markets developer API (/v1). Base-unit amounts are strings (integers in the
// asset's smallest unit — sats for BTC, 1e6 for USDT). Chain families, as the API names them:
// 'evm' | 'tvm' (TRON) | 'bitcoin' | 'svm' (Solana).

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
  /** Absent when the server has no chain id configured — not null. */
  chainId?: number;
  sign: 'evm-tx';
  txs: Array<{ to: string; data: string; value?: string }>;
}
/**
 * Bitcoin funding: pay this P2WSH exactly `amountSats` from your BTC wallet.
 *
 * `feePayTo`/`feeAmountSats` appear when the protocol fee falls on this leg, and the leg does not
 * count as funded until BOTH are paid — in one transaction if your wallet can, otherwise as a second
 * transfer from the same wallet. There is no contract on this rail to take the fee for you.
 */
export interface BtcPaymentBuild {
  chain: string;
  family: 'bitcoin';
  sign: 'btc-payment';
  /**
   * The HTLC's P2WSH — NULL until the escrow can be derived, which needs both sides' Bitcoin pubkeys.
   * The funding build answers anyway in that state, so check it before paying; a claim or refund of the
   * same leg errors instead of building.
   */
  payTo: string | null;
  amountSats: string;
  feePayTo?: string;
  feeAmountSats?: string;
  note?: string;
}
/**
 * Bitcoin claim/refund: a PSBT sweeping the escrow, and one sighash per swept input. Sign EACH with
 * secp256k1 (the same key), then `broadcast('bitcoin', { psbtBase64, signaturesHex, preimageHex })` —
 * the witness is assembled server-side, and the presence of `preimageHex` is what selects the claim
 * branch over the refund one. A refund is only relayable once the chain's MEDIAN TIME PAST has passed
 * the timelock, which trails real time by roughly an hour.
 */
export interface BtcSighashBuild {
  chain: string;
  family: 'bitcoin';
  sign: 'btc-sighash';
  psbtBase64: string;
  /** One per swept input, in order. `sighashHex` is the first, for the single-input case. */
  sighashHexes: string[];
  sighashHex: string;
  toAddress: string;
  amountSats: number;
  feeSats: number;
  preimageHex?: string; // claim only — pass it straight back to broadcast
  /** Refund only: a node rejects the spend until the chain's median time past has gone by this. */
  timelockUnix?: number;
  note?: string;
}
/**
 * TRON: unsigned transaction objects — sign each by its txID (secp256k1) and broadcast.
 *
 * `family` is `'tvm'`, which is what the API's chain registry calls this family and therefore what the
 * wire carries. This said `'tron'` until 0.5.0, so a `build.family === 'tron'` branch never ran.
 */
export interface TronBuild {
  chain: string;
  family: 'tvm';
  sign: 'tron-txid';
  transactions: Array<{ transaction: unknown; txID: string }>;
}
/**
 * Solana: one transaction, already assembled, needing one signature. The escrow ADDRESS is a hash of
 * the agreed terms, so nothing in it is yours to choose — sign the base64 with the funder key (a claim
 * is signed by the recipient) and pass the result to `broadcast('solana', signed)`. The blockhash
 * expires in about a minute; build again if it does.
 */
export interface SolanaBuild {
  chain: string;
  family: 'svm';
  sign: 'solana-tx';
  escrow: string;
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Refund only: the program refuses before it. */
  timelockUnix?: number;
  note?: string;
}
export type SettlementBuild = EvmBuild | BtcPaymentBuild | BtcSighashBuild | SolanaBuild | TronBuild;

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
