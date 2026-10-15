/**
 * "Pick another version" route (V2-PLAN T12, item 5): status codes and what
 * lands in the database. Real in-memory PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../../lib/db'
import { SHORTLINK_MESSAGE } from '../../../../../lib/pick-version'
import { POST } from './route'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const CHOSEN_URL = 'https://music.youtube.com/watch?v=AAAAAAAAAAA'
const ALT_URL = 'https://soundcloud.com/band/song'
const MATCH_INFO = {
  chosen: { title: 'Song', uploader: 'Band - Topic', durationSec: 200, url: CHOSEN_URL, score: 0.9, source: 'ytmusic' },
  score: 0.9,
  alternatives: [{ title: 'Song', uploader: 'band', durationSec: 201, url: ALT_URL, score: 0.7, source: 'soundcloud' }],
}
let counter = 0

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events`
})

async function insertTrack(source: 'catalog' | 'youtube', status: string): Promise<string> {
  counter += 1
  const sourceId = source === 'catalog' ? `deezer:${counter}` : `pickr${String(counter).padStart(6, '0')}`
  const sourceUrl = source === 'catalog' ? '' : `https://www.youtube.com/watch?v=${sourceId}`
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, status, attempts, error,
                        resolved_url, match_info)
    values (${source}, ${sourceId}, ${sourceUrl}, 'Song', 'Song', ${status}, 2, 'Old error',
            ${CHOSEN_URL}, ${JSON.stringify(MATCH_INFO)}::jsonb)
    returning id`
  return String(rows[0].id)
}

function pick(id: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/tracks/${id}/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

async function row(id: string) {
  const [r] = await sql`select status, attempts, error, resolved_url from tracks where id = ${id}`
  return r
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

describe('POST /api/tracks/[id]/pick', () => {
  it('picks a saved alternative and re-queues the song', async () => {
    const id = await insertTrack('catalog', 'ready')
    const response = await pick(id, { url: ALT_URL })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await row(id)).toMatchObject({ status: 'waiting', attempts: 0, error: '', resolved_url: ALT_URL })
  })

  it('accepts a pasted YouTube link and stores its canonical form', async () => {
    const id = await insertTrack('catalog', 'failed')
    const response = await pick(id, { url: 'https://youtu.be/ZZZZZZZZZZZ?si=share' })
    expect(response.status).toBe(200)
    expect(await row(id)).toMatchObject({
      status: 'waiting',
      resolved_url: 'https://www.youtube.com/watch?v=ZZZZZZZZZZZ',
    })
  })

  it('Search again clears the pick', async () => {
    const id = await insertTrack('catalog', 'ready')
    expect((await pick(id, { searchAgain: true })).status).toBe(200)
    expect(await row(id)).toMatchObject({ status: 'waiting', attempts: 0, error: '', resolved_url: null })
  })

  it('answers 400 for a bad id or a bad body', async () => {
    expect((await pick('nope', { url: ALT_URL })).status).toBe(400)
    const id = await insertTrack('catalog', 'ready')
    for (const body of ['not json', [], {}, { url: 5 }, { searchAgain: 'yes' }, { searchAgain: false }]) {
      const response = await pick(id, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect(await row(id)).toMatchObject({ status: 'ready', resolved_url: CHOSEN_URL })
  })

  it('answers 400 with a plain message for a link it cannot use', async () => {
    const id = await insertTrack('catalog', 'ready')
    let response = await pick(id, { url: 'https://example.com/song' })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('Not a YouTube or SoundCloud song link')
    response = await pick(id, { url: 'https://on.soundcloud.com/abc' })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe(SHORTLINK_MESSAGE)
    expect(await row(id)).toMatchObject({ status: 'ready', resolved_url: CHOSEN_URL })
  })

  it('answers 404 for an unknown song', async () => {
    const response = await pick(UNKNOWN_ID, { searchAgain: true })
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Track not found')
  })

  it('answers 409 for a song that did not come from the catalog', async () => {
    const id = await insertTrack('youtube', 'ready')
    const response = await pick(id, { url: ALT_URL })
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('Only songs added from the catalog can pick another version')
    expect(await row(id)).toMatchObject({ status: 'ready' })
  })

  it('answers 409 while the PC is downloading the song', async () => {
    const id = await insertTrack('catalog', 'downloading')
    const response = await pick(id, { url: ALT_URL })
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('Your PC is downloading this song right now. Try again in a minute.')
    expect(await row(id)).toMatchObject({ status: 'downloading', attempts: 2, resolved_url: CHOSEN_URL })
  })
})
