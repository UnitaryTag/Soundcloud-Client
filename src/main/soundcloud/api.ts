import { AppErrorCode } from '@shared/result'
import { isUrn, type TrackSummary, type Urn, type UserSummary } from '@shared/sc'
import { log } from '../logger'
import type { FetchLike } from './oauth'

/**
 * Authenticated SoundCloud API client.
 *
 * Two things here are easy to get wrong and expensive to debug:
 *
 * 1. The auth scheme is `OAuth`, not `Bearer`. A `Bearer` token is rejected
 *    with a 401 that looks exactly like an expired token.
 * 2. Rate limits arrive in the response BODY, not in headers. SoundCloud sends
 *    no `X-RateLimit-*` headers at all, so a client that only inspects headers
 *    sees a bare 429 with no idea when to retry.
 */

export const API_BASE = 'https://api.soundcloud.com'
export const AUTH_SCHEME = 'OAuth'

export type RateLimitInfo = {
  /** Requests left in the window, when the server reports one. */
  remaining: number | null
  /** Epoch ms at which the window resets, when the server reports one. */
  resetAt: number | null
  /** ISO 8601 duration, e.g. `PT24H`. */
  window: string | null
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: AppErrorCode,
    readonly status: number,
    readonly rateLimit?: RateLimitInfo
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type ApiDeps = {
  /** Returns a usable access token, refreshing if needed. */
  getAccessToken: () => Promise<string>
  /** Marks the current access token unusable, forcing the next fetch to refresh. */
  invalidateAccessToken: () => void
  fetch?: FetchLike
  baseUrl?: string
}

/**
 * Parse SoundCloud's `reset_time`, which is `yyyy/MM/dd HH:mm:ss Z` — a format
 * `Date.parse` does not accept. Returns null rather than guessing when the
 * shape is unexpected, since a wrong reset time is worse than none.
 */
export const parseResetTime = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\s*(Z|[+-]\d{4})$/.exec(raw.trim())
  if (match === null) return null

  const [, year, month, day, hour, minute, second, zone] = match
  const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3)}`
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`)
  return Number.isNaN(parsed) ? null : parsed
}

const readRateLimit = (payload: unknown): RateLimitInfo | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined
  const errors = (payload as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return undefined

  for (const entry of errors) {
    if (typeof entry !== 'object' || entry === null) continue
    const meta = (entry as { meta?: unknown }).meta
    if (typeof meta !== 'object' || meta === null) continue
    const limit = (meta as { rate_limit?: unknown }).rate_limit
    if (typeof limit !== 'object' || limit === null) continue

    const record = limit as Record<string, unknown>
    return {
      remaining: typeof record['remaining_requests'] === 'number' ? record['remaining_requests'] : null,
      resetAt: parseResetTime(record['reset_time']),
      window: typeof record['time_window'] === 'string' ? record['time_window'] : null
    }
  }
  return undefined
}

export type Page<T> = {
  items: T[]
  /** Cursor for the next page, or null at the end. Opaque — never construct one. */
  next: string | null
}

export class ApiClient {
  constructor(private readonly deps: ApiDeps) {}

  private resolveFetch(): FetchLike {
    return this.deps.fetch ?? ((input, init) => fetch(input, init))
  }

  private base(): string {
    return this.deps.baseUrl ?? API_BASE
  }

