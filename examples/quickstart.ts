/**
 * Quickstart: a full BTC ↔ USDT(EVM) swap driven entirely through the developer API.
 *
 *   npm i @hashlock-tech/sdk
 *   HASHLOCK_API_KEY=hk_test_… npx tsx examples/quickstart.ts
 *
 * This shows the API flow end-to-end. Signing is YOURS — the settlement builders return UNSIGNED
 * transactions; sign them with your wallet or HSM (see examples/fireblocks) and either broadcast via
 * client.broadcast(...) or let your custody provider broadcast. The server never holds your keys.
 */
import { HashlockClient, newSecret } from '@hashlock-tech/sdk';

const client = new HashlockClient({
  apiKey: process.env.HASHLOCK_API_KEY!,
  baseUrl: process.env.HASHLOCK_API_URL ?? 'https://api-dev.hashlock.markets/v1',
});

// Sign an unsigned settlement build with your own key/HSM, then return a txid.
// EVM → sign each tx and broadcast; TRON → sign each txID; Bitcoin → build+sign the P2WSH spend.
// See examples/fireblocks for a custody-provider reference.
declare function signAndBroadcast(build: unknown): Promise<string>;

async function main() {
  const me = await client.me();
  console.log('authenticated:', me.userId, me.scopes);

  const assets = await client.assets();
  const btc = assets.find((a) => a.chain === 'bitcoin' && a.symbol === 'BTC')!;
  const usdt = assets.find((a) => a.chain === 'ethereum' && a.symbol === 'USDT')!;

  // 1) taker: create an RFQ to sell BTC for USDT (the taker funds the long BTC leg → is the initiator).
  const rfq = await client.createRfq({
    direction: 'sell_base',
    baseAssetId: btc.id,
    baseAmount: '10000', // sats
    quoteAssetId: usdt.id,
    ttlSeconds: 3600,
  });
  console.log('rfq', rfq.id);

  // 2) maker (a different account/key) quotes it → opens a settlement thread.
  //    const { thread } = await makerClient.quoteRfq(rfq.id, '650000'); // 0.65 USDT (6 decimals)
  const threadId = '<thread id from the maker quote>';

  // 3) accept. The initiator (funds the long leg) supplies hashlock = sha256(secret).
  const { secret, hashlock } = await newSecret(); // keep `secret` private until you claim your leg
  await client.acceptTerms(threadId, { hashlock });
  // …the maker also accepts; when BOTH accept, the swap is created:
  const swap = (await client.acceptTerms(threadId)).swap!; // returns the swap once both sides accepted

  // 4) set your receive/refund addresses. Bitcoin uses the compressed pubkey (hex).
  await client.setSwapAddress(swap.id, 'ethereum', '0xYourUsdtPayoutAddress'); // taker receives USDT
  await client.setSwapAddress(swap.id, 'bitcoin', '<your btc compressed pubkey>'); // taker's BTC refund

  // 5) fund the long (BTC) leg — build → sign → broadcast.
  const fundBuild = await client.buildFund(swap.id, 'b'); // leg 'b' = BTC here
  await signAndBroadcast(fundBuild);

  // 6) once the counterparty funds the USDT leg (poll getSwap until 'counterparty_funded'),
  //    claim your USDT leg with the secret — this reveals it on-chain.
  const claimBuild = await client.buildClaim(swap.id, 'a', secret); // leg 'a' = USDT here
  await signAndBroadcast(claimBuild);

  // The counterparty then claims the BTC leg using the now-public secret. Track it live:
  for await (const s of pollSwap(client, swap.id)) {
    console.log('status:', s.status);
    if (s.status === 'counterparty_claimed' || s.status === 'refunded') break;
  }
}

async function* pollSwap(c: HashlockClient, id: string) {
  let last = '';
  for (;;) {
    const s = await c.getSwap(id);
    if (s.status !== last) { last = s.status; yield s; }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
