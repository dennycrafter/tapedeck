/**
 * Running an import (V2-PLAN T13), generic over the importer:
 *
 *   listing   importer.listPlaylists -> the checklist (or waiting for the PC)
 *   start     the ticked playlists become Tapedeck playlists (same name; a
 *             playlist imported before is reused, so a re-import adds to it)
 *   chunk     one browser-driven request: read the next pages of songs
 *             (importer.getTracks) into import_items, else match and add the
 *             next 50 songs. Each request stops starting new work after
 *             CHUNK_BUDGET_MS, well inside Vercel's function time limit.
 *   skip      "Skip" on a song that needs a look
 *
 * Adding a song: catalog matching (lib/import-match.ts), then the "already
 * in your library" rules (lib/catalog-library.ts: same catalog id, same
 * ISRC, or same normalised title and artist; a direct link: same source and
 * id). A new song is a `catalog` row in the T11 shape (source_id = the
 * catalog id, or `import:<service>:<id>` with the source's own metadata
 * when nothing matched), or, for a direct YouTube or SoundCloud link, a row
 * with that source and link (the normal pipeline). It is appended to its
 * playlist in the source's order.
 */

import { sql, type Row } from './db'
import { cleanName, createPlaylist } from './library'
import { cleanTitleRules } from './clean-title'
import { loadLibraryIndex, type LibraryIndex } from './catalog-library'
import { parseSongLink, type ParsedSongLink } from './parse-source-url'
import { matchToCatalog, runWithDeadline, type MatchOutcome } from './import-match'
import { SERVICE_LABELS, type ServiceId } from './import-types'
import {
  getJob,
  importedPlaylists,
  lockJob,
  unlockJob,
  updateJob,
  type ImportJob,
  type SelectedPlaylist,
} from './import-jobs'
import {
  ImportUserError,
  isPending,
  type ImportFile,
  type ImportPlaylist,
  type ImportTrack,
  type Importer,
  type ImporterJob,
  type ListInput,
} from './importers/types'

/** V2-PLAN T13: "Write in chunks of 50". */
export const CHUNK_SIZE = 50
/** No new work starts after this much time in one request. */
export const CHUNK_BUDGET_MS = 8_000
/** Catalog lookups at once (Deezer allows about 50 requests per 5 s). */
export const MATCH_CONCURRENCY = 6
/** The per-job lock outlives any request (it is released at the end anyway). */
export const LOCK_SECONDS = 60
export const MAX_PLAYLISTS = 500
export const MAX_SONGS_PER_PLAYLIST = 10_000
const MAX_TEXT = 300
const MAX_REF = 300
const ITEM_INSERT_BATCH = 200

export const GENERIC_LIST_ERROR = "Couldn't read that. Check it and try again."
export const NO_PLAYLISTS = 'No playlists found there.'

// ---------------------------------------------------------------------------
// Small cleaners for what adapters hand back (they read untrusted pages)
// ---------------------------------------------------------------------------

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1_000) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function seconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) && n > 0 && n <= 24 * 60 * 60 ? Math.round(n) : null
}

function isrcCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return /^[A-Z0-9]{12}$/.test(code) ? code : null
}

/** Valid playlists only, unique refs, at most MAX_PLAYLISTS. */
export function cleanPlaylists(raw: readonly ImportPlaylist[]): ImportPlaylist[] {
  const seen = new Set<string>()
  const out: ImportPlaylist[] = []
  for (const playlist of raw) {
    const ref = text(playlist?.ref, MAX_REF)
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    const count = typeof playlist.trackCount === 'number' && playlist.trackCount >= 0 ? Math.round(playlist.trackCount) : null
    out.push({
      ref,
      name: text(playlist.name, 200) ?? 'Untitled playlist',
      coverUrl: httpUrl(playlist.coverUrl),
      trackCount: count,
      kind: playlist.kind === 'liked' ? 'liked' : 'playlist',
    })
    if (out.length >= MAX_PLAYLISTS) break
  }
  return out
}

