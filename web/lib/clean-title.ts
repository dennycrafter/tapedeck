/**
 * Rule cleaner (SPEC 8.4 step 1) — always run on freshly fetched metadata,
 * and the fallback when the AI step (T3) is unavailable. Pure string logic.
 *
 * Rules, in order:
 *  1. Remove (case-insensitive) bracketed or trailing marketing text —
 *     `Official Video` and friends — plus empty brackets left behind.
 *     Loose words after a removed marketing bracket are description junk
 *     and go with it ("[Official Video] Furious 7 Soundtrack"); bracketed
 *     version info and a feat clause after it are kept.
 *  2. SoundCloud: a title of the form "X by Y" (from oEmbed) splits into
 *     title X, artist Y.
 *  3. A title containing ` - ` (or U+2013/U+2014 with spaces) splits:
 *     left = artist, right = title.
 *  4. Featured artists (`ft.`, `ft`, `feat`, `featuring`) in title or artist
 *     are normalised to `(feat. Name)` at the end of the title. The names
 *     stop where a bracket starts, so "(Live)" after them stays in place.
 *  A kept bracket gets one space before it: "STYLE(x)" becomes "STYLE (x)".
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

/** Lazy left side → the FIRST dash splits artist from title (8.4). Inputs are tidied before splitting, so no dotAll flag is needed. */
const DASH_SPLIT_PATTERN = /^(.+?)\s[-–—]\s(.+)$/

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

const OPEN_BRACKETS = '([{'
const CLOSE_BRACKETS = ')]}'

/** Opening brackets minus closing brackets; 0 when every group in the text is closed. */
function bracketDepth(text: string): number {
  let depth = 0
  for (const ch of text) {
    if (OPEN_BRACKETS.includes(ch)) depth++
    else if (CLOSE_BRACKETS.includes(ch) && depth > 0) depth--
  }
  return depth
}

interface Piece {
  text: string
  bracketed: boolean
}

/**
 * Split text into top-level pieces: balanced bracket groups (nesting kept
 * inside) and the loose runs between them. An unclosed group at the end
 * counts as loose text.
 */
function topLevelPieces(text: string): Piece[] {
  const pieces: Piece[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (OPEN_BRACKETS.includes(ch)) {
      if (depth === 0 && i > start) {
        pieces.push({ text: text.slice(start, i), bracketed: false })
        start = i
      }
      depth++
    } else if (CLOSE_BRACKETS.includes(ch) && depth > 0) {
      depth--
      if (depth === 0) {
        pieces.push({ text: text.slice(start, i + 1), bracketed: true })
        start = i + 1
      }
    }
  }
  if (start < text.length) pieces.push({ text: text.slice(start), bracketed: false })
  return pieces
}

/** A feat marker (8.4): `ft.`, `ft`, `feat`, `featuring`, as whole words. */
const FEAT_MARKER = /\b(?:featuring|feat|ft)\b\.?\s*:?\s*/i

/**
 * What survives after a removed marketing bracket: later bracket groups
 * (version info such as "(Live)"; marketing ones go on the next pass) and
 * a feat clause ("(Official Video) ft. Bruno Mars"). Any other loose text
 * is description junk ("[Official Video] Furious 7 Soundtrack").
 */
function keepAfterMarketing(tail: string): string {
  const kept: string[] = []
  for (const piece of topLevelPieces(tail)) {
    if (piece.bracketed) {
      kept.push(piece.text)
      continue
    }
    const feat = piece.text.search(FEAT_MARKER)
    if (feat !== -1) kept.push(piece.text.slice(feat))
  }
  return kept.join(' ')
}

/** True when the text has words outside any bracket group. */
function hasLooseText(text: string): boolean {
  return topLevelPieces(text).some((piece) => !piece.bracketed && piece.text.trim().length > 0)
}

/**
 * Remove the first marketing bracket group, or return the text unchanged.
 * A top-level group that follows the song text also drops the loose junk
 * after it; a nested group, or one that leads the title ("[MV] Artist -
 * Song"), is only cut out.
 */
function removeFirstMarketingGroup(text: string): string {
  for (const match of text.matchAll(BRACKET_GROUP)) {
    if (match.index === undefined || !isMarketingText(match[1])) continue
    const head = text.slice(0, match.index)
    const tail = text.slice(match.index + match[0].length)
    if (bracketDepth(head) !== 0 || !hasLooseText(head)) return `${head} ${tail}`
    return `${head} ${keepAfterMarketing(tail)}`
  }
  return text
}

/** Remove marketing bracket groups, then the empty brackets they leave behind, until stable. */
function removeBracketedMarketing(text: string): string {
  let current = text
  let previous = ''
  while (current !== previous) {
    previous = current
    current = removeFirstMarketingGroup(current)
    current = current.replace(EMPTY_BRACKETS, ' ')
  }
  return current
}

/** One space before a bracket glued to the word in front of it: "STYLE(x)" becomes "STYLE (x)". */
function spaceBeforeBrackets(text: string): string {
  return text.replace(/([^\s([{])([([{])/gu, '$1 $2')
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

/**
 * Cut the first feat marker out of the text. The names run to the next
 * bracket (or the end); text from that bracket on stays in place. A marker
 * inside a group ("(feat. A)") takes the group's closing bracket with it,
 * and a group with text before the marker ("(Remix feat. A)") is closed.
 */
function extractFeatured(text: string): FeatSplit {
  const match = text.match(FEAT_MARKER)
  if (!match || match.index === undefined) return { text: text.trim(), names: null }
  const after = text.slice(match.index + match[0].length)
  const stop = after.search(/[()[\]{}]/)
  const names = (stop === -1 ? after : after.slice(0, stop)).replace(/[\s,]+$/, '').trim()
  let rest = stop === -1 ? '' : after.slice(stop)
  let before = stripDanglingEnd(text.slice(0, match.index))
  if (rest && CLOSE_BRACKETS.includes(rest[0])) {
    const closer = rest[0]
    rest = rest.slice(1)
    if (bracketDepth(before) > 0) before = `${before}${closer}`
  }
  return { text: tidy(`${before} ${rest}`), names: names || null }
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

/** The "Restore original" suffixes (8.4 Undo): only ` - Topic` and `VEVO`. */
const RESTORE_SUFFIX = /\s*-\s*topic\s*$|\s*-\s*vevo\s*$|vevo\s*$/i

/**
 * The restore-original artist (song menu "Restore original", 8.4 Undo): the
 * raw artist with only " - Topic" and "VEVO" stripped. " Official" stays:
 * that strip belongs to the cleaner's channel fallback, not to restore. A
 * raw artist that is nothing but a suffix ("VEVO") is kept as is; only an
 * empty raw artist becomes "Unknown Artist".
 */
export function restoreOriginalArtist(rawArtist: string): string {
  const raw = tidy(rawArtist)
  let current = raw
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(RESTORE_SUFFIX, '').trim()
  }
  // "Name - VEVO" leaves a stray dash behind; tidy it.
  current = current.replace(/\s[-\u2013\u2014|]\s*$/, '').trim()
  return current || raw || UNKNOWN_ARTIST
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
    title: spaceBeforeBrackets(title) || raw,
    artist: artist || UNKNOWN_ARTIST,
  }
}
