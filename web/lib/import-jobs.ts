/**
 * Import jobs in the database (V2-PLAN T13): create, read, update, the
 * per-job lock the chunked import uses, the "already imported" lookup, and
 * the helpers a PC adapter's agent endpoints use (claim, release, fail).
 * Table and status values: supabase/migrations/t13_import.sql.
 */

import { sql, type DbExecutor, type Row } from './db'
import { toIso } from './library'
import type { ChecklistPlaylist, ConnectMethod, ImportJobStatus, ServiceId } from './import-types'
import type { ImportPlaylist } from './importers/types'

/** One ticked playlist and how far its songs have been read. */
export interface SelectedPlaylist {
  ref: string
  /** The Tapedeck playlist name (Liked songs get the service name added). */
  name: string
  playlistId: string | null
  /** The `next` value of the last page read, or null before the first page. */
  cursor: string | null
  /** Every page has been read. */
  fetched: boolean
  /** Songs read so far (the next song's position). */
  count: number
  /** Reading the songs failed for good; shown on the progress screen. */
  error?: string
}

export interface ImportJob {
  id: string
  service: ServiceId
  importer: string
  method: ConnectMethod
  status: ImportJobStatus
  error: string
  payload: Record<string, unknown>
  playlists: ImportPlaylist[] | null
  selected: SelectedPlaylist[]
  attempts: number
  claimedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** A PC claim older than this is taken again (same rule as tracks, SPEC 8.3). */
export const PC_CLAIM_STALE_MINUTES = 15
/** After this many PC claims a failure is final (same as tracks). */
export const PC_MAX_ATTEMPTS = 3

const JOB_COLUMNS = sql.raw(
  'id, service, importer, method, status, error, payload, playlists, selected, attempts, claimed_at, created_at, updated_at',
)

/** jsonb comes back parsed from one driver and as text from the other. */
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> {
  const parsed = json(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

function asArray<T>(value: unknown): T[] | null {
  const parsed = json(value)
  return Array.isArray(parsed) ? (parsed as T[]) : null
}

export function jobFromRow(row: Row): ImportJob {
  return {
    id: String(row.id),
    service: String(row.service) as ServiceId,
    importer: String(row.importer),
    method: String(row.method) as ConnectMethod,
    status: String(row.status) as ImportJobStatus,
    error: String(row.error ?? ''),
    payload: asObject(row.payload),
    playlists: asArray<ImportPlaylist>(row.playlists),
    selected: asArray<SelectedPlaylist>(row.selected) ?? [],
    attempts: Number(row.attempts ?? 0),
    claimedAt: toIso(row.claimed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export async function createJob(input: {
  service: ServiceId
  importer: string
  method: ConnectMethod
  status?: ImportJobStatus
  payload?: Record<string, unknown>
}): Promise<ImportJob> {
  const rows = await sql`
    insert into import_jobs (service, importer, method, status, payload)
    values (${input.service}, ${input.importer}, ${input.method}, ${input.status ?? 'new'},
            ${JSON.stringify(input.payload ?? {})}::jsonb)
    returning ${JOB_COLUMNS}`
  return jobFromRow(rows[0])
}

export async function getJob(id: string, db: DbExecutor = sql): Promise<ImportJob | null> {
  const rows = await db`select ${JOB_COLUMNS} from import_jobs where id = ${id}`
  return rows[0] ? jobFromRow(rows[0]) : null
}

export async function recentJobs(limit = 5): Promise<ImportJob[]> {
  const rows = await sql`
    select ${JOB_COLUMNS} from import_jobs
    where status in ('importing', 'done') or (status = 'waiting_pc' and playlists is not null)
    order by created_at desc limit ${limit}`
  return rows.map(jobFromRow)
}

export interface JobPatch {
  status?: ImportJobStatus
  error?: string
  /** Merged into the payload (top-level keys replace). */
  payload?: Record<string, unknown>
  playlists?: ImportPlaylist[]
  selected?: SelectedPlaylist[]
}

/** Applies the patch; `onlyIf` limits it to jobs in one of those statuses. Returns the job, or null when nothing matched. */
export async function updateJob(id: string, patch: JobPatch, onlyIf?: readonly ImportJobStatus[]): Promise<ImportJob | null> {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = []
  const param = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }
  if (patch.status !== undefined) sets.push(`status = ${param(patch.status)}`)
  if (patch.error !== undefined) sets.push(`error = ${param(patch.error.slice(0, 500))}`)
  if (patch.payload !== undefined) sets.push(`payload = payload || ${param(JSON.stringify(patch.payload))}::jsonb`)
  if (patch.playlists !== undefined) sets.push(`playlists = ${param(JSON.stringify(patch.playlists))}::jsonb`)
  if (patch.selected !== undefined) sets.push(`selected = ${param(JSON.stringify(patch.selected))}::jsonb`)
  let where = `id = ${param(id)}`
  if (onlyIf && onlyIf.length > 0) where += ` and status in (${onlyIf.map((status) => param(status)).join(', ')})`
  const rows = await sql.unsafe(
    `update import_jobs set ${sets.join(', ')} where ${where}
     returning id, service, importer, method, status, error, payload, playlists, selected, attempts, claimed_at, created_at, updated_at`,
    params,
  )
  return rows[0] ? jobFromRow(rows[0]) : null
}

/**
 * One import request at a time per job: true when this request got the
 * lock. It runs out by itself after `seconds`, so a crashed request never
 * blocks the job for long.
 */
export async function lockJob(id: string, seconds: number): Promise<boolean> {
  const rows = await sql`
    update import_jobs set locked_until = now() + make_interval(secs => ${seconds})
    where id = ${id} and (locked_until is null or locked_until < now())
    returning id`
  return rows.length > 0
}

export async function unlockJob(id: string): Promise<void> {
  await sql`update import_jobs set locked_until = null where id = ${id}`
}

/**
 * Playlists of this service imported by earlier jobs whose Tapedeck
 * playlist still exists: source playlist ref to Tapedeck playlist id, the
 * newest import winning. Drives the "Imported" mark on the checklist, and a
 * re-import adds to that same playlist.
 */
export async function importedPlaylists(service: ServiceId, excludeJobId: string): Promise<Map<string, string>> {
  const rows = await sql`
    select distinct on (entry.value->>'ref') entry.value->>'ref' as ref, p.id as playlist_id
    from import_jobs j
    cross join lateral jsonb_array_elements(j.selected) as entry(value)
    join playlists p on p.id::text = entry.value->>'playlistId'
    where j.service = ${service} and j.id <> ${excludeJobId}
    order by entry.value->>'ref', j.created_at desc`
  return new Map(rows.map((row) => [String(row.ref), String(row.playlist_id)]))
}

/** The checklist for the browser: Liked songs first, then the source's order. */
export function checklist(playlists: readonly ImportPlaylist[], imported: Map<string, string>): ChecklistPlaylist[] {
  const items = playlists.map((playlist) => ({
    ref: playlist.ref,
    name: playlist.name,
    coverUrl: playlist.coverUrl ?? null,
    trackCount: playlist.trackCount ?? null,
    kind: playlist.kind === 'liked' ? ('liked' as const) : ('playlist' as const),
    importedPlaylistId: imported.get(playlist.ref) ?? null,
  }))
  return [...items.filter((item) => item.kind === 'liked'), ...items.filter((item) => item.kind !== 'liked')]
}

// ---------------------------------------------------------------------------
// The PC side (for a PC adapter's /api/agent/import/* endpoints)
// ---------------------------------------------------------------------------

/**
 * Claims jobs of one importer that wait for the PC: not claimed yet, or
 * claimed more than 15 minutes ago (the PC died). Each claim counts an
 * attempt. Oldest first, atomically, so two PCs never take the same job.
 */
export async function claimPcJobs(importer: string, limit = 1): Promise<ImportJob[]> {
  const rows = await sql`
    with picked as (
      select id from import_jobs
      where importer = ${importer} and status = 'waiting_pc'
        and (claimed_at is null or claimed_at < now() - make_interval(mins => ${PC_CLAIM_STALE_MINUTES}))
      order by created_at
      limit ${limit}
      for update skip locked
    )
    update import_jobs j set claimed_at = now(), attempts = j.attempts + 1, updated_at = now()
    from picked where j.id = picked.id
    returning j.id, j.service, j.importer, j.method, j.status, j.error, j.payload, j.playlists, j.selected,
              j.attempts, j.claimed_at, j.created_at, j.updated_at`
  return rows.map(jobFromRow)
}

/**
 * The PC finished its part: merge what it sent into the payload and hand
 * the job back to the browser. A job that was listing goes back to `new`
 * (the browser lists again and the adapter reads the result from the
 * payload); one that was importing goes back to `importing`. Returns false
 * when the job does not exist or is not waiting for the PC.
 */
export async function releasePcJob(id: string, payload: Record<string, unknown>): Promise<boolean> {
  const rows = await sql`
    update import_jobs
    set payload = payload || ${JSON.stringify(payload)}::jsonb,
        status = case when playlists is null then 'new' else 'importing' end,
        claimed_at = null, attempts = 0, error = '', updated_at = now()
    where id = ${id} and status = 'waiting_pc'
    returning id`
  return rows.length > 0
}

/**
 * The PC could not do it. While attempts allow another try the job stays
 * waiting (the next poll takes it again); after the third it fails with
 * `error`, which the owner sees, so write it in plain words.
 */
export async function failPcJob(id: string, error: string): Promise<'waiting_pc' | 'failed' | null> {
  const rows = await sql`
    update import_jobs
    set status = case when attempts < ${PC_MAX_ATTEMPTS} then 'waiting_pc' else 'failed' end,
        claimed_at = null, error = left(${error}, 500), updated_at = now()
    where id = ${id} and status = 'waiting_pc'
    returning status`
  const status = rows[0]?.status
  return status === 'waiting_pc' || status === 'failed' ? status : null
}
