import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { DeleteObjectCommand, HeadObjectCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  asciiSafeFilename,
  contentTypeForKey,
  createLocalStorage,
  createR2Storage,
  DOWNLOAD_URL_TTL_SECONDS,
  isS3NotFound,
  localKeyPath,
  localSignature,
  parseRange,
  r2CorsRules,
  UPLOAD_URL_TTL_SECONDS,
  type R2Config,
  type R2Transport,
} from './storage'

const SECRET = 'test-session-secret'

// -- pure helpers -------------------------------------------------------------

describe('asciiSafeFilename', () => {
  it('replaces non-ASCII with underscores (SPEC 7.2)', () => {
    expect(asciiSafeFilename('Daft Punk \u2013 Get Lucky.m4a')).toBe('Daft Punk _ Get Lucky.m4a')
    expect(asciiSafeFilename('Björk \u2013 Homogenic.m4a')).toBe('Bj_rk _ Homogenic.m4a')
  })

  it('drops quotes so the quoted-string header stays well-formed', () => {
    expect(asciiSafeFilename('say "hi".m4a')).toBe('say _hi_.m4a')
  })

  it('keeps plain ASCII names untouched', () => {
    expect(asciiSafeFilename('Artist - Title.m4a')).toBe('Artist - Title.m4a')
  })
})

describe('localSignature', () => {
  it('is deterministic and covers key, exp and secret', () => {
    const a = localSignature('tracks/x.m4a', 1000, SECRET)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(localSignature('tracks/x.m4a', 1000, SECRET))
    expect(a).not.toBe(localSignature('tracks/y.m4a', 1000, SECRET))
    expect(a).not.toBe(localSignature('tracks/x.m4a', 1001, SECRET))
    expect(a).not.toBe(localSignature('tracks/x.m4a', 1000, 'other-secret'))
  })
})

describe('localKeyPath', () => {
  const base = '/tmp/tapedeck-storage'

  it('resolves nested keys inside the base dir', () => {
    expect(localKeyPath(base, ['tracks', 'x.m4a'])).toBe(nodePath.join(base, 'tracks', 'x.m4a'))
  })

  it('rejects traversal, absolute and empty segments', () => {
    expect(localKeyPath(base, ['..', 'escape.m4a'])).toBeNull()
    expect(localKeyPath(base, ['tracks', '..', '..', 'escape.m4a'])).toBeNull()
    expect(localKeyPath(base, [''])).toBeNull()
    expect(localKeyPath(base, ['.', 'x.m4a'])).toBeNull()
    // '/etc/passwd' arrives as ['', 'etc', 'passwd'] after splitting on '/'
    expect(localKeyPath(base, ['', 'etc', 'passwd'])).toBeNull()
  })

  it('rejects backslashes and NUL bytes', () => {
    expect(localKeyPath(base, ['a\\b.m4a'])).toBeNull()
    expect(localKeyPath(base, ['a\0b'])).toBeNull()
  })
})

