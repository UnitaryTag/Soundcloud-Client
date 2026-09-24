import { IPC } from '@shared/ipc'
import { AppErrorCode, err } from '@shared/result'
import type { Page, TrackSummary } from '@shared/sc'
import { resolveUrl, searchTracks, type ApiClient } from '../soundcloud/api'
import { handle } from './register'
import { toResult } from './to-result'

/**
 * Every argument here arrives from the renderer and is therefore untrusted —
 * the renderer is a web context. Each one is checked before it reaches the API.
 */

const MAX_QUERY_LENGTH = 200

export const registerCatalogHandlers = (api: ApiClient): void => {
  handle<Page<TrackSummary>>(IPC.CatalogSearch, async (_event, query, cursor) => {
    if (typeof query !== 'string' || query.trim() === '') {
      return err(AppErrorCode.InvalidRequest, 'Enter something to search for.')
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return err(
        AppErrorCode.InvalidRequest,
        `Search queries are limited to ${MAX_QUERY_LENGTH} characters.`
      )
    }

    // A cursor is opaque and comes from the previous page's `next`. It is passed
    // through rather than constructed, and the API client resolves it as an
    // absolute URL.
    const cursorValue = typeof cursor === 'string' && cursor !== '' ? cursor : undefined

    return toResult(() => searchTracks(api, query.trim(), cursorValue))
  })

  handle<TrackSummary>(IPC.CatalogResolve, async (_event, rawUrl) => {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return err(AppErrorCode.InvalidRequest, 'Paste a SoundCloud link.')
    }

    let parsed: URL
    try {
      parsed = new URL(rawUrl.trim())
    } catch {
      return err(AppErrorCode.InvalidRequest, 'That does not look like a URL.')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return err(AppErrorCode.InvalidRequest, 'Only http and https links are supported.')
    }

    return toResult(() => resolveUrl(api, parsed.toString()))
  })
}
