/**
 * Upload your own songs (T15), server side: the two upload steps, and how an
 * uploaded song then behaves everywhere else (playback URL, delete, restore,
 * the PC downloader, Apple Music). Real in-memory PGlite plus the local
 * storage stand-in in a temp folder; the "upload" is a file written there.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from './db'
import { finishUpload, startUpload, type FinishDeps } from './uploads'
import { claimTracks, retryTrack } from './agent-queue'
import { addTrackToAppleMusic, deleteTrack, getLibrarySnapshot } from './library'
import { MAX_UPLOAD_BYTES } from './upload-rules'
import { GET as playbackUrl } from '../app/api/tracks/[id]/url/route'
import { POST as restore } from '../app/api/tracks/[id]/restore/route'
import { POST as appleMusic } from '../app/api/tracks/[id]/apple-music/route'
import { POST as startRoute } from '../app/api/uploads/route'
import { POST as completeRoute } from '../app/api/uploads/[id]/complete/route'
import { GET as coverRoute } from '../app/covers/[id]/route'

const PRINT_A = 'a'.repeat(64)
const PRINT_B = 'b'.repeat(64)
const NO_LOOKUP: FinishDeps = { lookupCover: async () => null }
let storageDir = ''

beforeAll(async () => {
  storageDir = await mkdtemp(nodePath.join(tmpdir(), 'tapedeck-uploads-test-'))
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('TAPEDECK_STORAGE_DIR', storageDir)
  vi.stubEnv('SESSION_SECRET', 'uploads-test-session-secret')
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

/** What the browser PUT would have stored. */
async function putObject(key: string, bytes: number | string): Promise<void> {
  const file = nodePath.join(storageDir, ...key.split('/'))
  await mkdir(nodePath.dirname(file), { recursive: true })
  await writeFile(file, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 1))
}

async function exists(key: string): Promise<boolean> {
  return stat(nodePath.join(storageDir, ...key.split('/'))).then(
    () => true,
    () => false,
  )
}

/** Steps 1 and 2 with a file "uploaded" in between. */
async function upload(
  fileName: string,
  body: Record<string, unknown> = {},
  options: { fingerprint?: string; cover?: boolean; deps?: FinishDeps } = {},
) {
  const fingerprint = options.fingerprint ?? PRINT_A
  const start = await startUpload({ fileName, bytes: 1000, fingerprint, ...(options.cover ? { coverBytes: 50 } : {}) })
  if (start.status !== 'ready') throw new Error(`start said ${start.status}`)
  const ext = fileName.split('.').pop()!.toLowerCase()
  await putObject(`tracks/${start.id}.${ext}`, 1000)
  if (options.cover) await putObject(`covers/${start.id}.jpg`, 'jpeg')
  return finishUpload(start.id, { fileName, fingerprint, cover: options.cover === true, ...body }, options.deps ?? NO_LOOKUP)
}

describe('startUpload', () => {
  it('hands out a PUT URL for tracks/<new id>.<ext> with the right content type', async () => {
    const result = await startUpload({ fileName: 'Night Drive.FLAC', bytes: 1234, fingerprint: PRINT_A })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.contentType).toBe('audio/flac')
    expect(result.uploadUrl).toContain(`/api/local-storage/tracks/${result.id}.flac?`)
    expect(result.coverUploadUrl).toBeNull()
  })

  it('adds a cover URL when the file has cover art', async () => {
    const result = await startUpload({ fileName: 'a.mp3', bytes: 10, fingerprint: PRINT_A, coverBytes: 500 })
    expect(result.status === 'ready' && result.coverUploadUrl).toContain(`/covers/`)
  })

  it('refuses files that are not songs, too big, or empty, with friendly messages', async () => {
    expect(await startUpload({ fileName: 'notes.txt', bytes: 10, fingerprint: PRINT_A })).toEqual({
      status: 'error',
      httpStatus: 400,
      message: 'Not a song file. Upload MP3, M4A, WAV or FLAC.',
    })
    expect(await startUpload({ fileName: 'mix.wav', bytes: MAX_UPLOAD_BYTES + 1, fingerprint: PRINT_A })).toMatchObject({
      status: 'error',
      message: 'Too big. Songs can be up to 200 MB.',
    })
    expect(await startUpload({ fileName: 'a.mp3', bytes: 0, fingerprint: PRINT_A })).toMatchObject({ status: 'error' })
    expect(await startUpload({ fileName: 'a.mp3', bytes: 10, fingerprint: 'nope' })).toMatchObject({ status: 'error' })
    expect(
      await startUpload({ fileName: 'a.mp3', bytes: 10, fingerprint: PRINT_A, coverBytes: 9 * 1024 * 1024 }),
    ).toMatchObject({ status: 'error' })
  })

  it('says "Already in your library" for a file uploaded before, before any bytes move', async () => {
    const first = await upload('song.mp3')
    expect(first.status).toBe('added')
    const again = await startUpload({ fileName: 'copy of song.mp3', bytes: 1000, fingerprint: PRINT_A })
    expect(again).toMatchObject({ status: 'already', message: 'Already in your library' })
    expect(again.status === 'already' && first.status === 'added' && again.trackId).toBe(
      first.status === 'added' ? first.track.id : null,
    )
  })
})

