"use client";

/**
 * One library list row (SPEC 8.3/8.8/10): cover, title, artist · album,
 * duration for ready rows, status dot + label for the others, Retry on
 * failed rows. Only ready rows are playable (tappable); the rest render as
 * muted divs so they are not buttons.
 */
import { Cover } from "./Cover";
import { formatDuration } from "@/lib/player/format";
import { STATUS_META, rowSubtitle } from "../lib/ui";
import type { TrackDto } from "../lib/api";

interface TrackRowProps {
  track: TrackDto;
  onPlay(track: TrackDto): void;
  onRetry(track: TrackDto): void;
  retrying: boolean;
  /** True when this track is the one loaded in the player. */
  current: boolean;
}

export function TrackRow({ track, onPlay, onRetry, retrying, current }: TrackRowProps) {
  const statusMeta = STATUS_META[track.status];
  const playable = track.status === "ready";

  const content = (
    <>
      <Cover src={track.coverUrl} alt="" />
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-sm font-semibold ${playable || current ? "text-fg" : "text-muted"}`}
          data-testid="track-title"
        >
          {track.title}
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
        {playable ? (
          <span className="tabular-nums" data-testid="track-duration">
            {formatDuration(track.durationSec)}
          </span>
        ) : (
          <span className="flex items-center gap-1.5" data-testid="track-status">
            <span className={`h-2 w-2 rounded-full ${statusMeta.dotClass ?? ""}`} aria-hidden="true" />
            {retrying ? "Retry queued" : statusMeta.label}
          </span>
        )}
        {track.status === "failed" && (
          <button
            type="button"
            onClick={() => onRetry(track)}
            disabled={retrying}
            data-testid="retry-button"
            className={
              "rounded-btn border border-line px-2 py-0.5 text-xs text-silver hover:border-muted " +
              "disabled:opacity-60 focus:outline-2 focus:outline-offset-2 focus:outline-silver"
            }
          >
            Retry
          </button>
        )}
      </div>
    </>
  );

  if (!playable) {
    return (
      <div className="flex items-center gap-3 px-3 py-2.5" data-testid="track-row" data-track-id={track.id}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onPlay(track)}
      data-testid="track-row"
      data-track-id={track.id}
      className={
        "flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 " +
        "focus:outline-2 focus:outline-offset-[-2px] focus:outline-silver"
      }
    >
      {content}
    </button>
  );
}
