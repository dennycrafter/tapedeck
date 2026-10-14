// Audio storage adapter (SPEC 4.1). Two drivers behind one interface:
// - "r2":    Cloudflare R2 via the S3 API when the R2_* env vars are set
//            (presigned PUT for the downloader, presigned GET for playback).
// - "local": development/test stand-in writing to web/.data/storage, served by
//            /api/local-storage/[...key] with HMAC-signed URLs.
// In production builds the local stand-in is disabled (SPEC 4.1): a production
// runtime without the R2 variables throws here and the Setup page (8.12) shows.
// All external HTTP for R2 goes through the AWS SDK (presigning is local, no
// network), so tests run offline.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHmac, randomBytes } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'

/** Presigned PUT lifetime for downloader uploads (SPEC 7.2). */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60
/** Presigned GET lifetime for playback (SPEC 7.2). */
export const DOWNLOAD_URL_TTL_SECONDS = 6 * 60 * 60
/** Content type stamped on uploads and served back (SPEC 7.2). */
export const AUDIO_CONTENT_TYPE = 'audio/mp4'

/** What head(key) reports; the player and delete flow branch on `exists`. */
export type StorageHead = { exists: true; bytes: number } | { exists: false }

/**
 * The storage adapter surface, fixed by SPEC 4.1. Every method takes an
 * object key (e.g. `tracks/<uuid>.m4a`) relative to the storage root.
 */
export interface StorageDriver {
  /** Which driver this instance is (health check reports STAND-IN for local). */
  readonly driverName: 'r2' | 'local'
  /** Presigned upload URL the PC agent PUTs bytes to (15 min, audio/mp4). */
  uploadUrl(key: string): Promise<string>
  /** Presigned playback URL (6 h); attachmentName turns it into a download. */
  downloadUrl(key: string, opts?: { attachmentName?: string }): Promise<string>
  head(key: string): Promise<StorageHead>
  delete(key: string): Promise<void>
  /** Applies the browser CORS rules (7.2); no-op for the local stand-in. */
  setCors(): Promise<void>
}

/** Thrown when a key could escape the storage root or is malformed. */
export class StorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${key}`)
    this.name = 'StorageKeyError'
  }
}

// ---------------------------------------------------------------------------
// Shared pure helpers (used by both drivers and the local-storage route)
// ---------------------------------------------------------------------------

/**
 * ASCII-safe filename for Content-Disposition (SPEC 7.2): non-ASCII becomes
 * `_` and quotes are dropped so the quoted-string form stays well-formed.
 */
export function asciiSafeFilename(name: string): string {
  return name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '_')
}

/**
 * HMAC signature for local stand-in URLs, exactly as SPEC 4.1 defines it:
 * HMAC-SHA256(key+exp, SESSION_SECRET), exp in unix seconds, hex digest.
 */
export function localSignature(key: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${key}${exp}`).digest('hex')
}

/**
 * Resolves a storage key (which may contain `/`) to a path inside `baseDir`,
 * or null when any segment could escape it. Backslashes and empty/dot
 * segments are rejected outright so the result is traversal-proof on every
 * platform.
 */
export function localKeyPath(baseDir: string, key: string[]): string | null {
  if (key.length === 0) return null
  for (const segment of key) {
    if (segment === '' || segment === '.' || segment === '..') return null
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return null
  }
  const resolved = nodePath.resolve(nodePath.resolve(baseDir), ...key)
  const base = nodePath.resolve(baseDir) + nodePath.sep
  return resolved.startsWith(base) ? resolved : null
}

export type RangeSelection = { start: number; end: number }

export type ParseRangeResult = RangeSelection | 'unsatisfiable' | null

/**
 * Parses a single `Range: bytes=...` header against a resource of `size`
 * bytes. Returns:
 * - a {start,end} selection (end inclusive, clamped to the resource)
 * - 'unsatisfiable' → respond 416
 * - null → ignore the header and serve the full body (200). This covers no
 *   header, malformed values, and multi-range requests, which this stand-in
 *   does not implement (RFC 9110 allows ignoring them).
 */
