// Unit tests for /api/cron/keepalive (SPEC 7.8, T0 step 7; the T0 check:
// "without bearer = 401, with bearer = 200").
//
// The db seam is mocked by exact specifier like the health route tests — the
// route's contract here is "one select on settings", not driver behavior
// (PGlite/Postgres drivers are covered by lib/db's own tests). The real
// constantTimeEqual from login/session runs: the bearer check is exactly what
// is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const mocks = vi.hoisted(() => ({
  sqlMock: vi.fn(),
}))

vi.mock('../../../../lib/db', () => ({ sql: mocks.sqlMock }))

// Shape matches the SPEC's 64-hex CRON_SECRET; the value itself is arbitrary.
const SECRET = '98b4a0fa034a44303ad1c30a5c52a45ea2096a94b69b7133880830d604a3654c'

function cronRequest(authorization?: string): Request {
  return new Request('https://tapedeck.example.com/api/cron/keepalive', {
    headers: authorization ? { authorization } : {},
  })
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  mocks.sqlMock.mockReset()
  mocks.sqlMock.mockImplementation(async () => [{ id: 1 }])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/cron/keepalive', () => {
  it('returns 401 without an Authorization header and never touches the database', async () => {
    const response = await GET(cronRequest())
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mocks.sqlMock).not.toHaveBeenCalled()
  })

  it('returns 401 for a wrong bearer token', async () => {
    const wrong = '0'.repeat(64)
    const response = await GET(cronRequest(`Bearer ${wrong}`))
    expect(response.status).toBe(401)
    expect(mocks.sqlMock).not.toHaveBeenCalled()
  })

  it('returns 401 for a non-Bearer scheme or malformed header', async () => {
    for (const header of [`Basic ${SECRET}`, SECRET, `Bearer  ${SECRET}`, `bearer ${SECRET}`]) {
      const response = await GET(cronRequest(header))
      expect(response.status).toBe(401)
    }
    expect(mocks.sqlMock).not.toHaveBeenCalled()
  })

  it('fails closed with 401 when CRON_SECRET is not configured', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const response = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(response.status).toBe(401)
    expect(mocks.sqlMock).not.toHaveBeenCalled()
  })

  it('returns 200 and runs one select on settings with the exact bearer', async () => {
    const response = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.sqlMock).toHaveBeenCalledTimes(1)
    // The tagged template's text — one query against the settings table.
    const [strings] = mocks.sqlMock.mock.calls[0] as unknown as [TemplateStringsArray]
    expect(strings.join('?')).toContain('settings')
  })

  it('returns 500 when the settings select fails instead of swallowing the error', async () => {
    mocks.sqlMock.mockImplementation(async () => {
      throw new Error('database gone')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await GET(cronRequest(`Bearer ${SECRET}`))
      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: 'Keepalive failed' })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
