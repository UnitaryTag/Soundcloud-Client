import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { AppErrorCode } from '@shared/result'
import type { AuthStatus, UserSummary } from '@shared/sc'
import { AuthService, type AuthServiceDeps } from './auth'
import { TOKEN_ENDPOINT, type Credentials, type FetchLike } from './oauth'
import { challengeFor } from './pkce'
import { TokenManager, type StoredTokens, type TokenStore } from './tokens'

const CREDENTIALS: Credentials = { clientId: 'client-abc', clientSecret: 'shhh' }

const USER: UserSummary = {
  urn: 'soundcloud:users:1',
  username: 'Listener',
  permalinkUrl: 'https://soundcloud.com/listener',
  avatarUrl: null
}

const freePort = async (): Promise<number> => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const memoryStore = (initial: StoredTokens | null = null) => {
  let data = initial
  const impl: TokenStore & { peek: () => StoredTokens | null } = {
    load: async () => data,
    save: async (tokens) => {
      data = tokens
    },
    clear: async () => {
      data = null
    },
    peek: () => data
  }
  return impl
}

type Behavior = 'approve' | 'deny' | 'wrong-state' | 'ignore'

/**
 * Stands in for the system browser. Reads the authorize URL the service built
 * and drives a real HTTP request back to the loopback listener — which is
 * exactly what a browser redirect is, so nothing about the callback path is
 * faked.
 */
const browser = (behavior: Behavior) => {
  let authorizeUrl: URL | null = null

  const openExternal = async (url: string): Promise<void> => {
    authorizeUrl = new URL(url)
    if (behavior === 'ignore') return

    const redirectUri = authorizeUrl.searchParams.get('redirect_uri')
    const state = authorizeUrl.searchParams.get('state')
    if (redirectUri === null || state === null) throw new Error('authorize URL was incomplete')

    const query =
      behavior === 'deny'
        ? `?error=access_denied&state=${state}`
        : behavior === 'wrong-state'
          ? '?code=stolen&state=forged-state'
          : `?code=the-auth-code&state=${state}`

    await fetch(`${redirectUri}${query}`)
  }

  return { openExternal, url: () => authorizeUrl }
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const okTokens = (): Response =>
  json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })

type HarnessOptions = {
  behavior?: Behavior
  credentials?: Credentials | null
  store?: ReturnType<typeof memoryStore>
  tokenResponder?: () => Response
  fetchCurrentUser?: () => Promise<UserSummary>
  onChanged?: (status: AuthStatus) => void
  timeoutMs?: number
  port?: number
}

const buildService = async (options: HarnessOptions = {}) => {
  const store = options.store ?? memoryStore()
  const tokens = new TokenManager({
    store,
    exchange: async () => ({ accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 })
  })
  const browserMock = browser(options.behavior ?? 'approve')
  const port = options.port ?? (await freePort())
  const tokenRequests: URLSearchParams[] = []

  const fetchImpl: FetchLike = async (url, init) => {
    if (url !== TOKEN_ENDPOINT) throw new Error(`unexpected request to ${url}`)
    tokenRequests.push(new URLSearchParams(String(init?.body ?? '')))
    return (options.tokenResponder ?? okTokens)()
  }

  const deps: AuthServiceDeps = {
    getCredentials: () =>
      options.credentials === undefined ? CREDENTIALS : options.credentials,
    redirectPort: () => port,
    openExternal: browserMock.openExternal,
    fetchCurrentUser: options.fetchCurrentUser ?? (async () => USER),
    tokens,
    fetch: fetchImpl,
    ...(options.onChanged !== undefined ? { onChanged: options.onChanged } : {}),
    ...(options.timeoutMs !== undefined ? { relayTimeoutMs: options.timeoutMs } : {})
  }

  return {
    service: new AuthService(deps),
    deps,
    store,
    tokens,
    browser: browserMock,
    port,
    tokenRequests
  }
}