describe('finishUpload', () => {
  it('adds the song ready to play with its tags, file size and length', async () => {
    const result = await upload('01 night.mp3', {
      title: 'Night Drive',
      artist: 'The Made Ups',
      album: 'Test Pressing',
      albumArtist: 'Various',
      durationSec: 187.6,
    })
    expect(result).toMatchObject({
      status: 'added',
      message: 'Added',
      track: { source: 'upload', title: 'Night Drive', artist: 'The Made Ups', album: 'Test Pressing', albumArtist: 'Various', durationSec: 188, status: 'ready' },
    })
    const [row] = await sql`select source, source_id, source_url, storage_key, bytes, ready_at, raw_title from tracks`
    expect(row).toMatchObject({ source: 'upload', source_id: PRINT_A, source_url: '', raw_title: 'Night Drive' })
    expect(String(row!.storage_key)).toMatch(/^tracks\/[0-9a-f-]{36}\.mp3$/)
    expect(Number(row!.bytes)).toBe(1000)
    expect(row!.ready_at).not.toBeNull()

    // It is an ordinary library song from here on.
    const snapshot = await getLibrarySnapshot()
    expect(snapshot.tracks[0]).toMatchObject({ source: 'upload', title: 'Night Drive', status: 'ready', bytes: 1000 })
  })

  it('names a song without tags after its file, and the album artist after the artist', async () => {
    const plain = await upload('Field Recording 7.wav')
    expect(plain).toMatchObject({ status: 'added', track: { title: 'Field Recording 7', artist: '', album: null, albumArtist: null } })
    const withAlbum = await upload('b.m4a', { artist: 'Solo', album: 'First' }, { fingerprint: PRINT_B })
    expect(withAlbum).toMatchObject({ track: { album: 'First', albumArtist: 'Solo' } })
  })

  it('keeps the cover from the file, served by the app at /covers/<id>', async () => {
    const result = await upload('a.mp3', { title: 'Covered', artist: 'X' }, { cover: true })
    if (result.status !== 'added') throw new Error(result.status)
    expect(result.track.coverUrl).toBe(`/covers/${result.track.id}`)

    const response = await coverRoute(new Request('http://localhost/covers/x'), { params: Promise.resolve({ id: result.track.id }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(await response.text()).toBe('jpeg')

    const missing = await coverRoute(new Request('http://localhost/covers/x'), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }),
    })
    expect(missing.status).toBe(404)
  })

  it('without a cover in the file, looks one up like a pasted link (album too when the tags had none)', async () => {
    const lookupCover = vi.fn(async () => ({ coverUrl: 'https://covers.example/1.jpg', album: 'Found Album', albumArtist: 'X' }))
    const result = await upload('a.mp3', { title: 'Song', artist: 'X' }, { deps: { lookupCover } })
    expect(lookupCover).toHaveBeenCalledWith('Song', 'X')
    expect(result).toMatchObject({ track: { coverUrl: 'https://covers.example/1.jpg', album: 'Found Album' } })

    // No artist: nothing to look up.
    const lookupNever = vi.fn(async () => null)
    await upload('b.mp3', {}, { fingerprint: PRINT_B, deps: { lookupCover: lookupNever } })
    expect(lookupNever).not.toHaveBeenCalled()
  })

  it('fails clearly when the file never arrived', async () => {
    const start = await startUpload({ fileName: 'a.mp3', bytes: 10, fingerprint: PRINT_A })
    if (start.status !== 'ready') throw new Error(start.status)
    expect(await finishUpload(start.id, { fileName: 'a.mp3', fingerprint: PRINT_A }, NO_LOOKUP)).toEqual({
      status: 'error',
      httpStatus: 409,
      message: 'The file did not finish uploading. Try again.',
    })
    expect(await sql`select 1 from tracks`).toHaveLength(0)
  })

  it('keeps the first copy when the same file finishes twice, and removes the second', async () => {
    await upload('a.mp3')
    const start = await startUpload({ fileName: 'a.mp3', bytes: 1000, fingerprint: PRINT_B })
    if (start.status !== 'ready') throw new Error(start.status)
    await putObject(`tracks/${start.id}.mp3`, 1000)
    // Same fingerprint as the first upload (two tabs, same file).
    const result = await finishUpload(start.id, { fileName: 'a.mp3', fingerprint: PRINT_A }, NO_LOOKUP)
    expect(result.status).toBe('already')
    expect(await exists(`tracks/${start.id}.mp3`)).toBe(false)
    expect(await sql`select 1 from tracks`).toHaveLength(1)
  })
})

