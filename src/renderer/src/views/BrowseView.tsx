import { useState } from 'react'
import type { AuthStatus, TrackSummary } from '@shared/sc'
import Player from '../player/Player'
import { useHlsPlayer } from '../player/useHlsPlayer'

/**
 * Search, or paste a link, and play what comes back.
 *
 * Track rows link out to the original sound — the §08 attribution requirement.
 */
export default function BrowseView({
  status,
  onStatus
}: {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
}) {
  const [query, setQuery] = useState('')
  const [link, setLink] = useState('')
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const player = useHlsPlayer()
  const username = status.state === 'signed-in' ? (status.user?.username ?? 'signed in') : ''

  const search = async (cursor?: string): Promise<void> => {
    const q = query.trim()
    if (q === '') return
    setBusy(true)
    setError(null)

    const result = await window.sc.catalog.search(q, cursor)
    setBusy(false)

    if (!result.ok) {
      setError(result.error.message)
      return
    }
    // A cursor means "next page", so append; a fresh query replaces.
    setTracks((previous) =>
      cursor === undefined ? result.value.items : [...previous, ...result.value.items]
    )
    setNext(result.value.next)
  }

  const resolve = async (): Promise<void> => {
    setBusy(true)
    setError(null)

    const result = await window.sc.catalog.resolve(link.trim())
    setBusy(false)

    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setTracks([result.value])
    setNext(null)
  }

  const signOut = async (): Promise<void> => {
    player.stop()
    const result = await window.sc.auth.signOut()
    if (result.ok) onStatus(result.value)
  }

  const playingUrn = player.state.track?.urn ?? null

  return (
    <main className="shell">
      <header className="bar">
        <h1>SoundCloud Client</h1>
        <div className="bar-right">
          <span className="muted">{username}</span>
          <button type="button" className="ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <section className="panel">
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault()
            void search()
          }}
        >
          <input
            type="search"
            placeholder="Search tracks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={busy || query.trim() === ''}>
            Search
          </button>
        </form>

        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault()
            void resolve()
          }}
        >
          <input
            type="url"
            placeholder="…or paste a soundcloud.com link"
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
          <button type="submit" disabled={busy || link.trim() === ''}>
            Load
          </button>
        </form>

        {error !== null && <p className="error">{error}</p>}
      </section>

      <Player
        bindAudio={player.bindAudio}
        state={player.state}
        onToggle={player.toggle}
        onSeek={player.seek}
        onStop={player.stop}
      />

      <section className="panel">
        {tracks.length === 0 ? (
          <p className="muted">Nothing loaded yet.</p>
        ) : (
          <ul className="tracks">
            {tracks.map((track) => (
              <li key={track.urn} className={track.urn === playingUrn ? 'playing' : undefined}>
                <button
                  type="button"
                  className="play"
                  onClick={() => void player.play(track)}
                  aria-label={`Play ${track.title}`}
                >
                  {track.urn === playingUrn && player.state.status === 'playing' ? '❚❚' : '▶'}
                </button>

                <div className="track-main">
                  <span className="track-title">{track.title}</span>
                  <span className="track-artist">{track.user.username}</span>
                </div>

                {track.permalinkUrl !== '' && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void window.sc.shell.openExternal(track.permalinkUrl)}
                  >
                    Open on SoundCloud
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {next !== null && (
          <button type="button" onClick={() => void search(next)} disabled={busy}>
            Load more
          </button>
        )}
      </section>
    </main>
  )
}
