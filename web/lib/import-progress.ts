/**
 * Import progress (V2-PLAN T13): "142 of 150 ready, 6 waiting, 2 need a
 * look", read live from the database on every request (the songs become
 * ready as the PC downloads them, long after the import itself is done).
 *
 * A song counts once, even when it is in two ticked playlists. Skipped songs
 * and songs deleted from the library since do not count. "Need a look" is a
 * song the PC gave up on (status failed) or one that could not be added.
 */

import { sql, type Row } from './db'
import { checklist, importedPlaylists, recentJobs, type ImportJob } from './import-jobs'
import { SERVICE_LABELS, type ImportJobSummary, type ImportJobView, type ImportProgress, type NeedsLookSong } from './import-types'

const NEEDS_LOOK_LIMIT = 50

/** Per distinct song: ready, waiting, look or pending. */
const SONG_STATES = `
  select distinct coalesce(i.track_id::text, i.id::text) as song,
    case
      when i.status = 'pending' then 'pending'
      when i.status = 'error' then 'look'
      when t.status = 'ready' then 'ready'
      when t.status = 'failed' then 'look'
      else 'waiting'
    end as state
  from import_items i
  left join tracks t on t.id = i.track_id
  where i.job_id = $1 and i.status <> 'skipped'
    -- a song deleted from the library since no longer counts
    and not (i.status in ('added', 'already') and t.id is null)`

function count(row: Row | undefined, name: string): number {
  return Number(row?.[name] ?? 0)
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

export async function loadProgress(jobId: string): Promise<ImportProgress> {
  const [counts] = await sql.unsafe(
    `select
       count(*) filter (where state = 'ready')::int as ready,
       count(*) filter (where state = 'waiting')::int as waiting,
       count(*) filter (where state = 'look')::int as look,
       count(*) filter (where state = 'pending')::int as pending
     from (${SONG_STATES}) songs`,
    [jobId],
  )
  const [skipped] = await sql`
    select count(distinct coalesce(track_id::text, id::text))::int as n
    from import_items where job_id = ${jobId} and status = 'skipped'`
  const looks = await sql`
    select distinct on (coalesce(i.track_id::text, i.id::text))
      i.id as item_id, i.track_id, coalesce(t.title, i.title) as title, coalesce(t.artist, i.artist) as artist,
      t.source, coalesce(nullif(t.error, ''), i.error) as error, t.match_info, t.resolved_url
    from import_items i
    left join tracks t on t.id = i.track_id
    where i.job_id = ${jobId} and i.status <> 'skipped' and (i.status = 'error' or t.status = 'failed')
    order by coalesce(i.track_id::text, i.id::text), i.created_at, i.position
    limit ${NEEDS_LOOK_LIMIT}`
  const needsLookSongs: NeedsLookSong[] = looks.map((row) => ({
    itemId: String(row.item_id),
    trackId: row.track_id == null ? null : String(row.track_id),
    title: String(row.title ?? ''),
    artist: String(row.artist ?? ''),
    source: row.source == null ? null : String(row.source),
    error: String(row.error ?? ''),
    matchInfo: json(row.match_info) ?? null,
    resolvedUrl: row.resolved_url == null ? null : String(row.resolved_url),
  }))
  needsLookSongs.sort((a, b) => a.title.localeCompare(b.title))
  const ready = count(counts, 'ready')
  const waiting = count(counts, 'waiting')
  const needsLook = count(counts, 'look')
  const pending = count(counts, 'pending')
  return {
    total: ready + waiting + needsLook + pending,
    ready,
    waiting,
    needsLook,
    pending,
    skipped: count(skipped, 'n'),
    needsLookSongs,
  }
}

/** The job as the browser sees it; progress once the import has started. */
export async function jobView(job: ImportJob): Promise<ImportJobView> {
  const started = job.status === 'importing' || job.status === 'done' || (job.status === 'waiting_pc' && job.playlists !== null)
  const imported = job.playlists ? await importedPlaylists(job.service, job.id) : new Map<string, string>()
  return {
    id: job.id,
    service: job.service,
    serviceLabel: SERVICE_LABELS[job.service] ?? job.service,
    importer: job.importer,
    method: job.method,
    status: job.status,
    error: job.error,
    playlists: job.playlists ? checklist(job.playlists, imported) : null,
    selected: job.selected.map((entry) => ({
      ref: entry.ref,
      name: entry.name,
      playlistId: entry.playlistId,
      fetched: entry.fetched,
      ...(entry.error ? { error: entry.error } : {}),
    })),
    createdAt: job.createdAt,
    progress: started ? await loadProgress(job.id) : null,
  }
}

/** "Your imports": the latest few, with their counts. */
export async function recentJobSummaries(limit = 5): Promise<ImportJobSummary[]> {
  const jobs = await recentJobs(limit)
  const out: ImportJobSummary[] = []
  for (const job of jobs) {
    const started = job.selected.length > 0
    const progress = started ? await loadProgress(job.id) : null
    out.push({
      id: job.id,
      service: job.service,
      serviceLabel: SERVICE_LABELS[job.service] ?? job.service,
      status: job.status,
      createdAt: job.createdAt,
      playlistNames: job.selected.map((entry) => entry.name),
      progress: progress
        ? { total: progress.total, ready: progress.ready, waiting: progress.waiting + progress.pending, needsLook: progress.needsLook }
        : null,
    })
  }
  return out
}
