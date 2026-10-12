// PUT /api/albums/favorite { album, albumArtist, favorite } (SPEC 8.6): the
// heart on an album page. Albums are tracks grouped by album + album_artist.
import { jsonError, readJsonObject } from '../../agent/requests'
import { setAlbumFavorite } from '../../../../lib/library'

const MAX = 500

export async function PUT(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const album = typeof body?.album === 'string' ? body.album.trim().slice(0, MAX) : ''
  const albumArtist = typeof body?.albumArtist === 'string' ? body.albumArtist.trim().slice(0, MAX) : null
  if (!album || albumArtist === null || typeof body?.favorite !== 'boolean') {
    return jsonError(400, 'Expected { album, albumArtist, favorite }')
  }
  try {
    await setAlbumFavorite(album, albumArtist, body.favorite)
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[albums/favorite] failed:', error)
    return jsonError(500, 'Could not update the album')
  }
}
