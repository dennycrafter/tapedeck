/**
 * DELETE /api/tracks/[id] (SPEC 8.6): removes the stored file, then the row.
 * Real in-memory PGlite plus the local storage stand-in in a temp folder.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../lib/db'
import { getStorage } from '../../../../lib/storage'
import { DELETE } from './route'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
let storageDir = ''

beforeAll(async () => {
  storageDir = await mkdtemp(nodePath.join(tmpdir(), 'tapedeck-delete-test-'))
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('TAPEDECK_STORAGE_DIR', storageDir)
  vi.stubEnv('SESSION_SECRET', 'delete-test-session-secret')
  vi.stubEnv('R2_ACCOUNT_ID', '')
  vi.stubEnv('R2_ACCESS_KEY_ID', '')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', '')
  vi.stubEnv('R2_BUCKET', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
  await rm(storageDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events`
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function insertTrack(sourceId: string, storageKey: string | null): Promise<string> {
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, artist, status, storage_key, bytes)
    values ('youtube', ${sourceId}, ${`https://www.youtube.com/watch?v=${sourceId}`}, 'Song', 'Song', 'Band', 'ready',
            ${storageKey}, ${storageKey ? 10 : null})
    returning id
  `
  return String(rows[0].id)
}

function del(id: string): Promise<Response> {
  return DELETE(new Request('http://localhost/api/tracks/x', { method: 'DELETE' }), ctx(id))
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

describe('DELETE /api/tracks/[id]', () => {
  it('deletes the stored file and the row, cascading playlist entries', async () => {
    const key = 'tracks/route-delete.m4a'
    const filePath = nodePath.join(storageDir, 'tracks', 'route-delete.m4a')
    await mkdir(nodePath.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'fake audio')
    const id = await insertTrack('del00000001', key)
    const playlist = await sql`insert into playlists (name) values ('Mix') returning id`
    await sql`insert into playlist_tracks (playlist_id, track_id) values (${playlist[0].id}, ${id})`
    await sql`insert into play_events (track_id, seconds_listened) values (${id}, 45)`

    const response = await del(id)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await fileExists(filePath)).toBe(false)
    expect(await sql`select 1 from tracks where id = ${id}`).toHaveLength(0)
    expect(await sql`select 1 from playlist_tracks`).toHaveLength(0)
    expect(await sql`select track_id, seconds_listened from play_events`).toEqual([
      { track_id: null, seconds_listened: 45 },
    ])
  })

  it('deletes a song that was never downloaded', async () => {
    const id = await insertTrack('del00000002', null)
    expect((await del(id)).status).toBe(200)
    expect(await sql`select 1 from tracks`).toHaveLength(0)
  })

  it('answers 500 and keeps the song when storage fails', async () => {
    const id = await insertTrack('del00000003', 'tracks/stuck.m4a')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(getStorage(), 'delete').mockRejectedValueOnce(new Error('storage down'))
    const response = await del(id)
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: string }).error).toBe('Could not delete the song')
    expect(await sql`select 1 from tracks where id = ${id}`).toHaveLength(1)
  })

  it('rejects a non-UUID id and 404s an unknown track', async () => {
    expect((await del('not-a-uuid')).status).toBe(400)
    const response = await del(UNKNOWN_ID)
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toBe('Track not found')
  })
})
