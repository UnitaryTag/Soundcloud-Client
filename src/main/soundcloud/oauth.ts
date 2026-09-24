import { log } from '../logger'
import type { PkceFlow } from './pkce'
import { RefreshRejected, type RefreshedTokens } from './tokens'

/**
 * The OAuth 2.1 + PKCE exchange.
 *
 * Uses Node's global `fetch` rather than Electron's `net.fetch`: these calls
 * carry no cookies and need no Chromium session, and keeping them entirely
 * outside Chromium means the token exchange can never touch its disk cache.
 * (`net.fetch` is reserved for media, where the `{cache: false}` partition
 * actually matters.)
 *
 * `fetch` is injected so the whole module is testable against a mock endpoint.
 */

export const AUTHORIZE_ENDPOINT = 'https://secure.soundcloud.com/authorize'
export const TOKEN_ENDPOINT = 'https://secure.soundcloud.com/oauth/token'

export type Credentials = {
  clientId: string
  /**
   * Omitted from the request entirely when absent — not sent as an empty
   * string. SoundCloud currently treats every client as confidential and
   * requires this, but if an app is ever marked public the request has to go
   * out without the parameter at all, and that must not require a code change.
   */
  clientSecret?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type OAuthDeps = {
  fetch?: FetchLike
}

/** A token request that failed for a reason other than the grant being dead. */
export class TokenRequestFailed extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly oauthError?: string
  ) {
    super(message)
    this.name = 'TokenRequestFailed'
  }
}

export type AuthorizeUrlOptions = {
  credentials: Credentials
  redirectUri: string
  flow: PkceFlow
  /**
   * Left off by default. SoundCloud's OpenAPI spec marks `scope` as required
   * with the description "leave blank by default", which is ambiguous — it is
   * not verified whether the parameter must be present-but-empty or omitted.
   * Set it explicitly if authorization fails on scope.
   */
  scope?: string
}

export const buildAuthorizeUrl = (options: AuthorizeUrlOptions): string => {
  const url = new URL(AUTHORIZE_ENDPOINT)
  url.searchParams.set('client_id', options.credentials.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('code_challenge', options.flow.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', options.flow.state)
  if (options.scope !== undefined) {
    url.searchParams.set('scope', options.scope)
  }
  return url.toString()
}

const resolveFetch = (deps: OAuthDeps): FetchLike => deps.fetch ?? ((input, init) => fetch(input, init))

/**
 * Post a form-encoded token request and normalise the response.
 *
 * Error mapping is the interesting part:
 *  - `invalid_grant` means the code or refresh token is dead. That is a
 *    permanent condition, so it becomes `RefreshRejected` and the caller signs
 *    the user out rather than retrying.
 *  - `invalid_client` means our own credentials are wrong. Retrying cannot
 *    help, but it is not the user's session that is broken, so it stays a
 *    `TokenRequestFailed` and surfaces as a configuration error.
 */
const postToken = async (
  deps: OAuthDeps,
  body: URLSearchParams
): Promise<RefreshedTokens> => {
  let response: Response
  try {
    response = await resolveFetch(deps)(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: body.toString()
    })
  } catch (cause) {
    // A network failure is transient and says nothing about the grant, so it
    // must not be mistaken for a dead token.
    throw new TokenRequestFailed(
      `Could not reach the token endpoint: ${cause instanceof Error ? cause.message : String(cause)}`,
      0
    )
  }

  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  } catch {
    throw new TokenRequestFailed(
      `Token endpoint returned a non-JSON response (HTTP ${response.status}).`,
      response.status
    )
  }

  const oauthError = typeof payload['error'] === 'string' ? payload['error'] : undefined

  if (!response.ok) {
    // The description is server-supplied, so it is logged but never rendered.
    const description =
      typeof payload['error_description'] === 'string' ? payload['error_description'] : undefined
    log.warn(`token request failed: HTTP ${response.status} ${oauthError ?? ''} ${description ?? ''}`)

    if (oauthError === 'invalid_grant' || response.status === 401) {
      throw new RefreshRejected(
        'SoundCloud rejected the grant. It may have expired, been revoked, or already been used.'
      )
    }
    throw new TokenRequestFailed(
      oauthError === undefined
        ? `Token request failed with HTTP ${response.status}.`
        : `Token request failed: ${oauthError}.`,
      response.status,
      oauthError
    )
  }

  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = payload

  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new TokenRequestFailed(
      'Token endpoint response was missing access_token, refresh_token, or expires_in.',
      response.status
    )
  }

  return { accessToken, refreshToken, expiresIn }
}

export const exchangeAuthorizationCode = async (
  options: {
    credentials: Credentials
    redirectUri: string
    code: string
    verifier: string
  },
  deps: OAuthDeps = {}
): Promise<RefreshedTokens> => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    code_verifier: options.verifier,
    client_id: options.credentials.clientId,
    redirect_uri: options.redirectUri
  })
  if (options.credentials.clientSecret !== undefined) {
    body.set('client_secret', options.credentials.clientSecret)
  }
  return postToken(deps, body)
}

/**
 * Spend a refresh token to get a new token set.
 *
 * Single-use: the returned `refreshToken` replaces the one passed in, and the
 * old one is dead. Callers must persist the replacement — see TokenManager,
 * which also guarantees this is never called concurrently for the same token.
 */
export const exchangeRefreshToken = async (
  refreshToken: string,
  credentials: Credentials,
  deps: OAuthDeps = {}
): Promise<RefreshedTokens> => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: credentials.clientId
  })
  if (credentials.clientSecret !== undefined) {
    body.set('client_secret', credentials.clientSecret)
  }
  return postToken(deps, body)
}