/** One song as stored in import_items, or null when it has no title. */
export function cleanTrack(raw: ImportTrack): ImportTrack | null {
  const title = text(raw?.title)
  if (!title) return null
  const artist = text(raw.artist) ?? ''
  // An unmatched song is stored as import:<service>:<ref>; make one up when the source has none.
  const ref = text(raw.ref, MAX_REF) ?? `${artist} ${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, MAX_REF)
  return {
    ref,
    title,
    artist,
    album: text(raw.album),
    durationSec: seconds(raw.durationSec),
    isrc: isrcCode(raw.isrc),
    coverUrl: httpUrl(raw.coverUrl),
    link: httpUrl(raw.link),
  }
}

/** The name a ticked playlist gets in Tapedeck. */
export function tapedeckPlaylistName(playlist: Pick<ImportPlaylist, 'name' | 'kind'>, service: ServiceId): string {
  if (playlist.kind === 'liked') return `Liked songs from ${SERVICE_LABELS[service]}`
  return cleanName(playlist.name) ?? 'Imported playlist'
}

export function importerJob(job: ImportJob): ImporterJob {
  return { id: job.id, service: job.service, method: job.method, payload: job.payload }
}

function userMessage(cause: unknown, fallback: string, where: string): string {
  if (cause instanceof ImportUserError) return cause.message
  console.error(`[import] ${where} failed:`, cause)
  return fallback
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** The input to list with: what was given now, else what the job kept (after the PC answered). */
export function listInputFor(job: ImportJob, file: ImportFile | null = null): ListInput {
  if (job.method === 'link') {
    const links = Array.isArray(job.payload.links) ? job.payload.links.filter((link): link is string => typeof link === 'string') : []
    return { method: 'link', links }
  }
  if (job.method === 'file') return { method: 'file', file }
  return { method: 'login' }
}

/** Lists the playlists of a `new` job: listed, waiting for the PC, or failed. */
export async function runListing(job: ImportJob, importer: Importer, input: ListInput): Promise<ImportJob> {
  try {
    const result = await importer.listPlaylists(input, { job: importerJob(job) })
    if (isPending(result)) {
      return (await updateJob(job.id, { status: 'waiting_pc' }, ['new'])) ?? job
    }
    const playlists = cleanPlaylists(result.playlists ?? [])
    if (playlists.length === 0) {
      return (await updateJob(job.id, { status: 'failed', error: NO_PLAYLISTS, payload: result.payload }, ['new'])) ?? job
    }
    return (await updateJob(job.id, { status: 'listed', error: '', playlists, payload: result.payload }, ['new'])) ?? job
  } catch (cause) {
    const error = userMessage(cause, GENERIC_LIST_ERROR, `listing (${importer.id})`)
    return (await updateJob(job.id, { status: 'failed', error }, ['new'])) ?? job
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type StartResult = { job: ImportJob } | { status: number; error: string }

/** The ticked playlists become Tapedeck playlists; the job moves to importing. */
export async function startImport(jobId: string, refs: unknown): Promise<StartResult> {
  const job = await getJob(jobId)
  if (!job) return { status: 404, error: 'Import not found' }
  if (job.status !== 'listed' || !job.playlists) return { status: 409, error: 'This import has already started.' }
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((ref) => typeof ref === 'string')) {
    return { status: 400, error: 'Tick at least one playlist.' }
  }
  const wanted = new Set(refs as string[])
  const chosen = job.playlists.filter((playlist) => wanted.has(playlist.ref))
  if (chosen.length !== wanted.size) return { status: 400, error: 'That playlist is not in this list.' }
  // Liked songs first, then the source's order (the checklist order).
  chosen.sort((a, b) => Number(b.kind === 'liked') - Number(a.kind === 'liked'))

  // Take the job first, so a double tap never makes the playlists twice.
  const taken = await updateJob(job.id, { status: 'importing', selected: [] }, ['listed'])
  if (!taken) return { status: 409, error: 'This import has already started.' }

  const imported = await importedPlaylists(job.service, job.id)
  const selected: SelectedPlaylist[] = []
  for (const playlist of chosen) {
    const name = tapedeckPlaylistName(playlist, job.service)
    const playlistId = imported.get(playlist.ref) ?? (await createPlaylist(name)).id
    selected.push({ ref: playlist.ref, name, playlistId, cursor: null, fetched: false, count: 0 })
  }
  return { job: (await updateJob(job.id, { selected })) ?? taken }
}

// ---------------------------------------------------------------------------
// Chunk: read songs, then match and add 50
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  budgetMs?: number
  chunkSize?: number
  concurrency?: number
  now?: () => number
}

export interface ChunkOutcome {
  job: ImportJob
  /** Nothing left for the browser to drive (done, failed, or waiting for the PC). */
  done: boolean
  busy?: boolean
}

async function insertItems(jobId: string, entry: SelectedPlaylist, tracks: readonly ImportTrack[]): Promise<void> {
  for (let start = 0; start < tracks.length; start += ITEM_INSERT_BATCH) {
    const batch = tracks.slice(start, start + ITEM_INSERT_BATCH)
    const params: unknown[] = []
    const values = batch.map((track, offset) => {
      const row = [
        jobId,
        entry.ref,
        entry.name,
        entry.playlistId,
        entry.count + start + offset,
        track.title,
        track.artist,
        track.album ?? null,
        track.durationSec ?? null,
        track.isrc ?? null,
        track.coverUrl ?? null,
        track.ref,
        track.link ?? null,
      ]
      const placeholders = row.map((value) => {
        params.push(value)
        return `$${params.length}`
      })
      return `(${placeholders.join(', ')})`
    })
    await sql.unsafe(
      `insert into import_items (job_id, playlist_ref, playlist_name, playlist_id, position, title, artist, album,
                                 duration_sec, isrc, cover_url, source_ref, link)
       values ${values.join(', ')}`,
      params,
    )
  }
}

/** Reads one page of the first playlist not fully read. */
async function fetchPage(job: ImportJob, importer: Importer, index: number): Promise<{ job: ImportJob; pending?: boolean }> {
  const entry = job.selected[index]
  const playlist = job.playlists?.find((candidate) => candidate.ref === entry.ref) ?? { ref: entry.ref, name: entry.name }
  const selected = [...job.selected]
  let page
  try {
    page = await importer.getTracks(playlist, { job: importerJob(job), cursor: entry.cursor })
  } catch (cause) {
    const error = userMessage(cause, `Couldn't read "${playlist.name}". Try importing it again later.`, `reading songs (${importer.id})`)
    selected[index] = { ...entry, fetched: true, error }
    return { job: (await updateJob(job.id, { selected })) ?? job }
  }
  if (isPending(page)) {
    return { job: (await updateJob(job.id, { status: 'waiting_pc' }, ['importing'])) ?? job, pending: true }
  }
  const room = Math.max(0, MAX_SONGS_PER_PLAYLIST - entry.count)
  const tracks = (page.tracks ?? [])
    .map(cleanTrack)
    .filter((track): track is ImportTrack => track !== null)
    .slice(0, room)
  await insertItems(job.id, entry, tracks)
  const next = typeof page.next === 'string' && page.next !== '' ? page.next : null
  // A cursor that does not move, or a full playlist, ends the reading.
  const fetched = next === null || next === entry.cursor || tracks.length === room
  selected[index] = { ...entry, cursor: next, fetched, count: entry.count + tracks.length }
  return { job: (await updateJob(job.id, { selected, payload: page.payload })) ?? job }
}

