/**
 * Pure logic for the /test-audio page (SPEC T0 step 8).
 * Kept free of DOM/runtime calls so it unit tests in node (Vitest).
 * Queue and player rules come from SPEC 8.8; offline storage names from 8.9.
 */

export type Tone = {
  readonly id: string;
  readonly src: string;
  readonly title: string;
  readonly frequencyHz: number;
};

/** The two 3-minute AAC tones served from web/public/test-audio/ (440 Hz and 660 Hz). */
export const TONES: readonly Tone[] = [
  { id: "test1", src: "/test-audio/test1.m4a", title: "Test tone 1", frequencyHz: 440 },
  { id: "test2", src: "/test-audio/test2.m4a", title: "Test tone 2", frequencyHz: 660 },
];

/** SPEC 8.9 offline database and audio store, reused here so the T4 store matches. */
export const OFFLINE_DB_NAME = "tapedeck-offline";
export const OFFLINE_AUDIO_STORE = "audio";
export const OFFLINE_TEST1_KEY = "test1";

/** SPEC 8.8: "if more than 3 s in, restart the song; else go to previous." */
export const RESTART_THRESHOLD_SECONDS = 3;

/** SPEC 8.8: update setPositionState on timeupdate, throttled to 1/s. */
export const POSITION_UPDATE_INTERVAL_MS = 1000;

/** Index of the next tone in the fixed two-tone queue, or null when the queue is over. */
export function nextIndex(currentIndex: number): number | null {
  const next = currentIndex + 1;
  return next < TONES.length ? next : null;
}

export type PreviousAction = { kind: "restart" } | { kind: "previous"; index: number };

/** SPEC 8.8 previous rule. Past 3 s restarts; otherwise previous tone, or restart when none. */
export function previousAction(
  currentTimeSeconds: number,
  currentIndex: number,
): PreviousAction {
  if (currentTimeSeconds > RESTART_THRESHOLD_SECONDS) return { kind: "restart" };
  const previous = currentIndex - 1;
  return previous >= 0 ? { kind: "previous", index: previous } : { kind: "restart" };
}

/** Media Session metadata payload for a tone. Artwork is omitted: tones have no cover (SPEC 8.8). */
export function mediaSessionPayload(tone: Tone): { title: string; artist: string; album: string } {
  return { title: tone.title, artist: "Tapedeck", album: "Test tones" };
}

/**
 * Target time for a seek, clamped into [0, duration].
 * With an unknown duration (metadata not loaded yet) only the 0 bound applies;
 * the browser clamps the rest.
 */
export function clampSeekTime(
  currentSeconds: number,
  deltaSeconds: number,
  durationSeconds: number,
): number {
  const target = Math.max(0, currentSeconds + deltaSeconds);
  return Number.isFinite(durationSeconds) ? Math.min(target, durationSeconds) : target;
}

export type PlaybackState = { position: number; duration: number; playbackRate: number };

/**
 * setPositionState input, or null while duration or position are unknown
 * (setPositionState rejects non-finite values, so callers skip those).
 */
export function playbackState(audio: {
  currentTime: number;
  duration: number;
  playbackRate: number;
}): PlaybackState | null {
  if (!Number.isFinite(audio.duration) || !Number.isFinite(audio.currentTime)) return null;
  return {
    position: Math.min(Math.max(audio.currentTime, 0), audio.duration),
    duration: audio.duration,
    playbackRate: audio.playbackRate,
  };
}

/** True when at least intervalMs passed since the last emitted position update. */
export function isPositionUpdateDue(
  lastSentAtMs: number,
  nowMs: number,
  intervalMs: number = POSITION_UPDATE_INTERVAL_MS,
): boolean {
  return nowMs - lastSentAtMs >= intervalMs;
}

/** Human-readable size for the saved-offline status line. */
export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