export function parseRange(header: string | null, size: number): ParseRangeResult {
  if (!header) return null
  // Only a single `bytes=start-end` range is accepted; the regex also rejects
  // multi-range lists (a comma can never match).
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  if (match[1] === '' && match[2] === '') return null

  const [startRaw, endRaw] = [match[1], match[2]]
  if (startRaw === '') {
    // `bytes=-N`: last N bytes. Suffix of 0 (or of an empty body) is unsatisfiable.
    const suffix = Number(endRaw)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(startRaw)
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  if (start > end) return start >= size ? 'unsatisfiable' : null
  if (start >= size) return 'unsatisfiable'
  return { start, end }
}

/** Content type for a stored object; the library stores audio files. */
export function contentTypeForKey(key: string): string {
  if (key.endsWith('.m4a') || key.endsWith('.mp4')) return 'audio/mp4'
  if (key.endsWith('.mp3')) return 'audio/mpeg'
  return 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Local stand-in driver (SPEC 4.1)
// ---------------------------------------------------------------------------

export interface LocalStorageConfig {
  /** Root directory for stored files (web/.data/storage in development). */
  baseDir: string
  /** SESSION_SECRET value used for the HMAC URL signatures. */
  secret: string
}

export function createLocalStorage(config: LocalStorageConfig): StorageDriver {
  const { baseDir, secret } = config

  function assertKeyPath(key: string): string {
    const filePath = localKeyPath(baseDir, key.split('/'))
    if (!filePath) throw new StorageKeyError(key)
    return filePath
  }

  /** Builds the stand-in "presigned" URL: /api/local-storage/<key>?exp&sig. */
  function signedUrl(key: string, ttlSeconds: number, extraParams?: URLSearchParams): string {
    assertKeyPath(key) // every driver method refuses invalid keys, URL builders included
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds
    const params = new URLSearchParams({ exp: String(exp), sig: localSignature(key, exp, secret) })
    for (const [name, value] of extraParams ?? []) params.append(name, value)
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')
    return `/api/local-storage/${encodedKey}?${params.toString()}`
  }

  return {
    driverName: 'local',

    async uploadUrl(key) {
      return signedUrl(key, UPLOAD_URL_TTL_SECONDS)
    },

    async downloadUrl(key, opts) {
      const extra = new URLSearchParams()
      if (opts?.attachmentName) {
        // SPEC 8.10 opens the URL with ?download=1 for "Save to Files" on PC.
        extra.set('download', '1')
        extra.set('name', asciiSafeFilename(opts.attachmentName))
      }
      return signedUrl(key, DOWNLOAD_URL_TTL_SECONDS, extra)
    },

    async head(key) {
      try {
        const info = await stat(assertKeyPath(key))
        return { exists: true, bytes: info.size }
      } catch (err) {
        if (isNodeNotFound(err)) return { exists: false }
        throw err
      }
    },

    async delete(key) {
      // force: deleting a missing object is not an error (matches S3 semantics).
      await rm(assertKeyPath(key), { force: true })
    },

    async setCors() {
      // No-op: the local route is same-origin, no CORS policy applies.
    },
  }
}

// ---------------------------------------------------------------------------
// R2 driver (SPEC 7.2)
// ---------------------------------------------------------------------------

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/**
 * The subset of the S3 client the R2 driver sends non-presigned commands
 * through. Injectable so tests can capture commands without the network.
 * S3Client satisfies this structurally; the resolved value is re-typed per
 * command at the call site (the SDK's own command→output mapping).
 */
export interface R2Transport {
  send(command: HeadObjectCommand | DeleteObjectCommand | PutBucketCorsCommand): Promise<unknown>
}

export function createR2Storage(config: R2Config, transport?: R2Transport): StorageDriver {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
  const send: R2Transport = transport ?? client
  const bucket = config.bucket

  return {
    driverName: 'r2',

    // Presigned PUT for the agent: 15 minutes, content type pinned (7.2).
    async uploadUrl(key) {
      const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: AUDIO_CONTENT_TYPE })
      return getSignedUrl(client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS })
    },

    // Presigned GET for playback: 6 hours; attachment for "Save to Files" (8.10).
    async downloadUrl(key, opts) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(opts?.attachmentName
          ? { ResponseContentDisposition: `attachment; filename="${asciiSafeFilename(opts.attachmentName)}"` }
          : {}),
      })
      return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS })
    },

    async head(key) {
      try {
        // HeadObjectCommand always resolves to HeadObjectCommandOutput.
        const out = (await send.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))) as HeadObjectCommandOutput
        return { exists: true, bytes: out.ContentLength ?? 0 }
      } catch (err) {
        if (isS3NotFound(err)) return { exists: false }
        throw err
      }
    },

    async delete(key) {
      await send.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },

    // Called by "Finish setup" (8.12) so the browser can play/HEAD objects.
    async setCors() {
      const origins = ['http://localhost:3000']
      const production = productionOrigin()
      if (production) origins.unshift(production)
      await send.send(
        new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: r2CorsRules(origins) } }),
      )
    },
  }
}

