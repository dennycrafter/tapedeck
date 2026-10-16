// GET /api/catalog/artist/:id (V2-PLAN T11): one catalog artist with their
// top songs and albums, each carrying an `inLibrary` flag. Session-gated
// like every /api route.
import { jsonError } from '../../../agent/requests'
import { getArtist } from '../../../../../lib/catalog'
import { loadLibraryIndex, markAlbums, markTracks } from '../../../../../lib/catalog-library'
import { isCatalogId, type CatalogArtistResponse } from '../../../../../lib/catalog-types'
import { catalogError, decodeId } from '../../errors'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const id = decodeId((await ctx.params).id)
  if (!isCatalogId(id)) return jsonError(400, 'Not a catalog artist id')
  try {
    const [detail, index] = await Promise.all([getArtist(id), loadLibraryIndex()])
    const body: CatalogArtistResponse = {
      artist: { ...detail.artist, inLibrary: index.hasArtist(detail.artist) },
      topTracks: markTracks(detail.topTracks, index),
      albums: markAlbums(detail.albums, index),
    }
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return catalogError(cause, 'artist', "This artist isn't in the catalog.")
  }
}
