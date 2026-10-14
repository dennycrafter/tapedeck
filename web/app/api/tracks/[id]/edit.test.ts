/**
 * PATCH /api/tracks/[id] (song menu "Edit details") and POST
 * /api/tracks/[id]/restore ("Restore original") integration tests: real
 * in-memory PGlite (fresh per test via resetDb) plus the MSW fixture
 * handlers. Drives the route handlers directly, exactly as
 * middleware-authenticated requests would reach them.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { resetDb, sql, type Row } from '../../../../lib/db'
import { startTestMocks, stopTestMocks } from '../../../../e2e/mocks/server'
import { PATCH } from './route'
import { POST as RESTORE } from './restore/route'

startTestMocks({ onUnhandledRequest: 'error' })

type RouteContext = { params: Promise<{ id: string }> }
const ctx = (id: string): RouteContext => ({ params: Promise.resolve({ id }) })

const RAW_TITLE = 'Wiz Khalifa - See You Again ft. Charlie Puth [Official Video]'
const RAW_ARTIST = 'Wiz Khalifa - Topic'
const CLEAN_TITLE = 'See You Again (feat. Charlie Puth)'
const CLEAN_ARTIST = 'Wiz Khalifa'

async function seedTrack(): Promise<string> {
  const rows = (await sql`
    insert into tracks (source, source_id, source_url, raw_title, raw_artist, title, artist, album, album_artist, cover_url, ai_cleaned, ai_confidence)
    values ('youtube', 'seed-edit-1', 'https://www.youtube.com/watch?v=seed-edit-1',
            ${RAW_TITLE}, ${RAW_ARTIST}, ${CLEAN_TITLE}, ${CLEAN_ARTIST},
            'Furious 7 (Original Motion Picture Soundtrack)', 'Wiz Khalifa',
            'https://is1-ssl.mzstatic.com/cover.jpg', true, 0.9)
    returning id
  `) as (Row & { id: string })[]
  return rows[0].id
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await resetDb()
  stopTestMocks()
})

function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request('http://localhost/api/tracks/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx(id),
  )
}

async function restore(id: string): Promise<Response> {
  return RESTORE(new Request('http://localhost/api/tracks/x', { method: 'POST' }), ctx(id))
}

describe('PATCH /api/tracks/[id] (Edit details)', () => {
  it('saves title, artist, album and a pasted cover URL', async () => {
    const id = await seedTrack()
    const response = await patch(id, {
      title: 'See You Again',
      artist: 'Wiz Khalifa and Charlie Puth',
      album: 'Furious 7',
      coverUrl: 'https://example.com/cover.png',
    })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { title: string; artist: string; album: string | null; albumArtist: string | null; coverUrl: string | null }
    expect(saved.title).toBe('See You Again')
    expect(saved.artist).toBe('Wiz Khalifa and Charlie Puth')
    expect(saved.album).toBe('Furious 7')
    expect(saved.coverUrl).toBe('https://example.com/cover.png')
  })

  it('keeps absent fields and clears album_artist when the album is edited', async () => {
    const id = await seedTrack()
    const response = await patch(id, { album: 'Furious 7 OST' })
    const saved = (await response.json()) as { title: string; artist: string; album: string | null; albumArtist: string | null; coverUrl: string | null }
    expect(saved.title).toBe(CLEAN_TITLE)
    expect(saved.artist).toBe(CLEAN_ARTIST)
    expect(saved.album).toBe('Furious 7 OST')
    expect(saved.albumArtist).toBeNull()
    expect(saved.coverUrl).toBe('https://is1-ssl.mzstatic.com/cover.jpg')
  })

  it('removes the cover with null or an empty string, and rejects bad URLs', async () => {
    const id = await seedTrack()
    expect(((await patch(id, { coverUrl: null })) as Response).status).toBe(200)
    const cleared = (await sql`select cover_url from tracks where id = ${id}`) as { cover_url: string | null }[]
    expect(cleared[0].cover_url).toBeNull()

    expect(((await patch(id, { coverUrl: '' })) as Response).status).toBe(200)
    expect(((await patch(id, { coverUrl: 'not a url' })) as Response).status).toBe(400)
    expect(((await patch(id, { coverUrl: 'ftp://example.com/x' })) as Response).status).toBe(400)
  })

  it('rejects an empty title or artist, and a body with nothing to change', async () => {
    const id = await seedTrack()
    expect(((await patch(id, { title: '   ' })) as Response).status).toBe(400)
    expect(((await patch(id, { artist: '' })) as Response).status).toBe(400)
    expect(((await patch(id, {})) as Response).status).toBe(400)
  })

  it('rejects a non-UUID id and returns 404 for an unknown track', async () => {
    expect(((await patch('not-a-uuid', { title: 'x' })) as Response).status).toBe(400)
    expect(((await patch('00000000-0000-4000-8000-000000000000', { title: 'x' })) as Response).status).toBe(404)
  })
})

describe('POST /api/tracks/[id]/restore (Restore original)', () => {
  it('brings back the raw title and the suffix-stripped raw artist, and clears album and cover', async () => {
    const id = await seedTrack()
    const response = await restore(id)
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { title: string; artist: string; album: string | null; coverUrl: string | null }
    expect(saved.title).toBe(RAW_TITLE)
    expect(saved.artist).toBe('Wiz Khalifa')
    expect(saved.album).toBeNull()
    expect(saved.coverUrl).toBeNull()
    const flags = (await sql`select ai_cleaned, ai_confidence, raw_title, raw_artist from tracks where id = ${id}`) as {
      ai_cleaned: boolean
      ai_confidence: string | null
      raw_title: string
      raw_artist: string
    }[]
    expect(flags[0].ai_cleaned).toBe(false)
    expect(flags[0].ai_confidence).toBeNull()
    // Originals are never edited by the restore.
    expect(flags[0].raw_title).toBe(RAW_TITLE)
    expect(flags[0].raw_artist).toBe(RAW_ARTIST)
  })

  it('strips only " - Topic" and "VEVO" from the raw artist, keeping "Official" (8.4 Undo)', async () => {
    const id = await seedTrack()
    await sql`update tracks set raw_artist = 'Wiz Khalifa Official' where id = ${id}`
    const official = (await (await restore(id)).json()) as { artist: string }
    expect(official.artist).toBe('Wiz Khalifa Official')

    await sql`update tracks set raw_artist = 'WizKhalifaVEVO' where id = ${id}`
    const vevo = (await (await restore(id)).json()) as { artist: string }
    expect(vevo.artist).toBe('WizKhalifa')
  })

  it('is repeatable, and 404s an unknown id', async () => {
    const id = await seedTrack()
    expect(((await restore(id)) as Response).status).toBe(200)
    expect(((await restore(id)) as Response).status).toBe(200)
    expect(((await restore('00000000-0000-4000-8000-000000000000')) as Response).status).toBe(404)
    expect(((await restore('not-a-uuid')) as Response).status).toBe(400)
  })
})
