import { IPC, type MediaChunk, type StreamResolution } from '@shared/ipc'
import { AppErrorCode, err } from '@shared/result'
import { isUrn } from '@shared/sc'
import type { MediaFetcher } from '../media/fetch-media'
import type { ApiClient } from '../soundcloud/api'
import { NoPlayableStream, resolveStream } from '../soundcloud/streams'
import { handle } from './register'
import { toResult } from './to-result'

/**
 * Media access for the renderer.
 *
 * Arguments arrive from the renderer and are untrusted. The real defence is in
 * MediaFetcher — https only, host allowlist, enforced on redirect targets too —
 * so these checks exist to give a clear error rather than to be the boundary.
 */

const TRACK_URN_PREFIX = 'soundcloud:tracks:'

export const registerMediaHandlers = (fetcher: MediaFetcher, api: ApiClient): void => {
  handle<StreamResolution>(IPC.MediaResolve, async (_event, trackUrn) => {
    // Validated as a URN and specifically a *track* URN: a numeric id here would
    // be the deprecated form, and a playlist URN would resolve to nothing
    // useful. See the URN migration note in CLAUDE.md.
    if (!isUrn(trackUrn) || !trackUrn.startsWith(TRACK_URN_PREFIX)) {
      return err(AppErrorCode.InvalidRequest, 'A track URN is required to resolve a stream.')
    }

    return toResult(async () => {
      try {
        return await resolveStream(api, trackUrn)
      } catch (cause) {
        // Surfaced with its own code so the UI can say "this track cannot be
        // played" rather than a generic network failure the user would retry.
        if (cause instanceof NoPlayableStream) {
          throw new MediaUnavailable(cause.message)
        }
        throw cause
      }
    })
  })

  handle<MediaChunk>(IPC.MediaFetch, async (_event, rawUrl, range) => {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      return err(AppErrorCode.InvalidRequest, 'No media URL was given.')
    }
    if (range !== undefined && typeof range !== 'string') {
      return err(AppErrorCode.InvalidRequest, 'The range header must be a string.')
    }

    return toResult(async () => {
      const response = await fetcher.fetch(rawUrl, range)
      const chunk: MediaChunk = {
        status: response.status,
        url: response.url,
        contentType: response.contentType
      }
      if (response.text !== undefined) chunk.text = response.text
      if (response.bytes !== undefined) chunk.bytes = response.bytes
      return chunk
    })
  })
}

/** Carries StreamUnavailable through toResult without widening the error set. */
class MediaUnavailable extends Error {
  readonly code = AppErrorCode.StreamUnavailable
  constructor(message: string) {
    super(message)
    this.name = 'MediaUnavailable'
  }
}
