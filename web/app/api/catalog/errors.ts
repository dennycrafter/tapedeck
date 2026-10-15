// Shared error answers for the /api/catalog routes (V2-PLAN T11).
import { jsonError } from '../agent/requests'
import { CatalogNotFoundError } from '../../../lib/catalog'

/** The words the pages show when the catalog cannot be reached. */
export const CATALOG_DOWN_MESSAGE = 'The music catalog is not answering. Try again in a moment.'

/** 404 for an unknown album or artist, 502 for anything the providers failed on. */
export function catalogError(cause: unknown, what: string, notFound: string): Response {
  if (cause instanceof CatalogNotFoundError) return jsonError(404, notFound)
  console.error(`[catalog] ${what} failed:`, cause)
  return jsonError(502, CATALOG_DOWN_MESSAGE)
}

/** The `:id` path segment as text; a malformed escape is simply not an id. */
export function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
