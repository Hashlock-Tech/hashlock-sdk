# Changelog

All notable changes to this project will be documented in this file.

## [0.1.3] - 2026-04-11

### Added
- **Principal + attestation type surface (experimental)** — agents operating
  under a KYC'd principal can now attach structured metadata to RFQs,
  quotes, and HTLC funding calls:
  - `PrincipalAttestation` interface: opaque binding from an order to a
    KYC'd entity (principalId, principalType, tier, blindId, issuedAt,
    expiresAt, proof) without leaking identity to counterparties
  - `AgentInstance` interface: autonomous agent instance metadata
    (instanceId, strategy, version, spawnedAt)
  - `KycTier` enum with `NONE < BASIC < STANDARD < ENHANCED < INSTITUTIONAL`
    ordering plus `KYC_TIER_RANK` and `meetsKycTier()` helper
  - New optional response fields on `RFQ` (`attestationTier`,
    `attestationBlindId`, `minCounterpartyTier`), `Quote`
    (`attestationTier`, `attestationBlindId`), and `Trade`
    (`initiatorAttestationTier`, `counterpartyAttestationTier`)
  - New optional input fields on `CreateRFQInput` (`attestation`,
    `agentInstance`, `minCounterpartyTier`, `hideIdentity`),
    `SubmitQuoteInput` (`attestation`, `agentInstance`, `hideIdentity`),
    and `FundHTLCInput` (`attestation`, `agentInstance`)
- 6 new tests covering the agent principal layer and backward compat

### Fixed
- Widen `GraphQLClient.execute()` variables parameter to accept
  `Record<string, unknown> | object | undefined` so typed SDK inputs
  (e.g., `CreateRFQInput`) satisfy the signature under strict TypeScript.
  This fix was a pre-existing CI lint failure from the v0.1.1 and v0.1.2
  publish commits; v0.1.3 is the first version whose CI lint step is green.

### Compatibility
- **Backward compatible.** All new fields are optional. Existing human
  OTC flows without attestation continue to work unchanged.
- **EXPERIMENTAL.** The new agent-layer fields are accepted at the SDK
  type surface today but are not yet sent to the Cayman GraphQL
  backend. Wire-through will land in a later release once the backend
  schema accepts `PrincipalAttestationInput` and `AgentInstanceInput`.
  Passing these fields today is a no-op at the network layer.

## [0.1.2] - 2026-04-09

### Fixed
- Use `/api/graphql` endpoint to bypass CSRF protection.

## [0.1.1] - 2026-04-09

### Fixed
- HTLC query uses `chainId` instead of `chainType` to match backend schema.

## [0.1.0] - 2026-04-09

### Added
- Initial release
- RFQ trading: createRFQ, submitQuote, acceptQuote, listRFQs, cancelRFQ
- Trade management: getTrade, listTrades, acceptTrade, cancelTrade, confirmDirectTrade
- EVM HTLC: fundHTLC, claimHTLC, refundHTLC, getHTLCStatus
- Bitcoin HTLC: prepareBitcoinHTLC, buildBitcoinClaimPSBT, broadcastBitcoinTx
- Settlement wallet management: confirmSettlementWallets
- Full TypeScript types for all inputs and outputs
- Automatic retry with exponential backoff
- Error hierarchy: HashLockError, GraphQLError, NetworkError, AuthError
- ESM + CJS dual build
