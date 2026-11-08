// POST /api/uploads/<id>/complete (T15): step 2 of uploading a song. The
// browser has PUT the file (and its cover) to the URLs step 1 gave it; this
// checks the file arrived and adds the song, ready to play. Body
// { fileName, fingerprint, title?, artist?, album?, albumArtist?,
//   durationSec?, cover? }. Answers { status: 'added', message, track } or
// { status: 'already', trackId, message }; errors are { error }.
import { isUuid, jsonError, readJsonObject } from '../../../agent/requests'
import { finishUpload } from '../../../../../lib/uploads'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Upload id must be a UUID')
  const body = await readJsonObject(request)
  if (!body) return jsonError(400, 'Expected a JSON object')
  try {
    const result = await finishUpload(id.toLowerCase(), body)
    if (result.status === 'error') return jsonError(result.httpStatus, result.message)
    return Response.json(result)
  } catch (error) {
    console.error('[uploads] complete failed:', error)
    return jsonError(500, 'Could not add this song. Try again.')
  }
}
