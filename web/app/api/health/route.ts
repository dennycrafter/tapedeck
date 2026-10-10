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
import { getStorage, type StorageDriver } from '../../../lib/storage'
import { httpResponse } from '../../../lib/http'
// The local stand-in's signed-URL round trip is dispatched in-process through
// the local-storage route's PUT handler (see checkLocalStorage below).
import { PUT as localStoragePut } from '../local-storage/[...key]/route'

// Outbound service probes fail fast instead of holding the response for the
// wrapper's 10s default.
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

async function checkStorage(origin: string): Promise<string> {
  // The facade owns driver selection (4.1). It throws in a production build
  // without the R2 variables; the error text becomes this service's value so
  // the seven-key response shape always holds. driverName is the facade's
  // STAND-IN signal: local -> prove the driver, r2 -> reachability probe.
  let storage: StorageDriver
  try {
    storage = getStorage()
  } catch (err) {
    return errorText(err)
  }
  return storage.driverName === 'local' ? checkLocalStorage(storage, origin) : checkR2Storage(storage)
}

async function checkDatabase(): Promise<string> {
  // "select settings" (T0 step 6). db.ts applies the schema itself in dev and
  // test; in production "Finish setup" created it.
  await sql`select id from settings limit 1`
  return databaseIsLocal() ? 'STAND-IN' : 'OK'
}

async function cleanupProbeKey(storage: StorageDriver, key: string): Promise<void> {
  // Used only after a probe step already failed: the probe error is what gets
  // reported, so a failing cleanup must not mask it.
  try {
    await storage.delete(key)
  } catch {
    // keep the probe error
  }
}

async function checkLocalStorage(storage: StorageDriver, origin: string): Promise<string> {
  // Local driver (4.1): prove the signed-URL round trip - uploadUrl() mints
  // the signed PUT URL, the local-storage route consumes it, then head() and
  // delete() run on the driver itself. The route handler is called
  // IN-PROCESS, never fetched back over HTTP: the e2e harness serves
  // self-signed TLS (8.1 marks the session cookie Secure), which a
  // server-side self-fetch cannot verify. Calling the handler still exercises
  // the signature machinery the whole local driver depends on, end to end.
  const key = `health-probe/${crypto.randomUUID()}`
  const payload = new TextEncoder().encode('tapedeck-health-probe')
  try {
    // Upload probe through the adapter's signed-URL surface.
    const putUrl = new URL(await storage.uploadUrl(key), origin).toString()
    const put = await localStoragePut(new Request(putUrl, { method: 'PUT', body: payload }), {
      params: Promise.resolve({ key: key.split('/') }),
    })
    if (!put.ok) {
      const reason = (await put.text()).slice(0, 200)
      return `local storage PUT probe returned ${put.status}${reason ? `: ${reason}` : ''}`
    }

    // Read side through the driver: the probe object landed with the exact
    // byte count written above.
    const head = await storage.head(key)
    if (!head.exists) return 'local storage probe object missing after upload'
    if (head.bytes !== payload.byteLength) return 'local storage probe object has the wrong size'
  } catch (err) {
    await cleanupProbeKey(storage, key)
    return errorText(err)
  }
  // Round trip passed: a failing delete is a real storage fault, not noise.
  await storage.delete(key)
  return 'STAND-IN'
}

async function checkR2Storage(storage: StorageDriver): Promise<string> {
  // R2 (7.2): probe through the adapter's head(), never a direct S3 client.
  // head() folds a missing object (and a missing bucket) into its resolved
  // { exists: false } result, so any resolved answer proves the bucket is
  // reachable with working credentials; only a throw is a fault.
  try {
    await storage.head('health-probe/tapedeck')
    return 'OK'
  } catch (err) {
    return errorText(err)
  }
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
