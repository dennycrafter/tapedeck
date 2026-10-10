/**
 * Pure UI helpers shared by the library and profile pages (SPEC 8.2, 8.3).
 * Text here is user-visible copy and follows the SPEC strings verbatim.
 */
import type { TrackStatus } from "@/lib/player/store";
import type { AddLineResult } from "./api";

export interface StatusMeta {
  label: string;
  /** Dot background class; null for ready rows (no dot per SPEC 8.3). */
  dotClass: string | null;
}

/** Status dot + label per SPEC 8.3. */
export const STATUS_META: Record<TrackStatus, StatusMeta> = {
  waiting: { label: "Waiting for your PC", dotClass: "bg-warn" },
  downloading: { label: "Downloading", dotClass: "bg-info" },
  failed: { label: "Failed", dotClass: "bg-bad" },
  ready: { label: "", dotClass: null },
};

/** Summary toast copy: "3 added, 1 already in library" (SPEC 8.2). */
export function summarizeAddResults(results: readonly AddLineResult[]): string | null {
  const added = results.filter((r) => r.status === "added").length;
  const already = results.filter((r) => r.status === "already").length;
  const failed = results.filter((r) => r.status === "error").length;
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (already > 0) parts.push(`${already} already in library`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** "just now", "4 minutes ago", "2 hours ago", "3 days ago"; "" for unknown. */
export function relativeTimeAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** "Downloader online" while lastSeenAt is within 2 minutes (SPEC 8.3). */
export const DOWNLOADER_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export function downloaderStatus(
  lastSeenAt: string | null,
  nowMs: number,
): { online: boolean; text: string } {
  if (!lastSeenAt || Number.isNaN(Date.parse(lastSeenAt))) {
    return { online: false, text: "Downloader offline" };
  }
  if (nowMs - Date.parse(lastSeenAt) <= DOWNLOADER_ONLINE_WINDOW_MS) {
    return { online: true, text: "Downloader online" };
  }
  const ago = relativeTimeAgo(lastSeenAt, nowMs);
  return {
    online: false,
    text: ago ? `Downloader offline, last seen ${ago}` : "Downloader offline",
  };
}

/** "Artist · Album", either side may be blank (SPEC 10 list rows). */
export function rowSubtitle(artist: string, album: string | null | undefined): string {
  return [artist, album]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" · ");
}

export function pluralWaiting(count: number): string {
  return count === 1 ? "1 song waiting for your PC" : `${count} songs waiting for your PC`;
}
