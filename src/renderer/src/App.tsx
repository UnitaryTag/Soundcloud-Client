import { useCallback, useEffect, useState } from 'react'
import type { AuthStatus, CredentialInfo } from '@shared/sc'
import BrowseView from './views/BrowseView'
import LoginView from './views/LoginView'

/**
 * A small state machine: no credentials -> sign in -> browse.
 *
 * Auth state is read once on mount and then pushed from main, so a session that
 * expires or is revoked elsewhere updates without polling.
 */
export default function App() {
  const [creds, setCreds] = useState<CredentialInfo | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    void window.sc.creds.get().then((result) => {
      if (!cancelled && result.ok) setCreds(result.value)
    })
    void window.sc.auth.status().then((result) => {
      if (!cancelled && result.ok) setAuth(result.value)
    })

    const unsubscribe = window.sc.auth.onChanged((status) => setAuth(status))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const applyStatus = useCallback((status: AuthStatus) => setAuth(status), [])

  if (creds === null || auth === null) {
    return (
      <main className="shell">
        <p className="muted">Starting…</p>
      </main>
    )
  }

  if (creds.source === 'none') {
    return (
      <main className="shell">
        <h1>SoundCloud Client</h1>
        <section className="panel">
          <h2>Credentials needed</h2>
          <p>
            Copy <code>.env.example</code> to <code>.env</code> and fill in your client id and
            secret, then restart.
          </p>
          <p className="hint">
            Register an app at <code>soundcloud.com/you/apps</code>. Registration requires an
            Artist Pro subscription.
          </p>
          <p className="hint">
            Set its redirect URI to <code className="uri">{creds.redirectUri}</code>
          </p>
        </section>
      </main>
    )
  }

  if (auth.state === 'signed-out') {
    return <LoginView creds={creds} onStatus={applyStatus} />
  }

  return <BrowseView status={auth} onStatus={applyStatus} />
}