interface PendingItem {
  id: string
  playlistId: string | null
  title: string
  artist: string
  album: string | null
  durationSec: number | null
  isrc: string | null
  coverUrl: string | null
  sourceRef: string
  link: ParsedSongLink | null
}

function pendingItemFromRow(row: Row): PendingItem {
  const rawLink = typeof row.link === 'string' ? row.link : null
  const parsed = rawLink ? parseSongLink(rawLink) : null
  return {
    id: String(row.id),
    playlistId: row.playlist_id == null ? null : String(row.playlist_id),
    title: String(row.title),
    artist: String(row.artist ?? ''),
    album: row.album == null ? null : String(row.album),
    durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
    isrc: row.isrc == null ? null : String(row.isrc),
    coverUrl: row.cover_url == null ? null : String(row.cover_url),
    sourceRef: String(row.source_ref ?? ''),
    // A link that is not a YouTube or SoundCloud song is matched like any other song.
    link: parsed?.kind === 'link' ? parsed.link : null,
  }
}

/** The title and artist to match with: a link's raw title is cleaned like a pasted link's (SPEC 8.4 rules). */
function matchInput(item: PendingItem) {
  const cleaned = item.link ? cleanTitleRules(item.title, item.artist, item.link.source) : { title: item.title, artist: item.artist }
  return { title: cleaned.title, artist: cleaned.artist, durationSec: item.durationSec, isrc: item.isrc }
}

interface NewTrack {
  source: string
  sourceId: string
  sourceUrl: string
  /** The source's own names, kept for "Restore original". */
  rawTitle: string
  rawArtist: string
  rawThumbnailUrl: string | null
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  coverUrl: string | null
  durationSec: number | null
  isrc: string | null
}