describe('parseRange', () => {
  const SIZE = 4096

  it('returns null when there is no header (serve full body)', () => {
    expect(parseRange(null, SIZE)).toBeNull()
    expect(parseRange('', SIZE)).toBeNull()
  })

  it('parses a bounded range', () => {
    expect(parseRange('bytes=0-1023', SIZE)).toEqual({ start: 0, end: 1023 })
    expect(parseRange('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199 })
  })

  it('parses open-ended ranges clamped to the resource', () => {
    expect(parseRange('bytes=0-', SIZE)).toEqual({ start: 0, end: SIZE - 1 })
    expect(parseRange('bytes=0-999999', SIZE)).toEqual({ start: 0, end: SIZE - 1 })
  })

  it('parses suffix ranges (last N bytes)', () => {
    expect(parseRange('bytes=-8', SIZE)).toEqual({ start: SIZE - 8, end: SIZE - 1 })
    // Suffix longer than the resource selects the whole resource.
    expect(parseRange('bytes=-99999', SIZE)).toEqual({ start: 0, end: SIZE - 1 })
  })

  it('reports unsatisfiable when the start is past the end', () => {
    expect(parseRange('bytes=4096-', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('ignores malformed and multi-range headers (serve full body)', () => {
    expect(parseRange('bytes=100-50', SIZE)).toBeNull()
    expect(parseRange('bytes=0-1,3-4', SIZE)).toBeNull()
    expect(parseRange('bytes=', SIZE)).toBeNull()
    expect(parseRange('bytes=abc', SIZE)).toBeNull()
    expect(parseRange('items=0-1', SIZE)).toBeNull()
  })
})

describe('contentTypeForKey', () => {
  it('serves audio/mp4 for m4a objects (T1 expects audio/mp4)', () => {
    expect(contentTypeForKey('tracks/abc.m4a')).toBe('audio/mp4')
    expect(contentTypeForKey('x.mp4')).toBe('audio/mp4')
    expect(contentTypeForKey('x.mp3')).toBe('audio/mpeg')
    expect(contentTypeForKey('x.bin')).toBe('application/octet-stream')
  })
})

// -- local driver ---------------------------------------------------------------

describe('local driver', () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(nodePath.join(tmpdir(), 'tapedeck-storage-'))
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('builds stand-in URLs signed over key+exp (SPEC 4.1)', async () => {
    const storage = createLocalStorage({ baseDir, secret: SECRET })
    const url = await storage.uploadUrl('tracks/x.m4a')
    const parsed = new URL(url, 'http://localhost:3000')
    expect(parsed.pathname).toBe('/api/local-storage/tracks/x.m4a')
    const exp = Number(parsed.searchParams.get('exp'))
    const now = Math.floor(Date.now() / 1000)
    expect(Math.abs(exp - (now + UPLOAD_URL_TTL_SECONDS))).toBeLessThanOrEqual(5)
    expect(parsed.searchParams.get('sig')).toBe(localSignature('tracks/x.m4a', exp, SECRET))
  })

  it('download URLs last 6 hours and carry attachment params only when asked', async () => {
    const storage = createLocalStorage({ baseDir, secret: SECRET })

    const playback = new URL(await storage.downloadUrl('tracks/x.m4a'), 'http://localhost:3000')
    const now = Math.floor(Date.now() / 1000)
    expect(Math.abs(Number(playback.searchParams.get('exp')) - (now + DOWNLOAD_URL_TTL_SECONDS))).toBeLessThanOrEqual(5)
    expect(playback.searchParams.get('download')).toBeNull()

    // SPEC 8.10: Save to Files opens the URL with ?download=1 and an ASCII name.
    const download = new URL(
      await storage.downloadUrl('tracks/x.m4a', { attachmentName: 'Daft Punk \u2013 Get Lucky.m4a' }),
      'http://localhost:3000',
    )
    expect(download.searchParams.get('download')).toBe('1')
    expect(download.searchParams.get('name')).toBe('Daft Punk _ Get Lucky.m4a')
  })

  it('head reports existing objects with size and missing objects as not found', async () => {
    const storage = createLocalStorage({ baseDir, secret: SECRET })
    await mkdir(nodePath.join(baseDir, 'tracks'), { recursive: true })
    await writeFile(nodePath.join(baseDir, 'tracks/abc.m4a'), 'hello audio')

    expect(await storage.head('tracks/abc.m4a')).toEqual({ exists: true, bytes: 11 })
    expect(await storage.head('tracks/missing.m4a')).toEqual({ exists: false })
  })

  it('delete removes the object and tolerates missing objects', async () => {
    const storage = createLocalStorage({ baseDir, secret: SECRET })
    await mkdir(nodePath.join(baseDir, 'tracks'), { recursive: true })
    await writeFile(nodePath.join(baseDir, 'tracks/abc.m4a'), 'x')

    await storage.delete('tracks/abc.m4a')
    expect(await storage.head('tracks/abc.m4a')).toEqual({ exists: false })
    await expect(storage.delete('tracks/abc.m4a')).resolves.toBeUndefined()
  })

  it('throws StorageKeyError for keys that would escape the base dir', async () => {
    const storage = createLocalStorage({ baseDir, secret: SECRET })
    await expect(storage.head('../escape.m4a')).rejects.toThrow(/Invalid storage key/)
    await expect(storage.delete('a\\b.m4a')).rejects.toThrow(/Invalid storage key/)
    await expect(storage.uploadUrl('')).rejects.toThrow(/Invalid storage key/)
  })

  it('setCors is a no-op (SPEC 4.1)', async () => {
    const storage = createLocalStorage({ baseDir, secret: SECRET })
    await expect(storage.setCors()).resolves.toBeUndefined()
  })
})

// -- R2 driver ------------------------------------------------------------------

const R2_CONFIG: R2Config = {
  accountId: 'abc123def456',
  accessKeyId: 'test-key-id',
  secretAccessKey: 'test-secret-key',
  bucket: 'tapedeck-audio',
}

/** Captures commands and answers with canned data; no network involved. */
function fakeTransport(handler: (command: unknown) => unknown): { commands: unknown[]; transport: R2Transport } {
  const commands: unknown[] = []
  return {
    commands,
    transport: {
      async send(command: HeadObjectCommand | DeleteObjectCommand | PutBucketCorsCommand): Promise<unknown> {
        commands.push(command)
        return handler(command)
      },
    },
  }
}

describe('r2 driver', () => {
  it('uploadUrl is a presigned PUT expiring in 15 minutes with content type pinned (SPEC 7.2)', async () => {
    const storage = createR2Storage(R2_CONFIG)
    const url = await storage.uploadUrl('tracks/x.m4a')
    expect(url).toContain('X-Amz-Expires=900')
    expect(url).toContain('X-Amz-Signature=')
    // Bucket-scoped host with the key in the path (the SDK's virtual-host style).
    expect(url.startsWith('https://tapedeck-audio.abc123def456.r2.cloudflarestorage.com/tracks/x.m4a')).toBe(true)
    // ContentType rides as the PUT request header (R2 stores it), not as a
    // signed query parameter; signed headers are host-only.
    expect(url).toContain('X-Amz-SignedHeaders=host')
  })

  it('downloadUrl is a presigned GET expiring in 6 hours (SPEC 7.2)', async () => {
    const storage = createR2Storage(R2_CONFIG)
    const url = await storage.downloadUrl('tracks/x.m4a')
    expect(url).toContain('X-Amz-Expires=21600')
    expect(url).not.toContain('ResponseContentDisposition')
  })

  it('downloadUrl adds an ASCII-safe attachment disposition for Save to Files (SPEC 7.2, 8.10)', async () => {
    const storage = createR2Storage(R2_CONFIG)
    const url = await storage.downloadUrl('tracks/x.m4a', { attachmentName: 'Daft Punk \u2013 Get Lucky.m4a' })
    // The SDK serializes ResponseContentDisposition as the lower-kebab query param.
    expect(decodeURIComponent(url)).toContain(
      'response-content-disposition=attachment; filename="Daft Punk _ Get Lucky.m4a"',
    )
  })

  it('head returns the object size and maps not-found errors to exists:false', async () => {
    const found = fakeTransport(() => ({ ContentLength: 42 }))
    const storageFound = createR2Storage(R2_CONFIG, found.transport)
    expect(await storageFound.head('tracks/x.m4a')).toEqual({ exists: true, bytes: 42 })
    const headCommand = found.commands[0] as HeadObjectCommand
    expect(headCommand.input.Bucket).toBe('tapedeck-audio')
    expect(headCommand.input.Key).toBe('tracks/x.m4a')

    const missing = fakeTransport(() => {
      throw Object.assign(new Error('not found'), { name: 'NotFound' })
    })
    const storageMissing = createR2Storage(R2_CONFIG, missing.transport)
    expect(await storageMissing.head('tracks/x.m4a')).toEqual({ exists: false })
  })

  it('head rethrows errors that are not not-found', async () => {
    const denied = fakeTransport(() => {
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' })
    })
    const storage = createR2Storage(R2_CONFIG, denied.transport)
    await expect(storage.head('tracks/x.m4a')).rejects.toThrow('denied')
  })

  it('delete sends a DeleteObjectCommand for the bucket and key', async () => {
    const { commands, transport } = fakeTransport(() => ({}))
    const storage = createR2Storage(R2_CONFIG, transport)
    await storage.delete('tracks/x.m4a')
    const command = commands[0] as DeleteObjectCommand
    expect(command.input.Bucket).toBe('tapedeck-audio')
    expect(command.input.Key).toBe('tracks/x.m4a')
  })

  it('setCors sends the SPEC 7.2 CORS rules via PutBucketCors', async () => {
    const { commands, transport } = fakeTransport(() => ({}))
    const storage = createR2Storage(R2_CONFIG, transport)
    await storage.setCors()
    const command = commands[0] as PutBucketCorsCommand
    expect(command.input.Bucket).toBe('tapedeck-audio')
    expect(command.input.CORSConfiguration?.CORSRules).toEqual(r2CorsRules(['http://localhost:3000']))
  })
})

describe('r2CorsRules', () => {
  it('matches the SPEC 7.2 policy shape and dedupes origins', () => {
    expect(
      r2CorsRules(['https://tapedeck.vercel.app', 'http://localhost:3000', 'https://tapedeck.vercel.app']),
    ).toEqual([
      {
        AllowedOrigins: ['https://tapedeck.vercel.app', 'http://localhost:3000'],
        AllowedMethods: ['GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'],
        MaxAgeSeconds: 3600,
      },
    ])
  })
})

describe('isS3NotFound', () => {
  it('recognizes the SDK not-found error shapes and rejects everything else', () => {
    expect(isS3NotFound(Object.assign(new Error('x'), { name: 'NotFound' }))).toBe(true)
    expect(isS3NotFound(Object.assign(new Error('x'), { name: 'NoSuchKey' }))).toBe(true)
    expect(isS3NotFound(Object.assign(new Error('x'), { code: 'NotFound' }))).toBe(true)
    expect(isS3NotFound(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 404 } }))).toBe(true)
    expect(isS3NotFound(new Error('plain'))).toBe(false)
    expect(isS3NotFound(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(false)
    expect(isS3NotFound(null)).toBe(false)
    expect(isS3NotFound('nope')).toBe(false)
  })
})
