import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileTokenStore, type Encryptor, type FileTokenStoreOptions } from './token-store'
import type { StoredTokens } from './tokens'

const TOKENS: StoredTokens = {
  refreshToken: 'rt-secret-value',
  accessToken: 'at-secret-value',
  expiresAt: 1_800_000_000_000,
  clientId: 'client-abc'
}

/**
 * A stand-in that genuinely obscures, so assertions about the file not holding
 * plaintext mean something. `v1.` is the version marker; a real `safeStorage`
 * blob is an opaque OS-encrypted buffer, which is why the store treats any
 * decrypt failure as "leave it alone" rather than "corrupt".
 */
const SEALED_PREFIX = 'v1.'
const sealed = (plaintext: string): string =>
  `${SEALED_PREFIX}${Buffer.from(plaintext, 'utf8').toString('base64')}`

const fakeEncryptor = (
  options: { failDecrypt?: boolean; shouldReEncrypt?: boolean } = {}
): Encryptor => ({
  encrypt: async (plaintext) => Buffer.from(sealed(plaintext), 'utf8'),
  decrypt: async (ciphertext) => {
    if (options.failDecrypt === true) throw new Error('Keychain is locked')
    const text = ciphertext.toString('utf8')
    if (!text.startsWith(SEALED_PREFIX)) throw new Error('not encrypted')
    return {
      result: Buffer.from(text.slice(SEALED_PREFIX.length), 'base64').toString('utf8'),
      shouldReEncrypt: options.shouldReEncrypt ?? false
    }
  }
})

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'sc-token-store-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const store = (options: Partial<FileTokenStoreOptions> = {}) =>
  createFileTokenStore({ dir, encryptor: fakeEncryptor(), ...options })

const filePath = (): string => join(dir, 'tokens.bin')

describe('round trip', () => {
  it('returns null when nothing has been stored', async () => {
    expect(await store().load()).toBeNull()
  })

  it('loads what was saved', async () => {
    const s = store()
    await s.save(TOKENS)
    expect(await s.load()).toEqual(TOKENS)
  })

  it('writes exactly what the encryptor produced, never the raw JSON', async () => {
    // The invariant that matters: the store must not bypass the encryptor.
    const encryptor = fakeEncryptor()
    await store({ encryptor }).save(TOKENS)

    const written = await fs.readFile(filePath())
    expect(written.equals(await encryptor.encrypt(JSON.stringify(TOKENS)))).toBe(true)
  })

  it('does not leave the tokens readable in the file', async () => {
    await store().save(TOKENS)
    const raw = await fs.readFile(filePath(), 'utf8')
    expect(raw).not.toContain('rt-secret-value')
    expect(raw).not.toContain('at-secret-value')
  })

  it('creates the file unreadable to other users', async () => {
    await store().save(TOKENS)
    const { mode } = await fs.stat(filePath())
    expect(mode & 0o777).toBe(0o600)
  })

  it('leaves no temp file behind', async () => {
    await store().save(TOKENS)
    expect(await fs.readdir(dir)).toEqual(['tokens.bin'])
  })

  it('overwrites an existing file cleanly on re-save', async () => {
    const s = store()
    await s.save(TOKENS)
    await s.save({ ...TOKENS, refreshToken: 'rt-rotated' })
    expect((await s.load())?.refreshToken).toBe('rt-rotated')
  })
})

describe('decrypt failure — the token must survive', () => {
  it('returns null without destroying the stored file', async () => {
    // The single most important behaviour here. Usual causes are a locked
    // Keychain or a changed code signature after an unsigned rebuild — both of
    // which the user can recover from. Overwriting would turn "unlock and retry"
    // into "signed out permanently".
    const good = store()
    await good.save(TOKENS)
    const before = await fs.readFile(filePath())

    const locked = store({ encryptor: fakeEncryptor({ failDecrypt: true }) })
    expect(await locked.load()).toBeNull()

    const after = await fs.readFile(filePath())
    expect(after.equals(before)).toBe(true)
    expect(after.length).toBeGreaterThan(0)
  })

  it('still loads once decryption works again', async () => {
    const s = store()
    await s.save(TOKENS)

    const locked = store({ encryptor: fakeEncryptor({ failDecrypt: true }) })
    expect(await locked.load()).toBeNull()

    // The file was never touched, so a working decryptor still reads it.
    expect(await s.load()).toEqual(TOKENS)
  })

  it('leaves an unparseable payload on disk rather than clearing it', async () => {
    await fs.writeFile(filePath(), sealed('this is not json'), { mode: 0o600 })
    expect(await store().load()).toBeNull()
    expect((await fs.readFile(filePath(), 'utf8')).length).toBeGreaterThan(0)
  })

  it('rejects a payload of the wrong shape without clearing it', async () => {
    await fs.writeFile(filePath(), sealed('{"unexpected":true}'), { mode: 0o600 })
    expect(await store().load()).toBeNull()
    expect((await fs.readFile(filePath(), 'utf8')).length).toBeGreaterThan(0)
  })

  it('rejects a payload missing a required field', async () => {
    await fs.writeFile(filePath(), sealed('{"refreshToken":"rt","accessToken":"at"}'), {
      mode: 0o600
    })
    expect(await store().load()).toBeNull()
  })
})

describe('encryption key rotation', () => {
  it('rewrites the file when the decryptor reports shouldReEncrypt', async () => {
    await store().save(TOKENS)

    // A rotation: the new encryptor seals with a v2 marker, so a rewrite is
    // observable in the file.
    const rotated: Encryptor = {
      encrypt: async (plaintext) =>
        Buffer.from(`v2.${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8'),
      decrypt: async (ciphertext) => {
        const text = ciphertext.toString('utf8')
        const body = text.replace(/^v1\.|^v2\./, '')
        return { result: Buffer.from(body, 'base64').toString('utf8'), shouldReEncrypt: true }
      }
    }

    expect(await store({ encryptor: rotated }).load()).toEqual(TOKENS)
    expect((await fs.readFile(filePath(), 'utf8')).startsWith('v2.')).toBe(true)
  })

  it('still returns the tokens when the rewrite itself fails', async () => {
    await store().save(TOKENS)

    const halfBroken: Encryptor = {
      encrypt: async () => {
        throw new Error('disk full')
      },
      decrypt: async (ciphertext) => ({
        result: Buffer.from(
          ciphertext.toString('utf8').slice(SEALED_PREFIX.length),
          'base64'
        ).toString('utf8'),
        shouldReEncrypt: true
      })
    }

    // A failed rewrite is a durability problem, not a reason to fail the load.
    expect(await store({ encryptor: halfBroken }).load()).toEqual(TOKENS)
  })
})

describe('clear', () => {
  it('removes the stored file', async () => {
    const s = store()
    await s.save(TOKENS)
    await s.clear()
    expect(await s.load()).toBeNull()
  })

  it('is safe when nothing was stored', async () => {
    await expect(store().clear()).resolves.toBeUndefined()
  })
})
