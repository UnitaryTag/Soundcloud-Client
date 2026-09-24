import { IPC } from '@shared/ipc'
import { err, AppErrorCode } from '@shared/result'
import type { MediaChunk } from '@shared/ipc'
import { MediaFetchError, type MediaFetcher } from '../media/fetch-media'
import { handle } from './register'
import { toResult } from './to-result'

/**
 * Media bytes for the renderer's hls.js loader.
 *
 * Arguments arrive from the renderer and are untrusted. The real defence is in
 * MediaFetcher — https only, host allowlist, enforced on the redirect target
 * too — so these checks are about giving a clear error rather than about
 * security.
 */
export const registerMediaHandlers = (fetcher: MediaFetcher): void => {
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

export { MediaFetchError }
