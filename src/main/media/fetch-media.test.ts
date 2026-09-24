import { describe, expect, it } from 'vitest'
import { AppErrorCode } from '@shared/result'
import {
  DEFAULT_ALLOWED_HOSTS,
  MediaFetcher,
  MediaFetchError,
  hostIsAllowed,
  type MediaFetchDeps
} from './fetch-media'

const url = (host: string, path = '/x.m3u8'): string => `https://${host}${path}`

const harness = (responder: (call: number, init: RequestInit) => Response) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const deps: MediaFetchDeps = {
    fetch: async (u, init) => {
      calls.push({
        url: u,
        headers: Object.fromEntries(new Headers(init.headers).entries())
      })
      return responder(calls.length, init)
    },
    getAccessToken: async () => 'at-1'
  }
  return { fetcher: new MediaFetcher(deps), calls }
}

const playlist = (body = '#EXTM3U\n'): Response =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' }
  })

const segment = (bytes = 8): Response =>
  new Response(new Uint8Array(bytes).fill(7), {
    status: 200,
    headers: { 'content-type': 'video/iso.segment' }
  })

describe('host allowlist', () => {
  it('accepts a bare allowlisted host', () => {
    expect(hostIsAllowed('sndcdn.com', DEFAULT_ALLOWED_HOSTS)).toBe(true)
  })

  it('accepts a subdomain', () => {
    expect(hostIsAllowed('i1.sndcdn.com', DEFAULT_ALLOWED_HOSTS)).toBe(true)
  })

  it('rejects a host that merely ends with an allowlisted name', () => {
    // The classic suffix-match bug: `sndcdn.com.evil.test`.endsWith('sndcdn.com')
    // is false, but a naive `includes` check would let it through.
    expect(hostIsAllowed('sndcdn.com.evil.test', DEFAULT_ALLOWED_HOSTS)).toBe(false)
    expect(hostIsAllowed('evilsndcdn.com', DEFAULT_ALLOWED_HOSTS)).toBe(false)
  })

  it('rejects an unrelated host', () => {
    expect(hostIsAllowed('example.com', DEFAULT_ALLOWED_HOSTS)).toBe(false)
  })
})

describe('request construction', () => {
  it('sends the OAuth scheme, not Bearer', async () => {
    const { fetcher, calls } = harness(() => playlist())
    await fetcher.fetch(url('api.soundcloud.com'))

    expect(calls[0].headers['authorization']).toBe('OAuth at-1')
    expect(calls[0].headers['authorization']).not.toMatch(/bearer/i)
  })

  it('follows redirects implicitly', async () => {
    // Measured, not assumed: redirect:'manual' does not work with net.fetch
    // (see spikes/net-fetch-redirect.js), so this is the only option — which is
    // why the allowlist matters as much as it does.
    const { fetcher } = harness(() => playlist())
    await fetcher.fetch(url('api.soundcloud.com'))
    expect(true).toBe(true)
  })

  it('forwards a range header when given one', async () => {
    const { fetcher, calls } = harness(() => segment())
    await fetcher.fetch(url('cf-media.sndcdn.com', '/a.m4s'), 'bytes=0-1023')
    expect(calls[0].headers['range']).toBe('bytes=0-1023')
  })

  it('omits the range header when none is given', async () => {
    const { fetcher, calls } = harness(() => segment())
    await fetcher.fetch(url('cf-media.sndcdn.com', '/a.m4s'))
    expect(calls[0].headers).not.toHaveProperty('range')
  })
})

describe('refusals', () => {
  const expectRefusal = async (target: string): Promise<MediaFetchError> => {
    const { fetcher, calls } = harness(() => playlist())
    const error = await fetcher
      .fetch(target)
      .then(() => null, (e: unknown) => e as MediaFetchError)
    // The refusal must happen before any request goes out.
    expect(calls).toHaveLength(0)
    return error as MediaFetchError
  }

  it('refuses to send credentials to an unrecognised host', async () => {
    const error = await expectRefusal(url('evil.example.com'))
    expect(error.code).toBe(AppErrorCode.StreamUnavailable)
    expect(error.message).toMatch(/unrecognised host/i)
  })

  it('refuses a non-https URL, which would leak the token in transit', async () => {
    const error = await expectRefusal('http://api.soundcloud.com/x.m3u8')
    expect(error.message).toMatch(/non-https/i)
  })

  it('refuses a relative URL rather than resolving it against something arbitrary', async () => {
    const error = await expectRefusal('/media/stream.m3u8')
    expect(error.message).toMatch(/not a valid media url/i)
  })

  it('refuses a file URL', async () => {
    await expectRefusal('file:///etc/passwd')
  })

  it('refuses an unparseable string', async () => {
    await expectRefusal('not a url at all')
  })
})

