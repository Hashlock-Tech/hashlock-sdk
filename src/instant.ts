// ─── Instant Settlement (Lane A) — taker + solver surface ───
//
// Mirrors the Instant Settlement Phase 1.6 backend surface:
//
//   Quote.instantFill / Quote.solverVaultAddr      (maker commitment)
//   requestInstantFill(rfqId, quoteId)             (taker)
//   acceptQuote(quoteId, policy)                   (taker, policy = preference)
//   markInstantFillFronted(fillId, frontTxHash)    (solver)
//   subscription instantFillRequested              (solver-scoped)
//   subscription instantFillFronted                (taker-scoped)
//
// CANONICAL ORDER (taker instant path):
//   requestInstantFill SUCCEEDS → then acceptQuote.
// The `requestInstantFillAndAccept` helper enforces this order inside
// the SDK so callers cannot get it backwards.
//
// MONEY FIELDS: `amountWei` is the committed fill amount in the
// asset's smallest on-chain unit (wei / sats / MIST) as a DECIMAL
// STRING. It covers the full uint256 range — NEVER convert it to a
// JavaScript `number` (precision loss above 2^53). Use `BigInt(amountWei)`
// when arithmetic is needed.

import { GraphQLError } from './errors.js';
import { HashLockError } from './errors.js';
import type { Quote } from './types.js';

// ─── InstantFill domain object ───────────────────────────────

/**
 * Lifecycle state of an instant fill. Linear, forward-only:
 * `committed → fronted → settled → reimbursed` (with `cancelled` as
 * a terminal off-ramp).
 */
export type InstantFillState =
  | 'committed'
  | 'fronted'
  | 'settled'
  | 'reimbursed'
  | 'cancelled';

export interface InstantFill {
  id: string;
  quoteId: string;
  /** The trade materialised from the accepted quote — null until the
   *  trade exists (e.g. right after `requestInstantFill`, before accept). */
  tradeId: string | null;
  state: InstantFillState;
  /**
   * Committed fill amount in the asset's smallest on-chain unit
   * (wei / sats / MIST) as a decimal string — full uint256 range.
   * NEVER convert to `number`; use `BigInt(amountWei)` for math.
   */
  amountWei: string;
  /** Tx hash of the solver's fronting payment (null until fronted). */
  frontTxHash: string | null;
  frontedAt: string | null;
  createdAt: string;
}

/** GraphQL selection set for the `InstantFill` type (mutation payloads:
 *  requestInstantFill / markInstantFillFronted). */
export const INSTANT_FILL_FIELDS =
  'id quoteId tradeId state amountWei frontTxHash frontedAt createdAt';

// ─── Subscription event payloads ─────────────────────────────
//
// The subscription payload types are NOT the InstantFill type — the
// schema defines dedicated event types with different fields:
//
//   type InstantFillRequested { fillId quoteId rfqId state amountWei createdAt }
//   type InstantFillFronted   { fillId quoteId rfqId tradeId state amountWei frontTxHash frontedAt }
//
// (no `id` — the fill id arrives as `fillId`; Requested has no
// tradeId/frontTxHash/frontedAt; Fronted has no createdAt.)
// Kept 1:1 with backend/services/trade-service/src/schema.ts
// SUBSCRIPTION_SDL; guarded by src/__tests__/schema-validate.test.ts
// against the vendored SDL in test/fixtures/.

/** Selection set for the `InstantFillRequested` subscription payload. */
export const INSTANT_FILL_REQUESTED_FIELDS =
  'fillId quoteId rfqId state amountWei createdAt';

/** Selection set for the `InstantFillFronted` subscription payload. */
export const INSTANT_FILL_FRONTED_FIELDS =
  'fillId quoteId rfqId tradeId state amountWei frontTxHash frontedAt';

/**
 * Payload of the solver-scoped `instantFillRequested` subscription:
 * a taker requested an instant fill on one of YOUR quotes.
 * Use `fillId` (not `id`) when calling `markInstantFillFronted`.
 */
