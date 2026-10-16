// POST /api/agent/import/complete (V2-PLAN T13, adapter 4): the downloader
// hands back a listing job it claimed. Same bearer auth as every
// /api/agent route.
//
// Body, one of:
//   { jobId, playlists: [{ ref, name, kind, coverUrl, tracks: [{ ref, title,
//     artist, durationSec, link, coverUrl }] }], problems?: string[],
//     truncated?: boolean }
//       Done. The cleaned result is stored in the job payload (`pcListing`,
//       lib/importers/pc-listing-result.ts) and the job goes back to the
//       browser, which lists it (lib/import-jobs.ts releasePcJob).
//   { jobId, error }
//       The PC could not do it this time (yt-dlp or the network failed). The
//       job waits for the next poll; after the third try it fails with
//       `error`, which the owner sees (failPcJob).
//
// Answers 200 { ok: true, status }, 400 for a bad body, 404 for an unknown
// job, 409 when the job is not waiting for the PC any more (the PC just
// moves on), 413 for a body over 4 MB.

import { agentAuthorized } from '../../auth'
import { isUuid, jsonError } from '../../requests'
import { failPcJob, getJob, releasePcJob } from '../../../../../lib/import-jobs'
import { pcListingImporter } from '../../../../../lib/importers/pc-listing'
import { MAX_BODY_BYTES, parsePcResult, PC_RESULT_KEY } from '../../../../../lib/importers/pc-listing-result'

const FALLBACK_ERROR = "Your PC couldn't read those links. Try again later."

async function readBody(request: Request): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return { response: jsonError(413, 'Too big') }
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return { response: jsonError(400, 'Expected a JSON body') }
  }
  if (raw.length > MAX_BODY_BYTES) return { response: jsonError(413, 'Too big') }
  try {
    const body: unknown = JSON.parse(raw)
    if (body && typeof body === 'object' && !Array.isArray(body)) return { body: body as Record<string, unknown> }
  } catch {
    // falls through
  }
  return { response: jsonError(400, 'Expected a JSON object') }
}

export async function POST(request: Request): Promise<Response> {
  if (!agentAuthorized(request)) return jsonError(401, 'Unauthorized')
  const read = await readBody(request)
  if ('response' in read) return read.response
  const { body } = read
  if (!isUuid(body.jobId)) return jsonError(400, 'jobId must be a UUID')
  try {
    const job = await getJob(body.jobId)
    if (!job || job.importer !== pcListingImporter.id) return jsonError(404, 'Import not found')
    if (job.status !== 'waiting_pc') return jsonError(409, 'This import is not waiting for the PC')

    if (body.error !== undefined) {
      const message = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : FALLBACK_ERROR
      const status = await failPcJob(job.id, message)
      if (!status) return jsonError(409, 'This import is not waiting for the PC')
      return Response.json({ ok: true, status })
    }

    const parsed = parsePcResult(body)
    if ('error' in parsed) return jsonError(400, parsed.error)
    if (!(await releasePcJob(job.id, { [PC_RESULT_KEY]: parsed.result }))) {
      return jsonError(409, 'This import is not waiting for the PC')
    }
    const songs = parsed.result.playlists.reduce((sum, playlist) => sum + playlist.trackCount, 0)
    return Response.json({ ok: true, status: 'new', playlists: parsed.result.playlists.length, songs })
  } catch (error) {
    console.error('[agent/import/complete] failed:', error)
    return jsonError(500, 'Complete failed')
  }
}
