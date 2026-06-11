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

/** Shared GraphQL selection set for InstantFill payloads. */
export const INSTANT_FILL_FIELDS =
  'id quoteId tradeId state amountWei frontTxHash frontedAt createdAt';

// ─── Agent policy (single engine, two adapters) ──────────────

/** Trust requirement level — mirrors the design §13.1 preset table. */
export type TrustLevel = 'low' | 'med' | 'max';

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
  /** Max acceptable total fee in basis points. */
  maxFeeBps?: number;
  /** Minimum trust level: 'max' = pure-HTLC trustless lane. */
  minTrust?: TrustLevel;
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

/**
 * Reduce an arbitrary value to a valid `AgentPolicy`, or `undefined`
 * when nothing valid remains. Unknown keys and wrongly-typed values
 * are dropped (never thrown) — this is what guarantees, at the SDK
 * layer, that a broken policy can never fail an `acceptQuote`.
 */
export function sanitizeAgentPolicy(policy: unknown): AgentPolicy | undefined {
  if (policy === null || typeof policy !== 'object') return undefined;
  const p = policy as Record<string, unknown>;
  const out: AgentPolicy = {};

  if (typeof p.maxLatencyMs === 'number' && Number.isFinite(p.maxLatencyMs) && p.maxLatencyMs > 0) {
    out.maxLatencyMs = p.maxLatencyMs;
  }
  if (typeof p.maxFeeBps === 'number' && Number.isFinite(p.maxFeeBps) && p.maxFeeBps >= 0) {
    out.maxFeeBps = p.maxFeeBps;
  }
  if (p.minTrust === 'low' || p.minTrust === 'med' || p.minTrust === 'max') {
    out.minTrust = p.minTrust;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// ─── Typed error classification for requestInstantFill ───────

/**
 * Why the instant path was unavailable and the SDK fell back to the
 * standard accept path:
 *
 * - `disabled`          — feature flag off (`INSTANT_FILL_DISABLED`)
 * - `lane_conflict`     — 409 with `metadata.lane`: the quote routed
 *                          to a lane that cannot instant-fill
 * - `already_requested` — 409: an instant fill already exists for
 *                          this quote (exactly-once per quote)
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

function extractHttpStatus(ext: Record<string, unknown>): number | undefined {
  if (typeof ext.status === 'number') return ext.status;
  const http = ext.http;
  if (http && typeof http === 'object' && typeof (http as Record<string, unknown>).status === 'number') {
    return (http as Record<string, unknown>).status as number;
  }
  return undefined;
}

/**
 * Classify a `requestInstantFill` failure into a typed fallback
 * reason, or `null` when the error is NOT an expected instant-fill
 * refusal (auth, network, validation, …) and must be rethrown
 * instead of silently falling back.
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

    // Lane conflict — 409 carrying metadata.lane
    const metadata = (ext.metadata ?? {}) as Record<string, unknown>;
    const lane = typeof metadata.lane === 'string' ? metadata.lane : undefined;
    if (lane !== undefined) {
      return { reason: 'lane_conflict', lane };
    }

    // Already-requested — 409 without a lane (exactly-once per quote)
    const status = extractHttpStatus(ext);
    if (status === 409 || code === 'CONFLICT' || code === 'ALREADY_REQUESTED') {
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
