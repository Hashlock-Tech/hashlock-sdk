// The swap secret + its hashlock. The INITIATOR (funds the long leg) generates the secret locally,
// keeps it private, and passes only `hashlock = sha256(secret)` to acceptTerms(). The secret is revealed
// on-chain when the initiator claims the counter-leg; keep it until then. Web Crypto → runs everywhere.

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh 32-byte secret and its sha256 hashlock, both as hex (no 0x). */
export async function newSecret(): Promise<{ secret: string; hashlock: string }> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const hash = await crypto.subtle.digest('SHA-256', secret);
  return { secret: toHex(secret), hashlock: toHex(new Uint8Array(hash)) };
}

/** sha256(secret) as hex — verify a preimage against a swap's hashlock. */
export async function sha256Hex(hex: string): Promise<string> {
  const bytes = Uint8Array.from((hex.replace(/^0x/, '').match(/.{1,2}/g) ?? []).map((h) => parseInt(h, 16)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(hash));
}
