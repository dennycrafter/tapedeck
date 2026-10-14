"use client";

/**
 * Header for playlist, album and artist pages: big art, a small kind label,
 * the name, a muted summary, the big Play button (the page's one accent) and
 * Shuffle, plus page specific actions.
 */
import type { ReactNode } from "react";
import { PlayIcon, ShuffleIcon } from "./icons";
import { BTN_SECONDARY, FOCUS } from "./ui";

interface ListHeaderProps {
  kind: string;
  title: string;
  summary: ReactNode;
  art: ReactNode;
  onPlay(): void;
  onShuffle(): void;
  canPlay: boolean;
  actions?: ReactNode;
  titleTestId?: string;
}

export function ListHeader({ kind, title, summary, art, onPlay, onShuffle, canPlay, actions, titleTestId }: ListHeaderProps) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end">
      <div className="w-40 shrink-0 sm:w-52">{art}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{kind}</p>
          <h1 className="mt-1 break-words text-3xl font-bold tracking-tight sm:text-4xl" data-testid={titleTestId}>
            {title}
          </h1>
          <div className="mt-1.5 text-sm text-muted">{summary}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onPlay}
            disabled={!canPlay}
            aria-label={`Play ${title}`}
            data-testid="list-play"
            className={`flex h-12 w-12 items-center justify-center rounded-full bg-accent text-bg hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          >
            <PlayIcon width={24} height={24} />
          </button>
          <button type="button" onClick={onShuffle} disabled={!canPlay} className={BTN_SECONDARY} data-testid="list-shuffle">
            <ShuffleIcon width={18} height={18} /> Shuffle
          </button>
          {actions}
        </div>
      </div>
    </header>
  );
}

export function NotFound({ text }: { text: string }) {
  return (
    <main className="pt-6">
      <p className="rounded-box border border-line bg-surface p-6 text-center text-sm text-muted" data-testid="not-found">
        {text}
      </p>
    </main>
  );
}
