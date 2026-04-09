import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HashLock } from '../hashlock.js';
import { GraphQLError, AuthError, NetworkError } from '../errors.js';

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    statusText: 'OK',
    json: () => Promise.resolve(data),
  });
}

function createClient(fetchFn: ReturnType<typeof vi.fn>) {
  return new HashLock({
    endpoint: 'http://localhost:4000/graphql',
    accessToken: 'test-token',
    fetch: fetchFn as unknown as typeof fetch,
    retries: 0, // no retries in tests
  });
}

describe('HashLock SDK', () => {
  // ─── RFQ ─────────────────────────────────────────────

  describe('createRFQ', () => {
    it('should create an RFQ and return it', async () => {
      const rfq = { id: 'rfq-1', baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL', amount: '10', status: 'ACTIVE', isBlind: false, createdAt: '2026-01-01', userId: 'u1', expiresAt: null, quotesCount: 0 };
      const fetch = mockFetch({ data: { createRFQ: rfq } });
      const hl = createClient(fetch);

      const result = await hl.createRFQ({ baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL', amount: '10' });
      expect(result.id).toBe('rfq-1');
      expect(result.status).toBe('ACTIVE');
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRFQ', () => {
    it('should return an RFQ by ID', async () => {
      const rfq = { id: 'rfq-1', baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL', amount: '10', status: 'ACTIVE', isBlind: false, createdAt: '2026-01-01', userId: 'u1', expiresAt: null, quotesCount: 0, quotes: [] };
      const fetch = mockFetch({ data: { rfq } });
      const hl = createClient(fetch);

      const result = await hl.getRFQ('rfq-1');
      expect(result?.id).toBe('rfq-1');
    });

    it('should return null for non-existent RFQ', async () => {
      const fetch = mockFetch({ data: { rfq: null } });
      const hl = createClient(fetch);

      const result = await hl.getRFQ('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('cancelRFQ', () => {
    it('should cancel an RFQ', async () => {
      const fetch = mockFetch({ data: { cancelRFQ: { id: 'rfq-1', status: 'CANCELLED' } } });
      const hl = createClient(fetch);

      const result = await hl.cancelRFQ('rfq-1');
      expect(result.status).toBe('CANCELLED');
    });
  });

  // ─── Quotes ──────────────────────────────────────────

  describe('submitQuote', () => {
    it('should submit a quote', async () => {
      const quote = { id: 'q-1', rfqId: 'rfq-1', marketMakerId: 'mm-1', price: '3500', amount: '10', status: 'PENDING', createdAt: '2026-01-01', expiresAt: null };
      const fetch = mockFetch({ data: { submitQuote: quote } });
      const hl = createClient(fetch);

      const result = await hl.submitQuote({ rfqId: 'rfq-1', price: '3500', amount: '10' });
      expect(result.price).toBe('3500');
    });
  });

  describe('acceptQuote', () => {
    it('should accept a quote and get trade ref', async () => {
      const fetch = mockFetch({ data: { acceptQuote: { id: 'q-1', rfqId: 'rfq-1', status: 'ACCEPTED', trade: { id: 't-1', status: 'PROPOSED' } } } });
      const hl = createClient(fetch);

      const result = await hl.acceptQuote('q-1');
      expect(result.status).toBe('ACCEPTED');
    });
  });

  // ─── Trades ──────────────────────────────────────────

  describe('getTrade', () => {
    it('should return a trade by ID', async () => {
      const trade = { id: 't-1', initiatorId: 'u1', counterpartyId: 'u2', baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL', baseAmount: '10', quoteAmount: '35000', price: '3500', status: 'ACCEPTED', createdAt: '2026-01-01' };
      const fetch = mockFetch({ data: { trade } });
      const hl = createClient(fetch);

      const result = await hl.getTrade('t-1');
      expect(result?.status).toBe('ACCEPTED');
    });
  });

  describe('acceptTrade', () => {
    it('should accept a trade', async () => {
      const fetch = mockFetch({ data: { acceptTrade: { id: 't-1', status: 'ACCEPTED' } } });
      const hl = createClient(fetch);

      const result = await hl.acceptTrade('t-1');
      expect(result.status).toBe('ACCEPTED');
    });
  });

  // ─── HTLC (EVM) ─────────────────────────────────────

  describe('fundHTLC', () => {
    it('should record an HTLC funding tx', async () => {
      const fetch = mockFetch({ data: { fundHTLC: { tradeId: 't-1', txHash: '0xabc', status: 'PENDING' } } });
      const hl = createClient(fetch);

      const result = await hl.fundHTLC({ tradeId: 't-1', txHash: '0xabc', role: 'INITIATOR' });
      expect(result.txHash).toBe('0xabc');
    });
  });

  describe('claimHTLC', () => {
    it('should record an HTLC claim', async () => {
      const fetch = mockFetch({ data: { claimHTLC: { tradeId: 't-1', status: 'WITHDRAWN' } } });
      const hl = createClient(fetch);

      const result = await hl.claimHTLC({ tradeId: 't-1', txHash: '0xdef', preimage: '0x1234' });
      expect(result.status).toBe('WITHDRAWN');
    });
  });

  describe('refundHTLC', () => {
    it('should record an HTLC refund', async () => {
      const fetch = mockFetch({ data: { refundHTLC: { tradeId: 't-1', status: 'REFUNDED' } } });
      const hl = createClient(fetch);

      const result = await hl.refundHTLC({ tradeId: 't-1', txHash: '0xghi' });
      expect(result.status).toBe('REFUNDED');
    });
  });

  describe('getHTLCStatus', () => {
    it('should return HTLC status with both sides', async () => {
      const htlcStatus = {
        tradeId: 't-1', status: 'BOTH_LOCKED',
        initiatorHTLC: { id: 'h1', tradeId: 't-1', role: 'INITIATOR', status: 'ACTIVE', contractAddress: '0x1', hashlock: '0xh', timelock: 999, amount: '1.0', txHash: '0xa', chainType: 'evm' },
        counterpartyHTLC: { id: 'h2', tradeId: 't-1', role: 'COUNTERPARTY', status: 'ACTIVE', contractAddress: '0x2', hashlock: '0xh', timelock: 888, amount: '3500', txHash: '0xb', chainType: 'evm' },
      };
      const fetch = mockFetch({ data: { htlcStatus } });
      const hl = createClient(fetch);

      const result = await hl.getHTLCStatus('t-1');
      expect(result?.initiatorHTLC?.role).toBe('INITIATOR');
      expect(result?.counterpartyHTLC?.role).toBe('COUNTERPARTY');
    });
  });

  // ─── HTLC (Bitcoin) ──────────────────────────────────

  describe('prepareBitcoinHTLC', () => {
    it('should return P2WSH address and redeem script', async () => {
      const btc = { tradeId: 't-1', htlcId: 'bh-1', htlcAddress: 'tb1q...', redeemScript: '6321...', hashlock: '0xabc', preimageHash: '0xdef', timelock: 9999, amountSats: '100000', estimatedClaimFee: 500, estimatedRefundFee: 400, refundPsbt: 'cHNidA==' };
      const fetch = mockFetch({ data: { prepareBitcoinHTLC: btc } });
      const hl = createClient(fetch);

      const result = await hl.prepareBitcoinHTLC({ tradeId: 't-1', role: 'INITIATOR', senderPubKey: '02abc', receiverPubKey: '03def', timelock: 9999, amountSats: '100000' });
      expect(result.htlcAddress).toBe('tb1q...');
      expect(result.amountSats).toBe('100000');
    });
  });

  describe('broadcastBitcoinTx', () => {
    it('should broadcast and return txid', async () => {
      const fetch = mockFetch({ data: { broadcastBitcoinTx: { txid: 'abc123', success: true } } });
      const hl = createClient(fetch);

      const result = await hl.broadcastBitcoinTx({ tradeId: 't-1', txHex: '0200000001...' });
      expect(result.success).toBe(true);
      expect(result.txid).toBe('abc123');
    });
  });

  // ─── Error Handling ──────────────────────────────────

  describe('error handling', () => {
    it('should throw GraphQLError on GraphQL errors', async () => {
      const fetch = mockFetch({ errors: [{ message: 'Trade not found' }] });
      const hl = createClient(fetch);

      await expect(hl.getTrade('bad-id')).rejects.toThrow(GraphQLError);
    });

    it('should throw AuthError on 401', async () => {
      const fetch = mockFetch({}, 401);
      const hl = createClient(fetch);

      await expect(hl.getTrade('t-1')).rejects.toThrow(AuthError);
    });

    it('should throw NetworkError on 500', async () => {
      const fetch = mockFetch({}, 500);
      const hl = createClient(fetch);

      await expect(hl.getTrade('t-1')).rejects.toThrow(NetworkError);
    });

    it('should include Authorization header when token is set', async () => {
      const fetch = mockFetch({ data: { trade: null } });
      const hl = createClient(fetch);

      await hl.getTrade('t-1');

      const callArgs = fetch.mock.calls[0];
      expect(callArgs[1].headers['Authorization']).toBe('Bearer test-token');
    });

    it('should update token via setAccessToken', async () => {
      const fetch = mockFetch({ data: { trade: null } });
      const hl = createClient(fetch);

      hl.setAccessToken('new-token');
      await hl.getTrade('t-1');

      const callArgs = fetch.mock.calls[0];
      expect(callArgs[1].headers['Authorization']).toBe('Bearer new-token');
    });
  });
});
