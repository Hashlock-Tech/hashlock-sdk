import { GraphQLClient } from './client.js';
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

/** Mainnet endpoint */
export const MAINNET_ENDPOINT = 'http://142.93.106.129/api/graphql';

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
export class HashLock {
  private client: GraphQLClient;

  constructor(config: HashLockConfig) {
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
    const { createRFQ } = await this.client.mutate<{ createRFQ: RFQ }>(`
      mutation CreateRFQ($baseToken: String!, $quoteToken: String!, $side: Side!, $amount: String!, $expiresIn: Int, $isBlind: Boolean) {
        createRFQ(baseToken: $baseToken, quoteToken: $quoteToken, side: $side, amount: $amount, expiresIn: $expiresIn, isBlind: $isBlind) {
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
    const { submitQuote } = await this.client.mutate<{ submitQuote: Quote }>(`
      mutation SubmitQuote($rfqId: ID!, $price: String!, $amount: String!, $expiresIn: Int) {
        submitQuote(rfqId: $rfqId, price: $price, amount: $amount, expiresIn: $expiresIn) {
          id rfqId marketMakerId price amount status createdAt expiresAt
        }
      }
    `, input);
    return submitQuote;
  }

  /**
   * Accept a quote — creates a trade from the RFQ flow.
   */
  async acceptQuote(quoteId: string): Promise<Quote> {
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
