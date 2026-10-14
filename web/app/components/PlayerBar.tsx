"use client";

/**
 * Player (SPEC 8.8, 10 layout). Desktop: bottom bar with cover, title and
 * artist (plus heart), shuffle / previous / play / next / repeat over the
 * progress bar with times, then queue and volume. Phone: mini player above
 * the tab bar (cover, title/artist, play/pause, thin progress line); tapping
 * it opens the Now playing sheet. Hidden until a song is loaded.
 */
import { useState } from "react";
import Link from "next/link";
import { usePlayer, usePlayerState } from "./PlayerProvider";
import { useLibrary } from "./LibraryProvider";
import { Cover } from "./Cover";
import { NowPlaying } from "./NowPlaying";
import { QueuePanel } from "./QueuePanel";
import { SongMenu } from "./SongMenu";
import {
  HeartIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  RepeatIcon,
  ShuffleIcon,
  VolumeIcon,
} from "./icons";
import { FOCUS, ICON_BTN } from "./ui";
import { formatClock } from "@/lib/player/format";
import { artistHref } from "../lib/library-view";
import type { PlayerState } from "@/lib/player/store";

const SEEK_MAX_FALLBACK_S = 1;

function durationOf(state: PlayerState): number {
  const track = state.index >= 0 ? state.queue[state.index] : undefined;
  return state.duration > 0 ? state.duration : (track?.durationSec ?? 0);
}

