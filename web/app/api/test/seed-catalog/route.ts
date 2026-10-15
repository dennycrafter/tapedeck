// Test-only seeding of catalog songs for the e2e suite (V2-PLAN T12), next
// to app/api/test/seed (which makes YouTube rows). Same switch: it exists
// ONLY when TAPEDECK_TEST=1 and answers 404 everywhere else, and it is behind
// the app password like every other /api route.
//
// POST { tracks: [{ title, artist?, album?, durationSec?, isrc? }] }
//   -> 201 { tracks: [{ id, title }] } inserted as 'waiting' catalog rows
//   (source 'catalog', source_id 'deezer:<made-up digits>', source_url '').
//   Tests make them ready through the real downloader API (upload-url, PUT,
//   complete with resolvedUrl and matchInfo).
import { randomInt } from 'node:crypto'
import { jsonError, readJsonObject } from '../../agent/requests'
import { sql } from '../../../../lib/db'

function enabled(): boolean {
  return process.env.TAPEDECK_TEST === '1'
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
    const artist = text(input.artist) ?? ''
    // Made-up 12-digit id, far above real Deezer ids today.
    const sourceId = `deezer:9${String(randomInt(0, 1e11)).padStart(11, '0')}`
    const duration = Number(input.durationSec)
    const rows = await sql`
      insert into tracks (source, source_id, source_url, raw_title, raw_artist, title, artist, album,
                          duration_sec, isrc)
      values ('catalog', ${sourceId}, '', ${title}, ${artist}, ${title}, ${artist}, ${text(input.album)},
              ${Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null}, ${text(input.isrc, 20)})
      returning id, title
    `
    created.push({ id: String(rows[0]?.id), title: String(rows[0]?.title) })
  }
  return Response.json({ tracks: created }, { status: 201 })
}
