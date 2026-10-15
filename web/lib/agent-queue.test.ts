/**
 * Queue mechanics tests (SPEC 8.3) against the real adapter: TAPEDECK_TEST=1
 * boots an in-memory PGlite (SPEC 4.1), so these exercise actual Postgres
 * semantics (the data-modifying claim CTE, `for update skip locked`, the
 * stale-claim reset and the attempts ladder), not mocks.
 *
 * HTTP concerns (auth, status codes, JSON shapes) live in
 * app/api/agent/agent-api.test.ts; this file pins the database behavior.
 *
 * Note on the concurrent-claim test: PGlite serializes queries on its single
 * connection, so the two parallel claims interleave only at the promise
 * level. The disjointness invariant is what matters and it is enforced by the
 * claim statement itself (`for update skip locked`), which on real Postgres
 * makes concurrent connections skip rows the other claimer holds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resetDb, sql } from './db'
import {
  CLAIM_BATCH,
  MAX_ATTEMPTS,
  STALE_CLAIM_SECONDS,
  claimTracks,
  completeTrack,
  failTrack,
  markAppleMusicDone,
  recordAgentSeen,
  resetStaleClaims,
  retryTrack,
  trackKey,
} from './agent-queue'

interface SeedOptions {
  title?: string
  status?: 'waiting' | 'downloading' | 'ready' | 'failed'
  attempts?: number
  error?: string
  /** Claimed this many seconds ago (downloading rows). */
  claimedSecondsAgo?: number
  /** Inserted "this many seconds ago"; controls claim order, oldest first. */
  createdSecondsAgo?: number
  appleMusic?: boolean
}

let seq = 0
async function seedTrack(opts: SeedOptions = {}): Promise<string> {
  seq += 1
  const sourceId = `queue-test-${seq}`
  const createdAt = new Date(Date.now() - (opts.createdSecondsAgo ?? seq) * 1000).toISOString()
  const claimedAt =
    opts.claimedSecondsAgo == null
      ? null
      : new Date(Date.now() - opts.claimedSecondsAgo * 1000).toISOString()
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, status, attempts,
                        error, claimed_at, created_at, apple_music)
    values ('youtube', ${sourceId}, ${'https://www.youtube.com/watch?v=' + sourceId}, 'Raw Title',
            ${opts.title ?? 'Song'}, ${opts.status ?? 'waiting'}, ${opts.attempts ?? 0},
            ${opts.error ?? ''}, ${claimedAt}, ${createdAt}, ${opts.appleMusic ?? false})
    returning id`
  return String(rows[0].id)
}

async function trackRow(id: string): Promise<Record<string, unknown>> {
  const rows = await sql`select * from tracks where id = ${id}`
  expect(rows).toHaveLength(1)
  return rows[0]
}

beforeAll(() => {
  // Set before any query: dbMode() decides the driver on first use.
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  // One PGlite boot per file; each test starts from a clean library and the
  // seeded settings row (SPEC 6).
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events, search_cache`
  await sql`update settings set agent_last_seen = null, agent_version = '', apple_music_export = false where id = 1`
})

