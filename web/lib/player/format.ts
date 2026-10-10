/**
 * Clock and duration formatting for player and track rows (SPEC 10 rows show
 * the duration right-aligned; the player bar shows elapsed and total time).
 * Pure functions so both the store and the UI can use them, and so tests run
 * in node (SPEC 9.0 keeps vitest jsdom-free).
 */

/** "3:42", "1:02:03"; empty string for unknown or negative values. */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const secs = total % 60;
  const mins = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

/** Row duration; same format as formatClock (an alias keeps intent clear). */
export const formatDuration = formatClock;
