// GET /api/profile (SPEC 8.6): display name, stats strip (songs, listening
// time, plays this month, storage used) and top 5 artists this month.
// PATCH /api/profile { displayName }: edit the name on Home and Profile.
import { jsonError, readJsonObject } from '../agent/requests'
import { cleanName, getProfile, setDisplayName } from '../../../lib/library'

export async function GET(request: Request): Promise<Response> {
  new URL(request.url)
  try {
    return Response.json(await getProfile(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[profile] failed:', error)
    return jsonError(500, 'Profile unavailable')
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const name = cleanName(body?.displayName)
  if (!name) return jsonError(400, 'Name must not be empty')
  try {
    await setDisplayName(name)
    return Response.json({ displayName: name })
  } catch (error) {
    console.error('[profile/update] failed:', error)
    return jsonError(500, 'Could not save the name')
  }
}
