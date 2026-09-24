import { useState } from 'react'
import type { AuthStatus, CredentialInfo } from '@shared/sc'

export default function LoginView({
  creds,
  onStatus
}: {
  creds: CredentialInfo
  onStatus: (status: AuthStatus) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await window.sc.auth.begin()
    setBusy(false)
    if (result.ok) onStatus(result.value)
    else setError(result.error.message)
  }

  return (
    <main className="shell">
      <h1>SoundCloud Client</h1>
      <p className="subtitle">Sign in to continue.</p>

      <section className="panel">
        <button type="button" onClick={() => void signIn()} disabled={busy}>
          {busy ? 'Waiting for your browser…' : 'Sign in with SoundCloud'}
        </button>

        {busy && (
          <p className="hint">
            Your browser has opened. Authorize the app there and this window will update on its
            own.
          </p>
        )}
        {error !== null && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>Credentials</h2>
        <dl>
          <dt>Source</dt>
          <dd>{creds.source === 'user' ? 'Your own' : 'Built into this build'}</dd>
          <dt>Client ID</dt>
          <dd>{creds.clientIdMasked}</dd>
        </dl>
        <p className="hint">
          If sign-in fails with a redirect error, check that your app's redirect URI is exactly{' '}
          <code className="uri">{creds.redirectUri}</code>
        </p>
      </section>
    </main>
  )
}
