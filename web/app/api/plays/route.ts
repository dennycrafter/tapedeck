// POST /api/plays { trackId, seconds, playedAt? } (SPEC 8.6): one play,
// sent by the player once 30 seconds were listened or the song ended.
// `playedAt` is for plays made offline and sent later (SPEC 8.9); it may
// not be in the future.
import { isUuid, jsonError, readJsonObject } from '../agent/requests'
import { recordPlay } from '../../../lib/library'

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  if (!body || !isUuid(body.trackId)) return jsonError(400, 'Expected { trackId, seconds }')
  // Only a real number or a numeric string: Number(null), Number('') and
  // Number(false) are all 0 and would slip through as a 0-second play.
  const raw = body.seconds
  const seconds =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (!Number.isFinite(seconds) || seconds < 0) return jsonError(400, 'seconds must be 0 or more')
  let playedAt: Date | undefined
  if (body.playedAt !== undefined) {
    const parsed = typeof body.playedAt === 'string' ? Date.parse(body.playedAt) : Number.NaN
    if (Number.isNaN(parsed) || parsed > Date.now() + 60_000) return jsonError(400, 'playedAt must be a past date')
    playedAt = new Date(parsed)
  }
  try {
    const recorded = await recordPlay(body.trackId, seconds, playedAt)
    // A song deleted before its play arrived: nothing to count, not an error.
    return Response.json({ recorded }, { status: recorded ? 201 : 200 })
  } catch (error) {
    console.error('[plays] failed:', error)
    return jsonError(500, 'Could not record the play')
  }
}
