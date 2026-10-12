/**
 * Pure queue logic for the player (SPEC 8.8). The store in ./store.ts owns
 * the <audio> element; everything about "which song plays next" lives here
 * so it can be unit tested without a browser (SPEC 9 T2: play next, add to
 * queue, shuffle keeps current first, repeat off/all/one, previous after
 * 3 seconds restarts).
 *
 * A queue never holds the same track twice: "Play next" and "Add to queue"
 * move a track that is already queued instead of duplicating it. That keeps
 * every queue row keyed by its track id (drag to reorder, remove).
 */

export type RepeatMode = "off" | "all" | "one";

/** Only the fields the queue needs; the store's PlayerTrack satisfies it. */
export interface QueueTrack {
  readonly id: string;
  readonly status: string;
}

export interface QueueState<T extends QueueTrack> {
  /** Play order. With shuffle on this is the shuffled order. */
  readonly tracks: readonly T[];
  /** Position of the current track; -1 when nothing is loaded. */
  readonly index: number;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  /** The order before shuffle was turned on, restored when it is turned off. */
  readonly original: readonly T[] | null;
}

/** Previous restarts the song when more than this much has played (SPEC 8.8). */
export const RESTART_THRESHOLD_S = 3;

export type Random = () => number;

export function emptyQueue<T extends QueueTrack>(): QueueState<T> {
  return { tracks: [], index: -1, shuffle: false, repeat: "off", original: null };
}

function isPlayable(track: QueueTrack | undefined): boolean {
  return track?.status === "ready";
}

/** Fisher-Yates on a copy. */
export function shuffled<T>(items: readonly T[], random: Random = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/** First playable index at or after `from`, or null. */
function firstPlayableFrom(tracks: readonly QueueTrack[], from: number): number | null {
  for (let i = Math.max(0, from); i < tracks.length; i++) {
    if (isPlayable(tracks[i])) return i;
  }
  return null;
}

/** Last playable index at or before `from`, or null. */
function lastPlayableUpTo(tracks: readonly QueueTrack[], from: number): number | null {
  for (let i = Math.min(from, tracks.length - 1); i >= 0; i--) {
    if (isPlayable(tracks[i])) return i;
  }
  return null;
}

/**
 * Start playing a list at `startIndex` (SPEC 8.8: playing from a list sets the
 * queue to that list starting at the tapped song). Waiting and failed songs
 * stay in the list but are skipped. With shuffle on, the tapped song plays
 * first and the rest of the list is shuffled behind it.
 */
export function startQueue<T extends QueueTrack>(
  prev: QueueState<T>,
  list: readonly T[],
  startIndex: number,
  random: Random = Math.random,
): QueueState<T> {
  const tracks = dedupe(list);
  const tapped = list[startIndex];
  let start = tapped ? tracks.findIndex((t) => t.id === tapped.id) : -1;
  if (start < 0 || !isPlayable(tracks[start])) start = firstPlayableFrom(tracks, start + 1) ?? -1;
  if (start < 0) return { ...prev, tracks, index: -1, original: prev.shuffle ? tracks : null };
  if (!prev.shuffle) return { ...prev, tracks, index: start, original: null };
  const current = tracks[start] as T;
  const rest = tracks.filter((_, i) => i !== start);
  return { ...prev, tracks: [current, ...shuffled(rest, random)], index: 0, original: tracks };
}

function dedupe<T extends QueueTrack>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const track of list) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

/** Remove `id` from a list, returning the list and where it was. */
function without<T extends QueueTrack>(list: readonly T[], id: string): T[] {
  return list.filter((t) => t.id !== id);
}

/**
 * "Play next" (SPEC 8.8): put the track right after the current one. A track
 * that is already queued moves there. Playing the current track next is a
 * no-op. With nothing loaded the track becomes the whole queue (not started).
 */
export function playNext<T extends QueueTrack>(state: QueueState<T>, track: T): QueueState<T> {
  const current = state.tracks[state.index];
  if (!current) {
    return { ...state, tracks: [track], index: 0, original: state.shuffle ? [track] : null };
  }
  if (current.id === track.id) return state;
  const tracks = without(state.tracks, track.id);
  const index = tracks.findIndex((t) => t.id === current.id);
  tracks.splice(index + 1, 0, track);
  return { ...state, tracks, index, original: insertAfterInOriginal(state.original, current.id, track) };
}

/** "Add to queue" (SPEC 8.8): append to the end; an already queued track moves there. */
export function addToQueue<T extends QueueTrack>(state: QueueState<T>, track: T): QueueState<T> {
  const current = state.tracks[state.index];
  if (!current) {
    return { ...state, tracks: [...without(state.tracks, track.id), track], index: state.index };
  }
  if (current.id === track.id) return state;
  const tracks = [...without(state.tracks, track.id), track];
  const index = tracks.findIndex((t) => t.id === current.id);
  const original = state.original ? [...without(state.original, track.id), track] : null;
  return { ...state, tracks, index, original };
}

function insertAfterInOriginal<T extends QueueTrack>(
  original: readonly T[] | null,
  afterId: string,
  track: T,
): T[] | null {
  if (!original) return null;
  const list = without(original, track.id);
  const at = list.findIndex((t) => t.id === afterId);
  list.splice(at + 1, 0, track);
  return list;
}

