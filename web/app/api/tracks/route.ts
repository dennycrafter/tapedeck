// POST /api/tracks (SPEC 8.2) — the add pipeline. One request carries up to
// 25 pasted lines; each line independently becomes a result:
//
//   { results: [{ index, line, status: 'added' | 'already' | 'error',
//                 message, track? }] }
//
//   1. Parse the line (8.2): every accepted YouTube/SoundCloud form with
//      trailing params stripped and one canonical source_url; anything else
//      gets the SPEC's per-line error.
//   2. SoundCloud short links are resolved server-side first (7.4).
//   3. Dedupe: (source, source_id) already in the library, or repeated
//      earlier in this same paste → "Already in your library".
//   4. Fetch raw metadata (7.3 videos.list batched when YOUTUBE_API_KEY is
//      set, oEmbed otherwise; 7.4 oEmbed for SoundCloud).
//   5. Clean the title (8.4): AI step 2 when ANTHROPIC_API_KEY is set and its
//      reply says music with confidence >= 0.5; the rule cleaner otherwise —
//      an add never fails because AI cleanup is unavailable.
//   6. Look up cover art (8.5): iTunes then Deezer, first candidate matching
//      the rule wins; no match → null cover (blank placeholder). Skipped for
//      non-music replies — the raw thumbnail stays, never a covers result.
//      Insert with status 'waiting'.
//
// Response shape note for the Add window (8.2): the summary toast counts
// statuses; the window stays open only when every line failed. Session
// protection lives in middleware (8.1) — this handler never sees an
// unauthenticated request.

import {
  fetchSoundcloudMetadata,
  fetchYoutubeMetadata,
  MetadataError,
  resolveSoundcloudShortLink,
  type RawTrackMetadata,
} from '../../../lib/metadata'
import { HttpError } from '../../../lib/http'
import { cleanWithFallback } from '../../../lib/ai-clean'
import { lookupCoverArt } from '../../../lib/cover-art'
import { parseSongLink, type ParsedSongLink } from '../../../lib/parse-source-url'
import { sql, type Row } from '../../../lib/db'

/** SPEC 8.2: "max 25 per request". */
export const MAX_LINES = 25

export interface TrackJson {
  id: string
  source: string
  sourceId: string
  sourceUrl: string
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  coverUrl: string | null
  durationSec: number | null
  status: string
}

export interface LineResult {
  index: number
  line: string
  status: 'added' | 'already' | 'error'
  /** "Added", "Already in your library", or the per-line error text (8.2). */
  message: string
  /** Present only for added lines. */
  track?: TrackJson
}

interface Candidate {
  index: number
  line: string
  link: ParsedSongLink
}

interface TrackRow extends Row {
  id: string
  source: string
  source_id: string
  source_url: string
  title: string
  artist: string
  album: string | null
  album_artist: string | null
  cover_url: string | null
  duration_sec: number | null
  status: string
}

function trackJson(row: TrackRow): TrackJson {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.album_artist,
    coverUrl: row.cover_url,
    durationSec: row.duration_sec,
    status: row.status,
  }
}

/** Resolve a line to a parsed link, following SoundCloud short links (7.4). */
async function parseLine(line: string): Promise<{ link?: ParsedSongLink; error?: string }> {
  let parsed = parseSongLink(line)
  if (parsed.kind === 'soundcloud-shortlink') {
    let resolved: string
    try {
      resolved = await resolveSoundcloudShortLink(parsed.shortUrl)
    } catch (cause) {
      const detail =
        cause instanceof HttpError && cause.status === 404
          ? 'That SoundCloud link does not exist.'
          : 'Could not resolve that SoundCloud link.'
      return { error: detail }
    }
    parsed = parseSongLink(resolved)
    if (parsed.kind === 'soundcloud-shortlink') {
      // The redirect landed on a short link again — not a track page.
      return { error: 'That link did not lead to a SoundCloud track.' }
    }
  }
  if (parsed.kind === 'error') return { error: parsed.message }
  return { link: parsed.link }
}

function alreadyResult(index: number, line: string): LineResult {
  return { index, line, status: 'already', message: 'Already in your library' }
}

function errorResult(index: number, line: string, message: string): LineResult {
  return { index, line, status: 'error', message }
}

/**
 * Existing (source, source_id) pairs among the candidates, in one query.
 * Candidate ids are unique per request, and YouTube ids and SoundCloud paths
 * are disjoint namespaces, so filtering by source_id is enough here.
 */
