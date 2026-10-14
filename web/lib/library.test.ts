/**
 * Unit tests for the library data layer (SPEC 8.6): snapshot, likes, delete,
 * playlists, favourite albums, plays and profile stats. Real in-memory PGlite
 * (TAPEDECK_TEST=1), one database for this file, wiped before every test.
 * Storage is the local stand-in pointed at a temp folder.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from './db'
import { getStorage } from './storage'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PLAY_SECONDS,
  RECENTLY_PLAYED_LIMIT,
  addToPlaylist,
  cleanName,
  createPlaylist,
  deletePlaylist,
  deleteTrack,
  getLibrarySnapshot,
  getProfile,
  recordPlay,
  removeFromPlaylist,
  reorderPlaylist,
  setAlbumFavorite,
  setDisplayName,
  setLiked,
  updatePlaylist,
} from './library'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
let storageDir = ''
let sourceCounter = 0

beforeAll(async () => {
  storageDir = await mkdtemp(nodePath.join(tmpdir(), 'tapedeck-library-test-'))
  // Set before any query or storage call: both pick their driver on first use.
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('TAPEDECK_STORAGE_DIR', storageDir)
  vi.stubEnv('SESSION_SECRET', 'library-test-session-secret')
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
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events, search_cache`
  await sql`update settings set display_name = 'Denis', agent_last_seen = null, apple_music_export = false where id = 1`
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface TrackSeed {
  title?: string
  artist?: string
  album?: string | null
  albumArtist?: string | null
  status?: string
  hoursAgo?: number
  storageKey?: string | null
  bytes?: number | null
}

async function insertTrack(seed: TrackSeed = {}): Promise<string> {
  sourceCounter += 1
  const sourceId = `src${String(sourceCounter).padStart(8, '0')}`
  const title = seed.title ?? `Song ${sourceCounter}`
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, artist, album, album_artist, status,
                        storage_key, bytes, created_at)
    values ('youtube', ${sourceId}, ${`https://www.youtube.com/watch?v=${sourceId}`}, ${title}, ${title},
            ${seed.artist ?? 'Someone'}, ${seed.album ?? null}, ${seed.albumArtist ?? null}, ${seed.status ?? 'ready'},
            ${seed.storageKey ?? null}, ${seed.bytes ?? null},
            now() - make_interval(hours => ${seed.hoursAgo ?? 0}))
    returning id
  `
  return String(rows[0].id)
}

async function insertPlay(trackId: string | null, seconds: number, playedAt: Date): Promise<void> {
  await sql`
    insert into play_events (track_id, seconds_listened, played_at)
    values (${trackId}, ${seconds}, ${playedAt.toISOString()}::timestamptz)
  `
}

/** Midnight on the 1st of the current month, Chicago time, as a UTC instant. */
function chicagoMonthStart(now = new Date()): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const part = (date: Date, type: string): string => fmt.formatToParts(date).find((p) => p.type === type)?.value ?? ''
  const year = Number(part(now, 'year'))
  const month = Number(part(now, 'month'))
  // Chicago is UTC-5 (CDT) or UTC-6 (CST); exactly one candidate is midnight there.
  for (const offset of [5, 6]) {
    const candidate = new Date(Date.UTC(year, month - 1, 1, offset))
    if (part(candidate, 'day') === '01' && part(candidate, 'hour') === '00') return candidate
  }
  throw new Error('Could not find the Chicago month start')
}

const MINUTE = 60_000

// ---------------------------------------------------------------------------

