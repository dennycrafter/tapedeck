/**
 * HTTP-surface tests for the T1b agent API (SPEC 8.3) and the retry route:
 * bearer auth on every /api/agent/* route, response shapes, body validation,
 * and the session-gated /api/tracks/[id]/retry handler. The queue mechanics
 * themselves (claim CTE, stale reset, fail ladder) are pinned in
 * lib/agent-queue.test.ts; here one test walks the ladder through the real
 * route handlers to prove the wiring end to end.
 *
 * Same environment as the queue tests: TAPEDECK_TEST=1 boots an in-memory
 * PGlite (SPEC 4.1); the storage driver is the local stand-in, so upload-url
 * issues signed /api/local-storage URLs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resetDb, sql } from '../../../lib/db'
import { trackKey } from '../../../lib/agent-queue'
import { POST as claimPOST } from './claim/route'
import { POST as uploadUrlPOST } from './upload-url/route'
import { POST as completePOST } from './complete/route'
import { POST as failPOST } from './fail/route'
import { GET as settingsGET } from './settings/route'
import { POST as appleMusicDonePOST } from './apple-music-done/route'
import { POST as retryPOST } from '../tracks/[id]/retry/route'

const TEST_TOKEN = 'agent-api-test-token'

const CLAIM_FIELDS = [
  'id',
  'source',
  'source_url',
  'title',
  'artist',
  'album',
  'cover_url',
  'duration_sec',
  'apple_music',
].sort()

// Every bearer-guarded handler, addressed uniformly for the auth matrix.
const AGENT_ROUTES = [
  { name: 'claim', call: (request: Request) => claimPOST(request) },
  { name: 'upload-url', call: (request: Request) => uploadUrlPOST(request) },
  { name: 'complete', call: (request: Request) => completePOST(request) },
  { name: 'fail', call: (request: Request) => failPOST(request) },
  { name: 'settings', call: (request: Request) => settingsGET(request) },
  { name: 'apple-music-done', call: (request: Request) => appleMusicDonePOST(request) },
]

interface SeedOptions {
  status?: 'waiting' | 'downloading' | 'ready' | 'failed'
  attempts?: number
  error?: string
}

let seq = 0
async function seedTrack(opts: SeedOptions = {}): Promise<string> {
  seq += 1
  const sourceId = `agent-api-test-${seq}`
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, status, attempts, error)
    values ('youtube', ${sourceId}, ${'https://www.youtube.com/watch?v=' + sourceId}, 'Raw Title',
            'Song', ${opts.status ?? 'waiting'}, ${opts.attempts ?? 0}, ${opts.error ?? ''})
    returning id`
  return String(rows[0].id)
}

async function trackRow(id: string): Promise<Record<string, unknown>> {
  const rows = await sql`select * from tracks where id = ${id}`
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** A bearer-authorized request to an agent route. */
function agentRequest(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...opts.headers,
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`http://localhost:3000${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

beforeAll(() => {
  // Set before any query: dbMode() decides the driver on first use.
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  vi.stubEnv('AGENT_TOKEN', TEST_TOKEN)
  // Deterministic local stand-in URLs (storage.ts HMAC signing).
  vi.stubEnv('SESSION_SECRET', 'agent-api-test-session-secret')
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events, search_cache`
  await sql`update settings set agent_last_seen = null, agent_version = '', apple_music_export = false where id = 1`
})