describe('an uploaded song everywhere else', () => {
  async function added(fileName = 'Song.flac', options: { cover?: boolean } = {}) {
    const result = await upload(fileName, { title: 'Song', artist: 'Band' }, options)
    if (result.status !== 'added') throw new Error(result.status)
    return result.track.id
  }

  it('plays from its own file, and saves with its own extension', async () => {
    const id = await added()
    const ctx = { params: Promise.resolve({ id }) }
    const play = (await (await playbackUrl(new Request(`http://localhost/api/tracks/${id}/url`), ctx)).json()) as { url: string }
    expect(play.url).toContain(`/api/local-storage/tracks/${id}.flac?`)
    const save = (await (
      await playbackUrl(new Request(`http://localhost/api/tracks/${id}/url?download=1`), { params: Promise.resolve({ id }) })
    ).json()) as { url: string }
    expect(new URL(save.url, 'http://localhost').searchParams.get('name')).toBe('Band - Song.flac')
  })

  it('is never handed to the PC downloader, not even after Retry or Add to Apple Music', async () => {
    const id = await added()
    expect(await retryTrack(id)).toBe(true)
    expect(await addTrackToAppleMusic(id)).toMatchObject({ id, status: 'ready', appleMusic: true })
    const [row] = await sql`select status, apple_music from tracks where id = ${id}`
    expect(row).toMatchObject({ status: 'ready', apple_music: true })
    await sql`update tracks set status = 'waiting' where id = ${id}` // even if something requeued it
    expect(await claimTracks(3, ['catalog'])).toEqual([])
  })

  it('Add to Apple Music keeps it ready; the PC copies the stored file (apple-music-uploads.ts)', async () => {
    const id = await added()
    const response = await appleMusic(new Request('http://localhost'), { params: Promise.resolve({ id }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id, status: 'ready', appleMusic: true })
  })

  it('is marked for Apple Music when uploaded with "Also add to Apple Music" on', async () => {
    await sql`update settings set apple_music_export = true where id = 1`
    try {
      const id = await added()
      const [row] = await sql`select apple_music from tracks where id = ${id}`
      expect(row).toMatchObject({ apple_music: true })
    } finally {
      await sql`update settings set apple_music_export = false where id = 1`
    }
    const later = await upload('later.mp3', {}, { fingerprint: PRINT_B })
    if (later.status !== 'added') throw new Error(later.status)
    const [row] = await sql`select apple_music from tracks where id = ${later.track.id}`
    expect(row).toMatchObject({ apple_music: false })
  })

  it('Restore original brings back the title, artist and cover from the file', async () => {
    const id = await added('a.mp3', { cover: true })
    await sql`update tracks set title = 'Renamed', artist = 'Someone', cover_url = null where id = ${id}`
    const response = await restore(new Request('http://localhost'), { params: Promise.resolve({ id }) })
    expect(await response.json()).toMatchObject({ title: 'Song', artist: 'Band', coverUrl: `/covers/${id}` })
  })

  it('Delete removes the song file and its cover', async () => {
    const id = await added('a.wav', { cover: true })
    expect(await exists(`tracks/${id}.wav`)).toBe(true)
    expect(await exists(`covers/${id}.jpg`)).toBe(true)
    expect(await deleteTrack(id)).toEqual({ found: true, storageKey: `tracks/${id}.wav` })
    expect(await exists(`tracks/${id}.wav`)).toBe(false)
    expect(await exists(`covers/${id}.jpg`)).toBe(false)
  })
})

describe('upload routes', () => {
  const post = (url: string, body: unknown) =>
    new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('start answers 400 with the friendly message, and ready with the URLs', async () => {
    const bad = await startRoute(post('http://localhost/api/uploads', { fileName: 'cat.jpg', bytes: 10, fingerprint: PRINT_A }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Not a song file. Upload MP3, M4A, WAV or FLAC.' })

    const ok = await startRoute(post('http://localhost/api/uploads', { fileName: 'a.mp3', bytes: 10, fingerprint: PRINT_A }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ status: 'ready', contentType: 'audio/mpeg' })
  })

  it('complete adds the song, and refuses a bad id', async () => {
    const start = await startUpload({ fileName: 'a.mp3', bytes: 1000, fingerprint: PRINT_A })
    if (start.status !== 'ready') throw new Error(start.status)
    await putObject(`tracks/${start.id}.mp3`, 1000)
    const ctx = { params: Promise.resolve({ id: start.id }) }
    const response = await completeRoute(
      post(`http://localhost/api/uploads/${start.id}/complete`, { fileName: 'a.mp3', fingerprint: PRINT_A, title: 'Routed' }),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'added', track: { title: 'Routed' } })

    const bad = await completeRoute(post('http://localhost/x', {}), { params: Promise.resolve({ id: 'nope' }) })
    expect(bad.status).toBe(400)
  })
})