describe('getLibrarySnapshot', () => {
  it('returns an empty library with the default name and downloader snapshot', async () => {
    const snapshot = await getLibrarySnapshot()
    expect(snapshot.tracks).toEqual([])
    expect(snapshot.playlists).toEqual([])
    expect(snapshot.favoriteAlbums).toEqual([])
    expect(snapshot.recentlyPlayed).toEqual([])
    expect(snapshot.displayName).toBe('Denis')
    expect(snapshot.appleMusicExport).toBe(false)
    expect(snapshot.downloader).toEqual({ lastSeenAt: null, waitingCount: 0 })
  })

  it('lists tracks newest first with their fields', async () => {
    await insertTrack({ title: 'Oldest', hoursAgo: 3 })
    await insertTrack({ title: 'Newest', hoursAgo: 0, album: 'LP', albumArtist: 'Band', bytes: 1234 })
    await insertTrack({ title: 'Middle', hoursAgo: 1 })

    const snapshot = await getLibrarySnapshot()
    expect(snapshot.tracks.map((t) => t.title)).toEqual(['Newest', 'Middle', 'Oldest'])
    const newest = snapshot.tracks[0]
    expect(newest.source).toBe('youtube')
    expect(newest.album).toBe('LP')
    expect(newest.albumArtist).toBe('Band')
    expect(newest.bytes).toBe(1234)
    expect(newest.liked).toBe(false)
    expect(newest.likedAt).toBeNull()
    expect(newest.appleMusic).toBe(false)
    expect(Number.isNaN(Date.parse(newest.createdAt ?? ''))).toBe(false)
  })

  it('lists playlists by position with their track ids in playlist order', async () => {
    const a = await insertTrack({ title: 'A' })
    const b = await insertTrack({ title: 'B' })
    const c = await insertTrack({ title: 'C' })
    const first = await createPlaylist('First')
    const second = await createPlaylist('Second', 'about it')
    await addToPlaylist(first.id, [c, a, b])

    const snapshot = await getLibrarySnapshot()
    expect(snapshot.playlists.map((p) => p.name)).toEqual(['First', 'Second'])
    expect(snapshot.playlists[0].trackIds).toEqual([c, a, b])
    expect(snapshot.playlists[1]).toMatchObject({ id: second.id, description: 'about it', position: 1, trackIds: [] })
  })

  it('lists favourite albums newest first', async () => {
    await sql`insert into album_favorites (album, album_artist, created_at) values ('Old LP', 'X', now() - interval '1 day')`
    await sql`insert into album_favorites (album, album_artist, created_at) values ('New LP', 'Y', now())`
    const snapshot = await getLibrarySnapshot()
    expect(snapshot.favoriteAlbums.map((f) => [f.album, f.albumArtist])).toEqual([
      ['New LP', 'Y'],
      ['Old LP', 'X'],
    ])
    expect(snapshot.favoriteAlbums[0].createdAt).not.toBeNull()
  })

  it('reports the last 20 distinct played tracks, most recent first', async () => {
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push(await insertTrack({ title: `T${i}` }))
    const base = Date.now() - 10 * 24 * 60 * MINUTE
    // Track i is played at base + i minutes, so higher i is more recent.
    for (let i = 0; i < 25; i++) await insertPlay(ids[i], 40, new Date(base + i * MINUTE))
    // Replaying track 0 moves it to the top; it must appear once.
    await insertPlay(ids[0], 40, new Date(base + 100 * MINUTE))
    // A play whose track was deleted (null track) never shows.
    await insertPlay(null, 40, new Date(base + 200 * MINUTE))

    const snapshot = await getLibrarySnapshot()
    expect(snapshot.recentlyPlayed).toHaveLength(RECENTLY_PLAYED_LIMIT)
    const expected = [ids[0], ...ids.slice(6).reverse()]
    expect(snapshot.recentlyPlayed).toEqual(expected)
    expect(new Set(snapshot.recentlyPlayed).size).toBe(RECENTLY_PLAYED_LIMIT)
  })

  it('reports the display name, Apple Music flag and waiting count', async () => {
    await insertTrack({ status: 'waiting' })
    await insertTrack({ status: 'waiting' })
    await insertTrack({ status: 'downloading' })
    await insertTrack({ status: 'ready' })
    await sql`update settings set display_name = 'Dee', apple_music_export = true, agent_last_seen = now() where id = 1`

    const snapshot = await getLibrarySnapshot()
    expect(snapshot.displayName).toBe('Dee')
    expect(snapshot.appleMusicExport).toBe(true)
    expect(snapshot.downloader.waitingCount).toBe(2)
    expect(Math.abs(Date.parse(snapshot.downloader.lastSeenAt ?? '') - Date.now())).toBeLessThan(60_000)
  })
})

// ---------------------------------------------------------------------------

