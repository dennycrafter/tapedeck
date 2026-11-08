"use client";

/**
 * Now playing sheet (SPEC 10 phone layout): big cover, title, artist, album
 * link, progress, previous/play/next, shuffle, repeat, heart, queue and the
 * "..." menu. Swipe down, the chevron or Escape closes it. The background is
 * the cover blurred at 0.15 opacity, nothing moves. The Lyrics button (T16)
 * swaps the cover for the song's lyrics; it stays on for the next songs and
 * the next visit (remembered per device).
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { usePlayer, usePlayerState } from "./PlayerProvider";
import { useLibrary } from "./LibraryProvider";
import { Cover } from "./Cover";
import { SongMenu } from "./SongMenu";
import { SpeedChip } from "./SpeedChip";
import { LyricsPanel } from "./LyricsPanel";
import { Progress, Transport } from "./PlayerBar";
import { ChevronDownIcon, HeartIcon, LyricsIcon, QueueIcon } from "./icons";
import { ICON_BTN, useEscape } from "./ui";
import { albumArtistOf, albumHref, artistHref } from "../lib/library-view";
import { playRange } from "../../lib/player/trim";

const CLOSE_DRAG_PX = 110;
const LYRICS_OPEN_KEY = "tapedeck:lyrics-open";

function readLyricsOpen(): boolean {
  try {
    return window.localStorage.getItem(LYRICS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveLyricsOpen(open: boolean): void {
  try {
    window.localStorage.setItem(LYRICS_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not remembered in a private window: it still toggles.
  }
}

export function NowPlaying({ onClose, onOpenQueue }: { onClose(): void; onOpenQueue(): void }) {
  const state = usePlayerState();
  const player = usePlayer();
  const library = useLibrary();
  const [dragY, setDragY] = useState(0);
  const [lyricsOpen, setLyricsOpen] = useState(readLyricsOpen);
  const start = useRef<number | null>(null);
  useEscape(onClose);

  const track = state.index >= 0 ? state.queue[state.index] : undefined;
  if (!track) return null;
  const full = library.byId.get(track.id) ?? null;
  const duration = state.duration > 0 ? state.duration : (track.durationSec ?? 0);
  // Lyrics are timed in the file's seconds; the player counts from the trim start (T10).
  const trimStart = playRange(track).start;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      data-testid="now-playing"
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-bg"
      style={{ transform: dragY > 0 ? `translateY(${dragY}px)` : undefined }}
      onTouchStart={(event) => {
        start.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        if (start.current == null) return;
        const delta = (event.touches[0]?.clientY ?? start.current) - start.current;
        setDragY(Math.max(0, delta));
      }}
      onTouchEnd={() => {
        if (dragY > CLOSE_DRAG_PX) onClose();
        setDragY(0);
        start.current = null;
      }}
    >
      {track.coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={track.coverUrl}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-15 blur-3xl"
        />
      )}
      <div className="relative mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="flex items-center justify-between">
          <button type="button" onClick={onClose} aria-label="Close now playing" data-testid="now-playing-close" className={ICON_BTN}>
            <ChevronDownIcon width={24} height={24} />
          </button>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Now playing</p>
          {full ? <SongMenu track={full} /> : <span className="w-9" />}
        </div>

        {lyricsOpen ? (
          <div className="flex min-h-0 flex-1 flex-col py-4">
            <LyricsPanel
              song={{ id: track.id, title: track.title, artist: track.artist }}
              mediaTime={trimStart + state.position}
              onSeek={(seconds) => player.seek(Math.max(0, seconds - trimStart))}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center py-6">
            <Cover src={track.coverUrl} alt="" sizeClass="aspect-square w-full max-w-[min(100%,52vh)] h-auto" />
          </div>
        )}

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xl font-bold" data-testid="now-playing-title">
              {track.title}
            </p>
            {track.artist && (
              <Link href={artistHref(track.artist)} onClick={onClose} className="block truncate text-base text-muted hover:text-fg">
                {track.artist}
              </Link>
            )}
            {track.album && (
              <Link
                href={albumHref(track.album, albumArtistOf(full ?? { albumArtist: null, artist: track.artist }))}
                onClick={onClose}
                data-testid="now-playing-album"
                className="block truncate text-sm text-muted hover:text-fg"
              >
                {track.album}
              </Link>
            )}
          </div>
          {full && (
            <button
              type="button"
              onClick={() => void library.setLiked(full, !full.liked)}
              aria-label={full.liked ? "Unlike" : "Like"}
              aria-pressed={full.liked === true}
              data-testid="now-playing-like"
              className={`${ICON_BTN} ${full.liked ? "text-fg" : ""}`}
            >
              <HeartIcon filled={full.liked === true} width={24} height={24} />
            </button>
          )}
        </div>

        {state.error && (
          <p className="mt-2 text-sm text-bad" role="alert">
            {state.error}
          </p>
        )}

        <div className="mt-5">
          <Progress state={state} duration={duration} big />
        </div>
        <div className="mt-4 flex justify-center">
          <Transport large />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <SpeedChip track={track} />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setLyricsOpen(!lyricsOpen);
                saveLyricsOpen(!lyricsOpen);
              }}
              aria-label="Lyrics"
              aria-pressed={lyricsOpen}
              data-testid="now-playing-lyrics"
              className={`${ICON_BTN} ${lyricsOpen ? "bg-surface-2 text-fg" : ""}`}
            >
              <LyricsIcon />
            </button>
            <button
              type="button"
              onClick={onOpenQueue}
              aria-label="Queue"
              data-testid="now-playing-queue"
              className={ICON_BTN}
            >
              <QueueIcon />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
