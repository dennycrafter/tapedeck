/**
 * Unit tests for cover matching and lookup (SPEC 8.5, 7.6). The match-rule
 * tests use the LIVE-recorded iTunes candidate sets from the MSW fixtures
 * (e2e/fixtures/itunes-search.json, recorded 2026-10-10 — see the fixtures
 * README) against the AI-cleaned titles of the same five MVs; near-miss
 * cases are hand-built.
 */

import { http, HttpResponse } from 'msw'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import itunesFixture from '../e2e/fixtures/itunes-search.json'
import { server, startTestMocks, stopTestMocks } from '../e2e/mocks/server'
import {
  artistMatches,
  candidateMatches,
  type CoverCandidate,
  itunesBigArtwork,
  jaccardOverlap,
  lookupCoverArt,
  normalizeForMatch,
  pickCoverMatch,
  stripAlbumSuffix,
} from './cover-art'

beforeAll(() => {
  process.env.TAPEDECK_TEST = '1'
  expect(startTestMocks({ onUnhandledRequest: 'error' })).toBe(true)
})

afterAll(() => {
  stopTestMocks()
  delete process.env.TAPEDECK_TEST
})

const itunes = itunesFixture as unknown as {
  terms: Record<string, { results: { trackName: string; artistName: string; collectionName: string; artworkUrl100: string }[] }>
  empty: unknown
}

/** The live-recorded candidates for one of the five MV lookups. */
function recorded(term: string): CoverCandidate[] {
  const body = itunes.terms[term]
  if (!body) throw new Error(`missing recorded fixture term: ${term}`)
  return body.results.map((result) => ({
    title: result.trackName,
    artist: result.artistName,
    album: result.collectionName,
    artworkUrl: itunesBigArtwork(result.artworkUrl100),
  }))
}

describe('normalizeForMatch (SPEC 8.5 + brief)', () => {
  it('lowercases and drops punctuation, brackets and extra spaces', () => {
    // Bracket removal deletes the Korean group text too — that is what keeps
    // the Jaccard score high against candidates like plain "Gangnam Style".
    expect(normalizeForMatch('Gangnam Style (강남스타일) M/V')).toBe('gangnam style m v')
    expect(normalizeForMatch('  Get   Lucky!!  ')).toBe('get lucky')
  })

  it('treats ampersand as "and" (brief: ampersand vs and)', () => {
    expect(normalizeForMatch('Luis Fonsi & Daddy Yankee')).toBe('luis fonsi and daddy yankee')
  })

  it('strips accents (brief: accents)', () => {
    expect(normalizeForMatch('Beyoncé')).toBe('beyonce')
  })

  it('removes bracketed text including nested groups', () => {
    expect(normalizeForMatch('Track [Official Video (HD Remaster)]')).toBe('track')
  })

  it('cuts everything from the first feat marker', () => {
    expect(normalizeForMatch('Uptown Funk ft. Bruno Mars')).toBe('uptown funk')
    expect(normalizeForMatch('Sunflower - Post Malone & Swae Lee feat. extra noise')).toBe('sunflower post malone and swae lee')
  })

  it('strips a leading article from both sides (brief: article strips)', () => {
    expect(normalizeForMatch('The Weeknd')).toBe('weeknd')
    expect(normalizeForMatch('the beatles')).toBe('beatles')
  })
})

describe('jaccardOverlap (SPEC 8.5 threshold 0.8)', () => {
  it('is 1 for identical text and 0 when a side is empty', () => {
    expect(jaccardOverlap('harder better faster stronger', 'stronger faster harder better')).toBe(1)
    expect(jaccardOverlap('', 'anything')).toBe(0)
  })

  it('matches exactly at 0.8 and rejects just below (boundary)', () => {
    // 4 shared tokens over a 5-token union = exactly 0.8.
    expect(jaccardOverlap('harder better faster stronger', 'harder better faster stronger live')).toBeCloseTo(0.8)
    expect(candidateMatches(
      { title: 'harder better faster stronger live', artist: 'Daft Punk', album: '', artworkUrl: '' },
      'Harder Better Faster Stronger',
      'Daft Punk',
    )).toBe(true)
    // 2 shared tokens over a 6-token union = 1/3 — well below the gate.
    expect(jaccardOverlap('harder better faster', 'harder better stronger win live')).toBeCloseTo(1 / 3)
  })
})