describe('claimTracks (SPEC 8.3)', () => {
  it('claims up to 3 waiting tracks oldest first and marks them downloading with attempts+1', async () => {
    const oldest = await seedTrack({ createdSecondsAgo: 300 })
    const middle = await seedTrack({ createdSecondsAgo: 200 })
    const newest = await seedTrack({ createdSecondsAgo: 100 })
    await seedTrack({ createdSecondsAgo: 50 })
    await seedTrack({ createdSecondsAgo: 10 })

    const claimed = await claimTracks()

    expect(claimed.map((track) => track.id)).toEqual([oldest, middle, newest])
    const row = await trackRow(oldest)
    expect(row.status).toBe('downloading')
    expect(row.attempts).toBe(1)
    expect(row.claimed_at).not.toBeNull()
  })

  it('returns exactly the SPEC 8.3 field list plus the v2 fields', async () => {
    await seedTrack({ title: 'Song', appleMusic: true, createdSecondsAgo: 30 })

    const [claimed] = await claimTracks()

    expect(claimed).toBeDefined()
    expect(Object.keys(claimed!).sort()).toEqual(
      [
        'album', 'apple_music', 'artist', 'cover_url', 'duration_sec', 'id', 'source', 'source_url', 'title',
        // v2 (V2-PLAN T9)
        'isrc', 'catalog_id', 'resolved_url',
      ].sort(),
    )
    expect(claimed!.apple_music).toBe(true)
    expect(claimed!.source).toBe('youtube')
  })

  it('never hands the same track to two parallel claims', async () => {
    for (let i = 0; i < 7; i += 1) await seedTrack()

    const [first, second] = await Promise.all([claimTracks(), claimTracks()])

    expect(first).toHaveLength(CLAIM_BATCH)
    expect(second).toHaveLength(CLAIM_BATCH)
    const ids = [...first, ...second].map((track) => track.id)
    // The invariant the claim CTE guarantees: no overlap, ever.
    expect(new Set(ids).size).toBe(ids.length)
    // 7 waiting, 6 claimed between the two polls, 1 left waiting.
    const remaining = await sql`select id from tracks where status = 'waiting'`
    expect(remaining).toHaveLength(1)
  })

  it('respects a custom limit', async () => {
    for (let i = 0; i < 5; i += 1) await seedTrack()
    expect(await claimTracks(2)).toHaveLength(2)
  })

  it('returns an empty array when nothing is waiting', async () => {
    expect(await claimTracks()).toEqual([])
  })

  it('claims only waiting rows; ready, failed and downloading stay untouched', async () => {
    await seedTrack({ status: 'ready', createdSecondsAgo: 100 })
    await seedTrack({ status: 'failed', attempts: 3, createdSecondsAgo: 90 })
    await seedTrack({ status: 'downloading', attempts: 1, claimedSecondsAgo: 10, createdSecondsAgo: 80 })
    const waiting = await seedTrack({ createdSecondsAgo: 5 })

    const claimed = await claimTracks()

    expect(claimed.map((track) => track.id)).toEqual([waiting])
  })
})

describe('stale-claim reset (SPEC 8.3)', () => {
  it('re-claims a downloading row claimed more than 15 minutes ago, incrementing attempts again', async () => {
    const stale = await seedTrack({
      status: 'downloading',
      attempts: 1,
      claimedSecondsAgo: STALE_CLAIM_SECONDS + 60,
    })

    const claimed = await claimTracks()

    expect(claimed.map((track) => track.id)).toEqual([stale])
    const row = await trackRow(stale)
    expect(row.status).toBe('downloading')
    expect(row.attempts).toBe(2) // 1 from the dead claim, +1 from the fresh one
  })

  it('leaves downloading rows alone while the claim is younger than 15 minutes', async () => {
    const fresh = await seedTrack({
      status: 'downloading',
      attempts: 1,
      claimedSecondsAgo: STALE_CLAIM_SECONDS - 60,
    })

    expect(await claimTracks()).toEqual([])
    const row = await trackRow(fresh)
    expect(row.status).toBe('downloading')
    expect(row.attempts).toBe(1)
  })

  it('resetStaleClaims recovers stale rows on its own', async () => {
    const stale = await seedTrack({
      status: 'downloading',
      attempts: 1,
      claimedSecondsAgo: STALE_CLAIM_SECONDS + 1,
    })
    expect(await resetStaleClaims()).toBe(1)
    const row = await trackRow(stale)
    expect(row.status).toBe('waiting')
  })
})

