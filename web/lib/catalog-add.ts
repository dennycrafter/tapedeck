/**
 * Adding catalog songs (V2-PLAN T11 item 5): `POST /api/tracks` with
 * `{ catalog: CatalogTrack[] }` (at most 50) next to the existing `{ urls }`.
 * The tracks route only checks which body it got and hands this kind here.
 *
 * Each song becomes a row with `source = 'catalog'`, `source_id` = the
 * catalog id (`deezer:3135556`), `source_url = ''` (the PC picks a copy
 * later, T12) and `status = 'waiting'`. Title, artist, album, album artist,
 * cover, length and ISRC come straight from the catalog: no AI cleanup and
 * no cover lookup. `raw_title` and `raw_artist` copy the catalog values, so
 * "Restore original" brings back the catalog names.
 *
 * "Already in your library" (SPEC 8.2): the same catalog id or the same
 * ISRC is already a track, or the song is repeated in the same request.
 * A Deezer song without an ISRC gets one from `/track/:id` first (best
 * effort, a few seconds at most).
 *
 * The response has the same shape as the link add: `{ results: [{ index,
 * line, status, message, track? }] }`, with `line` = the catalog id.
 */

import { lookupIsrc } from './catalog'
import { isCatalogId } from './catalog-types'
import { sql, type Row } from './db'

/** V2-PLAN T11: "max 50 per request". */
export const MAX_CATALOG_ADD = 50

const MAX_TEXT = 300
const MAX_URL = 1_000
const ISRC_CONCURRENCY = 5
const ISRC_BUDGET_MS = 6_000

export interface CatalogAddItem {
  id: string
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  coverUrl: string | null
  durationSec: number | null
  isrc: string | null
}

export interface CatalogAddTrackJson {
  id: string
  source: string
  sourceId: string
  sourceUrl: string
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  coverUrl: string | null
  durationSec: number | null
  isrc: string | null
  status: string
}

export interface CatalogAddResult {
  index: number
  line: string
  status: 'added' | 'already' | 'error'
  message: string
  track?: CatalogAddTrackJson
}

/** True when a POST /api/tracks body is the catalog kind. */
export function isCatalogAddBody(body: unknown): body is { catalog: unknown } {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'catalog' in body
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function cleanDuration(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) && n > 0 && n <= 24 * 60 * 60 ? Math.round(n) : null
}

function cleanIsrc(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return /^[A-Z0-9]{12}$/.test(code) ? code : null
}

/** One item of the request, or the per-item error text. */
export function parseCatalogItem(raw: unknown): CatalogAddItem | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'Not a catalog song.'
  const input = raw as Record<string, unknown>
  if (!isCatalogId(input.id)) return 'Not a catalog song.'
  const title = cleanText(input.title)
  if (!title) return 'That song has no title.'
  return {
    id: input.id,
    title,
    artist: cleanText(input.artist) ?? '',
    album: cleanText(input.album),
    albumArtist: cleanText(input.albumArtist),
    coverUrl: cleanUrl(input.coverUrl),
    durationSec: cleanDuration(input.durationSec),
    isrc: cleanIsrc(input.isrc),
  }
}

/** Fills missing Deezer ISRCs, a few at a time, within a fixed time budget. */
async function fillIsrcs(items: CatalogAddItem[]): Promise<void> {
  const missing = items.filter((item) => !item.isrc && item.id.startsWith('deezer:'))
  const deadline = Date.now() + ISRC_BUDGET_MS
  let next = 0
  async function worker(): Promise<void> {
    while (next < missing.length && Date.now() < deadline) {
      const item = missing[next++]
      item.isrc = await lookupIsrc(item.id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(ISRC_CONCURRENCY, missing.length) }, worker))
}