describe('setLiked', () => {
  it('sets liked and liked_at when liking', async () => {
    const id = await insertTrack()
    const track = await setLiked(id, true)
    expect(track?.id).toBe(id)
    expect(track?.liked).toBe(true)
    expect(Math.abs(Date.parse(track?.likedAt ?? '') - Date.now())).toBeLessThan(60_000)
  })

  it('keeps the original liked_at when liking an already liked song', async () => {
    const id = await insertTrack()
    await setLiked(id, true)
    await sql`update tracks set liked_at = '2020-01-02T03:04:05Z' where id = ${id}`
    const again = await setLiked(id, true)
    expect(again?.liked).toBe(true)
    expect(again?.likedAt).toBe('2020-01-02T03:04:05.000Z')
  })

  it('clears liked_at when unliking, and a later like gets a fresh time', async () => {
    const id = await insertTrack()
    await setLiked(id, true)
    await sql`update tracks set liked_at = '2020-01-02T03:04:05Z' where id = ${id}`
    const unliked = await setLiked(id, false)
    expect(unliked?.liked).toBe(false)
    expect(unliked?.likedAt).toBeNull()
    const relike = await setLiked(id, true)
    expect(Math.abs(Date.parse(relike?.likedAt ?? '') - Date.now())).toBeLessThan(60_000)
  })

  it('returns null for an unknown track', async () => {
    expect(await setLiked(UNKNOWN_ID, true)).toBeNull()
    expect(await setLiked(UNKNOWN_ID, false)).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('deleteTrack', () => {
  async function storeFile(key: string): Promise<string> {
    const filePath = nodePath.join(storageDir, ...key.split('/'))
    await mkdir(nodePath.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'fake audio')
    return filePath
  }

  async function exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath)
      return true
    } catch {
      return false
    }
  }

  it('removes the stored file through storage first, then the row', async () => {
    const key = 'tracks/delete-me.m4a'
    const filePath = await storeFile(key)
    const id = await insertTrack({ storageKey: key, bytes: 10 })

    const driver = getStorage()
    const original = driver.delete.bind(driver)
    let rowCountDuringDelete = -1
    const spy = vi.spyOn(driver, 'delete').mockImplementation(async (k: string) => {
      const rows = await sql`select 1 from tracks where id = ${id}`
      rowCountDuringDelete = rows.length
      await original(k)
    })

    const result = await deleteTrack(id)
    expect(result).toEqual({ found: true, storageKey: key })
    expect(spy).toHaveBeenCalledWith(key)
    expect(rowCountDuringDelete).toBe(1)
    expect(await exists(filePath)).toBe(false)
    expect(await sql`select 1 from tracks where id = ${id}`).toHaveLength(0)
  })

  it('leaves the song in place when the storage delete fails', async () => {
    const id = await insertTrack({ storageKey: 'tracks/stuck.m4a' })
    vi.spyOn(getStorage(), 'delete').mockRejectedValueOnce(new Error('storage down'))
    await expect(deleteTrack(id)).rejects.toThrow('storage down')
    expect(await sql`select 1 from tracks where id = ${id}`).toHaveLength(1)
  })

  it('skips storage for a song with no stored file', async () => {
    const id = await insertTrack({ status: 'waiting' })
    const spy = vi.spyOn(getStorage(), 'delete')
    expect(await deleteTrack(id)).toEqual({ found: true, storageKey: null })
    expect(spy).not.toHaveBeenCalled()
  })

  it('cascades playlist entries and keeps play events with a null track', async () => {
    const id = await insertTrack()
    const other = await insertTrack()
    const playlist = await createPlaylist('Mix')
    await addToPlaylist(playlist.id, [id, other])
    await recordPlay(id, 90)

    await deleteTrack(id)
    expect(await sql`select track_id from playlist_tracks where playlist_id = ${playlist.id}`).toEqual([
      { track_id: other },
    ])
    const plays = await sql`select track_id, seconds_listened from play_events`
    expect(plays).toEqual([{ track_id: null, seconds_listened: 90 }])
    expect((await getProfile()).stats.secondsListened).toBe(90)
  })

  it('reports found false for an unknown id', async () => {
    expect(await deleteTrack(UNKNOWN_ID)).toEqual({ found: false, storageKey: null })
  })
})

// ---------------------------------------------------------------------------

describe('cleanName', () => {
  it('rejects non-strings and blank strings', () => {
    expect(cleanName(undefined)).toBeNull()
    expect(cleanName(null)).toBeNull()
    expect(cleanName(42)).toBeNull()
    expect(cleanName('')).toBeNull()
    expect(cleanName('   \n\t ')).toBeNull()
  })

  it('trims and collapses whitespace', () => {
    expect(cleanName('  Road   trip \n mix ')).toBe('Road trip mix')
  })

  it('caps the length', () => {
    expect(cleanName('x'.repeat(MAX_NAME_LENGTH + 50))).toBe('x'.repeat(MAX_NAME_LENGTH))
  })
})

// ---------------------------------------------------------------------------

describe('createPlaylist', () => {
  it('gives each new playlist the next position', async () => {
    const a = await createPlaylist('A')
    const b = await createPlaylist('B', 'second one')
    const c = await createPlaylist('C')
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2])
    expect(a).toMatchObject({ name: 'A', description: '', trackIds: [] })
    expect(b.description).toBe('second one')
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.createdAt).not.toBeNull()
  })

  it('continues after the highest position even with gaps', async () => {
    await createPlaylist('A')
    const b = await createPlaylist('B')
    await deletePlaylist((await createPlaylist('gone')).id)
    await sql`update playlists set position = 7 where id = ${b.id}`
    expect((await createPlaylist('Next')).position).toBe(8)
  })

  it('caps the description', async () => {
    const p = await createPlaylist('Long', 'd'.repeat(MAX_DESCRIPTION_LENGTH + 20))
    expect(p.description).toHaveLength(MAX_DESCRIPTION_LENGTH)
  })
})

