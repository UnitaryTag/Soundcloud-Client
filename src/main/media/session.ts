import { session, type Session } from 'electron'

/**
 * Sessions used by the app.
 *
 * ToS §05 forbids persistent storage of User Content, and permits session
 * caching only where it "cease[s] to be available, accessible or playable
 * within your app at the end of that session". Both partitions below are
 * therefore non-persistent (`persist:` prefix deliberately absent) so Chromium
 * drops their caches at quit by construction rather than by our discipline.
 *
 * Two separate concerns:
 *  - MEDIA_PARTITION  — `cache: false` for all authenticated media fetching.
 *    This matters because plain `net.fetch` uses the DEFAULT session, which
 *    DOES have a disk cache and would write segment bytes to
 *    ~/Library/Caches/<app>/. Use `ses.fetch(...)` instead of `net.fetch(...)`.
 *  - APP_PARTITION    — the renderer window's session, kept non-persistent so
 *    anything Chromium caches for the UI (artwork, etc.) dies at quit.
 */

export const MEDIA_PARTITION = 'sc-media'
export const APP_PARTITION = 'sc-app'

/** Fetch media through this, never through `net.fetch`. */
export const mediaSession = (): Session =>
  session.fromPartition(MEDIA_PARTITION, { cache: false })
