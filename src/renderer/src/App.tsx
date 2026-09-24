import { useEffect, useState } from 'react'
import type { CredentialInfo } from '@shared/sc'

/**
 * Placeholder shell.
 *
 * There is deliberately no player or catalog UI yet: the streaming path is not
 * proven, and building on top of an unverified playback assumption is how you
 * end up rewriting the whole thing. This screen exercises the IPC bridge and
 * reports credential state.
 */

const SourceLabel: Record<CredentialInfo['source'], string> = {
  user: 'Your own credentials',
  builtin: "Built into this build",
  none: 'None configured'
}

export default function App() {
  const [creds, setCreds] = useState<CredentialInfo | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.sc.creds.get().then((result) => {
      if (cancelled) return
      if (result.ok) setCreds(result.value)
      else setStatus(result.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const openSoundCloud = async (): Promise<void> => {
    // Proves the bridge round-trip against a real handler with a real
    // allowlist. Not a UI feature.
    const result = await window.sc.shell.openExternal('https://soundcloud.com')
    setStatus(result.ok ? 'opened soundcloud.com in your browser' : result.error.message)
  }

  return (
    <main className="shell">
      <h1>SoundCloud Client</h1>
      <p className="subtitle">Project skeleton — playback is not implemented yet.</p>

      <section className="panel">
        <h2>Credentials</h2>
        {creds === null ? (
          <p className="muted">Reading…</p>
        ) : (
          <dl>
            <dt>Source</dt>
            <dd>{SourceLabel[creds.source]}</dd>
            <dt>Client ID</dt>
            <dd>{creds.clientIdMasked ?? <span className="muted">not set</span>}</dd>
            <dt>Secret</dt>
            <dd>{creds.hasSecret ? 'present' : <span className="muted">absent</span>}</dd>
          </dl>
        )}
        {creds?.source === 'none' && (
          <p className="hint">
            Copy <code>.env.example</code> to <code>.env</code> and fill in your credentials from{' '}
            <code>soundcloud.com/you/apps</code>. Registration requires Artist Pro.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Redirect URI</h2>
        <p>
          Register this exact value on your SoundCloud app, or login will fail with a{' '}
          <code>redirect_uri</code> error:
        </p>
        <p>
          <code className="uri">{creds?.redirectUri ?? 'http://127.0.0.1:8765/callback'}</code>
        </p>
        <p className="hint">Port is configurable via SC_REDIRECT_PORT in .env.</p>
      </section>

      <section className="panel">
        <h2>Bridge check</h2>
        <button type="button" onClick={() => void openSoundCloud()}>
          Open soundcloud.com
        </button>
        {status !== null && <p className="hint">{status}</p>}
      </section>
    </main>
  )
}
