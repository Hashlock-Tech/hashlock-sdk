import { describe, expect, it } from 'vitest';
import { HashlockClient } from './client.js';
import type { BtcPresignBuild, SettlementBuild } from './types.js';

/**
 * The settlement builds, as /v1 really answers them — these four objects are the shapes copied from
 * the API's own handlers (packages/api/src/routes/settlement-legs.ts). The point is not the runtime
 * assertions: it is that this file stops compiling the day a build stops fitting its type, which is
 * how the Bitcoin witness shape went on being exported here months after the API had replaced it.
 */
const builds: SettlementBuild[] = [
  {
    chain: 'ethereum-sepolia',
    family: 'evm',
    chainId: 11155111,
    sign: 'evm-tx',
    txs: [{ to: '0x97721f9e82fa046c3c365a5572b7d2fb33a1f3fa', data: '0xdeadbeef', value: '0' }],
  },
  {
    chain: 'bitcoin-signet',
    family: 'bitcoin',
    sign: 'btc-payment',
    payTo: 'tb1qexampleexampleexampleexampleexampleexamp',
    amountSats: '120000',
    feePayTo: 'tb1qtreasuryexampleexampleexampleexampleexam',
    feeAmountSats: '360',
    note: 'Pay amountSats to payTo AND feeAmountSats to feePayTo …',
  },
  {
    chain: 'bitcoin-signet',
    family: 'bitcoin',
    sign: 'btc-sighash',
    psbtBase64: 'cHNidP8BAH…',
    sighashHexes: ['aa'.repeat(32)],
    sighashHex: 'aa'.repeat(32),
    toAddress: 'tb1qexampleexampleexampleexampleexampleexamp',
    amountSats: 119_400,
    feeSats: 600,
    preimageHex: 'bb'.repeat(32),
  },
  {
    chain: 'tron-nile',
    // 'tvm', which is what the registry calls this family and therefore what the wire carries — the
    // reason this entry exists at all: the type said 'tron' and no branch on it ever ran.
    family: 'tvm',
    sign: 'tron-txid',
    transactions: [{ transaction: { raw_data: {} }, txID: 'cc'.repeat(32) }],
  },
  {
    chain: 'solana-devnet',
    family: 'svm',
    sign: 'solana-tx',
    escrow: 'EXEarB9qz2EwzXLjn6wxsexD4T9SvqJePAzFLddGBwAj',
    transactionBase64: 'AQAB…',
    blockhash: '8R6YhqA9oQhu42nQbeG2m7WjkJmZnqoAauJ1rw2Yq9qp',
    lastValidBlockHeight: 396_000_000,
  },
];

describe('SettlementBuild', () => {
  it('discriminates on `sign`, which is what callers branch on', () => {
    const seen = builds.map((b) => {
      // Each branch narrows to exactly one member; a missing member would fail to compile here.
      switch (b.sign) {
        case 'evm-tx':
          return b.txs[0]!.to;
        case 'btc-payment':
          return b.feeAmountSats ?? b.amountSats;
        case 'btc-sighash':
          return b.sighashHexes[0]!;
        case 'solana-tx':
          return b.transactionBase64;
        case 'tron-txid':
          return b.transactions.length.toString();
      }
    });
    expect(seen).toHaveLength(5);
    expect(seen.every((s) => typeof s === 'string')).toBe(true);
  });

  it('carries the Bitcoin fee fields a funding build answers with when the fee is on that leg', () => {
    const btc = builds.find((b) => b.sign === 'btc-payment')!;
    expect(btc).toMatchObject({ feePayTo: expect.any(String), feeAmountSats: '360' });
  });
});

// GET /v1/swaps/{id}/legs/{leg}/presign, as presignPrepareHandler answers a claim.
const presign: BtcPresignBuild = {
  chain: 'bitcoin-signet',
  family: 'bitcoin',
  sign: 'btc-sighash',
  kind: 'claim',
  toAddress: 'tb1qexampleexampleexampleexampleexampleexamp',
  signerPubkeyHex: '02' + 'dd'.repeat(32),
  receiverPubkeyHex: '02' + 'dd'.repeat(32),
  inputs: [{ txid: 'ee'.repeat(32), vout: 0, value: 120_000 }],
  levels: [{ feeSats: 300, psbtBase64: 'cHNidP8BAH…', sighashHexes: ['aa'.repeat(32)] }],
};

describe('presign', () => {
  // Records what the client sends; answers every call with { swap: { id: 's1' } }.
  const sent: Array<{ url: string; method: string; body?: string }> = [];
  const client = new HashlockClient({
    apiKey: 'hk_test_x',
    baseUrl: 'https://api.example/v1',
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method!, body: init.body as string | undefined });
      return new Response(JSON.stringify({ ...presign, swap: { id: 's1' } }));
    }) as typeof fetch,
  });

  it('prepares with GET and the query, stores with POST and the signed levels', async () => {
    sent.length = 0;
    await client.buildPresign('s1', 'b', { kind: 'refund' });
    const level = { feeSats: 300, psbtBase64: presign.levels[0]!.psbtBase64, signaturesHex: ['30'.repeat(36)] };
    const swap = await client.storePresign('s1', 'b', { kind: 'refund', toAddress: presign.toAddress, levels: [level] });
    expect(sent[0]).toMatchObject({ url: 'https://api.example/v1/swaps/s1/legs/b/presign?kind=refund', method: 'GET', body: undefined });
    expect(sent[1]).toMatchObject({ url: 'https://api.example/v1/swaps/s1/legs/b/presign', method: 'POST' });
    expect(JSON.parse(sent[1]!.body!)).toEqual({ kind: 'refund', toAddress: presign.toAddress, levels: [level] });
    expect(swap).toEqual({ id: 's1' });
  });

  it('sends a Bitcoin `to` and `escrow` only when given', async () => {
    sent.length = 0;
    await client.buildRefund('s1', 'a');
    await client.buildRefund('s1', 'a', { to: 'tb1qx', escrow: 'tb1qold' });
    await client.buildClaim('s1', 'a', 'bb'.repeat(32));
    expect(sent.map((r) => r.body)).toEqual([undefined, '{"to":"tb1qx"}', JSON.stringify({ secret: 'bb'.repeat(32) })]);
    expect(sent.map((r) => r.url.split('/legs/')[1])).toEqual(['a/refund', 'a/refund?escrow=tb1qold', 'a/claim']);
  });
});

describe('setProfile', () => {
  it('PATCHes /me/profile with exactly what was given — a null handle is sent, an absent one is not', async () => {
    const sent: Array<{ url: string; method: string; body: string; key: string | null }> = [];
    const client = new HashlockClient({
      apiKey: 'hk_test_x',
      baseUrl: 'https://api.example/v1',
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, method: init.method!, body: init.body as string, key: new Headers(init.headers).get('idempotency-key') });
        return new Response(JSON.stringify({ handle: 'my_desk', handlePublic: true }));
      }) as typeof fetch,
    });
    expect(await client.setProfile({ handle: 'my_desk', handlePublic: true }, 'k1')).toEqual({ handle: 'my_desk', handlePublic: true });
    await client.setProfile({ handle: null });
    await client.setProfile({ handlePublic: false });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(Array(3).fill('PATCH https://api.example/v1/me/profile'));
    expect(sent.map((s) => JSON.parse(s.body))).toEqual([{ handle: 'my_desk', handlePublic: true }, { handle: null }, { handlePublic: false }]);
    expect(sent[0]!.key).toBe('k1');
  });
});
