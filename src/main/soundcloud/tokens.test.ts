import { describe, expect, it, vi } from 'vitest'
import {
  ACCESS_TOKEN_SKEW_MS,
  NotSignedIn,
  RefreshRejected,
  TokenManager,
  type RefreshExchange,
  type RefreshedTokens,
  type StoredTokens,
  type TokenStore
} from './tokens'

const CLIENT = 'client-abc'
const OTHER_CLIENT = 'client-xyz'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const store = (initial: StoredTokens | null = null) => {
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

const tokensAt = (expiresAt: number, overrides: Partial<StoredTokens> = {}): StoredTokens => ({
  refreshToken: 'rt-old',
  accessToken: 'at-old',
  expiresAt,
  clientId: CLIENT,
  ...overrides
})

const refreshReturns = (
  impl: (call: number) => Promise<RefreshedTokens>
): { exchange: RefreshExchange; calls: () => number } => {
  let calls = 0
  return {
    exchange: async () => {
      calls += 1
      return impl(calls)
    },
    calls: () => calls
  }
}

const ok = (n: number): RefreshedTokens => ({
  accessToken: `at-${n}`,
  refreshToken: `rt-${n}`,
  expiresIn: 3600
})

const manager = (
  parts: { store: TokenStore; exchange: RefreshExchange; now: () => number }
): TokenManager => new TokenManager(parts)

describe('getAccessToken — caching', () => {
  it('returns the cached token without refreshing while it is comfortably fresh', async () => {
    let now = 1_000_000
    const { exchange, calls } = refreshReturns(async (n) => ok(n))
    const m = manager({ store: store(tokensAt(now + 3600_000)), exchange, now: () => now })
    await m.restore(CLIENT)

    expect(await m.getAccessToken(CLIENT)).toBe('at-old')
    expect(calls()).toBe(0)
  })

  it('refreshes once the token is inside the skew window', async () => {
    let now = 1_000_000
    // Still technically valid, but inside ACCESS_TOKEN_SKEW_MS of expiry.
    const expiresAt = now + ACCESS_TOKEN_SKEW_MS - 1
    const { exchange, calls } = refreshReturns(async (n) => ok(n))
    const m = manager({ store: store(tokensAt(expiresAt)), exchange, now: () => now })
    await m.restore(CLIENT)

    expect(await m.getAccessToken(CLIENT)).toBe('at-1')
    expect(calls()).toBe(1)
  })

  it('does not refresh when the token is just past the skew boundary', async () => {
    const now = 1_000_000
    const { exchange, calls } = refreshReturns(async (n) => ok(n))
    const m = manager({
      store: store(tokensAt(now + ACCESS_TOKEN_SKEW_MS + 1)),
      exchange,
      now: () => now
    })
    await m.restore(CLIENT)

    expect(await m.getAccessToken(CLIENT)).toBe('at-old')
    expect(calls()).toBe(0)
  })

  it('refreshes when the token sits exactly on the skew boundary', async () => {
    // The freshness check is a strict `>`, so exactly-at-the-boundary is stale.
    // Erring toward an early refresh is the safe direction: a token that expires
    // mid-flight means a 401 on a request already in progress.
    const now = 1_000_000
    const { exchange, calls } = refreshReturns(async (n) => ok(n))
    const m = manager({
      store: store(tokensAt(now + ACCESS_TOKEN_SKEW_MS)),
      exchange,
      now: () => now
    })
    await m.restore(CLIENT)

    expect(await m.getAccessToken(CLIENT)).toBe('at-1')
    expect(calls()).toBe(1)
  })
})

describe('getAccessToken — single-flight', () => {
  it('performs exactly ONE refresh for many concurrent callers', async () => {
    // The reason this class exists. Refresh tokens are single-use, so a second
    // concurrent refresh spends a token that the first one already burned.
    let now = 1_000_000
    const { exchange, calls } = refreshReturns(async () => {
      await delay(20)
      return ok(1)
    })
    const m = manager({ store: store(tokensAt(now - 1)), exchange, now: () => now })
    await m.restore(CLIENT)

    const results = await Promise.all(
      Array.from({ length: 8 }, () => m.getAccessToken(CLIENT))
    )

    expect(calls()).toBe(1)
    expect(new Set(results)).toEqual(new Set(['at-1']))
  })

  it('clears the in-flight promise once settled, so a later expiry refreshes again', async () => {
    let now = 1_000_000
    const { exchange, calls } = refreshReturns(async (n) => ok(n))
    const m = manager({ store: store(tokensAt(now - 1)), exchange, now: () => now })
    await m.restore(CLIENT)

    expect(await m.getAccessToken(CLIENT)).toBe('at-1')

    // Push past the new token's expiry.
    now += 3600_000
    expect(await m.getAccessToken(CLIENT)).toBe('at-2')
    expect(calls()).toBe(2)
  })

  it('allows a retry after a transient failure', async () => {
    let now = 1_000_000
    let attempts = 0
    const exchange: RefreshExchange = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('network blip')
      return ok(2)
    }
    const m = manager({ store: store(tokensAt(now - 1)), exchange, now: () => now })
    await m.restore(CLIENT)

    await expect(m.getAccessToken(CLIENT)).rejects.toThrow('network blip')
    // The in-flight promise must have been cleared, or this would replay the
    // same rejection forever.
    expect(await m.getAccessToken(CLIENT)).toBe('at-2')
  })
})

