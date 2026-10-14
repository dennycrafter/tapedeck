/**
 * Unit tests for the raw metadata fetchers (SPEC 7.3, 7.4). Every external
 * call is served by the recorded T0 fixtures through MSW (9.0), the same
 * handlers the e2e harness defines, plus local overrides for the cases the
 * recorded set does not cover (SoundCloud, redirects).
 */

import { http, HttpResponse } from 'msw'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import videosFixture from '../e2e/fixtures/youtube-videos-list.json'
import { server, startTestMocks, stopTestMocks } from '../e2e/mocks/server'
import { HttpError } from './http'
import {
  MetadataError,
  fetchSoundcloudMetadata,
  fetchYoutubeMetadata,
  fetchYoutubeOembedMetadata,
  parseIsoDuration,
  resolveSoundcloudShortLink,
  type RawTrackMetadata,
} from './metadata'

/** Narrow the union honestly: a failed lookup throws instead of a silent assertion. */
function expectRawMetadata(
  results: Map<string, RawTrackMetadata | MetadataError>,
  id: string,
): RawTrackMetadata {
  const metadata = results.get(id)
  if (!metadata || metadata instanceof MetadataError) {
    throw new Error(`expected raw metadata for ${id}`)
  }
  return metadata
}

beforeAll(() => {
  process.env.TAPEDECK_TEST = '1'
  expect(startTestMocks({ onUnhandledRequest: 'error' })).toBe(true)
})

afterAll(() => {
  stopTestMocks()
  delete process.env.TAPEDECK_TEST
})

describe('parseIsoDuration (SPEC 7.3 contentDetails.duration)', () => {
  it('parses the documented example and common shapes', () => {
    expect(parseIsoDuration('PT3M45S')).toBe(225)
    expect(parseIsoDuration('PT19S')).toBe(19)
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723)
    expect(parseIsoDuration('P1DT2H')).toBe(93_600)
    expect(parseIsoDuration('PT2M')).toBe(120)
  })

  it('rounds fractional seconds', () => {
    expect(parseIsoDuration('PT1.4S')).toBe(1)
    expect(parseIsoDuration('PT2.5S')).toBe(3)
  })

  it('returns null for non-durations and empty durations', () => {
    expect(parseIsoDuration('3:45')).toBeNull()
    expect(parseIsoDuration('')).toBeNull()
    expect(parseIsoDuration('PT')).toBeNull()
    expect(parseIsoDuration('P')).toBeNull()
  })
})

describe('fetchYoutubeMetadata without a key (SPEC 7.3 oEmbed path)', () => {
  it('serves the recorded video from the oEmbed fixture', async () => {
    const results = await fetchYoutubeMetadata(['jNQXAC9IVRw'], undefined)
    const metadata = expectRawMetadata(results, 'jNQXAC9IVRw')
    expect(metadata.rawTitle).toBe('Me at the zoo')
    expect(metadata.rawArtist).toBe('jawed')
    expect(metadata.rawThumbnailUrl).toBe('https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg')
    // 7.3: no description, no duration on the oEmbed path.
    expect(metadata.description).toBe('')
    expect(metadata.durationSec).toBeNull()
  })

  it('reports a MetadataError for an unknown video (fixture 404)', async () => {
    const results = await fetchYoutubeMetadata(['aaaaaaaaaaa'], undefined)
    const error = results.get('aaaaaaaaaaa')
    expect(error).toBeInstanceOf(MetadataError)
    expect((error as MetadataError).status).toBe(404)
  })

  it('serves every requested id independently', async () => {
    const results = await fetchYoutubeMetadata(['jNQXAC9IVRw', 'aaaaaaaaaaa'], undefined)
    expect(results.get('jNQXAC9IVRw')).not.toBeInstanceOf(MetadataError)
    expect(results.get('aaaaaaaaaaa')).toBeInstanceOf(MetadataError)
  })
})

