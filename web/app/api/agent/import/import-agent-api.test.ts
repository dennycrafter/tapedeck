/**
 * The PC listing's agent endpoints (V2-PLAN T13, adapter 4) end to end over
 * in-memory PGlite: paste a SoundCloud profile, the job waits for the PC,
 * the downloader claims it and sends the recorded answer
 * (e2e/fixtures/import-pc-listing/soundcloud-profile.json), the browser lists
 * again, imports, and the songs keep their SoundCloud links.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import profileResult from '../../../../e2e/fixtures/import-pc-listing/soundcloud-profile.json'
import { resetDb, sql } from '../../../../lib/db'
import type { ChunkResponse, CreateJobResponse, ImportJobView } from '../../../../lib/import-types'
import { POST as claimPOST } from './claim/route'
import { POST as completePOST } from './complete/route'
import { POST as jobsPost } from '../../import/jobs/route'
import { POST as listPost } from '../../import/jobs/[id]/list/route'
import { POST as startPost } from '../../import/jobs/[id]/start/route'
import { POST as chunkPost } from '../../import/jobs/[id]/chunk/route'

const TOKEN = 'import-agent-api-test-token'
const BASE = 'https://tapedeck.test'
const PROFILE = 'https://soundcloud.com/the-concept-band'

function agentRequest(path: string, body?: unknown, token = TOKEN): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

type Claimed = { id: string; service: string; targets: { link: string; kind: string; url: string }[]; maxSongs: number }

async function claim(body: unknown = { capabilities: ['import-listing'] }): Promise<Claimed[]> {
  const response = await claimPOST(agentRequest('/api/agent/import/claim', body))
  expect(response.status).toBe(200)
  return ((await response.json()) as { jobs: Claimed[] }).jobs
}

async function complete(body: unknown): Promise<Response> {
  return completePOST(agentRequest('/api/agent/import/complete', body))
}

async function createJob(links: string[], service = 'soundcloud'): Promise<ImportJobView> {
  const response = await jobsPost(post('/api/import/jobs', { service, method: 'link', links }))
  expect(response.status).toBe(201)
  return ((await response.json()) as CreateJobResponse).job
}

async function list(id: string): Promise<ImportJobView> {
  const response = await listPost(post(`/api/import/jobs/${id}/list`, {}), params(id))
  expect(response.status).toBe(200)
  return ((await response.json()) as { job: ImportJobView }).job
}

async function status(id: string): Promise<string> {
  const [row] = await sql`select status from import_jobs where id = ${id}`
  return String(row.status)
}

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  vi.stubEnv('AGENT_TOKEN', TOKEN)
  await sql`truncate import_items, import_jobs, tracks, playlists, playlist_tracks, play_events`
})

describe('the PC listing flow', () => {
  it('waits for the PC, takes its answer, and imports songs that keep their links', async () => {
    const job = await createJob([PROFILE, 'soundcloud.com/the-concept-band/tracks'])
    expect(job).toMatchObject({ importer: 'pc-listing', status: 'waiting_pc', playlists: null })

    // The downloader claims it and gets one cleaned target per address.
    const [claimed, ...more] = await claim()
    expect(more).toEqual([])
    expect(claimed).toEqual({
      id: job.id,
      service: 'soundcloud',
      targets: [{ link: PROFILE, kind: 'soundcloud-profile', url: PROFILE }],
      maxSongs: 5000,
    })
    expect(await claim()).toEqual([]) // claimed for 15 minutes

    // Its answer goes into the job, and the browser lists again.
    const done = await complete({ jobId: job.id, ...profileResult })
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ ok: true, status: 'new', playlists: 3, songs: 6 })
    const listed = await list(job.id)
    expect(listed.status).toBe('listed')
    expect(listed.playlists?.map((p) => [p.name, p.kind, p.trackCount])).toEqual([
      ['Likes', 'liked', 1],
      ['Royal EP', 'playlist', 2],
      ['The Royal Concept EP', 'playlist', 3],
    ])

    // Import two playlists; the song in both is one library song.
    const start = await startPost(post(`/api/import/jobs/${job.id}/start`, { refs: ['likes:9615865', '10258832', '2284613'] }), params(job.id))
    expect(start.status).toBe(200)
    for (let i = 0; i < 10; i++) {
      const response = await chunkPost(post(`/api/import/jobs/${job.id}/chunk`, {}), params(job.id))
      if (((await response.json()) as ChunkResponse).done) break
    }
    expect(await status(job.id)).toBe('done')
    const tracks = await sql`select source, source_id, source_url, raw_title, artist, duration_sec from tracks order by source_id`
    expect(tracks.map((t) => [t.source, t.source_url, t.artist, t.duration_sec])).toEqual([
      ['soundcloud', 'https://soundcloud.com/mrtnoriginal/mrtn-feat-oh-deer-illusion', 'MRTN', 246],
      ['soundcloud', 'https://soundcloud.com/the-concept-band/in-the-end-mastered', 'The Royal Concept', 324],
      ['soundcloud', 'https://soundcloud.com/the-concept-band/knocked-up-mastered', 'The Royal Concept', 222],
      ['soundcloud', 'https://soundcloud.com/the-concept-band/shut-the-world', 'The Royal Concept', 245],
      ['soundcloud', 'https://soundcloud.com/the-concept-band/world-on-fire-1', 'The Royal Concept', 200],
    ])
    const playlists = await sql`select name from playlists order by name`
    expect(playlists.map((p) => p.name)).toEqual(['Liked songs from SoundCloud', 'Royal EP', 'The Royal Concept EP'])
    // Read songs are dropped from the payload.
    const [row] = await sql`select payload from import_jobs where id = ${job.id}`
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    expect(payload.pcListing.playlists.every((p: { tracks: unknown[]; read?: boolean }) => p.tracks.length === 0 && p.read)).toBe(true)
  })

  it('shows a bad link right away, without waiting for the PC', async () => {
    const job = await createJob(['https://soundcloud.com/the-concept-band/world-on-fire-1'])
    expect(job.status).toBe('failed')
    expect(job.error).toContain('is one song, not a playlist')
    expect(await claim()).toEqual([])
  })

  it("fails with the PC's own words when nothing could be read", async () => {
    const job = await createJob(['https://www.youtube.com/playlist?list=PLnotreal'], 'youtube')
    await claim()
    const problem = "Couldn't open https://www.youtube.com/playlist?list=PLnotreal. Check that it exists and is public."
    expect((await complete({ jobId: job.id, playlists: [], problems: [problem] })).status).toBe(200)
    expect(await list(job.id)).toMatchObject({ status: 'failed', error: problem })
  })

  it('retries after a PC failure, then gives up after the third', async () => {
    const job = await createJob([PROFILE])
    for (const attempt of [1, 2, 3]) {
      const [claimed] = await claim()
      expect(claimed?.id).toBe(job.id)
      const response = await complete({ jobId: job.id, error: 'yt-dlp could not read it' })
      expect(await response.json()).toEqual({ ok: true, status: attempt < 3 ? 'waiting_pc' : 'failed' })
    }
    expect(await claim()).toEqual([])
    const [row] = await sql`select status, error from import_jobs where id = ${job.id}`
    expect(row).toMatchObject({ status: 'failed', error: 'yt-dlp could not read it' })
  })
})

describe('the agent endpoints', () => {
  it('need the agent token', async () => {
    expect((await claimPOST(agentRequest('/api/agent/import/claim', { capabilities: ['import-listing'] }, 'wrong'))).status).toBe(401)
    expect((await completePOST(agentRequest('/api/agent/import/complete', {}, 'wrong'))).status).toBe(401)
  })

  it('hand jobs only to a downloader that says it can list', async () => {
    await createJob([PROFILE])
    expect(await claim({})).toEqual([])
    expect(await claim({ capabilities: ['catalog'] })).toEqual([])
    expect(await claim({ capabilities: 'import-listing' })).toEqual([])
    expect(await claim({ capabilities: ['catalog', 'import-listing'] })).toHaveLength(1)
  })

  it('never hand out jobs of other importers', async () => {
    await createJob(['https://example.com/waiting-for-pc'], 'test') // the stand-in also waits for the PC
    expect(await claim()).toEqual([])
  })

  it('refuse bad completes', async () => {
    const job = await createJob([PROFILE])
    expect((await completePOST(agentRequest('/api/agent/import/complete', 'not json'))).status).toBe(400)
    expect((await complete({ jobId: 'nope', playlists: [] })).status).toBe(400)
    expect((await complete({ jobId: '00000000-0000-4000-8000-000000000000', playlists: [] })).status).toBe(404)
    expect((await complete({ jobId: job.id, playlists: 'x' })).status).toBe(400)
    const big = agentRequest('/api/agent/import/complete', { jobId: job.id, playlists: [] })
    big.headers.set('content-length', String(5 * 1024 * 1024))
    expect((await completePOST(big)).status).toBe(413)
    // Done once: a second answer finds the job no longer waiting.
    expect((await complete({ jobId: job.id, ...profileResult })).status).toBe(200)
    expect((await complete({ jobId: job.id, ...profileResult })).status).toBe(409)
    expect((await complete({ jobId: job.id, error: 'late' })).status).toBe(409)
  })
})