describe('fail ladder (SPEC 8.3)', () => {
  it('requeues twice, then fails at 3 attempts, and retry starts over', async () => {
    const id = await seedTrack()

    // Attempt 1 → fail → back to waiting.
    await claimTracks()
    expect(await failTrack(id, 'boom 1')).toBe('waiting')
    // Attempt 2 → fail → back to waiting.
    await claimTracks()
    expect(await failTrack(id, 'boom 2')).toBe('waiting')
    // Attempt 3 → final failure.
    await claimTracks()
    expect(await failTrack(id, 'boom 3')).toBe('failed')

    const row = await trackRow(id)
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(row.error).toBe('boom 3')

    // UI Retry: requeue from zero.
    expect(await retryTrack(id)).toBe(true)
    const retried = await trackRow(id)
    expect(retried.status).toBe('waiting')
    expect(retried.attempts).toBe(0)
    expect(retried.error).toBe('')

    // And the track can be claimed again.
    const claimed = await claimTracks()
    expect(claimed.map((track) => track.id)).toEqual([id])
  })

  it('stores only the first 500 characters of the error', async () => {
    const id = await seedTrack()
    await claimTracks()

    // 600 characters of a multi-byte character: left() counts characters, not bytes.
    await failTrack(id, 'ä'.repeat(600))

    const row = await trackRow(id)
    expect(String(row.error)).toHaveLength(500)
    expect(row.status).toBe('waiting') // attempts=1: still retryable
  })

  it('reports unknown tracks as null', async () => {
    expect(await failTrack(randomUUID(), 'boom')).toBeNull()
  })
})

describe('completeTrack (SPEC 8.3)', () => {
  it('marks a claimed track ready with storage, size and duration', async () => {
    const id = await seedTrack()
    await claimTracks()

    expect(
      await completeTrack({ trackId: id, key: trackKey(id), bytes: 12345, durationSec: 179.6 }),
    ).toBe(true)

    const row = await trackRow(id)
    expect(row.status).toBe('ready')
    expect(row.storage_key).toBe(trackKey(id))
    expect(Number(row.bytes)).toBe(12345)
    expect(row.duration_sec).toBe(180) // ffprobe fractions round to the int column
    expect(row.ready_at).not.toBeNull()
    expect(row.error).toBe('')
  })

  it('leaves the stored duration alone when none is provided', async () => {
    const id = await seedTrack()
    await sql`update tracks set duration_sec = 42 where id = ${id}`
    await claimTracks()

    await completeTrack({ trackId: id, key: trackKey(id), bytes: 1, durationSec: null })

    const row = await trackRow(id)
    expect(row.duration_sec).toBe(42)
  })

  it('reports unknown tracks as false', async () => {
    expect(await completeTrack({ trackId: randomUUID(), key: 'tracks/x.m4a', bytes: 1 })).toBe(false)
  })
})

describe('recordAgentSeen (SPEC 8.3)', () => {
  it('stores agent_last_seen and a new version, keeping the version on later polls without one', async () => {
    await recordAgentSeen('1.2.3')
    let settings = await sql`select agent_last_seen, agent_version from settings where id = 1`
    expect(settings[0].agent_version).toBe('1.2.3')
    expect(settings[0].agent_last_seen).not.toBeNull()
    const firstSeen = settings[0].agent_last_seen

    // A later poll without a version header refreshes seen, keeps version.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await recordAgentSeen(null)
    settings = await sql`select agent_last_seen, agent_version from settings where id = 1`
    expect(settings[0].agent_version).toBe('1.2.3')
    expect(settings[0].agent_last_seen).not.toBe(firstSeen)
  })
})

describe('retryTrack / markAppleMusicDone (SPEC 8.3)', () => {
  it('retries any track back to waiting with a clean slate', async () => {
    const id = await seedTrack({ status: 'failed', attempts: 3, error: 'boom' })
    expect(await retryTrack(id)).toBe(true)
    const row = await trackRow(id)
    expect(row.status).toBe('waiting')
    expect(row.attempts).toBe(0)
    expect(row.error).toBe('')
  })

  it('marks the Apple Music copy done without touching status or attempts', async () => {
    const id = await seedTrack({ status: 'ready', attempts: 3 })
    expect(await markAppleMusicDone(id)).toBe(true)
    const row = await trackRow(id)
    expect(row.apple_music_done_at).not.toBeNull()
    expect(row.status).toBe('ready')
    expect(row.attempts).toBe(3)
  })

  it('reports unknown tracks for retry and apple-music-done', async () => {
    expect(await retryTrack(randomUUID())).toBe(false)
    expect(await markAppleMusicDone(randomUUID())).toBe(false)
  })
})
