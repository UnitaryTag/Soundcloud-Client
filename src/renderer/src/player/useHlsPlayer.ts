import { useCallback, useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import type { TrackSummary } from '@shared/sc'
import { IpcLoader } from './ipc-loader'

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export type PlayerState = {
  status: PlaybackStatus
  track: TrackSummary | null
  error: string | null
  positionSec: number
  durationSec: number
}

const INITIAL: PlayerState = {
  status: 'idle',
  track: null,
  error: null,
  positionSec: 0,
  durationSec: 0
}

/**
 * MediaSession actions throw when the action is unsupported, so every
 * registration is guarded. `null` releases a handler.
 */
const setAction = (
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null
): void => {
  try {
    navigator.mediaSession.setActionHandler(action, handler)
  } catch {
    // Unsupported here. The OS keeps its own button for it; nothing to do.
  }
}

const describeFailure = (type: string, details: string): string => {
  if (type === Hls.ErrorTypes.NETWORK_ERROR) {
    return `Playback stopped: the stream could not be loaded (${details}).`
  }
  if (type === Hls.ErrorTypes.MEDIA_ERROR) {
    return `Playback stopped: this stream could not be decoded (${details}).`
  }
  return `Playback stopped (${details}).`
}

export const useHlsPlayer = () => {
  // Held in state rather than a ref so effects can depend on the element
  // actually existing — a ref would be null on the first render and the
  // listeners would silently never attach.
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  /** Guards re-resolve-once-on-expiry. Deliberately not reset per track load. */
  const retriedRef = useRef(false)
  const [state, setState] = useState<PlayerState>(INITIAL)

  const bindAudio = useCallback((element: HTMLAudioElement | null): void => {
    setAudioEl(element)
  }, [])

  const teardown = useCallback((): void => {
    hlsRef.current?.destroy()
    hlsRef.current = null
  }, [])

  const attachSession = useCallback((track: TrackSummary): void => {
    if (!('mediaSession' in navigator)) return

    // Metadata is what makes this app the owner of the OS media keys: Chromium
    // reports playback state to macOS via MPNowPlayingInfoCenter, and macOS
    // decides by that state which app receives the keys. Not done with
    // globalShortcut — on macOS 10.14+ media accelerators need an Accessibility
    // grant and fail silently, and a second holder makes registration a no-op.
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.user.username,
      artwork: track.artworkUrl === null ? [] : [{ src: track.artworkUrl }]
    })

    setAction('play', () => audioEl?.play())
    setAction('pause', () => audioEl?.pause())
    setAction('seekto', (details) => {
      if (audioEl !== null && typeof details.seekTime === 'number') {
        audioEl.currentTime = details.seekTime
      }
    })
  }, [audioEl])

  const startStream = useCallback(
    (track: TrackSummary, url: string): void => {
      if (audioEl === null) return

      /**
       * Named so the error handler can restart the pipeline after re-resolving
       * — a self-reference a `useCallback` const cannot express without a
       * circular dependency between callbacks.
       */
      const begin = (sourceUrl: string): void => {
        teardown()

        const hls = new Hls({ loader: IpcLoader, enableWorker: true })
        hlsRef.current = hls

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return

          // A fatal network error most often means the stream URL's signature
          // expired between resolving and using it. Re-resolving once is the
          // targeted fix. Not repeated: a second failure is something else, and
          // a retry loop would spin.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !retriedRef.current) {
            retriedRef.current = true
            void window.sc.media.resolve(track.urn).then((resolved) => {
              if (!resolved.ok) {
                setState((previous) => ({
                  ...previous,
                  status: 'error',
                  error: resolved.error.message
                }))
                return
              }
              begin(resolved.value.url)
            })
            return
          }

          teardown()
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: describeFailure(data.type, data.details)
          }))
        })

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          attachSession(track)
          // Only ever reached from a click, so playback is user-initiated —
          // ToS §04 requires it, and Chromium's autoplay policy would block it
          // otherwise.
          void audioEl.play().catch((cause: unknown) => {
            setState((previous) => ({
              ...previous,
              status: 'error',
              error: `Could not start playback: ${
                cause instanceof Error ? cause.message : String(cause)
              }`
            }))
          })
        })

        hls.loadSource(sourceUrl)
        hls.attachMedia(audioEl)
      }

      begin(url)
    },
    [attachSession, audioEl, teardown]
  )

  const play = useCallback(
    async (track: TrackSummary): Promise<void> => {
      if (audioEl === null) return

      teardown()
      retriedRef.current = false
      setState({ status: 'loading', track, error: null, positionSec: 0, durationSec: 0 })

      // Resolved fresh every time, never cached: these URLs are signed with an
      // `expires` parameter and SoundCloud has shipped ones already expired.
      const resolved = await window.sc.media.resolve(track.urn)
      if (!resolved.ok) {
        setState({
          status: 'error',
          track,
          error: resolved.error.message,
          positionSec: 0,
          durationSec: 0
        })
        return
      }

      startStream(track, resolved.value.url)
    },
    [audioEl, startStream, teardown]
  )

  const toggle = useCallback((): void => {
    if (audioEl === null) return
    if (audioEl.paused) void audioEl.play()
    else audioEl.pause()
  }, [audioEl])

  const seek = useCallback(
    (seconds: number): void => {
      if (audioEl === null) return
      audioEl.currentTime = seconds
    },
    [audioEl]
  )

  const stop = useCallback((): void => {
    teardown()
    audioEl?.pause()
    setState(INITIAL)
  }, [audioEl, teardown])

  // Element events drive the UI, so nothing polls.
  useEffect(() => {
    if (audioEl === null) return

    const onTime = (): void => {
      setState((previous) => ({ ...previous, positionSec: audioEl.currentTime }))
      if ('mediaSession' in navigator && Number.isFinite(audioEl.duration)) {
        try {
          navigator.mediaSession.setPositionState({
            duration: audioEl.duration,
            position: Math.min(audioEl.currentTime, audioEl.duration),
            playbackRate: audioEl.playbackRate
          })
        } catch {
          // Throws when the position exceeds duration, which happens in the
          // moment between a seek and the metadata catching up.
        }
      }
    }
    const onDuration = (): void =>
      setState((previous) => ({
        ...previous,
        durationSec: Number.isFinite(audioEl.duration) ? audioEl.duration : 0
      }))
    const onPlay = (): void => {
      setState((previous) => ({ ...previous, status: 'playing' }))
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    }
    const onPause = (): void => {
      setState((previous) =>
        previous.status === 'error' ? previous : { ...previous, status: 'paused' }
      )
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    }

    audioEl.addEventListener('timeupdate', onTime)
    audioEl.addEventListener('loadedmetadata', onDuration)
    audioEl.addEventListener('durationchange', onDuration)
    audioEl.addEventListener('play', onPlay)
    audioEl.addEventListener('pause', onPause)

    return () => {
      audioEl.removeEventListener('timeupdate', onTime)
      audioEl.removeEventListener('loadedmetadata', onDuration)
      audioEl.removeEventListener('durationchange', onDuration)
      audioEl.removeEventListener('play', onPlay)
      audioEl.removeEventListener('pause', onPause)
    }
  }, [audioEl])

  // A player left running past unmount keeps pulling segments.
  useEffect(() => teardown, [teardown])

  return { bindAudio, state, play, toggle, seek, stop }
}