export interface InstantFillRequestedEvent {
  fillId: string;
  quoteId: string;
  rfqId: string;
  /** Always 'committed' at request time. */
  state: InstantFillState;
  /** Committed amount in the asset's smallest unit (decimal string —
   *  full uint256 range; never convert to `number`). */
  amountWei: string;
  createdAt: string;
}

/**
 * Payload of the taker-scoped `instantFillFronted` subscription:
 * the solver marked one of YOUR requested fills as fronted.
 */
export interface InstantFillFrontedEvent {
  fillId: string;
  quoteId: string;
  rfqId: string;
  /** Trade materialised from the accepted quote (fronting requires the
   *  link, but the schema types it nullable). */
  tradeId: string | null;
  /** Always 'fronted' at publish time. */
  state: InstantFillState;
  /** Committed amount in the asset's smallest unit (decimal string). */
  amountWei: string;
  /** EVM tx hash of the solver vault's fronting transfer. */
  frontTxHash: string;
  frontedAt: string;
}

// ─── Agent policy (single engine, two adapters) ──────────────

/** Trust requirement level — mirrors the design §13.1 preset table. */
export type TrustLevel = 'low' | 'med' | 'max';

/**
 * Wire mapping for `TrustLevel` → the schema's `AgentPolicyInput.minTrust:
 * Int` (a 0-100 solver trust/reputation score). The backend compares
 * `minTrust > solverReputation` (reputation stubbed at 50 until the
 * reputation oracle lands):
 *
 * | TrustLevel | Int sent | Effect vs the 50 stub                         |
 * |------------|----------|-----------------------------------------------|
 * | `low`      | 0        | never constrains                              |
 * | `med`      | 50       | passes the stub (50 > 50 is false)            |
 * | `max`      | 100      | unmet → steers to the trustless pure-HTLC path |
 */
export const TRUST_LEVEL_TO_SCORE: Record<TrustLevel, number> = {
  low: 0,
  med: 50,
  max: 100,
};

/**
 * Declarative settlement preference attached to `acceptQuote`.
 *
 * SEMANTICS: a policy is a PREFERENCE, not a commitment. The backend
 * never rejects an accept because of its policy — a malformed or
 * unsatisfiable policy silently falls back to the standard
 * settlement path. The SDK reinforces this by sanitizing the policy
 * before sending (see `sanitizeAgentPolicy`).
 */
export interface AgentPolicy {
  /** Max acceptable settlement latency in milliseconds. */
  maxLatencyMs?: number;
  /** Max acceptable total fee in basis points (0-10000). */
  maxFeeBps?: number;
  /**
   * Minimum solver trust: either a `TrustLevel` preset name or a raw
   * 0-100 integer score. Either way the SDK sends an Int on the wire
   * (the schema's `AgentPolicyInput.minTrust` is `Int`) — see
   * `TRUST_LEVEL_TO_SCORE` for the preset mapping. `'max'`/100 steers
   * to the trustless pure-HTLC lane.
   */
  minTrust?: TrustLevel | number;
}

/**
 * The exact shape sent as the `policy` GraphQL variable — every field
 * an integer, matching `AgentPolicyInput { maxLatencyMs: Int,
 * maxFeeBps: Int, minTrust: Int }`. A `TrustLevel` string here would
 * fail GraphQL Int coercion and reject the WHOLE acceptQuote, which
 * is why `sanitizeAgentPolicy` always converts before send.
 */
export interface AgentPolicyWire {
  maxLatencyMs?: number;
  maxFeeBps?: number;
  minTrust?: number;
}

/**
 * Policy presets — 1:1 with the human speed-slider presets
 * (single engine, two adapters; design doc §13.1):
 *
 * | Preset     | Policy                  | Under the hood                        |
 * |------------|-------------------------|---------------------------------------|
 * | instant    | `maxLatencyMs: 3000`    | Lane A/B fronting, k=0–1 conf, wide spread |
 * | balanced   | `minTrust: 'med'`       | Lane A, k=2–3 confirmations            |
 * | trustless  | `minTrust: 'max'`       | Lane Z pure HTLC, full confs, tight spread |
 *
 * `balanced` intentionally leaves `maxFeeBps` unset (the design table's
 * `max_fee=X` is caller-specific) — spread it in:
 * `{ ...policyPresets.balanced, maxFeeBps: 30 }`.
 */
