/**
 * Browser clients for the T11 catalog routes and the catalog add
 * (POST /api/tracks with `{ catalog }`). Kept apart from api.ts so the v2
 * tickets built at the same time do not edit the same file.
 */
import type {
  CatalogAlbumResponse,
  CatalogArtistResponse,
  CatalogSearchResponse,
  CatalogTrack,
} from "@/lib/catalog-types";
import { ApiError, type AddLineResult } from "./api";

/** POST /api/tracks takes at most this many catalog songs per request. */
export const CATALOG_ADD_CHUNK = 50;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === "string" && body.error ? body.error : `Request failed (${response.status})`;
    throw new ApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

export function searchCatalog(q: string, signal?: AbortSignal): Promise<CatalogSearchResponse> {
  return getJson(`/api/catalog/search?q=${encodeURIComponent(q)}&type=all`, signal);
}

export function fetchCatalogAlbum(id: string, signal?: AbortSignal): Promise<CatalogAlbumResponse> {
  return getJson(`/api/catalog/album/${encodeURIComponent(id)}`, signal);
}

export function fetchCatalogArtist(id: string, signal?: AbortSignal): Promise<CatalogArtistResponse> {
  return getJson(`/api/catalog/artist/${encodeURIComponent(id)}`, signal);
}

/** Only the fields the add stores; list-only fields (thumbnail, flags) stay behind. */
function addPayload(track: CatalogTrack) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    coverUrl: track.coverUrl,
    durationSec: track.durationSec,
    isrc: track.isrc,
  };
}

/** Adds catalog songs, 50 per request, and returns every song's result in order. */
export async function addCatalogTracks(tracks: readonly CatalogTrack[]): Promise<AddLineResult[]> {
  const results: AddLineResult[] = [];
  for (let start = 0; start < tracks.length; start += CATALOG_ADD_CHUNK) {
    const chunk = tracks.slice(start, start + CATALOG_ADD_CHUNK);
    const response = await fetch("/api/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog: chunk.map(addPayload) }),
    });
    const body = (await response.json().catch(() => null)) as { results?: AddLineResult[]; error?: string } | null;
    if (!response.ok || !body?.results) {
      throw new ApiError(response.status, body?.error || `Could not add (${response.status})`);
    }
    results.push(...body.results.map((result) => ({ ...result, index: result.index + start })));
  }
  return results;
}

/** Catalog pages link here: /catalog/artist?id=deezer:27 and /catalog/album?id=deezer:302127. */
export function catalogArtistHref(id: string): string {
  return `/catalog/artist?id=${encodeURIComponent(id)}`;
}

export function catalogAlbumHref(id: string): string {
  return `/catalog/album?id=${encodeURIComponent(id)}`;
}
