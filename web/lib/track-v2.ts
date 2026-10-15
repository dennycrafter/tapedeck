/**
 * The per-song fields v2 adds (V2-PLAN T9), shared by the server (library
 * payload) and the client (TrackDto, offline snapshot). Database columns are
 * snake_case; the API and the app use these camelCase names.
 *
 *   isrc                 catalog ISRC (T11, T13)
 *   resolvedUrl          the copy the PC actually downloaded (T12)
 *   matchInfo            how the PC picked that copy, with alternatives (T12)
 *   autoTrimStartSec/EndSec  trim suggested by the PC (T10)
 *   trimStartSec/EndSec  trim set by hand; null means use the auto value (T10)
 *   playbackRate         0.5 to 1.5 (T14)
 *   preservePitch        keep the original pitch at other speeds (T14)
 */

/** One possible copy of a catalog song the PC found (T12). */
export interface MatchCandidate {
  title: string
  uploader: string
  durationSec: number | null
  url: string
  score: number
  /** "ytmusic", "soundcloud" or "youtube". */
  source?: string
}

/** What the PC chose and the runners-up (T12). Stored as jsonb, at most 8 KB. */
export interface MatchInfo {
  chosen?: MatchCandidate | null
  score?: number | null
  alternatives?: MatchCandidate[]
}

export interface TrackV2Fields {
  isrc: string | null
  resolvedUrl: string | null
  matchInfo: MatchInfo | null
  autoTrimStartSec: number | null
  autoTrimEndSec: number | null
  trimStartSec: number | null
  trimEndSec: number | null
  playbackRate: number
  preservePitch: boolean
}

export const TRACK_V2_DEFAULTS: Readonly<TrackV2Fields> = Object.freeze({
  isrc: null,
  resolvedUrl: null,
  matchInfo: null,
  autoTrimStartSec: null,
  autoTrimEndSec: null,
  trimStartSec: null,
  trimEndSec: null,
  playbackRate: 1,
  preservePitch: true,
})

/** The columns to select for these fields (keep in step with v2FieldsFromRow). */
export const TRACK_V2_COLUMNS =
  'isrc, resolved_url, match_info, auto_trim_start_sec, auto_trim_end_sec, trim_start_sec, trim_end_sec, playback_rate, preserve_pitch'

function numberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function textOrNull(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function matchInfoOrNull(value: unknown): MatchInfo | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return matchInfoOrNull(JSON.parse(value))
    } catch {
      return null
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? (value as MatchInfo) : null
}

/** Read the v2 fields from a tracks row (numeric columns arrive as strings on some drivers). */
export function v2FieldsFromRow(row: Record<string, unknown>): TrackV2Fields {
  return {
    isrc: textOrNull(row.isrc),
    resolvedUrl: textOrNull(row.resolved_url),
    matchInfo: matchInfoOrNull(row.match_info),
    autoTrimStartSec: numberOrNull(row.auto_trim_start_sec),
    autoTrimEndSec: numberOrNull(row.auto_trim_end_sec),
    trimStartSec: numberOrNull(row.trim_start_sec),
    trimEndSec: numberOrNull(row.trim_end_sec),
    playbackRate: numberOrNull(row.playback_rate) ?? 1,
    preservePitch: row.preserve_pitch !== false,
  }
}

/**
 * Fill in the v2 fields a track is missing, for example one from an offline
 * snapshot saved before v2. Present values are kept as they are.
 */
export function withV2Defaults<T extends Partial<TrackV2Fields>>(track: T): T & TrackV2Fields {
  return {
    ...track,
    isrc: track.isrc ?? null,
    resolvedUrl: track.resolvedUrl ?? null,
    matchInfo: track.matchInfo ?? null,
    autoTrimStartSec: track.autoTrimStartSec ?? null,
    autoTrimEndSec: track.autoTrimEndSec ?? null,
    trimStartSec: track.trimStartSec ?? null,
    trimEndSec: track.trimEndSec ?? null,
    playbackRate: typeof track.playbackRate === 'number' ? track.playbackRate : 1,
    preservePitch: track.preservePitch ?? true,
  }
}
