/**
 * Apple Music export, app side (SPEC 8.11, T6): the song menu's "Add to
 * Apple Music" and the profile setting. Real in-memory PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../../lib/db'
import { POST } from './route'
import { PUT } from '../../../settings/apple-music/route'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
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
  await sql`update settings set apple_music_export = false where id = 1`
})

async function insertTrack(status: string, attempts = 2): Promise<string> {
  counter += 1
  const sourceId = `apple${String(counter).padStart(6, '0')}`
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, status, attempts)
    values ('youtube', ${sourceId}, ${`https://www.youtube.com/watch?v=${sourceId}`}, 'Song', 'Song', ${status}, ${attempts})
    returning id
  `
  return String(rows[0].id)
}

function add(id: string): Promise<Response> {
  return POST(new Request(`http://localhost/api/tracks/${id}/apple-music`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

function setting(body: unknown): Promise<Response> {
  return PUT(
    new Request('http://localhost/api/settings/apple-music', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function row(id: string) {
  const [r] = await sql`select apple_music, status, attempts from tracks where id = ${id}`
  return r
}

describe('POST /api/tracks/[id]/apple-music', () => {
  it('flags a ready song and sends it back to waiting so the PC processes it again', async () => {
    const id = await insertTrack('ready')
    const response = await add(id)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { appleMusic: boolean; status: string }
    expect(body).toMatchObject({ appleMusic: true, status: 'waiting' })
    expect(await row(id)).toMatchObject({ apple_music: true, status: 'waiting', attempts: 0 })
  })

  it('only flags a song that is still waiting or downloading', async () => {
    for (const status of ['waiting', 'downloading']) {
      const id = await insertTrack(status)
      expect((await add(id)).status).toBe(200)
      expect(await row(id)).toMatchObject({ apple_music: true, status, attempts: 2 })
    }
  })

  it('answers 404 for an unknown song and 400 for a bad id', async () => {
    expect((await add(UNKNOWN_ID)).status).toBe(404)
    expect((await add('nope')).status).toBe(400)
  })
})

describe('PUT /api/settings/apple-music', () => {
  it('turns the setting on and off', async () => {
    expect((await setting({ on: true })).status).toBe(200)
    expect((await sql`select apple_music_export from settings where id = 1`)[0]?.apple_music_export).toBe(true)
    expect((await setting({ on: false })).status).toBe(200)
    expect((await sql`select apple_music_export from settings where id = 1`)[0]?.apple_music_export).toBe(false)
  })

  it('rejects a body without a boolean', async () => {
    expect((await setting({ on: 'yes' })).status).toBe(400)
    expect((await setting({})).status).toBe(400)
  })
})
