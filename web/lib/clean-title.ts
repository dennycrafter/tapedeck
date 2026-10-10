/**
 * Rule cleaner (SPEC 8.4 step 1) — always run on freshly fetched metadata,
 * and the fallback when the AI step (T3) is unavailable. Pure string logic.
 *
 * Rules, in order:
 *  1. Remove (case-insensitive) bracketed or trailing marketing text —
 *     `Official Video` and friends — plus empty brackets left behind.
 *  2. SoundCloud: a title of the form "X by Y" (from oEmbed) splits into
 *     title X, artist Y.
 *  3. A title containing ` - ` (or U+2013/U+2014 with spaces) splits:
 *     left = artist, right = title.
 *  4. Featured artists (`ft.`, `ft`, `feat`, `featuring`) in title or artist
 *     are normalised to `(feat. Name)` at the end of the title.
 *  5. Otherwise the artist is the channel name with suffixes removed
 *     (` - Topic`, `VEVO`, ` Official`, `Official`).
 * An artist that ends up empty becomes "Unknown Artist".
 */

import type { TrackSource } from './parse-source-url'

export interface CleanedMetadata {
  title: string
  artist: string
}

/** The artist shown when nothing better exists (task brief: "empty artist becomes Unknown Artist"). */
export const UNKNOWN_ARTIST = 'Unknown Artist'

/**
 * Multi-word marketing phrases (8.4), lowercased. Single-word items live in
 * MARKETING_TOKENS below.
 */
const MARKETING_PHRASES = new Set([
  'official video',
  'official music video',
  'official audio',
  'official lyric video',
  'lyric video',
  'music video',
  'clip officiel',
])

/**
 * Single marketing words (8.4) — plus combinations: a bracket or trailing
 * run whose every token is one of these counts as marketing text ("(HD 4K)",
 * "Song | Official Visualizer").
 */
const MARKETING_TOKENS = new Set([
  'official',
  'lyrics',
  'audio',
  'visualizer',
  'visualiser',
  'hd',
  'hq',
  '4k',
  'mv',
  'm/v',
  'explicit',
])

/** Whitespace-padded dash separators: ` - `, ` – ` (U+2013), ` — ` (U+2014). */
const DASH_SEPARATOR = /\s[-–—]\s/

/** Lazy left side → the FIRST dash splits artist from title (8.4). */
const DASH_SPLIT_PATTERN = /^(.+?)\s[-–—]\s(.+)$/s

const BY_SPLIT_PATTERN = /^(.+?)\s+by\s+(.+)$/i

/** A bracket group whose content holds no nested brackets. */
const BRACKET_GROUP = /[([{]([^()[\]{}]*?)[)\]}]/g

const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]|\{\s*\}/g

/** SoundCloud uploader suffixes and YouTube channel suffixes (8.4). */
const CHANNEL_SUFFIX = /\s*-\s*topic\s*$|\s*-\s*vevo\s*$|vevo\s*$|\s*-\s*official\s*$|\s*official\s*$/i

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * True when the text is pure marketing (8.4): a listed phrase, or a run of
 * listed single tokens. Case-insensitive; whitespace-collapsed.
 */
function isMarketingText(text: string): boolean {
  const normalized = tidy(text).toLowerCase()
  if (!normalized) return false
  if (MARKETING_PHRASES.has(normalized)) return true
  return normalized.split(' ').every((token) => MARKETING_TOKENS.has(token))
}

/** Remove marketing bracket groups, then the empty brackets they leave behind, until stable. */
function removeBracketedMarketing(text: string): string {
  let current = text
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(BRACKET_GROUP, (match, inner: string) => (isMarketingText(inner) ? ' ' : match))
    current = current.replace(EMPTY_BRACKETS, ' ')
  }
  return current
}

/**
 * Remove trailing marketing text after a separator ("Song | Official Video",
 * "Get Lucky - Official Video") and bare trailing marketing words
 * ("Song Official Video"). Runs BEFORE the artist split so a track titled
 * "Get Lucky - Official Video" is not mistaken for artist "Get Lucky".
 */
