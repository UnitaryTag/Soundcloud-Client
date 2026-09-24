import { describe, expect, it } from 'vitest'
import {
  AUTHORIZE_ENDPOINT,
  TOKEN_ENDPOINT,
  TokenRequestFailed,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  type FetchLike
} from './oauth'
import type { PkceFlow } from './pkce'
import { RefreshRejected } from './tokens'

const FLOW: PkceFlow = {
  verifier: 'the-verifier-must-never-leave-the-app',
  challenge: 'CHALLENGE-VALUE',
  state: 'STATE-VALUE'
}

const REDIRECT = 'http://127.0.0.1:8765/callback'

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const goodTokens = {
  access_token: 'at-new',
  refresh_token: 'rt-new',
  expires_in: 3600,
  scope: '*'
}

const mockFetch = (responder: () => Response | Promise<Response>) => {
  const calls: Array<{ url: string; body: URLSearchParams }> = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? '')) })
    return responder()
  }
  return { impl, calls }
}

describe('buildAuthorizeUrl', () => {
  const url = (): URL =>
    new URL(
      buildAuthorizeUrl({
        credentials: { clientId: 'cid' },
        redirectUri: REDIRECT,
        flow: FLOW
      })
    )

  it('targets the SoundCloud authorization endpoint', () => {
    expect(`${url().origin}${url().pathname}`).toBe(AUTHORIZE_ENDPOINT)
  })

  it('carries every parameter the PKCE flow requires', () => {
    expect(url().searchParams.get('client_id')).toBe('cid')
    expect(url().searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url().searchParams.get('response_type')).toBe('code')
    expect(url().searchParams.get('code_challenge')).toBe('CHALLENGE-VALUE')
    expect(url().searchParams.get('code_challenge_method')).toBe('S256')
    expect(url().searchParams.get('state')).toBe('STATE-VALUE')
  })

  it('never puts the code verifier in the URL', () => {
    // The whole point of PKCE. The verifier is presented only at token-exchange
    // time; leaking it here would defeat the mechanism entirely.
    expect(url().toString()).not.toContain(FLOW.verifier)
  })

  it('omits scope by default', () => {
    expect(url().searchParams.has('scope')).toBe(false)
  })

  it('includes scope when explicitly provided', () => {
    const withScope = new URL(
      buildAuthorizeUrl({
        credentials: { clientId: 'cid' },
        redirectUri: REDIRECT,
        flow: FLOW,
        scope: 'non-expiring'
      })
    )
    expect(withScope.searchParams.get('scope')).toBe('non-expiring')
  })

  it('never includes the client secret', () => {
    const withSecret = new URL(
      buildAuthorizeUrl({
        credentials: { clientId: 'cid', clientSecret: 'shhh' },
        redirectUri: REDIRECT,
        flow: FLOW
      })
    )
    expect(withSecret.toString()).not.toContain('shhh')
    expect(withSecret.searchParams.has('client_secret')).toBe(false)
  })
})

describe('exchangeAuthorizationCode', () => {
  const call = async (
    credentials: { clientId: string; clientSecret?: string },
    responder: () => Response
  ) => {
    const { impl, calls } = mockFetch(responder)
    const result = await exchangeAuthorizationCode(
      { credentials, redirectUri: REDIRECT, code: 'the-code', verifier: FLOW.verifier },
      { fetch: impl }
    )
    return { result, call: calls[0] }
  }

  it('posts to the token endpoint with an authorization_code grant', async () => {
    const { call: posted } = await call({ clientId: 'cid' }, () => json(200, goodTokens))
    expect(posted.url).toBe(TOKEN_ENDPOINT)
    expect(posted.body.get('grant_type')).toBe('authorization_code')
    expect(posted.body.get('code')).toBe('the-code')
    expect(posted.body.get('code_verifier')).toBe(FLOW.verifier)
    expect(posted.body.get('client_id')).toBe('cid')
    expect(posted.body.get('redirect_uri')).toBe(REDIRECT)
  })

  it('omits client_secret ENTIRELY when none is configured', async () => {
    // Not an empty string, not the literal "undefined" — the parameter must be
    // absent, so a public-client app keeps working with no code change.
    const { call: posted } = await call({ clientId: 'cid' }, () => json(200, goodTokens))
    expect(posted.body.has('client_secret')).toBe(false)
  })

  it('includes client_secret when one is configured', async () => {
    const { call: posted } = await call(
      { clientId: 'cid', clientSecret: 'shhh' },
      () => json(200, goodTokens)
    )
    expect(posted.body.get('client_secret')).toBe('shhh')
  })

  it('returns the parsed token set', async () => {
    const { result } = await call({ clientId: 'cid' }, () => json(200, goodTokens))
    expect(result).toEqual({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 3600 })
  })
})

