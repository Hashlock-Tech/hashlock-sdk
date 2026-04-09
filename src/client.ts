import type { HashLockConfig } from './types.js';
import { GraphQLError, NetworkError, AuthError } from './errors.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const RETRY_DELAY_BASE = 1000;

interface GQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

/**
 * Low-level GraphQL client with retry logic, timeout, and error normalization.
 * Used internally by all SDK methods — not exported to consumers.
 */
export class GraphQLClient {
  private endpoint: string;
  private accessToken: string | undefined;
  private timeout: number;
  private retries: number;
  private fetchFn: typeof fetch;

  constructor(config: HashLockConfig) {
    this.endpoint = config.endpoint;
    this.accessToken = config.accessToken;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.fetchFn = config.fetch ?? globalThis.fetch;

    if (!this.fetchFn) {
      throw new Error('fetch is not available — pass a custom fetch implementation or use Node.js >= 18');
    }
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Execute a GraphQL query with automatic retries on transient failures.
   * Retries on: network errors, 5xx status codes.
   * Does NOT retry on: 4xx errors, GraphQL validation errors.
   */
  async query<T>(
    query: string,
    variables?: Record<string, unknown> | object,
  ): Promise<T> {
    return this.execute<T>(query, variables, true);
  }

  /**
   * Execute a GraphQL mutation.
   * Only retries on network errors (not on 5xx — mutations are not idempotent).
   */
  async mutate<T>(
    query: string,
    variables?: Record<string, unknown> | object,
  ): Promise<T> {
    return this.execute<T>(query, variables, false);
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    retryOn5xx: boolean,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        };

        if (this.accessToken) {
          headers['Authorization'] = `Bearer ${this.accessToken}`;
        }

        const response = await this.fetchFn(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        // Auth errors — don't retry
        if (response.status === 401 || response.status === 403) {
          throw new AuthError(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Server errors — retry only for queries
        if (response.status >= 500) {
          const msg = `Server error: HTTP ${response.status}`;
          if (retryOn5xx && attempt < this.retries) {
            lastError = new NetworkError(msg);
            await this.delay(attempt);
            continue;
          }
          throw new NetworkError(msg);
        }

        const json = (await response.json()) as GQLResponse<T>;

        // GraphQL errors
        if (json.errors?.length) {
          throw new GraphQLError(
            json.errors[0].message,
            json.errors,
          );
        }

        if (!json.data) {
          throw new GraphQLError('No data returned', [{ message: 'Empty response' }]);
        }

        return json.data;
      } catch (err) {
        if (err instanceof AuthError || err instanceof GraphQLError) {
          throw err;
        }

        // Network/timeout errors — retry
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        const isNetwork = err instanceof TypeError; // fetch network failure

        if ((isAbort || isNetwork) && attempt < this.retries) {
          lastError = err instanceof Error ? err : new Error(String(err));
          await this.delay(attempt);
          continue;
        }

        if (err instanceof NetworkError) throw err;

        throw new NetworkError(
          isAbort ? 'Request timed out' : `Network error: ${err instanceof Error ? err.message : err}`,
          err instanceof Error ? err : undefined,
        );
      }
    }

    throw lastError ?? new NetworkError('Request failed after all retries');
  }

  private delay(attempt: number): Promise<void> {
    const ms = RETRY_DELAY_BASE * Math.pow(2, attempt);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