  /**
   * Perform an authenticated request, retrying once on a 401.
   *
   * The retry is bounded to a single attempt on purpose. The token manager
   * single-flights refreshes, so a persistent 401 means the credentials
   * themselves are wrong — retrying harder would just burn the request budget
   * and bury the real error.
   */
  async request(
    path: string,
    init: RequestInit = {},
    options: { absolute?: boolean; attempt?: number } = {}
  ): Promise<Response> {
    const attempt = options.attempt ?? 0
    const token = await this.deps.getAccessToken()
    const url = options.absolute === true ? path : `${this.base()}${path}`

    const headers = new Headers(init.headers)
    headers.set('authorization', `${AUTH_SCHEME} ${token}`)
    headers.set('accept', 'application/json; charset=utf-8')

    let response: Response
    try {
      response = await this.resolveFetch()(url, { ...init, headers })
    } catch (cause) {
      throw new ApiError(
        `Could not reach SoundCloud: ${cause instanceof Error ? cause.message : String(cause)}`,
        AppErrorCode.NetworkError,
        0
      )
    }

    if (response.status === 401 && attempt === 0) {
      log.warn('API returned 401; forcing a token refresh and retrying once')
      this.deps.invalidateAccessToken()
      return this.request(path, init, { ...options, attempt: 1 })
    }

    if (response.ok) return response

    throw await this.toError(response)
  }

  private async toError(response: Response): Promise<ApiError> {
    let payload: unknown
    let text = ''
    try {
      text = await response.text()
      payload = text === '' ? undefined : JSON.parse(text)
    } catch {
      payload = undefined
    }

    if (response.status === 401) {
      return new ApiError(
        'SoundCloud rejected the access token. Sign in again.',
        AppErrorCode.Unauthorized,
        401
      )
    }

    if (response.status === 429) {
      const rateLimit = readRateLimit(payload)
      const when =
        rateLimit?.resetAt != null ? ` Resets at ${new Date(rateLimit.resetAt).toISOString()}.` : ''
      // Never auto-retry a 429: the window is 24h, so a retry loop would just
      // consume more of a budget that is already exhausted.
      return new ApiError(
        `SoundCloud rate limit reached (15,000 stream requests per 24h, shared across all users of this client id).${when}`,
        AppErrorCode.RateLimited,
        429,
        rateLimit
      )
    }

    if (response.status === 404) {
      return new ApiError('Not found on SoundCloud.', AppErrorCode.NotFound, 404)
    }

    return new ApiError(
      `SoundCloud returned HTTP ${response.status}.`,
      AppErrorCode.NetworkError,
      response.status
    )
  }

