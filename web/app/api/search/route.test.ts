/**
 * GET /api/search (SPEC 8.7) route tests: minimum query length, the no-key
 * stand-in message, quota mapping to the SPEC message, upstream failure,
 * and the happy path. Drives the route handler directly, exactly as
 * middleware-authenticated requests would reach it.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { HttpResponse, http } from 'msw'

import { resetDb } from '../../../lib/db'
import { server, startTestMocks, stopTestMocks } from '../../../e2e/mocks/server'
import { SEARCH_OFF_MESSAGE, SEARCH_QUOTA_MESSAGE } from '../../../lib/search-youtube'
import { GET } from './route'

startTestMocks({ onUnhandledRequest: 'error' })

beforeEach(async () => {
  await resetDb()
  delete process.env.YOUTUBE_API_KEY
})

afterAll(async () => {
  await resetDb()
  delete process.env.YOUTUBE_API_KEY
  stopTestMocks()
})

function get(q: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`))
}

interface SearchResponse {
  results?: { videoId: string }[]
  message?: string
  error?: string
}

describe('GET /api/search (Search YouTube)', () => {
  it('rejects queries shorter than 2 characters', async () => {
    expect((await get('')).status).toBe(400)
    expect((await get('q')).status).toBe(400)
    expect((await get('   ')).status).toBe(400)
  })

  it('answers the no-key stand-in with the SPEC message instead of failing', async () => {
    const response = await get('Get Lucky')
    expect(response.status).toBe(200)
    const body = (await response.json()) as SearchResponse
    expect(body.results).toEqual([])
    expect(body.message).toBe(SEARCH_OFF_MESSAGE)
  })

  it('returns 10 results with a message absent on success', async () => {
    process.env.YOUTUBE_API_KEY = 'test-key'
    const response = await get('Get Lucky')
    expect(response.status).toBe(200)
    const body = (await response.json()) as SearchResponse
    expect(body.results).toHaveLength(10)
    expect(body.results?.[0]?.videoId).toBe('GetLuckyF01')
    expect(body.message).toBeUndefined()
  })

  it('surfaces the quota message without failing the request', async () => {
    process.env.YOUTUBE_API_KEY = 'test-key'
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/search', () =>
        HttpResponse.json(
          { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } },
          { status: 403 },
        ),
      ),
    )
    const response = await get('Get Lucky')
    expect(response.status).toBe(200)
    const body = (await response.json()) as SearchResponse
    expect(body.results).toEqual([])
    expect(body.message).toBe(SEARCH_QUOTA_MESSAGE)
    server.resetHandlers()
  })

  it('returns 502 when the upstream call fails for another reason', async () => {
    process.env.YOUTUBE_API_KEY = 'test-key'
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/search', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    const response = await get('Get Lucky')
    expect(response.status).toBe(502)
    const body = (await response.json()) as SearchResponse
    expect(body.error).toBe('Could not search YouTube')
    server.resetHandlers()
  })
})