describe('fetchYoutubeMetadata with a key (SPEC 7.3 videos.list path)', () => {
  it('batches one videos.list call and returns description and duration', async () => {
    const results = await fetchYoutubeMetadata(['jNQXAC9IVRw', 'aaaaaaaaaaa'], 'test-key')
    const metadata = expectRawMetadata(results, 'jNQXAC9IVRw')
    expect(metadata.rawTitle).toBe('Me at the zoo')
    expect(metadata.rawArtist).toBe('jawed')
    expect(metadata.rawThumbnailUrl).toBe('https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg')
    // The recorded description is under 300 chars, so it passes through whole.
    expect(metadata.description).toBe(videosFixture.jNQXAC9IVRw.snippet.description)
    // contentDetails.duration PT19S → 19 (7.3 ISO 8601).
    expect(metadata.durationSec).toBe(19)

    // The fixture omits unknown ids (9.0 handler convention).
    expect(results.get('aaaaaaaaaaa')).toBeInstanceOf(MetadataError)
  })

  it('truncates the description to its first 300 characters (SPEC 7.3)', async () => {
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/videos', () =>
        HttpResponse.json({
          kind: 'youtube#videoListResponse',
          items: [
            {
              id: 'jNQXAC9IVRw',
              snippet: {
                title: 'Long description',
                channelTitle: 'jawed',
                description: 'x'.repeat(1000),
                thumbnails: {},
              },
              contentDetails: { duration: 'PT1M' },
            },
          ],
        }),
      ),
    )
    const results = await fetchYoutubeMetadata(['jNQXAC9IVRw'], 'test-key')
    const metadata = expectRawMetadata(results, 'jNQXAC9IVRw')
    expect(metadata.description).toBe('x'.repeat(300))
    expect(metadata.durationSec).toBe(60)
  })

  it('surfaces a batch-wide MetadataError when videos.list fails', async () => {
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/videos', () =>
        HttpResponse.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
      ),
    )
    const results = await fetchYoutubeMetadata(['jNQXAC9IVRw'], 'test-key')
    const error = results.get('jNQXAC9IVRw')
    expect(error).toBeInstanceOf(MetadataError)
    expect((error as MetadataError).status).toBe(403)
  })

  it('chunks more than 50 ids into multiple calls', async () => {
    let calls = 0
    const seenIdCounts: number[] = []
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/videos', ({ request }) => {
        calls += 1
        seenIdCounts.push((new URL(request.url).searchParams.get('id') ?? '').split(',').length)
        return HttpResponse.json({ kind: 'youtube#videoListResponse', items: [] })
      }),
    )
    const ids = Array.from({ length: 55 }, (_, i) => `id${String(i).padStart(8, '0')}`)
    const results = await fetchYoutubeMetadata(ids, 'test-key')
    expect(calls).toBe(2)
    expect(seenIdCounts).toEqual([50, 5])
    // Every id still resolves (here: not found, the fixture set is empty).
    for (const id of ids) expect(results.get(id)).toBeInstanceOf(MetadataError)
  })
})

describe('fetchYoutubeOembedMetadata (exported single-id form)', () => {
  it('wraps transport failures in MetadataError', async () => {
    server.use(
      http.get('https://www.youtube.com/oembed', () => HttpResponse.error()),
    )
    await expect(fetchYoutubeOembedMetadata('jNQXAC9IVRw')).rejects.toBeInstanceOf(MetadataError)
  })
})

describe('SoundCloud (SPEC 7.4)', () => {
  beforeAll(() => {
    // The recorded T0 fixture set has no SoundCloud exchange (T0 only proved
    // reachability); these local handlers stand in for it.
    server.use(
      http.get('https://soundcloud.com/oembed', ({ request }) => {
        const sourceUrl = new URL(request.url).searchParams.get('url') ?? ''
        if (sourceUrl.includes('forss/flickermood')) {
          return HttpResponse.json({
            title: 'Flickermood',
            author_name: 'Forss',
            thumbnail_url: 'https://i.ytimg.com/vi/none.jpg',
          })
        }
        return HttpResponse.json({ title: 'Get Lucky by Daft Punk', author_name: 'Radio Record' })
      }),
    )
  })

  it('fetches title, uploader and thumbnail from SoundCloud oEmbed', async () => {
    const metadata = await fetchSoundcloudMetadata('https://soundcloud.com/forss/flickermood')
    expect(metadata.rawTitle).toBe('Flickermood')
    expect(metadata.rawArtist).toBe('Forss')
    expect(metadata.durationSec).toBeNull() // 7.4: no duration from oEmbed
  })

  it('passes through the "Track by Artist" title for the cleaner to split', async () => {
    const metadata = await fetchSoundcloudMetadata('https://soundcloud.com/other/track')
    expect(metadata.rawTitle).toBe('Get Lucky by Daft Punk')
    expect(metadata.rawArtist).toBe('Radio Record')
  })
})

describe('resolveSoundcloudShortLink (SPEC 7.4: follow the redirect server-side)', () => {
  it('resolves to the final URL after following the redirect', async () => {
    server.use(
      http.get('https://on.soundcloud.com/abc123', () =>
        new HttpResponse(null, { status: 302, headers: { location: 'https://soundcloud.com/forss/flickermood' } }),
      ),
      // MSW sees the followed request too, so the redirect target needs a handler.
      http.get('https://soundcloud.com/forss/flickermood', () =>
        HttpResponse.json({}, { status: 200 }),
      ),
    )
    const resolved = await resolveSoundcloudShortLink('https://on.soundcloud.com/abc123')
    expect(resolved).toBe('https://soundcloud.com/forss/flickermood')
  })

  it('rejects for a dead short link', async () => {
    server.use(
      http.get('https://on.soundcloud.com/dead', () => new HttpResponse(null, { status: 404 })),
    )
    await expect(resolveSoundcloudShortLink('https://on.soundcloud.com/dead')).rejects.toBeInstanceOf(
      HttpError,
    )
  })
})
