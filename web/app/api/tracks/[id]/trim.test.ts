/**
 * PATCH /api/tracks/[id] trim points (V2-PLAN T10): trimStartSec and
 * trimEndSec, numbers or null, with the rule 0 <= start < end <= duration
 * and at least 10 seconds kept. Real in-memory PGlite, fresh per test.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { resetDb, sql, type Row } from '../../../../lib/db'
import { startTestMocks, stopTestMocks } from '../../../../e2e/mocks/server'
import { PATCH } from './route'

startTestMocks({ onUnhandledRequest: 'error' })

type RouteContext = { params: Promise<{ id: string }> }
const ctx = (id: string): RouteContext => ({ params: Promise.resolve({ id }) })

interface Saved {
  title: string
  durationSec: number | null
  trimStartSec: number | null
  trimEndSec: number | null
  autoTrimStartSec: number | null
  autoTrimEndSec: number | null
}

async function seedTrack(opts: { durationSec?: number | null; autoStart?: number | null; autoEnd?: number | null } = {}): Promise<string> {
  const rows = (await sql`
    insert into tracks (source, source_id, source_url, raw_title, raw_artist, title, artist, status, duration_sec, auto_trim_start_sec, auto_trim_end_sec)
    values ('youtube', ${`seed-trim-${Math.random()}`}, 'https://www.youtube.com/watch?v=seed-trim', 'Raw', 'Raw Artist', 'Song', 'Artist', 'ready',
            ${opts.durationSec === undefined ? 180 : opts.durationSec}, ${opts.autoStart ?? null}, ${opts.autoEnd ?? null})
    returning id
  `) as (Row & { id: string })[]
  return rows[0].id
}

function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request('http://localhost/api/tracks/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx(id),
  )
}

async function stored(id: string): Promise<{ start: number | null; end: number | null }> {
  const rows = (await sql`select trim_start_sec, trim_end_sec from tracks where id = ${id}`) as Row[]
  const value = (v: unknown) => (v == null ? null : Number(v))
  return { start: value(rows[0].trim_start_sec), end: value(rows[0].trim_end_sec) }
}

async function errorOf(response: Response): Promise<string> {
  expect(response.status).toBe(400)
  return ((await response.json()) as { error: string }).error
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await resetDb()
  stopTestMocks()
})

describe('PATCH /api/tracks/[id] trim (T10)', () => {
  it('saves a trim and returns the v2 fields', async () => {
    const id = await seedTrack({ autoStart: 3.2 })
    const response = await patch(id, { trimStartSec: 12.5, trimEndSec: 170 })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as Saved
    expect(saved).toMatchObject({ trimStartSec: 12.5, trimEndSec: 170, autoTrimStartSec: 3.2, autoTrimEndSec: null, durationSec: 180 })
    expect(await stored(id)).toEqual({ start: 12.5, end: 170 })
  })

  it('saves together with the other Edit details fields', async () => {
    const id = await seedTrack()
    const response = await patch(id, { title: 'New title', trimStartSec: 5, trimEndSec: null })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as Saved
    expect(saved.title).toBe('New title')
    expect(saved.trimStartSec).toBe(5)
  })

  it('"Reset to automatic" clears both values', async () => {
    const id = await seedTrack({ autoStart: 3.2, autoEnd: 175 })
    await patch(id, { trimStartSec: 10, trimEndSec: 100 })
    const response = await patch(id, { trimStartSec: null, trimEndSec: null })
    expect(response.status).toBe(200)
    expect(await stored(id)).toEqual({ start: null, end: null })
  })

  it('"Don\'t trim" stores 0 and the full length', async () => {
    const id = await seedTrack({ autoStart: 3.2, autoEnd: 175 })
    const response = await patch(id, { trimStartSec: 0, trimEndSec: 180 })
    expect(response.status).toBe(200)
    expect(await stored(id)).toEqual({ start: 0, end: 180 })
  })

  it('changes only the side that was sent', async () => {
    const id = await seedTrack()
    await patch(id, { trimStartSec: 10, trimEndSec: 100 })
    await patch(id, { trimEndSec: 120 })
    expect(await stored(id)).toEqual({ start: 10, end: 120 })
  })

  it('rejects a start before 0', async () => {
    const id = await seedTrack()
    expect(await errorOf(await patch(id, { trimStartSec: -1 }))).toBe("The start can't be before 0:00.")
  })

  it('rejects an end past the song', async () => {
    const id = await seedTrack()
    expect(await errorOf(await patch(id, { trimEndSec: 181 }))).toBe("The end can't be past the end of the song.")
  })

  it('rejects a start at or after the end', async () => {
    const id = await seedTrack()
    expect(await errorOf(await patch(id, { trimStartSec: 100, trimEndSec: 100 }))).toBe('The start must be before the end.')
    expect(await errorOf(await patch(id, { trimStartSec: 120, trimEndSec: 100 }))).toBe('The start must be before the end.')
  })

  it('rejects less than 10 seconds kept', async () => {
    const id = await seedTrack()
    expect(await errorOf(await patch(id, { trimStartSec: 100, trimEndSec: 109.9 }))).toBe('Keep at least 10 seconds of the song.')
  })

  it('checks the result against the stored suggestion', async () => {
    // The PC suggested an end at 60 s; a hand start at 55 s keeps only 5 s.
    const id = await seedTrack({ autoEnd: 60 })
    expect(await errorOf(await patch(id, { trimStartSec: 55 }))).toBe('Keep at least 10 seconds of the song.')
    expect(await stored(id)).toEqual({ start: null, end: null })
  })

  it('rejects values that are not numbers', async () => {
    const id = await seedTrack()
    expect(await errorOf(await patch(id, { trimStartSec: '12' }))).toBe('trimStartSec must be a number of seconds or null')
    expect(await errorOf(await patch(id, { trimEndSec: true }))).toBe('trimEndSec must be a number of seconds or null')
  })

  it('a song with an unknown length only checks the start', async () => {
    const id = await seedTrack({ durationSec: null })
    expect((await patch(id, { trimStartSec: 4 })).status).toBe(200)
    expect(await errorOf(await patch(id, { trimStartSec: -4 }))).toBe("The start can't be before 0:00.")
  })

  it('404s for a missing song', async () => {
    const response = await patch('00000000-0000-4000-8000-000000000000', { trimStartSec: 4 })
    expect(response.status).toBe(404)
  })
})
