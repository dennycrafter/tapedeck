/**
 * Library data layer (SPEC 8.6): songs, liked songs, playlists, favourite
 * albums, recently played, plays and profile stats. Server only, through the
 * one `sql` adapter (SPEC 4), so it runs the same on PGlite and Supabase.
 *
 * GET /api/library returns one snapshot built here. The phone keeps that
 * snapshot for offline use (SPEC 8.9), so everything the library screens
 * need is in it: albums and artists are grouped on the client from the
 * tracks.
 */
import { sql, type Row } from './db'
import { getStorage } from './storage'

/** "Today" and "this month" are Chicago time (SPEC 3). */
export const APP_TIMEZONE = 'America/Chicago'
/** R2 free tier (SPEC 3); the profile shows "3.2 of 10 GB". */
export const STORAGE_LIMIT_BYTES = 10 * 1024 ** 3
/** Amber dot at 8 GB or more (SPEC 8.6). */
export const STORAGE_WARN_BYTES = 8 * 1024 ** 3
/** Recently played: last 20 distinct tracks (SPEC 8.6). */
export const RECENTLY_PLAYED_LIMIT = 20
export const MAX_NAME_LENGTH = 100
export const MAX_DESCRIPTION_LENGTH = 300
/** A single play can never be longer than this (bounds bad input). */
export const MAX_PLAY_SECONDS = 6 * 60 * 60

export interface LibraryTrack {
  id: string
  source: 'youtube' | 'soundcloud'
  sourceUrl: string
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  coverUrl: string | null
  durationSec: number | null
  status: string
  error: string
  createdAt: string | null
  liked: boolean
  likedAt: string | null
  bytes: number | null
  appleMusic: boolean
}

export interface LibraryPlaylist {
  id: string
  name: string
  description: string
  position: number
  createdAt: string | null
  updatedAt: string | null
  /** Track ids in playlist order. */
  trackIds: string[]
}

export interface FavoriteAlbum {
  album: string
  albumArtist: string
  createdAt: string | null
}

export interface LibrarySnapshot {
  tracks: LibraryTrack[]
  playlists: LibraryPlaylist[]
  favoriteAlbums: FavoriteAlbum[]
  /** Track ids, most recent first, distinct, at most 20. */
  recentlyPlayed: string[]
  displayName: string
  appleMusicExport: boolean
  downloader: { lastSeenAt: string | null; waitingCount: number }
}

export function toIso(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  const text = String(value)
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString()
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function trackFromRow(row: Row): LibraryTrack {
  return {
    id: String(row.id),
    source: row.source === 'soundcloud' ? 'soundcloud' : 'youtube',
    sourceUrl: String(row.source_url),
    title: String(row.title),
    artist: String(row.artist ?? ''),
    album: row.album == null ? null : String(row.album),
    albumArtist: row.album_artist == null ? null : String(row.album_artist),
    coverUrl: row.cover_url == null ? null : String(row.cover_url),
    durationSec: toNumberOrNull(row.duration_sec),
    status: String(row.status),
    error: String(row.error ?? ''),
    createdAt: toIso(row.created_at),
    liked: row.liked === true,
    likedAt: toIso(row.liked_at),
    bytes: toNumberOrNull(row.bytes),
    appleMusic: row.apple_music === true,
  }
}

export async function getLibrarySnapshot(): Promise<LibrarySnapshot> {
  const trackRows = await sql`
    select id, source, source_url, title, artist, album, album_artist, cover_url,
           duration_sec, status, error, created_at, liked, liked_at, bytes, apple_music
    from tracks
    order by created_at desc, id desc
  `
  const playlistRows = await sql`
    select id, name, description, position, created_at, updated_at
    from playlists
    order by position asc, created_at asc
  `
  const entryRows = await sql`
    select playlist_id, track_id
    from playlist_tracks
    order by playlist_id, position asc, added_at asc
  `
  const favoriteRows = await sql`
    select album, album_artist, created_at from album_favorites order by created_at desc
  `
  const recentRows = await sql`
    select track_id from (
      select track_id, max(played_at) as last_played
      from play_events
      where track_id is not null
      group by track_id
    ) recent
    order by last_played desc
    limit ${RECENTLY_PLAYED_LIMIT}
  `
  const settingsRows = await sql`
    select display_name, apple_music_export, agent_last_seen from settings where id = 1
  `
  const waitingRows = await sql`select count(*) as count from tracks where status = 'waiting'`

  const byPlaylist = new Map<string, string[]>()
  for (const row of entryRows) {
    const list = byPlaylist.get(String(row.playlist_id)) ?? []
    list.push(String(row.track_id))
    byPlaylist.set(String(row.playlist_id), list)
  }
  const settings = settingsRows[0] ?? {}

  return {
    tracks: trackRows.map(trackFromRow),
    playlists: playlistRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      position: Number(row.position ?? 0),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      trackIds: byPlaylist.get(String(row.id)) ?? [],
    })),
    favoriteAlbums: favoriteRows.map((row) => ({
      album: String(row.album),
      albumArtist: String(row.album_artist),
      createdAt: toIso(row.created_at),
    })),
    recentlyPlayed: recentRows.map((row) => String(row.track_id)),
    displayName: String(settings.display_name ?? 'Denis'),
    appleMusicExport: settings.apple_music_export === true,
    downloader: {
      lastSeenAt: toIso(settings.agent_last_seen),
      waitingCount: Number(waitingRows[0]?.count ?? 0),
    },
  }
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** Heart on any track; `liked_at` sets the Liked songs order (SPEC 8.6). */
export async function setLiked(trackId: string, liked: boolean): Promise<LibraryTrack | null> {
  const rows = liked
    ? await sql`
        update tracks set liked = true, liked_at = coalesce(case when liked then liked_at end, now())
        where id = ${trackId}
        returning *
      `
    : await sql`update tracks set liked = false, liked_at = null where id = ${trackId} returning *`
  return rows[0] ? trackFromRow(rows[0]) : null
}

