// Verify webhook deliveries. The server signs each POST with
//   X-Hashlock-Signature: sha256=HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
// where timestamp is the X-Hashlock-Timestamp header. Verify against the RAW request body (not a
// re-serialised object). Uses Web Crypto so it runs in Node 18+, browsers, and edge runtimes.

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyOptions {
  secret: string;
  /** The RAW request body string (exactly as received — do not re-serialise). */
  rawBody: string;
  /** The X-Hashlock-Signature header value, e.g. `sha256=…`. */
  signature: string | null | undefined;
  /** The X-Hashlock-Timestamp header value. */
  timestamp: string | null | undefined;
  /** Reject deliveries older than this many seconds (replay guard). Default 300; 0 disables. */
  toleranceSeconds?: number;
  /** Current unix time in seconds (for testing). Defaults to Date.now(). */
  nowUnix?: number;
}

/** Returns true iff the signature matches and the timestamp is within tolerance. */
export async function verifyWebhook(opts: VerifyOptions): Promise<boolean> {
  if (!opts.signature || !opts.timestamp) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;
  }
  const expected = `sha256=${await hmacHex(opts.secret, `${opts.timestamp}.${opts.rawBody}`)}`;
  return timingSafeEqual(expected, opts.signature);
}
