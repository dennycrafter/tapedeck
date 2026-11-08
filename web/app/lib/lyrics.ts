/**
 * Lyrics (T16), browser side: load a song's lyrics for Now Playing. Answers
 * are kept in memory and the last MAX_SAVED songs in localStorage, so lyrics
 * seen once also show offline (on a flight with downloaded songs). They are
 * keyed by the song's id, title and artist, so editing a song's details
 * looks its lyrics up again. Every storage call is wrapped: private windows
 * and full storage just skip it.
 */
import { isLyricsResult, type LyricsResult } from "../../lib/lyrics-types";

/** What the lyrics view shows: an answer, or "no connection and not saved". */
export type LyricsView = LyricsResult | { status: "offline" };

const MAX_SAVED = 60;
const STORAGE_KEY = "tapedeck:lyrics";
const memory = new Map<string, LyricsResult>();

type Saved = { id: string; result: LyricsResult }[];

export interface LyricsSong {
  id: string;
  title: string;
  artist: string;
}

function keyOf(song: LyricsSong): string {
  return `${song.id}|${song.title}|${song.artist}`;
}

function readSaved(): Saved {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is Saved[number] => isLyricsResult(entry?.result) && typeof entry?.id === "string") : [];
  } catch {
    return [];
  }
}

function save(id: string, result: LyricsResult): void {
  try {
    const kept = readSaved().filter((entry) => entry.id !== id);
    kept.unshift({ id, result });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept.slice(0, MAX_SAVED)));
  } catch {
    // Storage off or full: the in-memory copy still works for this visit.
  }
}

/** Lyrics already known on this device, without asking the app. */
export function knownLyrics(song: LyricsSong): LyricsResult | null {
  const key = keyOf(song);
  const inMemory = memory.get(key);
  if (inMemory) return inMemory;
  if (typeof window === "undefined") return null;
  return readSaved().find((entry) => entry.id === key)?.result ?? null;
}

/** GET /api/tracks/:id/lyrics, remembered unless the service was unavailable. */
export async function loadLyrics(song: LyricsSong): Promise<LyricsView> {
  const key = keyOf(song);
  const known = memory.get(key);
  if (known) return known;
  try {
    const response = await fetch(`/api/tracks/${encodeURIComponent(song.id)}/lyrics`);
    const body = response.ok ? ((await response.json()) as unknown) : null;
    if (!isLyricsResult(body)) return knownLyrics(song) ?? { status: "unavailable" };
    if (body.status !== "unavailable") {
      memory.set(key, body);
      save(key, body);
    }
    return body;
  } catch {
    // No connection: what this device saw before, if anything.
    return knownLyrics(song) ?? { status: "offline" };
  }
}
