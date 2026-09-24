import { AppErrorCode } from '@shared/result'

/**
 * Authenticated media fetching.
 *
 * Three constraints shape this, and the first two are measured rather than
 * assumed (see spikes/net-fetch-redirect.js):
 *
 * 1. **`Authorization` survives a cross-origin 302 in Electron's `net.fetch`,
 *    but is stripped by Node's global `fetch`.** SoundCloud's stream URLs
 *    redirect to a signed CDN host, so media MUST go through `net.fetch` (via a
 *    session). Node's fetch would 401 every segment with no obvious cause.
 * 2. **`redirect: 'manual'` does not work with `net.fetch`** — it fails with
 *    "Redirect was cancelled". Following redirects by hand is therefore not
 *    available, which makes the host allowlist below the only thing standing
 *    between us and sending the user's token to an arbitrary host.
 * 3. **Nothing may be written to disk** (ToS §05). That is the session's job —
 *    see session.ts — not this module's.
 *
 * On why URLs rather than opaque handles: hls.js resolves segment URIs against
 * the playlist's response URL, so children must be addressable by URL no matter
 * what. Handles would only cover the first request while adding a layer to keep
 * in sync, so the allowlist is the boundary instead — enforced on every request,
 * including redirect targets.
 */

export type MediaFetchDeps = {
  /**
   * Must be `mediaSession().fetch` in production — not global `fetch` (strips
   * the header) and not bare `net.fetch` (uses the default session, which has a
   * disk cache).
   */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  getAccessToken: () => Promise<string>
  /** Hosts permitted to receive the token. */
  allowedHosts?: readonly string[]
}

/** Suffix-matched, so `i1.sndcdn.com` passes and `sndcdn.com.evil.test` does not. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'soundcloud.com',
  'sndcdn.com',
  'soundcloud.cloud'
]

export type MediaResponse = {
  status: number
  /** The final URL after redirects. hls.js needs it to resolve relative child URIs. */
  url: string
  contentType: string | null
  /** Present for playlist-shaped responses. */
  text?: string
  /** Present for segment-shaped responses. */
  bytes?: Uint8Array
}

export class MediaFetchError extends Error {
  constructor(
    message: string,
    readonly code: AppErrorCode
  ) {
    super(message)
    this.name = 'MediaFetchError'
  }
}

export const hostIsAllowed = (hostname: string, allowed: readonly string[]): boolean =>
  allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`))

export class MediaFetcher {
  constructor(private readonly deps: MediaFetchDeps) {}

  private allowed(): readonly string[] {
    return this.deps.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
  }

  /** Rejects anything the token must not be sent to. */
  private parseAllowed(rawUrl: string): URL {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new MediaFetchError('Not a valid media URL.', AppErrorCode.StreamUnavailable)
    }
    // https only: plaintext would leak the token in transit.
    if (parsed.protocol !== 'https:') {
      throw new MediaFetchError(
        `Refusing a non-https media URL (${parsed.protocol}).`,
        AppErrorCode.StreamUnavailable
      )
    }
    if (!hostIsAllowed(parsed.hostname, this.allowed())) {
      throw new MediaFetchError(
        `Refusing to send credentials to an unrecognised host (${parsed.hostname}).`,
        AppErrorCode.StreamUnavailable
      )
    }
    return parsed
  }

  /**
   * Fetch a playlist or segment.
   *
   * Response classification is by content type rather than by caller intent —
   * hls.js works out what a URL is only after seeing it, and a playlist served
   * from a `.ts`-looking path is not hypothetical.
   */
  async fetch(rawUrl: string, range?: string): Promise<MediaResponse> {
    const url = this.parseAllowed(rawUrl)
    const token = await this.deps.getAccessToken()

    const headers: Record<string, string> = {
      // SoundCloud's scheme is literally `OAuth`. `Bearer` gets a 401 that is
      // indistinguishable from an expired token.
      authorization: `OAuth ${token}`
    }
    if (range !== undefined && range !== '') headers['range'] = range

    let response: Response
    try {
      response = await this.deps.fetch(url.toString(), { headers, redirect: 'follow' })
    } catch (cause) {
      throw new MediaFetchError(
        `Could not reach the media host: ${cause instanceof Error ? cause.message : String(cause)}`,
        AppErrorCode.NetworkError
      )
    }

    if (response.status === 401 || response.status === 403) {
      // Either our token is stale or the URL's own signature expired. The
      // response cannot distinguish them, so the caller re-resolves once and
      // lets a fresh URL settle it.
      throw new MediaFetchError(
        `SoundCloud refused the stream (HTTP ${response.status}). The stream URL may have expired.`,
        AppErrorCode.StreamUnavailable
      )
    }

    // 206 is a valid range response, not a failure.
    if (!response.ok && response.status !== 206) {
      throw new MediaFetchError(
        `Media request failed with HTTP ${response.status}.`,
        AppErrorCode.NetworkError
      )
    }

    const contentType = response.headers.get('content-type')
    const finalUrl = response.url === '' ? url.toString() : response.url

    // Lowercased before matching: media types are case-insensitive, and
    // `application/x-mpegURL` is a real spelling in the wild. Matching case
    // sensitively would classify a playlist as a binary segment and hand hls.js
    // bytes where it expects text.
    const normalized = contentType?.toLowerCase() ?? null
    const isPlaylist =
      normalized !== null && (normalized.includes('mpegurl') || normalized.includes('m3u'))

    if (isPlaylist) {
      return { status: response.status, url: finalUrl, contentType, text: await response.text() }
    }

    // Sliced to exactly this view's window. `new Uint8Array(buffer)` would
    // expose the whole underlying allocation when the view is a window into a
    // larger buffer, which is a silent-corruption bug that only shows up as
    // garbled audio partway through a track.
    const buffer = await response.arrayBuffer()
    return {
      status: response.status,
      url: finalUrl,
      contentType,
      bytes: new Uint8Array(buffer)
    }
  }
}
