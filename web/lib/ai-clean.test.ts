/**
 * Unit tests for the AI cleanup step (SPEC 8.4 step 2, 7.5). Request shape
 * and reply parsing run against the recorded T0 fixtures through MSW (9.0),
 * with local overrides for the failure and gate cases.
 */

import { http, HttpResponse } from 'msw'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { server, startTestMocks, stopTestMocks } from '../e2e/mocks/server'
import aiFixture from '../e2e/fixtures/anthropic-messages.json'
import { AI_CONFIDENCE_GATE, aiCleanTitle, parseAiReply, stripCodeFences } from './ai-clean'

beforeAll(() => {
  process.env.TAPEDECK_TEST = '1'
  expect(startTestMocks({ onUnhandledRequest: 'error' })).toBe(true)
})

afterAll(() => {
  stopTestMocks()
  delete process.env.TAPEDECK_TEST
})

const KEY = 'sk-ant-test-key'

/** Build an Anthropic-shaped response body whose content[0].text is `reply`. */
function anthropicBody(reply: string) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: reply }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 84, output_tokens: 42 },
  }
}

function replyFor(title: string, artist: string, isMusic: boolean, confidence: number): string {
  return JSON.stringify({ title, artist, is_music: isMusic, confidence })
}

function overrideReply(reply: unknown, status = 200) {
  server.use(
    http.post('https://api.anthropic.com/v1/messages', () =>
      typeof reply === 'string'
        ? new HttpResponse(reply, { status, headers: { 'content-type': 'application/json' } })
        : HttpResponse.json(reply as object, { status }),
    ),
  )
}

describe('parseAiReply (SPEC 7.5 reply parsing)', () => {
  it('parses the documented reply shape', () => {
    expect(parseAiReply(replyFor('Get Lucky', 'Daft Punk', true, 0.9))).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
      isMusic: true,
      confidence: 0.9,
    })
  })

  it('strips code fences before parsing (SPEC 7.5)', () => {
    const fenced = '```json\n{"title":"Get Lucky","artist":"Daft Punk","is_music":true,"confidence":0.9}\n```'
    expect(parseAiReply(fenced)).toMatchObject({ title: 'Get Lucky', artist: 'Daft Punk' })
  })

  it('unwraps a reply that arrives as a quoted JSON string ("no quotes")', () => {
    const wrapped = JSON.stringify(replyFor('Get Lucky', 'Daft Punk', true, 0.9))
    expect(parseAiReply(wrapped)).toMatchObject({ title: 'Get Lucky' })
  })

  it('trims whitespace around fields', () => {
    expect(parseAiReply('{"title":"  Get Lucky  ","artist":" Daft Punk ","is_music":true,"confidence":0.9}')).toMatchObject({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
  })

  it('rejects empty title or artist so the model never invents text', () => {
    expect(parseAiReply('{"title":"","artist":"Daft Punk","is_music":true,"confidence":0.9}')).toBeNull()
    expect(parseAiReply('{"title":"Get Lucky","artist":"","is_music":true,"confidence":0.9}')).toBeNull()
    expect(parseAiReply('{"title":"   ","artist":"Daft Punk","is_music":true,"confidence":0.9}')).toBeNull()
  })

  it('rejects missing or non-boolean is_music and non-numeric confidence', () => {
    expect(parseAiReply('{"title":"T","artist":"A","confidence":0.9}')).toBeNull()
    expect(parseAiReply('{"title":"T","artist":"A","is_music":"yes","confidence":0.9}')).toBeNull()
    expect(parseAiReply('{"title":"T","artist":"A","is_music":true,"confidence":"0.9"}')).toBeNull()
  })

  it('rejects confidence outside 0 to 1', () => {
    expect(parseAiReply(replyFor('T', 'A', true, 1.5))).toBeNull()
    expect(parseAiReply(replyFor('T', 'A', true, -0.1))).toBeNull()
  })

  it('rejects prose-only replies, arrays and empty text', () => {
    expect(parseAiReply('I cannot help with that.')).toBeNull()
    expect(parseAiReply('[{"title":"T"}]')).toBeNull()
    expect(parseAiReply('')).toBeNull()
    expect(parseAiReply('```json\n```')).toBeNull()
  })
})

