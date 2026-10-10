/**
 * Raw metadata fetchers (SPEC 7.3, 7.4) — the input to title cleanup (8.4).
 *
 * YouTube: with `YOUTUBE_API_KEY`, batched Data API `videos.list` calls
 * (1 quota unit per call, up to 50 ids each); without a key, YouTube oEmbed
 * per video — no key, but no description and no duration either (7.3).
 * SoundCloud: SoundCloud oEmbed, no key, no duration (7.4).
 *
 * Every outbound call goes through lib/http.ts (4.1) so timeouts and errors
 * stay uniform and MSW intercepts everything in tests (9.0).
 */

import { HttpError, httpResponse, httpJson } from './http'

/** What the add pipeline (8.2 step 3) needs before cleanup (8.4). */
export interface RawTrackMetadata {
  /** oEmbed / Data API title, before cleanup. */
  rawTitle: string
  /** YouTube channel or SoundCloud uploader, before cleanup. */
  rawArtist: string
  rawThumbnailUrl: string | null
  /** First 300 characters of the description; '' when the source gives none. */
  description: string
  /** Expected length from metadata; null until the downloader reports it (7.3). */
  durationSec: number | null
}

/** One track's metadata could not be fetched (missing video, quota, network…). */
export class MetadataError extends Error {
  /** HTTP status when the failure came from a response. */
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'MetadataError'
    this.status = options.status
  }
}

// ---------------------------------------------------------------------------
// ISO 8601 duration (SPEC 7.3 `contentDetails.duration`, e.g. `PT3M45S`)
// ---------------------------------------------------------------------------

const ISO_DURATION_PATTERN = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

/** `PT3M45S` → 225. Returns null for anything that does not parse. */
export function parseIsoDuration(value: string): number | null {
  const match = ISO_DURATION_PATTERN.exec(value.trim())
  if (!match) return null
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => (part ? Number(part) : 0))
  // All groups absent ("P", "PT") carries no information — treat as unknown.
  if (match.slice(1).every((part) => part === undefined)) return null
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds
  return Number.isFinite(total) ? Math.round(total) : null
}

// ---------------------------------------------------------------------------
// YouTube (SPEC 7.3)
// ---------------------------------------------------------------------------

interface YoutubeVideoItem {
  id?: string
  snippet?: {
    title?: string
    channelTitle?: string
    description?: string
    thumbnails?: { high?: { url?: string } }
  }
  contentDetails?: { duration?: string }
}

interface VideosListResponse {
  items?: YoutubeVideoItem[]
}

/** The Data API accepts at most 50 ids per videos.list call (SPEC 7.3). */
const VIDEOS_LIST_MAX_IDS = 50

/** SPEC 7.3: only the first 300 characters of the description go to the cleaner. */
const DESCRIPTION_MAX_CHARS = 300

function metadataFromVideoItem(item: YoutubeVideoItem): RawTrackMetadata | null {
  const snippet = item.snippet
  if (!item.id || !snippet?.title) return null
  return {
    rawTitle: snippet.title,
    rawArtist: snippet.channelTitle ?? '',
    rawThumbnailUrl: snippet.thumbnails?.high?.url ?? null,
    description: (snippet.description ?? '').slice(0, DESCRIPTION_MAX_CHARS),
    durationSec: item.contentDetails
      ? parseIsoDuration(item.contentDetails.duration ?? '')
      : null,
  }
}

async function fetchVideosListPage(
  ids: readonly string[],
  apiKey: string,
): Promise<Map<string, RawTrackMetadata | MetadataError>> {
  const byId = new Map<string, RawTrackMetadata | MetadataError>()
  let body: VideosListResponse
  try {
    const url =
      'https://www.googleapis.com/youtube/v3/videos' +
      `?part=snippet,contentDetails&id=${ids.map(encodeURIComponent).join(',')}` +
      `&key=${encodeURIComponent(apiKey)}`
    body = await httpJson<VideosListResponse>(url)
  } catch (cause) {
    const status = cause instanceof HttpError ? cause.status : undefined
    const error = new MetadataError('Could not fetch YouTube metadata', { status, cause })
    for (const id of ids) byId.set(id, error)
    return byId
  }

  for (const id of ids) byId.set(id, new MetadataError(`YouTube video not found: ${id}`, { status: 404 }))
  for (const item of body.items ?? []) {
    const metadata = metadataFromVideoItem(item)
    if (metadata && item.id) byId.set(item.id, metadata)
  }
  return byId
}