describe('begin — successful sign-in', () => {
  it('completes the flow and reports signed in', async () => {
    const { service, store } = await buildService()

    const result = await service.begin()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe('signed-in')
    if (result.value.state === 'signed-in') {
      expect(result.value.user).toEqual(USER)
      expect(result.value.expiresAt).toBeGreaterThan(Date.now())
    }
    expect(store.peek()?.refreshToken).toBe('rt-1')
  })

  it('presents a verifier whose S256 matches the challenge it advertised', async () => {
    // The end-to-end PKCE assertion. If the challenge sent to the authorize
    // endpoint and the verifier sent at exchange time ever drift, SoundCloud
    // rejects with an opaque invalid_grant and the cause is invisible.
    const { service, browser: browserMock, tokenRequests } = await buildService()

    await service.begin()

    const advertised = browserMock.url()?.searchParams.get('code_challenge')
    const verifier = tokenRequests[0]?.get('code_verifier')

    expect(advertised).toBeTruthy()
    expect(verifier).toBeTruthy()
    expect(challengeFor(verifier ?? '')).toBe(advertised)
  })

  it('never puts the verifier in the authorize URL', async () => {
    const { service, browser: browserMock, tokenRequests } = await buildService()

    await service.begin()

    const verifier = tokenRequests[0]?.get('code_verifier') ?? ''
    expect(browserMock.url()?.toString()).not.toContain(verifier)
  })

  it('sends the client secret when one is configured', async () => {
    const { service, tokenRequests } = await buildService()
    await service.begin()
    expect(tokenRequests[0]?.get('client_secret')).toBe('shhh')
  })

  it('omits the client secret entirely when none is configured', async () => {
    const { service, tokenRequests } = await buildService({ credentials: { clientId: 'abc' } })
    await service.begin()
    expect(tokenRequests[0]?.has('client_secret')).toBe(false)
  })

  it('notifies listeners of the state change', async () => {
    const seen: AuthStatus[] = []
    const { service } = await buildService({ onChanged: (status) => seen.push(status) })

    await service.begin()

    expect(seen.at(-1)?.state).toBe('signed-in')
  })
})

describe('begin — refusals', () => {
  it('reports a decline when the user denies access', async () => {
    const { service, store, tokenRequests } = await buildService({ behavior: 'deny' })

    const result = await service.begin()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AuthDenied)
    // A denial must never reach the token endpoint.
    expect(tokenRequests).toHaveLength(0)
    expect(store.peek()).toBeNull()
  })

  it('discards a callback carrying a forged state', async () => {
    const { service, store, tokenRequests } = await buildService({ behavior: 'wrong-state' })

    const result = await service.begin()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AuthDenied)
    expect(tokenRequests).toHaveLength(0)
    expect(store.peek()).toBeNull()
  })

  it('times out when the browser never comes back', async () => {
    const { service, store } = await buildService({ behavior: 'ignore', timeoutMs: 60 })

    const result = await service.begin()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AuthTimeout)
    expect(store.peek()).toBeNull()
  })

  it('refuses to start without credentials', async () => {
    const { service } = await buildService({ credentials: null })

    const result = await service.begin()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.NoCredentials)
  })

  it('rejects a second concurrent sign-in instead of opening another tab', async () => {
    const { service } = await buildService({ behavior: 'ignore', timeoutMs: 60 })

    const results = await Promise.all([service.begin(), service.begin()])

    const inProgress = results.filter(
      (r) => !r.ok && r.error.code === AppErrorCode.AuthInProgress
    )
    expect(inProgress).toHaveLength(1)
  })

  it('reports a rejected authorization code', async () => {
    const { service, store } = await buildService({
      tokenResponder: () => json(400, { error: 'invalid_grant' })
    })

    const result = await service.begin()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AuthDenied)
    expect(store.peek()).toBeNull()
  })

  it('reports bad app credentials distinctly from a dead code', async () => {
    const { service } = await buildService({
      tokenResponder: () => json(400, { error: 'invalid_client' })
    })

    const result = await service.begin()

    expect(result.ok).toBe(false)
    // Misconfigured app credentials — the user should check their client id and
    // secret, not retry a login that will keep failing.
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.NoCredentials)
  })
})

describe('begin — resource cleanup', () => {
  it('releases the callback port after a failed attempt', async () => {
    const port = await freePort()
    const first = await buildService({ behavior: 'deny', port })
    await first.service.begin()

    // Binding the same port again proves the listener was released on the error
    // path — a leak here would block every later sign-in attempt.
    const second = await buildService({ behavior: 'deny', port })
    const result = await second.service.begin()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AuthDenied)
  })

  it('allows a retry that succeeds after a failure', async () => {
    const port = await freePort()
    const store = memoryStore()
    const shared = { port, store }

    const denied = await buildService({ ...shared, behavior: 'deny' })
    expect((await denied.service.begin()).ok).toBe(false)

    const approved = await buildService({ ...shared, behavior: 'approve' })
    expect((await approved.service.begin()).ok).toBe(true)
    expect(store.peek()?.refreshToken).toBe('rt-1')
  })
})

