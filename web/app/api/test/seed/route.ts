// Test-only seeding for the e2e suite (SPEC 9.0). The e2e app server keeps
// its database in memory inside its own process, so Playwright tests cannot
// write to it directly; this route lets them create made-up songs (SPEC 9
// T2: "seeded ready tracks with made-up titles") and read raw database
// counts to compare against what the UI shows.
//
// It exists ONLY when TAPEDECK_TEST=1 and the build is not production:
// everywhere else it answers 404, like any unknown address. It is also
// behind the app password like every other /api route.
//
// POST { tracks: [{ title, artist?, album?, albumArtist?, durationSec? }] }
//   -> { tracks: [{ id, title }] } inserted as 'waiting'. Tests make them
//   ready through the real downloader API (upload-url, PUT, complete).
// GET ?trackId=<uuid> -> raw counts: tracks, play events (all, for that
//   track, this month in Chicago time), seconds listened, stored bytes.
import { randomBytes } from 'node:crypto'
import { isUuid, jsonError, readJsonObject } from '../../agent/requests'
import { sql } from '../../../../lib/db'
import { APP_TIMEZONE } from '../../../../lib/library'

function enabled(): boolean {
  return process.env.TAPEDECK_TEST === '1' && process.env.NODE_ENV !== 'production'
}

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

export async function POST(request: Request): Promise<Response> {
  if (!enabled()) return new Response('Not found', { status: 404 })
  const body = await readJsonObject(request)
  const list = Array.isArray(body?.tracks) ? (body.tracks as unknown[]) : null
  if (!list || list.length === 0 || list.length > 50) return jsonError(400, 'Expected { tracks: [...] } (1 to 50)')
  const created: { id: string; title: string }[] = []
  for (const item of list) {
    const input = (item ?? {}) as Record<string, unknown>
    const title = text(input.title)
    if (!title) return jsonError(400, 'Every seeded track needs a title')
    // Made-up 11-character id so it can never collide with a real video.
    const sourceId = `T${randomBytes(8).toString('base64url').slice(0, 10)}`
    const duration = Number(input.durationSec)
    const rows = await sql`
      insert into tracks (source, source_id, source_url, raw_title, raw_artist, title, artist, album, album_artist, duration_sec)
      values ('youtube', ${sourceId}, ${`https://www.youtube.com/watch?v=${sourceId}`}, ${title}, ${text(input.artist) ?? ''},
              ${title}, ${text(input.artist) ?? ''}, ${text(input.album)}, ${text(input.albumArtist)},
              ${Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null})
      returning id, title
    `
    created.push({ id: String(rows[0]?.id), title: String(rows[0]?.title) })
  }
  return Response.json({ tracks: created }, { status: 201 })
}

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return new Response('Not found', { status: 404 })
  const trackId = new URL(request.url).searchParams.get('trackId')
  const tracks = await sql`select count(*) as count, coalesce(sum(bytes), 0) as bytes from tracks`
  const plays = await sql`select count(*) as count, coalesce(sum(seconds_listened), 0) as seconds from play_events`
  const month = await sql`
    select count(*) as count from play_events
    where played_at >= (date_trunc('month', now() at time zone ${APP_TIMEZONE}) at time zone ${APP_TIMEZONE})
  `
  const forTrack = isUuid(trackId)
    ? await sql`select count(*) as count from play_events where track_id = ${trackId}`
    : [{ count: 0 }]
  return Response.json({
    tracks: Number(tracks[0]?.count ?? 0),
    storageBytes: Number(tracks[0]?.bytes ?? 0),
    playEvents: Number(plays[0]?.count ?? 0),
    secondsListened: Number(plays[0]?.seconds ?? 0),
    playsThisMonth: Number(month[0]?.count ?? 0),
    playEventsForTrack: Number(forTrack[0]?.count ?? 0),
  })
}