describe('exchangeRefreshToken', () => {
  it('posts a refresh_token grant', async () => {
    const { impl, calls } = mockFetch(() => json(200, goodTokens))
    await exchangeRefreshToken('rt-old', { clientId: 'cid' }, { fetch: impl })

    expect(calls[0].body.get('grant_type')).toBe('refresh_token')
    expect(calls[0].body.get('refresh_token')).toBe('rt-old')
    expect(calls[0].body.get('client_id')).toBe('cid')
  })

  it('omits client_secret entirely when none is configured', async () => {
    const { impl, calls } = mockFetch(() => json(200, goodTokens))
    await exchangeRefreshToken('rt-old', { clientId: 'cid' }, { fetch: impl })
    expect(calls[0].body.has('client_secret')).toBe(false)
  })

  it('returns the ROTATED token, which differs from the one spent', async () => {
    const { impl } = mockFetch(() => json(200, goodTokens))
    const result = await exchangeRefreshToken('rt-old', { clientId: 'cid' }, { fetch: impl })
    expect(result.refreshToken).toBe('rt-new')
  })
})

describe('error mapping', () => {
  const expectFailure = async (
    responder: () => Response,
    grant: 'code' | 'refresh' = 'refresh'
  ): Promise<unknown> => {
    const { impl } = mockFetch(responder)
    const run =
      grant === 'refresh'
        ? exchangeRefreshToken('rt', { clientId: 'cid' }, { fetch: impl })
        : exchangeAuthorizationCode(
            { credentials: { clientId: 'cid' }, redirectUri: REDIRECT, code: 'c', verifier: 'v' },
            { fetch: impl }
          )
    return run.then(
      () => {
        throw new Error('expected the request to reject')
      },
      (error: unknown) => error
    )
  }

  it('treats invalid_grant as a dead token', async () => {
    const error = await expectFailure(() => json(400, { error: 'invalid_grant' }))
    expect(error).toBeInstanceOf(RefreshRejected)
  })

  it('treats a 401 as a dead token even without an error body', async () => {
    const error = await expectFailure(() => json(401, {}))
    expect(error).toBeInstanceOf(RefreshRejected)
  })

  it('treats invalid_client as a configuration failure, NOT a dead session', async () => {
    // Retrying cannot help, but the user's session is not what is broken — this
    // must surface as a credentials problem rather than signing them out.
    const error = await expectFailure(() => json(400, { error: 'invalid_client' }))
    expect(error).toBeInstanceOf(TokenRequestFailed)
    expect(error).not.toBeInstanceOf(RefreshRejected)
    expect((error as TokenRequestFailed).oauthError).toBe('invalid_client')
  })

  it('treats a network failure as transient, not as a dead token', async () => {
    // Getting this wrong signs the user out on a dropped connection.
    const impl: FetchLike = async () => {
      throw new Error('ECONNRESET')
    }
    const error = await exchangeRefreshToken('rt', { clientId: 'cid' }, { fetch: impl }).then(
      () => {
        throw new Error('expected rejection')
      },
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(TokenRequestFailed)
    expect(error).not.toBeInstanceOf(RefreshRejected)
  })

  it('rejects a non-JSON response body', async () => {
    const error = await expectFailure(() => new Response('<html>502</html>', { status: 502 }))
    expect(error).toBeInstanceOf(TokenRequestFailed)
  })

  it('rejects a 200 response missing required fields', async () => {
    const error = await expectFailure(() => json(200, { access_token: 'only-this' }))
    expect(error).toBeInstanceOf(TokenRequestFailed)
    expect((error as Error).message).toMatch(/missing/i)
  })

  it('rejects a 200 response with wrongly-typed fields', async () => {
    const error = await expectFailure(() =>
      json(200, { access_token: 'a', refresh_token: 'r', expires_in: '3600' })
    )
    expect(error).toBeInstanceOf(TokenRequestFailed)
  })

  it('does not fold a server error into a sign-out', async () => {
    const error = await expectFailure(() => json(503, { error: 'temporarily_unavailable' }))
    expect(error).not.toBeInstanceOf(RefreshRejected)
  })
})