/**
 * The CORS policy from SPEC 7.2, parameterized by the app origins. Exposed
 * pure so tests pin the exact rules "Finish setup" applies.
 */
export function r2CorsRules(allowedOrigins: string[]): {
  AllowedOrigins: string[]
  AllowedMethods: string[]
  AllowedHeaders: string[]
  ExposeHeaders: string[]
  MaxAgeSeconds: number
}[] {
  return [
    {
      AllowedOrigins: [...new Set(allowedOrigins)],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'],
      MaxAgeSeconds: 3600,
    },
  ]
}

/**
 * Recognizes S3 "object does not exist" errors so head() can report
 * { exists: false } instead of throwing. Covers the error shapes the SDK
 * surfaces (error name/code and the HTTP status).
 */
export function isS3NotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } }
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.code === 'NotFound' ||
    e.code === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  )
}

function isNodeNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

// ---------------------------------------------------------------------------
// Driver selection from the environment (SPEC 4.1)
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  // TAPEDECK_TEST=1 is the one test switch (SPEC 9.0), honored by db.ts and
  // the session code too: the e2e production server (T4 offline checks)
  // runs a real production build on the local stand-in.
  return process.env.NODE_ENV === 'production' && process.env.TAPEDECK_TEST !== '1'
}

function r2ConfigFromEnv(): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  }
}

/**
 * The production app origin for R2 CORS (7.2), or null when unknown. Vercel
 * sets VERCEL_PROJECT_PRODUCTION_URL without a scheme; normalize it.
 */
function productionOrigin(): string | null {
  const raw = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (!raw) return null
  return raw.startsWith('http') ? raw : `https://${raw}`
}

// Process-scoped fallback so development works before the dev-secrets loader
// (web/.data/dev-secrets.json) injects SESSION_SECRET. Signatures are stable
// within a run; across restarts URLs are re-issued, nothing is persisted.
let devFallbackSecret: string | null = null
function fallbackSecret(): string {
  devFallbackSecret ??= randomBytes(32).toString('hex')
  return devFallbackSecret
}

function localConfigFromEnv(): LocalStorageConfig {
  return {
    // SPEC 9.0 runs tests against a temp folder; TAPEDECK_STORAGE_DIR points there.
    baseDir: process.env.TAPEDECK_STORAGE_DIR || nodePath.join(process.cwd(), '.data', 'storage'),
    secret: process.env.SESSION_SECRET || fallbackSecret(),
  }
}

/**
 * Configuration for the local stand-in route, or null when the stand-in is
 * disabled (R2 active, or a production build — SPEC 4.1). The route serves
 * 404 in the disabled case.
 */
export function localStorageConfig(): { baseDir: string; secret: string } | null {
  if (r2ConfigFromEnv() || isProduction()) return null
  return localConfigFromEnv()
}

let cachedDriver: StorageDriver | null = null

/**
 * The app-wide storage adapter. Picks R2 when configured, otherwise the local
 * stand-in in development/test. Throws in a production build without the R2
 * variables (stand-ins are disabled there; the Setup page handles onboarding).
 */
export function getStorage(): StorageDriver {
  if (cachedDriver) return cachedDriver
  const r2 = r2ConfigFromEnv()
  if (r2) {
    cachedDriver = createR2Storage(r2)
    return cachedDriver
  }
  if (isProduction()) {
    throw new Error(
      'Storage is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET (the local stand-in is disabled in production, SPEC 4.1).',
    )
  }
  cachedDriver = createLocalStorage(localConfigFromEnv())
  return cachedDriver
}