describe('bearer auth (SPEC 2, 8.3)', () => {
  it.each(AGENT_ROUTES)('$name answers 401 with no authorization header', async ({ call }) => {
    const res = await call(new Request('http://localhost:3000/api/agent/x', { method: 'POST' }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Unauthorized')
  })

  it.each(AGENT_ROUTES)('$name answers 401 with a wrong token', async ({ call }) => {
    const request = new Request('http://localhost:3000/api/agent/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect((await call(request)).status).toBe(401)
  })

  it.each(AGENT_ROUTES)('$name answers 401 with the wrong scheme (lowercase bearer)', async ({ call }) => {
    const request = new Request('http://localhost:3000/api/agent/x', {
      method: 'POST',
      headers: { Authorization: `bearer ${TEST_TOKEN}` },
    })
    expect((await call(request)).status).toBe(401)
  })

  it.each(AGENT_ROUTES)('$name fails closed when AGENT_TOKEN is not configured', async ({ call }) => {
    vi.stubEnv('AGENT_TOKEN', '')
    const request = new Request('http://localhost:3000/api/agent/x', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    })
    expect((await call(request)).status).toBe(401)
  })
})

describe('POST /api/agent/claim', () => {
  it('claims waiting tracks as a bare JSON array and records agent_last_seen + version', async () => {
    const id = await seedTrack()

    const res = await claimPOST(
      agentRequest('/api/agent/claim', { headers: { 'X-Agent-Version': '1.0.0' } }),
    )

    expect(res.status).toBe(200)
    const tracks = (await res.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(tracks)).toBe(true)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].id).toBe(id)
    expect(Object.keys(tracks[0]).sort()).toEqual(CLAIM_FIELDS)

    const settings = await sql`select agent_last_seen, agent_version from settings where id = 1`
    expect(settings[0].agent_version).toBe('1.0.0')
    expect(settings[0].agent_last_seen).not.toBeNull()
  })

  it('keeps the stored version when the poll sends no X-Agent-Version', async () => {
    await seedTrack()
    await sql`update settings set agent_version = '0.9.0' where id = 1`

    await claimPOST(agentRequest('/api/agent/claim'))

    const settings = await sql`select agent_version from settings where id = 1`
    expect(settings[0].agent_version).toBe('0.9.0')
  })

  it('returns an empty array on an empty queue', async () => {
    const res = await claimPOST(agentRequest('/api/agent/claim'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('POST /api/agent/upload-url', () => {
  it('returns a presigned PUT url and the canonical SPEC 4 key', async () => {
    const id = await seedTrack()

    const res = await uploadUrlPOST(agentRequest('/api/agent/upload-url', { body: { trackId: id } }))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; key: string }
    expect(body.key).toBe(trackKey(id))
    // Local stand-in driver: signed /api/local-storage PUT with exp + sig
    // (per-segment encoding joined with plain slashes, see storage.ts signedUrl).
    expect(body.url).toContain('/api/local-storage/tracks/')
    expect(body.url).not.toContain('%2F')
    expect(body.url).toContain('exp=')
    expect(body.url).toContain('sig=')
  })

  it('answers 400 on a missing or malformed trackId', async () => {
    expect((await uploadUrlPOST(agentRequest('/api/agent/upload-url', { body: {} }))).status).toBe(400)
    expect(
      (await uploadUrlPOST(agentRequest('/api/agent/upload-url', { body: { trackId: 'not-a-uuid' } })))
        .status,
    ).toBe(400)
  })

  it('answers 404 when the track is gone (deleted mid-queue)', async () => {
    const res = await uploadUrlPOST(
      agentRequest('/api/agent/upload-url', { body: { trackId: randomUUID() } }),
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/agent/complete', () => {
  it('marks a claimed track ready with storage key, bytes and duration', async () => {
    const id = await seedTrack()
    await claimPOST(agentRequest('/api/agent/claim'))

    const res = await completePOST(
      agentRequest('/api/agent/complete', {
        body: { trackId: id, key: trackKey(id), bytes: 2048, durationSec: 95.4 },
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const row = await trackRow(id)
    expect(row.status).toBe('ready')
    expect(row.storage_key).toBe(trackKey(id))
    expect(Number(row.bytes)).toBe(2048)
    expect(row.duration_sec).toBe(95) // ffprobe fractions round to the int column
    expect(row.ready_at).not.toBeNull()
    expect(row.error).toBe('')
  })

  it('answers 400 on invalid bodies', async () => {
    const id = await seedTrack()
    const cases: unknown[] = [
      {}, // everything missing
      { trackId: 'nope', key: 'k', bytes: 1 }, // bad uuid
      { trackId: id, bytes: 1 }, // key missing
      { trackId: id, key: 'k', bytes: 'many' }, // bytes not a number
      { trackId: id, key: 'k', bytes: 1.5 }, // bytes not an integer
      { trackId: id, key: 'k', bytes: -1 }, // negative bytes
      { trackId: id, key: 'k', bytes: 1, durationSec: 0 }, // duration must be positive
      { trackId: id, key: 'k', bytes: 1, durationSec: 'long' }, // duration not a number
    ]
    for (const body of cases) {
      expect((await completePOST(agentRequest('/api/agent/complete', { body }))).status).toBe(400)
    }

    // Raw bodies hit the malformed-JSON and non-object paths.
    for (const raw of ['not json at all', '[]']) {
      const request = new Request('http://localhost:3000/api/agent/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
        body: raw,
      })
      expect((await completePOST(request)).status).toBe(400)
    }
  })

  it('answers 404 when the track is gone', async () => {
    const res = await completePOST(
      agentRequest('/api/agent/complete', {
        body: { trackId: randomUUID(), key: 'tracks/x.m4a', bytes: 1, durationSec: 10 },
      }),
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/agent/fail', () => {
  it('runs the attempts ladder through the route: waiting, waiting, failed', async () => {
    const id = await seedTrack()

    await claimPOST(agentRequest('/api/agent/claim'))
    let res = await failPOST(agentRequest('/api/agent/fail', { body: { trackId: id, error: 'e1' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'waiting' })

    await claimPOST(agentRequest('/api/agent/claim'))
    res = await failPOST(agentRequest('/api/agent/fail', { body: { trackId: id, error: 'e2' } }))
    expect(await res.json()).toEqual({ status: 'waiting' })

    await claimPOST(agentRequest('/api/agent/claim'))
    res = await failPOST(agentRequest('/api/agent/fail', { body: { trackId: id, error: 'e3' } }))
    expect(await res.json()).toEqual({ status: 'failed' })

    const row = await trackRow(id)
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(3)
    expect(row.error).toBe('e3')
  })

  it('answers 400 on a non-string error or malformed trackId', async () => {
    const id = await seedTrack()
    expect(
      (await failPOST(agentRequest('/api/agent/fail', { body: { trackId: id, error: 42 } }))).status,
    ).toBe(400)
    expect(
      (await failPOST(agentRequest('/api/agent/fail', { body: { trackId: id } }))).status,
    ).toBe(400)
    expect(
      (await failPOST(agentRequest('/api/agent/fail', { body: { trackId: 'nope', error: 'e' } })))
        .status,
    ).toBe(400)
  })

  it('answers 404 when the track is gone', async () => {
    const res = await failPOST(
      agentRequest('/api/agent/fail', { body: { trackId: randomUUID(), error: 'e' } }),
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/agent/settings', () => {
  it('reports apple_music_export, defaulting to false', async () => {
    const res = await settingsGET(agentRequest('/api/agent/settings', { method: 'GET' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ apple_music_export: false })
  })

  it('reflects the current setting', async () => {
    await sql`update settings set apple_music_export = true where id = 1`
    const res = await settingsGET(agentRequest('/api/agent/settings', { method: 'GET' }))
    expect(await res.json()).toEqual({ apple_music_export: true })
  })
})

describe('POST /api/agent/apple-music-done', () => {
  it('sets apple_music_done_at', async () => {
    const id = await seedTrack()

    const res = await appleMusicDonePOST(
      agentRequest('/api/agent/apple-music-done', { body: { trackId: id } }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const row = await trackRow(id)
    expect(row.apple_music_done_at).not.toBeNull()
  })

  it('answers 400 on a malformed trackId and 404 on an unknown one', async () => {
    expect(
      (await appleMusicDonePOST(agentRequest('/api/agent/apple-music-done', { body: {} }))).status,
    ).toBe(400)
    expect(
      (
        await appleMusicDonePOST(
          agentRequest('/api/agent/apple-music-done', { body: { trackId: randomUUID() } }),
        )
      ).status,
    ).toBe(404)
  })
})

describe('POST /api/tracks/[id]/retry (session-gated, SPEC 8.3)', () => {
  function retryRequest(id: string): Promise<Response> {
    const ctx = { params: Promise.resolve({ id }) }
    return retryPOST(new Request(`http://localhost:3000/api/tracks/${id}/retry`, { method: 'POST' }), ctx)
  }

  it('requeues a failed track from zero', async () => {
    const id = await seedTrack({ status: 'failed', attempts: 3, error: 'boom' })

    const res = await retryRequest(id)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const row = await trackRow(id)
    expect(row.status).toBe('waiting')
    expect(row.attempts).toBe(0)
    expect(row.error).toBe('')
  })

  it('answers 400 on a malformed id and 404 on an unknown track', async () => {
    expect((await retryRequest('not-a-uuid')).status).toBe(400)
    expect((await retryRequest(randomUUID())).status).toBe(404)
  })
})