/**
 * Delete song (SPEC 8.6): the stored audio file, then the row (playlist
 * entries cascade; play_events keep the listening time with a null track).
 * The file goes first so a storage failure leaves the song in place to retry
 * rather than an orphaned file nobody can see.
 */
export async function deleteTrack(trackId: string): Promise<{ found: boolean; storageKey: string | null }> {
  const rows = await sql`select storage_key from tracks where id = ${trackId}`
  if (!rows[0]) return { found: false, storageKey: null }
  const storageKey = rows[0].storage_key == null ? null : String(rows[0].storage_key)
  if (storageKey) await getStorage().delete(storageKey)
  await sql`delete from tracks where id = ${trackId}`
  return { found: true, storageKey }
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : null
}

export async function createPlaylist(name: string, description = ''): Promise<LibraryPlaylist> {
  const rows = await sql`
    insert into playlists (name, description, position)
    values (${name}, ${description.slice(0, MAX_DESCRIPTION_LENGTH)},
            (select coalesce(max(position), -1) + 1 from playlists))
    returning id, name, description, position, created_at, updated_at
  `
  const row = rows[0] as Row
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    position: Number(row.position ?? 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    trackIds: [],
  }
}

export async function updatePlaylist(
  playlistId: string,
  input: { name?: string; description?: string },
): Promise<boolean> {
  const rows = await sql`
    update playlists set
      name = coalesce(${input.name ?? null}, name),
      description = coalesce(${input.description == null ? null : input.description.slice(0, MAX_DESCRIPTION_LENGTH)}, description),
      updated_at = now()
    where id = ${playlistId}
    returning id
  `
  return rows.length > 0
}

export async function deletePlaylist(playlistId: string): Promise<boolean> {
  const rows = await sql`delete from playlists where id = ${playlistId} returning id`
  return rows.length > 0
}

async function playlistExists(playlistId: string): Promise<boolean> {
  const rows = await sql`select 1 from playlists where id = ${playlistId}`
  return rows.length > 0
}

/** Append tracks to a playlist; tracks already in it stay where they are. */
export async function addToPlaylist(
  playlistId: string,
  trackIds: string[],
): Promise<{ found: boolean; added: number }> {
  if (!(await playlistExists(playlistId))) return { found: false, added: 0 }
  let added = 0
  for (const trackId of trackIds) {
    const rows = await sql`
      insert into playlist_tracks (playlist_id, track_id, position)
      select ${playlistId}, t.id,
             (select coalesce(max(position), -1) + 1 from playlist_tracks where playlist_id = ${playlistId})
      from tracks t where t.id = ${trackId}
      on conflict (playlist_id, track_id) do nothing
      returning track_id
    `
    added += rows.length
  }
  await sql`update playlists set updated_at = now() where id = ${playlistId}`
  return { found: true, added }
}

