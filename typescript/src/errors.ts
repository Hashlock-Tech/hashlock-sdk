/** Thrown for any non-2xx API response. Carries the HTTP status and the server's error message. */
export class HashlockError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Present on 429 — seconds until the rate-limit window resets. */
  readonly retryAfter?: number;

  constructor(status: number, message: string, body?: unknown, retryAfter?: number) {
    super(message);
    this.name = 'HashlockError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}
