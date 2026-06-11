# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-06-11

### Added — Instant Settlement (Lane A) public surface

First SDK slice of Phase 5.2: agent frameworks call Hashlock's
instant-settlement engine through the SDK ("single engine, two
adapters" — this is the SDK adapter leg). All backend surfaces are
live behind a feature flag; the SDK degrades gracefully when the
flag is off.

- **Types**: `InstantFill` (state union `committed | fronted | settled |
  reimbursed | cancelled`; `amountWei` is a decimal **string** over the
  full uint256 range — never converted to `number`), `AgentPolicy`
  (`maxLatencyMs` / `maxFeeBps` / `minTrust`), `TrustLevel`,
  `InstantTakerResult`, `InstantFillFallbackReason`,
  `InstantFillOrphanedError`. `Quote.instantFill` /
  `Quote.solverVaultAddr` response fields.
- **Maker**: `submitQuote` accepts `instantFill` + `solverVaultAddr`.
- **Taker**: `requestInstantFill(rfqId, quoteId)`;
  `acceptQuote(quoteId, policy?)` — policy is an optional PREFERENCE
  that can never fail the accept (SDK sanitizes invalid policies down
  to the standard path); flow helper
  `requestInstantFillAndAccept(rfqId, quoteId, { policy })` enforcing
  the canonical order (fill succeeds → accept) with typed fallbacks:
  `INSTANT_FILL_DISABLED` / lane conflict (`extensions.lane`) /
  already-requested → automatic standard `acceptQuote`; fill OK +
  accept FAIL → `fill_orphaned` result carrying
  `InstantFillOrphanedError`, recoverable via the accept-only
  `retryAcceptAfterInstantFill(fill)` (never re-requests the fill —
  exactly-once per quote). Unexpected errors are thrown, never
  swallowed into fallback.
- **Solver**: `markInstantFillFronted(fillId, frontTxHash)`;
  `onInstantFillRequested(cb)` (solver-scoped subscription);
  `serveInstantFills(front, opts)` = subscribe + auto-mark-fronted.
- **Taker notifications**: `onInstantFillFronted(cb)` (taker-scoped).
- **Subscriptions**: minimal `graphql-transport-ws` client transport
  (zero new runtime dependencies). Global `WebSocket` (browsers,
  Node >= 22) used automatically; `HashLockConfig.webSocket` /
  `wsEndpoint` for Node 18/20 (`ws` package) or custom endpoints.
- **Policy presets**: `policyPresets.instant` (`maxLatencyMs: 3000`) /
  `.balanced` (`minTrust: 'med'`) / `.trustless` (`minTrust: 'max'`)
  — 1:1 with the design §13.1 human-slider table.
- `GraphQLError.errors[]` entries now preserve the server's
  `extensions` (code / flattened metadata) for typed
  classification (`classifyInstantFillError`).
- 35 new tests (taker decision table, error classification, policy
  sanitization, ws handshake/subscription lifecycle, solver serve loop).

### Fixed — schema drift (pre-release; 0.3.0 was never tagged/published)

The initial instant surface was written from the design brief instead of
the real SDL; verification against the main repo's `origin/main` schema
found two confirmed drifts, fixed here BEFORE any release:

- **Subscription payload types** — `instantFillRequested` /
  `instantFillFronted` deliver dedicated event types, NOT `InstantFill`.
  The SDK previously selected `id … frontTxHash frontedAt createdAt` on
  both, which the server rejects (`Cannot query field "id" on type
  "InstantFillRequested"`). Now: `InstantFillRequestedEvent`
  (`fillId quoteId rfqId state amountWei createdAt`) and
  `InstantFillFrontedEvent` (`fillId quoteId rfqId tradeId state
  amountWei frontTxHash frontedAt`), with matching selection constants
  `INSTANT_FILL_REQUESTED_FIELDS` / `INSTANT_FILL_FRONTED_FIELDS`.
  `onInstantFillRequested` / `onInstantFillFronted` /
  `serveInstantFills` callbacks are typed accordingly, and
  `serveInstantFills` now fronts via `event.fillId` (the old code read
  `fill.id`, which does not exist on the event payload).
- **`minTrust` wire type** — the schema's `AgentPolicyInput.minTrust`
  is `Int` (0-100 trust score); the SDK was sending the `TrustLevel`
  string raw, which fails GraphQL Int coercion and rejects the ENTIRE
  `acceptQuote` (violating the "a policy can never fail the accept"
  guarantee). `sanitizeAgentPolicy` now returns the wire shape
  (`AgentPolicyWire`, all fields integers): `TrustLevel` maps via
  `TRUST_LEVEL_TO_SCORE` (low→0, med→50, max→100 — med passes the
  backend's 50 reputation stub since the guard is `minTrust > score`;
  max steers trustless); raw 0-100 numbers are accepted, floored and
  clamped; `maxFeeBps` clamps to 0-10000 and `maxLatencyMs` to the
  32-bit Int range for coercion safety.
- **`classifyInstantFillError` wire shape** — verified against the
  backend pipeline (trade-service `maskTradeError` + gateway
  formatter): `HashlockError` serializes as
  `extensions: { ...metadata, code, retryable }` — metadata FLATTENED,
  HTTP status NEVER serialized. The classifier now reads the lane from
  `extensions.lane` (with `extensions.metadata.lane` as a defensive
  fallback) and detects already-requested via
  `code === 'INVALID_STATE_TRANSITION'` + the "already requested"
  message; the dead `extensions.status` / `http.status` / `CONFLICT`
  paths were removed. Other `INVALID_STATE_TRANSITION` errors (quote no
  longer firm / expired) classify as `null` and are rethrown.

### Added — permanent drift guard

- `test/fixtures/schema.graphql` + `schema.subscriptions.graphql`:
  vendored authoritative SDL from the main repo (source path, git ref
  and commit SHA recorded in the fixture headers). Refresh with
  `node scripts/vendor-schema.mjs <main-repo-path>`.
- `src/__tests__/schema-validate.test.ts`: every operation string the
  SDK sends (captured from the real code paths, including the ws
  subscribe frames) is `validate()`d against the vendored SDL using the
  `graphql` package (devDependency ONLY — runtime stays zero-dependency).
- Known pre-existing legacy drift documented (skipped test, not fixed
  to avoid breaking the v0.1.x public shape): `getHTLCStatus` selects
  `initiatorHTLC`/`counterpartyHTLC`, but the schema's
  `HTLCStatusResult` is flat — use `getHTLCs(tradeId)` instead.

### Compatibility
- **Backward compatible / additive.** `acceptQuote` without a policy
  sends the exact legacy operation; plain quotes are untouched; no
  existing export changed shape.
- **Not yet published to npm** (operator decision pending). Publish
  with `npm publish --access public` after operator sign-off.

## [0.2.0] - 2026-04-26

### Added
- Cross-chain `createRFQ` — `baseChain` / `quoteChain` inputs
  (`RFQChainId`) so cross-chain RFQs resolve `(symbol, chain)`
  composite tokens unambiguously. (Entry backfilled in 0.3.0; see git
  tag/commit `bb2771f` for details.)

## [0.1.4] - 2026-04-11

### Added
- **Experimental field warning** — when a caller sets any of the
  experimental agent-layer fields (`attestation`, `agentInstance`,
  `minCounterpartyTier`, `hideIdentity`) on `createRFQ`,
  `submitQuote`, or `fundHTLC`, the SDK now emits a one-time
  `console.warn` per field/method pair explaining that GraphQL
  wire-through to the Cayman backend is not yet implemented and
  the field is currently a no-op at the network layer.
- Warning can be suppressed with `HASHLOCK_SDK_SILENCE_EXPERIMENTAL=1`
  for call sites that have already acknowledged the experimental
  status.
- 2 new tests verifying the warning fires when experimental fields
  are set and stays silent when they are not.

### Why
The v0.1.3 release exposed experimental type surface for agent
flows but dropped the fields silently at the network layer — a
DX hazard, because a caller could set `attestation` and assume
it reached the backend. This warning closes the expectation gap.

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
