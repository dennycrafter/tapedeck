/**
 * POST /api/tracks with an Anthropic key set (SPEC 8.4 step 2, 8.5, 7.4):
 * real in-memory PGlite (fresh per test via resetDb) plus the MSW fixture
 * handlers, which answer each raw title with its recorded AI reply
 * (e2e/fixtures/anthropic-messages.json). Covers the confidence gate, the
 * non-music path (song added, no cover lookup, no thumbnail as cover) and
 * the SoundCloud oEmbed fixture.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HttpResponse, http } from 'msw'

import { resetDb, sql } from '../../../lib/db'
import { server, startTestMocks, stopTestMocks } from '../../../e2e/mocks/server'
import oembedFixture from '../../../e2e/fixtures/youtube-oembed.json'
import { POST } from './route'

startTestMocks({ onUnhandledRequest: 'error' })

const KEY = 'sk-ant-fixture-key'
const ZOO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const ZOO_THUMBNAIL = (oembedFixture as { videos: Record<string, { thumbnail_url: string }> }).videos.jNQXAC9IVRw
  .thumbnail_url

/** The five recorded music videos and the clean values of their fixture AI replies. */
const FIVE_MV: Array<{ id: string; title: string; artist: string; confidence: number }> = [
  { id: '4NRXx6U8ABQ', title: 'Blinding Lights', artist: 'The Weeknd', confidence: 0.97 },
  { id: 'kJQP7kiw5Fk', title: 'Despacito (feat. Daddy Yankee)', artist: 'Luis Fonsi', confidence: 0.96 },
  { id: '9bZkp7q19f0', title: 'Gangnam Style', artist: 'PSY', confidence: 0.95 },
  { id: 'RgKAFK5djSk', title: 'See You Again (feat. Charlie Puth)', artist: 'Wiz Khalifa', confidence: 0.96 },
  { id: 'OPf0YbXqDm0', title: 'Uptown Funk (feat. Bruno Mars)', artist: 'Mark Ronson', confidence: 0.97 },
]

/** A made-up video id the oEmbed override below answers with the "mystery upload" raw title. */
const MYSTERY_ID = 'MysteryUp01'

interface StoredRow {
  title: string
  artist: string
  album: string | null
  cover_url: string | null
  raw_thumbnail_url: string | null
  ai_cleaned: boolean
  ai_confidence: string | number | null
}

