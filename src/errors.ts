/**
 * Base error class for all HashLock SDK errors.
 */
export class HashLockError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HashLockError';
  }
}

/**
 * GraphQL returned errors in the response.
 */
export class GraphQLError extends HashLockError {
  constructor(
    message: string,
    public readonly errors: Array<{ message: string; path?: string[] }>,
  ) {
    super(message, 'GRAPHQL_ERROR', errors);
    this.name = 'GraphQLError';
  }
}

/**
 * Network-level error (timeout, DNS failure, etc.).
 */
export class NetworkError extends HashLockError {
  constructor(message: string, public readonly cause?: Error) {
    super(message, 'NETWORK_ERROR', cause);
    this.name = 'NetworkError';
  }
}

/**
 * Authentication error — token missing or expired.
 */
export class AuthError extends HashLockError {
  constructor(message: string = 'Authentication required — set accessToken in config or call setAccessToken()') {
    super(message, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}
