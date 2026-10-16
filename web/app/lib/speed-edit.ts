/**
 * State for the Speed section in Edit details and the Now Playing speed chip
 * (V2-PLAN T14). The draft holds the speed and the "Keep original pitch"
 * switch; only fields that changed are sent with PATCH /api/tracks/:id.
 */
import { formatClock } from "../../lib/player/format";
import { keepsPitch, normalizeRate, rateOf, toShownTime, type SpeedSource } from "../../lib/player/speed";

export interface SpeedDraft {
  readonly rate: number;
  readonly keepPitch: boolean;
}

export function initialSpeedDraft(track: SpeedSource): SpeedDraft {
  return { rate: rateOf(track), keepPitch: keepsPitch(track) };
}

/** The PATCH fields for the draft; empty when nothing changed. */
export function speedPatch(track: SpeedSource, draft: SpeedDraft): { playbackRate?: number; preservePitch?: boolean } {
  const before = initialSpeedDraft(track);
  const rate = normalizeRate(draft.rate);
  return {
    ...(rate !== before.rate ? { playbackRate: rate } : {}),
    ...(draft.keepPitch !== before.keepPitch ? { preservePitch: draft.keepPitch } : {}),
  };
}

/**
 * "Plays in 2:24 instead of 3:00" for a song of `lengthSec` (its trimmed
 * length, in the file's own seconds); null at normal speed or unknown length.
 */
export function playLengthText(lengthSec: number | null | undefined, rate: number): string | null {
  if (lengthSec == null || !Number.isFinite(lengthSec) || lengthSec <= 0) return null;
  const normal = normalizeRate(rate);
  if (normal === 1) return null;
  return `Plays in ${formatClock(toShownTime(lengthSec, normal))} instead of ${formatClock(lengthSec)}`;
}
