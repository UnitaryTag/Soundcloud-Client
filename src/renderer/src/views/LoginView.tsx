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

  const cancel = async (): Promise<void> => {
    // The pending begin() resolves on its own once the listener closes, and
    // clears `busy` — so this deliberately does not touch it here, or the
    // button would flicker back before the flow has actually unwound.
    await window.sc.auth.cancel()
  }

  return (
    <main className="shell">
      <h1>SoundCloud Client</h1>
      <p className="subtitle">Sign in to continue.</p>

      <section className="panel">
        {busy ? (
          <>
            <div className="row">
              <button type="button" className="ghost" onClick={() => void cancel()}>
                Cancel
              </button>
            </div>
            <p className="hint">
              Your browser has opened. Authorize the app there and this window will update on its
              own.
            </p>
          </>
        ) : (
          <button type="button" onClick={() => void signIn()}>
            Sign in with SoundCloud
          </button>
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