describe('stripCodeFences', () => {
  it('drops fence lines wherever they appear and trims', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripCodeFences('```json\n{"a":1}\n```\n')).toBe('{"a":1}')
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}')
  })
})

describe('aiCleanTitle (SPEC 7.5 request, 8.4 step 2)', () => {
  it('returns null before any request when no key is set', async () => {
    const handler = vi.fn()
    server.use(http.post('https://api.anthropic.com/v1/messages', handler))
    await expect(aiCleanTitle({ rawTitle: 'T', rawArtist: 'A', description: '' }, undefined)).resolves.toBeNull()
    expect(handler).not.toHaveBeenCalled()
  })

  it('sends the SPEC 7.5 request shape', async () => {
    let seen: { headers: Headers; body: Record<string, unknown> } | undefined
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        seen = { headers: request.headers, body: (await request.json()) as Record<string, unknown> }
        return HttpResponse.json(anthropicBody(replyFor('Clean', 'Artist', true, 0.9)))
      }),
    )
    await aiCleanTitle({ rawTitle: 'Raw', rawArtist: 'Raw Artist', description: 'Desc' }, KEY)
    expect(seen).toBeDefined()
    if (!seen) return
    expect(seen.headers.get('x-api-key')).toBe(KEY)
    expect(seen.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(seen.body.model).toBe('claude-haiku-5-5')
    expect(seen.body.max_tokens).toBe(300)
    expect(seen.body.temperature).toBe(0)
    expect(typeof seen.body.system).toBe('string')
    expect(seen.body.system).toContain('You clean music metadata for a personal music library.')
    expect(seen.body.messages).toEqual([
      { role: 'user', content: JSON.stringify({ raw_title: 'Raw', raw_artist: 'Raw Artist', description: 'Desc' }) },
    ])
  })

  it('resolves the parsed reply for a recorded fixture', async () => {
    // The recorded fixture (e2e/fixtures/anthropic-messages.json) is the
    // "Me at the zoo" exchange: non-music, high confidence.
    const fixture = (aiFixture as unknown as Record<string, { content: { text: string }[] }>).default
    server.use(http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.json(fixture)))
    const result = await aiCleanTitle({ rawTitle: 'Me at the zoo', rawArtist: 'jawed', description: '' }, KEY)
    expect(result).toMatchObject({ title: 'Me at the zoo', artist: 'jawed', isMusic: false, confidence: 0.95 })
  })

  it('resolves null on an HTTP error and never throws', async () => {
    overrideReply('rate limited', 429)
    await expect(aiCleanTitle({ rawTitle: 'T', rawArtist: 'A', description: '' }, KEY)).resolves.toBeNull()
  })

  it('resolves null when the body is not JSON', async () => {
    server.use(
      http.post('https://api.anthropic.com/v1/messages', () => new HttpResponse('<html>oops</html>', { status: 200 })),
    )
    await expect(aiCleanTitle({ rawTitle: 'T', rawArtist: 'A', description: '' }, KEY)).resolves.toBeNull()
  })

  it('resolves null when the reply has no text content', async () => {
    server.use(
      http.post('https://api.anthropic.com/v1/messages', () =>
        HttpResponse.json({ content: [{ type: 'tool_use', id: 'x' }] }),
      ),
    )
    await expect(aiCleanTitle({ rawTitle: 'T', rawArtist: 'A', description: '' }, KEY)).resolves.toBeNull()
  })

  it('resolves null when the model replies with unusable text', async () => {
    overrideReply(anthropicBody('Sorry, I do not know.'))
    await expect(aiCleanTitle({ rawTitle: 'T', rawArtist: 'A', description: '' }, KEY)).resolves.toBeNull()
  })
})

describe('AI_CONFIDENCE_GATE', () => {
  it('is the SPEC 8.4 threshold', () => {
    expect(AI_CONFIDENCE_GATE).toBe(0.5)
  })
})
