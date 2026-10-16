/**
 * PATCH /api/tracks/[id] speed fields (V2-PLAN T14): playbackRate from 0.5
 * to 1.5 in 0.05 steps, and preservePitch true or false. Real in-memory
 * PGlite, fresh per test.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { resetDb, sql, type Row } from '../../../../lib/db'
import { startTestMocks, stopTestMocks } from '../../../../e2e/mocks/server'
import { PATCH } from './route'
import { readSpeedChange } from './speed'

startTestMocks({ onUnhandledRequest: 'error' })

type RouteContext = { params: Promise<{ id: string }> }
const ctx = (id: string): RouteContext => ({ params: Promise.resolve({ id }) })

async function seedTrack(): Promise<string> {
  const rows = (await sql`
    insert into tracks (source, source_id, source_url, raw_title, raw_artist, title, artist, status, duration_sec)
    values ('youtube', ${`seed-speed-${Math.random()}`}, 'https://www.youtube.com/watch?v=seed-speed', 'Raw', 'Raw Artist', 'Song', 'Artist', 'ready', 180)
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

async function stored(id: string): Promise<{ rate: number; keep: boolean; title: string }> {
  const rows = (await sql`select playback_rate, preserve_pitch, title from tracks where id = ${id}`) as Row[]
  return { rate: Number(rows[0].playback_rate), keep: rows[0].preserve_pitch === true, title: String(rows[0].title) }
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

describe('PATCH /api/tracks/[id] speed (T14)', () => {
  it('starts at normal speed with the pitch kept', async () => {
    const id = await seedTrack()
    expect(await stored(id)).toMatchObject({ rate: 1, keep: true })
  })

  it('saves Sped up with the pitch off and returns both fields', async () => {
    const id = await seedTrack()
    const response = await patch(id, { playbackRate: 1.25, preservePitch: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ playbackRate: 1.25, preservePitch: false })
    expect(await stored(id)).toMatchObject({ rate: 1.25, keep: false })
  })

  it('takes either field alone and leaves the other as it was', async () => {
    const id = await seedTrack()
    expect((await patch(id, { preservePitch: false })).status).toBe(200)
    expect(await stored(id)).toMatchObject({ rate: 1, keep: false })
    expect((await patch(id, { playbackRate: 0.85 })).status).toBe(200)
    expect(await stored(id)).toMatchObject({ rate: 0.85, keep: false })
  })

  it('saves together with the other Edit details fields', async () => {
    const id = await seedTrack()
    const response = await patch(id, { title: 'New title', playbackRate: 0.5, preservePitch: true })
    expect(response.status).toBe(200)
    expect(await stored(id)).toEqual({ rate: 0.5, keep: true, title: 'New title' })
  })

  it('refuses speeds outside 0.5x to 1.5x or off the 0.05 steps', async () => {
    const id = await seedTrack()
    expect(await errorOf(await patch(id, { playbackRate: 2 }))).toBe('Speed must be between 0.5x and 1.5x.')
    expect(await errorOf(await patch(id, { playbackRate: 0.25 }))).toBe('Speed must be between 0.5x and 1.5x.')
    expect(await errorOf(await patch(id, { playbackRate: 1.03 }))).toBe('Speed goes up and down in steps of 0.05.')
    expect(await errorOf(await patch(id, { playbackRate: '1.25' }))).toBe('Speed must be a number, for example 1.25.')
    expect(await errorOf(await patch(id, { playbackRate: null }))).toBe('Speed must be a number, for example 1.25.')
    expect(await errorOf(await patch(id, { preservePitch: 'no' }))).toBe('preservePitch must be true or false')
    expect(await stored(id)).toMatchObject({ rate: 1, keep: true })
  })

  it('answers 404 for a song that does not exist', async () => {
    const response = await patch('00000000-0000-4000-8000-000000000000', { playbackRate: 1.25 })
    expect(response.status).toBe(404)
  })
})

describe('readSpeedChange', () => {
  it('is null when neither field is sent', () => {
    expect(readSpeedChange({ title: 'x' })).toEqual({ change: null })
  })

  it('stores speeds on the two-decimal grid', () => {
    expect(readSpeedChange({ playbackRate: 1.1500000000000001 }).change).toEqual({ playbackRate: 1.15 })
  })
})