async function existingKeys(candidates: readonly Candidate[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()
  const ids = [...new Set(candidates.map((candidate) => candidate.link.sourceId))]
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ')
  const rows = (await sql.unsafe(
    `select source, source_id from tracks where source_id in (${placeholders})`,
    ids,
  )) as TrackRow[]
  const candidateKeys = new Set(candidates.map((c) => `${c.link.source}:${c.link.sourceId}`))
  const found = new Set<string>()
  for (const row of rows) {
    const key = `${row.source}:${row.source_id}`
    if (candidateKeys.has(key)) found.add(key)
  }
  return found
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }
  const urls =
    typeof body === 'object' && body !== null && 'urls' in body ? (body as { urls: unknown }).urls : null
  if (
    !Array.isArray(urls) ||
    urls.some((line) => typeof line !== 'string') ||
    urls.length === 0 ||
    urls.length > MAX_LINES
  ) {
    return Response.json({ error: `Expected urls: string[] with 1 to ${MAX_LINES} lines.` }, { status: 400 })
  }

  // Steps 1-2 (8.2): parse every line; short links resolve concurrently.
  const parsed = await Promise.all(
    (urls as string[]).map(async (line, index) => ({ index, line, ...(await parseLine(line)) })),
  )

  // Step 3 (8.2): within-paste dedupe; the library check follows in one query.
  const candidates: Candidate[] = []
  const results: LineResult[] = new Array(urls.length)
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (entry.error) {
      results[entry.index] = errorResult(entry.index, entry.line, entry.error)
      continue
    }
    if (!entry.link) continue // unreachable: parseLine returns a link or an error
    const key = `${entry.link.source}:${entry.link.sourceId}`
    if (seen.has(key)) {
      results[entry.index] = alreadyResult(entry.index, entry.line)
      continue
    }
    seen.add(key)
    candidates.push({ index: entry.index, line: entry.line, link: entry.link })
  }
  const existing = await existingKeys(candidates)

  // Step 4 (8.2): metadata — one batched YouTube call, oEmbed per SoundCloud link.
  const youtubeIds = [...new Set(candidates.filter((c) => c.link.source === 'youtube').map((c) => c.link.sourceId))]
  const youtubeMetadata = await fetchYoutubeMetadata(youtubeIds, process.env.YOUTUBE_API_KEY)
  const soundcloudMetadata = new Map<string, RawTrackMetadata | MetadataError>()
  await Promise.all(
    [...new Set(candidates.filter((c) => c.link.source === 'soundcloud').map((c) => c.link.sourceUrl))].map(
      async (sourceUrl) => {
        try {
          soundcloudMetadata.set(sourceUrl, await fetchSoundcloudMetadata(sourceUrl))
        } catch (cause) {
          soundcloudMetadata.set(
            sourceUrl,
            cause instanceof MetadataError ? cause : new MetadataError('Could not fetch SoundCloud metadata'),
          )
        }
      },
    ),
  )

  // Step 5 (8.2): clean (8.4) and insert with status 'waiting'.
  for (const candidate of candidates) {
    if (existing.has(`${candidate.link.source}:${candidate.link.sourceId}`)) {
      results[candidate.index] = alreadyResult(candidate.index, candidate.line)
      continue
    }
    const metadata =
      candidate.link.source === 'youtube'
        ? youtubeMetadata.get(candidate.link.sourceId)
        : soundcloudMetadata.get(candidate.link.sourceUrl)
    if (!metadata || metadata instanceof Error) {
      results[candidate.index] = errorResult(
        candidate.index,
        candidate.line,
        errorText(metadata, 'No metadata found for that link.'),
      )
      continue
    }

    // Step 5 (8.4): AI cleanup with the rule cleaner as the deterministic
    // fallback; step 6 (8.5): cover lookup, skipped when the AI verdict was
    // non-music — a covers result is never attached to non-music.
    const outcome = await cleanWithFallback(metadata, process.env.ANTHROPIC_API_KEY, candidate.link.source)
    const cover = outcome.isMusic === false ? null : await lookupCoverArt(outcome.title, outcome.artist)
    try {
      const inserted = (await sql`
        insert into tracks (source, source_id, source_url, raw_title, raw_artist, raw_thumbnail_url, title, artist, album, album_artist, cover_url, duration_sec, ai_cleaned, ai_confidence)
        values (${candidate.link.source}, ${candidate.link.sourceId}, ${candidate.link.sourceUrl},
                ${metadata.rawTitle}, ${metadata.rawArtist}, ${metadata.rawThumbnailUrl ?? null},
                ${outcome.title}, ${outcome.artist}, ${cover?.album ?? null}, ${cover?.albumArtist ?? null},
                ${cover?.coverUrl ?? null}, ${metadata.durationSec ?? null}, ${outcome.aiCleaned}, ${outcome.aiConfidence})
        returning id, source, source_id, source_url, title, artist, album, album_artist, cover_url, duration_sec, status
      `) as TrackRow[]
      results[candidate.index] = {
        index: candidate.index,
        line: candidate.line,
        status: 'added',
        message: 'Added',
        track: inserted[0] ? trackJson(inserted[0]) : undefined,
      }
    } catch (cause) {
      results[candidate.index] = errorResult(candidate.index, candidate.line, errorText(cause, 'Could not add that track.'))
    }
  }

  return Response.json({ results })
}