function post(urls: string[]): Promise<Response> {
  return POST(
    new Request('http://localhost/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    }),
  )
}

async function addOne(url: string): Promise<StoredRow> {
  const response = await post([url])
  expect(response.status).toBe(200)
  const body = (await response.json()) as { results: Array<{ status: string; message: string }> }
  expect(body.results[0], JSON.stringify(body.results[0])).toMatchObject({ status: 'added' })
  const rows = (await sql`
    select title, artist, album, cover_url, raw_thumbnail_url, ai_cleaned, ai_confidence
    from tracks order by created_at desc limit 1
  `) as unknown as StoredRow[]
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** Count requests to the cover providers (SPEC 7.6) while a test runs. */
let coverRequests = 0
function countCoverRequests({ request }: { request: Request }): void {
  const host = new URL(request.url).hostname
  if (host === 'itunes.apple.com' || host === 'api.deezer.com') coverRequests++
}

let previousKey: string | undefined

beforeAll(() => {
  previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = KEY
  server.events.on('request:start', countCoverRequests)
})

beforeEach(async () => {
  coverRequests = 0
  await resetDb()
})

afterEach(() => {
  server.resetHandlers()
})

afterAll(async () => {
  server.events.removeListener('request:start', countCoverRequests)
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previousKey
  await resetDb()
  stopTestMocks()
})

describe('fixture AI replies for the five recorded music videos (T3)', () => {
  for (const video of FIVE_MV) {
    it(`adds ${video.id} with the AI title "${video.title}" and artist "${video.artist}"`, async () => {
      const row = await addOne(`https://youtu.be/${video.id}`)
      expect(row.title).toBe(video.title)
      expect(row.artist).toBe(video.artist)
      expect(row.ai_cleaned).toBe(true)
      expect(Number(row.ai_confidence)).toBeCloseTo(video.confidence)
      // Music: the cover lookup ran (8.5).
      expect(coverRequests).toBeGreaterThan(0)
    })
  }
})

describe('non-music replies (8.4: is_music=false only skips the cover lookup)', () => {
  it('adds "Me at the zoo" with the AI result, a null cover and album, and no thumbnail as cover', async () => {
    const row = await addOne(ZOO_URL)
    // Fixture reply: is_music false, confidence 0.95 (at or above the gate).
    expect(row.title).toBe('Me at the zoo')
    expect(row.artist).toBe('jawed')
    expect(row.ai_cleaned).toBe(true)
    expect(Number(row.ai_confidence)).toBeCloseTo(0.95)
    expect(row.cover_url).toBeNull()
    expect(row.album).toBeNull()
    // The thumbnail is kept as raw metadata only, never as the cover (8.5).
    expect(row.raw_thumbnail_url).toBe(ZOO_THUMBNAIL)
    expect(row.cover_url).not.toBe(ZOO_THUMBNAIL)
    expect(coverRequests).toBe(0)
  })

  it('uses the AI title of a non-music reply at or above the gate and makes no cover lookup', async () => {
    server.use(
      http.post('https://api.anthropic.com/v1/messages', () =>
        HttpResponse.json({
          id: 'msg_fixture_nonmusic',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ title: 'Zoo Talk', artist: 'Jawed Karim', is_music: false, confidence: 0.6 }),
            },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 80, output_tokens: 30 },
        }),
      ),
    )
    const row = await addOne(ZOO_URL)
    expect(row.title).toBe('Zoo Talk')
    expect(row.artist).toBe('Jawed Karim')
    expect(row.ai_cleaned).toBe(true)
    expect(Number(row.ai_confidence)).toBeCloseTo(0.6)
    expect(row.cover_url).toBeNull()
    expect(row.album).toBeNull()
    expect(coverRequests).toBe(0)
  })
})

describe('low-confidence reply (8.4: below 0.5 keeps the rule result)', () => {
  it('keeps the rule result for the 0.3 "mystery upload" fixture', async () => {
    server.use(
      http.get('https://www.youtube.com/oembed', ({ request }) => {
        const url = new URL(request.url).searchParams.get('url') ?? ''
        if (!url.includes(MYSTERY_ID)) return undefined
        return HttpResponse.json({
          title: 'Mystery Upload Official Video',
          author_name: 'Mystery Channel',
          thumbnail_url: `https://i.ytimg.com/vi/${MYSTERY_ID}/hqdefault.jpg`,
        })
      }),
    )
    const row = await addOne(`https://youtu.be/${MYSTERY_ID}`)
    // Rule cleaner: trailing marketing stripped, channel name as artist.
    expect(row.title).toBe('Mystery Upload')
    expect(row.artist).toBe('Mystery Channel')
    expect(row.ai_cleaned).toBe(false)
    expect(row.ai_confidence).toBeNull()
    // The discarded reply's verdict does not apply: the cover lookup still ran.
    expect(coverRequests).toBeGreaterThan(0)
  })
})

describe('SoundCloud (7.4, 8.4 "X by Y")', () => {
  it('adds the soundcloud-oembed fixture as "Blinding Lights" by "The Weeknd"', async () => {
    // No AI key for this case: the rule cleaner's "X by Y" split is under test.
    delete process.env.ANTHROPIC_API_KEY
    try {
      const response = await post(['https://soundcloud.com/theweeknd/blinding-lights'])
      const body = (await response.json()) as {
        results: Array<{ status: string; track?: { source: string; title: string; artist: string } }>
      }
      expect(body.results[0].status).toBe('added')
      expect(body.results[0].track).toMatchObject({
        source: 'soundcloud',
        title: 'Blinding Lights',
        artist: 'The Weeknd',
      })
    } finally {
      process.env.ANTHROPIC_API_KEY = KEY
    }
  })
})
