// /api/health (SPEC T0 step 6): one value per service, each "OK" (check
// passed against the real service), "STAND-IN" (local driver in use and its
// probe passed, 4.1), "NOT_SET" (the service's key is missing), or the error
// text. The SPEC lists six check items; the sixth names two services
// (itunes and deezer), so the response carries seven keys:
//
//   { database, storage, youtube, soundcloud, anthropic, itunes, deezer }
//
// Password protection lives in middleware (8.1): API routes without a valid
// session cookie get 401 there, so this handler never sees one. It must also
// never be cached; reading `request` keeps the handler per-request (Next 16
// Cache Components removes the `dynamic` segment config).

import { sql } from '../../../lib/db'
import { storage } from '../../../lib/storage'
import { httpResponse } from '../../../lib/http'

// Local probes fail fast instead of holding the response for the wrapper's
// 10s default.
const PROBE_TIMEOUT_MS = 5000

// "Me at the zoo", the first YouTube video - stable, and exactly the id the
// SPEC names for the probe (1 quota unit with part=id).
const YOUTUBE_PROBE_VIDEO_ID = 'jNQXAC9IVRw'

// Public track, stable for years (it is SoundCloud's own API example).
const SOUNDCLOUD_PROBE_TRACK_URL = 'https://soundcloud.com/forss/flickermood'

// The SPEC's cover-art probe query for itunes and deezer.
const COVER_PROBE_QUERY = 'daft punk get lucky'

// web/lib/http.ts is the one wrapper for outbound HTTP (4.1); it rejects
// non-2xx, timeout and network failures with a normalized HttpError, which
// `settled` turns into the error text reported for that service.
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.slice(0, 300)
}

async function settled(probe: () => Promise<string>): Promise<string> {
  try {
    return await probe()
  } catch (err) {
    return errorText(err)
  }
}

// The 4.1 stand-in selection restated: PGlite when TAPEDECK_TEST=1 (in-memory)
// or when DATABASE_URL is missing (development only - production builds never
// fall back to stand-ins, they show the Setup page instead).
function databaseIsLocal(): boolean {
  return process.env.TAPEDECK_TEST === '1' || !process.env.DATABASE_URL
}

function storageIsLocal(): boolean {
  if (process.env.TAPEDECK_TEST === '1') return true
  return !(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  )
}

async function checkDatabase(): Promise<string> {
  // "select settings" (T0 step 6). db.ts applies the schema itself in dev and
  // test; in production "Finish setup" created it.
  await sql`select id from settings limit 1`
  return databaseIsLocal() ? 'STAND-IN' : 'OK'
}

async function cleanupProbeKey(key: string): Promise<void> {
  // Used only after a probe step already failed: the probe error is what gets
  // reported, so a failing cleanup must not mask it.
  try {
    await storage.delete(key)
  } catch {
    // keep the probe error
  }
}

async function checkLocalStorage(origin: string): Promise<string> {
  // Local driver (4.1): prove write/read/delete of a tiny file through the
  // adapter's signed-URL surface - uploadUrl -> PUT, downloadUrl -> GET,
  // then delete(key). The signed round trip also exercises the signature
  // machinery the whole local driver depends on.
  const key = `health-probe/${crypto.randomUUID()}`
  const payload = 'tapedeck-health-probe'
  try {
    const putUrl = new URL(storage.uploadUrl(key), origin).toString()
    await httpResponse(putUrl, { method: 'PUT', body: payload, timeoutMs: PROBE_TIMEOUT_MS })

    const getUrl = new URL(storage.downloadUrl(key), origin).toString()
    const get = await httpResponse(getUrl, { timeoutMs: PROBE_TIMEOUT_MS })
    if ((await get.text()) !== payload) {
      return 'local storage readback did not match what was written'
    }
  } catch (err) {
    await cleanupProbeKey(key)
    return errorText(err)
  }
  // Round trip passed: a failing delete is a real storage fault, not noise.
  await storage.delete(key)
  return 'STAND-IN'
}

async function checkR2Storage(): Promise<string> {
  // R2 (7.2): probe through the adapter's head(), never a direct S3 client.
  // Through HeadObject a missing probe key and a missing bucket are both 404,
  // so a not-found still proves the bucket is reachable and the credentials
  // work; only other statuses are failures.
  try {
    await storage.head('health-probe/tapedeck')
    return 'OK'
  } catch (err) {
    const status =
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ??
      (err as { status?: number }).status
    if (status === 404 || (err as { name?: string }).name === 'NotFound') return 'OK'
    return errorText(err)
  }
}

function checkStorage(origin: string): Promise<string> {
  return storageIsLocal() ? checkLocalStorage(origin) : checkR2Storage()
}

function checkYoutube(apiKey: string | undefined): Promise<string> {
  if (!apiKey) return Promise.resolve('NOT_SET')
  return settled(async () => {
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=id&id=${YOUTUBE_PROBE_VIDEO_ID}` +
      `&key=${encodeURIComponent(apiKey)}`
    await httpResponse(url, { timeoutMs: PROBE_TIMEOUT_MS })
    return 'OK'
  })
}

function checkSoundcloud(): Promise<string> {
  return settled(async () => {
    const url = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(SOUNDCLOUD_PROBE_TRACK_URL)}`
    await httpResponse(url, { timeoutMs: PROBE_TIMEOUT_MS })
    return 'OK'
  })
}

function checkAnthropic(apiKey: string | undefined): Promise<string> {
  if (!apiKey) return Promise.resolve('NOT_SET')
  return settled(async () => {
    // GET /v1/models with the 7.5 header set.
    await httpResponse('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    return 'OK'
  })
}

function checkItunes(): Promise<string> {
  return settled(async () => {
    const url =
      `https://itunes.apple.com/search?term=${encodeURIComponent(COVER_PROBE_QUERY)}` +
      '&entity=song&limit=5&country=US'
    await httpResponse(url, { timeoutMs: PROBE_TIMEOUT_MS })
    return 'OK'
  })
}

function checkDeezer(): Promise<string> {
  return settled(async () => {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(COVER_PROBE_QUERY)}&limit=5`
    await httpResponse(url, { timeoutMs: PROBE_TIMEOUT_MS })
    return 'OK'
  })
}

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin
  const [database, storageCheck, youtube, soundcloud, anthropic, itunes, deezer] =
    await Promise.all([
      settled(checkDatabase),
      checkStorage(origin),
      checkYoutube(process.env.YOUTUBE_API_KEY),
      checkSoundcloud(),
      checkAnthropic(process.env.ANTHROPIC_API_KEY),
      checkItunes(),
      checkDeezer(),
    ])
  return Response.json({ database, storage: storageCheck, youtube, soundcloud, anthropic, itunes, deezer })
}
