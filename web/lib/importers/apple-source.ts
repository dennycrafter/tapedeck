/**
 * Getting an Apple Music playlist page (V2-PLAN T13, Apple Music link).
 *
 * Live: one GET of the public page through lib/http.ts (so MSW intercepts it
 * in unit tests). The address is always built from the playlist id, never
 * taken from the pasted text, so only music.apple.com is ever called.
 *
 * Under TAPEDECK_TEST=1 (every e2e and unit test run) the pages come from the
 * recordings in e2e/fixtures/import-apple-link/ instead (the stand-in
 * pattern, SPEC 4.1, like lib/catalog-fixtures.ts), so tests and CI never
 * call Apple. A playlist id with no recording answers like Apple does for an
 * unknown playlist: the recorded 404.
 */

import { HttpError, httpResponse } from '../http'

export interface ApplePageResponse {
  status: number
  html: string
}

/** Pages with all their songs are big (about 1.7 MB for 300 songs). */
const PAGE_TIMEOUT_MS = 15_000

const USER_AGENT = 'Tapedeck (personal music app)'

/** True when pages come from the recordings. `APPLE_SOURCE=live` lets unit tests run the live path against MSW. */
export function appleUsesFixtures(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.APPLE_SOURCE?.trim().toLowerCase() === 'live') return false
  return env.TAPEDECK_TEST === '1'
}

export function applePlaylistUrl(storefront: string, id: string): string {
  return `https://music.apple.com/${encodeURIComponent(storefront)}/playlist/${encodeURIComponent(id)}`
}

interface PageFixture {
  status: number
  /** The verbatim `serialized-server-data` script text of a 200 page. */
  serverData?: string
  /** The verbatim body of an error page, or a hand-made page. */
  body?: string
}

type FixtureModule = { default?: PageFixture } & PageFixture

/** Playlist id to recording. Static imports, so the bundler finds the files. */
const FIXTURES: Record<string, () => Promise<FixtureModule>> = {
  'pl.74657640b88c4587a426160f7441de46': () => import('../../e2e/fixtures/import-apple-link/daft-punk-essentials.json'),
  'pl.u-11zB9vyskDZ1AX': () => import('../../e2e/fixtures/import-apple-link/shared-user-playlist.json'),
  'pl.c125e4b2998a4015abbe6b9ae90d5479': () => import('../../e2e/fixtures/import-apple-link/ten-years-top-songs.json'),
  // Hand-made: a page whose layout this importer does not know.
  'pl.u-tapedeckchanged': () => import('../../e2e/fixtures/import-apple-link/changed-page.json'),
}

const MISSING = () => import('../../e2e/fixtures/import-apple-link/missing-playlist.json')

/** A recorded page as the live fetch would return it. */
export async function fixturePage(id: string): Promise<ApplePageResponse> {
  const loaded = await (FIXTURES[id] ?? MISSING)()
  const fixture: PageFixture = loaded.default ?? loaded
  if (fixture.serverData !== undefined) {
    return {
      status: fixture.status,
      html: `<!DOCTYPE html><html><head><script type="application/json" id="serialized-server-data">${fixture.serverData}</script></head><body></body></html>`,
    }
  }
  return { status: fixture.status, html: fixture.body ?? '' }
}

/**
 * The public page of one playlist. A 404 answers `{ status: 404 }`; other
 * failures (network, timeout, other statuses) throw `HttpError`.
 */
export async function fetchApplePlaylistPage(
  storefront: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplePageResponse> {
  if (appleUsesFixtures(env)) return fixturePage(id)
  try {
    const response = await httpResponse(applePlaylistUrl(storefront, id), {
      timeoutMs: PAGE_TIMEOUT_MS,
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' },
    })
    return { status: response.status, html: await response.text() }
  } catch (cause) {
    if (cause instanceof HttpError && cause.kind === 'status' && (cause.status === 404 || cause.status === 410)) {
      return { status: 404, html: '' }
    }
    throw cause
  }
}
