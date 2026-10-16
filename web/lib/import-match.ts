/**
 * Matching imported songs to the catalog (V2-PLAN T13, "Matching to the
 * catalog"): enrichment for cover and album, best effort.
 *
 *   1. ISRC first: Deezer `track/isrc:<ISRC>`.
 *   2. Otherwise a catalog search for "artist title"; the first result whose
 *      title and artist match (the SPEC 8.5 rule: normalised title overlap,
 *      one artist contains the other) and whose length is within 5 s wins.
 *   3. No match: the caller stores the song as `import:<service>:<id>` with
 *      the source's own metadata. The PC finder (T12) works from title,
 *      artist and length either way.
 *
 * Lookups go through lib/catalog.ts, so they are cached for 24 hours and
 * answered from the recorded fixtures under TAPEDECK_TEST=1. A lookup that
 * fails (Deezer and iTunes both down) counts as no match: the import never
 * stops for enrichment.
 */

import { findTrackByIsrc, searchTracks } from './catalog'
import type { CatalogTrack } from './catalog-types'
import { candidateMatches } from './cover-art'

/** V2-PLAN T13: "the length within 5 s". */
export const LENGTH_TOLERANCE_SEC = 5
const MAX_QUERY_LENGTH = 200

export type MatchHow = 'isrc' | 'search' | 'none'

export interface MatchInput {
  title: string
  artist: string
  durationSec: number | null
  isrc: string | null
}

export interface MatchOutcome {
  how: MatchHow
  catalog: CatalogTrack | null
}

/** Both lengths known and further apart than the tolerance. */
export function lengthTooFar(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null || a <= 0 || b <= 0) return false
  return Math.abs(a - b) > LENGTH_TOLERANCE_SEC
}

/** The search text: "artist title", trimmed and capped. */
export function searchQuery(input: Pick<MatchInput, 'title' | 'artist'>): string {
  return `${input.artist} ${input.title}`.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH)
}

/** Pure: the first search result that is this song, or null. */
export function pickSearchMatch(results: readonly CatalogTrack[], input: MatchInput): CatalogTrack | null {
  for (const result of results) {
    const same = candidateMatches(
      { title: result.title, artist: result.artist, album: result.album ?? '', artworkUrl: '' },
      input.title,
      input.artist,
    )
    if (same && !lengthTooFar(result.durationSec, input.durationSec)) return result
  }
  return null
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** ISRC first, then artist + title search; never throws. */
export async function matchToCatalog(input: MatchInput): Promise<MatchOutcome> {
  if (input.isrc) {
    try {
      const found = await findTrackByIsrc(input.isrc)
      if (found) return { how: 'isrc', catalog: found }
    } catch (cause) {
      console.warn('[import-match] ISRC lookup failed:', describe(cause))
    }
  }
  const query = searchQuery(input)
  if (!input.title.trim() || query.length < 2) return { how: 'none', catalog: null }
  try {
    const found = pickSearchMatch(await searchTracks(query), input)
    if (found) return { how: 'search', catalog: found }
  } catch (cause) {
    console.warn('[import-match] catalog search failed:', describe(cause))
  }
  return { how: 'none', catalog: null }
}

/**
 * Runs `work` over `items` with at most `concurrency` at a time, starting no
 * new item after `deadline` (ms since epoch), except the first, so every
 * call makes progress. Items start in order, so the results are a prefix:
 * by index, with the items not started left undefined for the next request.
 */
export async function runWithDeadline<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  opts: { concurrency: number; deadline: number; now?: () => number },
): Promise<(R | undefined)[]> {
  const now = opts.now ?? Date.now
  const results: (R | undefined)[] = new Array(items.length).fill(undefined)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length && (next === 0 || now() < opts.deadline)) {
      const index = next++
      results[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, items.length) }, worker))
  return results
}
