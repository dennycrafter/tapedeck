// PUT /api/settings/apple-music { on } (SPEC 8.11): the profile setting
// "Also add to Apple Music on my PC". The downloader reads it through
// GET /api/agent/settings and copies every finished song while it is on.
import { jsonError, readJsonObject } from '../../agent/requests'
import { setAppleMusicExport } from '../../../../lib/library'

export async function PUT(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  if (!body || typeof body.on !== 'boolean') return jsonError(400, 'Expected { on: boolean }')
  try {
    await setAppleMusicExport(body.on)
    return Response.json({ appleMusicExport: body.on })
  } catch (error) {
    console.error('[settings/apple-music] failed:', error)
    return jsonError(500, 'Could not save the setting')
  }
}