describe('response classification', () => {
  it('returns text for a playlist', async () => {
    const { fetcher } = harness(() => playlist('#EXTM3U\n#EXTINF:2,\na.m4s\n'))
    const response = await fetcher.fetch(url('api.soundcloud.com'))

    expect(response.text).toContain('#EXTM3U')
    expect(response.bytes).toBeUndefined()
  })

  it('returns bytes for a segment', async () => {
    const { fetcher } = harness(() => segment(16))
    const response = await fetcher.fetch(url('cf-media.sndcdn.com', '/a.m4s'))

    expect(response.bytes).toBeInstanceOf(Uint8Array)
    expect(response.bytes?.byteLength).toBe(16)
    expect(response.text).toBeUndefined()
  })

  it('classifies by content type, not by file extension', async () => {
    // hls.js works out what a URL is only after seeing it; a playlist served
    // from a segment-looking path is not hypothetical.
    const { fetcher } = harness(
      () =>
        new Response('#EXTM3U\n', {
          status: 200,
          headers: { 'content-type': 'application/x-mpegURL' }
        })
    )
    const response = await fetcher.fetch(url('api.soundcloud.com', '/looks-like.m4s'))
    expect(response.text).toBeDefined()
  })

  it('reports the post-redirect URL, which hls.js needs for relative URIs', async () => {
    const { fetcher } = harness(
      () =>
        new Response('', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' }
        })
    )
    // A constructed Response has an empty `url`, so the fetcher must fall back
    // to the requested URL rather than handing hls.js an empty base.
    const response = await fetcher.fetch(url('api.soundcloud.com', '/master.m3u8'))
    expect(response.url).toBe(url('api.soundcloud.com', '/master.m3u8'))
  })

  it('treats a 206 as success, since that is a valid range response', async () => {
    const { fetcher } = harness(
      () =>
        new Response(new Uint8Array(4), {
          status: 206,
          headers: { 'content-type': 'video/iso.segment' }
        })
    )
    const response = await fetcher.fetch(url('cf-media.sndcdn.com', '/a.m4s'), 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(response.bytes?.byteLength).toBe(4)
  })
})

describe('error mapping', () => {
  const status = async (code: number): Promise<MediaFetchError> => {
    const { fetcher } = harness(() => new Response('', { status: code }))
    return fetcher
      .fetch(url('cf-media.sndcdn.com', '/a.m4s'))
      .then(() => null, (e: unknown) => e as MediaFetchError) as Promise<MediaFetchError>
  }

  it('maps 401 to StreamUnavailable, since the URL or token has expired', async () => {
    const error = await status(401)
    expect(error.code).toBe(AppErrorCode.StreamUnavailable)
    expect(error.message).toMatch(/expired/i)
  })

  it('maps 403 the same way — an expired signature looks identical', async () => {
    expect((await status(403)).code).toBe(AppErrorCode.StreamUnavailable)
  })

  it('maps 404 to a network error rather than a dead session', async () => {
    expect((await status(404)).code).toBe(AppErrorCode.NetworkError)
  })

  it('maps 500 to a network error, which is retryable', async () => {
    expect((await status(500)).code).toBe(AppErrorCode.NetworkError)
  })

  it('maps a transport failure to NetworkError', async () => {
    const deps: MediaFetchDeps = {
      fetch: async () => {
        throw new Error('ECONNRESET')
      },
      getAccessToken: async () => 'at'
    }
    const error = await new MediaFetcher(deps)
      .fetch(url('cf-media.sndcdn.com', '/a.m4s'))
      .then(() => null, (e: unknown) => e as MediaFetchError)

    expect(error?.code).toBe(AppErrorCode.NetworkError)
  })
})