export const policyPresets = {
  instant: { maxLatencyMs: 3000 },
  balanced: { minTrust: 'med' },
  trustless: { minTrust: 'max' },
} as const satisfies Record<string, AgentPolicy>;

export type PolicyPresetName = keyof typeof policyPresets;

/** GraphQL `Int` is a signed 32-bit integer — anything above this fails
 *  wire coercion and would reject the whole mutation. */
const GRAPHQL_INT_MAX = 2_147_483_647;

/** Floor to an integer and clamp into [min, max]; non-finite → undefined. */
function toBoundedInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(Math.max(Math.floor(v), min), max);
}

/**
 * Reduce an arbitrary value to the wire policy (`AgentPolicyWire` — all
 * fields integers), or `undefined` when nothing valid remains. Unknown
 * keys and wrongly-typed values are dropped (never thrown) — this is
 * what guarantees, at the SDK layer, that a broken policy can never
 * fail an `acceptQuote`:
 *
 * - the schema types every `AgentPolicyInput` field as `Int`, so a
 *   non-integer (or a `TrustLevel` string) on the wire would fail
 *   GraphQL coercion and reject the ENTIRE mutation;
 * - therefore `minTrust` is converted via `TRUST_LEVEL_TO_SCORE`
 *   (low→0, med→50, max→100); a raw numeric score is accepted too and
 *   floored/clamped into the backend's 0-100 range;
 * - `maxFeeBps` is floored/clamped into the backend's 0-10000 range,
 *   `maxLatencyMs` floored and capped at the 32-bit Int maximum.
 */