/** Catalog ids and ISRCs among these items that are already tracks, in one query. */
async function existing(items: readonly CatalogAddItem[]): Promise<{ ids: Set<string>; isrcs: Set<string> }> {
  const ids = [...new Set(items.map((item) => item.id))]
  const isrcs = [...new Set(items.map((item) => item.isrc).filter((code): code is string => code !== null))]
  const params = [...ids, ...isrcs]
  const idList = ids.map((_, i) => `$${i + 1}`).join(', ')
  const isrcList = isrcs.map((_, i) => `$${ids.length + i + 1}`).join(', ')
  const where = [
    ids.length > 0 ? `(source = 'catalog' and source_id in (${idList}))` : '',
    isrcs.length > 0 ? `upper(isrc) in (${isrcList})` : '',
  ].filter(Boolean)
  if (where.length === 0) return { ids: new Set(), isrcs: new Set() }
  const rows = (await sql.unsafe(
    `select source, source_id, isrc from tracks where ${where.join(' or ')}`,
    params,
  )) as (Row & { source: string; source_id: string; isrc: string | null })[]
  return {
    ids: new Set(rows.filter((row) => row.source === 'catalog').map((row) => row.source_id)),
    isrcs: new Set(rows.map((row) => row.isrc?.toUpperCase()).filter((code): code is string => !!code)),
  }
}

interface InsertedRow extends Row {
  id: string
  source: string
  source_id: string
  source_url: string
  title: string
  artist: string
  album: string | null
  album_artist: string | null
  cover_url: string | null
  duration_sec: number | null
  isrc: string | null
  status: string
}

function trackJson(row: InsertedRow): CatalogAddTrackJson {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.album_artist,
    coverUrl: row.cover_url,
    durationSec: row.duration_sec,
    isrc: row.isrc,
    status: row.status,
  }
}

const ALREADY = 'Already in your library'

/** Adds the validated songs; one result per input item, in order. */
export async function addCatalogItems(rawItems: readonly unknown[]): Promise<CatalogAddResult[]> {
  const results: CatalogAddResult[] = new Array(rawItems.length)
  const fresh: { index: number; item: CatalogAddItem }[] = []
  const seenIds = new Set<string>()

  rawItems.forEach((raw, index) => {
    const parsed = parseCatalogItem(raw)
    const line = typeof (raw as { id?: unknown })?.id === 'string' ? String((raw as { id: string }).id).slice(0, 60) : ''
    if (typeof parsed === 'string') {
      results[index] = { index, line, status: 'error', message: parsed }
      return
    }
    if (seenIds.has(parsed.id)) {
      results[index] = { index, line: parsed.id, status: 'already', message: ALREADY }
      return
    }
    seenIds.add(parsed.id)
    fresh.push({ index, item: parsed })
  })

  await fillIsrcs(fresh.map((entry) => entry.item))
  const owned = await existing(fresh.map((entry) => entry.item))
  const seenIsrcs = new Set<string>()

  for (const { index, item } of fresh) {
    const line = item.id
    if (owned.ids.has(item.id) || (item.isrc && (owned.isrcs.has(item.isrc) || seenIsrcs.has(item.isrc)))) {
      results[index] = { index, line, status: 'already', message: ALREADY }
      continue
    }
    if (item.isrc) seenIsrcs.add(item.isrc)
    try {
      const inserted = (await sql`
        insert into tracks (source, source_id, source_url, raw_title, raw_artist, title, artist, album, album_artist, cover_url, duration_sec, isrc)
        values ('catalog', ${item.id}, '', ${item.title}, ${item.artist}, ${item.title}, ${item.artist},
                ${item.album}, ${item.albumArtist}, ${item.coverUrl}, ${item.durationSec}, ${item.isrc})
        on conflict (source, source_id) do nothing
        returning id, source, source_id, source_url, title, artist, album, album_artist, cover_url, duration_sec, isrc, status
      `) as InsertedRow[]
      results[index] = inserted[0]
        ? { index, line, status: 'added', message: 'Added', track: trackJson(inserted[0]) }
        : { index, line, status: 'already', message: ALREADY } // added by a request racing this one
    } catch (cause) {
      console.error('[catalog-add] insert failed:', cause)
      results[index] = { index, line, status: 'error', message: 'Could not add that song.' }
    }
  }
  return results
}

/** The whole `{ catalog }` request: 400 for a bad shape, else the per-song results. */
export async function handleCatalogAdd(body: { catalog: unknown }): Promise<Response> {
  const items = body.catalog
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CATALOG_ADD) {
    return Response.json(
      { error: `Expected catalog: a list of 1 to ${MAX_CATALOG_ADD} songs.` },
      { status: 400 },
    )
  }
  return Response.json({ results: await addCatalogItems(items) })
}
