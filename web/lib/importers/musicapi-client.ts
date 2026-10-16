/**
 * The HTTP shape of MusicAPI.com (V2-PLAN T13, adapter 1), in one small file
 * so it is easy to fix when their API turns out to differ from the public
 * docs (read on 2026-10-16 without an account; see docs/DECISIONS.md,
 * "T13 MusicAPI login"):
 *
 *   log in    https://app.musicapi.com/integrations/<slug>?returnUrl=...&ms=<service>
 *             The browser comes back to returnUrl with `data64`: base64 JSON
 *             { integrationUserUUID, authModel: { uuid, status, error }, integration: { type } }.
 *   playlists GET https://api.musicapi.com/api/<integrationUserUUID>/playlists
 *   liked     GET https://api.musicapi.com/api/<integrationUserUUID>/liked/tracks
 *   songs     GET https://api.musicapi.com/api/<integrationUserUUID>/playlists/<playlistId>/items
 *             Each page is { results, nextParam, totalItems }; send `nextParam`
 *             back to get the next page, and `limitParam` for the page size
 *             (each service caps it: Spotify 50, Apple Music 25, Tidal 20).
 *   auth      `Authorization: Basic base64(clientId:clientSecret)`, server only.
 *
 * Every call goes through lib/http.ts (MSW intercepts it in unit tests). Under
 * TAPEDECK_TEST=1 the calls are answered from recorded-shape fixtures instead
 * (./musicapi-standin.ts), so tests and CI never reach MusicAPI.
 */

import { HttpError, httpJson } from '../http'
import { ImportUserError, type ServiceId } from './types'

export const MUSICAPI_API_BASE = 'https://api.musicapi.com'
export const MUSICAPI_AUTH_BASE = 'https://app.musicapi.com'

/** Songs per page we ask for. MusicAPI lowers it to what each service allows. */
export const MUSICAPI_PAGE_SIZE = 50
export const MUSICAPI_TIMEOUT_MS = 15_000

/** Tapedeck's service ids to MusicAPI's `ms` names (their "authSources"). */
export const MUSICAPI_SERVICE: Readonly<Partial<Record<ServiceId, string>>> = {
  spotify: 'spotify',
  apple: 'appleMusic',
  ytmusic: 'youtube',
  tidal: 'tidal',
  deezer: 'deezer',
}

export type MusicapiConfig =
  | { mode: 'live'; clientId: string; clientSecret: string; slug: string }
  | { mode: 'standin' }

/**
 * How MusicAPI is reached: the stand-in under TAPEDECK_TEST=1 (even when keys
 * are set, so tests never call MusicAPI), the real API when all three
 * settings are there, else null (the login button hides).
 */
export function musicapiConfig(env: NodeJS.ProcessEnv = process.env): MusicapiConfig | null {
  if (env.TAPEDECK_TEST === '1') return { mode: 'standin' }
  const clientId = env.MUSICAPI_CLIENT_ID?.trim()
  const clientSecret = env.MUSICAPI_CLIENT_SECRET?.trim()
  const slug = env.MUSICAPI_SLUG?.trim()
  if (!clientId || !clientSecret || !slug) return null
  return { mode: 'live', clientId, clientSecret, slug }
}

/** Where to send the browser to log in to one service. */
export function musicapiLoginUrl(base: string, returnUrl: string, service: string): string {
  const url = new URL(base)
  url.searchParams.set('returnUrl', returnUrl)
  url.searchParams.set('ms', service)
  // Come straight back on a failed or cancelled log in, instead of staying on their page.
  url.searchParams.set('forwardFailures', 'true')
  return url.toString()
}

/** The real log-in page for an account slug. */
export function musicapiLiveLoginBase(slug: string): string {
  return `${MUSICAPI_AUTH_BASE}/integrations/${encodeURIComponent(slug)}`
}

// ---------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------

export interface MusicapiCallback {
  integrationUserUUID?: unknown
  authModel?: { uuid?: unknown; status?: unknown; error?: unknown } | null
  integration?: { type?: unknown } | null
}

/**
 * Decodes the `data64` query parameter, or null when it is missing or not
 * base64 JSON. A `+` that arrived unencoded reads as a space, so spaces are
 * put back; both base64 alphabets are accepted.
 */
