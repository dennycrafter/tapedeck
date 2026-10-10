import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { HttpError, httpJson } from './http'

const server = setupServer()

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('httpJson', () => {
  it('returns parsed JSON when MSW intercepts the request', async () => {
    let interceptedUrl: string | undefined
    server.use(
      http.get('https://itunes.example/search', ({ request }) => {
        interceptedUrl = request.url
        return HttpResponse.json({ results: [{ trackName: 'Get Lucky' }] })
      }),
    )

    const data = await httpJson<{ results: Array<{ trackName: string }> }>(
      'https://itunes.example/search?term=daft+punk',
    )

    expect(interceptedUrl).toBe('https://itunes.example/search?term=daft+punk')
    expect(data.results[0].trackName).toBe('Get Lucky')
  })

  it('forwards method, headers and body (Anthropic-style POST)', async () => {
    let captured: Request | undefined
    server.use(
      http.post('https://anthropic.example/v1/messages', async ({ request }) => {
        captured = request
        return HttpResponse.json({ content: [{ text: '{"title":"Daft Punk"}' }] })
      }),
    )

    const data = await httpJson<{ content: Array<{ text: string }> }>(
      'https://anthropic.example/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-haiku-5-5' }),
      },
    )

    expect(captured?.method).toBe('POST')
    expect(captured?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(await captured?.json()).toEqual({ model: 'claude-haiku-5-5' })
    expect(data.content[0].text).toBe('{"title":"Daft Punk"}')
  })

  it('normalizes non-2xx responses into HttpError kind "status"', async () => {
    server.use(
      http.get('https://deezer.example/search', () =>
        HttpResponse.json({ error: 'quota exceeded' }, { status: 429 }),
      ),
    )

    const promise = httpJson('https://deezer.example/search?q=x')
    await expect(promise).rejects.toBeInstanceOf(HttpError)
    await expect(promise).rejects.toMatchObject({
      kind: 'status',
      status: 429,
      bodyExcerpt: expect.stringContaining('quota exceeded'),
    })
  })

  it('normalizes timeouts into HttpError kind "timeout"', async () => {
    server.use(
      http.get('https://slow.example/api', async () => {
        await delay('infinite') // hold the request past the wrapper timeout
        return HttpResponse.json({})
      }),
    )

    const promise = httpJson('https://slow.example/api', { timeoutMs: 25 })
    await expect(promise).rejects.toBeInstanceOf(HttpError)
    await expect(promise).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('normalizes malformed bodies into HttpError kind "parse"', async () => {
    server.use(
      http.get('https://broken.example/api', () => new Response('<html>oops</html>')),
    )

    const promise = httpJson('https://broken.example/api')
    await expect(promise).rejects.toBeInstanceOf(HttpError)
    await expect(promise).rejects.toMatchObject({ kind: 'parse', bodyExcerpt: '<html>oops</html>' })
  })

  it('normalizes connection failures into HttpError kind "network"', async () => {
    server.use(http.get('http://unreachable.example/api', () => HttpResponse.error()))
    const promise = httpJson('http://unreachable.example/api')
    await expect(promise).rejects.toBeInstanceOf(HttpError)
    await expect(promise).rejects.toMatchObject({ kind: 'network' })
  })
})