describe('cancel', () => {
  /**
   * `begin()` binds the listener asynchronously, so there is a window where a
   * sign-in is running but not yet cancellable. Polling cancel until it takes
   * is deterministic where a fixed sleep would be a guess.
   */
  const cancelOncePending = async (service: AuthService): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await service.cancel()).ok) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('sign-in never became cancellable')
  }

  it('settles a pending sign-in instead of leaving it hanging', async () => {
    const { service } = await buildService({ behavior: 'ignore' })
    const pending = service.begin()

    await cancelOncePending(service)

    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AuthDenied)
  })

  it('stores nothing when the sign-in was cancelled', async () => {
    const { service, store } = await buildService({ behavior: 'ignore' })
    const pending = service.begin()
    await cancelOncePending(service)
    await pending

    expect(store.peek()).toBeNull()
  })

  it('releases the port so a retry can start immediately', async () => {
    // The bug this exists for: without cancel, an abandoned sign-in holds the
    // callback port until the five-minute timeout, so the next attempt fails
    // with EADDRINUSE.
    const port = await freePort()
    const abandoned = await buildService({ behavior: 'ignore', port })
    const pending = abandoned.service.begin()
    await cancelOncePending(abandoned.service)
    await pending

    const retry = await buildService({ behavior: 'approve', port })
    const result = await retry.service.begin()

    expect(result.ok).toBe(true)
  })

  it('reports InvalidRequest when nothing is in progress', async () => {
    const { service } = await buildService()
    const result = await service.cancel()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.InvalidRequest)
  })

  it('does not disturb a completed sign-in', async () => {
    const { service, store } = await buildService({ behavior: 'approve' })
    await service.begin()

    // Nothing is pending now, so this must not clear the session.
    await service.cancel()

    expect(store.peek()).not.toBeNull()
    expect(service.status().state).toBe('signed-in')
  })
})

describe('restore', () => {
  const storedSession = (clientId = CREDENTIALS.clientId): StoredTokens => ({
    refreshToken: 'rt-1',
    accessToken: 'at-1',
    expiresAt: Date.now() + 3_600_000,
    clientId
  })

  it('reports signed out when nothing is stored', async () => {
    const { service } = await buildService()
    expect(await service.restore()).toEqual({ state: 'signed-out' })
  })

  it('restores a persisted session and loads the user', async () => {
    const { service } = await buildService({ store: memoryStore(storedSession()) })

    const status = await service.restore()

    expect(status.state).toBe('signed-in')
    if (status.state === 'signed-in') expect(status.user).toEqual(USER)
  })

  it('stays signed in when the user cannot be fetched', async () => {
    // Offline at launch. The tokens are still valid, so reporting signed-out
    // would throw away a working session over a network blip.
    const { service } = await buildService({
      store: memoryStore(storedSession()),
      fetchCurrentUser: async () => {
        throw new Error('offline')
      }
    })

    const status = await service.restore()

    expect(status.state).toBe('signed-in')
    if (status.state === 'signed-in') expect(status.user).toBeNull()
  })

  it('discards a session stored for a different client id', async () => {
    const { service, store } = await buildService({
      store: memoryStore(storedSession('some-other-client'))
    })

    expect(await service.restore()).toEqual({ state: 'signed-out' })
    expect(store.peek()).toBeNull()
  })

  it('reports signed out when there are no credentials at all', async () => {
    const { service } = await buildService({
      store: memoryStore(storedSession()),
      credentials: null
    })
    expect(await service.restore()).toEqual({ state: 'signed-out' })
  })
})

describe('signOut', () => {
  it('clears the session and reports signed out', async () => {
    const { service, store } = await buildService()
    await service.begin()
    expect(store.peek()).not.toBeNull()

    const status = await service.signOut()

    expect(status).toEqual({ state: 'signed-out' })
    expect(store.peek()).toBeNull()
    expect(service.status()).toEqual({ state: 'signed-out' })
  })
})
