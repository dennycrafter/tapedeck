/**
 * State and rules for the trim editor in Edit details (V2-PLAN T10). The
 * draft holds the values set by hand (null = use the PC's suggestion), the
 * same shape as the database columns, so "Reset to automatic" is simply both
 * null and "Don't trim" is 0 and the full length.
 */
import { MIN_TRIM_LENGTH_SEC, roundTenth, trimProblem, type TrimSource } from "../../lib/player/trim";

export interface TrimDraft {
  /** Hand start in seconds; null = automatic. */
  readonly start: number | null;
  /** Hand end in seconds; null = automatic. */
  readonly end: number | null;
  /** A field holds text that is not a time; the message to show, else null. */
  readonly typing: string | null;
}

export function initialTrimDraft(track: TrimSource): TrimDraft {
  return { start: track.trimStartSec ?? null, end: track.trimEndSec ?? null, typing: null };
}

/** The start and end the draft would play (hand value, else suggestion, else whole song). */
export function draftEdges(track: TrimSource, draft: TrimDraft): { start: number; end: number } {
  const duration = track.durationSec ?? 0;
  return {
    start: draft.start ?? track.autoTrimStartSec ?? 0,
    end: draft.end ?? track.autoTrimEndSec ?? duration,
  };
}

/** What stops the draft from being saved, or null. */
export function trimDraftProblem(track: TrimSource, draft: TrimDraft): string | null {
  if (draft.typing) return draft.typing;
  const { start, end } = draftEdges(track, draft);
  return trimProblem(start, end, track.durationSec);
}

/** The PATCH fields for the draft; empty when nothing changed. */
export function trimPatch(track: TrimSource, draft: TrimDraft): { trimStartSec?: number | null; trimEndSec?: number | null } {
  const before = initialTrimDraft(track);
  if (before.start === draft.start && before.end === draft.end) return {};
  return { trimStartSec: draft.start, trimEndSec: draft.end };
}

function cutText(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

/**
 * "Not trimmed", "Trimmed automatically: ..." or "Trimmed: ..." with the
 * amounts cut, so Denis can see what happened.
 */
export function trimSummary(track: TrimSource, draft: TrimDraft): string {
  const { start, end } = draftEdges(track, draft);
  const duration = track.durationSec ?? end;
  const cutStart = roundTenth(Math.max(0, start));
  const cutEnd = roundTenth(Math.max(0, duration - end));
  if (cutStart <= 0 && cutEnd <= 0) return "Not trimmed";
  const parts: string[] = [];
  if (cutStart > 0) parts.push(`${cutText(cutStart)} cut from the start`);
  if (cutEnd > 0) parts.push(`${cutText(cutEnd)} cut from the end`);
  const byHand = draft.start != null || draft.end != null;
  return `${byHand ? "Trimmed" : "Trimmed automatically"}: ${parts.join(", ")}`;
}

/** Keep a dragged start at least the minimum length before the end. */
export function clampStart(value: number, end: number): number {
  return roundTenth(Math.min(Math.max(0, value), Math.max(0, end - MIN_TRIM_LENGTH_SEC)));
}

/** Keep a dragged end at least the minimum length after the start, within the song. */
export function clampEnd(value: number, start: number, duration: number): number {
  return roundTenth(Math.max(Math.min(duration, value), Math.min(duration, start + MIN_TRIM_LENGTH_SEC)));
}
