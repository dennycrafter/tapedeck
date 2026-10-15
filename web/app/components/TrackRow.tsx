"use client";

/**
 * One song row (SPEC 8.3/8.8/10): 44px cover, bold title over "Artist ·
 * Album", duration on the right for ready songs, a status dot plus muted
 * text for the others, Retry on failed rows, and the "..." menu. Only ready
 * songs are playable: the `track-row` element is a button for them and a
 * plain div for the rest (greyed out). The menu sits beside it, never
 * inside, so buttons are not nested.
 */
import type { ReactNode } from "react";
import { Cover } from "./Cover";
import { SongMenu } from "./SongMenu";
import { DownloadedIcon, HeartIcon, VolumeIcon } from "./icons";
import { useOffline } from "./useOffline";
import { canPlayNow } from "../lib/offline";
import { useLibrary } from "./LibraryProvider";
import { useOverlays } from "./Overlays";
import { formatDuration } from "@/lib/player/format";
import { STATUS_META, rowSubtitle, statusLabel } from "../lib/ui";
import type { TrackDto } from "../lib/api";

interface TrackRowProps {
  track: TrackDto;
  onPlay(track: TrackDto): void;
  /** True when this track is the one loaded in the player. */
  current: boolean;
  /** On a playlist page: the menu offers "Remove from this playlist". */
  playlistId?: string;
  /** Leading slot, e.g. the drag handle on a playlist page. */
  leading?: ReactNode;
}

export function TrackRow({ track, onPlay, current, playlistId, leading }: TrackRowProps) {
  const library = useLibrary();
  const { showToast } = useOverlays();
  const statusMeta = STATUS_META[track.status];
  const offline = useOffline();
  // Offline, only songs downloaded to this device can play (SPEC 8.9).
  const playable = canPlayNow(track, offline);
  const downloaded = offline.downloaded.has(track.id);
  const progress = offline.progress.get(track.id);

  const content = (
    <>
      <Cover src={track.coverUrl} alt="" />
      <div className="min-w-0 flex-1">
        <p
          className={`flex items-center gap-1.5 truncate text-sm font-semibold ${playable ? "text-fg" : "text-muted"}`}
        >
          {current && <VolumeIcon width={14} height={14} className="shrink-0 text-silver" aria-label="Now playing" />}
          <span className="truncate" data-testid="track-title">
            {track.title}
          </span>
        </p>
        <p className="truncate text-sm text-muted" data-testid="track-subtitle">
          {rowSubtitle(track.artist, track.album)}
        </p>
        {track.status === "failed" && track.error && (
          <p className="truncate text-xs text-bad" data-testid="track-error">
            {track.error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-sm text-muted">
        {track.liked && <HeartIcon filled width={14} height={14} aria-label="Liked" data-testid="track-liked" />}
        {progress !== undefined && (
          <span className="tabular-nums text-xs" data-testid="track-download-progress" aria-label="Downloading">
            {Math.round(progress * 100)}%
          </span>
        )}
        {downloaded && (
          <DownloadedIcon width={14} height={14} className="text-silver" aria-label="Downloaded" data-testid="track-downloaded" />
        )}
        {track.status === "ready" ? (
          <span className="tabular-nums" data-testid="track-duration">
            {formatDuration(track.durationSec)}
          </span>
        ) : (
          <span className="flex items-center gap-1.5" data-testid="track-status">
            <span className={`h-2 w-2 rounded-full ${statusMeta.dotClass ?? ""}`} aria-hidden="true" />
            {statusLabel(track)}
          </span>
        )}
        {track.status === "failed" && (
          <button
            type="button"
            onClick={() => {
              library.retryTrack(track).then(
                () => showToast("Retry queued"),
                (error: unknown) => showToast(error instanceof Error ? error.message : String(error)),
              );
            }}
            data-testid="retry-button"
            className="rounded-btn border border-line px-2 py-0.5 text-xs text-silver hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-silver"
          >
            Retry
          </button>
        )}
      </div>
    </>
  );

  return (
    <div
      className={`group flex items-center pr-1.5 ${current ? "bg-surface-2/60" : ""}`}
      data-testid="track-item"
      data-item-id={track.id}
    >
      {leading}
      {playable ? (
        <button
          type="button"
          onClick={() => onPlay(track)}
          data-testid="track-row"
          data-track-id={track.id}
          aria-current={current ? "true" : undefined}
          className={
            "flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 pr-2 text-left hover:bg-surface-2 " +
            "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-silver"
          }
        >
          {content}
        </button>
      ) : (
        <div
          className={`flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 pr-2 ${track.status === "ready" ? "opacity-50" : ""}`}
          data-testid="track-row"
          data-unavailable-offline={track.status === "ready" ? "true" : undefined}
          data-track-id={track.id}
        >
          {content}
        </div>
      )}
      <SongMenu track={track} playlistId={playlistId} />
    </div>
  );
}
