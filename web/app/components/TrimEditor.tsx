"use client";

/**
 * Trim in Edit details (V2-PLAN T10). A bar the length of the song with two
 * drag handles (44 px touch targets) and m:ss.s fields for precision, plus
 * "Play from start", "Hear the ending", "Reset to automatic" and "Don't
 * trim". Trim is non-destructive: only start and end points are saved (with
 * the dialog's Save), the file is never cut.
 *
 * Previews play through the main player with the draft trim, as a queue of
 * just this song (see docs/DECISIONS.md, T10: the previous queue is not
 * restored afterwards).
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatTrimTime, parseTrimTime, roundTenth } from "@/lib/player/trim";
import type { PlayerTrack } from "@/lib/player/store";
import type { TrackDto } from "../lib/api";
import {
  clampEnd,
  clampStart,
  draftEdges,
  trimDraftProblem,
  trimSummary,
  type TrimDraft,
} from "../lib/trim-edit";
import { usePlayer } from "./PlayerProvider";
import { BTN_SECONDARY, INPUT } from "./ui";

/** The song being edited; Edit details only shows trim for ready songs with a length. */
export type TrimTrack = Pick<TrackDto, "id" | "title" | "artist" | "album"> &
  Partial<Pick<TrackDto, "coverUrl" | "autoTrimStartSec" | "autoTrimEndSec" | "trimStartSec" | "trimEndSec" | "playbackRate" | "preservePitch">> & {
    durationSec: number;
  };

interface TrimEditorProps {
  track: TrimTrack;
  draft: TrimDraft;
  onChange(draft: TrimDraft): void;
}

/** "Hear the ending" plays this many seconds before the end handle. */
const ENDING_PREVIEW_SEC = 5;
/** Arrow keys on a handle move it this far (Shift: ten times as far). */
const KEY_STEP_SEC = 1;

type Side = "start" | "end";

