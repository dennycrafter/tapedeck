// Unit tests for /api/health (SPEC T0 step 6).
//
// All four adapter seams are mocked by exact specifier:
// - the `sql` tagged template from lib/db
// - the getStorage() facade (driverName/uploadUrl/downloadUrl/head/delete)
//   from lib/storage
// - httpResponse from lib/http (mocked so no unit test touches the network;
//   non-2xx/timeout failures are simulated by rejecting it like the real
//   wrapper does)
// - the local-storage route's PUT handler, which the health route dispatches
//   the local upload probe to in-process (mocked here; the route's own tests
//   cover it against the real signature machinery)
//
// Assertions go through the hoisted mock handles. The only static import from
// the mocked modules is the type-only StorageDriver, which is erased before
// the mock factory runs.
//
// Note on "six checks": SPEC T0 step 6 lists six check items, and the sixth
// names two services (itunes and deezer), so the response carries seven keys.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'
import { httpResponse } from '../../../lib/http'
import { PUT as localStoragePut } from '../local-storage/[...key]/route'
import type { StorageDriver } from '../../../lib/storage'

const mocks = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  getStorageMock: vi.fn(),
  uploadUrlMock: vi.fn(),
  downloadUrlMock: vi.fn(),
  headMock: vi.fn(),
  deleteMock: vi.fn(),
  httpResponseMock: vi.fn(),
  localStoragePutMock: vi.fn(),
}))

vi.mock('../../../lib/db', () => ({ sql: mocks.sqlMock }))

vi.mock('../../../lib/storage', () => ({ getStorage: mocks.getStorageMock }))

vi.mock('../../../lib/http', () => ({ httpResponse: mocks.httpResponseMock }))

vi.mock('../local-storage/[...key]/route', () => ({ PUT: mocks.localStoragePutMock }))

const PROBE_PAYLOAD = 'tapedeck-health-probe'

// Builds the mocked StorageDriver handed back by getStorage(); tests pass
// 'r2' to exercise the facade's real-driver path. setCors is a no-op: the
// route probes through uploadUrl/head/delete and the in-process PUT dispatch
// only.
function fakeDriver(driverName: StorageDriver['driverName'] = 'local'): StorageDriver {
  return {
    driverName,
    uploadUrl: mocks.uploadUrlMock,
    downloadUrl: mocks.downloadUrlMock,
    head: mocks.headMock,
    delete: mocks.deleteMock,
    setCors: async () => {},
  }
}

beforeEach(() => {
  mocks.sqlMock.mockImplementation(async () => [{ id: 1 }])
  mocks.getStorageMock.mockImplementation(() => fakeDriver())
  // Async URL builders and the { exists, bytes } head result mirror the real
  // driver contract (the route awaits both).
  mocks.uploadUrlMock.mockImplementation(
    async (key: string) => `/api/local-storage/${key}?exp=4102444800&sig=test`,
  )
  mocks.downloadUrlMock.mockImplementation(
    async (key: string) => `/api/local-storage/${key}?exp=4102444800&sig=test`,
  )
  mocks.headMock.mockResolvedValue({ exists: true, bytes: PROBE_PAYLOAD.length })
  mocks.deleteMock.mockResolvedValue(undefined)
  // 2xx with the probe payload as body: enough for every check to pass.
  mocks.httpResponseMock.mockImplementation(async () => new Response(PROBE_PAYLOAD))
  // The local-storage route accepts the in-process upload probe by default.
  mocks.localStoragePutMock.mockResolvedValue(new Response(null, { status: 200 }))

  vi.stubEnv('TAPEDECK_TEST', '1')
  // Empty string behaves as unset for every env read in the route.
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('YOUTUBE_API_KEY', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
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

  it('proves the local storage stand-in with an in-process signed-URL round trip: upload probe, head, delete', async () => {
    const body = await getHealthBody()

    expect(body.storage).toBe('STAND-IN')

    // Upload probe: the driver's signed PUT URL, dispatched through the
    // local-storage route handler in-process.
    const [putRequest, putContext] = vi.mocked(localStoragePut).mock.calls[0]
    expect(putRequest).toBeInstanceOf(Request)
    expect(putRequest.method).toBe('PUT')
    expect(putRequest.url).toContain('/api/local-storage/health-probe/')
    expect(await putRequest.text()).toBe(PROBE_PAYLOAD)
    expect((await putContext.params).key?.[0]).toBe('health-probe')

    // Read side and cleanup run through the driver itself.
    expect(mocks.headMock).toHaveBeenCalledWith(expect.stringMatching(/^health-probe\//))
    expect(mocks.deleteMock).toHaveBeenCalledWith(expect.stringMatching(/^health-probe\//))

    // No server-side self-fetch: the signed URL never goes back over the wire
    // (the harness TLS is self-signed and cannot be verified server-side).
    const httpUrls = vi.mocked(httpResponse).mock.calls.map(([url]) => String(url))
    expect(httpUrls.some((url) => url.includes('/api/local-storage/'))).toBe(false)
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
    // Driver selection is the facade's job (mocked here), so "configured"
    // means the facade hands back the r2 driver; the DATABASE_URL stub drives
    // the route's own databaseIsLocal() label.
    vi.stubEnv('TAPEDECK_TEST', '')
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:6543/postgres')
    mocks.getStorageMock.mockImplementation(() => fakeDriver('r2'))

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

  it('reports the error and cleans up when the local storage upload probe fails', async () => {
    vi.mocked(localStoragePut).mockRejectedValue(new Error('HTTP 500 calling local storage'))

    const body = await getHealthBody()

    expect(body.storage).toBe('HTTP 500 calling local storage')
    expect(mocks.deleteMock).toHaveBeenCalledWith(
      expect.stringMatching(/^health-probe\//),
    )
  })

  it('reports the reason when the local-storage route rejects the probe upload', async () => {
    vi.mocked(localStoragePut).mockResolvedValue(
      new Response('forbidden: expired signature', { status: 403 }),
    )

    const body = await getHealthBody()

    expect(body.storage).toBe('local storage PUT probe returned 403: forbidden: expired signature')
  })

  it('reports the probe failure when the uploaded object cannot be found again', async () => {
    mocks.headMock.mockResolvedValue({ exists: false })

    const body = await getHealthBody()

    expect(body.storage).toBe('local storage probe object missing after upload')
  })

  it('reports the probe failure when the stored object has the wrong size', async () => {
    mocks.headMock.mockResolvedValue({ exists: true, bytes: PROBE_PAYLOAD.length + 1 })

    const body = await getHealthBody()

    expect(body.storage).toBe('local storage probe object has the wrong size')
  })
})