export function sanitizeAgentPolicy(policy: unknown): AgentPolicyWire | undefined {
  if (policy === null || typeof policy !== 'object') return undefined;
  const p = policy as Record<string, unknown>;
  const out: AgentPolicyWire = {};

  if (typeof p.maxLatencyMs === 'number' && Number.isFinite(p.maxLatencyMs) && p.maxLatencyMs > 0) {
    out.maxLatencyMs = toBoundedInt(p.maxLatencyMs, 0, GRAPHQL_INT_MAX);
  }
  const maxFeeBps = toBoundedInt(p.maxFeeBps, 0, 10_000);
  if (maxFeeBps !== undefined) {
    out.maxFeeBps = maxFeeBps;
  }
  if (p.minTrust === 'low' || p.minTrust === 'med' || p.minTrust === 'max') {
    out.minTrust = TRUST_LEVEL_TO_SCORE[p.minTrust];
  } else {
    const minTrust = toBoundedInt(p.minTrust, 0, 100);
    if (minTrust !== undefined) out.minTrust = minTrust;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// ─── Typed error classification for requestInstantFill ───────

/**
 * Why the instant path was unavailable and the SDK fell back to the
 * standard accept path:
 *
 * - `disabled`          — feature flag off (`INSTANT_FILL_DISABLED`)
 * - `lane_conflict`     — the settlement router classified the intent
 *                          into a non-instant lane (`extensions.lane`)
 * - `already_requested` — an instant fill already exists for this
 *                          quote (exactly-once per quote)
 */
export type InstantFillFallbackReason =
  | 'disabled'
  | 'lane_conflict'
  | 'already_requested';

export interface InstantFillFallback {
  reason: InstantFillFallbackReason;
  /** The conflicting lane (only for `lane_conflict`). */
  lane?: string;
}

/**
 * Classify a `requestInstantFill` failure into a typed fallback
 * reason, or `null` when the error is NOT an expected instant-fill
 * refusal (auth, network, validation, …) and must be rethrown
 * instead of silently falling back.
 *
 * WIRE SHAPE (verified against the backend error pipeline):
 * `HashlockError` crosses trade-service's yoga `maskTradeError` and the
 * gateway formatter as `extensions: { ...metadata, code, retryable }` —
 * the metadata is FLATTENED into extensions and the HTTP statusCode is
 * NEVER serialized. So on the wire:
 *
 * - flag off          → `extensions.code = 'INSTANT_FILL_DISABLED'`
 *                       (a bare GraphQLError; survives the gateway's
 *                       prod masking, which preserves the code);
 * - lane conflict     → `extensions.code = 'INVALID_INPUT'` with the
 *                       lane at `extensions.lane` (flattened metadata);
 * - already requested → `extensions.code = 'INVALID_STATE_TRANSITION'`
 *                       with message "Instant fill already requested
 *                       for this quote".
 *
 * Other `INVALID_STATE_TRANSITION` errors (quote no longer firm /
 * expired) deliberately classify as `null`: the standard accept would
 * fail on the same dead quote, so falling back silently would only
 * obscure the real error.
 */
export function classifyInstantFillError(err: unknown): InstantFillFallback | null {
  if (!(err instanceof GraphQLError)) return null;

  for (const entry of err.errors) {
    const ext = (entry.extensions ?? {}) as Record<string, unknown>;
    const code = typeof ext.code === 'string' ? ext.code : undefined;
    const message = entry.message ?? '';

    // Feature flag off
    if (code === 'INSTANT_FILL_DISABLED' || message.includes('INSTANT_FILL_DISABLED')) {
      return { reason: 'disabled' };
    }

    // Lane conflict — HashlockError metadata { lane } is flattened to
    // extensions.lane by the error formatter (extensions.metadata.lane
    // kept as a defensive fallback for non-flattening transports).
    const metadata = (ext.metadata ?? {}) as Record<string, unknown>;
    const lane =
      typeof ext.lane === 'string' ? ext.lane
      : typeof metadata.lane === 'string' ? metadata.lane
      : undefined;
    if (lane !== undefined) {
      return { reason: 'lane_conflict', lane };
    }

    // Exactly-once guard: committed fill already exists for the quote.
    if (code === 'INVALID_STATE_TRANSITION' && /already requested/i.test(message)) {
      return { reason: 'already_requested' };
    }
  }

  return null;
}

// ─── Taker flow result ───────────────────────────────────────

/**
 * The fill was committed (`requestInstantFill` succeeded) but the
 * follow-up `acceptQuote` failed — the fill exists server-side
 * without an accepted quote. Recover with
 * `retryAcceptAfterInstantFill(result.fill)` (accept-only; never
 * re-requests the fill, which would 409 on the exactly-once guard).
 */
export class InstantFillOrphanedError extends HashLockError {
  constructor(
    public readonly fill: InstantFill,
    public readonly acceptError: Error,
  ) {
    super(
      `Instant fill ${fill.id} is committed but acceptQuote failed: ${acceptError.message}. ` +
        `Do NOT call requestInstantFill again — retry the accept only ` +
        `(retryAcceptAfterInstantFill).`,
      'INSTANT_FILL_ORPHANED',
      { fill, acceptError },
    );
    this.name = 'InstantFillOrphanedError';
  }
}

/**
 * Outcome of the taker flow helper `requestInstantFillAndAccept`:
 *
 * | kind            | meaning                                                    |
 * |-----------------|------------------------------------------------------------|
 * | `instant`       | fill committed AND quote accepted — instant path complete   |
 * | `standard`      | instant path refused (typed `reason`) → standard accept done |
 * | `fill_orphaned` | fill committed but accept failed — see `error.fill` to retry |
 *
 * Unexpected errors (auth, network, unknown GraphQL) are THROWN, not
 * folded into this union — only typed instant-fill refusals fall back.
 */
export type InstantTakerResult =
  | { kind: 'instant'; fill: InstantFill; quote: Quote }
  | { kind: 'standard'; reason: InstantFillFallbackReason; lane?: string; quote: Quote }
  | { kind: 'fill_orphaned'; fill: InstantFill; error: InstantFillOrphanedError };
