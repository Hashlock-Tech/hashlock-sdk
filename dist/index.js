// src/errors.ts
var HashLockError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "HashLockError";
  }
  code;
  details;
};
var GraphQLError = class extends HashLockError {
  constructor(message, errors) {
    super(message, "GRAPHQL_ERROR", errors);
    this.errors = errors;
    this.name = "GraphQLError";
  }
  errors;
};
var NetworkError = class extends HashLockError {
  constructor(message, cause) {
    super(message, "NETWORK_ERROR", cause);
    this.cause = cause;
    this.name = "NetworkError";
  }
  cause;
};
var AuthError = class extends HashLockError {
  constructor(message = "Authentication required \u2014 set accessToken in config or call setAccessToken()") {
    super(message, "AUTH_ERROR");
    this.name = "AuthError";
  }
};

// src/client.ts
var DEFAULT_TIMEOUT = 3e4;
var DEFAULT_RETRIES = 3;
var RETRY_DELAY_BASE = 1e3;
var GraphQLClient = class {
  endpoint;
  accessToken;
  timeout;
  retries;
  fetchFn;
  constructor(config) {
    this.endpoint = config.endpoint;
    this.accessToken = config.accessToken;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.fetchFn = config.fetch ?? globalThis.fetch;
    if (!this.fetchFn) {
      throw new Error("fetch is not available \u2014 pass a custom fetch implementation or use Node.js >= 18");
    }
  }
  setAccessToken(token) {
    this.accessToken = token;
  }
  /**
   * Execute a GraphQL query with automatic retries on transient failures.
   * Retries on: network errors, 5xx status codes.
   * Does NOT retry on: 4xx errors, GraphQL validation errors.
   */
  async query(query, variables) {
    return this.execute(query, variables, true);
  }
  /**
   * Execute a GraphQL mutation.
   * Only retries on network errors (not on 5xx — mutations are not idempotent).
   */
  async mutate(query, variables) {
    return this.execute(query, variables, false);
  }
  async execute(query, variables, retryOn5xx) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        const headers = {
          "Content-Type": "application/json",
          "Accept": "application/json"
        };
        if (this.accessToken) {
          headers["Authorization"] = `Bearer ${this.accessToken}`;
        }
        const response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (response.status === 401 || response.status === 403) {
          throw new AuthError(`HTTP ${response.status}: ${response.statusText}`);
        }
        if (response.status >= 500) {
          const msg = `Server error: HTTP ${response.status}`;
          if (retryOn5xx && attempt < this.retries) {
            lastError = new NetworkError(msg);
            await this.delay(attempt);
            continue;
          }
          throw new NetworkError(msg);
        }
        const json = await response.json();
        if (json.errors?.length) {
          throw new GraphQLError(
            json.errors[0].message,
            json.errors
          );
        }
        if (!json.data) {
          throw new GraphQLError("No data returned", [{ message: "Empty response" }]);
        }
        return json.data;
      } catch (err) {
        if (err instanceof AuthError || err instanceof GraphQLError) {
          throw err;
        }
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        const isNetwork = err instanceof TypeError;
        if ((isAbort || isNetwork) && attempt < this.retries) {
          lastError = err instanceof Error ? err : new Error(String(err));
          await this.delay(attempt);
          continue;
        }
        if (err instanceof NetworkError) throw err;
        throw new NetworkError(
          isAbort ? "Request timed out" : `Network error: ${err instanceof Error ? err.message : err}`,
          err instanceof Error ? err : void 0
        );
      }
    }
    throw lastError ?? new NetworkError("Request failed after all retries");
  }
  delay(attempt) {
    const ms = RETRY_DELAY_BASE * Math.pow(2, attempt);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};

// src/hashlock.ts
var MAINNET_ENDPOINT = "http://142.93.106.129/graphql";
var HashLock = class {
  client;
  constructor(config) {
    this.client = new GraphQLClient(config);
  }
  /** Update the access token (e.g., after login or token refresh) */
  setAccessToken(token) {
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
  async createRFQ(input) {
    const { createRFQ } = await this.client.mutate(`
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
  async getRFQ(id) {
    const { rfq } = await this.client.query(`
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
  async listRFQs(params) {
    const { rfqs } = await this.client.query(`
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
  async cancelRFQ(id) {
    const { cancelRFQ } = await this.client.mutate(`
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
  async submitQuote(input) {
    const { submitQuote } = await this.client.mutate(`
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
  async acceptQuote(quoteId) {
    const { acceptQuote } = await this.client.mutate(`
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
  async getQuotes(rfqId) {
    const { quotes } = await this.client.query(`
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
  async getTrade(id) {
    const { trade } = await this.client.query(`
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
  async listTrades(params) {
    const { trades } = await this.client.query(`
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
  async confirmDirectTrade(input) {
    const { confirmDirectTrade } = await this.client.mutate(`
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
  async acceptTrade(tradeId) {
    const { acceptTrade } = await this.client.mutate(`
      mutation AcceptTrade($tradeId: ID!) {
        acceptTrade(tradeId: $tradeId) { id status }
      }
    `, { tradeId });
    return acceptTrade;
  }
  /**
   * Cancel a trade.
   */
  async cancelTrade(tradeId) {
    const { cancelTrade } = await this.client.mutate(`
      mutation CancelTrade($tradeId: ID!) {
        cancelTrade(tradeId: $tradeId) { id status }
      }
    `, { tradeId });
    return cancelTrade;
  }
  /**
   * Confirm settlement wallets for a trade.
   */
  async confirmSettlementWallets(input) {
    const { confirmSettlementWallets } = await this.client.mutate(`
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
  async fundHTLC(input) {
    const { fundHTLC } = await this.client.mutate(`
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
  async claimHTLC(input) {
    const { claimHTLC } = await this.client.mutate(`
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
  async refundHTLC(input) {
    const { refundHTLC } = await this.client.mutate(`
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
  async getHTLCStatus(tradeId) {
    const { htlcStatus } = await this.client.query(`
      query HTLCStatus($tradeId: ID!) {
        htlcStatus(tradeId: $tradeId) {
          tradeId status
          initiatorHTLC { id tradeId role status contractAddress hashlock timelock amount txHash chainType }
          counterpartyHTLC { id tradeId role status contractAddress hashlock timelock amount txHash chainType }
        }
      }
    `, { tradeId });
    return htlcStatus;
  }
  /**
   * Get all HTLCs for a trade.
   */
  async getHTLCs(tradeId) {
    const { htlcs } = await this.client.query(`
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
  async prepareBitcoinHTLC(input) {
    const { prepareBitcoinHTLC } = await this.client.mutate(`
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
  async buildBitcoinClaimPSBT(input) {
    const { buildBitcoinClaimPSBT } = await this.client.mutate(`
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
  async broadcastBitcoinTx(input) {
    const { broadcastBitcoinTx } = await this.client.mutate(`
      mutation BroadcastBTC($tradeId: ID!, $txHex: String!) {
        broadcastBitcoinTx(tradeId: $tradeId, txHex: $txHex) { txid success }
      }
    `, input);
    return broadcastBitcoinTx;
  }
};
export {
  AuthError,
  GraphQLError,
  HashLock,
  HashLockError,
  MAINNET_ENDPOINT,
  NetworkError
};
//# sourceMappingURL=index.js.map