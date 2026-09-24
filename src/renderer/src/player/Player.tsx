import Attribution from './Attribution'
import type { PlayerState } from './useHlsPlayer'

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

export default function Player({
  bindAudio,
  state,
  onToggle,
  onSeek,
  onStop
}: {
  bindAudio: (element: HTMLAudioElement | null) => void
  state: PlayerState
  onToggle: () => void
  onSeek: (seconds: number) => void
  onStop: () => void
}) {
  const { track, status, error, positionSec, durationSec } = state

  return (
    <section className="player">
      {/*
        The element hls.js attaches its MediaSource to. Audio reaches the
        speakers through in-memory SourceBuffers and is never written to disk —
        a Terms of Use requirement, not an implementation detail.
      */}
      <audio ref={bindAudio} hidden />

      {track === null ? (
        <p className="muted">Select a track to play.</p>
      ) : (
        <>
          <div className="player-row">
            <button type="button" onClick={onToggle} disabled={status === 'loading'}>
              {status === 'playing' ? 'Pause' : status === 'loading' ? 'Loading…' : 'Play'}
            </button>
            <button type="button" className="ghost" onClick={onStop}>
              Stop
            </button>

            <div className="player-meta">
              <span className="track-title">{track.title}</span>
              <Attribution track={track} />
            </div>

            <span className="time">
              {formatTime(positionSec)} / {formatTime(durationSec)}
            </span>
          </div>

          <input
            className="scrubber"
            type="range"
            min={0}
            max={durationSec > 0 ? durationSec : 1}
            step={1}
            value={Math.min(positionSec, durationSec > 0 ? durationSec : 1)}
            onChange={(event) => onSeek(Number(event.target.value))}
            disabled={durationSec === 0}
            aria-label="Seek"
          />
        </>
      )}

      {error !== null && <p className="error">{error}</p>}
    </section>
  )
}
