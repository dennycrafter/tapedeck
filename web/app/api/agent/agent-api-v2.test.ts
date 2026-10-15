/**
 * The v2 additions to the downloader contract (V2-PLAN T9): claim
 * capabilities and the catalog-only rule, the extra claim fields, and the
 * optional resolvedUrl / matchInfo / autoTrim fields on complete and fail.
 * Same setup as agent-api.test.ts: in-memory PGlite with the migrations.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../lib/db'
import { trackKey } from '../../../lib/agent-queue'
import { POST as claimPOST } from './claim/route'
import { POST as completePOST } from './complete/route'
import { POST as failPOST } from './fail/route'

const TEST_TOKEN = 'agent-api-v2-test-token'

function agentRequest(path: string, body?: unknown): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${TEST_TOKEN}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

let seq = 0
async function seedYoutube(durationSec: number | null = 200): Promise<string> {
  seq += 1
  const sourceId = `v2-test-${seq}`
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, duration_sec)
    values ('youtube', ${sourceId}, ${'https://www.youtube.com/watch?v=' + sourceId}, 'Raw', 'Song', ${durationSec})
    returning id`
  return String(rows[0].id)
}

async function seedCatalog(): Promise<string> {
  seq += 1
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, raw_artist, title, artist, duration_sec, isrc)
    values ('catalog', ${`deezer:${3135556 + seq}`}, '', 'Harder', 'Daft Punk', 'Harder', 'Daft Punk', 224, 'GBDUW0000059')
    returning id`
  return String(rows[0].id)
}

async function claim(body?: unknown): Promise<Array<Record<string, unknown>>> {
  const res = await claimPOST(agentRequest('/api/agent/claim', body))
  expect(res.status).toBe(200)
  return (await res.json()) as Array<Record<string, unknown>>
}

async function row(id: string): Promise<Record<string, unknown>> {
  return (await sql`select * from tracks where id = ${id}`)[0]
}

const MATCH_INFO = {
  chosen: {
    title: 'Harder',
    uploader: 'Daft Punk - Topic',
    durationSec: 224,
    url: 'https://music.youtube.com/watch?v=abc',
    score: 0.97,
    source: 'ytmusic',
  },
  score: 0.97,
  alternatives: [
    {
      title: 'Harder (Live)',
      uploader: 'Someone',
      durationSec: 300,
      url: 'https://www.youtube.com/watch?v=def',
      score: 0.4,
      source: 'youtube',
    },
  ],
}

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  vi.stubEnv('AGENT_TOKEN', TEST_TOKEN)
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events, search_cache`
})

describe('POST /api/agent/claim capabilities', () => {
  it('never hands catalog songs to a downloader without the catalog capability', async () => {
    await seedCatalog()
    const youtube = await seedYoutube()
    expect((await claim()).map((track) => track.id)).toEqual([youtube])
    expect(await claim({ capabilities: [] })).toEqual([])
    expect(await claim({ capabilities: 'catalog' })).toEqual([]) // malformed means none
  })

  it('hands catalog songs to a downloader that sends "catalog", with the v2 fields', async () => {
    const id = await seedCatalog()
    const tracks = await claim({ capabilities: ['catalog', 'something-new'] })
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({
      id,
      source: 'catalog',
      source_url: '',
      duration_sec: 224,
      isrc: 'GBDUW0000059',
      catalog_id: expect.stringMatching(/^deezer:\d+$/),
      resolved_url: null,
    })
  })

  it('returns resolved_url when a copy was already picked', async () => {
    const id = await seedCatalog()
    await sql`update tracks set resolved_url = 'https://soundcloud.com/a/b' where id = ${id}`
    const tracks = await claim({ capabilities: ['catalog'] })
    expect(tracks[0].resolved_url).toBe('https://soundcloud.com/a/b')
  })

  it('gives YouTube and SoundCloud rows a null catalog_id', async () => {
    await seedYoutube()
    const tracks = await claim({ capabilities: ['catalog'] })
    expect(tracks[0]).toMatchObject({ source: 'youtube', catalog_id: null, isrc: null })
  })
})

describe('POST /api/agent/complete v2 fields', () => {
  it('stores resolvedUrl, matchInfo and the auto trim', async () => {
    const id = await seedCatalog()
    const res = await completePOST(
      agentRequest('/api/agent/complete', {
        trackId: id,
        key: trackKey(id),
        bytes: 10,
        durationSec: 224.3,
        resolvedUrl: 'https://music.youtube.com/watch?v=abc',
        matchInfo: MATCH_INFO,
        autoTrimStartSec: 1.2,
        autoTrimEndSec: 220.5,
      }),
    )
    expect(res.status).toBe(200)
    const stored = await row(id)
    expect(stored.status).toBe('ready')
    expect(stored.resolved_url).toBe('https://music.youtube.com/watch?v=abc')
    expect(stored.match_info).toEqual(MATCH_INFO)
    expect(Number(stored.auto_trim_start_sec)).toBe(1.2)
    expect(Number(stored.auto_trim_end_sec)).toBe(220.5)
  })

  it('keeps the stored values when the fields are left out (older downloaders)', async () => {
    const id = await seedYoutube()
    await sql`update tracks set auto_trim_start_sec = 2, resolved_url = 'https://x.test/a' where id = ${id}`
    const res = await completePOST(agentRequest('/api/agent/complete', { trackId: id, key: trackKey(id), bytes: 1 }))
    expect(res.status).toBe(200)
    const stored = await row(id)
    expect(Number(stored.auto_trim_start_sec)).toBe(2)
    expect(stored.resolved_url).toBe('https://x.test/a')
  })

  it('checks the trim against the stored length when durationSec is left out', async () => {
    const id = await seedYoutube(100)
    const over = await completePOST(
      agentRequest('/api/agent/complete', { trackId: id, key: 'k', bytes: 1, autoTrimEndSec: 130 }),
    )
    expect(over.status).toBe(400)
    const ok = await completePOST(
      agentRequest('/api/agent/complete', { trackId: id, key: 'k', bytes: 1, autoTrimEndSec: 99.6 }),
    )
    expect(ok.status).toBe(200)
  })

  it('answers 400 on bad v2 fields', async () => {
    const id = await seedYoutube()
    const base = { trackId: id, key: 'k', bytes: 1, durationSec: 200 }
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ resolvedUrl: 'ftp://x.test/a' }, /resolvedUrl/],
      [{ resolvedUrl: 'not a url' }, /resolvedUrl/],
      [{ resolvedUrl: 42 }, /resolvedUrl/],
      [{ matchInfo: 'text' }, /matchInfo/],
      [{ matchInfo: [1, 2] }, /matchInfo/],
      [{ matchInfo: { alternatives: [{ title: 'x'.repeat(9000) }] } }, /8 KB/],
      [{ autoTrimStartSec: -1 }, /autoTrimStartSec/],
      [{ autoTrimStartSec: 'soon' }, /autoTrimStartSec/],
      [{ autoTrimEndSec: 250 }, /length/],
      [{ autoTrimStartSec: 50, autoTrimEndSec: 40 }, /before/],
    ]
    for (const [extra, message] of cases) {
      const res = await completePOST(agentRequest('/api/agent/complete', { ...base, ...extra }))
      expect(res.status, JSON.stringify(extra).slice(0, 80)).toBe(400)
      expect((await res.json()).error).toMatch(message)
    }
    expect((await row(id)).status).toBe('waiting') // nothing was stored
  })
})

describe('POST /api/agent/fail v2 fields', () => {
  it('saves the alternatives with the failure', async () => {
    const id = await seedCatalog()
    await claim({ capabilities: ['catalog'] })
    const res = await failPOST(
      agentRequest('/api/agent/fail', {
        trackId: id,
        error: 'Could not find a matching version',
        matchInfo: MATCH_INFO,
      }),
    )
    expect(res.status).toBe(200)
    const stored = await row(id)
    expect(stored.error).toBe('Could not find a matching version')
    expect(stored.match_info).toEqual(MATCH_INFO)
  })

  it('answers 400 on a bad matchInfo', async () => {
    const id = await seedYoutube()
    const res = await failPOST(agentRequest('/api/agent/fail', { trackId: id, error: 'x', matchInfo: 'nope' }))
    expect(res.status).toBe(400)
  })
})
