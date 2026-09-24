import { useState } from 'react'
import type { AuthStatus, TrackSummary } from '@shared/sc'

/**
 * Minimal browse surface: search, or paste a link.
 *
 * Track rows link out to the original sound on soundcloud.com, which is the
 * attribution requirement in SoundCloud's API Terms of Use (§08) — apps that
 * display User Content must credit the uploader and link back to the source.
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
    setTracks((previous) => (cursor === undefined ? result.value.items : [...previous, ...result.value.items]))
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
    const result = await window.sc.auth.signOut()
    if (result.ok) onStatus(result.value)
  }

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

      <section className="panel">
        {tracks.length === 0 ? (
          <p className="muted">Nothing loaded yet.</p>
        ) : (
          <ul className="tracks">
            {tracks.map((track) => (
              <li key={track.urn}>
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