/** What the library row would be, from the item and its catalog match. */
export function newTrackFor(
  item: Pick<PendingItem, 'title' | 'artist' | 'album' | 'durationSec' | 'isrc' | 'coverUrl' | 'sourceRef' | 'link'>,
  outcome: MatchOutcome,
  service: ServiceId,
): NewTrack {
  const catalog = outcome.catalog
  const raw = { rawTitle: item.title, rawArtist: item.artist }
  if (item.link) {
    const cleaned = cleanTitleRules(item.title, item.artist, item.link.source)
    return {
      source: item.link.source,
      sourceId: item.link.sourceId,
      sourceUrl: item.link.sourceUrl,
      ...raw,
      // SPEC 8.5: a video thumbnail is never the cover; only a catalog cover is.
      rawThumbnailUrl: item.coverUrl,
      title: catalog?.title ?? cleaned.title,
      artist: catalog?.artist ?? cleaned.artist,
      album: catalog?.album ?? null,
      albumArtist: catalog?.albumArtist ?? null,
      coverUrl: catalog?.coverUrl ?? null,
      durationSec: item.durationSec ?? catalog?.durationSec ?? null,
      isrc: catalog?.isrc ?? item.isrc,
    }
  }
  if (catalog) {
    return {
      source: 'catalog',
      sourceId: catalog.id,
      sourceUrl: '',
      ...raw,
      rawThumbnailUrl: null,
      title: catalog.title,
      artist: catalog.artist,
      album: catalog.album,
      albumArtist: catalog.albumArtist,
      coverUrl: catalog.coverUrl,
      durationSec: catalog.durationSec ?? item.durationSec,
      isrc: catalog.isrc ?? item.isrc,
    }
  }
  return {
    source: 'catalog',
    sourceId: `import:${service}:${item.sourceRef}`,
    sourceUrl: '',
    ...raw,
    rawThumbnailUrl: null,
    title: item.title,
    artist: item.artist,
    album: item.album,
    albumArtist: item.album ? item.artist || null : null,
    coverUrl: item.coverUrl,
    durationSec: item.durationSec,
    isrc: item.isrc,
  }
}

/** The library song this is, by the "already in your library" rules, or null. */
function existingTrack(track: NewTrack, index: LibraryIndex): string | null {
  const bySource = index.findBySource(track.source, track.sourceId)
  if (bySource) return bySource
  // A direct link is only the same song as that exact link: a live video and
  // the album version share a normalised title.
  if (track.source !== 'catalog') return null
  return index.findTrackId({ id: track.sourceId, isrc: track.isrc, title: track.title, artist: track.artist })
}

async function insertTrack(track: NewTrack): Promise<string> {
  // raw_title / raw_artist keep the source's names ("Restore original").
  const inserted = await sql`
    insert into tracks (source, source_id, source_url, raw_title, raw_artist, raw_thumbnail_url, title, artist,
                        album, album_artist, cover_url, duration_sec, isrc)
    values (${track.source}, ${track.sourceId}, ${track.sourceUrl}, ${track.rawTitle}, ${track.rawArtist},
            ${track.rawThumbnailUrl}, ${track.title}, ${track.artist}, ${track.album}, ${track.albumArtist},
            ${track.coverUrl}, ${track.durationSec}, ${track.isrc})
    on conflict (source, source_id) do nothing
    returning id`
  if (inserted[0]) return String(inserted[0].id)
  // Added by a request racing this one.
  const [row] = await sql`select id from tracks where source = ${track.source} and source_id = ${track.sourceId}`
  if (!row) throw new Error(`track ${track.source}:${track.sourceId} vanished`)
  return String(row.id)
}

async function appendToPlaylist(playlistId: string, trackId: string): Promise<void> {
  await sql`
    insert into playlist_tracks (playlist_id, track_id, position)
    select ${playlistId}, ${trackId},
           (select coalesce(max(position), -1) + 1 from playlist_tracks where playlist_id = ${playlistId})
    where exists (select 1 from playlists where id = ${playlistId})
    on conflict (playlist_id, track_id) do nothing`
}

/** Adds one matched item: an existing song or a new one, then its playlist. */
async function addItem(item: PendingItem, outcome: MatchOutcome, job: ImportJob, index: LibraryIndex): Promise<void> {
  const track = newTrackFor(item, outcome, job.service)
  const how = item.link ? 'link' : outcome.how
  try {
    let trackId = existingTrack(track, index)
    const status = trackId ? 'already' : 'added'
    if (!trackId) {
      trackId = await insertTrack(track)
      index.addRow({
        id: trackId,
        source: track.source,
        source_id: track.sourceId,
        isrc: track.isrc,
        title: track.title,
        artist: track.artist,
        album: track.album,
        album_artist: track.albumArtist,
      })
    }
    if (item.playlistId) await appendToPlaylist(item.playlistId, trackId)
    await sql`update import_items set status = ${status}, track_id = ${trackId}, match = ${how}, error = '' where id = ${item.id}`
  } catch (cause) {
    console.error('[import] adding a song failed:', cause)
    await sql`update import_items set status = 'error', match = ${how}, error = 'Could not add this song.' where id = ${item.id}`
  }
}

