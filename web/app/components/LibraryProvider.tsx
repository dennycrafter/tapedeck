"use client";

/**
 * One library snapshot for the whole app (SPEC 8.6). Loads GET /api/library,
 * polls it every 5 s while the tab is visible (queue progress, "x ago"),
 * reloads when an add, edit or retry bumps the overlays' library version,
 * and hands every screen the derived views (albums, artists, playlists,
 * liked songs). Mutations update the snapshot right away and then confirm
 * with a refetch, so hearts and reorders feel instant.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  addToPlaylist as apiAddToPlaylist,
  createPlaylist as apiCreatePlaylist,
  deletePlaylist as apiDeletePlaylist,
  deleteTrack as apiDeleteTrack,
  ApiError,
  fetchLibrary,
  removeFromPlaylist as apiRemoveFromPlaylist,
  renamePlaylist as apiRenamePlaylist,
  reorderPlaylist as apiReorderPlaylist,
  retryTrack as apiRetryTrack,
  setAlbumFavorite as apiSetAlbumFavorite,
  setTrackLiked,
  type LibraryResponse,
  type PlaylistDto,
  type TrackDto,
} from "../lib/api";
import {
  albumKey,
  groupAlbums,
  groupArtists,
  likedSongs,
  normalizeLibrary,
  playlistViews,
  recentlyPlayed,
  toPlayerTrack,
  type AlbumView,
  type ArtistView,
  type PlaylistView,
} from "../lib/library-view";
import { loadSnapshot, saveSnapshot } from "../lib/offline-db";
import { flushPlays, removeDownload, setFromSnapshot } from "../lib/offline";
import { useOverlays } from "./Overlays";
import { usePlayer } from "./PlayerProvider";

const POLL_MS = 5000;

type Library = Required<LibraryResponse>;

export interface LibraryApi {
  library: Library | null;
  loading: boolean;
  error: string | null;
  byId: ReadonlyMap<string, TrackDto>;
  albums: AlbumView[];
  artists: ArtistView[];
  playlists: PlaylistView[];
  liked: TrackDto[];
  recent: TrackDto[];
  refetch(): Promise<void>;
  setLiked(track: TrackDto, liked: boolean): Promise<void>;
  deleteTrack(track: TrackDto): Promise<void>;
  retryTrack(track: TrackDto): Promise<void>;
  createPlaylist(name: string, trackIds?: string[]): Promise<PlaylistDto>;
  renamePlaylist(playlistId: string, name: string): Promise<void>;
  deletePlaylist(playlistId: string): Promise<void>;
  addToPlaylist(playlistId: string, trackIds: string[]): Promise<number>;
  removeFromPlaylist(playlistId: string, trackId: string): Promise<void>;
  reorderPlaylist(playlistId: string, trackIds: string[]): Promise<void>;
  setAlbumFavorite(album: AlbumView, favorite: boolean): Promise<void>;
}

const LibraryContext = createContext<LibraryApi | null>(null);

export function useLibrary(): LibraryApi {
  const api = useContext(LibraryContext);
  if (!api) throw new Error("useLibrary must be used inside LibraryProvider");
  return api;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** No answer at all (offline, server down), as opposed to an error reply. */