/** Remove the track at `position` (queue view). Removing the current track is not allowed here. */
export function removeAt<T extends QueueTrack>(state: QueueState<T>, position: number): QueueState<T> {
  const target = state.tracks[position];
  if (!target || position === state.index) return state;
  const tracks = state.tracks.filter((_, i) => i !== position);
  const index = position < state.index ? state.index - 1 : state.index;
  const original = state.original ? without(state.original, target.id) : null;
  return { ...state, tracks, index, original };
}

/** Remove a track everywhere (song deleted). Returns `removedCurrent` so the store can stop it. */
export function removeTrack<T extends QueueTrack>(
  state: QueueState<T>,
  id: string,
): { state: QueueState<T>; removedCurrent: boolean } {
  const position = state.tracks.findIndex((t) => t.id === id);
  if (position < 0) return { state, removedCurrent: false };
  const removedCurrent = position === state.index;
  const tracks = state.tracks.filter((_, i) => i !== position);
  let index = state.index;
  if (position < state.index) index -= 1;
  if (removedCurrent) index = -1;
  const original = state.original ? without(state.original, id) : null;
  return { state: { ...state, tracks, index, original }, removedCurrent };
}

/** Drag to reorder in the queue view: move the row at `from` to `to`. */
export function move<T extends QueueTrack>(state: QueueState<T>, from: number, to: number): QueueState<T> {
  if (from === to || !state.tracks[from] || to < 0 || to >= state.tracks.length) return state;
  const current = state.tracks[state.index];
  const tracks = [...state.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved as T);
  const index = current ? tracks.findIndex((t) => t.id === current.id) : state.index;
  return { ...state, tracks, index };
}

/**
 * Shuffle on (SPEC 8.8): the current song stays first and every other song
 * in the queue is shuffled behind it. Shuffle off brings back the order the
 * list had, positioned at the current song.
 */
export function setShuffle<T extends QueueTrack>(
  state: QueueState<T>,
  on: boolean,
  random: Random = Math.random,
): QueueState<T> {
  if (on === state.shuffle) return state;
  const current = state.tracks[state.index];
  if (on) {
    if (!current) return { ...state, shuffle: true, original: state.tracks, tracks: shuffled(state.tracks, random) };
    const rest = state.tracks.filter((_, i) => i !== state.index);
    return { ...state, shuffle: true, original: state.tracks, tracks: [current, ...shuffled(rest, random)], index: 0 };
  }
  // Off: the original order, keeping songs added while shuffled (appended).
  const base = state.original ?? state.tracks;
  const present = new Set(state.tracks.map((t) => t.id));
  const restored = base.filter((t) => present.has(t.id));
  const known = new Set(restored.map((t) => t.id));
  for (const t of state.tracks) if (!known.has(t.id)) restored.push(t);
  const index = current ? restored.findIndex((t) => t.id === current.id) : -1;
  return { ...state, shuffle: false, original: null, tracks: restored, index };
}

/** Repeat cycles off -> all -> one -> off (one button in the player). */
export function nextRepeat(mode: RepeatMode): RepeatMode {
  if (mode === "off") return "all";
  if (mode === "all") return "one";
  return "off";
}

/**
 * Which index plays after the current one.
 * - `auto` is true when the song ended by itself: repeat one replays it.
 *   A tap on Next with repeat one moves on, like every music app.
 * - Repeat all wraps to the first playable song at the end of the queue.
 * - null means stop.
 */
export function nextIndex<T extends QueueTrack>(state: QueueState<T>, auto: boolean): number | null {
  if (state.index < 0) return firstPlayableFrom(state.tracks, 0);
  if (auto && state.repeat === "one" && isPlayable(state.tracks[state.index])) return state.index;
  const after = firstPlayableFrom(state.tracks, state.index + 1);
  if (after !== null) return after;
  if (state.repeat === "all") return firstPlayableFrom(state.tracks, 0);
  return null;
}

/**
 * What Previous does (SPEC 8.8): more than 3 seconds in restarts the song;
 * otherwise go to the previous playable song (wrapping with repeat all).
 * At the start of the queue with nothing before it, restart.
 */
export function previousAction<T extends QueueTrack>(
  state: QueueState<T>,
  positionSec: number,
): { kind: "restart" } | { kind: "go"; index: number } {
  if (positionSec > RESTART_THRESHOLD_S || state.index < 0) return { kind: "restart" };
  const before = lastPlayableUpTo(state.tracks, state.index - 1);
  if (before !== null) return { kind: "go", index: before };
  if (state.repeat === "all") {
    const last = lastPlayableUpTo(state.tracks, state.tracks.length - 1);
    if (last !== null && last !== state.index) return { kind: "go", index: last };
  }
  return { kind: "restart" };
}

/** Songs still to come after the current one (the queue view's "Next up"). */
export function upNext<T extends QueueTrack>(state: QueueState<T>): { track: T; position: number }[] {
  return state.tracks
    .map((track, position) => ({ track, position }))
    .filter(({ position }) => position > state.index);
}
