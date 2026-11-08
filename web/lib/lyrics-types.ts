/**
 * Lyrics (T16): what the lyrics route answers, and the small helpers the
 * Now Playing screen shares with the server. No Node imports: the browser
 * imports this file too.
 */

/** One line of timed lyrics; `time` is seconds into the song's file. */
export interface LyricLine {
  time: number;
  text: string;
}

export type LyricsResult =
  /** Timed lines that fit this copy of the song (lengths within SYNC_TOLERANCE_SEC). */
  | { status: "synced"; lines: LyricLine[] }
  /** Words without timing: no timed version, or one made for a copy of another length. */
  | { status: "plain"; text: string }
  | { status: "instrumental" }
  | { status: "none" }
  /** The lyrics service could not be reached or asked to slow down: try later. */
  | { status: "unavailable" };

/**
 * Timed lyrics are only used when their song's length is this close to the
 * file's (a music video with an intro would show every line too early).
 */
export const SYNC_TOLERANCE_SEC = 3;

/** Where the lyrics come from, credited under them. */
export const LYRICS_CREDIT = "Lyrics from LRCLIB";

/**
 * The line being sung at `mediaTime` (seconds into the file): the last line
 * that has started, or -1 before the first one.
 */
export function activeLineIndex(lines: readonly LyricLine[], mediaTime: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.time <= mediaTime) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export function isLyricsResult(value: unknown): value is LyricsResult {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  if (status === "synced") return Array.isArray((value as { lines?: unknown }).lines);
  if (status === "plain") return typeof (value as { text?: unknown }).text === "string";
  return status === "instrumental" || status === "none" || status === "unavailable";
}
