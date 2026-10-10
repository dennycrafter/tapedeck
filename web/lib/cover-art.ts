/**
 * Cover art and album lookup (SPEC 8.5, 7.6) — iTunes Search API first, then
 * Deezer; no keys for either. A candidate wins when it passes the 8.5 match
 * rule: normalised artist of one side contains the other's AND title token
 * overlap (Jaccard) is >= 0.8. No match → null on everything (the UI shows
 * the blank placeholder); the YouTube thumbnail is never a cover.
 *
 * Pure matching logic (normalizeForMatch, jaccard, stripAlbumSuffix,
 * pickCoverMatch) is exported for the unit tests; the fetchers go through
 * lib/http.ts so MSW intercepts them in tests (9.0).
 *
 * First-match caveat, documented from the recorded fixtures (2026-10-10):
 * provider ordering wins ties — iTunes ranked "Blinding Lights (Remix)"
 * first and bracket normalisation makes that title exact, so the remix
 * single's cover is chosen. That is the SPEC rule as written ("First
 * candidate that matches wins"); adding a preference order would be a
 * deviation from it.
 */

import { HttpError, httpJson } from './http'

/** One candidate returned by a cover provider (7.6 fields). */
export interface CoverCandidate {
  title: string
  artist: string
  album: string
  artworkUrl: string
}

/** The 8.5 outcome stored on the track when a candidate matches. */
export interface CoverArtMatch {
  coverUrl: string
  album: string
  albumArtist: string
}

/** SPEC 8.5: title token overlap (Jaccard) at or above this matches. */
export const JACCARD_THRESHOLD = 0.8

// ---------------------------------------------------------------------------
// Normalisation (SPEC 8.5 + task brief: lowercase, accents, brackets,
// feat parts, punctuation, spaces, ampersand vs and, article strips)
// ---------------------------------------------------------------------------

/** A bracket group whose content holds no nested brackets. */
const BRACKET_GROUP = /[([{]([^()[\]{}]*?)[)\]}]/g

/** Cut the first feat marker and everything after it (8.5 "remove feat./ft. parts"). */
const FEAT_MARKER = /\b(?:featuring|feat|ft)\b\s*\.?:?\s*/i

/** Punctuation and symbols: everything that is not a letter, number or space. */
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu

/**
 * The 8.5 normal form used for BOTH sides of a match: lowercase, `&` →
 * "and", accents stripped, bracketed text removed, feat parts removed,
 * punctuation removed, spaces collapsed, and a leading article ("the ")
 * dropped so "The Weeknd" and "Weeknd" normalise identically.
 */
export function normalizeForMatch(text: string): string {
  let current = text.toLowerCase()
  current = current.replace(/&/g, ' and ')
  current = current.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  // Bracket groups can nest marketing inside version info — remove until stable.
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(BRACKET_GROUP, ' ')
  }
  const featIndex = current.search(FEAT_MARKER)
  if (featIndex !== -1) current = current.slice(0, featIndex)
  current = current.replace(PUNCTUATION, ' ')
  current = current.replace(/\s+/g, ' ').trim()
  // Article strip (task brief): a leading "the " carries no identity.
  return current.replace(/^the /, '').trim()
}

/** Token-set Jaccard overlap of two already-normalised strings (8.5). */
export function jaccardOverlap(a: string, b: string): number {
  const tokensA = new Set(a.split(' ').filter(Boolean))
  const tokensB = new Set(b.split(' ').filter(Boolean))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }
  return intersection / (tokensA.size + tokensB.size - intersection)
}

/** True when one normalised artist contains the other's (both non-empty, 8.5). */
export function artistMatches(ourArtist: string, candidateArtist: string): boolean {
  const ours = normalizeForMatch(ourArtist)
  const theirs = normalizeForMatch(candidateArtist)
  if (!ours || !theirs) return false
  return theirs.includes(ours) || ours.includes(theirs)
}

/** The full 8.5 match rule for one candidate. */
export function candidateMatches(candidate: CoverCandidate, title: string, artist: string): boolean {
  if (!artistMatches(artist, candidate.artist)) return false
  const ourTitle = normalizeForMatch(title)
  const candidateTitle = normalizeForMatch(candidate.title)
  if (!ourTitle || !candidateTitle) return false
  return jaccardOverlap(ourTitle, candidateTitle) >= JACCARD_THRESHOLD
}

