"use client";

/**
 * Player bar (SPEC 8.8 basics + 10 layout): play/pause, seek, current time.
 * Desktop: bottom bar with cover, title/artist, play/pause, progress and
 * times. Phone: mini player above the tab bar with a thin progress line;
 * the full Now playing sheet arrives with T2. Hidden until a track plays.
 */
import { useState, useSyncExternalStore } from "react";
import { usePlayer } from "./PlayerProvider";
import { Cover } from "./Cover";
import { PauseIcon, PlayIcon } from "./icons";
import { TrackEditDialog } from "./TrackEditDialog";
import { formatClock } from "@/lib/player/format";

const SEEK_MAX_FALLBACK_S = 1;

export function PlayerBar() {
  const player = usePlayer();
  const state = useSyncExternalStore(player.subscribe, player.getState, player.getState);
  const track = state.index >= 0 ? (state.queue[state.index] ?? null) : null;
  const [editing, setEditing] = useState(false);
  if (!track) return null;

  const duration = state.duration > 0 ? state.duration : (track.durationSec ?? 0);
  const seekMax = duration > 0 ? duration : SEEK_MAX_FALLBACK_S;
  const progressPct = duration > 0 ? Math.min(100, (state.position / duration) * 100) : 0;

  return (
    <div data-testid="player-bar">
      {/* Phone: mini player above the tab bar (tab bar is 64px + safe area). */}
      <div
        className={
          "fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex items-center gap-3 " +
          "border-t border-line bg-surface px-4 pt-2 pb-2 lg:hidden"
        }
      >
        <Cover src={track.coverUrl} alt="" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" data-testid="player-title">
            {track.title}
          </p>
          {state.error ? (
            <p className="truncate text-xs text-bad" data-testid="player-error">
              {state.error}
            </p>
          ) : (
            <p className="truncate text-sm text-muted">{track.artist}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid="player-edit"
          className="flex-none rounded-btn border border-line px-2 py-1 text-xs text-muted hover:text-fg focus:outline-2 focus:outline-offset-2 focus:outline-silver"
        >
          Edit
        </button>
        <PlayPauseButton />
        <div
          className="absolute inset-x-0 bottom-0 h-0.5 bg-line"
          aria-hidden="true"
        >
          <div className="h-full bg-accent" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {/* Desktop: full bottom bar. */}
      <div
        className={
          "fixed inset-x-0 bottom-0 z-30 hidden items-center gap-4 border-t border-line bg-surface " +
          "px-[clamp(16px,2.6vw,40px)] py-3 lg:flex"
        }
      >
        <Cover src={track.coverUrl} alt="" />
        <div className="w-56 min-w-0 shrink-0">
          <p className="truncate text-sm font-semibold" data-testid="player-title">
            {track.title}
          </p>
          {state.error ? (
            <p className="truncate text-xs text-bad" data-testid="player-error">
              {state.error}
            </p>
          ) : (
            <p className="truncate text-sm text-muted">{track.artist}</p>
          )}
        </div>
        <PlayPauseButton />
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid="player-edit"
          className="flex-none rounded-btn border border-line px-2 py-1 text-xs text-muted hover:text-fg focus:outline-2 focus:outline-offset-2 focus:outline-silver"
        >
          Edit
        </button>
        <span className="w-12 text-right text-xs tabular-nums text-muted" data-testid="player-position">
          {formatClock(state.position)}
        </span>
        <input
          type="range"
          min={0}
          max={seekMax}
          step={1}
          value={Math.min(state.position, seekMax)}
          aria-label="Seek"
          data-testid="seek-slider"
          onChange={(event) => player.seek(Number(event.target.value))}
          className="h-1 w-full accent-accent"
        />
        <span className="w-12 text-xs tabular-nums text-muted" data-testid="player-duration">
          {formatClock(duration)}
        </span>
      </div>

      {editing && <TrackEditDialog track={track} onClose={() => setEditing(false)} />}
    </div>
  );
}

function PlayPauseButton() {
  const player = usePlayer();
  const state = useSyncExternalStore(player.subscribe, player.getState, player.getState);
  return (
    <button
      type="button"
      onClick={() => player.toggle()}
      aria-label={state.playing ? "Pause" : "Play"}
      data-testid="player-toggle"
      className={
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-bg " +
        "hover:bg-accent-ink focus:outline-2 focus:outline-offset-2 focus:outline-silver"
      }
    >
      {state.playing ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
}
