/**
 * Trim math (V2-PLAN T10). Trim is non-destructive: the stored file is never
 * cut, the song just plays from its trim start to its trim end.
 *
 * Two clocks exist. "Media time" is the audio element's currentTime in the
 * whole file. "Trimmed time" runs from 0 at the trim start to the trimmed
 * length at the trim end; the scrubber, the elapsed and total times and the
 * lock screen all show trimmed time. The store converts at the edges.
 *
 * Effective start = coalesce(trimStartSec, autoTrimStartSec, 0) and
 * effective end = coalesce(trimEndSec, autoTrimEndSec, durationSec): a value
 * set by hand wins over the PC's suggestion, null means "use the suggestion".
 *
 * Pure functions, no DOM: the store, the Edit details trim editor and the
 * PATCH route all share them, and tests run in node.
 */

/** The fields of a song trim needs (PlayerTrack and TrackDto both fit). */
export interface TrimSource {
  readonly durationSec: number | null;
  readonly autoTrimStartSec?: number | null;
  readonly autoTrimEndSec?: number | null;
  readonly trimStartSec?: number | null;
  readonly trimEndSec?: number | null;
}

/** The part of the file to play, in media seconds. `end: null` plays to the file's end. */
export interface PlayRange {
  readonly start: number;
  readonly end: number | null;
}

/** A trim must keep at least this much of the song (V2-PLAN T10). */
export const MIN_TRIM_LENGTH_SEC = 10;

/**
 * The stored duration is whole seconds while the file is a little longer or
 * shorter, so trim points may sit up to half a second past it (the same
 * allowance /api/agent/complete makes for the PC's suggestion).
 */
export const DURATION_SLACK_SEC = 0.5;

/** Ranges shorter than this are treated as broken data and ignored by the player. */
const MIN_PLAYABLE_SEC = 1;

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The effective start in seconds: hand value, else the PC's suggestion, else 0. */
export function effectiveStart(track: TrimSource): number {
  const value = finite(track.trimStartSec) ? track.trimStartSec : finite(track.autoTrimStartSec) ? track.autoTrimStartSec : 0;
  return Math.max(0, value);
}

/** The effective end in seconds: hand value, else the PC's suggestion, else the duration (null if unknown). */
export function effectiveEnd(track: TrimSource): number | null {
  if (finite(track.trimEndSec)) return track.trimEndSec;
  if (finite(track.autoTrimEndSec)) return track.autoTrimEndSec;
  return finite(track.durationSec) ? track.durationSec : null;
}

/**
 * What the player plays. `mediaDuration` is the audio element's duration once
 * known (more exact than the stored whole seconds). An end at or past the
 * stored length plays to the file's natural end, so "Don't trim" never cuts
 * the last fraction of a second. Nonsense ranges (start past the end, or
 * under a second long) fall back to the whole song rather than skipping it.
 */
export function playRange(track: TrimSource, mediaDuration?: number | null): PlayRange {
  const known = finite(mediaDuration) && mediaDuration > 0 ? mediaDuration : finite(track.durationSec) && track.durationSec > 0 ? track.durationSec : null;
  const start = effectiveStart(track);
  const endRaw = finite(track.trimEndSec) ? track.trimEndSec : finite(track.autoTrimEndSec) ? track.autoTrimEndSec : null;
  let end: number | null = endRaw;
  if (end != null) {
    const storedLength = finite(track.durationSec) ? track.durationSec : null;
    if ((storedLength != null && end >= storedLength) || (known != null && end >= known)) end = null;
  }
  const limit = end ?? known;
  if (limit != null && limit - start < MIN_PLAYABLE_SEC) return { start: 0, end: null };
  return { start, end };
}

/** True when the song is trimmed at all. */
export function isTrimmed(range: PlayRange): boolean {
  return range.start > 0 || range.end != null;
}

/** Trimmed length in seconds; 0 while unknown. */
export function rangeLength(range: PlayRange, mediaDuration: number | null | undefined): number {
  const end = range.end ?? (finite(mediaDuration) && mediaDuration > 0 ? mediaDuration : null);
  if (end == null) return 0;
  return Math.max(0, end - range.start);
}

/** Media time to trimmed time, clamped into [0, length] when the length is known. */
export function toTrimmedTime(mediaTime: number, range: PlayRange, length: number): number {
  if (!Number.isFinite(mediaTime)) return 0;
  const t = Math.max(0, mediaTime - range.start);
  return length > 0 ? Math.min(t, length) : t;
}

/** Trimmed time to media time. Seeks outside the range are clamped into it. */
export function toMediaTime(trimmedTime: number, range: PlayRange, length: number): number {
  const t = Number.isFinite(trimmedTime) ? Math.max(0, trimmedTime) : 0;
  return range.start + (length > 0 ? Math.min(t, length) : t);
}

/** True once playback has reached the trim end (the store then acts as on `ended`). */
export function pastTrimEnd(mediaTime: number, range: PlayRange): boolean {
  return range.end != null && Number.isFinite(mediaTime) && mediaTime >= range.end;
}

/** True when two songs would play the same range (the player re-reads it on changes). */
export function sameTrim(a: TrimSource, b: TrimSource): boolean {
  return (
    (a.trimStartSec ?? null) === (b.trimStartSec ?? null) &&
    (a.trimEndSec ?? null) === (b.trimEndSec ?? null) &&
    (a.autoTrimStartSec ?? null) === (b.autoTrimStartSec ?? null) &&
    (a.autoTrimEndSec ?? null) === (b.autoTrimEndSec ?? null)
  );
}

// --- Edit details (TrimEditor) and PATCH /api/tracks/:id ---

/**
 * The plan's rule for a trim: 0 <= start < end <= duration and at least 10
 * seconds kept. Returns the message to show, or null when it is fine.
 * `durationSec` null skips the length check (unknown length).
 */
export function trimProblem(start: number, end: number, durationSec: number | null): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Enter the start and end as m:ss.s, for example 0:12.5.";
  if (start < 0) return "The start can't be before 0:00.";
  if (durationSec != null && end > durationSec + DURATION_SLACK_SEC) return "The end can't be past the end of the song.";
  if (start >= end) return "The start must be before the end.";
  if (end - start < MIN_TRIM_LENGTH_SEC) return `Keep at least ${MIN_TRIM_LENGTH_SEC} seconds of the song.`;
  return null;
}

/** Round to a tenth of a second, the precision of the editor's fields. */
export function roundTenth(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

/** "m:ss.s", for example 0:05.0 or 3:12.4 (the trim editor's fields). */
export function formatTrimTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const tenths = Math.round(seconds * 10);
  const mins = Math.floor(tenths / 600);
  const rest = (tenths - mins * 600) / 10;
  return `${mins}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Read "m:ss.s", "m:ss" or plain seconds ("75.5"). Null when it is not a time. */
export function parseTrimTime(text: string): number | null {
  const value = text.trim();
  const clock = /^(\d{1,3}):([0-5]?\d(?:[.,]\d+)?)$/.exec(value);
  if (clock) return roundTenth(Number(clock[1]) * 60 + Number(clock[2].replace(",", ".")));
  const plain = /^\d+(?:[.,]\d+)?$/.exec(value);
  if (plain) return roundTenth(Number(value.replace(",", ".")));
  return null;
}
