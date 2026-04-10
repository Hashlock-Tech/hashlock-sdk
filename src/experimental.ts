// ─── Experimental Field Warning ──────────────────────────────
//
// The agent-layer input fields (attestation, agentInstance,
// minCounterpartyTier, hideIdentity) are accepted by the SDK type
// surface today but are NOT yet sent to the Cayman GraphQL backend.
// Passing them is currently a no-op at the network layer.
//
// To avoid silent confusion, emit a one-time warning per field the
// first time a consumer sets one in a given process. The warning
// can be suppressed with `HASHLOCK_SDK_SILENCE_EXPERIMENTAL=1` in
// the environment, for call sites that have already opted in.

const warned = new Set<string>();

function silenceFlag(): boolean {
  // Works in both Node and browser-ish runtimes.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.HASHLOCK_SDK_SILENCE_EXPERIMENTAL === '1';
}

function emit(fieldPath: string): void {
  if (warned.has(fieldPath)) return;
  warned.add(fieldPath);
  if (silenceFlag()) return;

  const logger = (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console;
  logger?.warn?.(
    `[hashlock-sdk] EXPERIMENTAL: '${fieldPath}' was set but the GraphQL ` +
      `wire-through to the Cayman backend is not yet implemented. ` +
      `The field is accepted at the type surface but is currently ` +
      `a no-op at the network layer. Set HASHLOCK_SDK_SILENCE_EXPERIMENTAL=1 ` +
      `to suppress this warning.`,
  );
}

/**
 * Test-only: clear the warning dedup set so each test starts fresh.
 * @internal
 */
export function __resetExperimentalWarningState(): void {
  warned.clear();
}

/**
 * Inspect an input object for experimental agent-layer fields and
 * warn once per field when any are set. Safe to call on every SDK
 * method invocation — deduplication is built in.
 */
export function warnIfExperimental(
  methodName: string,
  input: Record<string, unknown>,
): void {
  const experimentalFields = [
    'attestation',
    'agentInstance',
    'minCounterpartyTier',
    'hideIdentity',
  ];

  for (const field of experimentalFields) {
    if (input[field] !== undefined) {
      emit(`${methodName}.${field}`);
    }
  }
}
