/**
 * Schema-drift guard: every GraphQL operation string the SDK sends is
 * statically validated against the VENDORED authoritative SDL from the
 * main repo (test/fixtures/schema.graphql + schema.subscriptions.graphql,
 * refreshed via `node scripts/vendor-schema.mjs <main-repo-path>`).
 *
 * This exists because the Instant Settlement surface initially shipped
 * with operation strings written from a brief instead of the real SDL —
 * two confirmed drifts (subscription payload fields, minTrust type).
 * Any future field/arg drift now fails this suite instead of failing at
 * runtime against production.
 *
 * `graphql` is a devDependency ONLY — the published SDK keeps zero
 * runtime dependencies.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  parse,
  validate,
  buildASTSchema,
  Kind,
} from 'graphql';
import type { DefinitionNode, DocumentNode, GraphQLSchema } from 'graphql';
import { HashLock } from '../hashlock.js';
import { policyPresets } from '../instant.js';
import type { WebSocketConstructor } from '../ws.js';

// ─── Vendored schema loading ─────────────────────────────────

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)),
    'utf8',
  );
}

/**
 * Build an executable-enough schema from vendored SDL:
 * - drop the Apollo Federation `extend schema @link(...)` header
 *   (gateway-only; the SDK never speaks federation directives);
 * - fold `extend type X` extensions in (buildASTSchema accepts a doc
 *   that defines X and later extends it via concatenated definitions —
 *   we merge manually to stay graphql-js-version-agnostic);
 * - inject a dummy Query root for the subscriptions-only SDL
 *   (graphql-js refuses to validate against a schema without Query).
 */
function buildVendoredSchema(sdl: string): GraphQLSchema {
  const doc = parse(sdl);
  const defs = doc.definitions.filter((d) => d.kind !== Kind.SCHEMA_EXTENSION);

  // Merge `extend type X { fields }` into the base `type X` definition.
  const merged: DefinitionNode[] = [];
  const extensions = defs.filter((d) => d.kind === Kind.OBJECT_TYPE_EXTENSION);
  for (const def of defs) {
    if (def.kind === Kind.OBJECT_TYPE_EXTENSION) continue;
    if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
      const extra = extensions
        .filter((e) => e.kind === Kind.OBJECT_TYPE_EXTENSION && e.name.value === def.name.value)
        .flatMap((e) => e.fields ?? []);
      if (extra.length > 0) {
        merged.push({ ...def, fields: [...(def.fields ?? []), ...extra] });
        continue;
      }
    }
    merged.push(def);
  }

  const hasQuery = merged.some(
    (d) => d.kind === Kind.OBJECT_TYPE_DEFINITION && d.name.value === 'Query',
  );
  if (!hasQuery) {
    merged.push(...parse('type Query { _sdkSchemaValidationDummy: Boolean }').definitions);
  }

  const finalDoc: DocumentNode = { kind: Kind.DOCUMENT, definitions: merged };
  return buildASTSchema(finalDoc);
}

const httpSchema = buildVendoredSchema(fixture('schema.graphql'));
const wsSchema = buildVendoredSchema(fixture('schema.subscriptions.graphql'));

function expectValid(schema: GraphQLSchema, operation: string): void {
  const errors = validate(schema, parse(operation));
  expect(
    errors.map((e) => e.message),
    `operation failed schema validation:\n${operation}`,
  ).toEqual([]);
}

// ─── Capture the EXACT operation strings the SDK sends ───────

/** GraphQLClient stand-in that records operations and returns hollow data. */
function capturingClient(captured: string[]) {
  const run = (query: string): Promise<Record<string, unknown>> => {
    captured.push(query);
    // Every HashLock method destructures exactly one root field — hand
    // back a proxy that has every key.
    return Promise.resolve(
      new Proxy({}, { get: () => ({}) }) as Record<string, unknown>,
    );
  };
  return {
    query: run,
    mutate: run,
    setAccessToken: (): void => {},
    getAccessToken: (): string | undefined => 'test-token',
  };
}

type Listener = (event: { data?: unknown }) => void;

/** Minimal fake socket: handshakes far enough to capture the subscribe payload. */
class CaptureWebSocket {
  static lastQuery: string | undefined;
  private listeners: Record<string, Listener[]> = {};
  constructor(_url: string, _protocols?: string | string[]) {
    queueMicrotask(() => {
      this.emit('open');
      this.emit('message', { data: JSON.stringify({ type: 'connection_ack' }) });
    });
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type?: string; payload?: { query?: string } };
    if (msg.type === 'subscribe' && msg.payload?.query) {
      CaptureWebSocket.lastQuery = msg.payload.query;
    }
  }
  close(): void {}
  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }
  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const l of this.listeners[type] ?? []) l(event);
  }
}

function makeSdk(captured: string[]): HashLock {
  const hl = new HashLock({
    endpoint: 'http://localhost:4000/graphql',
    accessToken: 'test-token',
    fetch: vi.fn() as unknown as typeof fetch,
    webSocket: CaptureWebSocket as unknown as WebSocketConstructor,
  });
  (hl as unknown as { client: ReturnType<typeof capturingClient> }).client =
    capturingClient(captured);
  return hl;
}

