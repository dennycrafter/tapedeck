/**
 * Typed clients for the API routes the UI consumes. The add, retry and
 * playback-URL routes are owned by the T1b/T1c builders (SPEC 8.2/8.3/8.8);
 * this module only describes their wire contracts.
 *
 * Coordination note (T1d): the SPEC names `GET /api/library` and the profile
 * downloader data but does not spell out their response shapes; the
 * `LibraryResponse` / `DownloaderSetupResponse` types here are the UI's
 * proposed contract from the tracks/settings schema (SPEC 6, 8.3, 8.6).
 * If the sibling route lands with a different shape, this file is the single
 * place to align.
 */
import type { TrackStatus } from "@/lib/player/store";
import type { TrackV2Fields } from "@/lib/track-v2";

/**
 * v2 fields (web/lib/track-v2.ts) are optional here because offline snapshots
 * saved before v2 lack them; normalizeLibrary fills the defaults, so every
 * track the screens get has them.
 */
export interface TrackDto extends Partial<TrackV2Fields> {
  id: string;
  source: "youtube" | "soundcloud" | "catalog";
  sourceUrl: string;
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  status: TrackStatus;
  error: string;
  createdAt: string;
  /** Album grouping key with `album` (SPEC 8.6); null for hand-edited albums. */
  albumArtist?: string | null;
  liked?: boolean;
  likedAt?: string | null;
  bytes?: number | null;
  appleMusic?: boolean;
}

export interface DownloaderSnapshot {
  lastSeenAt: string | null;
  waitingCount: number;
}

/** One playlist in the library snapshot; `trackIds` are in playlist order. */
export interface PlaylistDto {
  id: string;
  name: string;
  description: string;
  position: number;
  createdAt: string | null;
  updatedAt: string | null;
  trackIds: string[];
}

export interface FavoriteAlbumDto {
  album: string;
  albumArtist: string;
  createdAt: string | null;
}

/** GET /api/library (web/lib/library.ts `LibrarySnapshot`). */
export interface LibraryResponse {
  tracks: TrackDto[];
  downloader: DownloaderSnapshot;
  playlists?: PlaylistDto[];
  favoriteAlbums?: FavoriteAlbumDto[];
  /** Track ids, most recent first, distinct, at most 20. */
  recentlyPlayed?: string[];
  displayName?: string;
  appleMusicExport?: boolean;
}

export interface ProfileResponse {
  displayName: string;
  stats: { songs: number; secondsListened: number; playsThisMonth: number; storageBytes: number };
  topArtists: { artist: string; plays: number }[];
}

export type AddOutcome = "added" | "already" | "error";

/** POST /api/tracks line result: T1c's contract from web/app/api/tracks/route.ts. */
export interface AddLineResult {
  /** Position of the line in the textarea, preserving paste order. */
  index: number;
  line: string;
  status: AddOutcome;
  /** "Added", "Already in your library", or the per-line error text. */
  message: string;
  /** The created track, present only for added lines. */
  track?: AddLineTrack;
}

export interface AddLineTrack {
  id: string;
  source: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  durationSec: number | null;
  status: string;
}

export interface AddTracksResponse {
  results: AddLineResult[];
}

