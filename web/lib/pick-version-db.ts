/**
 * "Pick another version" (V2-PLAN T12, item 5), the database part. Kept apart
 * from lib/pick-version.ts so the client dialog can import the pure helpers
 * without pulling the database driver into the browser bundle.
 */

import { sql } from './db'
import type { MatchInfo } from './track-v2'
import { v2FieldsFromRow } from './track-v2'

export type PickResult = 'ok' | 'not-found' | 'not-catalog' | 'busy'

export interface PickTarget {
  source: string
  status: string
  matchInfo: MatchInfo | null
}

/** What the pick route needs to check a request, or null for an unknown song. */
export async function pickTarget(trackId: string): Promise<PickTarget | null> {
  const [row] = await sql`select source, status, match_info from tracks where id = ${trackId}`
  if (!row) return null
  return { source: String(row.source), status: String(row.status), matchInfo: v2FieldsFromRow(row).matchInfo }
}

/**
 * Queue a catalog song again. With a url the PC downloads exactly that copy;
 * with null (Search again) the pick is cleared and the PC searches afresh.
 * Either way the song goes back to waiting with a clean slate (attempts 0, no
 * error). match_info is kept so the dialog still lists the alternatives.
 * A song the PC is downloading right now is left alone ('busy').
 */
export async function pickVersion(trackId: string, url: string | null): Promise<PickResult> {
  const updated = await sql`
    update tracks
    set resolved_url = ${url}, status = 'waiting', attempts = 0, error = ''
    where id = ${trackId} and source = 'catalog' and status <> 'downloading'
    returning id`
  if (updated.length > 0) return 'ok'
  const [row] = await sql`select source from tracks where id = ${trackId}`
  if (!row) return 'not-found'
  return row.source === 'catalog' ? 'busy' : 'not-catalog'
}
