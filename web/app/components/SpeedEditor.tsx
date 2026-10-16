"use client";

/**
 * Speed in Edit details (V2-PLAN T14): a slider from 0.5x to 1.5x in 0.05
 * steps, the presets Slowed, Normal and Sped up, and a "Keep original pitch"
 * switch (off gives the classic sped up or slowed sound). Saved with the
 * dialog's Save. The presets and the switch are shared with the Now Playing
 * speed chip.
 */
import { useId } from "react";
import { MAX_RATE, MIN_RATE, RATE_STEP, SPEED_PRESETS, normalizeRate, presetFor, speedLabel } from "@/lib/player/speed";
import { playLengthText, type SpeedDraft } from "../lib/speed-edit";
import { FOCUS } from "./ui";

/** The three presets as one row of buttons; the matching one is pressed. */
export function SpeedPresets({ rate, onPick, testIdPrefix }: { rate: number; onPick(rate: number): void; testIdPrefix: string }) {
  const current = presetFor(rate)?.id ?? null;
  return (
    <div role="radiogroup" aria-label="Speed presets" className="flex overflow-hidden rounded-btn border border-line">
      {SPEED_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={current === preset.id}
          data-testid={`${testIdPrefix}-${preset.id}`}
          onClick={() => onPick(preset.rate)}
          className={
            "flex-1 border-l border-line px-3 py-2 text-sm first:border-l-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-silver " +
            (current === preset.id ? "bg-line text-fg" : "text-muted hover:text-fg")
          }
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}

/** "Keep original pitch" on or off. */
export function PitchSwitch({ on, onChange, testId }: { on: boolean; onChange(on: boolean): void; testId: string }) {
  const labelId = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm" id={labelId}>
          Keep original pitch
        </p>
        <p className="mt-0.5 text-xs text-muted">Off gives the classic sped up or slowed sound.</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        data-testid={testId}
        onClick={() => onChange(!on)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${FOCUS} ${
          on ? "border-silver bg-silver" : "border-line bg-surface-2"
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-4 w-4 rounded-full transition-transform ${on ? "translate-x-6 bg-bg" : "translate-x-1 bg-muted"}`}
        />
      </button>
    </div>
  );
}

interface SpeedEditorProps {
  draft: SpeedDraft;
  onChange(draft: SpeedDraft): void;
  /** The song's playing length in the file's own seconds (trimmed), when known. */
  lengthSec: number | null;
}

export function SpeedEditor({ draft, onChange, lengthSec }: SpeedEditorProps) {
  const length = playLengthText(lengthSec, draft.rate);
  return (
    <fieldset className="flex flex-col gap-2 text-sm" data-testid="speed-editor">
      <legend className="mb-1">Speed</legend>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={MIN_RATE}
          max={MAX_RATE}
          step={RATE_STEP}
          value={draft.rate}
          aria-label="Speed"
          aria-valuetext={speedLabel(draft.rate)}
          data-testid="speed-slider"
          onChange={(event) => onChange({ ...draft, rate: normalizeRate(Number(event.target.value)) })}
          className="h-1 flex-1 accent-silver"
        />
        <span className="w-12 text-right font-display tabular-nums" data-testid="speed-value">
          {speedLabel(draft.rate)}
        </span>
      </div>
      <SpeedPresets rate={draft.rate} onPick={(rate) => onChange({ ...draft, rate })} testIdPrefix="speed-preset" />
      {length && (
        <p className="text-xs text-muted" data-testid="speed-length">
          {length}
        </p>
      )}
      <PitchSwitch on={draft.keepPitch} onChange={(keepPitch) => onChange({ ...draft, keepPitch })} testId="speed-keep-pitch" />
    </fieldset>
  );
}
