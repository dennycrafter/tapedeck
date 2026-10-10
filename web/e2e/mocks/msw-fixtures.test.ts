import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startTestMocks, stopTestMocks } from './server'

// Captured before any MSW interception so the gate test can prove fetch is
// left untouched when TAPEDECK_TEST is not set.
const originalFetch = globalThis.fetch

describe('registration gate (SPEC 4.1: mocks only under TAPEDECK_TEST)', () => {
  it('does not register handlers when TAPEDECK_TEST is not "1"', () => {
    stopTestMocks()
    const previous = process.env.TAPEDECK_TEST
    delete process.env.TAPEDECK_TEST
    try {
      expect(startTestMocks()).toBe(false)
      expect(globalThis.fetch).toBe(originalFetch)
    } finally {
      if (previous === undefined) delete process.env.TAPEDECK_TEST
      else process.env.TAPEDECK_TEST = previous
    }
  })
})

describe('external calls resolve from fixtures', () => {
  beforeAll(() => {
    process.env.TAPEDECK_TEST = '1'
    expect(startTestMocks({ onUnhandledRequest: 'error' })).toBe(true)
  })

  afterAll(() => {
    stopTestMocks()
    delete process.env.TAPEDECK_TEST
  })

  it('is idempotent while running', () => {
    expect(startTestMocks({ onUnhandledRequest: 'error' })).toBe(true)
  })

  it('serves YouTube Data API videos.list from the recorded fixture', async () => {
    const response = await fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=jNQXAC9IVRw&key=test-key',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.kind).toBe('youtube#videoListResponse')
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe('jNQXAC9IVRw')
    expect(body.items[0].snippet.title).toBe('Me at the zoo')
    expect(body.items[0].snippet.channelTitle).toBe('jawed')
    expect(body.items[0].snippet.thumbnails.high.url).toBe(
      'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
    )
    expect(body.items[0].contentDetails.duration).toBe('PT19S')
  })

  it('omits unknown ids from videos.list items', async () => {
    const response = await fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=aaaaaaaaaaa,jNQXAC9IVRw&key=test-key',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe('jNQXAC9IVRw')
  })

  it('serves YouTube oEmbed from the recorded fixture', async () => {
    const response = await fetch(
      'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&format=json',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.title).toBe('Me at the zoo')
    expect(body.author_name).toBe('jawed')
    expect(body.thumbnail_url).toBe('https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg')
  })

  it('returns the recorded 404 for an unrecorded oEmbed video', async () => {
    const response = await fetch(
      'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D00000000000&format=json',
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })

  it('serves YouTube Data API search.list from the recorded fixture', async () => {
    const response = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=me%20at%20the%20zoo&key=test-key',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id.videoId).toBe('jNQXAC9IVRw')
  })

  it('returns an empty result set for unrecorded search queries', async () => {
    const response = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=nothing%20matches%20this&key=test-key',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items).toEqual([])
  })

  it('serves the iTunes Search API from the recorded fixture', async () => {
    const response = await fetch(
      'https://itunes.apple.com/search?term=daft%20punk%20get%20lucky&entity=song&limit=5&country=US',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.resultCount).toBe(5)
    expect(body.results[0].trackName).toBe('Get Lucky')
    expect(body.results[0].artistName).toBe('Daft Punk, Pharrell Williams & Nile Rodgers')
    expect(body.results[0].collectionName).toBe('Random Access Memories')
    expect(body.results[0].artworkUrl100).toContain('100x100bb.jpg')
  })

  it('returns the recorded empty response for unrecorded iTunes terms', async () => {
    const response = await fetch(
      'https://itunes.apple.com/search?term=zzqx%20no%20such%20song%20xyz&entity=song&limit=5&country=US',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.resultCount).toBe(0)
    expect(body.results).toEqual([])
  })

  it('serves Deezer lookups from the recorded fixture for the strict query form', async () => {
    const response = await fetch(
      `https://api.deezer.com/search?q=${encodeURIComponent('artist:"Daft Punk" track:"Get Lucky"')}&limit=5`,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data[0].artist.name).toBe('Daft Punk')
    expect(body.data[0].title).toContain('Get Lucky')
    expect(body.data[0].album.cover_xl).toBeTruthy()
  })

  it('serves the Anthropic cleanup response from the recorded fixture', async () => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 300,
        temperature: 0,
        system: 'You clean music metadata for a personal music library.',
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              raw_title: 'Me at the zoo',
              raw_artist: 'jawed',
              description_300: '',
            }),
          },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.type).toBe('message')
    const cleanup = JSON.parse(body.content[0].text)
    expect(cleanup.title).toBe('Me at the zoo')
    expect(cleanup.artist).toBe('jawed')
    expect(cleanup.is_music).toBe(false)
    expect(cleanup.confidence).toBeGreaterThanOrEqual(0.5)
  })
})
