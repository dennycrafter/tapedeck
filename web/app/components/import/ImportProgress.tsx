"use client";

/**
 * Steps 4 and 5 of the playlist import (V2-PLAN T13): importing, then the
 * progress screen, "142 of 150 ready, 6 waiting, 2 need a look", live from
 * the database. A song that needs a look offers "Pick another version"
 * (T12, catalog songs) or "Try again" (songs with their own link), and
 * "Skip".
 */
import Link from "next/link";
import { useState } from "react";
import type { ImportJobView, NeedsLookSong } from "@/lib/import-types";
import type { MatchInfo } from "@/lib/track-v2";
import { retryTrack, type TrackDto } from "../../lib/api";
import { skipImportSong } from "../../lib/import-api";
import { percentReady, progressSentence } from "../../lib/import-view";
import { PickVersionDialog } from "../PickVersionDialog";
import { BTN_QUIET, BTN_SECONDARY, FOCUS } from "../ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Just what PickVersionDialog reads: the id, the saved copies and the current pick. */
function dialogTrack(song: NeedsLookSong): TrackDto {
  return {
    id: song.trackId ?? "",
    source: "catalog",
    sourceUrl: "",
    title: song.title,
    artist: song.artist,
    album: null,
    coverUrl: null,
    durationSec: null,
    status: "failed",
    error: song.error,
    createdAt: "",
    matchInfo: (song.matchInfo as MatchInfo | null) ?? null,
    resolvedUrl: song.resolvedUrl,
  };
}

interface Props {
  job: ImportJobView;
  /** The import screen refetches the job. */
  onRefresh(): void;
  onJob(job: ImportJobView): void;
  /** Set when the browser-driven import stopped with an error. */
  runError: string | null;
  onRetryRun(): void;
}

export function ImportProgress({ job, onRefresh, onJob, runError, onRetryRun }: Props) {
  const [picking, setPicking] = useState<NeedsLookSong | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = job.progress;
  const reading = job.status === "importing" && job.selected.some((entry) => !entry.fetched);
  const importing = job.status === "importing" || job.status === "waiting_pc";

  async function act(itemId: string, action: () => Promise<void>) {
    if (busyItem) return;
    setBusyItem(itemId);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyItem(null);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="import-progress" data-status={job.status}>
      <section className="rounded-box border border-line bg-surface p-4">
        <h2 className="text-base font-semibold" data-testid="import-progress-title">
          {job.status === "done" ? "Imported" : job.status === "waiting_pc" ? "Waiting for your PC" : "Importing..."}
        </h2>
        {progress && progress.total > 0 && (
          <>
            <p className="mt-2 text-lg font-semibold tabular-nums" data-testid="import-progress-text">
              {progressSentence(progress)}
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
              <div className="h-full bg-ok transition-[width]" style={{ width: `${percentReady(progress)}%` }} />
            </div>
          </>
        )}
        <p className="mt-3 text-sm text-muted" data-testid="import-progress-note">
          {job.status === "waiting_pc"
            ? "Your PC reads these playlists. Keep the downloader running; this page updates by itself."
            : reading
              ? "Reading your playlists..."
              : importing
                ? "Adding songs. Keep this page open until it says Imported."
                : "Your PC downloads the songs now. You can close this page; they show up in your library as they finish."}
        </p>
        {progress && progress.skipped > 0 && (
          <p className="mt-1 text-xs text-muted">{progress.skipped === 1 ? "1 song skipped" : `${progress.skipped} songs skipped`}</p>
        )}
      </section>

      {runError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-box border border-bad/40 bg-surface p-3">
          <p className="text-sm text-bad">{runError}</p>
          <button type="button" onClick={onRetryRun} className={`${BTN_SECONDARY} min-h-11`} data-testid="import-resume">
            Try again
          </button>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Playlists</h2>
        <ul className="divide-y divide-line overflow-hidden rounded-box border border-line bg-surface">
          {job.selected.map((entry) => (
            <li key={entry.ref}>
              {entry.playlistId ? (
                <Link
                  href={`/playlist?id=${entry.playlistId}`}
                  className={`flex min-h-12 flex-col justify-center px-3 py-2 hover:bg-surface-2 ${FOCUS}`}
                  data-testid="import-progress-playlist"
                >
                  <span className="truncate text-sm font-semibold">{entry.name}</span>
                  {entry.error && <span className="text-xs text-bad">{entry.error}</span>}
                </Link>
              ) : (
                <span className="flex min-h-12 items-center px-3 text-sm">{entry.name}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {progress && progress.needsLookSongs.length > 0 && (
        <section data-testid="import-needs-look">
          <h2 className="text-sm font-semibold">Need a look</h2>
          <p className="mt-1 text-xs text-muted">Your PC couldn&apos;t find these. Pick a version yourself, or skip them.</p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-bad">
              {error}
            </p>
          )}
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-box border border-line bg-surface">
            {progress.needsLookSongs.map((song) => {
              const canPick = song.source === "catalog" && song.trackId !== null;
              const canRetry = !canPick && song.trackId !== null;
              return (
                <li
                  key={song.itemId}
                  className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
                  data-testid="import-look-song"
                  data-track-id={song.trackId ?? ""}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{song.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {[song.artist, song.error].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {canPick && (
                      <button
                        type="button"
                        disabled={busyItem !== null}
                        onClick={() => setPicking(song)}
                        className={`${BTN_SECONDARY} min-h-11`}
                        data-testid="import-look-pick"
                      >
                        Pick another version
                      </button>
                    )}
                    {canRetry && (
                      <button
                        type="button"
                        disabled={busyItem !== null}
                        onClick={() => void act(song.itemId, async () => {
                          await retryTrack(song.trackId as string);
                          onRefresh();
                        })}
                        className={`${BTN_SECONDARY} min-h-11`}
                        data-testid="import-look-retry"
                      >
                        Try again
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyItem !== null}
                      onClick={() => void act(song.itemId, async () => onJob(await skipImportSong(job.id, song.itemId)))}
                      className={`${BTN_QUIET} min-h-11`}
                      data-testid="import-look-skip"
                    >
                      Skip
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {picking && (
        <PickVersionDialog
          track={dialogTrack(picking)}
          onClose={() => {
            setPicking(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
