import { AppErrorCode, err, ok, type Result } from '@shared/result'
import type { AuthStatus, UserSummary } from '@shared/sc'
import { log } from '../logger'
import { startLoopback } from './loopback'
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  TokenRequestFailed,
  type Credentials,
  type FetchLike
} from './oauth'
import { RefreshRejected, TokenManager } from './tokens'

/**
 * The sign-in flow, start to finish.
 *
 * Everything with a side effect is injected — opening the browser, the port to
 * bind, fetching the current user — so the whole flow can be driven in a test
 * without a browser or a SoundCloud account.
 *
 * The flow, in order, and the order matters:
 *   1. bind the callback listener  (before the browser opens, or a fast
 *      redirect can arrive at a port nobody is listening on)
 *   2. open the system browser      (external user-agent per RFC 8252 — never
 *      an embedded window, which would expose the user's SoundCloud password
 *      to this app and is explicitly forbidden)
 *   3. await the callback
 *   4. exchange the code, with the verifier that never left this process
 *   5. adopt the tokens, then fetch who we are
 */

export type AuthServiceDeps = {
  /** Resolved credentials, or null when none are configured. */
  getCredentials: () => Credentials | null
  /** The port the redirect URI is registered against. */
  redirectPort: () => number
  /** Opens a URL in the system browser. Rejects if it cannot. */
  openExternal: (url: string) => Promise<void>
  /** Fetches the signed-in user. Only called once tokens are in hand. */
  fetchCurrentUser: () => Promise<UserSummary>
  tokens: TokenManager
  /** Called whenever the auth state changes, including from sign-out and expiry. */
  onChanged?: (status: AuthStatus) => void
  relayTimeoutMs?: number
  fetch?: FetchLike
}

export class AuthService {
  private user: UserSummary | null = null
  private starting = false

  constructor(private readonly deps: AuthServiceDeps) {}

  status(): AuthStatus {
    const snapshot = this.deps.tokens.snapshot()
    if (snapshot === null) return { state: 'signed-out' }
    return { state: 'signed-in', user: this.user, expiresAt: snapshot.expiresAt }
  }

  private publish(): AuthStatus {
    const status = this.status()
    this.deps.onChanged?.(status)
    return status
  }

  /**
   * Load any persisted session at startup.
   *
   * A failure to fetch the user is not a failure to restore: the tokens are
   * still valid, we just do not know who they belong to yet. Reporting
   * signed-out because the network is down would be wrong, and it would discard
   * a working session.
   */
  async restore(): Promise<AuthStatus> {
    const credentials = this.deps.getCredentials()
    if (credentials === null) {
      this.user = null
      return this.publish()
    }

    const restored = await this.deps.tokens.restore(credentials.clientId)
    if (restored === null) {
      this.user = null
      return this.publish()
    }

    try {
      this.user = await this.deps.fetchCurrentUser()
    } catch (cause) {
      log.warn('signed in, but could not load the current user:', cause)
      this.user = null
    }
    return this.publish()
  }

  /**
   * Run the interactive sign-in flow.
   *
   * Single-flight: a second call while one is pending returns AuthInProgress
   * rather than opening a second browser tab or rebinding the port.
   */
  async begin(): Promise<Result<AuthStatus>> {
    if (this.starting) {
      return err(AppErrorCode.AuthInProgress, 'A sign-in is already in progress.')
    }

    const credentials = this.deps.getCredentials()
    if (credentials === null) {
      return err(
        AppErrorCode.NoCredentials,
        'No SoundCloud credentials are configured. Add a client id and secret, or bundle them at build time.'
      )
    }

    this.starting = true
    let session: Awaited<ReturnType<typeof startLoopback>> | null = null
    try {
      session = await startLoopback({
        port: this.deps.redirectPort(),
        timeoutMs: this.deps.relayTimeoutMs
      })

      const authorizeUrl = buildAuthorizeUrl({
        credentials,
        redirectUri: session.redirectUri,
        flow: session.flow
      })

      // Only our own constructed URL reaches openExternal — never anything
      // renderer-supplied.
      await this.deps.openExternal(authorizeUrl)

      const outcome = await session.outcome
      if (!outcome.ok) {
        return err(...explain(outcome.reason))
      }

      let exchanged
      try {
        exchanged = await exchangeAuthorizationCode(
          {
            credentials,
            redirectUri: session.redirectUri,
            code: outcome.code,
            verifier: session.flow.verifier
          },
          { fetch: this.deps.fetch }
        )
      } catch (cause) {
        if (cause instanceof RefreshRejected) {
          return err(AppErrorCode.AuthDenied, 'SoundCloud rejected the authorization code.')
        }
        if (cause instanceof TokenRequestFailed) {
          return err(
            cause.status === 401 || cause.oauthError === 'invalid_client'
              ? AppErrorCode.NoCredentials
              : AppErrorCode.NetworkError,
            cause.message
          )
        }
        throw cause
      }

      await this.deps.tokens.adopt({
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        expiresAt: Date.now() + exchanged.expiresIn * 1000,
        clientId: credentials.clientId
      })

      try {
        this.user = await this.deps.fetchCurrentUser()
      } catch (cause) {
        // Tokens are good; we just could not read the profile. Not worth
        // failing a completed sign-in over.
        log.warn('signed in, but could not load the current user:', cause)
        this.user = null
      }

      return ok(this.publish())
    } finally {
      this.starting = false
      // Releases the port on every path, including the error ones. A leaked
      // listener here would block every later sign-in attempt.
      await session?.close()
    }
  }

  async signOut(): Promise<AuthStatus> {
    await this.deps.tokens.signOut()
    this.user = null
    return this.publish()
  }
}

const explain = (reason: string): [AppErrorCode, string] => {
  switch (reason) {
    case 'denied':
      return [AppErrorCode.AuthDenied, 'Sign-in was declined.']
    case 'timeout':
      return [AppErrorCode.AuthTimeout, 'Sign-in timed out. Try again.']
    case 'state_mismatch':
      return [
        AppErrorCode.AuthDenied,
        'The sign-in response could not be verified and was discarded.'
      ]
    case 'cancelled':
      return [AppErrorCode.AuthDenied, 'Sign-in was cancelled.']
    default:
      return [AppErrorCode.Unknown, 'Sign-in did not complete.']
  }
}