export function PlayerBar() {
  const player = usePlayer();
  const state = usePlayerState();
  const library = useLibrary();
  const track = state.index >= 0 ? (state.queue[state.index] ?? null) : null;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  if (!track) return null;

  const duration = durationOf(state);
  const progressPct = duration > 0 ? Math.min(100, (state.position / duration) * 100) : 0;
  const full = library.byId.get(track.id) ?? null;

  const subtitle = state.error ? (
    <p className="truncate text-xs text-bad" data-testid="player-error">
      {state.error}
    </p>
  ) : (
    <p className="truncate text-sm text-muted">{track.artist}</p>
  );

  return (
    <div data-testid="player-bar">
      {/* Phone: mini player above the tab bar (tab bar is 64px + safe area). */}
      <div
        className={
          "fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-line bg-surface lg:hidden"
        }
      >
        <div className="flex items-center gap-3 px-3 py-2">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-label="Open now playing"
            data-testid="mini-player-open"
            className={`flex min-w-0 flex-1 items-center gap-3 rounded-btn text-left ${FOCUS}`}
          >
            <Cover src={track.coverUrl} alt="" sizeClass="h-10 w-10" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold" data-testid="player-title">
                {track.title}
              </p>
              {subtitle}
            </div>
          </button>
          <PlayPauseButton size="sm" />
        </div>
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-line" aria-hidden="true">
          <div className="h-full bg-silver" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {/* Desktop: full bottom bar. */}
      <div
        className={
          "fixed inset-x-0 bottom-0 z-30 hidden h-[84px] items-center gap-6 border-t border-line bg-surface " +
          "px-[clamp(16px,2.6vw,40px)] lg:flex"
        }
      >
        <div className="flex w-[30%] min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-label="Open now playing"
            className={`shrink-0 rounded-box ${FOCUS}`}
          >
            <Cover src={track.coverUrl} alt="" sizeClass="h-14 w-14" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" data-testid="player-title">
              {track.title}
            </p>
            {state.error ? (
              subtitle
            ) : track.artist ? (
              <Link href={artistHref(track.artist)} className="block truncate text-sm text-muted hover:text-fg hover:underline">
                {track.artist}
              </Link>
            ) : null}
          </div>
          {full && (
            <button
              type="button"
              onClick={() => void library.setLiked(full, !full.liked)}
              aria-label={full.liked ? "Unlike" : "Like"}
              aria-pressed={full.liked === true}
              data-testid="player-like"
              className={`${ICON_BTN} ${full.liked ? "text-fg" : ""}`}
            >
              <HeartIcon filled={full.liked === true} width={18} height={18} />
            </button>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
          <Transport />
          <Progress state={state} duration={duration} />
        </div>

        <div className="flex w-[30%] items-center justify-end gap-2">
          {full && <SongMenu track={full} />}
          <button
            type="button"
            onClick={() => setQueueOpen((open) => !open)}
            aria-label="Queue"
            aria-pressed={queueOpen}
            data-testid="queue-open"
            className={`${ICON_BTN} ${queueOpen ? "text-fg" : ""}`}
          >
            <QueueIcon />
          </button>
          {/* iPhone and other touch devices ignore audio.volume (SPEC 12). */}
          <span className="flex items-center gap-2 pointer-coarse:hidden">
          <VolumeIcon className="shrink-0 text-muted" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            aria-label="Volume"
            data-testid="volume-slider"
            onChange={(event) => player.setVolume(Number(event.target.value))}
            className="h-1 w-24 accent-silver"
          />
          </span>
        </div>
      </div>

      {sheetOpen && (
        <NowPlaying
          onClose={() => setSheetOpen(false)}
          onOpenQueue={() => {
            setQueueOpen(true);
          }}
        />
      )}
      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
    </div>
  );
}

export function Transport({ large = false }: { large?: boolean }) {
  const player = usePlayer();
  const state = usePlayerState();
  const size = large ? 26 : 20;
  return (
    <div className={`flex items-center ${large ? "gap-6" : "gap-3"}`}>
      <button
        type="button"
        onClick={() => player.toggleShuffle()}
        aria-label="Shuffle"
        aria-pressed={state.shuffle}
        data-testid="player-shuffle"
        className={`${ICON_BTN} relative ${state.shuffle ? "text-fg" : ""}`}
      >
        <ShuffleIcon width={size - 2} height={size - 2} />
        {state.shuffle && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-fg" aria-hidden="true" />}
      </button>
      <button
        type="button"
        onClick={() => player.previous()}
        aria-label="Previous"
        data-testid="player-prev"
        className={`${ICON_BTN} text-silver`}
      >
        <PrevIcon width={size} height={size} />
      </button>
      <PlayPauseButton size={large ? "lg" : "md"} />
      <button
        type="button"
        onClick={() => player.next()}
        aria-label="Next"
        data-testid="player-next"
        className={`${ICON_BTN} text-silver`}
      >
        <NextIcon width={size} height={size} />
      </button>
      <button
        type="button"
        onClick={() => player.cycleRepeat()}
        aria-label={state.repeat === "off" ? "Repeat off" : state.repeat === "all" ? "Repeat all" : "Repeat one"}
        aria-pressed={state.repeat !== "off"}
        data-testid="player-repeat"
        data-repeat={state.repeat}
        className={`${ICON_BTN} relative ${state.repeat !== "off" ? "text-fg" : ""}`}
      >
        <RepeatIcon one={state.repeat === "one"} width={size - 2} height={size - 2} />
        {state.repeat !== "off" && (
          <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-fg" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

export function Progress({ state, duration, big = false }: { state: PlayerState; duration: number; big?: boolean }) {
  const player = usePlayer();
  const seekMax = duration > 0 ? duration : SEEK_MAX_FALLBACK_S;
  const time = big ? "font-display text-sm text-muted" : "text-xs text-muted";
  return (
    <div className={`flex w-full items-center gap-3 ${big ? "flex-wrap" : "max-w-2xl"}`}>
      <span className={`${big ? "order-2" : "w-11 text-right"} tabular-nums ${time}`} data-testid="player-position">
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
        className={`h-1 accent-silver ${big ? "order-1 w-full basis-full" : "flex-1"}`}
      />
      <span
        className={`${big ? "order-3 ml-auto" : "w-11"} tabular-nums ${time}`}
        data-testid="player-duration"
      >
        {formatClock(duration)}
      </span>
    </div>
  );
}

export function PlayPauseButton({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const player = usePlayer();
  const state = usePlayerState();
  const box = size === "lg" ? "h-16 w-16" : size === "md" ? "h-10 w-10" : "h-9 w-9";
  const icon = size === "lg" ? 30 : 20;
  return (
    <button
      type="button"
      onClick={() => player.toggle()}
      aria-label={state.playing ? "Pause" : "Play"}
      data-testid="player-toggle"
      className={`flex ${box} shrink-0 items-center justify-center rounded-full bg-accent text-bg hover:bg-accent-ink ${FOCUS}`}
    >
      {state.playing ? <PauseIcon width={icon} height={icon} /> : <PlayIcon width={icon} height={icon} />}
    </button>
  );
}
