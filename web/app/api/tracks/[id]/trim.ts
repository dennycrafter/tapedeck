// Trim fields for PATCH /api/tracks/[id] (V2-PLAN T10). Edit details sends
// `trimStartSec` and `trimEndSec`: a number of seconds, or null to go back
// to the PC's suggestion. The trim that would result (hand value, else the
// suggestion, else the whole song) must pass the plan's rule:
// 0 <= start < end <= duration, with at least 10 seconds kept.

import { trimProblem } from '../../../../lib/player/trim'
import type { Row } from '../../../../lib/db'

export interface TrimChange {
  /** Absent = unchanged; null = clear (use the suggestion). */
  start?: number | null
  end?: number | null
}

/** The stored values the check needs (numeric columns can arrive as strings). */
export interface TrimRow extends Row {
  duration_sec: number | string | null
  auto_trim_start_sec: number | string | null
  auto_trim_end_sec: number | string | null
  trim_start_sec: number | string | null
  trim_end_sec: number | string | null
}

export const TRIM_ROW_COLUMNS = 'duration_sec, auto_trim_start_sec, auto_trim_end_sec, trim_start_sec, trim_end_sec'

function num(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Read the two trim fields from the body; `change` is null when neither is present. */
export function readTrimChange(body: Record<string, unknown>): { change: TrimChange | null; error?: string } {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined
  if (!has('trimStartSec') && !has('trimEndSec')) return { change: null }
  const change: TrimChange = {}
  for (const [key, field] of [
    ['trimStartSec', 'start'],
    ['trimEndSec', 'end'],
  ] as const) {
    if (!has(key)) continue
    const value = body[key]
    if (value === null) {
      change[field] = null
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      change[field] = value
    } else {
      return { change: null, error: `${key} must be a number of seconds or null` }
    }
  }
  return { change }
}

/** The 400 message for a trim that breaks the rule, or null when it is fine. */
export function checkTrimChange(change: TrimChange, row: TrimRow): string | null {
  const duration = num(row.duration_sec)
  const manualStart = change.start !== undefined ? change.start : num(row.trim_start_sec)
  const manualEnd = change.end !== undefined ? change.end : num(row.trim_end_sec)
  const start = manualStart ?? num(row.auto_trim_start_sec) ?? 0
  const end = manualEnd ?? num(row.auto_trim_end_sec) ?? duration
  // Unknown length and no end anywhere: only the start can be checked.
  if (end == null) return start < 0 ? "The start can't be before 0:00." : null
  return trimProblem(start, end, duration)
}
