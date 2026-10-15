/**
 * Pure views over the library snapshot (SPEC 8.6). The server sends one flat
 * snapshot; songs, liked songs, albums, artists, playlist contents and
 * playlist covers are all derived here, on the client, so the same code
 * works from the offline copy later (SPEC 8.9).
 */
import type { PlayerTrack } from "@/lib/player/store";
import type { FavoriteAlbumDto, LibraryResponse, PlaylistDto, TrackDto } from "./api";
import { withV2Defaults } from "../../lib/track-v2";

export type SongSort = "recent" | "title" | "artist";

export const SONG_SORTS: { value: SongSort; label: string }[] = [
  { value: "recent", label: "Recently added" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
];

export interface AlbumView {
  /** Stable key: album + album artist. */
  key: string;
  album: string;
  albumArtist: string;
  coverUrl: string | null;
  /** Songs in added order (oldest first, SPEC 8.6). */
  tracks: TrackDto[];
  favorite: boolean;
}

export interface ArtistView {
  artist: string;
  coverUrl: string | null;
  /** Newest first. */
  tracks: TrackDto[];
  albums: AlbumView[];
}

export interface PlaylistView extends PlaylistDto {
  tracks: TrackDto[];
  /** Up to 4 distinct covers for the 2x2 grid (SPEC 8.6). */
  covers: string[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** The album artist used for grouping: the stored one, else the song's artist. */
export function albumArtistOf(track: Pick<TrackDto, "albumArtist" | "artist">): string {
  const value = track.albumArtist?.trim();
  return value ? value : track.artist.trim();
}

export function albumKey(album: string, albumArtist: string): string {
  return `${album}\u0000${albumArtist}`;
}

function time(iso: string | null | undefined): number {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Songs tab: every track, sorted by the chosen order. */
export function sortSongs(tracks: readonly TrackDto[], sort: SongSort): TrackDto[] {
  const list = [...tracks];
  if (sort === "title") {
    list.sort((a, b) => collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist));
  } else if (sort === "artist") {
    list.sort((a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title));
  } else {
    list.sort((a, b) => time(b.createdAt) - time(a.createdAt));
  }
  return list;
}

/** Liked songs, newest like first (SPEC 8.6). */
export function likedSongs(tracks: readonly TrackDto[]): TrackDto[] {
  return tracks.filter((track) => track.liked).sort((a, b) => time(b.likedAt) - time(a.likedAt));
}

/** Albums: tracks with an album, grouped by album + album artist. Favourites first. */
export function groupAlbums(
  tracks: readonly TrackDto[],
  favorites: readonly FavoriteAlbumDto[] = [],
): AlbumView[] {
  const favoriteOrder = new Map<string, number>();
  favorites.forEach((fav, index) => favoriteOrder.set(albumKey(fav.album, fav.albumArtist), index));

  const byKey = new Map<string, AlbumView>();
  // Added order: oldest first inside an album.
  const oldestFirst = [...tracks].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  for (const track of oldestFirst) {
    const album = track.album?.trim();
    if (!album) continue;
    const artist = albumArtistOf(track);
    const key = albumKey(album, artist);
    let view = byKey.get(key);
    if (!view) {
      view = { key, album, albumArtist: artist, coverUrl: null, tracks: [], favorite: favoriteOrder.has(key) };
      byKey.set(key, view);
    }
    view.tracks.push(track);
    if (!view.coverUrl && track.coverUrl) view.coverUrl = track.coverUrl;
  }

  return [...byKey.values()].sort((a, b) => {
    const fa = favoriteOrder.get(a.key);
    const fb = favoriteOrder.get(b.key);
    if (fa !== undefined || fb !== undefined) {
      if (fa === undefined) return 1;
      if (fb === undefined) return -1;
      return fa - fb; // newest favourite first (the snapshot is newest first)
    }
    return collator.compare(a.album, b.album) || collator.compare(a.albumArtist, b.albumArtist);
  });
}

/** Artists: grouped by the exact artist string (SPEC 8.6), A to Z. */
export function groupArtists(tracks: readonly TrackDto[], albums: readonly AlbumView[]): ArtistView[] {
  const byArtist = new Map<string, ArtistView>();
  const newestFirst = [...tracks].sort((a, b) => time(b.createdAt) - time(a.createdAt));
  for (const track of newestFirst) {
    const artist = track.artist.trim();
    if (!artist) continue;
    let view = byArtist.get(artist);
    if (!view) {
      view = { artist, coverUrl: null, tracks: [], albums: [] };
      byArtist.set(artist, view);
    }
    view.tracks.push(track);
    if (!view.coverUrl && track.coverUrl) view.coverUrl = track.coverUrl;
  }
  for (const album of albums) {
    const owners = new Set(album.tracks.map((track) => track.artist.trim()));
    owners.add(album.albumArtist);
    for (const owner of owners) {
      const view = byArtist.get(owner);
      if (view && !view.albums.includes(album)) view.albums.push(album);
    }
  }
  return [...byArtist.values()].sort((a, b) => collator.compare(a.artist, b.artist));
}

/** Up to 4 distinct covers, in playlist order (SPEC 8.6: 2x2 grid). */
export function playlistCovers(tracks: readonly TrackDto[]): string[] {
  const covers: string[] = [];
  for (const track of tracks) {
    if (track.coverUrl && !covers.includes(track.coverUrl)) covers.push(track.coverUrl);
    if (covers.length === 4) break;
  }
  return covers;
}

export function playlistViews(
  playlists: readonly PlaylistDto[],
  byId: ReadonlyMap<string, TrackDto>,
): PlaylistView[] {
  return playlists.map((playlist) => {
    const tracks = playlist.trackIds
      .map((id) => byId.get(id))
      .filter((track): track is TrackDto => track !== undefined);
    return { ...playlist, tracks, covers: playlistCovers(tracks) };
  });
}

/** Recently played track ids resolved to songs still in the library. */
export function recentlyPlayed(ids: readonly string[], byId: ReadonlyMap<string, TrackDto>): TrackDto[] {
  return ids.map((id) => byId.get(id)).filter((track): track is TrackDto => track !== undefined);
}

/** Case-insensitive search across title, artist and album. */
export function filterTracks(tracks: readonly TrackDto[], query: string): TrackDto[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return tracks.filter((track) => {
    const haystack = `${track.title} ${track.artist} ${track.album ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function toPlayerTrack(track: TrackDto): PlayerTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.coverUrl,
    status: track.status,
    durationSec: track.durationSec,
    // v2 playback settings (T10 trim, T14 speed); absent means the defaults.
    autoTrimStartSec: track.autoTrimStartSec ?? null,
    autoTrimEndSec: track.autoTrimEndSec ?? null,
    trimStartSec: track.trimStartSec ?? null,
    trimEndSec: track.trimEndSec ?? null,
    playbackRate: track.playbackRate ?? 1,
    preservePitch: track.preservePitch ?? true,
  };
}

/**
 * Playing from a list sets the queue to that list starting at the tapped
 * song; waiting and failed songs are skipped (SPEC 8.8). Returns null when
 * the tapped song is not playable.
 */
export function queueFrom(
  list: readonly TrackDto[],
  start: TrackDto | null,
  /** Offline, only downloaded songs can play (SPEC 8.9). */
  canPlay: (track: TrackDto) => boolean = (track) => track.status === "ready",
): { tracks: PlayerTrack[]; index: number } | null {
  const ready = list.filter((track) => track.status === "ready" && canPlay(track));
  if (ready.length === 0) return null;
  const index = start ? ready.findIndex((track) => track.id === start.id) : 0;
  if (index < 0) return null;
  return { tracks: ready.map(toPlayerTrack), index };
}

/** Total runtime as "12 songs, 48 min" for page headers. */
export function listSummary(tracks: readonly TrackDto[]): string {
  const count = tracks.length === 1 ? "1 song" : `${tracks.length} songs`;
  const seconds = tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0);
  if (seconds <= 0) return count;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${count}, ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${count}, ${hours} h ${rest} min`;
}

/** Time-of-day greeting is not in the SPEC: Home says "Hey {name}". */
export function greeting(displayName: string | undefined): string {
  const name = displayName?.trim();
  return name ? `Hey ${name}` : "Hey";
}

/** Fills the optional snapshot fields so screens never deal with undefined. */
export function normalizeLibrary(data: LibraryResponse): Required<LibraryResponse> {
  return {
    // Snapshots saved before v2 lack the v2 fields (V2-PLAN T9).
    tracks: data.tracks.map(withV2Defaults),
    downloader: data.downloader,
    playlists: data.playlists ?? [],
    favoriteAlbums: data.favoriteAlbums ?? [],
    recentlyPlayed: data.recentlyPlayed ?? [],
    displayName: data.displayName ?? "",
    appleMusicExport: data.appleMusicExport ?? false,
  };
}

/** /album?name=..&artist=.. and /artist?name=.. (search params decode reliably). */
export function albumHref(album: string, albumArtist: string): string {
  return `/album?${new URLSearchParams({ name: album, artist: albumArtist }).toString()}`;
}

export function artistHref(artist: string): string {
  return `/artist?${new URLSearchParams({ name: artist }).toString()}`;
}

/** Profile stats formatting (SPEC 8.6). */
export function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 10) return hours.toFixed(1);
  return Math.round(hours).toLocaleString("en-US");
}

/** "3.2 of 10 GB" (SPEC 8.6). */
export function formatStorage(bytes: number, limitBytes: number): string {
  const gb = bytes / 1024 ** 3;
  const limit = Math.round(limitBytes / 1024 ** 3);
  const shown = gb === 0 ? "0" : gb.toFixed(1);
  return `${shown} of ${limit} GB`;
}