describe('updatePlaylist', () => {
  it('renames and keeps the description, and bumps updated_at', async () => {
    const p = await createPlaylist('Old', 'desc')
    await sql`update playlists set updated_at = '2020-01-01T00:00:00Z' where id = ${p.id}`
    expect(await updatePlaylist(p.id, { name: 'New' })).toBe(true)
    const [row] = await sql`select name, description, updated_at from playlists where id = ${p.id}`
    expect(row.name).toBe('New')
    expect(row.description).toBe('desc')
    expect(new Date(row.updated_at as string).getTime()).toBeGreaterThan(Date.parse('2021-01-01'))
  })

  it('changes only the description when no name is given', async () => {
    const p = await createPlaylist('Keep me', 'old')
    expect(await updatePlaylist(p.id, { description: 'new' })).toBe(true)
    const [row] = await sql`select name, description from playlists where id = ${p.id}`
    expect(row).toEqual({ name: 'Keep me', description: 'new' })
  })

  it('can clear the description with an empty string', async () => {
    const p = await createPlaylist('P', 'old')
    await updatePlaylist(p.id, { description: '' })
    const [row] = await sql`select description from playlists where id = ${p.id}`
    expect(row.description).toBe('')
  })

  it('returns false for an unknown playlist', async () => {
    expect(await updatePlaylist(UNKNOWN_ID, { name: 'x' })).toBe(false)
  })
})

describe('deletePlaylist', () => {
  it('removes the playlist and its entries but keeps the songs', async () => {
    const id = await insertTrack()
    const p = await createPlaylist('Bye')
    await addToPlaylist(p.id, [id])
    expect(await deletePlaylist(p.id)).toBe(true)
    expect(await sql`select 1 from playlists where id = ${p.id}`).toHaveLength(0)
    expect(await sql`select 1 from playlist_tracks`).toHaveLength(0)
    expect(await sql`select 1 from tracks where id = ${id}`).toHaveLength(1)
  })

  it('returns false for an unknown playlist', async () => {
    expect(await deletePlaylist(UNKNOWN_ID)).toBe(false)
  })
})

describe('addToPlaylist', () => {
  async function order(playlistId: string): Promise<string[]> {
    const snapshot = await getLibrarySnapshot()
    return snapshot.playlists.find((p) => p.id === playlistId)?.trackIds ?? []
  }

  it('appends in the given order across calls', async () => {
    const [a, b, c] = [await insertTrack(), await insertTrack(), await insertTrack()]
    const p = await createPlaylist('P')
    expect(await addToPlaylist(p.id, [b, a])).toEqual({ found: true, added: 2 })
    expect(await addToPlaylist(p.id, [c])).toEqual({ found: true, added: 1 })
    expect(await order(p.id)).toEqual([b, a, c])
  })

  it('ignores songs already in the playlist and keeps their place', async () => {
    const [a, b] = [await insertTrack(), await insertTrack()]
    const p = await createPlaylist('P')
    await addToPlaylist(p.id, [a, b])
    expect(await addToPlaylist(p.id, [a, a])).toEqual({ found: true, added: 0 })
    expect(await order(p.id)).toEqual([a, b])
  })

  it('skips ids that are not in the library', async () => {
    const a = await insertTrack()
    const p = await createPlaylist('P')
    expect(await addToPlaylist(p.id, [UNKNOWN_ID, a])).toEqual({ found: true, added: 1 })
    expect(await order(p.id)).toEqual([a])
  })

  it('reports found false for an unknown playlist', async () => {
    const a = await insertTrack()
    expect(await addToPlaylist(UNKNOWN_ID, [a])).toEqual({ found: false, added: 0 })
    expect(await sql`select 1 from playlist_tracks`).toHaveLength(0)
  })
})

