import { http, HttpResponse } from 'msw'

import deezerCatalog from '../fixtures/catalog-deezer.json'
import itunesCatalog from '../fixtures/catalog-itunes.json'
import importDeezer from '../fixtures/import-deezer.json'
import { fixtureKey } from '../../lib/catalog-fixtures'

/**
 * MSW handlers for the T11 catalog calls (Deezer search, album, artist and
 * track; iTunes search and lookup), backed by the same recorded files the
 * app's stand-in reads (fixtures/catalog-*.json, keyed by `fixtureKey`).
 * Kept apart from handlers.ts: unit tests add them with
 * `server.use(...catalogHandlers)`.
 *
 * A request these files do not know falls through to the next handler, so
 * the cover-art lookups (same /search endpoints, other parameters) still get
 * their own fixtures from handlers.ts. Unknown catalog-only paths answer with
 * the recorded Deezer "no data" error or an empty result.
 */

const deezerFiles = deezerCatalog as { responses: Record<string, unknown>; unknown: unknown; empty: unknown }
// T13's recordings (ISRC lookups, artist + title searches) sit in their own file.
const deezer = {
  ...deezerFiles,
  responses: { ...deezerFiles.responses, ...(importDeezer.responses as Record<string, unknown>) },
}
const itunes = itunesCatalog as { responses: Record<string, unknown>; empty: unknown }

export const catalogHandlers = [
  http.get('https://api.deezer.com/*', ({ request }) => {
    const key = fixtureKey(request.url)
    if (key in deezer.responses) return HttpResponse.json(deezer.responses[key] as object)
    const path = new URL(request.url).pathname
    if (path === '/search') return undefined // cover-art lookups: handlers.ts answers
    return HttpResponse.json((path.startsWith('/search') ? deezer.empty : deezer.unknown) as object)
  }),

  http.get('https://itunes.apple.com/:endpoint', ({ request }) => {
    const key = fixtureKey(request.url)
    if (key in itunes.responses) return HttpResponse.json(itunes.responses[key] as object)
    if (new URL(request.url).pathname === '/search') return undefined // cover-art lookups: handlers.ts answers
    return HttpResponse.json(itunes.empty as object)
  }),
]