export function decodeCallback(data64: string | null): MusicapiCallback | null {
  if (!data64) return null
  try {
    const json = Buffer.from(data64.replace(/ /g, '+'), 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as MusicapiCallback) : null
  } catch {
    return null
  }
}

/** The reverse, for the stand-in log-in page and tests. */
export function encodeCallback(data: MusicapiCallback): string {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
}

// ---------------------------------------------------------------------------
// Pages of playlists and songs
// ---------------------------------------------------------------------------

export interface MusicapiArtist {
  id?: string | null
  name?: string | null
}

export interface MusicapiPlaylist {
  id: string
  name: string
  totalItems?: number | null
  imageUrl?: string | null
  isOwner?: boolean
}

export interface MusicapiTrack {
  id?: string | null
  entryId?: string | null
  name?: string | null
  isrc?: string | null
  /** Milliseconds. */
  duration?: number | null
  imageUrl?: string | null
  album?: { id?: string | null; name?: string | null } | null
  artists?: MusicapiArtist[] | null
  isAvailable?: boolean | null
}

export interface MusicapiPage<T> {
  results: T[]
  nextParam?: string | null
  totalItems?: number | null
}

/** Answers one GET for a full API URL: the real HTTP call, or the stand-in. */
export type MusicapiTransport = (url: string) => Promise<unknown>

export function liveTransport(clientId: string, clientSecret: string): MusicapiTransport {
  const authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
  return (url) =>
    httpJson<unknown>(url, {
      headers: { Authorization: authorization, 'Content-Type': 'application/json; charset=utf-8' },
      timeoutMs: MUSICAPI_TIMEOUT_MS,
    })
}

export function pageUrl(path: string, next: string | null, limit: number = MUSICAPI_PAGE_SIZE): string {
  const url = new URL(path, MUSICAPI_API_BASE)
  url.searchParams.set('limitParam', String(limit))
  if (next) url.searchParams.set('nextParam', next)
  return url.toString()
}

function asPage<T>(raw: unknown, url: string): MusicapiPage<T> {
  const body = (raw ?? {}) as Partial<MusicapiPage<T>>
  if (!Array.isArray(body.results)) {
    throw new HttpError('parse', `MusicAPI answered without results: ${url}`, { url })
  }
  return {
    results: body.results,
    nextParam: typeof body.nextParam === 'string' && body.nextParam !== '' ? body.nextParam : null,
    totalItems: typeof body.totalItems === 'number' ? body.totalItems : null,
  }
}

/** Status codes that mean "this service has no such list", not "something broke". */
export function isMissing(cause: unknown): boolean {
  return cause instanceof HttpError && cause.kind === 'status' && (cause.status === 400 || cause.status === 404 || cause.status === 405 || cause.status === 501)
}

/**
 * Turns MusicAPI's refusals into plain words for the owner; everything else
 * is passed on (the core shows a generic message and logs it).
 */
export function explain(cause: unknown): unknown {
  if (!(cause instanceof HttpError) || cause.kind !== 'status') return cause
  if (cause.status === 401 || cause.status === 403) {
    return new ImportUserError('MusicAPI did not accept the keys. Check MUSICAPI_CLIENT_ID and MUSICAPI_CLIENT_SECRET.')
  }
  if (cause.status === 429) return new ImportUserError('The music service is busy. Wait a minute and try again.')
  return cause
}

export interface MusicapiClient {
  playlists(user: string, next: string | null): Promise<MusicapiPage<MusicapiPlaylist>>
  likedTracks(user: string, next: string | null, limit?: number): Promise<MusicapiPage<MusicapiTrack>>
  playlistItems(user: string, playlistId: string, next: string | null): Promise<MusicapiPage<MusicapiTrack>>
}

export function musicapiClient(transport: MusicapiTransport): MusicapiClient {
  const get = async <T>(path: string, next: string | null, limit?: number): Promise<MusicapiPage<T>> => {
    const url = pageUrl(path, next, limit)
    return asPage<T>(await transport(url), url)
  }
  const userPath = (user: string) => `/api/${encodeURIComponent(user)}`
  return {
    playlists: (user, next) => get(`${userPath(user)}/playlists`, next),
    likedTracks: (user, next, limit) => get(`${userPath(user)}/liked/tracks`, next, limit),
    playlistItems: (user, playlistId, next) =>
      get(`${userPath(user)}/playlists/${encodeURIComponent(playlistId)}/items`, next),
  }
}
