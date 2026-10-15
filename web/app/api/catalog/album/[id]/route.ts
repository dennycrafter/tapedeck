// GET /api/catalog/album/:id (V2-PLAN T11): one catalog album with its full
// tracklist (`deezer:302127` or `itunes:617154241`), every song carrying an
// `inLibrary` flag; the album's own flag is on when every song is in the
// library. Session-gated like every /api route.
import { jsonError } from '../../../agent/requests'
import { getAlbum } from '../../../../../lib/catalog'
import { loadLibraryIndex, markTracks } from '../../../../../lib/catalog-library'
import { isCatalogId, type CatalogAlbumResponse } from '../../../../../lib/catalog-types'
import { catalogError, decodeId } from '../../errors'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const id = decodeId((await ctx.params).id)
  if (!isCatalogId(id)) return jsonError(400, 'Not a catalog album id')
  try {
    const [detail, index] = await Promise.all([getAlbum(id), loadLibraryIndex()])
    const tracks = markTracks(detail.tracks, index)
    const inLibrary = tracks.length > 0 ? tracks.every((track) => track.inLibrary) : index.hasAlbum(detail.album)
    const body: CatalogAlbumResponse = { album: { ...detail.album, inLibrary }, tracks }
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return catalogError(cause, 'album', "This album isn't in the catalog.")
  }
}
