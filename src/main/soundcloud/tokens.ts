import { log } from '../logger'

/**
 * Access-token lifecycle.
 *
 * The single most important rule here: **refresh tokens are single-use.** Every
 * refresh returns a new one, and the old one is dead. Two concurrent refreshes
 * with the same token means one of them burns the session and the user is
 * silently signed out. Hence every refresh goes through one shared in-flight
 * promise.
 *
 * Electron-free by construction — persistence is injected — so this is testable
 * in plain Node. The `safeStorage` implementation lives in token-store.ts.
 */

/** Refresh this long before actual expiry, to absorb clock skew and request latency. */
export const ACCESS_TOKEN_SKEW_MS = 60_000

export type StoredTokens = {
  refreshToken: string
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
  /** The client_id that issued this refresh token. See the mismatch check below. */
  clientId: string
}

export type TokenStore = {
  load: () => Promise<StoredTokens | null>
  save: (tokens: StoredTokens) => Promise<void>
  clear: () => Promise<void>
}

export type RefreshedTokens = {
  accessToken: string
  refreshToken: string
  /** Seconds, as returned by the token endpoint. */
  expiresIn: number
}

/** Throws when the refresh token is dead — revoked, expired, or already used. */
export type RefreshExchange = (refreshToken: string) => Promise<RefreshedTokens>

/**
 * The refresh token will never work again. Sign the user out; do not retry,
 * because retrying a burned single-use token can only fail.
 */
export class RefreshRejected extends Error {
  constructor(message = 'The refresh token was rejected. Sign in again.') {
    super(message)
    this.name = 'RefreshRejected'
  }
}

export class NotSignedIn extends Error {
  constructor(message = 'Not signed in.') {
    super(message)
    this.name = 'NotSignedIn'
  }
}

export type TokenManagerDeps = {
  store: TokenStore
  exchange: RefreshExchange
  now?: () => number
}

export class TokenManager {
  private current: StoredTokens | null = null
  private inFlight: Promise<StoredTokens> | null = null

  constructor(private readonly deps: TokenManagerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private isFresh(tokens: StoredTokens | null, clientId: string): tokens is StoredTokens {
    if (tokens === null || tokens.clientId !== clientId) return false
    return tokens.expiresAt - ACCESS_TOKEN_SKEW_MS > this.now()
  }

  /**
   * Load persisted tokens at startup.
   *
   * Returns null — and clears the store — when the stored tokens were issued by
   * a different client_id. That happens when the user switches to their own
   * credentials: the old refresh token can never be redeemed against the new
   * client, and a guaranteed-to-fail refresh is worse than a clean sign-out.
   */
  async restore(clientId: string): Promise<StoredTokens | null> {
    const stored = await this.deps.store.load()
    if (stored === null) {
      this.current = null
      return null
    }
    if (stored.clientId !== clientId) {
      log.warn('stored tokens belong to a different client_id; discarding them')
      this.current = null
      await this.deps.store.clear()
      return null
    }
    this.current = stored
    return stored
  }

  /** Adopt a freshly exchanged token set, as returned by the authorization-code flow. */
  async adopt(tokens: StoredTokens): Promise<void> {
    this.current = tokens
    await this.deps.store.save(tokens)
  }

  hasSession(): boolean {
    return this.current !== null
  }

  /** Read-only view of the current token set, for reporting auth state. */
  snapshot(): StoredTokens | null {
    return this.current
  }

  /**
   * Mark the current access token unusable so the next call refreshes.
   *
   * Used when the API returns 401 despite the token looking unexpired on our
   * clock — the server is authoritative about its own tokens, and a revoke or a
   * clock skew would otherwise leave us retrying a token it has already
   * rejected. Deliberately does not refresh immediately: the next
   * `getAccessToken` will, and it will be single-flighted with any other caller.
   */
  invalidate(): void {
    if (this.current !== null) {
      this.current = { ...this.current, expiresAt: 0 }
    }
  }

  async signOut(): Promise<void> {
    this.current = null
    this.inFlight = null
    await this.deps.store.clear()
  }

  /**
   * Returns a usable access token, refreshing first if the current one is
   * expired or close to it.
   *
   * Concurrent callers share a single refresh. This is the whole point of the
   * class: without it, two in-flight API calls after expiry would each spend the
   * same single-use refresh token.
   */
  async getAccessToken(clientId: string): Promise<string> {
    if (this.isFresh(this.current, clientId)) {
      return this.current.accessToken
    }

    if (this.inFlight === null) {
      this.inFlight = this.refresh(clientId).finally(() => {
        // Cleared by whoever created it, so a later caller starts a fresh
        // refresh rather than awaiting an already-settled promise.
        this.inFlight = null
      })
    }

    return (await this.inFlight).accessToken
  }

  private async refresh(clientId: string): Promise<StoredTokens> {
    const current = this.current
    if (current === null) throw new NotSignedIn()
    if (current.clientId !== clientId) {
      await this.signOut()
      throw new NotSignedIn('Credentials changed since sign-in. Sign in again.')
    }

    let refreshed: RefreshedTokens
    try {
      refreshed = await this.deps.exchange(current.refreshToken)
    } catch (cause) {
      if (cause instanceof RefreshRejected) {
        // Dead token: drop everything and make the UI show a signed-out state.
        await this.signOut()
      }
      throw cause
    }

    const next: StoredTokens = {
      // Rotation: always the new token. The one we just spent is now dead.
      refreshToken: refreshed.refreshToken,
      accessToken: refreshed.accessToken,
      expiresAt: this.now() + refreshed.expiresIn * 1000,
      clientId
    }
    this.current = next

    try {
      await this.deps.store.save(next)
    } catch (cause) {
      // The session is still usable in memory, but the rotated token did not
      // reach disk. Once this process exits, the stored token is the spent one
      // and sign-in will be required. Surfacing it beats failing silently.
      log.error('rotated refresh token could not be persisted:', cause)
    }

    return next
  }
}