function stripTrailingMarketing(text: string): string {
  let current = text
  let previous = ''
  while (current !== previous) {
    previous = current
    // Greedy prefix → the LAST separator; strip only pure-marketing tails.
    const separated = current.match(/^(.*\S)\s[-–—|·•~]+\s*(\S.*)$/u)
    if (separated && isMarketingText(separated[2])) {
      current = separated[1]
      continue
    }
    const words = current.split(' ')
    if (words.length >= 2 && isMarketingText(words.slice(-2).join(' '))) {
      current = words.slice(0, -2).join(' ')
      continue
    }
    if (words.length >= 2 && isMarketingText(words[words.length - 1])) {
      current = words.slice(0, -1).join(' ')
      continue
    }
  }
  return current
}

/**
 * "X by Y" from SoundCloud oEmbed (8.4). Guarded to titles without a dash
 * separator — "A - B by C" keeps the dash split's more explicit reading.
 */
function splitByArtist(title: string): { title: string; artist: string } | null {
  const match = title.match(BY_SPLIT_PATTERN)
  if (!match) return null
  return { title: match[1], artist: match[2] }
}

function splitOnDash(title: string): { title: string; artist: string } | null {
  const match = title.match(DASH_SPLIT_PATTERN)
  if (!match) return null
  return { artist: match[1], title: match[2] }
}

/** Strip the dangling separator/bracket left when a feat marker is cut out. */
function stripDanglingEnd(text: string): string {
  return text.replace(/[\s([{\-–—·,|]+$/, '').trim()
}

interface FeatSplit {
  text: string
  names: string | null
}

/** Cut the first feat marker out of the text; the rest of the string is the names. */
function extractFeatured(text: string): FeatSplit {
  const match = text.match(/\b(?:featuring|feat|ft)\b\.?\s*:?\s*/i)
  if (!match || match.index === undefined) return { text: text.trim(), names: null }
  const names = text.slice(match.index + match[0].length).replace(/[\s)\]},]+$/, '').trim()
  return { text: stripDanglingEnd(text.slice(0, match.index)), names: names || null }
}

/** Featured artists from title and artist move to `(feat. A, B)` at the end of the title (8.4). */
function moveFeaturedArtists(title: string, artist: string): CleanedMetadata {
  const fromTitle = extractFeatured(title)
  const fromArtist = extractFeatured(artist)
  const names = [fromTitle.names, fromArtist.names].filter((name): name is string => name !== null)
  return {
    title: names.length > 0 ? `${fromTitle.text} (feat. ${names.join(', ')})` : fromTitle.text,
    artist: fromArtist.text,
  }
}

/** Channel-name fallback (8.4): strip ` - Topic`, `VEVO`, ` Official`, `Official`. */
function cleanChannelArtist(artist: string): string {
  let current = artist.trim()
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(CHANNEL_SUFFIX, '').trim()
  }
  // "Name - VEVO" leaves a stray dash behind — tidy it.
  return current.replace(/\s[-–—|]\s*$/, '').trim()
}

/**
 * The 8.4 step-1 result for one track's raw metadata. Never returns an empty
 * title (falls back to the raw title) or an empty artist ("Unknown Artist").
 */
export function cleanTitleRules(
  rawTitle: string,
  rawArtist: string,
  source: TrackSource,
): CleanedMetadata {
  const raw = tidy(rawTitle)
  let title = tidy(stripTrailingMarketing(tidy(removeBracketedMarketing(raw))))
  let artist = tidy(rawArtist)
  let artistFromSplit = false

  const by = source === 'soundcloud' && !DASH_SEPARATOR.test(title) ? splitByArtist(title) : null
  if (by) {
    title = by.title
    artist = by.artist
    artistFromSplit = true
  } else {
    const dash = splitOnDash(title)
    if (dash) {
      artist = dash.artist
      title = dash.title
      artistFromSplit = true
    }
  }

  const featured = moveFeaturedArtists(title, artist)
  title = featured.title
  artist = featured.artist

  // The channel-suffix cleanup is the no-split fallback (8.4 "else" branch).
  if (!artistFromSplit) artist = cleanChannelArtist(artist)

  return {
    title: title || raw,
    artist: artist || UNKNOWN_ARTIST,
  }
}