describe('getAccessToken — rotation and persistence', () => {
  it('persists the rotated refresh token, not the spent one', async () => {
    let now = 1_000_000
    const s = store(tokensAt(now - 1))
    const { exchange } = refreshReturns(async (n) => ok(n))
    const m = manager({ store: s, exchange, now: () => now })
    await m.restore(CLIENT)

    await m.getAccessToken(CLIENT)

    expect(s.peek()?.refreshToken).toBe('rt-1')
    expect(s.peek()?.accessToken).toBe('at-1')
    expect(s.peek()?.expiresAt).toBe(now + 3600_000)
  })

  it('keeps the session usable when the rotated token cannot be written to disk', async () => {
    let now = 1_000_000
    const s = store(tokensAt(now - 1))
    s.save = async () => {
      throw new Error('disk full')
    }
    const { exchange } = refreshReturns(async (n) => ok(n))
    const m = manager({ store: s, exchange, now: () => now })
    await m.restore(CLIENT)

    // Degraded, not broken: the in-memory session still works, and the failure
    // is logged rather than thrown at whatever called getAccessToken.
    await expect(m.getAccessToken(CLIENT)).resolves.toBe('at-1')
  })
})

describe('getAccessToken — rejection', () => {
  it('signs out and clears the store when the refresh token is rejected', async () => {
    let now = 1_000_000
    const s = store(tokensAt(now - 1))
    const exchange: RefreshExchange = async () => {
      throw new RefreshRejected()
    }
    const m = manager({ store: s, exchange, now: () => now })
    await m.restore(CLIENT)

    await expect(m.getAccessToken(CLIENT)).rejects.toThrow(RefreshRejected)

    expect(s.peek()).toBeNull()
    expect(m.hasSession()).toBe(false)
  })

  it('does not retry a rejected token', async () => {
    let now = 1_000_000
    let attempts = 0
    const exchange: RefreshExchange = async () => {
      attempts += 1
      throw new RefreshRejected()
    }
    const m = manager({ store: store(tokensAt(now - 1)), exchange, now: () => now })
    await m.restore(CLIENT)

    await expect(m.getAccessToken(CLIENT)).rejects.toThrow(RefreshRejected)
    // A burned single-use token can only fail again, so it must not be replayed.
    await expect(m.getAccessToken(CLIENT)).rejects.toThrow(NotSignedIn)
    expect(attempts).toBe(1)
  })

  it('reports NotSignedIn when there is no session at all', async () => {
    const { exchange } = refreshReturns(async (n) => ok(n))
    const m = manager({ store: store(null), exchange, now: () => Date.now() })

    await expect(m.getAccessToken(CLIENT)).rejects.toThrow(NotSignedIn)
  })
})

describe('restore', () => {
  it('loads tokens issued by the current client', async () => {
    const now = 1_000_000
    const m = manager({
      store: store(tokensAt(now + 3600_000)),
      exchange: vi.fn(),
      now: () => now
    })

    const restored = await m.restore(CLIENT)
    expect(restored?.refreshToken).toBe('rt-old')
    expect(m.hasSession()).toBe(true)
  })

  it('discards tokens issued by a different client_id', async () => {
    // Happens when the user switches to their own credentials: the old refresh
    // token can never be redeemed against the new client, so sign out cleanly
    // rather than attempt a refresh that is guaranteed to fail.
    const now = 1_000_000
    const s = store(tokensAt(now + 3600_000, { clientId: OTHER_CLIENT }))
    const { exchange, calls } = refreshReturns(async (n) => ok(n))
    const m = manager({ store: s, exchange, now: () => now })

    expect(await m.restore(CLIENT)).toBeNull()
    expect(s.peek()).toBeNull()
    expect(m.hasSession()).toBe(false)
    expect(calls()).toBe(0)
  })

  it('handles an empty store', async () => {
    const m = manager({ store: store(null), exchange: vi.fn(), now: () => 0 })
    expect(await m.restore(CLIENT)).toBeNull()
    expect(m.hasSession()).toBe(false)
  })
})

describe('signOut', () => {
  it('clears in-memory and persisted state', async () => {
    const now = 1_000_000
    const s = store(tokensAt(now + 3600_000))
    const m = manager({ store: s, exchange: vi.fn(), now: () => now })
    await m.restore(CLIENT)

    await m.signOut()

    expect(m.hasSession()).toBe(false)
    expect(s.peek()).toBeNull()
    await expect(m.getAccessToken(CLIENT)).rejects.toThrow(NotSignedIn)
  })
})
