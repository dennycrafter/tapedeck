// Speed fields for PATCH /api/tracks/[id] (V2-PLAN T14). Edit details and
// the Now Playing chip send `playbackRate` (0.5 to 1.5 in 0.05 steps) and
// `preservePitch` (true keeps the original pitch). Either may come alone.
// The columns exist since T9 (`playback_rate`, `preserve_pitch`), with a
// database check on the same 0.5 to 1.5 range.

import { normalizeRate, speedProblem } from '../../../../lib/player/speed'

export interface SpeedChange {
  /** Absent = unchanged. */
  playbackRate?: number
  preservePitch?: boolean
}

/** Read the two speed fields from the body; `change` is null when neither is present. */
export function readSpeedChange(body: Record<string, unknown>): { change: SpeedChange | null; error?: string } {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined
  if (!has('playbackRate') && !has('preservePitch')) return { change: null }
  const change: SpeedChange = {}
  if (has('playbackRate')) {
    const problem = speedProblem(body.playbackRate)
    if (problem) return { change: null, error: problem }
    change.playbackRate = normalizeRate(body.playbackRate)
  }
  if (has('preservePitch')) {
    if (typeof body.preservePitch !== 'boolean') return { change: null, error: 'preservePitch must be true or false' }
    change.preservePitch = body.preservePitch
  }
  return { change }
}