async function addPendingSongs(job: ImportJob, deadline: number, opts: Required<Omit<ChunkOptions, 'budgetMs'>>): Promise<void> {
  const rows = await sql`
    select id, playlist_id, title, artist, album, duration_sec, isrc, cover_url, source_ref, link
    from import_items
    where job_id = ${job.id} and status = 'pending'
    order by created_at, position
    limit ${opts.chunkSize}`
  if (rows.length === 0) return
  const items = rows.map(pendingItemFromRow)
  const outcomes = await runWithDeadline(items, (item) => matchToCatalog(matchInput(item)), {
    concurrency: opts.concurrency,
    deadline,
    now: opts.now,
  })
  const index = await loadLibraryIndex()
  const touched = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const outcome = outcomes[i]
    if (!outcome) break // not reached in time: the next request continues here, in order
    await addItem(items[i], outcome, job, index)
    if (items[i].playlistId) touched.add(items[i].playlistId as string)
  }
  for (const playlistId of touched) {
    await sql`update playlists set updated_at = now() where id = ${playlistId}`
  }
}

async function pendingCount(jobId: string): Promise<number> {
  const [row] = await sql`select count(*)::int as n from import_items where job_id = ${jobId} and status = 'pending'`
  return Number(row?.n ?? 0)
}

/**
 * One browser-driven step of an importing job. Reads songs first (as many
 * pages as fit in half the budget), then matches and adds up to 50 songs.
 * Another request already working on the job answers `busy`.
 */
export async function runChunk(jobId: string, importer: Importer, options: ChunkOptions = {}): Promise<ChunkOutcome | null> {
  const now = options.now ?? Date.now
  const started = now()
  const budget = options.budgetMs ?? CHUNK_BUDGET_MS
  let job = await getJob(jobId)
  if (!job) return null
  if (job.status !== 'importing') return { job, done: job.status !== 'waiting_pc' }
  if (!(await lockJob(job.id, LOCK_SECONDS))) return { job, done: false, busy: true }
  try {
    for (;;) {
      const index = job.selected.findIndex((entry) => !entry.fetched)
      if (index === -1) break
      const read: { job: ImportJob; pending?: boolean } = await fetchPage(job, importer, index)
      job = read.job
      if (read.pending) return { job, done: false }
      if (now() - started >= budget / 2) break
    }
    if (job.selected.some((entry) => !entry.fetched)) return { job, done: false }

    await addPendingSongs(job, started + budget, {
      chunkSize: options.chunkSize ?? CHUNK_SIZE,
      concurrency: options.concurrency ?? MATCH_CONCURRENCY,
      now,
    })
    if ((await pendingCount(job.id)) === 0) {
      job = (await updateJob(job.id, { status: 'done' }, ['importing'])) ?? job
      return { job, done: true }
    }
    return { job, done: false }
  } finally {
    await unlockJob(jobId)
  }
}

// ---------------------------------------------------------------------------
// Skip
// ---------------------------------------------------------------------------

/**
 * "Skip" on a song that needs a look: the song leaves this import (it no
 * longer counts) and this import's playlists. When this import added the
 * song, it is not ready and no other playlist or import holds it, the
 * library row goes too, so a song that could not be found does not stay
 * behind as failed.
 */
export async function skipItem(jobId: string, itemId: string): Promise<'ok' | 'not-found'> {
  const [item] = await sql`select track_id from import_items where id = ${itemId} and job_id = ${jobId}`
  if (!item) return 'not-found'
  const trackId = item.track_id == null ? null : String(item.track_id)
  if (!trackId) {
    await sql`update import_items set status = 'skipped' where id = ${itemId}`
    return 'ok'
  }
  const [created] = await sql`
    select 1 as yes from import_items where job_id = ${jobId} and track_id = ${trackId} and status = 'added' limit 1`
  await sql`update import_items set status = 'skipped' where job_id = ${jobId} and track_id = ${trackId}`
  const job = await getJob(jobId)
  for (const entry of job?.selected ?? []) {
    if (entry.playlistId) {
      await sql`delete from playlist_tracks where playlist_id = ${entry.playlistId} and track_id = ${trackId}`
    }
  }
  if (created) {
    await sql`
      delete from tracks t
      where t.id = ${trackId} and t.status in ('waiting', 'failed') and t.storage_key is null
        and not exists (select 1 from playlist_tracks pt where pt.track_id = t.id)
        and not exists (select 1 from import_items i where i.track_id = t.id and i.status <> 'skipped')`
  }
  return 'ok'
}