function isNetworkError(error: unknown): boolean {
  return !(error instanceof ApiError);
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { libraryVersion } = useOverlays();
  const player = usePlayer();
  const [library, setLibrary] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by every local mutation so a poll that started before it can not
  // overwrite the optimistic state with older data.
  const generation = useRef(0);

  const apply = useCallback(
    (data: LibraryResponse, fromSnapshot = false) => {
      if (!fromSnapshot) {
        // SPEC 8.9: keep the last good library on the phone for offline use.
        saveSnapshot(data).catch(() => undefined);
        void flushPlays();
      }
      setFromSnapshot(fromSnapshot);
      const normalized = normalizeLibrary(data);
      setLibrary(normalized);
      setError(null);
      // Edits and status changes reach the queued copies in the player.
      player.syncTracks(normalized.tracks.map(toPlayerTrack));
    },
    [player],
  );

  const refetch = useCallback(async () => {
    const started = generation.current;
    try {
      const data = await fetchLibrary();
      if (started === generation.current) apply(data);
    } catch (err) {
      if (isNetworkError(err)) setFromSnapshot(true);
      else setError(errorText(err));
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    const started = generation.current;
    fetchLibrary()
      .then((data) => {
        if (!cancelled && started === generation.current) apply(data);
      })
      .catch(async (err: unknown) => {
        if (cancelled) return;
        // Offline: open from the saved snapshot (SPEC 8.9).
        const snapshot = isNetworkError(err) ? await loadSnapshot() : null;
        if (cancelled) return;
        if (snapshot) apply(snapshot, true);
        else setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryVersion, apply]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);

  /** Optimistic local change, then the server call, then a confirming refetch. */
  const mutate = useCallback(
    async <T,>(local: ((current: Library) => Library) | null, call: () => Promise<T>): Promise<T> => {
      generation.current += 1;
      if (local) setLibrary((current) => (current ? local(current) : current));
      try {
        return await call();
      } catch (err) {
        await refetch(); // put the screen back to what the server has
        throw err;
      } finally {
        generation.current += 1;
        void refetch();
      }
    },
    [refetch],
  );

  const derived = useMemo(() => {
    const tracks = library?.tracks ?? [];
    const byId = new Map(tracks.map((track) => [track.id, track] as const));
    const albums = groupAlbums(tracks, library?.favoriteAlbums ?? []);
    return {
      byId,
      albums,
      artists: groupArtists(tracks, albums),
      playlists: playlistViews(library?.playlists ?? [], byId),
      liked: likedSongs(tracks),
      recent: recentlyPlayed(library?.recentlyPlayed ?? [], byId),
    };
  }, [library]);

  const api = useMemo<LibraryApi>(
    () => ({
      library,
      loading,
      error,
      ...derived,
      refetch,
      setLiked: (track, liked) =>
        mutate(
          (current) => ({
            ...current,
            tracks: current.tracks.map((candidate) =>
              candidate.id === track.id
                ? {
                    ...candidate,
                    liked,
                    likedAt: liked ? (candidate.likedAt ?? new Date().toISOString()) : null,
                  }
                : candidate,
            ),
          }),
          () => setTrackLiked(track.id, liked),
        ).then(() => undefined),
      deleteTrack: (track) =>
        mutate(
          (current) => ({
            ...current,
            tracks: current.tracks.filter((candidate) => candidate.id !== track.id),
            playlists: current.playlists.map((playlist) => ({
              ...playlist,
              trackIds: playlist.trackIds.filter((id) => id !== track.id),
            })),
            recentlyPlayed: current.recentlyPlayed.filter((id) => id !== track.id),
          }),
          async () => {
            player.removeTrack(track.id);
            await apiDeleteTrack(track.id);
            // SPEC 8.6: deleting a song also removes this device's offline copy.
            await removeDownload(track.id).catch(() => undefined);
          },
        ),
      retryTrack: (track) =>
        mutate(
          (current) => ({
            ...current,
            tracks: current.tracks.map((candidate) =>
              candidate.id === track.id ? { ...candidate, status: "waiting", error: "" } : candidate,
            ),
          }),
          () => apiRetryTrack(track.id),
        ),
      createPlaylist: (name, trackIds = []) =>
        mutate(null, async () => {
          const playlist = await apiCreatePlaylist(name);
          if (trackIds.length > 0) await apiAddToPlaylist(playlist.id, trackIds);
          return playlist;
        }),
      renamePlaylist: (playlistId, name) =>
        mutate(
          (current) => ({
            ...current,
            playlists: current.playlists.map((playlist) =>
              playlist.id === playlistId ? { ...playlist, name } : playlist,
            ),
          }),
          () => apiRenamePlaylist(playlistId, name),
        ),
      deletePlaylist: (playlistId) =>
        mutate(
          (current) => ({
            ...current,
            playlists: current.playlists.filter((playlist) => playlist.id !== playlistId),
          }),
          () => apiDeletePlaylist(playlistId),
        ),
      addToPlaylist: (playlistId, trackIds) =>
        mutate(
          (current) => ({
            ...current,
            playlists: current.playlists.map((playlist) =>
              playlist.id === playlistId
                ? {
                    ...playlist,
                    trackIds: [...playlist.trackIds, ...trackIds.filter((id) => !playlist.trackIds.includes(id))],
                  }
                : playlist,
            ),
          }),
          async () => (await apiAddToPlaylist(playlistId, trackIds)).added,
        ),
      removeFromPlaylist: (playlistId, trackId) =>
        mutate(
          (current) => ({
            ...current,
            playlists: current.playlists.map((playlist) =>
              playlist.id === playlistId
                ? { ...playlist, trackIds: playlist.trackIds.filter((id) => id !== trackId) }
                : playlist,
            ),
          }),
          () => apiRemoveFromPlaylist(playlistId, trackId),
        ),
      reorderPlaylist: (playlistId, trackIds) =>
        mutate(
          (current) => ({
            ...current,
            playlists: current.playlists.map((playlist) =>
              playlist.id === playlistId ? { ...playlist, trackIds: [...trackIds] } : playlist,
            ),
          }),
          () => apiReorderPlaylist(playlistId, trackIds),
        ),
      setAlbumFavorite: (album, favorite) =>
        mutate(
          (current) => {
            const key = albumKey(album.album, album.albumArtist);
            const rest = current.favoriteAlbums.filter(
              (fav) => albumKey(fav.album, fav.albumArtist) !== key,
            );
            return {
              ...current,
              favoriteAlbums: favorite
                ? [
                    { album: album.album, albumArtist: album.albumArtist, createdAt: new Date().toISOString() },
                    ...rest,
                  ]
                : rest,
            };
          },
          () => apiSetAlbumFavorite(album.album, album.albumArtist, favorite),
        ),
    }),
    [library, loading, error, derived, refetch, mutate, player],
  );

  return <LibraryContext.Provider value={api}>{children}</LibraryContext.Provider>;
}
