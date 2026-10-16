/**
 * Speed and pitch per song (V2-PLAN T14). Each song stores a speed from 0.5x
 * to 1.5x in 0.05 steps (`playbackRate`) and whether its pitch is kept
 * (`preservePitch`). The player puts both on the one <audio> element at
 * every track start; nothing is re-encoded.
 *
 * Clocks: trim (T10) and the store's `position` / `duration` stay in media
 * time, the file's own seconds. The clocks people read in the app are
 * divided by the speed ("shown time"), so a 3:00 song at 1.25x shows 2:24.
 * The lock screen gets media time plus the playbackRate, as the Media
 * Session API expects, and the phone runs its clock at that rate.
 *
 * Pure functions plus one DOM setter: the store, the Edit details speed
 * section, the Now Playing chip and the PATCH route share them, and tests
 * run in node.
 */

export const MIN_RATE = 0.5;
export const MAX_RATE = 1.5;
export const RATE_STEP = 0.05;
export const NORMAL_RATE = 1;

export interface SpeedPreset {
  readonly id: "slowed" | "normal" | "sped-up";
  readonly label: string;
  readonly rate: number;
}

/** The plan's three presets. */
export const SPEED_PRESETS: readonly SpeedPreset[] = [
  { id: "slowed", label: "Slowed", rate: 0.85 },
  { id: "normal", label: "Normal", rate: NORMAL_RATE },
  { id: "sped-up", label: "Sped up", rate: 1.25 },
];

/** The fields speed needs (PlayerTrack and TrackDto both fit). */
export interface SpeedSource {
  readonly playbackRate?: number | null;
  readonly preservePitch?: boolean | null;
}

/** Round to the 0.05 grid, clamped into 0.5 to 1.5; anything unusable is 1. */
export function normalizeRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return NORMAL_RATE;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, value));
  // Two decimals so 0.85 stays 0.85 and not 0.8500000000000001.
  return Number((Math.round(clamped / RATE_STEP) * RATE_STEP).toFixed(2));
}

/** The song's speed, safe to put on the audio element. */
export function rateOf(track: SpeedSource | null | undefined): number {
  return normalizeRate(track?.playbackRate ?? NORMAL_RATE);
}

/** True unless the song asks for the classic sped up / slowed sound. */
export function keepsPitch(track: SpeedSource | null | undefined): boolean {
  return track?.preservePitch !== false;
}

/** True when the song plays at normal speed. */
export function isNormalSpeed(track: SpeedSource | null | undefined): boolean {
  return rateOf(track) === NORMAL_RATE;
}

/** True when two songs would play at the same speed and pitch setting. */
export function sameSpeed(a: SpeedSource, b: SpeedSource): boolean {
  return rateOf(a) === rateOf(b) && keepsPitch(a) === keepsPitch(b);
}

/** "1.25x", "0.85x", "1.5x", "1x". */
export function speedLabel(rate: number): string {
  return `${Number(normalizeRate(rate).toFixed(2))}x`;
}

/** The preset a speed matches, or null for any other speed. */
export function presetFor(rate: number): SpeedPreset | null {
  const normal = normalizeRate(rate);
  return SPEED_PRESETS.find((preset) => preset.rate === normal) ?? null;
}

/** Media seconds to the seconds a person waits at this speed. */
export function toShownTime(mediaSeconds: number, rate: number): number {
  return mediaSeconds / normalizeRate(rate);
}

/** Shown seconds (scrubber, clocks) back to media seconds for a seek. */
export function fromShownTime(shownSeconds: number, rate: number): number {
  return shownSeconds * normalizeRate(rate);
}

/**
 * The plan's rule for a stored speed: a number from 0.5 to 1.5 on the 0.05
 * grid. Returns the message to show, or null when it is fine.
 */
export function speedProblem(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Speed must be a number, for example 1.25.";
  if (value < MIN_RATE - 1e-9 || value > MAX_RATE + 1e-9) return "Speed must be between 0.5x and 1.5x.";
  const steps = value / RATE_STEP;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return "Speed goes up and down in steps of 0.05.";
  return null;
}

/** The audio element fields speed touches (the prefixed one is older Safari's name). */
export interface SpeedTarget {
  playbackRate: number;
  defaultPlaybackRate?: number;
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
}

/**
 * Put the song's speed and pitch setting on the audio element. Safe to call
 * again and again: it only writes what differs.
 *
 * `defaultPlaybackRate` is set as well because loading a new `src` resets
 * `playbackRate` to it (HTML media load algorithm), so the speed holds even
 * if the engine reloads behind our back. The pitch is set first: some engines
 * pick the pitch mode when the rate changes.
 */
export function applySpeed(audio: SpeedTarget, track: SpeedSource | null | undefined): void {
  const rate = rateOf(track);
  const keep = keepsPitch(track);
  try {
    if ("preservesPitch" in audio && audio.preservesPitch !== keep) audio.preservesPitch = keep;
    if ("webkitPreservesPitch" in audio && audio.webkitPreservesPitch !== keep) audio.webkitPreservesPitch = keep;
    if ("defaultPlaybackRate" in audio && audio.defaultPlaybackRate !== rate) audio.defaultPlaybackRate = rate;
    if (audio.playbackRate !== rate) audio.playbackRate = rate;
  } catch {
    // An engine that refuses a rate keeps playing at its own; never stop the music for it.
  }
}
