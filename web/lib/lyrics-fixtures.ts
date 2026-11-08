/**
 * Lyrics stand-in (T16): answers LRCLIB's /api/get and /api/search from a
 * few made-up songs, so tests never reach the internet. Every word here is
 * invented for the tests. Same switch as the catalog stand-in: on whenever
 * TAPEDECK_TEST=1 (unit tests and the e2e servers), unless LYRICS_SOURCE=live.
 *
 * One leniency over the real service: a requested title only has to start
 * with a stand-in title, so e2e songs can carry their per-run tag
 * ("Paper Lanterns k3x9").
 */
import type { LrclibRecord } from './lyrics'

export function lyricsUseFixtures(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LYRICS_SOURCE?.trim().toLowerCase() === 'live') return false
  return env.TAPEDECK_TEST === '1'
}

export const FIXTURE_RECORDS: LrclibRecord[] = [
  {
    id: 1,
    trackName: 'Paper Lanterns',
    artistName: 'The Made Ups',
    albumName: 'Test Pressing',
    duration: 180,
    instrumental: false,
    plainLyrics: 'Paper lanterns on the water\nCarry every word we said\nLight them one more time\nUntil the river runs to red',
    syncedLyrics:
      '[ar: The Made Ups]\n[00:00.40] Paper lanterns on the water\n[00:01.40] Carry every word we said\n[00:02.40] Light them one more time\n[00:30.00] Until the river runs to red\n',
  },
  {
    id: 2,
    trackName: 'Quiet Piece',
    artistName: 'The Made Ups',
    albumName: null,
    duration: 180,
    instrumental: true,
    plainLyrics: null,
    syncedLyrics: null,
  },
  {
    // A copy 30 s shorter than the e2e tone: only its words are shown.
    id: 3,
    trackName: 'Radio Edit',
    artistName: 'The Made Ups',
    albumName: null,
    duration: 150,
    instrumental: false,
    plainLyrics: 'Short and sweet\nCut for the radio',
    syncedLyrics: '[00:05.00] Short and sweet\n[00:09.00] Cut for the radio\n',
  },
]

function norm(text: string | null): string {
  return (text ?? '').trim().toLowerCase()
}

/** The stand-in's answer to `https://lrclib.net/api/...`: status and JSON body. */
export function fixtureLyricsResponse(rawUrl: string): { status: number; body: unknown } {
  const url = new URL(rawUrl)
  const track = norm(url.searchParams.get('track_name') ?? url.searchParams.get('q'))
  const artist = norm(url.searchParams.get('artist_name'))
  const matches = FIXTURE_RECORDS.filter(
    (record) => track.startsWith(norm(record.trackName ?? '')) && (!artist || norm(record.artistName ?? '') === artist),
  )
  if (url.pathname === '/api/search') return { status: 200, body: matches }
  if (url.pathname !== '/api/get') return { status: 404, body: { name: 'NotFound' } }
  const duration = Number(url.searchParams.get('duration'))
  const hit = matches.find((record) => !duration || Math.abs((record.duration ?? 0) - duration) <= 2)
  return hit ? { status: 200, body: hit } : { status: 404, body: { code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' } }
}
