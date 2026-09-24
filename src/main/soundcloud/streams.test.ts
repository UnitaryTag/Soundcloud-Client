import { describe, expect, it } from 'vitest'
import { AppErrorCode } from '@shared/result'
import { ApiClient, type ApiDeps } from './api'
import type { FetchLike } from './oauth'
import { NoPlayableStream, parseExpires, resolveStream } from './streams'

const URN = 'soundcloud:tracks:123456' as const

const clientReturning = (payload: unknown): ApiClient => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  const deps: ApiDeps = {
    getAccessToken: async () => 'at-1',
    invalidateAccessToken: () => {},
    fetch: fetchImpl
  }
  return new ApiClient(deps)
}

describe('parseExpires', () => {
  it('converts unix seconds to milliseconds', () => {
    expect(parseExpires('https://cf-media.sndcdn.com/a.m3u8?expires=1800000000&x=1')).toBe(
      1_800_000_000_000
    )
  })

  it('returns null when there is no expires parameter', () => {
    expect(parseExpires('https://cf-media.sndcdn.com/a.m3u8?Policy=abc')).toBeNull()
  })

  it('returns null rather than guessing at a non-numeric value', () => {
    expect(parseExpires('https://cf-media.sndcdn.com/a.m3u8?expires=soon')).toBeNull()
    expect(parseExpires('https://cf-media.sndcdn.com/a.m3u8?expires=')).toBeNull()
  })

  it('returns null for a non-positive expiry', () => {
    // Zero or negative would mark every stream as already-expired, which is
    // worse than not knowing.
    expect(parseExpires('https://cf-media.sndcdn.com/a.m3u8?expires=0')).toBeNull()
    expect(parseExpires('https://cf-media.sndcdn.com/a.m3u8?expires=-5')).toBeNull()
  })

  it('returns null for an unparseable URL instead of throwing', () => {
    expect(parseExpires('not a url')).toBeNull()
  })

  it('detects an already-past expiry, which is the case worth knowing about', () => {
    const past = Math.floor(Date.now() / 1000) - 60
    const parsed = parseExpires(`https://cf-media.sndcdn.com/a.m3u8?expires=${past}`)
    expect(parsed).not.toBeNull()
    expect(parsed).toBeLessThan(Date.now())
  })
})

describe('resolveStream', () => {
  it('prefers 160 kbps AAC', async () => {
    const client = clientReturning({
      hls_aac_160_url: 'https://cf-media.sndcdn.com/160.m3u8',
      hls_mp3_128_url: 'https://cf-media.sndcdn.com/128.m3u8'
    })

    const resolved = await resolveStream(client, URN)
    expect(resolved.url).toBe('https://cf-media.sndcdn.com/160.m3u8')
  })

  it('reports the expiry when the URL carries one', async () => {
    const client = clientReturning({
      hls_aac_160_url: 'https://cf-media.sndcdn.com/a.m3u8?expires=1800000000'
    })

    const resolved = await resolveStream(client, URN)
    expect(resolved.expiresAt).toBe(1_800_000_000_000)
  })

  it('reports a null expiry when the URL is unsigned', async () => {
    const client = clientReturning({ hls_aac_160_url: 'https://cf-media.sndcdn.com/a.m3u8' })
    expect((await resolveStream(client, URN)).expiresAt).toBeNull()
  })

  it('requests the plural streams endpoint with the URN', async () => {
    const urls: string[] = []
    const deps: ApiDeps = {
      getAccessToken: async () => 'at',
      invalidateAccessToken: () => {},
      fetch: async (url) => {
        urls.push(url)
        return new Response(JSON.stringify({ hls_aac_160_url: 'https://a/b.m3u8' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    }
    await resolveStream(new ApiClient(deps), URN)

    // Plural — the singular /stream is not in the current spec.
    expect(urls[0]).toContain(`/tracks/${URN}/streams`)
  })

  it('refuses to substitute a preview for full playback', async () => {
    // Playing a short clip as if it were the track looks like a playback bug;
    // refusing is the honest behaviour.
    const client = clientReturning({ preview_mp3_128_url: 'https://cf-media.sndcdn.com/p.mp3' })

    const error = await resolveStream(client, URN).then(
      () => null,
      (e: unknown) => e as NoPlayableStream
    )
    expect(error).toBeInstanceOf(NoPlayableStream)
    expect(error?.code).toBe(AppErrorCode.StreamUnavailable)
    expect(error?.message).toMatch(/no full-length stream/i)
  })

  it('refuses when the response offers nothing playable', async () => {
    await expect(resolveStream(clientReturning({}), URN)).rejects.toBeInstanceOf(NoPlayableStream)
  })

  it('propagates an API error rather than reporting it as unplayable', async () => {
    // A 404 or a rate limit is not the same as "this track has no stream", and
    // conflating them would tell the user something untrue.
    const deps: ApiDeps = {
      getAccessToken: async () => 'at',
      invalidateAccessToken: () => {},
      fetch: async () => new Response('', { status: 404 })
    }

    const error = await resolveStream(new ApiClient(deps), URN).then(
      () => null,
      (e: unknown) => e as { code?: string }
    )
    expect(error?.code).toBe(AppErrorCode.NotFound)
    expect(error).not.toBeInstanceOf(NoPlayableStream)
  })
})