describe('removeFromPlaylist', () => {
  it('removes one entry and keeps the song in the library', async () => {
    const [a, b] = [await insertTrack(), await insertTrack()]
    const p = await createPlaylist('P')
    await addToPlaylist(p.id, [a, b])
    expect(await removeFromPlaylist(p.id, a)).toBe(true)
    expect(await sql`select track_id from playlist_tracks where playlist_id = ${p.id}`).toEqual([{ track_id: b }])
    expect(await sql`select 1 from tracks where id = ${a}`).toHaveLength(1)
  })

  it('returns false when the song is not in the playlist or the playlist is unknown', async () => {
    const a = await insertTrack()
    const p = await createPlaylist('P')
    expect(await removeFromPlaylist(p.id, a)).toBe(false)
    expect(await removeFromPlaylist(UNKNOWN_ID, a)).toBe(false)
  })
})

describe('reorderPlaylist', () => {
  async function setup(): Promise<{ playlistId: string; ids: string[] }> {
    const ids = [await insertTrack(), await insertTrack(), await insertTrack()]
    const p = await createPlaylist('P')
    await addToPlaylist(p.id, ids)
    return { playlistId: p.id, ids }
  }

  it('saves the new order', async () => {
    const { playlistId, ids } = await setup()
    const [a, b, c] = ids
    expect(await reorderPlaylist(playlistId, [c, a, b])).toBe('ok')
    const snapshot = await getLibrarySnapshot()
    expect(snapshot.playlists[0].trackIds).toEqual([c, a, b])
  })

  it('accepts an empty order for an empty playlist', async () => {
    const p = await createPlaylist('Empty')
    expect(await reorderPlaylist(p.id, [])).toBe('ok')
  })

  it('returns not_found for an unknown playlist', async () => {
    expect(await reorderPlaylist(UNKNOWN_ID, [])).toBe('not_found')
  })

  it('returns mismatch for missing, extra or duplicate ids and keeps the order', async () => {
    const { playlistId, ids } = await setup()
    const [a, b, c] = ids
    const outside = await insertTrack()
    expect(await reorderPlaylist(playlistId, [a, b])).toBe('mismatch')
    expect(await reorderPlaylist(playlistId, [a, b, c, outside])).toBe('mismatch')
    expect(await reorderPlaylist(playlistId, [a, b, outside])).toBe('mismatch')
    expect(await reorderPlaylist(playlistId, [c, c, b, a])).toBe('mismatch')
    expect(await reorderPlaylist(playlistId, [a, a, b])).toBe('mismatch')
    const snapshot = await getLibrarySnapshot()
    expect(snapshot.playlists[0].trackIds).toEqual([a, b, c])
  })
})

// ---------------------------------------------------------------------------

