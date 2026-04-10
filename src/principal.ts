// ─── Principal + Attestation Types ───────────────────────────
//
// Mirror of the canonical types defined in @hashlock-tech/intent-schema.
// Duplicated here as plain TS interfaces (the SDK pattern) so the
// SDK has no runtime dependency on the intent-schema package.
//
// Keep these shapes in sync with:
//   @hashlock-tech/intent-schema → src/types/principal.ts
//
// EXPERIMENTAL: these fields are defined at the SDK type surface so
// agents can construct the right shape today. GraphQL wire-through
// to the Cayman backend happens in a later release once the backend
// schema is updated to accept PrincipalAttestationInput and
// AgentInstanceInput. Until then, passing these fields to SDK
// methods is a no-op at the network layer.

export type KycTier =
  | 'NONE'
  | 'BASIC'
  | 'STANDARD'
  | 'ENHANCED'
  | 'INSTITUTIONAL';

export type PrincipalType = 'HUMAN' | 'INSTITUTION' | 'AGENT';

export interface PrincipalAttestation {
  /** Opaque identifier (hash) of the KYC'd principal entity */
  principalId: string;
  /** Kind of principal backing the intent/order */
  principalType: PrincipalType;
  /** Attested compliance tier of the principal */
  tier: KycTier;
  /** Rotating pseudonym visible to counterparty (omit for post-match attribution only) */
  blindId?: string;
  /** Attestation issuance time (unix seconds) */
  issuedAt: number;
  /** Attestation expiration (unix seconds) */
  expiresAt: number;
  /** Opaque proof (signature or ZK proof) verified by the HashLock gateway */
  proof: string;
}

export interface AgentInstance {
  /** Stable identifier for the agent instance */
  instanceId: string;
  /** Human-readable strategy label (e.g. "mm-eth-usdc") */
  strategy?: string;
  /** Agent software version */
  version?: string;
  /** Instance spawn time (unix seconds) */
  spawnedAt?: number;
}

export const KYC_TIER_RANK: Record<KycTier, number> = {
  NONE: 0,
  BASIC: 1,
  STANDARD: 2,
  ENHANCED: 3,
  INSTITUTIONAL: 4,
};

export function meetsKycTier(actual: KycTier, required: KycTier): boolean {
  return KYC_TIER_RANK[actual] >= KYC_TIER_RANK[required];
}
