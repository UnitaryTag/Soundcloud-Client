import { describe, expect, it } from 'vitest'
import { AppErrorCode } from '@shared/result'
import {
  API_BASE,
  ApiClient,
  ApiError,
  bestStreamUrl,
  getStreamUrls,
  parseResetTime,
  resolveUrl,
  searchTracks,
  toTrackSummary,
  type ApiDeps
} from './api'
import type { FetchLike } from './oauth'

const URN = 'soundcloud:tracks:123456' as const

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })

type Captured = { url: string; authorization: string | null; method: string }

const harness = (
  responder: (call: number) => Response | Promise<Response>,
  token = 'at-1'
): { deps: ApiDeps; calls: Captured[]; invalidations: () => number } => {
  const calls: Captured[] = []
  let invalidations = 0

  const impl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      authorization: headers.get('authorization'),
      method: init?.method ?? 'GET'
    })
    return responder(calls.length)
  }

  return {
    deps: {
      getAccessToken: async () => token,
      invalidateAccessToken: () => {
        invalidations += 1
      },
      fetch: impl
    },
    calls,
    invalidations: () => invalidations
  }
}

describe('request — authentication', () => {
  it('uses the OAuth scheme, not Bearer', async () => {
    // SoundCloud rejects Bearer with a 401 that is indistinguishable from an
    // expired token, which makes this misconfiguration expensive to diagnose.
    const { deps, calls } = harness(() => json(200, {}))
    await new ApiClient(deps).getJson('/me')

    expect(calls[0].authorization).toBe('OAuth at-1')
    expect(calls[0].authorization).not.toMatch(/bearer/i)
  })

  it('resolves relative paths against the API base', async () => {
    const { deps, calls } = harness(() => json(200, {}))
    await new ApiClient(deps).getJson('/me')
    expect(calls[0].url).toBe(`${API_BASE}/me`)
  })

  it('appends query parameters', async () => {
    const { deps, calls } = harness(() => json(200, { collection: [] }))
    await new ApiClient(deps).getJson('/tracks', { q: 'ambient', limit: '50' })
    expect(calls[0].url).toContain('q=ambient')
    expect(calls[0].url).toContain('limit=50')
  })
})

describe('request — 401 handling', () => {
  it('invalidates the token and retries exactly once', async () => {
    const { deps, calls, invalidations } = harness((call) =>
      call === 1 ? json(401, {}) : json(200, { ok: true })
    )

    const body = await new ApiClient(deps).getJson<{ ok: boolean }>('/me')

    expect(body.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(invalidations()).toBe(1)
  })

  it('gives up after a second 401 rather than looping', async () => {
    // A persistent 401 means the credentials are wrong, not the token. Retrying
    // harder would burn the request budget and bury the real error.
    const { deps, calls, invalidations } = harness(() => json(401, {}))

    await expect(new ApiClient(deps).getJson('/me')).rejects.toMatchObject({
      code: AppErrorCode.Unauthorized
    })
    expect(calls).toHaveLength(2)
    expect(invalidations()).toBe(1)
  })
})

describe('request — error mapping', () => {
  it('maps 404 to NotFound', async () => {
    const { deps } = harness(() => json(404, {}))
    await expect(new ApiClient(deps).getJson('/tracks/x')).rejects.toMatchObject({
      code: AppErrorCode.NotFound
    })
  })

  it('maps a network failure to NetworkError without a status', async () => {
    const deps: ApiDeps = {
      getAccessToken: async () => 'at',
      invalidateAccessToken: () => {},
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      }
    }
    const error = await new ApiClient(deps)
      .getJson('/me')
      .then(() => null, (e: unknown) => e as ApiError)

    expect(error?.code).toBe(AppErrorCode.NetworkError)
    expect(error?.status).toBe(0)
  })
})