describe('candidateMatches / artistMatches (SPEC 8.5 rule)', () => {
  it('requires the artist to match before comparing titles', () => {
    expect(artistMatches('The Weeknd', 'The Weeknd VEVO')).toBe(true)
    expect(artistMatches('The Weeknd', 'weeknd')).toBe(true)
    expect(artistMatches('Wiz Khalifa', 'Charlie Puth')).toBe(false)
  })

  it('matches the five MV lookups against the LIVE-recorded iTunes sets', () => {
    // The AI-cleaned (title, artist) pairs for the five recorded MVs vs the
    // candidate lists iTunes actually returned on 2026-10-10.
    const cases: [string, string, string][] = [
      ['the weeknd blinding lights', 'Blinding Lights', 'The Weeknd'],
      ['luis fonsi despacito', 'Despacito (feat. Daddy Yankee)', 'Luis Fonsi'],
      ['psy gangnam style', 'Gangnam Style', 'PSY'],
      ['wiz khalifa see you again', 'See You Again (feat. Charlie Puth)', 'Wiz Khalifa'],
      ['mark ronson uptown funk', 'Uptown Funk (feat. Bruno Mars)', 'Mark Ronson'],
    ]
    for (const [term, title, artist] of cases) {
      expect(recorded(term).some((candidate) => candidateMatches(candidate, title, artist))).toBe(true)
    }
  })

  it('rejects the five hand-built near misses (brief)', () => {
    const pairs: [string, string, CoverCandidate][] = [
      // (our title, our artist, the wrong candidate)
      ['Get Lucky', 'Daft Punk', { title: 'Get Luxurious', artist: 'Daft Punk', album: '', artworkUrl: '' }],
      ['Blinding Lights', 'The Weeknd', { title: 'Blinding Frights', artist: 'The Weeknd', album: '', artworkUrl: '' }],
      ['One More Time', 'Daft Punk', { title: 'One More Chance', artist: 'Daft Punk', album: '', artworkUrl: '' }],
      ['Gangnam Style', 'PSY', { title: 'Gangnam Style', artist: 'Enrique Iglesias', album: '', artworkUrl: '' }],
      ['Harder Better Faster Stronger', 'Daft Punk', { title: 'Harder Better Faster', artist: 'Daft Punk', album: '', artworkUrl: '' }],
    ]
    for (const [title, artist, candidate] of pairs) {
      expect(candidateMatches(candidate, title, artist)).toBe(false)
    }
  })

  it('does not let a contained artist prefix fake a match ("Nile" vs "Nile Rodgers")', () => {
    // Artist containment holds, but the titles differ — no match.
    expect(candidateMatches(
      { title: 'Nile', artist: 'Nile Rodgers', album: '', artworkUrl: '' },
      'Le Freak',
      'Nile Rodgers',
    )).toBe(false)
  })
})

describe('stripAlbumSuffix (SPEC 8.5)', () => {
  it('strips " - Single" and " - EP" and keeps full album names', () => {
    expect(stripAlbumSuffix('Gangnam Style - Single')).toBe('Gangnam Style')
    expect(stripAlbumSuffix('Get Lucky - EP')).toBe('Get Lucky')
    expect(stripAlbumSuffix('After Hours')).toBe('After Hours')
    expect(stripAlbumSuffix('RAM - Live')).toBe('RAM - Live')
  })
})

describe('itunesBigArtwork (SPEC 7.6)', () => {
  it('rewrites 100x100bb to 600x600bb', () => {
    expect(itunesBigArtwork('https://is1-ssl.mzstatic.com/x/100x100bb.jpg')).toBe('https://is1-ssl.mzstatic.com/x/600x600bb.jpg')
  })
})

describe('pickCoverMatch (SPEC 8.5 first match wins)', () => {
  it('returns the first candidate that passes the rule, with stripped album', () => {
    // "(Remix)" is bracket text, so normalization makes this candidate an
    // exact title match — the SPEC first-match rule takes it.
    const match = pickCoverMatch(
      [
        { title: 'Gangnam Style (Remix)', artist: 'PSY', album: 'Remix - Single', artworkUrl: 'https://a/1.jpg' },
        { title: 'Gangnam Style', artist: 'PSY', album: 'Gangnam Style - Single', artworkUrl: 'https://a/2.jpg' },
      ],
      'Gangnam Style',
      'PSY',
    )
    expect(match).toEqual({ coverUrl: 'https://a/1.jpg', album: 'Remix', albumArtist: 'PSY' })
  })

  it('skips earlier candidates that fail the rule', () => {
    const match = pickCoverMatch(
      [
        { title: 'Gangnam Remix', artist: 'PSY', album: 'Remix - Single', artworkUrl: 'https://a/1.jpg' },
        { title: 'Gangnam Style', artist: 'PSY', album: 'Gangnam Style - Single', artworkUrl: 'https://a/2.jpg' },
      ],
      'Gangnam Style',
      'PSY',
    )
    expect(match).toEqual({ coverUrl: 'https://a/2.jpg', album: 'Gangnam Style', albumArtist: 'PSY' })
  })

  it('returns null when nothing matches', () => {
    expect(pickCoverMatch(recorded('the weeknd blinding lights'), 'Le Freak', 'Chic')).toBeNull()
  })
})

describe('lookupCoverArt (SPEC 8.5 flow over SPEC 7.6 providers)', () => {
  it('matches the recorded Blinding Lights lookup end to end (iTunes first)', async () => {
    // Recorded iTunes ranked the ROSALÍA remix first; bracket normalization
    // makes its title an exact match, so the SPEC first-match rule picks it.
    const match = await lookupCoverArt('Blinding Lights', 'The Weeknd')
    expect(match).not.toBeNull()
    expect(match?.album).toBe('Blinding Lights (Remix)')
    expect(match?.albumArtist).toBe('The Weeknd & ROSALÍA')
    expect(match?.coverUrl).toContain('600x600bb')
  })

  it('falls back to Deezer when iTunes has no match (recorded bodies)', async () => {
    // iTunes returns no candidates (simulated miss), so the lookup must
    // reach Deezer's recorded body for "daft punk get lucky".
    server.use(
      http.get('https://itunes.apple.com/search', () => HttpResponse.json(itunes.empty as object)),
    )
    const match = await lookupCoverArt('Get Lucky', 'Daft Punk')
    expect(match).not.toBeNull()
    expect(match?.coverUrl).toContain('dzcdn.net')
    expect(match?.albumArtist).toBe('Daft Punk')
  })

  it('resolves null when both providers fail (never throws)', async () => {
    server.use(
      http.get('https://itunes.apple.com/search', () => HttpResponse.json({ error: 'x' }, { status: 500 })),
      http.get('https://api.deezer.com/search', () => HttpResponse.json({ error: 'x' }, { status: 500 })),
    )
    await expect(lookupCoverArt('Anything', 'Anyone')).resolves.toBeNull()
  })

  it('resolves null when providers return no candidates', async () => {
    const match = await lookupCoverArt('Completely Unknown Song Title Here', 'Unknown Artist Here')
    expect(match).toBeNull()
  })
})
