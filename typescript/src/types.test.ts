import { describe, expect, it } from 'vitest';
import type { SettlementBuild } from './types.js';

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
