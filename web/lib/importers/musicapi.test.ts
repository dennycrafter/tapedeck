/**
 * The MusicAPI login importer (V2-PLAN T13, adapter 1): availability, the
 * signed state, the log-in start and finish, the HTTP shape against MSW
 * (Basic auth, nextParam pages, errors in plain words), the stand-in
 * fixtures, the fake log-in page, and one whole log in through the core's
 * routes over PGlite. Nothing here reaches MusicAPI.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { musicapiImporter, toImportTrack } from './musicapi'
import { decodeCallback, encodeCallback, musicapiConfig, type MusicapiTrack } from './musicapi-client'
import { STATE_TTL_SECONDS, signState, verifyState } from './musicapi-state'
import { loadStandinFixtures, standinKey } from './musicapi-standin'
import { ImportUserError, type ImporterJob, type ServiceId } from './types'
import { GET as standinLogin } from '../../app/api/test/musicapi-login/route'
import { POST as jobsPost } from '../../app/api/import/jobs/route'
import { GET as jobGet } from '../../app/api/import/jobs/[id]/route'
import { GET as callbackGet } from '../../app/api/import/callback/[importer]/route'
import { resetDb, sql } from '../db'
import type { CreateJobResponse, ImportJobView } from '../import-types'

const API = 'https://api.musicapi.com'
const USER = '0d6f4a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6'
const JOB = '11111111-2222-4333-8444-555555555555'
const CALLBACK = 'https://tapedeck.test/api/import/callback/musicapi'
const SECRET = 'unit-test-session-secret'

const LIVE_ENV = {
  MUSICAPI_CLIENT_ID: 'client-id',
  MUSICAPI_CLIENT_SECRET: 'client-secret',
  MUSICAPI_SLUG: 'tapedeck-denis',
} as Record<string, string>

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

function useEnv(values: Record<string, string>): void {
  vi.stubEnv('TAPEDECK_TEST', '')
  vi.stubEnv('MUSICAPI_CLIENT_ID', '')
  vi.stubEnv('MUSICAPI_CLIENT_SECRET', '')
  vi.stubEnv('MUSICAPI_SLUG', '')
  vi.stubEnv('SESSION_SECRET', SECRET)
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
}

function job(payload: Record<string, unknown>, service: ServiceId = 'spotify'): ImporterJob {
  return { id: JOB, service, method: 'login', payload }
}

function track(overrides: Partial<MusicapiTrack> = {}): MusicapiTrack {
  return {
    id: '2nLtzopw4rPReszdYBJU6h',
    entryId: 'entry-1',
    name: 'Numb',
    isrc: 'USWB10300474',
    duration: 185586,
    imageUrl: 'https://i.scdn.co/image/cover',
    album: { id: 'alb', name: 'Meteora' },
    artists: [{ id: 'a1', name: 'Linkin Park' }],
    isAvailable: true,
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('availability', () => {
  it('needs the client id, secret and account slug, or the test switch', () => {
    const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv
    expect(musicapiImporter.isAvailable(env({}))).toBe(false)
    expect(musicapiImporter.isAvailable(env({ MUSICAPI_CLIENT_ID: 'a', MUSICAPI_CLIENT_SECRET: 'b' }))).toBe(false)
    expect(musicapiImporter.isAvailable(env({ MUSICAPI_CLIENT_ID: 'a', MUSICAPI_CLIENT_SECRET: ' ', MUSICAPI_SLUG: 'c' }))).toBe(false)
    expect(musicapiImporter.isAvailable(env(LIVE_ENV))).toBe(true)
    expect(musicapiImporter.isAvailable(env({ TAPEDECK_TEST: '1' }))).toBe(true)
  })

  it('always uses the stand-in under TAPEDECK_TEST=1, even with keys set', () => {
    expect(musicapiConfig({ ...LIVE_ENV, TAPEDECK_TEST: '1' } as unknown as NodeJS.ProcessEnv)).toEqual({ mode: 'standin' })
    expect(musicapiConfig(LIVE_ENV as unknown as NodeJS.ProcessEnv)).toEqual({
      mode: 'live',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      slug: 'tapedeck-denis',
    })
  })
})

describe('the signed state', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0)

  it('gives the job id back only when unchanged, ours and not expired', () => {
    const state = signState(JOB, SECRET, now)
    expect(verifyState(state, SECRET, now)).toBe(JOB)
    expect(verifyState(state, SECRET, now + (STATE_TTL_SECONDS - 1) * 1000)).toBe(JOB)
    expect(verifyState(state, SECRET, now + (STATE_TTL_SECONDS + 1) * 1000)).toBeNull()
    expect(verifyState(state, 'another-secret', now)).toBeNull()
    const [, expiry, signature] = state.split('.')
    expect(verifyState(`22222222-2222-4333-8444-555555555555.${expiry}.${signature}`, SECRET, now)).toBeNull()
    expect(verifyState(`${JOB}.${Number(expiry) + 600}.${signature}`, SECRET, now)).toBeNull()
    expect(verifyState(`${JOB}.${expiry}.${signature}x`, SECRET, now)).toBeNull()
    for (const bad of [null, '', JOB, `${JOB}.${expiry}`, `${JOB}.soon.${signature}`, 'a.b.c.d']) {
      expect(verifyState(bad, SECRET, now), String(bad)).toBeNull()
    }
  })
})

describe('log in', () => {
  it('sends the browser to MusicAPI for the picked service, with the signed job id on the return address', async () => {
    useEnv(LIVE_ENV)
    const { redirectUrl } = await musicapiImporter.login!.start({ jobId: JOB, service: 'apple', callbackUrl: CALLBACK })
    const url = new URL(redirectUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://app.musicapi.com/integrations/tapedeck-denis')
    expect(url.searchParams.get('ms')).toBe('appleMusic')
    expect(url.searchParams.get('forwardFailures')).toBe('true')
    const back = new URL(url.searchParams.get('returnUrl') ?? '')
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK)
    expect(verifyState(back.searchParams.get('state'), SECRET)).toBe(JOB)
  })

  it('maps every listed service to MusicAPI', async () => {
    useEnv(LIVE_ENV)
    const names: Record<string, string> = { spotify: 'spotify', apple: 'appleMusic', ytmusic: 'youtube', tidal: 'tidal', deezer: 'deezer' }
    for (const service of musicapiImporter.services) {
      const { redirectUrl } = await musicapiImporter.login!.start({ jobId: JOB, service, callbackUrl: CALLBACK })
      expect(new URL(redirectUrl).searchParams.get('ms')).toBe(names[service])
    }
  })

  it('uses the stand-in log-in page under TAPEDECK_TEST=1', async () => {
    useEnv({ TAPEDECK_TEST: '1' })
    const { redirectUrl } = await musicapiImporter.login!.start({ jobId: JOB, service: 'spotify', callbackUrl: CALLBACK })
    expect(redirectUrl.startsWith('https://tapedeck.test/api/test/musicapi-login?')).toBe(true)
  })

  function callbackParams(state: string | null, data: Parameters<typeof encodeCallback>[0] | null): URLSearchParams {
    const params = new URLSearchParams()
    if (state !== null) params.set('state', state)
    if (data !== null) params.set('data64', encodeCallback(data))
    return params
  }

  const success = {
    integrationUserUUID: USER.toUpperCase(),
    authModel: { uuid: 'a1869581-38b2-4268-aee2-a4c2355efeb0', status: 'success', error: null },
    integration: { type: 'spotify' },
  }

  it('keeps only MusicAPI user id and service for this job', async () => {
    useEnv(LIVE_ENV)
    const result = await musicapiImporter.login!.finish(callbackParams(signState(JOB, SECRET), success), { callbackUrl: CALLBACK })
    expect(result).toEqual({ jobId: JOB, payload: { musicapiUser: USER, musicapiService: 'spotify' } })
  })

  it('reads data64 even when its + signs arrived as spaces', async () => {
    useEnv(LIVE_ENV)
    // This JSON encodes to base64 with a "+" in it.
    const data = { ...success, authModel: { ...success.authModel, error: '>>>' } }
    const encoded = encodeCallback(data)
    expect(encoded).toContain('+')
    expect(decodeCallback(encoded.replace(/\+/g, ' '))).toEqual(data)
    expect(decodeCallback('not base64 json')).toBeNull()
    expect(decodeCallback(null)).toBeNull()
  })

  it('refuses a changed or old state, and a cancelled or failed log in, in plain words', async () => {
    useEnv(LIVE_ENV)
    const finish = (params: URLSearchParams) => musicapiImporter.login!.finish(params, { callbackUrl: CALLBACK })
    const expired = 'That log in has expired. Start again.'
    const cancelled = 'The log in was cancelled or did not work. Try again.'
    expect((await rejection(finish(callbackParams(null, success)))).message).toBe(expired)
    expect((await rejection(finish(callbackParams(signState(JOB, 'other'), success)))).message).toBe(expired)
    const old = signState(JOB, SECRET, Date.now() - (STATE_TTL_SECONDS + 5) * 1000)
    expect((await rejection(finish(callbackParams(old, success)))).message).toBe(expired)
    const state = signState(JOB, SECRET)
    const failed = { ...success, authModel: { uuid: 'x', status: 'error', error: 'accessDenied' } }
    for (const params of [
      callbackParams(state, null),
      callbackParams(state, failed),
      callbackParams(state, { ...success, integrationUserUUID: 'not-a-uuid' }),
    ]) {
      const error = await rejection(finish(params))
      expect(error).toBeInstanceOf(ImportUserError)
      expect(error.message).toBe(cancelled)
    }
  })
})

describe('songs', () => {
  it('maps a MusicAPI song: artists joined, milliseconds to seconds, ISRC, album and cover', () => {
    expect(toImportTrack(track({ artists: [{ name: 'JAY-Z' }, { name: ' Linkin Park ' }, { name: '' }] }), 'spotify')).toEqual({
      ref: '2nLtzopw4rPReszdYBJU6h',
      title: 'Numb',
      artist: 'JAY-Z, Linkin Park',
      album: 'Meteora',
      durationSec: 186,
      isrc: 'USWB10300474',
      coverUrl: 'https://i.scdn.co/image/cover',
    })
    expect(toImportTrack(track({ name: '  ' }), 'spotify')).toBeNull()
    const bare = toImportTrack(track({ id: null, entryId: null, duration: null, isrc: null, album: null, artists: null, imageUrl: null }), 'tidal')
    expect(bare).toMatchObject({ ref: '', artist: '', album: null, durationSec: null, isrc: null, coverUrl: null })
    expect(toImportTrack(track({ id: null }), 'deezer')?.ref).toBe('entry-1')
  })

  it('keeps the exact video of a YouTube Music song as its link', () => {
    expect(toImportTrack(track({ id: 'dQw4w9WgXcQ' }), 'ytmusic')?.link).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(toImportTrack(track({ id: 'PLAYLIST-ITEM-ID-NOT-A-VIDEO' }), 'ytmusic')?.link).toBeUndefined()
    expect(toImportTrack(track({ id: 'dQw4w9WgXcQ' }), 'spotify')?.link).toBeUndefined()
  })
})

describe('reading MusicAPI (MSW)', () => {
  beforeEach(() => useEnv(LIVE_ENV))

  const playlist = (id: string, name: string, totalItems: number | null = 3) => ({ id, name, totalItems, imageUrl: null, isOwner: true })

  it('lists Liked songs and every playlist page, with Basic auth', async () => {
    const seen: string[] = []
    server.use(
      http.get(`${API}/api/:user/liked/tracks`, ({ request, params }) => {
        expect(params.user).toBe(USER)
        expect(request.headers.get('authorization')).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`)
        seen.push(new URL(request.url).search)
        return HttpResponse.json({ results: [track()], nextParam: 'n1', totalItems: 742 })
      }),
      http.get(`${API}/api/:user/playlists`, ({ request }) => {
        const next = new URL(request.url).searchParams.get('nextParam')
        seen.push(new URL(request.url).search)
        if (!next) return HttpResponse.json({ results: [playlist('p1', 'Gym'), { name: 'No id' }], nextParam: 'page2', totalItems: 3 })
        if (next === 'page2') return HttpResponse.json({ results: [playlist('p2', 'Sleep', null)], nextParam: 'page3', totalItems: 3 })
        return HttpResponse.json({ results: [{ ...playlist('p3', 'Road'), imageUrl: 'https://img.example/p3.jpg' }], nextParam: null, totalItems: 3 })
      }),
    )
    const result = await musicapiImporter.listPlaylists({ method: 'login' }, { job: job({ musicapiUser: USER, musicapiService: 'spotify' }) })
    expect(result).toEqual({
      playlists: [
        { ref: 'liked', name: 'Liked songs', kind: 'liked', coverUrl: null, trackCount: 742 },
        { ref: 'p1', name: 'Gym', kind: 'playlist', coverUrl: null, trackCount: 3 },
        { ref: 'p2', name: 'Sleep', kind: 'playlist', coverUrl: null, trackCount: null },
        { ref: 'p3', name: 'Road', kind: 'playlist', coverUrl: 'https://img.example/p3.jpg', trackCount: 3 },
      ],
    })
    expect(seen).toEqual([
      '?limitParam=1',
      '?limitParam=50',
      '?limitParam=50&nextParam=page2',
      '?limitParam=50&nextParam=page3',
    ])
  })

  it('leaves Liked songs out when the service has no such list, and stops on a cursor that does not move', async () => {
    let calls = 0
    server.use(
      http.get(`${API}/api/:user/liked/tracks`, () => HttpResponse.json({ message: 'Not supported' }, { status: 400 })),
      http.get(`${API}/api/:user/playlists`, () => {
        calls++
        return HttpResponse.json({ results: [playlist(`p${calls}`, `List ${calls}`)], nextParam: 'same', totalItems: null })
      }),
    )
    const result = await musicapiImporter.listPlaylists({ method: 'login' }, { job: job({ musicapiUser: USER }) })
    expect('playlists' in result && result.playlists.map((p) => p.ref)).toEqual(['p1', 'p2'])
    expect(calls).toBe(2)
  })

  it('reads one page of songs per call, passing the cursor on as nextParam', async () => {
    server.use(
      http.get(`${API}/api/:user/playlists/:id/items`, ({ request, params }) => {
        expect(params.id).toBe('37i9dQZF1DX')
        const next = new URL(request.url).searchParams.get('nextParam')
        expect(new URL(request.url).searchParams.get('limitParam')).toBe('50')
        return next === 'eyJvZmZzZXQiOjUwfQ=='
          ? HttpResponse.json({ results: [track({ id: 'b', name: 'Second' })], nextParam: null, totalItems: 2 })
          : HttpResponse.json({ results: [track({ id: 'a', name: 'First' }), track({ name: '' })], nextParam: 'eyJvZmZzZXQiOjUwfQ==', totalItems: 2 })
      }),
      http.get(`${API}/api/:user/liked/tracks`, () => HttpResponse.json({ results: [track({ id: 'liked-1' })], nextParam: null, totalItems: 1 })),
    )
    const ctx = { job: job({ musicapiUser: USER }) }
    const ref = { ref: '37i9dQZF1DX', name: 'Mix' }
    const first = await musicapiImporter.getTracks(ref, { ...ctx, cursor: null })
    expect('tracks' in first && first.tracks.map((t) => t.title)).toEqual(['First'])
    expect('tracks' in first && first.next).toBe('eyJvZmZzZXQiOjUwfQ==')
    const second = await musicapiImporter.getTracks(ref, { ...ctx, cursor: 'eyJvZmZzZXQiOjUwfQ==' })
    expect(second).toMatchObject({ tracks: [{ ref: 'b', title: 'Second' }], next: null })
    const liked = await musicapiImporter.getTracks({ ref: 'liked', name: 'Liked songs', kind: 'liked' }, { ...ctx, cursor: null })
    expect(liked).toMatchObject({ tracks: [{ ref: 'liked-1' }], next: null })
  })

  it('says plainly when the keys are refused, the service is busy, or a playlist is gone', async () => {
    const ctx = { job: job({ musicapiUser: USER }) }
    server.use(http.get(`${API}/api/:user/liked/tracks`, () => HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })))
    expect((await rejection(musicapiImporter.listPlaylists({ method: 'login' }, ctx))).message).toBe(
      'MusicAPI did not accept the keys. Check MUSICAPI_CLIENT_ID and MUSICAPI_CLIENT_SECRET.',
    )
    server.use(
      http.get(`${API}/api/:user/playlists/:id/items`, ({ params }) =>
        params.id === 'busy' ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '30' } }) : new HttpResponse(null, { status: 404 }),
      ),
    )
    const busy = await rejection(musicapiImporter.getTracks({ ref: 'busy', name: 'Busy' }, { ...ctx, cursor: null }))
    expect(busy).toBeInstanceOf(ImportUserError)
    expect(busy.message).toBe('The music service is busy. Wait a minute and try again.')
    expect((await rejection(musicapiImporter.getTracks({ ref: 'old', name: 'Old mix' }, { ...ctx, cursor: null }))).message).toBe(
      'The playlist "Old mix" is gone.',
    )
  })

  it('asks for a log in first, and catches a log in to the wrong service', async () => {
    expect((await rejection(musicapiImporter.listPlaylists({ method: 'login' }, { job: job({}) }))).message).toBe('Log in first.')
    const wrong = job({ musicapiUser: USER, musicapiService: 'appleMusic' }, 'spotify')
    expect((await rejection(musicapiImporter.listPlaylists({ method: 'login' }, { job: wrong }))).message).toBe(
      'You logged in to Apple Music. Start again and pick Apple Music from the list.',
    )
  })
})

describe('the stand-in (TAPEDECK_TEST=1)', () => {
  beforeEach(() => useEnv({ TAPEDECK_TEST: '1' }))

  it('lists and pages the fixture library without any network', async () => {
    const { user } = await loadStandinFixtures()
    const ctx = { job: job({ musicapiUser: user, musicapiService: 'spotify' }) }
    const listed = await musicapiImporter.listPlaylists({ method: 'login' }, ctx)
    expect('playlists' in listed && listed.playlists.map((p) => [p.ref, p.name, p.trackCount])).toEqual([
      ['liked', 'Liked songs', 3],
      ['mapi-pl-night', 'Night drive mix', 2],
      ['mapi-pl-gone', 'Old mixtape', 4],
    ])
    const liked = { ref: 'liked', name: 'Liked songs', kind: 'liked' as const }
    const first = await musicapiImporter.getTracks(liked, { ...ctx, cursor: null })
    expect(first).toMatchObject({ tracks: [{ title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', durationSec: 226 }, { title: 'Something About Us' }] })
    const second = await musicapiImporter.getTracks(liked, { ...ctx, cursor: 'next' in first ? (first.next ?? null) : null })
    expect(second).toMatchObject({ tracks: [{ title: 'Static Bloom', artist: 'The Stand-in Trio, Fixture Friend' }], next: null })
    expect((await rejection(musicapiImporter.getTracks({ ref: 'mapi-pl-gone', name: 'Old mixtape' }, { ...ctx, cursor: null }))).message).toBe(
      'The playlist "Old mixtape" is gone.',
    )
  })

  it('keys fixtures by path and sorted query', () => {
    expect(standinKey(`${API}/api/u/playlists?nextParam=eyJ9%3D%3D&limitParam=50`)).toBe('/api/u/playlists?limitParam=50&nextParam=eyJ9==')
  })

  it('the fake log-in page sends the browser back to this app only, as MusicAPI would', async () => {
    const { redirectUrl } = await musicapiImporter.login!.start({ jobId: JOB, service: 'tidal', callbackUrl: CALLBACK })
    const page = await standinLogin(new Request(redirectUrl))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Log in to Tidal')
    const href = (testId: string) => {
      const match = html.match(new RegExp(`data-testid="${testId}" href="([^"]+)"`))
      return new URL((match?.[1] ?? '').replace(/&#38;/g, '&'))
    }
    const allowed = await musicapiImporter.login!.finish(href('musicapi-allow').searchParams, { callbackUrl: CALLBACK })
    expect(allowed).toEqual({ jobId: JOB, payload: { musicapiUser: (await loadStandinFixtures()).user, musicapiService: 'tidal' } })
    expect((await rejection(musicapiImporter.login!.finish(href('musicapi-cancel').searchParams, { callbackUrl: CALLBACK }))).message).toBe(
      'The log in was cancelled or did not work. Try again.',
    )

    const elsewhere = new URL(redirectUrl)
    elsewhere.searchParams.set('returnUrl', 'https://evil.example/api/import/callback/musicapi')
    expect((await standinLogin(new Request(elsewhere))).status).toBe(400)
    vi.stubEnv('TAPEDECK_TEST', '')
    expect((await standinLogin(new Request(redirectUrl))).status).toBe(404)
  })
})

describe('a whole log in through the core routes (stand-in, PGlite)', () => {
  const BASE = 'https://tapedeck.test'
  const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) })

  beforeEach(async () => {
    useEnv({ TAPEDECK_TEST: '1', DATABASE_URL: '' })
    await sql`truncate import_items, import_jobs`
  })

  afterAll(async () => {
    await resetDb()
  })

  async function startLogin(service: ServiceId): Promise<{ job: ImportJobView; redirectUrl: string }> {
    const response = await jobsPost(
      new Request(`${BASE}/api/import/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, method: 'login' }),
      }),
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as CreateJobResponse
    expect(body.job).toMatchObject({ importer: 'musicapi', status: 'login' })
    return { job: body.job, redirectUrl: body.redirectUrl ?? '' }
  }

  async function allowLink(redirectUrl: string, testId = 'musicapi-allow'): Promise<string> {
    const html = await (await standinLogin(new Request(redirectUrl))).text()
    return (html.match(new RegExp(`data-testid="${testId}" href="([^"]+)"`))?.[1] ?? '').replace(/&#38;/g, '&')
  }

  it('fills the Spotify log-in slot, comes back listed, and keeps the user id in that job only', async () => {
    const { job, redirectUrl } = await startLogin('spotify')
    const back = await callbackGet(new Request(await allowLink(redirectUrl)), params({ importer: 'musicapi' }))
    expect(back.status).toBe(303)
    expect(back.headers.get('location')).toBe(`${BASE}/import?job=${job.id}`)
    const view = (await (await jobGet(new Request(`${BASE}/api/import/jobs/${job.id}`), params({ id: job.id }))).json()) as {
      job: ImportJobView
    }
    expect(view.job.status).toBe('listed')
    expect(view.job.playlists?.map((p) => p.name)).toEqual(['Liked songs', 'Night drive mix', 'Old mixtape'])
    expect(JSON.stringify(view)).not.toContain((await loadStandinFixtures()).user)
    const rows = await sql`select payload from import_jobs where id = ${job.id}`
    expect(rows[0]?.payload).toEqual({ musicapiUser: (await loadStandinFixtures()).user, musicapiService: 'spotify' })
  })

  it('refuses a state moved to another job, and reads a cancel plainly', async () => {
    const first = await startLogin('deezer')
    const second = await startLogin('deezer')
    const firstBack = new URL(await allowLink(first.redirectUrl))
    const secondState = new URL(new URL(second.redirectUrl).searchParams.get('returnUrl') ?? '').searchParams.get('state') ?? ''
    // Point the first answer at the second job, keeping the first signature.
    const [, expiry, signature] = (firstBack.searchParams.get('state') ?? '').split('.')
    firstBack.searchParams.set('state', `${secondState.split('.')[0]}.${expiry}.${signature}`)
    const tampered = await callbackGet(new Request(firstBack), params({ importer: 'musicapi' }))
    expect(new URL(tampered.headers.get('location') ?? '').searchParams.get('error')).toBe('That log in has expired. Start again.')

    const cancel = await callbackGet(new Request(await allowLink(first.redirectUrl, 'musicapi-cancel')), params({ importer: 'musicapi' }))
    expect(new URL(cancel.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'The log in was cancelled or did not work. Try again.',
    )
    const rows = await sql`select status from import_jobs order by created_at`
    expect(rows.map((row) => row.status)).toEqual(['login', 'login'])
  })
})
