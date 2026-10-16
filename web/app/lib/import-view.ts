/**
 * Plain-words text for the import screens (V2-PLAN T13). Pure, so the unit
 * tests cover the exact wording.
 */
import type { ChecklistPlaylist, ImportJobStatus, ImportProgress, ServiceOption } from "@/lib/import-types";

/** "1 song", "12 songs", or "" when the source did not say. */
export function songCount(count: number | null | undefined): string {
  if (count == null) return "";
  return count === 1 ? "1 song" : `${count} songs`;
}

/** "142 of 150 ready, 6 waiting, 2 need a look"; parts that are 0 are left out. */
export function progressSentence(progress: Pick<ImportProgress, "total" | "ready" | "waiting" | "needsLook" | "pending">): string {
  const waiting = progress.waiting + progress.pending;
  const parts = [`${progress.ready} of ${progress.total} ready`];
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (progress.needsLook > 0) parts.push(`${progress.needsLook} ${progress.needsLook === 1 ? "needs" : "need"} a look`);
  return parts.join(", ");
}

/** The import's own state, for "Your imports". */
export function jobStatusText(status: ImportJobStatus): string {
  switch (status) {
    case "login":
      return "Waiting for you to log in";
    case "new":
      return "Finding your playlists";
    case "waiting_pc":
      return "Waiting for your PC";
    case "listed":
      return "Pick your playlists";
    case "importing":
      return "Importing";
    case "done":
      return "Imported";
    case "failed":
      return "Didn't work";
  }
}

/** The Import button on the checklist. */
export function importButtonLabel(selected: number): string {
  if (selected === 0) return "Tick a playlist to import";
  return selected === 1 ? "Import 1 playlist" : `Import ${selected} playlists`;
}

/** Playlists ticked at first: everything not imported before. */
export function defaultSelection(playlists: readonly ChecklistPlaylist[]): string[] {
  return playlists.filter((playlist) => !playlist.importedPlaylistId).map((playlist) => playlist.ref);
}

/** Lines of a paste box, trimmed, empty ones dropped. */
export function pastedLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 0 to 100: songs ready to play out of all. */
export function percentReady(progress: Pick<ImportProgress, "total" | "ready">): number {
  if (progress.total === 0) return 0;
  return Math.round((progress.ready / progress.total) * 100);
}

/** "Spotify", "Spotify and Apple Music", "Spotify, Apple Music and 2 more". */
export function serviceNames(services: readonly Pick<ServiceOption, "label">[]): string {
  const labels = services.map((service) => service.label);
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  if (labels.length === 3) return `${labels[0]}, ${labels[1]} and ${labels[2]}`;
  return `${labels[0]}, ${labels[1]} and ${labels.length - 2} more`;
}