export async function removeFromPlaylist(playlistId: string, trackId: string): Promise<boolean> {
  const rows = await sql`
    delete from playlist_tracks where playlist_id = ${playlistId} and track_id = ${trackId} returning track_id
  `
  if (rows.length > 0) await sql`update playlists set updated_at = now() where id = ${playlistId}`
  return rows.length > 0
}

/**
 * Drag to reorder (SPEC 8.6): `trackIds` is the playlist's new full order.
 * It must be exactly the playlist's current songs, so a stale screen can
 * never drop or invent entries.
 */
export async function reorderPlaylist(
  playlistId: string,
  trackIds: string[],
): Promise<'ok' | 'not_found' | 'mismatch'> {
  if (!(await playlistExists(playlistId))) return 'not_found'
  const current = await sql`select track_id from playlist_tracks where playlist_id = ${playlistId}`
  const have = new Set(current.map((row) => String(row.track_id)))
  const want = new Set(trackIds)
  if (have.size !== want.size || trackIds.length !== want.size || [...want].some((id) => !have.has(id))) {
    return 'mismatch'
  }
  await sql.begin(async (tx) => {
    for (let i = 0; i < trackIds.length; i++) {
      await tx`update playlist_tracks set position = ${i} where playlist_id = ${playlistId} and track_id = ${trackIds[i]}`
    }
    await tx`update playlists set updated_at = now() where id = ${playlistId}`
  })
  return 'ok'
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

/** "Favourite album" toggle (SPEC 8.6). */
export async function setAlbumFavorite(album: string, albumArtist: string, favorite: boolean): Promise<void> {
  if (favorite) {
    await sql`
      insert into album_favorites (album, album_artist) values (${album}, ${albumArtist})
      on conflict (album, album_artist) do nothing
    `
  } else {
    await sql`delete from album_favorites where album = ${album} and album_artist = ${albumArtist}`
  }
}

// ---------------------------------------------------------------------------
// Plays and profile
// ---------------------------------------------------------------------------

/** One play (SPEC 8.6). `playedAt` lets offline plays keep their real time (SPEC 8.9). */
export async function recordPlay(trackId: string, seconds: number, playedAt?: Date): Promise<boolean> {
  const exists = await sql`select 1 from tracks where id = ${trackId}`
  if (exists.length === 0) return false
  const clamped = Math.max(0, Math.min(MAX_PLAY_SECONDS, Math.round(seconds)))
  if (playedAt) {
    await sql`insert into play_events (track_id, seconds_listened, played_at) values (${trackId}, ${clamped}, ${playedAt.toISOString()}::timestamptz)`
  } else {
    await sql`insert into play_events (track_id, seconds_listened) values (${trackId}, ${clamped})`
  }
  return true
}

export interface ProfileStats {
  songs: number
  /** Total listening, all time. */
  secondsListened: number
  playsThisMonth: number
  storageBytes: number
}

export interface TopArtist {
  artist: string
  plays: number
}

export interface Profile {
  displayName: string
  stats: ProfileStats
  topArtists: TopArtist[]
}

export async function getProfile(): Promise<Profile> {
  const songs = await sql`select count(*) as count, coalesce(sum(bytes), 0) as bytes from tracks`
  const listened = await sql`select coalesce(sum(seconds_listened), 0) as seconds from play_events`
  // The month starts at midnight on the 1st, Chicago time (SPEC 3).
  const month = await sql`
    select count(*) as count from play_events
    where played_at >= (date_trunc('month', now() at time zone ${APP_TIMEZONE}) at time zone ${APP_TIMEZONE})
  `
  const top = await sql`
    select t.artist as artist, count(*) as plays
    from play_events p join tracks t on t.id = p.track_id
    where p.played_at >= (date_trunc('month', now() at time zone ${APP_TIMEZONE}) at time zone ${APP_TIMEZONE})
      and t.artist <> ''
    group by t.artist
    order by plays desc, t.artist asc
    limit 5
  `
  const settings = await sql`select display_name from settings where id = 1`
  return {
    displayName: String(settings[0]?.display_name ?? 'Denis'),
    stats: {
      songs: Number(songs[0]?.count ?? 0),
      secondsListened: Number(listened[0]?.seconds ?? 0),
      playsThisMonth: Number(month[0]?.count ?? 0),
      storageBytes: Number(songs[0]?.bytes ?? 0),
    },
    topArtists: top.map((row) => ({ artist: String(row.artist), plays: Number(row.plays) })),
  }
}

export async function setDisplayName(name: string): Promise<void> {
  await sql`update settings set display_name = ${name} where id = 1`
}