export function TrimEditor({ track, draft, onChange }: TrimEditorProps) {
  const player = usePlayer();
  const barRef = useRef<HTMLDivElement>(null);
  // Text typed into a field, until it is committed or a handle moves.
  const [startText, setStartText] = useState<string | null>(null);
  const [endText, setEndText] = useState<string | null>(null);
  const duration = track.durationSec;
  const { start, end } = draftEdges(track, draft);
  const problem = trimDraftProblem(track, draft);

  function setEdges(next: { start?: number; end?: number }): void {
    setStartText(null);
    setEndText(null);
    onChange({
      start: next.start !== undefined ? next.start : draft.start,
      end: next.end !== undefined ? next.end : draft.end,
      typing: null,
    });
  }

  function moveHandle(side: Side, seconds: number): void {
    if (side === "start") setEdges({ start: clampStart(seconds, end) });
    else setEdges({ end: clampEnd(seconds, start, duration) });
  }

  function secondsAt(clientX: number): number {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return roundTenth(ratio * duration);
  }

  function onHandlePointerDown(side: Side, event: PointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  }

  function onHandlePointerMove(side: Side, event: PointerEvent<HTMLButtonElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    moveHandle(side, secondsAt(event.clientX));
  }

  function onHandleKey(side: Side, event: KeyboardEvent<HTMLButtonElement>): void {
    const step = event.shiftKey ? KEY_STEP_SEC * 10 : KEY_STEP_SEC;
    const value = side === "start" ? start : end;
    const moves: Record<string, number> = {
      ArrowLeft: value - step,
      ArrowDown: value - step,
      ArrowRight: value + step,
      ArrowUp: value + step,
      Home: 0,
      End: duration,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    moveHandle(side, moves[event.key]);
  }

  /** A field changed: keep the text, take the value once it reads as a time. */
  function onFieldInput(side: Side, text: string): void {
    if (side === "start") setStartText(text);
    else setEndText(text);
    const value = parseTrimTime(text);
    const texts: Record<Side, string | null> = {
      start: side === "start" ? text : startText,
      end: side === "end" ? text : endText,
    };
    const unreadable = (["start", "end"] as const).find((s) => texts[s] != null && parseTrimTime(texts[s] ?? "") == null);
    onChange({
      start: side === "start" && value != null ? value : draft.start,
      end: side === "end" && value != null ? value : draft.end,
      typing: unreadable ? `Enter the ${unreadable} as m:ss.s, for example 0:12.5.` : null,
    });
  }

  /** Leaving a field that reads as a time shows it in the m:ss.s format. */
  function onFieldBlur(side: Side): void {
    const text = side === "start" ? startText : endText;
    if (text != null && parseTrimTime(text) != null) {
      if (side === "start") setStartText(null);
      else setEndText(null);
    }
  }

  function preview(from: number, to: number): void {
    const song: PlayerTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverUrl: track.coverUrl ?? null,
      status: "ready",
      durationSec: duration,
      autoTrimStartSec: null,
      autoTrimEndSec: null,
      trimStartSec: from,
      trimEndSec: to,
      playbackRate: track.playbackRate ?? 1,
      preservePitch: track.preservePitch ?? true,
    };
    player.playTracks([song], 0);
  }

  const startPct = duration > 0 ? (Math.min(start, duration) / duration) * 100 : 0;
  const endPct = duration > 0 ? (Math.min(end, duration) / duration) * 100 : 100;

  const handle = (side: Side, pct: number, value: number) => (
    <button
      type="button"
      role="slider"
      aria-label={side === "start" ? "Trim start" : "Trim end"}
      aria-valuemin={0}
      aria-valuemax={roundTenth(duration)}
      aria-valuenow={roundTenth(value)}
      aria-valuetext={formatTrimTime(value)}
      data-testid={`trim-handle-${side}`}
      onPointerDown={(event) => onHandlePointerDown(side, event)}
      onPointerMove={(event) => onHandlePointerMove(side, event)}
      onKeyDown={(event) => onHandleKey(side, event)}
      style={{ left: `${pct}%` }}
      className={
        "absolute top-0 flex h-11 w-11 -translate-x-1/2 touch-none items-center justify-center " +
        "cursor-ew-resize rounded-full focus-visible:outline-2 focus-visible:outline-silver"
      }
    >
      <span aria-hidden="true" className="block h-8 w-2 rounded-full bg-fg shadow" />
    </button>
  );

  return (
    <fieldset className="flex flex-col gap-2 text-sm" data-testid="trim-editor">
      <legend className="mb-1">Trim</legend>
      <p className="text-xs text-muted" data-testid="trim-status">
        {trimSummary(track, draft)}
      </p>
      <div ref={barRef} className="relative mx-5 h-11" data-testid="trim-bar">
        <div aria-hidden="true" className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-line" />
        <div
          aria-hidden="true"
          className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-accent"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        />
        {handle("start", startPct, start)}
        {handle("end", endPct, end)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Start
          <input
            value={startText ?? formatTrimTime(start)}
            onChange={(event) => onFieldInput("start", event.target.value)}
            onBlur={() => onFieldBlur("start")}
            inputMode="decimal"
            aria-label="Trim start (m:ss.s)"
            data-testid="trim-start"
            className={`${INPUT} tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          End
          <input
            value={endText ?? formatTrimTime(end)}
            onChange={(event) => onFieldInput("end", event.target.value)}
            onBlur={() => onFieldBlur("end")}
            inputMode="decimal"
            aria-label="Trim end (m:ss.s)"
            data-testid="trim-end"
            className={`${INPUT} tabular-nums`}
          />
        </label>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-bad" data-testid="trim-error">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={problem != null}
          onClick={() => preview(start, end)}
          data-testid="trim-play-start"
          className={BTN_SECONDARY}
        >
          Play from start
        </button>
        <button
          type="button"
          disabled={problem != null}
          onClick={() => preview(Math.max(start, end - ENDING_PREVIEW_SEC), end)}
          data-testid="trim-play-end"
          className={BTN_SECONDARY}
        >
          Hear the ending
        </button>
        <button
          type="button"
          onClick={() => {
            setStartText(null);
            setEndText(null);
            onChange({ start: null, end: null, typing: null });
          }}
          data-testid="trim-reset"
          className={BTN_SECONDARY}
        >
          Reset to automatic
        </button>
        <button
          type="button"
          onClick={() => setEdges({ start: 0, end: duration })}
          data-testid="trim-none"
          className={BTN_SECONDARY}
        >
          Don&apos;t trim
        </button>
      </div>
    </fieldset>
  );
}
