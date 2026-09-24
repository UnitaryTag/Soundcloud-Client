import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { log } from '../logger'
import type { StoredTokens, TokenStore } from './tokens'

/**
 * Encrypted-at-rest token persistence.
 *
 * The file handling is separated from `safeStorage` behind `Encryptor` so the
 * parts that actually have rules — atomic write, and never destroying a token
 * you failed to read — are testable without an Electron runtime.
 */

export type Encryptor = {
  encrypt: (plaintext: string) => Promise<Buffer>
  decrypt: (ciphertext: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

export type FileTokenStoreOptions = {
  /** Directory to write into. Usually `app.getPath('userData')`. */
  dir: string
  encryptor: Encryptor
  fileName?: string
}

const isStoredTokens = (value: unknown): value is StoredTokens => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['refreshToken'] === 'string' &&
    typeof record['accessToken'] === 'string' &&
    typeof record['expiresAt'] === 'number' &&
    typeof record['clientId'] === 'string'
  )
}

export const createFileTokenStore = (options: FileTokenStoreOptions): TokenStore => {
  const fileName = options.fileName ?? 'tokens.bin'
  const path = join(options.dir, fileName)
  const tempPath = `${path}.tmp`

  const write = async (tokens: StoredTokens): Promise<void> => {
    const ciphertext = await options.encryptor.encrypt(JSON.stringify(tokens))

    // Write to a temp file, flush it, then rename over the real one. Rename is
    // atomic within a filesystem, so a crash mid-write leaves either the old
    // file or the new one — never a truncated file containing half a refresh
    // token, which would be an unrecoverable sign-out.
    const handle = await fs.open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(ciphertext)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tempPath, path)
  }

  return {
    load: async (): Promise<StoredTokens | null> => {
      let ciphertext: Buffer
      try {
        ciphertext = await fs.readFile(path)
      } catch {
        return null // Nothing stored yet — a normal first run.
      }

      let plaintext: string
      let shouldReEncrypt = false
      try {
        const decrypted = await options.encryptor.decrypt(ciphertext)
        plaintext = decrypted.result
        shouldReEncrypt = decrypted.shouldReEncrypt
      } catch (cause) {
        // Do NOT delete or overwrite. The usual causes are a locked Keychain, a
        // changed code signature after an unsigned rebuild, or a deleted
        // Keychain entry — all of which can be transient or fixable by the user.
        // Overwriting here would convert "sign in again after unlocking" into
        // "token destroyed forever".
        log.error('stored tokens could not be decrypted; leaving the file untouched', cause)
        return null
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(plaintext)
      } catch {
        log.error('stored token file was not valid JSON; leaving it untouched')
        return null
      }

      if (!isStoredTokens(parsed)) {
        log.error('stored token file had an unexpected shape; leaving it untouched')
        return null
      }

      // The encryption key was rotated. Rewrite now that we hold the plaintext —
      // the old ciphertext will not decrypt once the old key is gone.
      if (shouldReEncrypt) {
        try {
          await write(parsed)
        } catch (cause) {
          log.error('could not rewrite tokens after a key rotation:', cause)
        }
      }

      return parsed
    },

    save: async (tokens: StoredTokens): Promise<void> => {
      await write(tokens)
    },

    clear: async (): Promise<void> => {
      await fs.rm(path, { force: true })
      await fs.rm(tempPath, { force: true })
    }
  }
}

/**
 * The `safeStorage`-backed encryptor.
 *
 * Uses the async API deliberately: the sync one can block the calling thread on
 * macOS while Keychain collects input, which in a desktop app means a frozen
 * window. Electron's docs also note the sync API may be deprecated.
 *
 * `isEncryptionAvailable()` is never called on a read path — on macOS it can
 * itself trigger a Keychain prompt, which would be a baffling thing to see when
 * simply launching the app. Failures surface from encrypt/decrypt instead.
 */
export const createSafeStorageEncryptor = (): Encryptor => ({
  encrypt: (plaintext) => safeStorage.encryptStringAsync(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptStringAsync(ciphertext)
})

export const createTokenStore = (): TokenStore =>
  createFileTokenStore({
    dir: app.getPath('userData'),
    encryptor: createSafeStorageEncryptor()
  })
