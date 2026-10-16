/**
 * Pure helpers for the catalog screens (V2-PLAN T11), kept out of the
 * components so they can be unit tested in node.
 */
import type { CatalogAlbum, CatalogRecordType, CatalogTrack } from "@/lib/catalog-types";

/** Catalog search runs this long after the last key press (V2-PLAN T11: 300 ms). */
export const CATALOG_DEBOUNCE_MS = 300;
/** Shorter queries do not search the catalog. */
export const CATALOG_MIN_QUERY = 2;

/** "13 songs, 1 h 14 min" (same wording as the library's list summary). */
export function catalogSummary(tracks: readonly Pick<CatalogTrack, "durationSec">[]): string {
  const count = tracks.length === 1 ? "1 song" : `${tracks.length} songs`;
  const seconds = tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0);
  if (seconds <= 0) return count;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${count}, ${minutes} min`;
  return `${count}, ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export interface AlbumGroup<T extends CatalogAlbum> {
  title: string;
  albums: T[];
  testId: string;
}

const GROUPS: { title: string; types: CatalogRecordType[]; testId: string }[] = [
  { title: "Albums", types: ["album"], testId: "catalog-artist-albums" },
  { title: "Singles and EPs", types: ["single", "ep"], testId: "catalog-artist-singles" },
  { title: "Compilations", types: ["compile"], testId: "catalog-artist-compilations" },
];

/** An artist's releases split into Albums, Singles and EPs, Compilations (empty groups left out). */
export function groupReleases<T extends CatalogAlbum>(albums: readonly T[]): AlbumGroup<T>[] {
  return GROUPS.map((group) => ({
    title: group.title,
    testId: group.testId,
    albums: albums.filter((album) => group.types.includes(album.recordType)),
  })).filter((group) => group.albums.length > 0);
}

/** The songs "Add album" still has to add. */
export function songsToAdd<T extends CatalogTrack>(tracks: readonly T[], owned: (track: T) => boolean): T[] {
  return tracks.filter((track) => !owned(track));
}

export type SearchTab = "top" | "songs" | "artists" | "albums" | "youtube";
export const SEARCH_TABS: { id: SearchTab; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "songs", label: "Songs" },
  { id: "artists", label: "Artists" },
  { id: "albums", label: "Albums" },
  { id: "youtube", label: "YouTube" },
];

export function parseSearchTab(value: string | null): SearchTab {
  return SEARCH_TABS.some((tab) => tab.id === value) ? (value as SearchTab) : "top";
}

/** The search page address for a query and tab, so Back from an artist or album restores it. */
export function searchPageUrl(query: string, tab: SearchTab): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query);
  if (tab !== "top") params.set("tab", tab);
  const text = params.toString();
  return text ? `/search?${text}` : "/search";
}
