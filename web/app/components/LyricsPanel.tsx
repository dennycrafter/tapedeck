"use client";

/**
 * Lyrics (T16) in Now Playing, in place of the big cover. Timed lyrics
 * light up the line being sung and keep it in view; tapping a line plays
 * from there. While the owner scrolls by hand, following pauses for a few
 * seconds. Untimed lyrics are plain text. The credit to LRCLIB sits under them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { activeLineIndex, LYRICS_CREDIT } from "../../lib/lyrics-types";
import { knownLyrics, loadLyrics, type LyricsSong, type LyricsView } from "../lib/lyrics";

/** How long a hand scroll stops the lyrics from following the song. */
const HAND_SCROLL_PAUSE_MS = 4000;
/** The line being sung sits this far down the panel. */
const ACTIVE_LINE_AT = 0.35;

const MESSAGES: Record<"none" | "instrumental" | "unavailable" | "offline", string> = {
  none: "No lyrics found for this song.",
  instrumental: "Instrumental",
  unavailable: "Lyrics can't be loaded right now. Try again later.",
  offline: "Lyrics need a connection the first time.",
};

const FADE = "linear-gradient(to bottom, transparent 0, black 6%, black 88%, transparent 100%)";

export function LyricsPanel({
  song,
  mediaTime,
  onSeek,
}: {
  song: LyricsSong;
  /** Seconds into the song's file. */
  mediaTime: number;
  /** Play from this many seconds into the file. */
  onSeek(mediaSeconds: number): void;
}) {
  const { id, title, artist } = song;
  const key = `${id}|${title}|${artist}`;
  const [loaded, setLoaded] = useState<{ key: string; view: LyricsView } | null>(null);
  // Saved on this device: shown at once while the app is asked again.
  const saved = useMemo(() => knownLyrics({ id, title, artist }), [id, title, artist]);

  useEffect(() => {
    let cancelled = false;
    void loadLyrics({ id, title, artist }).then((view) => {
      if (!cancelled) setLoaded({ key: `${id}|${title}|${artist}`, view });
    });
    return () => {
      cancelled = true;
    };
  }, [id, title, artist]);

  const view: LyricsView | null = loaded?.key === key ? loaded.view : saved;
  const lines = view?.status === "synced" ? view.lines : null;
  const active = lines ? activeLineIndex(lines, mediaTime) : -1;

  const box = useRef<HTMLDivElement>(null);
  const handScrollAt = useRef(0);
  useEffect(() => {
    const panel = box.current;
    if (!panel || !lines || Date.now() - handScrollAt.current < HAND_SCROLL_PAUSE_MS) return;
    const line = panel.querySelector<HTMLElement>(`[data-line="${Math.max(0, active)}"]`);
    if (!line) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    panel.scrollTo({ top: Math.max(0, line.offsetTop - panel.clientHeight * ACTIVE_LINE_AT), behavior: reduced ? "auto" : "smooth" });
  }, [active, lines]);

  const byHand = () => {
    handScrollAt.current = Date.now();
  };

  if (!view || view.status === "none" || view.status === "instrumental" || view.status === "unavailable" || view.status === "offline") {
    return (
      <div className="flex flex-1 items-center justify-center px-2 text-center" data-testid="lyrics" data-state={view?.status ?? "loading"}>
        <p className={`text-base ${view?.status === "instrumental" ? "text-silver" : "text-muted"}`} data-testid="lyrics-message">
          {view ? MESSAGES[view.status] : "Finding lyrics"}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={box}
      role="region"
      aria-label="Lyrics"
      data-testid="lyrics"
      data-state={view.status}
      onWheel={byHand}
      onTouchMove={byHand}
      onKeyDown={byHand}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pt-8 pb-[40vh]"
      style={{ maskImage: FADE, WebkitMaskImage: FADE }}
    >
      {lines ? (
        <ol className="flex flex-col gap-3">
          {lines.map((line, index) => (
            <li key={`${index}-${line.time}`}>
              <button
                type="button"
                data-testid="lyrics-line"
                data-line={index}
                data-active={index === active ? "true" : "false"}
                aria-current={index === active ? "true" : undefined}
                onClick={() => onSeek(line.time)}
                className={
                  "block w-full rounded-btn text-left text-xl font-bold leading-snug transition-colors duration-300 lg:text-2xl " +
                  "hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-silver " +
                  (index === active ? "text-fg" : index < active ? "text-muted/60" : "text-muted")
                }
              >
                {line.text || "♪"}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="whitespace-pre-line text-lg font-semibold leading-relaxed text-silver" data-testid="lyrics-plain">
          {view.status === "plain" ? view.text : ""}
        </p>
      )}
      <p className="mt-8 text-xs text-muted">{LYRICS_CREDIT}</p>
    </div>
  );
}
