import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalStorage, localSignature } from '../../../../lib/storage'
import { GET, PUT } from './route'

const SECRET = 'route-test-secret'
const KEY = 'tracks/round-trip.m4a'
const SEGMENTS = KEY.split('/')
// 4 KiB of deterministic bytes: slices are asserted byte-for-byte.
const AUDIO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))

// The route resolves its configuration per request, so pointing the env at a
// fresh temp dir before each test isolates every case.
let baseDir = ''

beforeEach(async () => {
  baseDir = await mkdtemp(nodePath.join(tmpdir(), 'tapedeck-route-'))
  process.env.SESSION_SECRET = SECRET
  process.env.TAPEDECK_STORAGE_DIR = baseDir
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function driver(): ReturnType<typeof createLocalStorage> {
  return createLocalStorage({ baseDir, secret: SECRET })
}

async function put(body: Buffer, key: string[] = SEGMENTS, urlPath?: string): Promise<Response> {
  const url = requestUrl(urlPath ?? (await driver().uploadUrl(KEY)))
  return PUT(new Request(url, { method: 'PUT', body: new Uint8Array(body) }), {
    params: Promise.resolve({ key }),
  })
}

async function get(options?: { key?: string[]; urlPath?: string; range?: string }): Promise<Response> {
  const urlPath = options?.urlPath ?? (await driver().downloadUrl(KEY))
  const headers = options?.range ? { Range: options.range } : undefined
  return GET(new Request(requestUrl(urlPath), { headers }), {
    params: Promise.resolve({ key: options?.key ?? SEGMENTS }),
  })
}

function requestUrl(path: string): string {
  return `http://localhost:3000${path}`
}

describe('PUT (downloader stand-in upload)', () => {
  it('stores bytes at the signed key with a valid signature', async () => {
    const response = await put(AUDIO)
    expect(response.status).toBe(200)
    const stored = await readFile(nodePath.join(baseDir, 'tracks/round-trip.m4a'))
    expect(stored.equals(AUDIO)).toBe(true)
  })

  it('rejects uploads without, with a wrong, or expired signature (403)', async () => {
    const unsigned = (await driver().uploadUrl(KEY)).replace(/&sig=[^&]+/, '')
    expect((await put(AUDIO, SEGMENTS, unsigned)).status).toBe(403)

    const wrong = (await driver().uploadUrl(KEY)).replace(/sig=[0-9a-f]+/i, `sig=${'0'.repeat(64)}`)
    expect((await put(AUDIO, SEGMENTS, wrong)).status).toBe(403)

    const exp = Math.floor(Date.now() / 1000) - 10
    const expired = `/api/local-storage/${KEY}?exp=${exp}&sig=${localSignature(KEY, exp, SECRET)}`
    expect((await put(AUDIO, SEGMENTS, expired)).status).toBe(403)

    // Nothing was written by any rejected request.
    await expect(stat(nodePath.join(baseDir, 'tracks/round-trip.m4a'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('GET (playback)', () => {
  it('serves the full object with audio/mp4 and Accept-Ranges', async () => {
    await put(AUDIO)
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe('4096')
    const body = Buffer.from(await response.arrayBuffer())
    expect(body.equals(AUDIO)).toBe(true)
  })

  it('serves a bounded Range as 206 with the exact slice (T0 check)', async () => {
    await put(AUDIO)
    const response = await get({ range: 'bytes=0-1023' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096')
    expect(response.headers.get('content-length')).toBe('1024')
    const body = Buffer.from(await response.arrayBuffer())
    expect(body.equals(AUDIO.subarray(0, 1024))).toBe(true)
  })

  it('serves open-ended and suffix ranges as 206, clamped', async () => {
    await put(AUDIO)
    const open = await get({ range: 'bytes=4000-' })
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe('bytes 4000-4095/4096')
    expect((await open.arrayBuffer()).byteLength).toBe(96)

    const suffix = await get({ range: 'bytes=-8' })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 4088-4095/4096')
    const body = Buffer.from(await suffix.arrayBuffer())
    expect(body.equals(AUDIO.subarray(4088))).toBe(true)
  })

  it('rejects unsatisfiable ranges with 416', async () => {
    await put(AUDIO)
    const response = await get({ range: 'bytes=4096-' })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */4096')
  })

  it('rejects missing, malformed and expired signatures with 403', async () => {
    await put(AUDIO)
    const missing = (await driver().downloadUrl(KEY)).replace(/&sig=[^&]+/, '')
    expect((await get({ urlPath: missing })).status).toBe(403)

    const malformed = (await driver().downloadUrl(KEY)).replace(/exp=\d+/, 'exp=not-a-number')
    expect((await get({ urlPath: malformed })).status).toBe(403)

    const exp = Math.floor(Date.now() / 1000) - 1
    const expired = `/api/local-storage/${KEY}?exp=${exp}&sig=${localSignature(KEY, exp, SECRET)}`
    expect((await get({ urlPath: expired })).status).toBe(403)

    // A signature computed for a different key must not authorize this key.
    const forgedSig = localSignature('other/key', exp + 4000, SECRET)
    const forged = (await driver().downloadUrl(KEY)).replace(/sig=[0-9a-f]+/i, `sig=${forgedSig}`)
    expect((await get({ urlPath: forged })).status).toBe(403)
  })

  it('serves 404 for a signed key that has no stored object', async () => {
    const key = 'tracks/nothing.m4a'
    const response = await get({ urlPath: await driver().downloadUrl(key), key: key.split('/') })
    expect(response.status).toBe(404)
  })

  it('never serves paths that escape the storage root, even with a valid signature', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const traversal = `/api/local-storage/../secret.txt?exp=${exp}&sig=${localSignature('../secret.txt', exp, SECRET)}`
    const response = await get({ urlPath: traversal, key: ['..', 'secret.txt'] })
    expect(response.status).toBe(404)
  })

  it('serves an attachment disposition for ?download=1 (Save to Files, SPEC 8.10)', async () => {
    await put(AUDIO)
    const url = await driver().downloadUrl(KEY, { attachmentName: 'Daft Punk \u2013 Get Lucky.m4a' })
    const response = await get({ urlPath: url })
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="Daft Punk _ Get Lucky.m4a"')
  })
})
