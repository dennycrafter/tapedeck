/**
 * Catalog matching for imported songs (V2-PLAN T13): ISRC first, then an
 * artist + title search with the length within 5 s, else no match. The
 * catalog answers come from the recorded Deezer fixtures
 * (e2e/fixtures/import-deezer.json) through the TAPEDECK_TEST stand-in;
 * nothing here touches the network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetDb } from './db'
import type { CatalogTrack } from './catalog-types'
import {
  lengthTooFar,
  matchToCatalog,
  pickSearchMatch,
  runWithDeadline,
  searchQuery,
  LENGTH_TOLERANCE_SEC,
} from './import-match'

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

function catalogTrack(id: number, title: string, artist: string, durationSec: number | null): CatalogTrack {
  return {
    id: `deezer:${id}`,
    title,
    artist,
    artistId: null,
    album: null,
    albumId: null,
    albumArtist: artist,
    coverUrl: null,
    thumbUrl: null,
    durationSec,
    isrc: null,
    trackNumber: null,
    discNumber: null,
    explicit: false,
  }
}

describe('lengthTooFar', () => {
  it('allows up to 5 seconds either way', () => {
    expect(LENGTH_TOLERANCE_SEC).toBe(5)
    expect(lengthTooFar(200, 205)).toBe(false)
    expect(lengthTooFar(205, 200)).toBe(false)
    expect(lengthTooFar(200, 206)).toBe(true)
  })

  it('never rejects when a length is unknown', () => {
    expect(lengthTooFar(null, 200)).toBe(false)
    expect(lengthTooFar(200, undefined)).toBe(false)
    expect(lengthTooFar(0, 200)).toBe(false)
  })
})

describe('searchQuery', () => {
  it('is "artist title", spaces collapsed', () => {
    expect(searchQuery({ title: '  Veridis   Quo ', artist: 'Daft Punk' })).toBe('Daft Punk Veridis Quo')
    expect(searchQuery({ title: 'Song', artist: '' })).toBe('Song')
  })
})

describe('pickSearchMatch', () => {
  const results = [
    catalogTrack(1, 'Something About Us (Speedy Beats House Version)', 'Speedy Beats', 280),
    catalogTrack(2, 'One More Time', 'Daft Punk', 320),
    catalogTrack(3, 'One More Time (Short Radio Edit)', 'Daft Punk', 235),
  ]

  it('takes the first result with the same title and artist within 5 s', () => {
    expect(pickSearchMatch(results, { title: 'One More Time', artist: 'Daft Punk', durationSec: 322, isrc: null })?.id).toBe('deezer:2')
  })

  it('skips a result whose length is too far off, even with the same title', () => {
    expect(pickSearchMatch(results, { title: 'One More Time', artist: 'Daft Punk', durationSec: 236, isrc: null })?.id).toBe('deezer:3')
    expect(pickSearchMatch(results, { title: 'One More Time', artist: 'Daft Punk', durationSec: 600, isrc: null })).toBeNull()
  })

  it('needs the artist to match', () => {
    expect(pickSearchMatch(results, { title: 'One More Time', artist: 'Someone Else', durationSec: 320, isrc: null })).toBeNull()
  })

  it('takes the first title and artist match when the length is unknown', () => {
    expect(pickSearchMatch(results, { title: 'One More Time', artist: 'Daft Punk', durationSec: null, isrc: null })?.id).toBe('deezer:2')
  })
})

describe('matchToCatalog (recorded Deezer answers)', () => {
  it('matches by ISRC first', async () => {
    const outcome = await matchToCatalog({
      title: 'Harder Better Faster Stronger',
      artist: 'Daft Punk',
      durationSec: 226,
      isrc: 'GBDUW0000059',
    })
    expect(outcome.how).toBe('isrc')
    expect(outcome.catalog).toMatchObject({
      id: 'deezer:3135556',
      title: 'Harder, Better, Faster, Stronger',
      album: 'Discovery',
      isrc: 'GBDUW0000059',
      durationSec: 226,
    })
    expect(outcome.catalog?.coverUrl).toMatch(/^https:\/\/.+600x600/)
  })

  it('falls back to the search when Deezer has no song with that ISRC', async () => {
    const outcome = await matchToCatalog({ title: 'Veridis Quo', artist: 'Daft Punk', durationSec: 345, isrc: 'ZZZZ00000000' })
    expect(outcome).toMatchObject({ how: 'search', catalog: { id: 'deezer:3135563' } })
  })

  it('matches by artist and title, passing over covers and remixes', async () => {
    const outcome = await matchToCatalog({ title: 'Something About Us', artist: 'Daft Punk', durationSec: 233, isrc: null })
    expect(outcome).toMatchObject({ how: 'search', catalog: { id: 'deezer:3135561', isrc: 'GBDUW0000064' } })
  })

  it('takes the edit whose length fits', async () => {
    const outcome = await matchToCatalog({ title: 'One More Time', artist: 'Daft Punk', durationSec: 236, isrc: null })
    expect(outcome.catalog?.id).toBe('deezer:3157685')
  })

  it('has no match when no length fits', async () => {
    expect(await matchToCatalog({ title: 'One More Time', artist: 'Daft Punk', durationSec: 600, isrc: null })).toEqual({
      how: 'none',
      catalog: null,
    })
  })

  it('has no match for a song the catalog does not know', async () => {
    expect(await matchToCatalog({ title: 'Paper Lanterns', artist: 'The Fixture Band', durationSec: 201, isrc: null })).toEqual({
      how: 'none',
      catalog: null,
    })
  })
})

describe('runWithDeadline', () => {
  it('runs everything before the deadline, with limited concurrency', async () => {
    let running = 0
    let most = 0
    const results = await runWithDeadline(
      [1, 2, 3, 4, 5, 6, 7],
      async (n) => {
        running++
        most = Math.max(most, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running--
        return n * 10
      },
      { concurrency: 3, deadline: Date.now() + 60_000 },
    )
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(most).toBe(3)
  })

  it('starts nothing new after the deadline, so the results are a prefix', async () => {
    let clock = 0
    const results = await runWithDeadline(
      [1, 2, 3, 4, 5],
      async (n) => {
        clock += 10
        return n
      },
      { concurrency: 1, deadline: 25, now: () => clock },
    )
    expect(results).toEqual([1, 2, 3, undefined, undefined])
  })

  it('always starts the first item, so a late request still makes progress', async () => {
    const results = await runWithDeadline([1, 2], async (n) => n, { concurrency: 2, deadline: 0, now: () => 100 })
    expect(results).toEqual([1, undefined])
  })
})
