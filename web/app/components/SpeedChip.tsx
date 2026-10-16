"use client";

/**
 * Speed on Now Playing and in song lists (V2-PLAN T14).
 *
 * SpeedChip: a small "1.25x" button on Now Playing that opens the presets
 * and the "Keep original pitch" switch. A pick is saved right away and the
 * playing song changes speed at once.
 *
 * SpeedBadge: muted "1.25x" text in a song row, only for songs that do not
 * play at normal speed.
 */
import { useEffect, useRef, useState } from "react";
import { isNormalSpeed, rateOf, speedLabel, type SpeedSource } from "@/lib/player/speed";
import type { PlayerTrack } from "@/lib/player/store";
import { editTrack } from "../lib/api";
import { initialSpeedDraft, speedPatch, type SpeedDraft } from "../lib/speed-edit";
import { usePlayer } from "./PlayerProvider";
import { useOverlays } from "./Overlays";
import { PitchSwitch, SpeedPresets } from "./SpeedEditor";
import { FOCUS, POPUP } from "./ui";

export function SpeedBadge({ track }: { track: SpeedSource }) {
  if (isNormalSpeed(track)) return null;
  const label = speedLabel(rateOf(track));
  return (
    <span className="tabular-nums text-xs" data-testid="track-speed" aria-label={`Speed ${label}`}>
      {label}
    </span>
  );
}

export function SpeedChip({ track }: { track: PlayerTrack }) {
  const player = usePlayer();
  const { showToast, notifyLibraryChanged } = useOverlays();
  const [open, setOpen] = useState(false);
  // What was picked while the save is on its way, so the chip answers at once.
  const [pending, setPending] = useState<SpeedDraft | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const draft = pending ?? initialSpeedDraft(track);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent | TouchEvent) {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    }
    // Escape closes only the presets, not Now Playing behind them. Caught on
    // the way down (capture) because Safari does not focus a tapped button,
    // so the key may not come from inside the panel.
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  async function save(next: SpeedDraft): Promise<void> {
    const patch = speedPatch(track, next);
    if (Object.keys(patch).length === 0) {
      setPending(null);
      return;
    }
    setPending(next);
    try {
      const saved = await editTrack(track.id, patch);
      // The playing song changes speed now, without waiting for the library to reload.
      player.syncTracks([
        {
          ...track,
          playbackRate: saved.playbackRate ?? next.rate,
          preservePitch: saved.preservePitch ?? next.keepPitch,
        },
      ]);
      notifyLibraryChanged();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  const label = speedLabel(draft.rate);
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Speed ${label}`}
        aria-expanded={open}
        data-testid="now-playing-speed"
        className={`inline-flex h-9 min-w-12 items-center justify-center rounded-btn border px-2.5 font-display text-sm tabular-nums ${FOCUS} ${
          isNormalSpeed({ playbackRate: draft.rate }) ? "border-line text-muted hover:text-fg" : "border-silver text-fg"
        }`}
      >
        {label}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Speed"
          data-testid="speed-popover"
          className={`absolute bottom-full left-0 z-10 mb-2 flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-3 p-3 ${POPUP}`}
        >
          <p className="text-sm font-semibold">Speed for this song</p>
          <SpeedPresets rate={draft.rate} onPick={(rate) => void save({ ...draft, rate })} testIdPrefix="chip-preset" />
          <PitchSwitch on={draft.keepPitch} onChange={(keepPitch) => void save({ ...draft, keepPitch })} testId="chip-keep-pitch" />
        </div>
      )}
    </div>
  );
}
