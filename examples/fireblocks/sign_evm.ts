/**
 * Reference: sign an EVM settlement build with Fireblocks (CONTRACT_CALL). Fireblocks signs AND broadcasts
 * via its own nodes, so you do NOT call client.broadcast for this path — you poll Fireblocks for the hash.
 *
 *   npm i @hashlock-tech/sdk fireblocks-sdk
 *
 * The CONTRACT_CALL flow is validated live on Fireblocks Sandbox (Sepolia); the `PeerType` /
 * `TransactionOperation` / `TransactionStatus` enums below match the current `fireblocks-sdk`. Set your
 * own vault account id + asset id. (Python uses different symbols — see sign_evm.py / the README.)
 */
import { HashlockClient, type EvmBuild } from '@hashlock-tech/sdk';
import { FireblocksSDK, PeerType, TransactionOperation, TransactionStatus } from 'fireblocks-sdk';

const client = new HashlockClient({ apiKey: process.env.HASHLOCK_API_KEY! });
const fireblocks = new FireblocksSDK(process.env.FIREBLOCKS_API_SECRET!, process.env.FIREBLOCKS_API_KEY!);

const VAULT_ACCOUNT_ID = process.env.FIREBLOCKS_VAULT_ID!; // your vault account
const ASSET_ID = 'ETH_TEST5'; // Fireblocks asset id for the target chain (Sepolia here)

/** Submit one unsigned EVM tx as a Fireblocks contract call and wait for the on-chain hash. */
async function signViaFireblocks(tx: { to: string; data: string; value?: string }): Promise<string> {
  const { id } = await fireblocks.createTransaction({
    operation: TransactionOperation.CONTRACT_CALL,
    assetId: ASSET_ID,
    source: { type: PeerType.VAULT_ACCOUNT, id: VAULT_ACCOUNT_ID },
    destination: { type: PeerType.ONE_TIME_ADDRESS, oneTimeAddress: { address: tx.to } },
    amount: tx.value ? String(BigInt(tx.value)) : '0', // wei; '0' for ERC-20 approve / createSwap
    extraParameters: { contractCallData: tx.data },
    note: 'Hashlock HTLC settlement',
  });

  // Return only once the tx is mined (CONFIRMING) or fully confirmed (COMPLETED) — NOT on the mere
  // presence of a txHash — so the dependent createSwap isn't submitted before this approve lands
  // (createSwap's transferFrom needs the approve's allowance on-chain).
  for (;;) {
    const t = await fireblocks.getTransactionById(id);
    if ((t.status === TransactionStatus.CONFIRMING || t.status === TransactionStatus.COMPLETED) && t.txHash) return t.txHash;
    if ([TransactionStatus.FAILED, TransactionStatus.BLOCKED, TransactionStatus.CANCELLED, TransactionStatus.REJECTED].includes(t.status)) {
      throw new Error(`Fireblocks tx ${id} ${t.status}: ${t.subStatus}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function fundEvmLeg(swapId: string, leg: 'a' | 'b') {
  const build = (await client.buildFund(swapId, leg)) as EvmBuild;
  // EVM fund = [approve, createSwap]; submit in order, waiting for each (approve must confirm before createSwap).
  for (const tx of build.txs) {
    const hash = await signViaFireblocks(tx);
    console.log('fireblocks broadcast', hash);
  }
}
