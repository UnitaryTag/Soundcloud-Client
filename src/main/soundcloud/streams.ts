import { AppErrorCode } from '@shared/result'
import type { Urn } from '@shared/sc'
import { bestStreamUrl, getStreamUrls, type ApiClient } from './api'

/**
 * Turning a track into something playable.
 *
 * Two things make this more than a lookup:
 *
 * - **These URLs expire.** SoundCloud signs them with an `expires` parameter,
 *   and has shipped URLs whose `expires` was already in the past, producing a
 *   403 that looks exactly like an auth failure. Parsing it lets the player
 *   re-resolve deliberately rather than guessing.
 * - **They are not directly playable.** The URL 401s unless the request carries
 *   the authorization header, which is why it goes to hls.js through the IPC
 *   loader rather than into an `<audio src>`.
 */

export type StreamResolution = {
  url: string
  /** Epoch ms, when the URL carries an `expires` parameter. */
  expiresAt: number | null
}

/** Thrown when SoundCloud offers no full-length stream — commonly a Go-only track. */
export class NoPlayableStream extends Error {
  constructor(message: string, readonly code: AppErrorCode = AppErrorCode.StreamUnavailable) {
    super(message)
    this.name = 'NoPlayableStream'
  }
}

/** SoundCloud signs stream URLs with `expires` in unix seconds, when it signs them at all. */
export const parseExpires = (rawUrl: string): number | null => {
  let value: string | null
  try {
    value = new URL(rawUrl).searchParams.get('expires')
  } catch {
    return null
  }
  if (value === null) return null

  const seconds = Number.parseInt(value, 10)
  // Reject non-numeric and absurd values rather than producing a date that
  // silently marks every stream as expired.
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return seconds * 1000
}

export const resolveStream = async (client: ApiClient, urn: Urn): Promise<StreamResolution> => {
  const streams = await getStreamUrls(client, urn)
  const url = bestStreamUrl(streams)

  if (url === null) {
    // Deliberately not substituting preview_mp3_128_url. A preview is a short
    // clip, and playing it as if it were the track would look like a playback
    // bug rather than the honest refusal it is.
    throw new NoPlayableStream(
      'SoundCloud offers no full-length stream for this track. It may be a preview-only or SoundCloud Go release.'
    )
  }

  return { url, expiresAt: parseExpires(url) }
}