  async getJson<T>(
    path: string,
    params: Record<string, string> = {},
    options: { absolute?: boolean } = {}
  ): Promise<T> {
    const query = new URLSearchParams(params).toString()
    const withQuery = query === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${query}`
    const response = await this.request(withQuery, { method: 'GET' }, options)
    return (await response.json()) as T
  }

  /** Absolute-URL fetch, for the API's own `next_href` cursors. */
  async getJsonAt<T>(url: string): Promise<T> {
    return this.getJson<T>(url, {}, { absolute: true })
  }
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/**
 * SoundCloud returns `urn` on every resource now. This asserts it rather than
 * trusting the shape, because a numeric `id` silently propagating through the
 * app is exactly the failure the 2025 URN migration warned about.
 */
const requireUrn = (value: unknown, context: string): Urn => {
  if (isUrn(value)) return value
  throw new ApiError(
    `SoundCloud returned a resource without a usable URN (${context}). This client requires URNs.`,
    AppErrorCode.Unknown,
    200
  )
}

type RawUser = { urn?: unknown; username?: unknown; permalink_url?: unknown; avatar_url?: unknown }

/**
 * Deliberately lenient, unlike `requireUrn` for a track. A missing or malformed
 * nested user is an attribution-display problem; throwing here would take
 * playback down with it over metadata nothing downstream keys on.
 */
const toUserSummary = (raw: RawUser): UserSummary => ({
  urn: isUrn(raw.urn) ? raw.urn : null,
  username: typeof raw.username === 'string' ? raw.username : 'Unknown artist',
  permalinkUrl: typeof raw.permalink_url === 'string' ? raw.permalink_url : '',
  avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : null
})

type RawTrack = {
  urn?: unknown
  /**
   * Still present alongside `urn` in responses, which is exactly why this is
   * modelled: a resource that carries only `id` must fail loudly (see
   * requireUrn) rather than silently propagate a deprecated key.
   */
  id?: unknown
  title?: unknown
  duration?: unknown
  permalink_url?: unknown
  artwork_url?: unknown
  streamable?: unknown
  user?: RawUser
}

export const toTrackSummary = (raw: RawTrack): TrackSummary => ({
  urn: requireUrn(raw.urn, 'track'),
  title: typeof raw.title === 'string' ? raw.title : 'Untitled',
  durationMs: typeof raw.duration === 'number' ? raw.duration : 0,
  permalinkUrl: typeof raw.permalink_url === 'string' ? raw.permalink_url : '',
  artworkUrl: typeof raw.artwork_url === 'string' ? raw.artwork_url : null,
  user: toUserSummary(raw.user ?? {}),
  streamable: raw.streamable !== false
})

type RawCollection = { collection?: unknown; next_href?: unknown }

const toPage = <Raw, Out>(payload: RawCollection, map: (raw: Raw) => Out): Page<Out> => {
  const items = Array.isArray(payload.collection) ? (payload.collection as Raw[]) : []
  return {
    items: items.map(map),
    next: typeof payload.next_href === 'string' && payload.next_href !== '' ? payload.next_href : null
  }
}

export const getTrack = async (client: ApiClient, urn: Urn): Promise<TrackSummary> =>
  toTrackSummary(await client.getJson<RawTrack>(`/tracks/${urn}`))

/**
 * Cursor pagination. `offset` is deprecated and bare collections are deprecated
 * with it — `linked_partitioning` is the supported shape.
 */
export const searchTracks = async (
  client: ApiClient,
  query: string,
  cursor?: string
): Promise<Page<TrackSummary>> => {
  if (cursor !== undefined) {
    return toPage<RawTrack, TrackSummary>(await client.getJsonAt<RawCollection>(cursor), toTrackSummary)
  }
  const payload = await client.getJson<RawCollection>('/tracks', {
    q: query,
    linked_partitioning: 'true',
    limit: '50'
  })
  return toPage<RawTrack, TrackSummary>(payload, toTrackSummary)
}

/** Resolves a soundcloud.com or on.soundcloud.com URL to a resource. */
export const resolveUrl = async (client: ApiClient, url: string): Promise<TrackSummary> => {
  const payload = await client.getJson<RawTrack>('/resolve', { url })
  return toTrackSummary(payload)
}

export type StreamUrls = {
  /** Preferred: 160 kbps AAC over HLS. */
  hlsAac160: string | null
  hlsMp3_128: string | null
  hlsAac96: string | null
  /** A short preview, not full playback. Only a last resort. */
  preview: string | null
}

type RawStreams = {
  hls_aac_160_url?: unknown
  hls_aac_96_url?: unknown
  hls_mp3_128_url?: unknown
  preview_mp3_128_url?: unknown
}

/**
 * Stream URLs for a track.
 *
 * These come back requiring the Authorization header — using one directly as an
 * `<audio src>` returns 401. Progressive MP3 was removed in August 2026, so HLS
 * is the only full-playback option; `preview_mp3_128_url` is a short clip and
 * must not be substituted silently.
 */
export const getStreamUrls = async (client: ApiClient, urn: Urn): Promise<StreamUrls> => {
  const raw = await client.getJson<RawStreams>(`/tracks/${urn}/streams`)
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
  return {
    hlsAac160: str(raw.hls_aac_160_url),
    hlsMp3_128: str(raw.hls_mp3_128_url),
    hlsAac96: str(raw.hls_aac_96_url),
    preview: str(raw.preview_mp3_128_url)
  }
}

/** Pick the best full-playback stream. Returns null if none is offered. */
export const bestStreamUrl = (streams: StreamUrls): string | null =>
  streams.hlsAac160 ?? streams.hlsMp3_128 ?? streams.hlsAac96
