// POST /api/uploads (T15): step 1 of uploading a song from this device.
// Body { fileName, bytes, fingerprint, coverBytes? } (the browser has read
// the tags and fingerprinted the file already). Answers
//   { status: 'ready', id, contentType, uploadUrl, coverUploadUrl }  PUT the file there
//   { status: 'already', trackId, message }                         same file uploaded before
// or 400 with { error } for a file that is not a song or is too big.
// Step 2 is POST /api/uploads/<id>/complete. Session-gated by the proxy.
import { jsonError, readJsonObject } from '../agent/requests'
import { ensureUploadCors, startUpload } from '../../../lib/uploads'

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  if (!body) return jsonError(400, 'Expected a JSON object')
  try {
    const result = await startUpload(body)
    if (result.status === 'error') return jsonError(result.httpStatus, result.message)
    if (result.status === 'ready') await ensureUploadCors(new URL(request.url).origin)
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[uploads] start failed:', error)
    return jsonError(500, 'Could not start the upload. Try again.')
  }
}
