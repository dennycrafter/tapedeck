"use client";

/**
 * Library page (SPEC 8.3/8.4, 8.6 list view, T1 scope): every track newest
 * first, status dots and labels, Retry on failed rows, header downloader
 * status. Polls every 5 s while the tab is visible so queue progress and
 * the "x ago" label stay current. A middle column (search, sort, albums)
 * arrives in T2; the single-column shell is laid out for it now.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fetchLibrary, retryTrack, type LibraryResponse, type TrackDto } from "./lib/api";
import { TrackRow } from "./components/TrackRow";
import { DownloaderStatus } from "./components/DownloaderStatus";
import { useOverlays } from "./components/Overlays";
import { usePlayer } from "./components/PlayerProvider";
import { PlusIcon } from "./components/icons";

const POLL_MS = 5000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function LibraryPage() {
  const { libraryVersion, openAdd, showToast } = useOverlays();
  const player = usePlayer();
  const playerState = useSyncExternalStore(player.subscribe, player.getState, player.getState);

  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Background refetch for the poll interval and post-action refreshes; the
  // setStates live in promise continuations, not the fetch call itself.
  const refetch = useCallback(
    () =>
      fetchLibrary()
        .then((data) => {
          setLibrary(data);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          setLoadError(errorText(error));
        }),
    [],
  );

  // Initial load; reloaded whenever add/retry changes library data.
  useEffect(() => {
    let cancelled = false;
    fetchLibrary()
      .then((data) => {
        if (cancelled) return;
        setLibrary(data);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryVersion]);

  // Watch the queue: poll while the tab is visible (5 s).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);

  const tracks = useMemo(() => library?.tracks ?? [], [library]);
  const playable = useMemo(() => tracks.filter((track) => track.status === "ready"), [tracks]);
  const currentId = playerState.index >= 0 ? (playerState.queue[playerState.index]?.id ?? null) : null;

  const handlePlay = useCallback(
    (track: TrackDto) => {
      // Playing from a list sets the queue to that list (SPEC 8.8) — ready
      // songs only, waiting/failed entries are skipped.
      const start = playable.findIndex((candidate) => candidate.id === track.id);
      if (start >= 0) player.playTracks(playable, start);
    },
    [playable, player],
  );

  const handleRetry = useCallback(
    async (track: TrackDto) => {
      setRetryingId(track.id);
      try {
        await retryTrack(track.id);
        showToast("Retry queued");
        await refetch();
      } catch (error) {
        showToast(errorText(error));
      } finally {
        setRetryingId(null);
      }
    },
    [refetch, showToast],
  );

  return (
    <main className="pb-40 pt-6 lg:pb-28">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">Library</h1>
          {library && <DownloaderStatus snapshot={library.downloader} />}
        </div>
        <button
          type="button"
          onClick={openAdd}
          data-testid="add-open"
          className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-2 text-sm font-medium text-silver hover:border-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
        >
          <PlusIcon /> Add
        </button>
      </header>

      {loading && (
        <p className="mt-8 text-sm text-muted" data-testid="library-loading">
          Loading your library...
        </p>
      )}

      {!loading && loadError && (
        <div className="mt-8 rounded-box border border-line bg-surface p-4" data-testid="library-error">
          <p className="text-sm text-bad">Could not load your library. {loadError}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-2 rounded-btn border border-line px-3 py-1.5 text-sm text-silver hover:border-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !loadError && tracks.length === 0 && (
        <div className="mt-8 rounded-box border border-line bg-surface p-6 text-center" data-testid="library-empty">
          <p className="font-semibold">No songs yet.</p>
          <p className="mt-1 text-sm text-muted">
            Paste a YouTube or SoundCloud link to add your first song.
          </p>
          <button
            type="button"
            onClick={openAdd}
            data-testid="add-open-empty"
            className="mt-4 rounded-btn bg-accent px-4 py-2 font-medium text-bg hover:bg-accent-ink focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          >
            Add songs
          </button>
        </div>
      )}

      {!loading && !loadError && tracks.length > 0 && (
        <ul
          className="mt-4 divide-y divide-line rounded-box border border-line bg-surface"
          data-testid="track-list"
        >
          {tracks.map((track) => (
            <li key={track.id}>
              <TrackRow
                track={track}
                onPlay={handlePlay}
                onRetry={(candidate) => void handleRetry(candidate)}
                retrying={retryingId === track.id}
                current={currentId === track.id}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