describe('setAlbumFavorite', () => {
  it('is idempotent when turning on', async () => {
    await setAlbumFavorite('LP', 'Band', true)
    await setAlbumFavorite('LP', 'Band', true)
    const snapshot = await getLibrarySnapshot()
    expect(snapshot.favoriteAlbums.map((f) => [f.album, f.albumArtist])).toEqual([['LP', 'Band']])
  })

  it('turns off only the matching album', async () => {
    await setAlbumFavorite('LP', 'Band', true)
    await setAlbumFavorite('LP', 'Other band', true)
    await setAlbumFavorite('LP', 'Band', false)
    const rows = await sql`select album, album_artist from album_favorites`
    expect(rows).toEqual([{ album: 'LP', album_artist: 'Other band' }])
  })

  it('turning off a missing favourite is a no-op', async () => {
    await expect(setAlbumFavorite('Nope', '', false)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('recordPlay', () => {
  it('records a play now with rounded seconds', async () => {
    const id = await insertTrack()
    expect(await recordPlay(id, 31.6)).toBe(true)
    const [row] = await sql`select track_id, seconds_listened, played_at from play_events`
    expect(row.track_id).toBe(id)
    expect(row.seconds_listened).toBe(32)
    expect(Math.abs(new Date(row.played_at as string).getTime() - Date.now())).toBeLessThan(60_000)
  })

  it('clamps seconds to 0 .. MAX_PLAY_SECONDS', async () => {
    const id = await insertTrack()
    await recordPlay(id, -10)
    await recordPlay(id, MAX_PLAY_SECONDS + 1000)
    const rows = await sql`select seconds_listened from play_events order by seconds_listened`
    expect(rows.map((r) => r.seconds_listened)).toEqual([0, MAX_PLAY_SECONDS])
  })

  it('returns false and records nothing for an unknown track', async () => {
    expect(await recordPlay(UNKNOWN_ID, 40)).toBe(false)
    expect(await sql`select 1 from play_events`).toHaveLength(0)
  })

  it('honours playedAt for offline plays', async () => {
    const id = await insertTrack()
    const when = new Date('2025-03-04T05:06:07.000Z')
    await recordPlay(id, 40, when)
    const [row] = await sql`select played_at from play_events`
    expect(new Date(row.played_at as string).toISOString()).toBe(when.toISOString())
  })
})

// ---------------------------------------------------------------------------

describe('getProfile', () => {
  it('returns zeros and the default name for an empty library', async () => {
    expect(await getProfile()).toEqual({
      displayName: 'Denis',
      stats: { songs: 0, secondsListened: 0, playsThisMonth: 0, storageBytes: 0 },
      topArtists: [],
    })
  })

  it('counts songs, stored bytes and all-time listening', async () => {
    const a = await insertTrack({ bytes: 1000 })
    await insertTrack({ bytes: 2500 })
    await insertTrack({ status: 'waiting' })
    await insertPlay(a, 100, new Date('2024-01-15T12:00:00Z'))
    await insertPlay(a, 50, new Date())

    const profile = await getProfile()
    expect(profile.stats.songs).toBe(3)
    expect(profile.stats.storageBytes).toBe(3500)
    expect(profile.stats.secondsListened).toBe(150)
  })

  it('counts plays from midnight on the 1st, Chicago time', async () => {
    const a = await insertTrack()
    const start = chicagoMonthStart()
    // Just before the Chicago month start is still on the 1st in UTC, so a UTC
    // month boundary would count it; Chicago time must not.
    await insertPlay(a, 30, new Date(start.getTime() - MINUTE))
    await insertPlay(a, 30, new Date(start.getTime() + MINUTE))
    await insertPlay(a, 30, new Date(start.getTime()))
    await insertPlay(null, 30, new Date(start.getTime() + 2 * MINUTE))

    const profile = await getProfile()
    expect(profile.stats.playsThisMonth).toBe(3)
    expect(profile.stats.secondsListened).toBe(120)
  })

  it('lists the top 5 artists this month by plays, then name, without blank artists', async () => {
    const start = chicagoMonthStart()
    const inMonth = new Date(start.getTime() + MINUTE)
    const lastMonth = new Date(start.getTime() - MINUTE)
    const plays: Record<string, number> = { Zed: 4, Abba: 3, Beck: 3, Cher: 2, Dido: 1, Enya: 1 }
    for (const [artist, count] of Object.entries(plays)) {
      const id = await insertTrack({ artist })
      for (let i = 0; i < count; i++) await insertPlay(id, 30, inMonth)
    }
    const blank = await insertTrack({ artist: '' })
    for (let i = 0; i < 9; i++) await insertPlay(blank, 30, inMonth)
    const old = await insertTrack({ artist: 'Old favourite' })
    for (let i = 0; i < 9; i++) await insertPlay(old, 30, lastMonth)

    const profile = await getProfile()
    expect(profile.topArtists).toEqual([
      { artist: 'Zed', plays: 4 },
      { artist: 'Abba', plays: 3 },
      { artist: 'Beck', plays: 3 },
      { artist: 'Cher', plays: 2 },
      { artist: 'Dido', plays: 1 },
    ])
  })

  it('groups plays across several songs by the same artist', async () => {
    const a = await insertTrack({ artist: 'Same' })
    const b = await insertTrack({ artist: 'Same' })
    await recordPlay(a, 30)
    await recordPlay(b, 30)
    expect((await getProfile()).topArtists).toEqual([{ artist: 'Same', plays: 2 }])
  })
})

describe('setDisplayName', () => {
  it('saves the name shown by the profile and the snapshot', async () => {
    await setDisplayName('Dennis P')
    expect((await getProfile()).displayName).toBe('Dennis P')
    expect((await getLibrarySnapshot()).displayName).toBe('Dennis P')
  })
})
