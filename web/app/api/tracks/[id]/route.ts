// PATCH /api/tracks/[id]: the song menu's "Edit details" (title, artist,
// album, cover: keep / remove / paste image URL). Absent fields stay as they
// are; null clears album or cover. Originals were kept at insert time
// (raw_title / raw_artist), so "Restore original" is the sibling route at
// tracks/[id]/restore. Session-gated like every /api/tracks route (the
// proxy's cookie check is the guard; no bearer here, as this endpoint belongs
// to the owner's browser, not the downloader). V2-PLAN T10 adds the trim
// points `trimStartSec` / `trimEndSec` (rules in ./trim.ts).

import { isUuid, jsonError } from '../../agent/requests'
import { sql, type Row } from '../../../../lib/db'
import { deleteTrack } from '../../../../lib/library'
import { TRACK_V2_COLUMNS, v2FieldsFromRow } from '../../../../lib/track-v2'
import { checkTrimChange, readTrimChange, TRIM_ROW_COLUMNS, type TrimRow } from './trim'

type RouteContext = { params: Promise<{ id: string }> }

/** Sanity caps; the SPEC sets none, these just bound the row. */
const MAX_FIELD_LENGTH = 500

interface TrackRow extends Row {
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
  status: string
}

interface EditBody {
  title?: unknown
  artist?: unknown
  album?: unknown
  coverUrl?: unknown
}

/** A trimmed non-empty string, or null when the value is not one. */
function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_FIELD_LENGTH) : null
}

/**
 * "keep / remove / paste image URL": absent = keep, null = remove, a string
 * must be a usable image URL.
 */
function parseCover(value: unknown): { coverUrl?: string | null; error?: string } {
  if (value === undefined) return {}
  if (value === null) return { coverUrl: null }
  if (typeof value !== 'string') return { error: 'coverUrl must be a string or null' }
  const trimmed = value.trim()
  if (!trimmed) return { coverUrl: null }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { error: 'coverUrl must be a URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'coverUrl must be an http(s) URL' }
  }
  return { coverUrl: trimmed.slice(0, MAX_FIELD_LENGTH) }
}

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) {
    return jsonError(400, 'Track id must be a UUID')
  }

  let body: EditBody
  try {
    body = (await request.json()) as EditBody
  } catch {
    return jsonError(400, 'Expected a JSON body')
  }
  if (typeof body !== 'object' || body === null) {
    return jsonError(400, 'Expected a JSON object')
  }

  // "keep" wins by default: only present fields change.
  const title = body.title === undefined ? undefined : asText(body.title)
  const artist = body.artist === undefined ? undefined : asText(body.artist)
  if (body.title !== undefined && title === null) return jsonError(400, 'Title must not be empty')
  if (body.artist !== undefined && artist === null) return jsonError(400, 'Artist must not be empty')
  const album = body.album === undefined ? undefined : asText(body.album)
  const cover = parseCover(body.coverUrl)
  if (cover.error) return jsonError(400, cover.error)
  const trim = readTrimChange(body as Record<string, unknown>)
  if (trim.error) return jsonError(400, trim.error)

  // The executor has no fragment-join helper, so the SET clause is built as
  // text with positional params: column names are hardcoded here, values
  // always travel as bound parameters.
  const sets: string[] = []
  const params: (string | number | null)[] = []
  const setColumn = (column: string, value: string | number | null) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (trim.change) {
    // The rule applies to the trim that results, so read the stored values first.
    const current = (await sql.unsafe(`select ${TRIM_ROW_COLUMNS} from tracks where id = $1`, [id])) as TrimRow[]
    if (!current[0]) return jsonError(404, 'Track not found')
    const problem = checkTrimChange(trim.change, current[0])
    if (problem) return jsonError(400, problem)
    if (trim.change.start !== undefined) setColumn('trim_start_sec', trim.change.start)
    if (trim.change.end !== undefined) setColumn('trim_end_sec', trim.change.end)
  }
  if (title !== undefined) setColumn('title', title)
  if (artist !== undefined) setColumn('artist', artist)
  if (album !== undefined) {
    // A hand-edited album is no longer the looked-up match, so drop album_artist.
    setColumn('album', album)
    sets.push('album_artist = null')
  }
  if (cover.coverUrl !== undefined) setColumn('cover_url', cover.coverUrl)
  if (sets.length === 0) return jsonError(400, 'Nothing to update')
  params.push(id)

  try {
    const updated = (await sql.unsafe(
      `update tracks set ${sets.join(', ')} where id = $${params.length}
      returning id, source, source_id, source_url, title, artist, album, album_artist, cover_url, duration_sec, status, ${TRACK_V2_COLUMNS}`,
      params,
    )) as TrackRow[]
    if (!updated[0]) {
      return jsonError(404, 'Track not found')
    }
    const row = updated[0]
    return Response.json({
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
      status: row.status,
      ...v2FieldsFromRow(row),
    })
  } catch (error) {
    console.error('[tracks/patch] failed:', error)
    return jsonError(500, 'Could not update the track')
  }
}

// DELETE /api/tracks/[id] (SPEC 8.6): delete a song. The UI confirms first.
// Removes the stored audio file, then the row; playlist entries cascade.
// The phone's offline copy is removed by the client (SPEC 8.9).
export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) {
    return jsonError(400, 'Track id must be a UUID')
  }
  try {
    const result = await deleteTrack(id)
    if (!result.found) return jsonError(404, 'Track not found')
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[tracks/delete] failed:', error)
    return jsonError(500, 'Could not delete the song')
  }
}
