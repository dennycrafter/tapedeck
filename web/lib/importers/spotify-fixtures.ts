/**
 * The Spotify link stand-in (SPEC 4.1 pattern, like lib/catalog-fixtures.ts):
 * Spotify's public pages recorded once into
 * web/e2e/fixtures/import-spotify-link/pages.json, served instead of the
 * network under TAPEDECK_TEST=1, so tests and CI never reach Spotify.
 *
 * The recordings keep only what the adapter reads (the embed page's
 * `__NEXT_DATA__` entity, the profile page's `initialState` entities); the
 * session part with its anonymous token was dropped when recording. Each
 * page is rebuilt here in the same shape as the live one, so the same
 * parser runs on both. The unit tests serve the same pages through MSW
 * (SPOTIFY_SOURCE=live) to cover the network path.
 */

import { embedPath, SpotifyNotFoundError, SpotifyUnavailableError, type PageFetcher } from './spotify-pages'

/** True when the Spotify link adapter reads the recorded pages instead of the network. */
export function spotifyUsesFixtures(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SPOTIFY_SOURCE?.trim().toLowerCase() === 'live') return false
  return env.TAPEDECK_TEST === '1'
}

export interface RecordedPage {
  status: number
  nextData?: unknown
  initialState?: unknown
}

export interface SpotifyRecordings {
  recorded: string
  pages: Record<string, RecordedPage>
  /** Spotify's "Page not available, try again later" embed page, seen while recording. */
  unavailable: RecordedPage
}

/** The recorded answer for a playlist id that does not exist. */
export const MISSING_PLAYLIST_PATH = embedPath('0000000000000000000000')

let recordings: Promise<SpotifyRecordings> | null = null

export function loadSpotifyRecordings(): Promise<SpotifyRecordings> {
  recordings ??= import('../../e2e/fixtures/import-spotify-link/pages.json').then(
    (m) => (m.default ?? m) as unknown as SpotifyRecordings,
  )
  return recordings
}

/** The HTML of a recorded page, rebuilt in the live page's shape. */
export function recordedPageHtml(page: RecordedPage): string {
  const parts: string[] = []
  if (page.nextData !== undefined) {
    parts.push(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(page.nextData)}</script>`)
  }
  if (page.initialState !== undefined) {
    const base64 = Buffer.from(JSON.stringify(page.initialState), 'utf8').toString('base64')
    parts.push(`<script id="initialState" type="text/plain">${base64}</script>`)
  }
  return `<!DOCTYPE html><html><head><title>Spotify</title></head><body>${parts.join('')}</body></html>`
}

/**
 * The recorded page for a path, as the live site would answer: an unknown
 * embed path gets the recorded "Page not found" embed page (HTTP 200, like
 * Spotify), any other unknown path HTTP 404.
 */
export function recordedResponse(data: SpotifyRecordings, path: string): { status: number; html: string } {
  const key = path.replace(/^\/+/, '').split(/[?#]/)[0]
  const page = data.pages[key] ?? (key.startsWith('embed/') ? data.pages[MISSING_PLAYLIST_PATH] : undefined)
  if (!page) return { status: 404, html: 'Not Found' }
  return { status: page.status, html: page.status === 200 ? recordedPageHtml(page) : 'Not Found' }
}

/** The stand-in fetcher: the same errors as the live one, from the recordings. */
export const fetchRecordedSpotifyPage: PageFetcher = async (path) => {
  const { status, html } = recordedResponse(await loadSpotifyRecordings(), path)
  if (status === 404) throw new SpotifyNotFoundError(path)
  if (status !== 200) throw new SpotifyUnavailableError(`recorded HTTP ${status} for ${path}`)
  return html
}