// ---------------------------------------------------------------------------
// Album naming (SPEC 8.5: strip ` - Single` / ` - EP`, keep grouping by the
// stripped name — storing the stripped name does both)
// ---------------------------------------------------------------------------

const ALBUM_SUFFIX = /\s+-\s+(single|ep)$/i

/** `Gangnam Style - Single` → `Gangnam Style`; anything else unchanged. */
export function stripAlbumSuffix(album: string): string {
  return album.replace(ALBUM_SUFFIX, '').trim()
}

/** First matching candidate wins (8.5); the stored album/artist come from it. */
export function pickCoverMatch(
  candidates: readonly CoverCandidate[],
  title: string,
  artist: string,
): CoverArtMatch | null {
  for (const candidate of candidates) {
    if (candidateMatches(candidate, title, artist)) {
      return {
        coverUrl: candidate.artworkUrl,
        album: stripAlbumSuffix(candidate.album),
        albumArtist: candidate.artist,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Provider fetches (SPEC 7.6) — iTunes first, then Deezer
// ---------------------------------------------------------------------------

interface ItunesResult {
  trackName?: string
  artistName?: string
  collectionName?: string
  artworkUrl100?: string
}

interface ItunesResponse {
  results?: ItunesResult[]
}

/** SPEC 7.6: the big cover is the same artwork with 100x100bb → 600x600bb. */
export function itunesBigArtwork(artworkUrl100: string): string {
  return artworkUrl100.replace('100x100bb', '600x600bb')
}

function itunesCandidates(body: ItunesResponse): CoverCandidate[] {
  const candidates: CoverCandidate[] = []
  for (const result of body.results ?? []) {
    if (!result.trackName || !result.artistName || !result.artworkUrl100) continue
    candidates.push({
      title: result.trackName,
      artist: result.artistName,
      album: result.collectionName ?? '',
      artworkUrl: itunesBigArtwork(result.artworkUrl100),
    })
  }
  return candidates
}

interface DeezerData {
  title?: string
  artist?: { name?: string }
  album?: { title?: string; cover_xl?: string }
}

interface DeezerResponse {
  data?: DeezerData[]
}

function deezerCandidates(body: DeezerResponse): CoverCandidate[] {
  const candidates: CoverCandidate[] = []
  for (const row of body.data ?? []) {
    if (!row.title || !row.artist?.name || !row.album?.cover_xl) continue
    candidates.push({
      title: row.title,
      artist: row.artist.name,
      album: row.album.title ?? '',
      artworkUrl: row.album.cover_xl,
    })
  }
  return candidates
}

/**
 * Deezer lookup for `<artist> <title>` in plain terms. Deviation from the
 * SPEC 7.6 strict form `artist:"X" track:"Y"`, recorded in T0 and re-confirmed
 * on 2026-10-10: the strict form returns zero results live (total: 0 for
 * every probe), the plain-terms form is the documented stand-in.
 */
async function fetchDeezerCandidates(title: string, artist: string): Promise<CoverCandidate[]> {
  const query = `${artist} ${title}`
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`
  try {
    return deezerCandidates(await httpJson<DeezerResponse>(url))
  } catch (cause) {
    // Cover lookup never fails an add (8.5: no match → blank cover); log and continue.
    console.warn('[cover-art] Deezer lookup failed:', cause instanceof HttpError ? `${cause.status} ${cause.url}` : cause)
    return []
  }
}

async function fetchItunesCandidates(title: string, artist: string): Promise<CoverCandidate[]> {
  const term = `${artist} ${title}`
  const url =
    'https://itunes.apple.com/search' +
    `?term=${encodeURIComponent(term)}&entity=song&limit=5&country=US`
  try {
    return itunesCandidates(await httpJson<ItunesResponse>(url))
  } catch (cause) {
    console.warn('[cover-art] iTunes lookup failed:', cause instanceof HttpError ? `${cause.status} ${cause.url}` : cause)
    return []
  }
}

/**
 * The 8.5 lookup for one track: iTunes first, then Deezer; first matching
 * candidate wins. Resolves null when nothing matches or both providers fail
 * — never throws, so adding never fails because of cover art.
 */
export async function lookupCoverArt(title: string, artist: string): Promise<CoverArtMatch | null> {
  const itunes = await fetchItunesCandidates(title, artist)
  const itunesMatch = pickCoverMatch(itunes, title, artist)
  if (itunesMatch) return itunesMatch

  const deezer = await fetchDeezerCandidates(title, artist)
  return pickCoverMatch(deezer, title, artist)
}
