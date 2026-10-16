/**
 * The MusicAPI stand-in (SPEC 4.1 pattern, V2-PLAN T13): under TAPEDECK_TEST=1
 * the log in goes to a fake MusicAPI page (/api/test/musicapi-login) that
 * comes straight back to the callback, and every API call is answered from
 * web/e2e/fixtures/import-musicapi/responses.json, keyed by path plus sorted
 * query. Tests and CI never reach MusicAPI. The fixtures are shaped from
 * MusicAPI's public docs (their user endpoints need an account).
 */

import { HttpError } from '../http'
import type { MusicapiTransport } from './musicapi-client'

/** The fake page that plays MusicAPI's log-in screen. */
export const STANDIN_LOGIN_PATH = '/api/test/musicapi-login'

interface StandinFixtures {
  user: string
  responses: Record<string, unknown>
}

let fixtures: Promise<StandinFixtures> | null = null

export function loadStandinFixtures(): Promise<StandinFixtures> {
  fixtures ??= import('../../e2e/fixtures/import-musicapi/responses.json').then(
    (m) => (m.default ?? m) as unknown as StandinFixtures,
  )
  return fixtures
}

/** `/api/<user>/playlists?limitParam=50&nextParam=x` for the full URL. */
export function standinKey(rawUrl: string): string {
  const url = new URL(rawUrl)
  const names = [...new Set(url.searchParams.keys())].sort()
  const query = names.map((name) => `${name}=${url.searchParams.get(name) ?? ''}`).join('&')
  return decodeURIComponent(url.pathname) + (query ? `?${query}` : '')
}

function isStatus(value: unknown): value is { status: number } {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 1 && typeof (value as { status?: unknown }).status === 'number'
}

/** Answers like the real API: the recorded body, `{ status }` as that error, else 404. */
export const standinTransport: MusicapiTransport = async (url) => {
  const { responses } = await loadStandinFixtures()
  const body = responses[standinKey(url)]
  if (body === undefined || isStatus(body)) {
    const status = body === undefined ? 404 : body.status
    throw new HttpError('status', `HTTP ${status} calling ${url}`, { status, url, bodyExcerpt: '{"message":"stand-in"}' })
  }
  return structuredClone(body)
}
