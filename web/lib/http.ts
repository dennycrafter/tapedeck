/**
 * The one HTTP wrapper every external call goes through.
 *
 * All outbound HTTP from `web/lib/*` (YouTube Data API, YouTube/SoundCloud
 * oEmbed, iTunes, Deezer, Anthropic, presigned file fetches) must go through
 * `httpResponse`/`httpJson` instead of calling `fetch` directly, so timeouts
 * and error handling stay uniform and MSW can intercept every request in
 * tests (SPEC 9.0).
 */

/** Timeout for every request unless the caller passes `timeoutMs`. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000

export type HttpErrorKind = 'timeout' | 'network' | 'status' | 'parse'

interface HttpErrorInit {
  status?: number
  url: string
  bodyExcerpt?: string
  cause?: unknown
}

/**
 * Normalized failure for every outbound HTTP call: non-2xx status, connection
 * failure, timeout, or a body that does not parse as JSON. Anything else
 * (e.g. a programming error) propagates untouched.
 */
export class HttpError extends Error {
  readonly kind: HttpErrorKind
  /** Response status; undefined when the request never got a response. */
  readonly status: number | undefined
  readonly url: string
  /** Start of the response body, when one was received and readable. */
  readonly bodyExcerpt: string | undefined

  constructor(kind: HttpErrorKind, message: string, init: HttpErrorInit) {
    super(message, { cause: init.cause })
    this.name = 'HttpError'
    this.kind = kind
    this.status = init.status
    this.url = init.url
    this.bodyExcerpt = init.bodyExcerpt
  }
}

export interface HttpInit extends RequestInit {
  /** Per-call timeout override in milliseconds. */
  timeoutMs?: number
}

const EXCERPT_LENGTH = 200

async function bodyExcerpt(response: Response): Promise<string | undefined> {
  // Diagnostics only: if an error body cannot be read, the status code
  // already carries the actionable information.
  try {
    const text = await response.text()
    return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text
  } catch (cause) {
    console.warn(`http: could not read error body of ${response.url}`, cause)
    return undefined
  }
}

/**
 * Fetch with a timeout and normalized errors: network failure, timeout and
 * non-2xx responses all reject with an `HttpError` instead of bare fetch
 * exceptions. Resolves with the raw `Response` for callers that need bytes
 * (e.g. offline audio downloads, SPEC 8.9).
 */
export async function httpResponse(url: string, init: HttpInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, ...requestInit } = init
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = requestInit.signal
    ? AbortSignal.any([requestInit.signal, timeoutSignal])
    : timeoutSignal

  let response: Response
  try {
    response = await fetch(url, { ...requestInit, signal })
  } catch (cause) {
    if (requestInit.signal?.aborted) throw cause // caller cancelled on their own signal
    if (timeoutSignal.aborted) {
      throw new HttpError('timeout', `Timed out after ${timeoutMs}ms: ${url}`, { url, cause })
    }
    throw new HttpError('network', `Network error calling ${url}`, { url, cause })
  }

  if (!response.ok) {
    throw new HttpError('status', `HTTP ${response.status} calling ${url}`, {
      status: response.status,
      url,
      bodyExcerpt: await bodyExcerpt(response),
    })
  }
  return response
}

/**
 * `httpResponse` plus typed JSON: parses a 2xx body as JSON. Malformed bodies
 * reject with `HttpError` kind `parse`, carrying a body excerpt for diagnosis.
 */
export async function httpJson<T>(url: string, init: HttpInit = {}): Promise<T> {
  const response = await httpResponse(url, init)

  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new HttpError('network', `Failed reading response body from ${url}`, {
      status: response.status,
      url,
      cause,
    })
  }

  try {
    return JSON.parse(text) as T
  } catch (cause) {
    throw new HttpError('parse', `Invalid JSON from ${url}`, {
      status: response.status,
      url,
      bodyExcerpt: text.slice(0, EXCERPT_LENGTH),
      cause,
    })
  }
}
