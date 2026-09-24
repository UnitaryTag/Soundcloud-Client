import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Build-time default credentials.
 *
 * Deliberately reads `.env` explicitly rather than relying on a bundler's env
 * injection: a wrong prefix there yields `undefined` silently, which surfaces
 * later as a confusing "no credentials" state rather than an error.
 *
 * `process.env` always wins over the file, so `SC_CLIENT_ID=... npm run dev`
 * works for a one-off without touching `.env`.
 *
 * SECURITY: whatever this resolves to is baked into a distributed build and is
 * therefore extractable from it. See README — the refresh-token model assumes
 * the secret is effectively public in that case.
 */

export type BuiltinCredentials = {
  clientId: string
  /** Optional: omitted from the token request entirely when absent. */
  clientSecret?: string
  redirectPort: number
}

const DEFAULT_REDIRECT_PORT = 8765

/** Minimal KEY=VALUE parser. Ignores blanks and `#` comments; strips matched quotes. */
const parseEnvFile = (contents: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const readEnvFile = (): Record<string, string> => {
  // `app.getAppPath()` is the project root in dev and the app bundle when packaged.
  try {
    return parseEnvFile(readFileSync(join(app.getAppPath(), '.env'), 'utf8'))
  } catch {
    return {}
  }
}

let cached: BuiltinCredentials | null | undefined

/**
 * Resolved once. Returns null when no client id is configured, which is a
 * legitimate state — the user may instead supply their own credentials.
 */
export const builtinCredentials = (): BuiltinCredentials | null => {
  if (cached !== undefined) return cached

  const file = readEnvFile()
  const pick = (key: string): string | undefined => {
    const fromProcess = process.env[key]
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess
    const fromFile = file[key]
    return fromFile !== undefined && fromFile !== '' ? fromFile : undefined
  }

  const clientId = pick('SC_CLIENT_ID')
  if (clientId === undefined) {
    cached = null
    return cached
  }

  const rawPort = pick('SC_REDIRECT_PORT')
  const parsedPort = rawPort === undefined ? NaN : Number.parseInt(rawPort, 10)

  cached = {
    clientId,
    clientSecret: pick('SC_CLIENT_SECRET'),
    redirectPort:
      Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536
        ? parsedPort
        : DEFAULT_REDIRECT_PORT
  }
  return cached
}