/**
 * Metadata for YouTube video ids (8.2 step 3). With an API key one batched
 * `videos.list` serves the whole batch; without one, oEmbed per id. Every id
 * resolves to metadata or a `MetadataError` — the map has an entry per input.
 */
export async function fetchYoutubeMetadata(
  ids: readonly string[],
  apiKey: string | undefined,
): Promise<Map<string, RawTrackMetadata | MetadataError>> {
  if (ids.length === 0) return new Map()

  if (!apiKey) {
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await fetchYoutubeOembedMetadata(id)] as const
        } catch (cause) {
          if (cause instanceof MetadataError) return [id, cause] as const
          throw cause
        }
      }),
    )
    return new Map(results)
  }

  const byId = new Map<string, RawTrackMetadata | MetadataError>()
  const pages: string[][] = []
  for (let start = 0; start < ids.length; start += VIDEOS_LIST_MAX_IDS) {
    pages.push(ids.slice(start, start + VIDEOS_LIST_MAX_IDS))
  }
  const pageResults = await Promise.all(pages.map((page) => fetchVideosListPage(page, apiKey)))
  for (const page of pageResults) {
    for (const [id, metadata] of page) byId.set(id, metadata)
  }
  return byId
}

interface OEmbedResponse {
  title?: string
  author_name?: string
  thumbnail_url?: string
}

/**
 * oEmbed fallback when no YOUTUBE_API_KEY is set (7.3): title, author_name
 * and thumbnail only — no description (the cleaner gets ''), no duration
 * (null until the downloader reports it).
 */
export async function fetchYoutubeOembedMetadata(id: string): Promise<RawTrackMetadata> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`
  try {
    const body = await httpJson<OEmbedResponse>(url)
    if (!body.title) throw new Error('oEmbed response has no title')
    return {
      rawTitle: body.title,
      rawArtist: body.author_name ?? '',
      rawThumbnailUrl: body.thumbnail_url ?? null,
      description: '',
      durationSec: null,
    }
  } catch (cause) {
    if (cause instanceof MetadataError) throw cause
    const status = cause instanceof HttpError ? cause.status : undefined
    throw new MetadataError(`Could not fetch YouTube metadata for ${id}`, { status, cause })
  }
}

// ---------------------------------------------------------------------------
// SoundCloud (SPEC 7.4)
// ---------------------------------------------------------------------------

/**
 * Follow an `on.soundcloud.com` short link server-side to its canonical
 * track URL (7.4: "follow the redirect server-side first"). Resolves with
 * the final URL after redirects; a dead link rejects with `HttpError`.
 */
export async function resolveSoundcloudShortLink(shortUrl: string): Promise<string> {
  // redirect: 'follow' is fetch's default; response.url is the final URL.
  // The response body (an HTML page) is intentionally left unread — only
  // where the redirect chain ended matters here.
  const response = await httpResponse(shortUrl)
  return response.url
}

/** SoundCloud oEmbed (7.4). The title is usually "Track by Artist" — the rule cleaner (8.4) splits it. */
export async function fetchSoundcloudMetadata(sourceUrl: string): Promise<RawTrackMetadata> {
  const url = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(sourceUrl)}`
  try {
    const body = await httpJson<OEmbedResponse>(url)
    if (!body.title) throw new Error('oEmbed response has no title')
    return {
      rawTitle: body.title,
      rawArtist: body.author_name ?? '',
      rawThumbnailUrl: body.thumbnail_url ?? null,
      description: '',
      durationSec: null,
    }
  } catch (cause) {
    if (cause instanceof MetadataError) throw cause
    const status = cause instanceof HttpError ? cause.status : undefined
    throw new MetadataError(`Could not fetch SoundCloud metadata for ${sourceUrl}`, { status, cause })
  }
}
