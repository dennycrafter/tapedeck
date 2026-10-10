// Unit tests for /api/health (SPEC T0 step 6).
//
// lib/http is real on this branch (its wrapper contract is pinned by these
// tests), but lib/db and lib/storage are sibling builders' files still to
// come. All three adapter seams are mocked by exact specifier:
// - the `sql` tagged template from lib/db
// - the storage facade (uploadUrl/downloadUrl/head/delete) from lib/storage
// - httpResponse from lib/http (mocked so no unit test touches the network;
//   non-2xx/timeout failures are simulated by rejecting it like the real
//   wrapper does)
//
// db and storage are NOT statically imported here: the files do not exist
// until their builder merges, and a static import of a missing module fails
// resolution before the mock factory can intercept it. Assertions go through
// the hoisted mock handles instead.
//
// Note on "six checks": SPEC T0 step 6 lists six check items, and the sixth
// names two services (itunes and deezer), so the response carries seven keys.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'
import { httpResponse } from '../../../lib/http'

const mocks = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  uploadUrlMock: vi.fn(),
  downloadUrlMock: vi.fn(),
  headMock: vi.fn(),
  deleteMock: vi.fn(),
  httpResponseMock: vi.fn(),
}))

vi.mock('../../../lib/db', () => ({ sql: mocks.sqlMock }))

vi.mock('../../../lib/storage', () => ({
  storage: {
    uploadUrl: mocks.uploadUrlMock,
    downloadUrl: mocks.downloadUrlMock,
    head: mocks.headMock,
    delete: mocks.deleteMock,
  },
}))

vi.mock('../../../lib/http', () => ({ httpResponse: mocks.httpResponseMock }))

const PROBE_PAYLOAD = 'tapedeck-health-probe'

beforeEach(() => {
  mocks.sqlMock.mockImplementation(async () => [{ id: 1 }])
  mocks.uploadUrlMock.mockImplementation(
    (key: string) => `/api/local-storage/${key}?exp=4102444800&sig=test`,
  )
  mocks.downloadUrlMock.mockImplementation(
    (key: string) => `/api/local-storage/${key}?exp=4102444800&sig=test`,
  )
  mocks.headMock.mockResolvedValue(undefined)
  mocks.deleteMock.mockResolvedValue(undefined)
  // 2xx with the probe payload as body: enough for every check to pass.
  mocks.httpResponseMock.mockImplementation(async () => new Response(PROBE_PAYLOAD))

  vi.stubEnv('TAPEDECK_TEST', '1')
  // Empty string behaves as unset for every env read in the route.
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('YOUTUBE_API_KEY', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('R2_ACCOUNT_ID', '')
  vi.stubEnv('R2_ACCESS_KEY_ID', '')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', '')
  vi.stubEnv('R2_BUCKET', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

async function getHealthBody(): Promise<Record<string, string>> {
  const res = await GET(new Request('http://localhost:3000/api/health'))
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, string>
}

describe('/api/health', () => {
  it('reports the SPEC six-check shape in TAPEDECK_TEST mode: STAND-IN for local drivers, NOT_SET for missing keys, OK for keyless services', async () => {
    const body = await getHealthBody()

    // Six check items, seven service keys (itunes and deezer share the sixth).
    expect(Object.keys(body).sort()).toEqual(
      ['anthropic', 'database', 'deezer', 'itunes', 'soundcloud', 'storage', 'youtube'],
    )

    expect(body.database).toBe('STAND-IN')
    expect(body.storage).toBe('STAND-IN')
    expect(body.youtube).toBe('NOT_SET')
    expect(body.anthropic).toBe('NOT_SET')
    expect(body.soundcloud).toBe('OK')
    expect(body.itunes).toBe('OK')
    expect(body.deezer).toBe('OK')
  })

  it('proves the local storage stand-in with a write/read/delete round trip through signed URLs', async () => {
    const body = await getHealthBody()

    expect(body.storage).toBe('STAND-IN')
    const putCall = vi
      .mocked(httpResponse)
      .mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(putCall?.[0]).toContain('/api/local-storage/health-probe/')
    expect(putCall?.[1]).toMatchObject({ method: 'PUT', body: PROBE_PAYLOAD })
    expect(mocks.deleteMock).toHaveBeenCalledWith(
      expect.stringMatching(/^health-probe\//),
    )
  })

  it('never calls keyed APIs when their keys are not set, but probes keyless services', async () => {
    await getHealthBody()

    const calledUrls = vi
      .mocked(httpResponse)
      .mock.calls.map(([url]) => String(url))
    expect(calledUrls.some((url) => url.includes('googleapis.com'))).toBe(false)
    expect(calledUrls.some((url) => url.includes('api.anthropic.com'))).toBe(false)
    expect(calledUrls.some((url) => url.includes('soundcloud.com/oembed'))).toBe(true)
    expect(calledUrls.some((url) => url.includes('itunes.apple.com/search'))).toBe(true)
    expect(calledUrls.some((url) => url.includes('api.deezer.com/search'))).toBe(true)
  })

  it('probes keyed services with the documented URLs and headers when keys are set', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', 'AIza-test-key')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key')

    const body = await getHealthBody()

    expect(body.youtube).toBe('OK')
    expect(body.anthropic).toBe('OK')

    const httpResponseMock = vi.mocked(httpResponse)
    const ytCall = httpResponseMock.mock.calls.find(([url]) =>
      String(url).includes('googleapis.com'),
    )
    expect(String(ytCall?.[0])).toContain('videos?part=id&id=jNQXAC9IVRw')
    const anthropicCall = httpResponseMock.mock.calls.find(([url]) =>
      String(url).includes('api.anthropic.com'),
    )
    expect(anthropicCall?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'x-api-key': 'sk-ant-test-key',
        'anthropic-version': '2023-06-01',
      }),
    })
  })

  it('reports OK for database and storage when the real drivers are configured', async () => {
    vi.stubEnv('TAPEDECK_TEST', '')
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:6543/postgres')
    vi.stubEnv('R2_ACCOUNT_ID', 'a'.repeat(32))
    vi.stubEnv('R2_ACCESS_KEY_ID', 'key-id')
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret')
    vi.stubEnv('R2_BUCKET', 'tapedeck-audio')

    const body = await getHealthBody()

    expect(body.database).toBe('OK')
    expect(body.storage).toBe('OK')
    expect(mocks.headMock).toHaveBeenCalledWith('health-probe/tapedeck')
  })

  it('reports the probe error as the value when a network check fails', async () => {
    vi.mocked(httpResponse).mockImplementation(async (url) => {
      if (String(url).includes('soundcloud.com')) throw new Error('boom')
      return new Response(PROBE_PAYLOAD)
    })

    const body = await getHealthBody()

    expect(body.soundcloud).toBe('boom')
    expect(body.itunes).toBe('OK')
  })

  it('reports the error and cleans up when the local storage write fails', async () => {
    vi.mocked(httpResponse).mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') throw new Error('HTTP 500 calling local storage')
      return new Response(PROBE_PAYLOAD)
    })

    const body = await getHealthBody()

    expect(body.storage).toBe('HTTP 500 calling local storage')
    expect(mocks.deleteMock).toHaveBeenCalledWith(
      expect.stringMatching(/^health-probe\//),
    )
  })
})
