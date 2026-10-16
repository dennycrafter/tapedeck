// GET /api/catalog/search?q=&type=all|tracks|albums|artists (V2-PLAN T11):
// songs, albums and artists from the free catalog (Deezer, iTunes as the
// fallback), each with an `inLibrary` flag. Session-gated like every /api
// route (the proxy's cookie check is the guard). Free to call, so the
// search page runs it while the owner types (debounced on the page).
import { jsonError } from '../../agent/requests'
import { searchCatalog } from '../../../../lib/catalog'
import { loadLibraryIndex, markAlbums, markArtists, markTracks } from '../../../../lib/catalog-library'
import type { CatalogSearchResponse, CatalogSearchType } from '../../../../lib/catalog-types'
import { catalogError } from '../errors'

const MIN_QUERY_LENGTH = 2
const MAX_QUERY_LENGTH = 200
const TYPES: readonly CatalogSearchType[] = ['all', 'tracks', 'albums', 'artists']

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const q = params.get('q')?.trim() ?? ''
  const type = (params.get('type') ?? 'all') as CatalogSearchType
  if (q.length < MIN_QUERY_LENGTH) return jsonError(400, 'Type at least 2 characters to search')
  if (q.length > MAX_QUERY_LENGTH) return jsonError(400, 'That search is too long')
  if (!TYPES.includes(type)) return jsonError(400, 'type must be all, tracks, albums or artists')

  try {
    const [found, index] = await Promise.all([searchCatalog(q, type), loadLibraryIndex()])
    const body: CatalogSearchResponse = {
      tracks: markTracks(found.tracks, index),
      albums: markAlbums(found.albums, index),
      artists: markArtists(found.artists, index),
    }
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return catalogError(cause, 'search', 'Nothing found')
  }
}
