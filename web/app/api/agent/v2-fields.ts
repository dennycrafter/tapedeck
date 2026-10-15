/**
 * Validation for the optional v2 fields on /api/agent/* (V2-PLAN T9). Every
 * field is optional so older downloaders keep working unchanged. Each parser
 * returns `{ value }` (undefined when the field is absent) or `{ error }`
 * with the 400 message.
 */

import type { MatchInfo } from '../../../lib/track-v2'

export type Parsed<T> = { value: T | undefined; error?: undefined } | { value?: undefined; error: string }

/** matchInfo is stored as jsonb; keep each row small. */
export const MAX_MATCH_INFO_BYTES = 8 * 1024

/** The capability list a downloader sends on claim; anything malformed means none. */
export function parseCapabilities(body: Record<string, unknown> | null): string[] {
  const list = body?.capabilities
  if (!Array.isArray(list)) return []
  return list.filter((item): item is string => typeof item === 'string')
}

export function parseMatchInfo(value: unknown): Parsed<MatchInfo> {
  if (value == null) return { value: undefined }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'matchInfo must be an object' }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_MATCH_INFO_BYTES) {
    return { error: 'matchInfo must be under 8 KB' }
  }
  return { value: value as MatchInfo }
}

export function parseResolvedUrl(value: unknown): Parsed<string> {
  if (value == null) return { value: undefined }
  if (typeof value !== 'string') return { error: 'resolvedUrl must be an http(s) URL' }
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return { value: url.toString() }
  } catch {
    // falls through to the error
  }
  return { error: 'resolvedUrl must be an http(s) URL' }
}

/**
 * The PC's trim suggestion (T10): both optional, each a number of seconds
 * within the song's real length, start before end. `durationSec` is the real
 * length when known (sent with complete, or stored); unknown skips that bound.
 */
export function parseAutoTrim(
  start: unknown,
  end: unknown,
  durationSec: number | null,
): Parsed<{ start: number | null; end: number | null }> {
  const read = (value: unknown, name: string): Parsed<number> => {
    if (value == null) return { value: undefined }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { error: `${name} must be a number of seconds, 0 or more` }
    }
    // duration_sec is stored rounded to whole seconds, so allow half a second over.
    if (durationSec != null && value > durationSec + 0.5) {
      return { error: `${name} must be within the song's length` }
    }
    return { value }
  }
  const parsedStart = read(start, 'autoTrimStartSec')
  if (parsedStart.error) return { error: parsedStart.error }
  const parsedEnd = read(end, 'autoTrimEndSec')
  if (parsedEnd.error) return { error: parsedEnd.error }
  const s = parsedStart.value ?? null
  const e = parsedEnd.value ?? null
  if (s != null && e != null && s >= e) {
    return { error: 'autoTrimStartSec must be before autoTrimEndSec' }
  }
  if (s == null && e == null) return { value: undefined }
  return { value: { start: s, end: e } }
}
