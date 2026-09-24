import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Repo-wide invariants that are cheaper to assert than to debug.
 *
 * These scan source text rather than behaviour, which is unusual — but both
 * rules below fail in ways that are invisible at the call site and produce
 * errors that point somewhere else entirely.
 */

const SRC = join(process.cwd(), 'src')

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') ? [path] : []
  })

const files = sourceFiles(SRC)

describe('auth scheme invariant', () => {
  it('finds source files to scan', () => {
    // Guards against the scan silently matching nothing and passing vacuously.
    expect(files.length).toBeGreaterThan(5)
  })

  it('never constructs a Bearer credential', () => {
    // SoundCloud's auth scheme is `OAuth`. A Bearer token is rejected with a
    // 401 that looks exactly like an expired access token, so this mistake
    // presents as an auth-refresh bug rather than a malformed header.
    //
    // Matching a quoted `Bearer ` targets credential construction specifically.
    // A bare /\bBearer\b/ also flags the redaction pattern in logger.ts, which
    // mentions the word precisely in order to strip it from logs.
    const offenders = files.filter((file) => /['"`]Bearer\s/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('never renders the client secret or an access token into markup', () => {
    // Catches a debug log or an error page sneaking a credential into the UI
    // or a log line, both of which persist outside the app's control.
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return /console\.(log|warn|error)\([^)]*(clientSecret|accessToken|refreshToken)/.test(text)
    })
    expect(offenders).toEqual([])
  })
})