describe('request — 429 rate limiting', () => {
  const rateLimited = {
    errors: [
      {
        error_message: 'Too Many Requests',
        meta: {
          rate_limit: {
            group: 'plays',
            max_nr_of_requests: 15000,
            time_window: 'PT24H',
            remaining_requests: 0,
            reset_time: '2026/09/25 14:30:00 +0000'
          }
        }
      }
    ]
  }

  it('parses the reset time out of the response body', async () => {
    // SoundCloud sends no X-RateLimit-* headers at all — the body is the only
    // place this information exists.
    const { deps } = harness(() => json(429, rateLimited))
    const error = await new ApiClient(deps)
      .getJson('/tracks')
      .then(() => null, (e: unknown) => e as ApiError)

    expect(error?.code).toBe(AppErrorCode.RateLimited)
    expect(error?.rateLimit?.window).toBe('PT24H')
    expect(error?.rateLimit?.remaining).toBe(0)
    expect(error?.rateLimit?.resetAt).toBe(Date.parse('2026-09-25T14:30:00Z'))
  })

  it('does not retry a 429', async () => {
    const { deps, calls } = harness(() => json(429, rateLimited))
    await expect(new ApiClient(deps).getJson('/tracks')).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('still reports a rate limit when the body is unparseable', async () => {
    const { deps } = harness(() => new Response('slow down', { status: 429 }))
    const error = await new ApiClient(deps)
      .getJson('/tracks')
      .then(() => null, (e: unknown) => e as ApiError)

    expect(error?.code).toBe(AppErrorCode.RateLimited)
    expect(error?.rateLimit).toBeUndefined()
  })
})

describe('parseResetTime', () => {
  it('parses the documented yyyy/MM/dd HH:mm:ss Z format', () => {
    expect(parseResetTime('2026/09/25 14:30:00 +0000')).toBe(Date.parse('2026-09-25T14:30:00Z'))
  })

  it('handles a literal Z zone', () => {
    expect(parseResetTime('2026/09/25 14:30:00 Z')).toBe(Date.parse('2026-09-25T14:30:00Z'))
  })

  it('honours a non-UTC offset', () => {
    expect(parseResetTime('2026/09/25 14:30:00 -0500')).toBe(Date.parse('2026-09-25T19:30:00Z'))
  })

  it('returns null rather than guessing at an unexpected shape', () => {
    // A wrong reset time is worse than no reset time: it misleads the user
    // about when they can listen again.
    for (const bad of ['', 'tomorrow', '2026-09-25T14:30:00Z', 42, null, undefined]) {
      expect(parseResetTime(bad)).toBeNull()
    }
  })
})

describe('URN handling', () => {
  it('refuses a track that comes back with a numeric id instead of a URN', () => {
    // Numeric ids were deprecated in 2025-04 and degrade silently. Failing
    // loudly here beats keying maps by an id the API will stop honouring.
    expect(() => toTrackSummary({ id: 123, title: 'x' })).toThrow(/URN/)
  })

  it('maps a well-formed track', () => {
    const track = toTrackSummary({
      urn: URN,
      title: 'Ambient One',
      duration: 240_000,
      permalink_url: 'https://soundcloud.com/a/b',
      artwork_url: 'https://i1.sndcdn.com/x.jpg',
      user: { urn: 'soundcloud:users:1', username: 'A', permalink_url: 'https://soundcloud.com/a' }
    })

    expect(track.urn).toBe(URN)
    expect(track.title).toBe('Ambient One')
    expect(track.user.username).toBe('A')
    expect(track.streamable).toBe(true)
  })

  it('treats an explicitly non-streamable track as not streamable', () => {
    expect(toTrackSummary({ urn: URN, streamable: false }).streamable).toBe(false)
  })

  it('still produces a track when the nested user is missing', () => {
    // Asymmetric on purpose. The track URN is the key for everything downstream
    // (streams, permalinks, playback); the artist URN only feeds a link. Failing
    // the whole track over missing display metadata would break playback for a
    // cosmetic problem.
    const track = toTrackSummary({ urn: URN, title: 'x' })

    expect(track.urn).toBe(URN)
    expect(track.user.urn).toBeNull()
    expect(track.user.username).toBe('Unknown artist')
  })
})

describe('searchTracks', () => {
  it('requests linked_partitioning, since bare collections are deprecated', async () => {
    const { deps, calls } = harness(() => json(200, { collection: [], next_href: null }))
    await searchTracks(new ApiClient(deps), 'ambient')

    expect(calls[0].url).toContain('linked_partitioning=true')
    expect(calls[0].url).toContain('q=ambient')
  })

  it('follows a next_href cursor verbatim', async () => {
    const cursor = `${API_BASE}/tracks?q=ambient&cursor=abc`
    const { deps, calls } = harness(() => json(200, { collection: [], next_href: null }))
    await searchTracks(new ApiClient(deps), 'ambient', cursor)

    expect(calls[0].url).toBe(cursor)
  })

  it('reports the next cursor, and null at the end', async () => {
    const next = `${API_BASE}/tracks?cursor=next`
    const one = harness(() => json(200, { collection: [], next_href: next }))
    const two = harness(() => json(200, { collection: [], next_href: null }))

    expect((await searchTracks(new ApiClient(one.deps), 'x')).next).toBe(next)
    expect((await searchTracks(new ApiClient(two.deps), 'x')).next).toBeNull()
  })

  it('tolerates a missing collection array', async () => {
    const { deps } = harness(() => json(200, {}))
    expect((await searchTracks(new ApiClient(deps), 'x')).items).toEqual([])
  })
})

describe('streams', () => {
  it('picks 160 kbps AAC first', async () => {
    const { deps } = harness(() =>
      json(200, {
        hls_aac_160_url: 'https://a/160.m3u8',
        hls_mp3_128_url: 'https://a/128.m3u8',
        preview_mp3_128_url: 'https://a/preview.mp3'
      })
    )
    const streams = await getStreamUrls(new ApiClient(deps), URN)
    expect(bestStreamUrl(streams)).toBe('https://a/160.m3u8')
  })

  it('falls back through the available HLS variants', async () => {
    const { deps } = harness(() => json(200, { hls_aac_96_url: 'https://a/96.m3u8' }))
    const streams = await getStreamUrls(new ApiClient(deps), URN)
    expect(bestStreamUrl(streams)).toBe('https://a/96.m3u8')
  })

  it('never silently substitutes a preview for full playback', async () => {
    // A preview is a short clip. Returning it as if it were the track would be
    // a confusing playback bug rather than an honest failure.
    const { deps } = harness(() => json(200, { preview_mp3_128_url: 'https://a/preview.mp3' }))
    const streams = await getStreamUrls(new ApiClient(deps), URN)

    expect(bestStreamUrl(streams)).toBeNull()
    expect(streams.preview).toBe('https://a/preview.mp3')
  })

  it('treats an empty string as absent', async () => {
    const { deps } = harness(() => json(200, { hls_aac_160_url: '' }))
    const streams = await getStreamUrls(new ApiClient(deps), URN)
    expect(streams.hlsAac160).toBeNull()
  })
})

describe('resolveUrl', () => {
  it('passes the URL through as a query parameter', async () => {
    const { deps, calls } = harness(() => json(200, { urn: URN }))
    await resolveUrl(new ApiClient(deps), 'https://soundcloud.com/a/b')

    expect(calls[0].url).toContain('/resolve')
    expect(decodeURIComponent(calls[0].url)).toContain('url=https://soundcloud.com/a/b')
  })
})
