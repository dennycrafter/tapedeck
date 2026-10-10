import { http, HttpResponse } from 'msw'

import anthropicFixture from '../fixtures/anthropic-messages.json'
import deezerFixture from '../fixtures/deezer-search.json'
import itunesFixture from '../fixtures/itunes-search.json'
import oembedFixture from '../fixtures/youtube-oembed.json'
import searchFixture from '../fixtures/youtube-search.json'
import videosFixture from '../fixtures/youtube-videos-list.json'

/**
 * Recorded-fixture handlers for the external APIs Tapedeck calls (SPEC 4.1,
 * 7.3, 7.5, 7.6, 9.0). Every response body comes from web/e2e/fixtures/ —
 * nothing here reaches the network. The unknown/empty responses mirror the
 * recorded live behaviour so tests stay deterministic on both paths.
 *
 * JSON imports arrive untyped, so the casts below declare only the fields
 * the handlers read; the full recorded body is always returned verbatim.
 */

const FIXTURE_ETAG = 'fixture'

interface OEmbedBody {
  title: string
  author_name: string
  thumbnail_url: string
}

interface OEmbedUnknown {
  status: number
  contentType: string
  body: string
}

interface VideoRecord {
  snippet: {
    publishedAt: string
    channelId: string
    title: string
    description: string
    channelTitle: string
    thumbnails: Record<string, { url: string; width: number; height: number }>
  }
  contentDetails: { duration: string }
}

interface SearchListBody {
  kind: string
  etag: string
  items: unknown[]
}

interface ItunesBody {
  resultCount: number
  results: unknown[]
}

interface DeezerBody {
  data: unknown[]
  total: number
}

interface AnthropicBody {
  id: string
  type: string
  role: string
  model: string
  content: { type: string; text: string }[]
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number }
}

const oembed = oembedFixture as { videos: Record<string, OEmbedBody>; unknown: OEmbedUnknown }
const videos = videosFixture as Record<string, VideoRecord>
const search = searchFixture as { queries: Record<string, SearchListBody>; empty: SearchListBody }
const itunes = itunesFixture as { terms: Record<string, ItunesBody>; empty: ItunesBody }
const deezer = deezerFixture as { queries: Record<string, DeezerBody>; empty: DeezerBody }
const anthropic = anthropicFixture as Record<string, AnthropicBody>

/** Extract the 11-char video id from a watch or youtu.be URL (SPEC 7.3). */
export function parseYouTubeVideoId(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null
    return url.searchParams.get('v')
  } catch {
    return null
  }
}

/** Fixture lookup key: lowercase, whitespace collapsed. */
export function normalizeQueryKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Deezer lookup key. The SPEC's strict form (artist:"X" track:"Y") and the
 * plain-terms form both collapse to "artist title"; see fixtures README.
 */
export function deezerQueryKey(raw: string): string {
  const strict = raw.match(/artist\s*:\s*"([^"]+)"\s+track\s*:\s*"([^"]+)"/i)
  return normalizeQueryKey(strict ? `${strict[1]} ${strict[2]}` : raw)
}

/** Fixture convention: unknown ids are omitted from items (empty array when none match). */
function videoListResponse(ids: string[]) {
  const items = ids.flatMap((id) => {
    const record = videos[id]
    if (!record) return []
    return [{ kind: 'youtube#video', etag: FIXTURE_ETAG, id, ...record }]
  })
  return HttpResponse.json({ kind: 'youtube#videoListResponse', etag: FIXTURE_ETAG, items })
}

export const handlers = [
  // YouTube Data API v3: videos.list (SPEC 7.3) — 1 quota unit.
  http.get('https://www.googleapis.com/youtube/v3/videos', ({ request }) => {
    const ids = (new URL(request.url).searchParams.get('id') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    return videoListResponse(ids)
  }),

  // YouTube Data API v3: search.list (SPEC 4.1: "In tests: recorded fixtures").
  http.get('https://www.googleapis.com/youtube/v3/search', ({ request }) => {
    const q = normalizeQueryKey(new URL(request.url).searchParams.get('q') ?? '')
    return HttpResponse.json(search.queries[q] ?? search.empty)
  }),

  // YouTube oEmbed metadata fallback when no API key is set (SPEC 7.3).
  http.get('https://www.youtube.com/oembed', ({ request }) => {
    const videoId = parseYouTubeVideoId(new URL(request.url).searchParams.get('url') ?? '')
    const body = videoId ? oembed.videos[videoId] : undefined
    if (!body) {
      const unknown = oembed.unknown
      return new HttpResponse(unknown.body, {
        status: unknown.status,
        headers: { 'content-type': unknown.contentType },
      })
    }
    return HttpResponse.json(body)
  }),

  // iTunes Search API cover lookup (SPEC 7.6) — tried first.
  http.get('https://itunes.apple.com/search', ({ request }) => {
    const term = normalizeQueryKey(new URL(request.url).searchParams.get('term') ?? '')
    return HttpResponse.json(itunes.terms[term] ?? itunes.empty)
  }),

  // Deezer cover lookup (SPEC 7.6) — fallback.
  http.get('https://api.deezer.com/search', ({ request }) => {
    const key = deezerQueryKey(new URL(request.url).searchParams.get('q') ?? '')
    return HttpResponse.json(deezer.queries[key] ?? deezer.empty)
  }),

  // Anthropic title-cleanup (SPEC 7.5, 8.4 step 2) — serves the single
  // recorded exchange for every request; tests needing a different exchange
  // override with server.use().
  http.post('https://api.anthropic.com/v1/messages', () =>
    HttpResponse.json(anthropic.default),
  ),
]