export interface DownloaderSetupResponse {
  appUrl: string;
  agentToken: string;
  lastSeenAt: string | null;
  waitingCount: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    // Error bodies carry { error } on the routes that validate input.
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === "string" && body.error.length > 0 ? body.error : "";
    throw new ApiError(
      response.status,
      detail || `${init?.method ?? "GET"} ${url} failed (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

export function fetchLibrary(): Promise<LibraryResponse> {
  return fetchJson<LibraryResponse>("/api/library");
}

export function addTracks(urls: string[]): Promise<AddTracksResponse> {
  return fetchJson<AddTracksResponse>("/api/tracks", {
    method: "POST",
    body: JSON.stringify({ urls }),
  });
}

/** One GET /api/search result (SPEC 8.7). */
export interface SearchHit {
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl: string | null;
  durationSec: number | null;
  inLibrary: boolean;
}

export interface SearchResponse {
  results: SearchHit[];
  /** Present when search is off (no key) or the daily quota ran out (SPEC 8.7). */
  message?: string;
}

export function searchYouTube(q: string): Promise<SearchResponse> {
  return fetchJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
}

/**
 * PATCH /api/tracks/:id: edit details (SPEC 8.4). Omitted fields stay
 * unchanged; empty album/cover clear them. Returns the updated track.
 */
export function editTrack(
  trackId: string,
  input: { title?: string; artist?: string; album?: string | null; coverUrl?: string | null },
): Promise<TrackDto> {
  return fetchJson<TrackDto>(`/api/tracks/${encodeURIComponent(trackId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** POST /api/tracks/:id/restore: restore the raw title/artist (SPEC 8.4). */
export async function restoreTrack(trackId: string): Promise<TrackDto> {
  return fetchJson<TrackDto>(`/api/tracks/${encodeURIComponent(trackId)}/restore`, { method: "POST" });
}

/** POST /api/tracks/:id/retry → status waiting, attempts 0 (SPEC 8.3). */
export async function retryTrack(trackId: string): Promise<void> {
  const response = await fetch(`/api/tracks/${encodeURIComponent(trackId)}/retry`, { method: "POST" });
  if (!response.ok) {
    throw new ApiError(response.status, `Retry failed (${response.status})`);
  }
}

export function fetchDownloaderSetup(): Promise<DownloaderSetupResponse> {
  return fetchJson<DownloaderSetupResponse>("/api/profile/downloader");
}

const enc = encodeURIComponent;

/** PUT /api/tracks/:id/like (SPEC 8.6). */
export function setTrackLiked(trackId: string, liked: boolean): Promise<TrackDto> {
  return fetchJson<TrackDto>(`/api/tracks/${enc(trackId)}/like`, {
    method: "PUT",
    body: JSON.stringify({ liked }),
  });
}

/** DELETE /api/tracks/:id: the stored file, then the row (SPEC 8.6). */
export async function deleteTrack(trackId: string): Promise<void> {
  await fetchJson<{ ok: true }>(`/api/tracks/${enc(trackId)}`, { method: "DELETE" });
}

export function createPlaylist(name: string): Promise<PlaylistDto> {
  return fetchJson<PlaylistDto>("/api/playlists", { method: "POST", body: JSON.stringify({ name }) });
}

export async function renamePlaylist(playlistId: string, name: string): Promise<void> {
  await fetchJson<{ ok: true }>(`/api/playlists/${enc(playlistId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  await fetchJson<{ ok: true }>(`/api/playlists/${enc(playlistId)}`, { method: "DELETE" });
}

/** Append songs; songs already in the playlist stay where they are. */
export function addToPlaylist(playlistId: string, trackIds: string[]): Promise<{ added: number }> {
  return fetchJson<{ added: number }>(`/api/playlists/${enc(playlistId)}/tracks`, {
    method: "POST",
    body: JSON.stringify({ trackIds }),
  });
}

/** The playlist's new full order after a drag. 409 when the playlist changed meanwhile. */
export async function reorderPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
  await fetchJson<{ ok: true }>(`/api/playlists/${enc(playlistId)}/tracks`, {
    method: "PUT",
    body: JSON.stringify({ trackIds }),
  });
}

export async function removeFromPlaylist(playlistId: string, trackId: string): Promise<void> {
  await fetchJson<{ ok: true }>(`/api/playlists/${enc(playlistId)}/tracks/${enc(trackId)}`, {
    method: "DELETE",
  });
}

/** PUT /api/albums/favorite: the heart on an album page (SPEC 8.6). */
export async function setAlbumFavorite(album: string, albumArtist: string, favorite: boolean): Promise<void> {
  await fetchJson<{ ok: true }>("/api/albums/favorite", {
    method: "PUT",
    body: JSON.stringify({ album, albumArtist, favorite }),
  });
}

export function fetchProfile(): Promise<ProfileResponse> {
  return fetchJson<ProfileResponse>("/api/profile");
}

export function setDisplayName(displayName: string): Promise<{ displayName: string }> {
  return fetchJson<{ displayName: string }>("/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ displayName }),
  });
}

/** PUT /api/settings/apple-music: "Also add to Apple Music on my PC" (SPEC 8.11). */
export function setAppleMusicExport(on: boolean): Promise<{ appleMusicExport: boolean }> {
  return fetchJson<{ appleMusicExport: boolean }>("/api/settings/apple-music", {
    method: "PUT",
    body: JSON.stringify({ on }),
  });
}

/** POST /api/tracks/:id/apple-music: the song menu's "Add to Apple Music" (SPEC 8.11). */
export function addToAppleMusic(trackId: string): Promise<TrackDto> {
  return fetchJson<TrackDto>(`/api/tracks/${enc(trackId)}/apple-music`, { method: "POST" });
}
