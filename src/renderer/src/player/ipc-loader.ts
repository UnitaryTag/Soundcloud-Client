import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats
} from 'hls.js'

/**
 * An hls.js loader that routes every request through IPC to the main process.
 *
 * This is the whole reason playback works at all: SoundCloud's stream URLs are
 * rejected unless the request carries an `Authorization: OAuth` header, and the
 * renderer must not hold a token. So hls.js asks for a URL, this hands it to
 * main, and main does the authenticated fetch.
 *
 * The class must be constructed *in the renderer*: class instances do not
 * survive the contextBridge — they arrive as plain objects with their methods
 * gone — so this cannot be built in the preload and handed over.
 */

/** hls.js reads `data` for binary and `text` for playlists. */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  // Sliced to exactly this view's window. Passing `bytes.buffer` directly is
  // the classic bug: a view into a larger buffer hands hls.js trailing bytes
  // belonging to something else, which surfaces as garbled audio mid-track
  // rather than as an error.
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const rangeHeaderFor = (context: LoaderContext): string | undefined => {
  if (context.rangeStart === undefined) return undefined
  const end = context.rangeEnd === undefined ? '' : String(context.rangeEnd)
  return `bytes=${context.rangeStart}-${end}`
}

const statsFor = (started: number, loaded: number): LoaderStats => {
  const ended = performance.now()
  return {
    aborted: false,
    loaded,
    retry: 0,
    total: loaded,
    chunkCount: 1,
    bwEstimate: 0,
    loading: { start: started, first: started, end: ended },
    parsing: { start: ended, end: ended },
    buffering: { start: ended, first: ended, end: ended }
  }
}

const emptyStats = (): LoaderStats => ({
  aborted: false,
  loaded: 0,
  retry: 0,
  total: 0,
  chunkCount: 0,
  bwEstimate: 0,
  loading: { start: 0, first: 0, end: 0 },
  parsing: { start: 0, end: 0 },
  buffering: { start: 0, first: 0, end: 0 }
})

export class IpcLoader implements Loader<LoaderContext> {
  /**
   * Required by the Loader interface, and read by hls.js for bandwidth
   * estimation. Kept up to date per load rather than left at zero, or hls.js
   * concludes the connection is infinitely fast and picks the top bitrate.
   */
  stats: LoaderStats = emptyStats()

  /**
   * Part of the Loader contract. Must be public — a private field cannot
   * satisfy a public interface member.
   */
  context: LoaderContext | null = null

  private aborted = false

  // hls.js instantiates loaders with the resolved HlsConfig. Nothing here needs
  // it, but the constructor signature has to match or the config key is ignored.
  constructor(_config: unknown) {
    void _config
  }

  destroy(): void {
    this.abort()
  }

  abort(): void {
    this.aborted = true
    this.stats.aborted = true
    this.context = null
  }

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>
  ): void {
    this.aborted = false
    this.stats = emptyStats()
    this.context = context
    void config
    void this.run(context, callbacks)
  }

  private async run(
    context: LoaderContext,
    callbacks: LoaderCallbacks<LoaderContext>
  ): Promise<void> {
    const started = performance.now()

    /** Records what was transferred, so hls.js can estimate bandwidth. */
    const settled = (loaded: number, aborted = false): LoaderStats => {
      this.stats = { ...statsFor(started, loaded), aborted }
      return this.stats
    }

    let result: Awaited<ReturnType<typeof window.sc.media.fetch>>
    try {
      result = await window.sc.media.fetch(context.url, rangeHeaderFor(context))
    } catch (cause) {
      if (this.aborted) return
      callbacks.onError(
        { code: 0, text: cause instanceof Error ? cause.message : String(cause) },
        context,
        null,
        settled(0)
      )
      return
    }

    // A load aborted while in flight must deliver nothing: hls.js has moved on,
    // and a late onSuccess can attach a buffer to the wrong track.
    if (this.aborted) return

    if (!result.ok) {
      callbacks.onError({ code: 0, text: result.error.message }, context, null, settled(0))
      return
    }

    const { text, bytes, url, status } = result.value

    if (bytes !== undefined) {
      const buffer = toArrayBuffer(bytes)
      callbacks.onSuccess(
        { url, data: buffer, code: status } satisfies LoaderResponse,
        settled(buffer.byteLength),
        context,
        null
      )
      return
    }

    const body = text ?? ''
    // Both fields carry the playlist text. `LoaderResponse` declares `data` and
    // `text` separately, and hls.js's own XHR loader populates `data` with
    // `responseText` — so `data` is what the playlist parser actually reads.
    // `text` is set as well because the interface advertises it and other
    // consumers in hls.js may look there. Setting only `text` produces a
    // "cannot read properties of undefined" deep inside parseMasterPlaylist.
    callbacks.onSuccess(
      { url, data: body, text: body, code: status } satisfies LoaderResponse,
      settled(body.length),
      context,
      null
    )
  }
}