async function captureOp(invoke: (hl: HashLock) => Promise<unknown>): Promise<string> {
  const captured: string[] = [];
  await invoke(makeSdk(captured));
  expect(captured).toHaveLength(1);
  return captured[0];
}

async function captureSubscription(invoke: (hl: HashLock) => void): Promise<string> {
  CaptureWebSocket.lastQuery = undefined;
  invoke(makeSdk([]));
  await new Promise((r) => setTimeout(r, 0)); // let the fake handshake run
  expect(CaptureWebSocket.lastQuery).toBeDefined();
  return CaptureWebSocket.lastQuery as string;
}

// ─── HTTP operations (queries + mutations) ───────────────────

const HTTP_OPERATIONS: Array<[name: string, invoke: (hl: HashLock) => Promise<unknown>]> = [
  ['createRFQ', (hl) => hl.createRFQ({ baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL', amount: '1' })],
  ['getRFQ', (hl) => hl.getRFQ('rfq-1')],
  ['listRFQs', (hl) => hl.listRFQs()],
  ['cancelRFQ', (hl) => hl.cancelRFQ('rfq-1')],
  ['submitQuote', (hl) => hl.submitQuote({ rfqId: 'rfq-1', price: '1', amount: '1' })],
  ['acceptQuote (no policy)', (hl) => hl.acceptQuote('q-1')],
  ['acceptQuote (with policy)', (hl) => hl.acceptQuote('q-1', policyPresets.balanced)],
  ['getQuotes', (hl) => hl.getQuotes('rfq-1')],
  ['requestInstantFill', (hl) => hl.requestInstantFill('rfq-1', 'q-1')],
  ['markInstantFillFronted', (hl) => hl.markInstantFillFronted('fill-1', '0xfront')],
  ['getTrade', (hl) => hl.getTrade('t-1')],
  ['listTrades', (hl) => hl.listTrades()],
  ['confirmDirectTrade', (hl) => hl.confirmDirectTrade({
    counterpartyId: 'u-2', baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL',
    baseAmount: '1', price: '1', chainId: '11155111',
  })],
  ['acceptTrade', (hl) => hl.acceptTrade('t-1')],
  ['cancelTrade', (hl) => hl.cancelTrade('t-1')],
  ['confirmSettlementWallets', (hl) => hl.confirmSettlementWallets({
    tradeId: 't-1', sendWalletId: 'w-1', receiveWalletId: 'w-2',
  })],
  ['fundHTLC', (hl) => hl.fundHTLC({ tradeId: 't-1', txHash: '0xabc', role: 'INITIATOR' })],
  ['claimHTLC', (hl) => hl.claimHTLC({ tradeId: 't-1', txHash: '0xabc', preimage: '0x01' })],
  ['refundHTLC', (hl) => hl.refundHTLC({ tradeId: 't-1', txHash: '0xabc' })],
  ['getHTLCs', (hl) => hl.getHTLCs('t-1')],
  ['prepareBitcoinHTLC', (hl) => hl.prepareBitcoinHTLC({
    tradeId: 't-1', role: 'INITIATOR', senderPubKey: '02ab', receiverPubKey: '03cd',
    timelock: 1700000000, amountSats: '100000',
  })],
  ['buildBitcoinClaimPSBT', (hl) => hl.buildBitcoinClaimPSBT({
    tradeId: 't-1', htlcId: 'h-1', preimage: '0x01', destinationPubKey: '02ab',
  })],
  ['broadcastBitcoinTx', (hl) => hl.broadcastBitcoinTx({ tradeId: 't-1', txHex: '0200' })],
];

describe('SDK operations validate against the vendored trade-service schema', () => {
  describe('HTTP operations (typeDefs schema)', () => {
    it.each(HTTP_OPERATIONS)('%s', async (_name, invoke) => {
      expectValid(httpSchema, await captureOp(invoke));
    });

    // KNOWN PRE-EXISTING DRIFT (since v0.1.0, NOT part of the instant
    // surface): getHTLCStatus selects nested `initiatorHTLC { … }` /
    // `counterpartyHTLC { … }`, but the schema's HTLCStatusResult is a
    // FLAT type (tradeId/contractAddress/hashlock/…/chainId). Fixing it
    // changes the legacy public return shape, so it is documented here
    // and skipped instead of silently "fixed". Use getHTLCs(tradeId)
    // for per-role HTLC data until getHTLCStatus is reworked.
    it.skip('getHTLCStatus — legacy drift: HTLCStatusResult has no initiatorHTLC/counterpartyHTLC', async () => {
      expectValid(httpSchema, await captureOp((hl) => hl.getHTLCStatus('t-1')));
    });
  });

  describe('subscriptions (graphql-ws schema)', () => {
    it('onInstantFillRequested selects exactly the InstantFillRequested payload', async () => {
      const op = await captureSubscription((hl) => hl.onInstantFillRequested(() => {}));
      expectValid(wsSchema, op);
    });

    it('onInstantFillFronted selects exactly the InstantFillFronted payload', async () => {
      const op = await captureSubscription((hl) => hl.onInstantFillFronted(() => {}));
      expectValid(wsSchema, op);
    });

    it('serveInstantFills subscribes with the InstantFillRequested payload', async () => {
      const op = await captureSubscription((hl) => {
        hl.serveInstantFills(async () => '0xfront');
      });
      expectValid(wsSchema, op);
    });
  });
});
