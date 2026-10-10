// Local storage stand-in route (SPEC 4.1). Serves the files written to
// web/.data/storage by the local driver through HMAC-signed URLs:
//   /api/local-storage/<key>?exp=<unix>&sig=<HMAC-SHA256(key+exp, SESSION_SECRET)>
// GET supports Range (206) and ?download=1 attachment disposition; PUT stores
// bytes (the downloader's presigned-PUT stand-in). Bad, malformed or expired
// signatures are rejected with 403. The route is a development/test stand-in:
// it 404s whenever the local driver is disabled (R2 active or a production
// build, SPEC 4.1).
import { open, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import * as nodePath from 'node:path'
import {
  asciiSafeFilename,
  contentTypeForKey,
  localKeyPath,
  localSignature,
  localStorageConfig,
  parseRange,
} from '../../../../lib/storage'

type RouteContext = { params: Promise<{ key?: string[] }> }

const SIG_PATTERN = /^[0-9a-f]{64}$/i

function notFound(reason: string): Response {
  return new Response(reason, { status: 404 })
}

function forbidden(reason: string): Response {
  return new Response(`forbidden: ${reason}`, { status: 403 })
}

/**
 * Returns a rejection reason when the request's signature is missing,
 * malformed, does not match the key, or has expired; null when authorized.
 * The signature message is `key + exp` exactly as SPEC 4.1 defines it.
 */
function signatureRejection(url: URL, key: string[], secret: string): string | null {
  const expRaw = url.searchParams.get('exp')
  const sig = url.searchParams.get('sig')
  if (!expRaw || !sig) return 'missing exp or sig parameter'
  const exp = Number(expRaw)
  if (!Number.isInteger(exp) || exp < 0) return 'malformed exp parameter'
  if (exp <= Math.floor(Date.now() / 1000)) return 'expired signature'
  if (!SIG_PATTERN.test(sig)) return 'malformed sig parameter'
  const expected = localSignature(key.join('/'), exp, secret)
  const provided = Buffer.from(sig, 'hex')
  const wanted = Buffer.from(expected, 'hex')
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return 'invalid signature'
  return null
}

/** Content-Disposition when the URL asks for a download (?download=1&name=…). */
function contentDisposition(url: URL, key: string[]): string | null {
  if (url.searchParams.get('download') !== '1') return null
  const requested = url.searchParams.get('name') || key[key.length - 1] || 'download'
  // Re-sanitize even though the driver already did: the name parameter is not
  // covered by the signature, and this lands in a response header.
  return `attachment; filename="${asciiSafeFilename(requested)}"`
}

async function readSlice(filePath: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    return buf
  } finally {
    await handle.close()
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const config = localStorageConfig()
  if (!config) return notFound('local storage stand-in is disabled')
  const { key } = await context.params
  const segments = key ?? []

  const rejection = signatureRejection(new URL(request.url), segments, config.secret)
  if (rejection) return forbidden(rejection)

  const filePath = localKeyPath(config.baseDir, segments)
  if (!filePath) return notFound('no such object')

  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    return notFound('no such object')
  }

  const headers = new Headers({ 'Content-Type': contentTypeForKey(segments.join('/')), 'Accept-Ranges': 'bytes' })
  const disposition = contentDisposition(new URL(request.url), segments)
  if (disposition) headers.set('Content-Disposition', disposition)

  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    })
  }
  if (range) {
    const length = range.end - range.start + 1
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    headers.set('Content-Length', String(length))
    const slice = new Uint8Array(await readSlice(filePath, range.start, length))
    return new Response(slice, { status: 206, headers })
  }

  headers.set('Content-Length', String(size))
  // Buffer is not in this config's BodyInit union; Uint8Array is the same bytes.
  const file = new Uint8Array(await readFile(filePath))
  return new Response(file, { status: 200, headers })
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const config = localStorageConfig()
  if (!config) return notFound('local storage stand-in is disabled')
  const { key } = await context.params
  const segments = key ?? []

  const rejection = signatureRejection(new URL(request.url), segments, config.secret)
  if (rejection) return forbidden(rejection)

  const filePath = localKeyPath(config.baseDir, segments)
  if (!filePath) return notFound('no such object')

  const body = Buffer.from(await request.arrayBuffer())
  await mkdir(nodePath.dirname(filePath), { recursive: true })
  await writeFile(filePath, body)
  return new Response(null, { status: 200 })
}
