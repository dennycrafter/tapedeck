/**
 * "Add to Apple Music" for uploaded songs (T15 follow-up): the copies the PC
 * claims, their links, the retry pacing, and the route. Real in-memory PGlite
 * plus the local storage stand-in (links are app-relative there).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from './db'
import { claimAppleMusicCopies, COPY_MAX_ATTEMPTS } from './apple-music-uploads'
import { markAppleMusicDone } from './agent-queue'
import { addTrackToAppleMusic } from './library'
import { POST as copiesRoute } from '../app/api/agent/apple-music-copies/route'

const AGENT_TOKEN = 'apple-copies-agent-token'
let storageDir = ''

beforeAll(async () => {
  storageDir = await mkdtemp(nodePath.join(tmpdir(), 'tapedeck-apple-copies-'))
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('TAPEDECK_STORAGE_DIR', storageDir)
  vi.stubEnv('SESSION_SECRET', 'apple-copies-session-secret')
  vi.stubEnv('AGENT_TOKEN', AGENT_TOKEN)
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

let counter = 0

/** A ready uploaded song, the way finishUpload stores one. */
async function uploadedSong(options: { ext?: string; coverUrl?: string | null; appleMusic?: boolean; album?: string } = {}) {
  counter += 1
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  const ext = options.ext ?? 'flac'
  await sql`
    insert into tracks (id, source, source_id, source_url, raw_title, title, artist, album, album_artist, cover_url,
                        status, storage_key, bytes, ready_at, apple_music, created_at)
    values (${id}, 'upload', ${String(counter).repeat(64).slice(0, 64)}, '', ${`Song ${counter}`}, ${`Song ${counter}`},
            'Band', ${options.album ?? null}, ${options.album ? 'Band' : null}, ${options.coverUrl ?? null},
            'ready', ${`tracks/${id}.${ext}`}, 1000, now(), ${options.appleMusic ?? true},
            now() + make_interval(secs => ${counter}))`
  return id
}

describe('claimAppleMusicCopies', () => {
  it('hands out wanted copies, oldest first, with links to the stored file and cover', async () => {
    const first = await uploadedSong({ ext: 'flac', coverUrl: null, album: 'Live' })
    const second = await uploadedSong({ ext: 'mp3' })
    await sql`update tracks set cover_url = ${`/covers/${second}`} where id = ${second}`
    const third = await uploadedSong({ ext: 'm4a', coverUrl: 'https://covers.example/x.jpg' })

    const copies = await claimAppleMusicCopies()
    expect(copies.map((copy) => copy.id)).toEqual([first, second, third])
    expect(copies[0]).toMatchObject({ title: 'Song 1', artist: 'Band', album: 'Live', albumArtist: 'Band', format: 'flac', coverUrl: null })
    expect(copies[0]!.audioUrl).toContain(`/api/local-storage/tracks/${first}.flac?`)
    expect(copies[1]).toMatchObject({ format: 'mp3', album: null })
    expect(copies[1]!.coverUrl).toContain(`/api/local-storage/covers/${second}.jpg?`)
    expect(copies[2]).toMatchObject({ format: 'm4a', coverUrl: 'https://covers.example/x.jpg' })
  })

  it('only claims uploaded songs asked for Apple Music and not done yet', async () => {
    await uploadedSong({ appleMusic: false })
    const done = await uploadedSong()
    expect(await markAppleMusicDone(done)).toBe(true)
    await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, status, storage_key, apple_music)
      values ('youtube', 'abc', 'https://youtu.be/abc', 'Downloaded', 'Downloaded', 'ready', 'tracks/x.m4a', true)`
    expect(await claimAppleMusicCopies()).toEqual([])
  })

  it('waits before handing a claimed copy out again, and gives up after three tries', async () => {
    const id = await uploadedSong()
    expect(await claimAppleMusicCopies()).toHaveLength(1)
    expect(await claimAppleMusicCopies()).toEqual([]) // claimed a moment ago

    for (let attempt = 2; attempt <= COPY_MAX_ATTEMPTS; attempt += 1) {
      await sql`update tracks set claimed_at = now() - interval '16 minutes' where id = ${id}`
      expect(await claimAppleMusicCopies()).toHaveLength(1)
    }
    await sql`update tracks set claimed_at = now() - interval '16 minutes' where id = ${id}`
    expect(await claimAppleMusicCopies()).toEqual([])

    // Pressing Add to Apple Music again starts over.
    expect(await addTrackToAppleMusic(id)).toMatchObject({ id, appleMusic: true, status: 'ready' })
    expect(await claimAppleMusicCopies()).toHaveLength(1)
  })

  it('takes at most three at a time', async () => {
    for (let i = 0; i < 5; i += 1) await uploadedSong()
    expect(await claimAppleMusicCopies()).toHaveLength(3)
    expect(await claimAppleMusicCopies()).toHaveLength(2)
  })
})

describe('Add to Apple Music on an uploaded song', () => {
  it('keeps it ready, and a copy that was done is wanted again', async () => {
    const id = await uploadedSong({ appleMusic: false })
    expect(await claimAppleMusicCopies()).toEqual([])
    await sql`update tracks set apple_music_done_at = now() - interval '1 day' where id = ${id}`

    expect(await addTrackToAppleMusic(id)).toMatchObject({ appleMusic: true, status: 'ready' })
    const [row] = await sql`select status, apple_music_done_at, attempts from tracks where id = ${id}`
    expect(row).toMatchObject({ status: 'ready', apple_music_done_at: null, attempts: 0 })
    expect((await claimAppleMusicCopies()).map((copy) => copy.id)).toEqual([id])
  })
})

describe('POST /api/agent/apple-music-copies', () => {
  function post(token: string | null) {
    return copiesRoute(
      new Request('http://localhost/api/agent/apple-music-copies', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    )
  }

  it('needs the agent token', async () => {
    expect((await post(null)).status).toBe(401)
    expect((await post('wrong')).status).toBe(401)
  })

  it('answers with the claimed copies', async () => {
    const id = await uploadedSong({ ext: 'wav' })
    const response = await post(AGENT_TOKEN)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { copies: { id: string; format: string }[] }
    expect(body.copies).toMatchObject([{ id, format: 'wav' }])
    expect(((await (await post(AGENT_TOKEN)).json()) as { copies: unknown[] }).copies).toEqual([])
  })
})
