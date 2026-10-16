/**
 * The /api/import routes (V2-PLAN T13) end to end over in-memory PGlite and
 * the stand-in importer: services, creating jobs by link, file and log in,
 * the callback, start, the browser-driven chunks, the job view and Skip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../lib/db'
import type { ChunkResponse, CreateJobResponse, ImportJobView, ServiceOption } from '../../../lib/import-types'
import { GET as servicesGet } from './services/route'
import { GET as jobsGet, POST as jobsPost } from './jobs/route'
import { GET as jobGet } from './jobs/[id]/route'
import { POST as listPost } from './jobs/[id]/list/route'
import { POST as startPost } from './jobs/[id]/start/route'
import { POST as chunkPost } from './jobs/[id]/chunk/route'
import { POST as skipPost } from './jobs/[id]/skip/route'
import { GET as callbackGet } from './callback/[importer]/route'

const BASE = 'https://tapedeck.test'

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await sql`truncate import_items, import_jobs, tracks, playlists, playlist_tracks, play_events`
})

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) })

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

async function createLinkJob(links: string[] = ['https://example.com/test-music/me']): Promise<ImportJobView> {
  const response = await jobsPost(post('/api/import/jobs', { service: 'test', method: 'link', links }))
  expect(response.status).toBe(201)
  return ((await response.json()) as CreateJobResponse).job
}

describe('GET /api/import/services', () => {
  it('lists only services with an available importer (here: the stand-in)', async () => {
    const response = await servicesGet(new Request(`${BASE}/api/import/services`))
    const { services } = (await response.json()) as { services: ServiceOption[] }
    expect(services.map((service) => service.id)).toContain('test')
    const test = services.find((service) => service.id === 'test')
    expect(test?.label).toBe('Test music service')
    expect(test?.options.map((option) => option.method)).toEqual(['login', 'link', 'file'])
  })
})

describe('POST /api/import/jobs', () => {
  it('lists the playlists of pasted links right away', async () => {
    const job = await createLinkJob()
    expect(job).toMatchObject({ service: 'test', serviceLabel: 'Test music service', importer: 'fake', method: 'link', status: 'listed' })
    expect(job.playlists?.map((playlist) => playlist.name)).toEqual(['Liked songs', 'Road trip', 'Chill'])
  })

  it('takes links as one text with a link per line', async () => {
    const response = await jobsPost(post('/api/import/jobs', { service: 'test', method: 'link', links: 'a\n\n  b  \n' }))
    expect(response.status).toBe(201)
    const [row] = await sql`select payload from import_jobs`
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    expect(payload).toEqual({ links: ['a', 'b'] })
  })

  it('answers the adapter\'s message when listing fails', async () => {
    const job = await createLinkJob(['https://example.com/broken'])
    expect(job).toMatchObject({ status: 'failed', error: "That link didn't work. Check it and try again." })
  })

  it('checks the request', async () => {
    const cases: [unknown, string][] = [
      [{ method: 'link', links: ['x'] }, 'Pick a service first.'],
      [{ service: 'myspace', method: 'link', links: ['x'] }, 'Pick a service first.'],
      [{ service: 'test', method: 'fax', links: ['x'] }, 'Pick how to connect.'],
      [{ service: 'test', method: 'link', links: [] }, 'Paste at least one link.'],
      [{ service: 'test', method: 'link', links: Array.from({ length: 51 }, () => 'x') }, 'Paste at most 50 links at once.'],
      [{ service: 'spotify', method: 'link', links: ['x'] }, "That way of connecting isn't available for this service."],
    ]
    for (const [body, message] of cases) {
      const response = await jobsPost(post('/api/import/jobs', body))
      expect(response.status, message).toBe(400)
      expect(await errorOf(response)).toBe(message)
    }
    expect(await sql`select id from import_jobs`).toHaveLength(0)
  })

  it('reads an uploaded file', async () => {
    const form = new FormData()
    form.set('service', 'test')
    form.set('method', 'file')
    form.set('file', new File(['Playlist,Song\n'], 'export.csv', { type: 'text/csv' }))
    const response = await jobsPost(new Request(`${BASE}/api/import/jobs`, { method: 'POST', body: form }))
    expect(response.status).toBe(201)
    expect(((await response.json()) as CreateJobResponse).job).toMatchObject({ method: 'file', status: 'listed' })
  })

  it('refuses an empty upload', async () => {
    const form = new FormData()
    form.set('service', 'test')
    form.set('file', new File([], 'empty.csv'))
    const response = await jobsPost(new Request(`${BASE}/api/import/jobs`, { method: 'POST', body: form }))
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('Choose a file to upload.')
  })
})

describe('logging in', () => {
  it('sends the browser to the log in, then lists on the way back', async () => {
    const response = await jobsPost(post('/api/import/jobs', { service: 'test', method: 'login' }))
    expect(response.status).toBe(201)
    const { job, redirectUrl } = (await response.json()) as CreateJobResponse
    expect(job.status).toBe('login')
    const target = new URL(redirectUrl ?? '')
    expect(target.pathname).toBe('/api/import/callback/fake')
    expect(target.searchParams.get('state')).toBe(job.id)

    const back = await callbackGet(new Request(target), params({ importer: 'fake' }))
    expect(back.status).toBe(303)
    expect(back.headers.get('location')).toBe(`${BASE}/import?job=${job.id}`)
    const view = ((await (await jobGet(new Request(`${BASE}/api/import/jobs/${job.id}`), params({ id: job.id }))).json()) as {
      job: ImportJobView
    }).job
    expect(view.status).toBe('listed')
  })

  it('comes back with a plain message when the log in was cancelled', async () => {
    const response = await jobsPost(post('/api/import/jobs', { service: 'test', method: 'login' }))
    const { job } = (await response.json()) as CreateJobResponse
    const back = await callbackGet(
      new Request(`${BASE}/api/import/callback/fake?state=${job.id}&error=access_denied`),
      params({ importer: 'fake' }),
    )
    const location = new URL(back.headers.get('location') ?? '')
    expect(location.pathname).toBe('/import')
    expect(location.searchParams.get('error')).toBe('The log in was cancelled.')
  })

  it('refuses a callback for an importer that is not available', async () => {
    const back = await callbackGet(new Request(`${BASE}/api/import/callback/musicapi?state=x&code=y`), params({ importer: 'musicapi' }))
    expect(new URL(back.headers.get('location') ?? '').searchParams.get('error')).toBe('That log in is not available any more.')
  })
})

describe('start, chunks, progress and Skip', () => {
  it('imports the ticked playlists in browser-driven chunks', async () => {
    const job = await createLinkJob()
    const start = await startPost(post(`/api/import/jobs/${job.id}/start`, { refs: ['liked', 'pl-road-trip'] }), params({ id: job.id }))
    expect(start.status).toBe(200)
    expect(((await start.json()) as { job: ImportJobView }).job.status).toBe('importing')

    let last: ChunkResponse | null = null
    for (let i = 0; i < 20 && !last?.done; i++) {
      const response = await chunkPost(post(`/api/import/jobs/${job.id}/chunk`, {}), params({ id: job.id }))
      expect(response.status).toBe(200)
      last = (await response.json()) as ChunkResponse
    }
    expect(last?.job.status).toBe('done')
    expect(last?.job.progress).toMatchObject({ total: 6, ready: 0, waiting: 6, needsLook: 0 })

    // A song the PC gave up on needs a look; Skip takes it out of the count.
    const [paper] = await sql`select id from tracks where source_id = 'import:test:fake-3'`
    await sql`update tracks set status = 'failed', error = 'Couldn''t find a matching version' where id = ${paper.id}`
    const view = ((await (await jobGet(new Request(`${BASE}/x`), params({ id: job.id }))).json()) as { job: ImportJobView }).job
    expect(view.progress?.needsLook).toBe(1)
    const song = view.progress!.needsLookSongs[0]
    expect(song).toMatchObject({ title: 'Paper Lanterns', source: 'catalog', error: "Couldn't find a matching version" })

    const skipped = await skipPost(post(`/api/import/jobs/${job.id}/skip`, { itemId: song.itemId }), params({ id: job.id }))
    expect(skipped.status).toBe(200)
    expect(((await skipped.json()) as { job: ImportJobView }).job.progress).toMatchObject({ total: 5, needsLook: 0, skipped: 1 })

    const recent = await jobsGet(new Request(`${BASE}/api/import/jobs`))
    const { jobs } = (await recent.json()) as { jobs: { id: string; progress: { total: number } }[] }
    expect(jobs[0]).toMatchObject({ id: job.id, progress: { total: 5 } })
  })

  it('answers 409 to a second start and 400 to bad ids', async () => {
    const job = await createLinkJob()
    await startPost(post('/x', { refs: ['pl-chill'] }), params({ id: job.id }))
    const again = await startPost(post('/x', { refs: ['pl-chill'] }), params({ id: job.id }))
    expect(again.status).toBe(409)
    expect((await startPost(post('/x', { refs: ['a'] }), params({ id: 'nope' }))).status).toBe(400)
    expect((await chunkPost(post('/x', {}), params({ id: 'nope' }))).status).toBe(400)
    expect((await chunkPost(post('/x', {}), params({ id: '00000000-0000-4000-8000-000000000000' }))).status).toBe(404)
    expect((await skipPost(post('/x', { itemId: 'nope' }), params({ id: job.id }))).status).toBe(400)
    expect((await skipPost(post('/x', { itemId: '00000000-0000-4000-8000-000000000000' }), params({ id: job.id }))).status).toBe(404)
  })

  it('lists again once the PC has answered', async () => {
    const job = await createLinkJob(['https://example.com/waiting-for-pc'])
    expect(job.status).toBe('waiting_pc')
    const still = await listPost(post('/x', {}), params({ id: job.id }))
    expect(((await still.json()) as { job: ImportJobView }).job.status).toBe('waiting_pc')
    await sql`update import_jobs set status = 'new', payload = payload || '{"pcListed": true}'::jsonb where id = ${job.id}`
    const listed = await listPost(post('/x', {}), params({ id: job.id }))
    expect(((await listed.json()) as { job: ImportJobView }).job.status).toBe('listed')
  })
})
