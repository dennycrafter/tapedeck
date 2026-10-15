/**
 * The app-wide player store (SPEC 8.8). One vanilla store bound to the single
 * <audio> element mounted once in the root layout; React reads it through
 * useSyncExternalStore (see web/app/components/PlayerProvider.tsx).
 *
 * The iPhone constraint shapes the hot path (SPEC 12): when the next track's
 * source is already known, the `ended` handler sets `src` and calls `play()`
 * synchronously, with no awaits in between. The next URL is prefetched as
 * soon as the current track starts.
 *
 * Which song plays next (queue, play next, shuffle, repeat, previous) is pure
 * logic in ./queue.ts. Plays are counted here (SPEC 8.6): once per track
 * start, when 30 seconds have been listened or the track ends.
 */
import {
  addToQueue as queueAdd,
  move as queueMove,
  nextIndex,
  nextRepeat,
  playNext as queuePlayNext,
  previousAction,
  removeAt as queueRemoveAt,
  removeTrack as queueRemoveTrack,
  setShuffle as queueSetShuffle,
  startQueue,
  type QueueState,
  type RepeatMode,
} from "./queue";

export type TrackStatus = "waiting" | "downloading" | "ready" | "failed";
export type { RepeatMode } from "./queue";

export interface PlayerTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly coverUrl: string | null;
  readonly status: TrackStatus;
  readonly durationSec: number | null;
  /** v2 (V2-PLAN T9): trim points in seconds of media time (T10); null means none. */
  readonly autoTrimStartSec?: number | null;
  readonly autoTrimEndSec?: number | null;
  readonly trimStartSec?: number | null;
  readonly trimEndSec?: number | null;
  /** v2: speed 0.5 to 1.5 and whether pitch is kept (T14); absent means 1 and true. */
  readonly playbackRate?: number;
  readonly preservePitch?: boolean;
}

export interface PlayerState {
  /** Play order (shuffled order when shuffle is on). */
  readonly queue: readonly PlayerTrack[];
  /** Position in the queue; -1 when nothing is loaded. */
  readonly index: number;
  readonly playing: boolean;
  /** Seconds into the current track. */
  readonly position: number;
  readonly duration: number;
  /** Last playback failure, surfaced in the player bar; null when healthy. */
  readonly error: string | null;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  /** 0 to 1. Desktop only; iPhone ignores audio.volume (SPEC 12). */
  readonly volume: number;
}

export interface PersistedPlayer {
  readonly queue: readonly PlayerTrack[];
  readonly index: number;
  readonly position: number;
  readonly savedAt: number;
  readonly shuffle?: boolean;
  readonly repeat?: RepeatMode;
  readonly volume?: number;
  /** List order before shuffle, so shuffle off still restores it after a reload. */
  readonly original?: readonly PlayerTrack[] | null;
}

/** Where the store loads the playback URL from (SPEC 8.8). */
export type PlaybackUrlFetcher = (trackId: string) => Promise<string>;

/** Records one play (SPEC 8.6: POST /api/plays { trackId, seconds }). */
export type PlayRecorder = (trackId: string, seconds: number) => void;

export interface PlayerPersistence {
  load(): PersistedPlayer | null;
  save(state: PersistedPlayer): void;
}

export interface PlayerDeps {
  fetchPlaybackUrl?: PlaybackUrlFetcher;
  persistence?: PlayerPersistence;
  recordPlay?: PlayRecorder;
  now?: () => number;
  random?: () => number;
}

export interface PlayerStoreApi {
  getState(): PlayerState;
  subscribe(listener: () => void): () => void;
  /** Bind the one <audio> element; pass null to unbind. Idempotent. */
  attachAudio(element: HTMLAudioElement | null): void;
  /** Set the queue to `tracks` and start at `startIndex`; non-ready tracks are skipped. */
  playTracks(tracks: readonly PlayerTrack[], startIndex: number): void;
  toggle(): void;
  seek(seconds: number): void;
  next(): void;
  previous(): void;
  /** Start the queue entry at `index` (tapping a song in the queue view). */
  jumpTo(index: number): void;
  playNext(track: PlayerTrack): void;
  addToQueue(track: PlayerTrack): void;
  removeFromQueue(index: number): void;
  moveInQueue(from: number, to: number): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  setVolume(volume: number): void;
  /** A song was deleted: drop it from the queue (stops it if it was playing). */
  removeTrack(trackId: string): void;
  /** Fresh library data (edits, status changes): update queued copies in place. */
  syncTracks(tracks: readonly PlayerTrack[]): void;
}

const STORAGE_KEY = "tapedeck.player.v1";
const SAVE_INTERVAL_MS = 5_000;
const POSITION_STATE_THROTTLE_MS = 1_000;
/** A play counts after this much listening, or when the song ends (SPEC 8.6). */
export const PLAY_THRESHOLD_S = 30;
/** timeupdate gaps bigger than this are seeks, not listening. */
const MAX_LISTEN_STEP_S = 2;
const SEEK_BACKWARD_S = 10;
const SEEK_FORWARD_S = 10;
const MEDIA_SESSION_ACTIONS = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekto",
  "seekbackward",
  "seekforward",
] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Typed client for GET /api/tracks/:id/url (SPEC 8.8: `{ url, expiresAt }`). */
async function defaultFetchPlaybackUrl(trackId: string): Promise<string> {
  const response = await fetch(`/api/tracks/${encodeURIComponent(trackId)}/url`);
  if (!response.ok) {
    throw new Error(`Could not get a playback URL (${response.status})`);
  }
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string" || body.url.length === 0) {
    throw new Error("Playback URL response had no url");
  }
  return body.url;
}

/** POST /api/plays, fire and forget: a lost play must never interrupt the music. */
function defaultRecordPlay(trackId: string, seconds: number): void {
  if (typeof fetch === "undefined") return;
  fetch("/api/plays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId, seconds }),
    keepalive: true,
  }).catch((error: unknown) => {
    console.warn(`player: recording a play failed: ${errorText(error)}`);
  });
}

/** localStorage persistence, best effort: private mode or a full quota throws. */
function windowPersistence(): PlayerPersistence {
  return {
    load(): PersistedPlayer | null {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as PersistedPlayer;
      } catch {
        return null;
      }
    },
    save(state: PersistedPlayer): void {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Position memory is a nicety; a blocked store must not break playback.
      }
    },
  };
}

const noopPersistence: PlayerPersistence = { load: () => null, save: () => {} };

/** First index after `from` whose track is playable (ready), or null. */
export function nextPlayableIndex(queue: readonly PlayerTrack[], from: number): number | null {
  for (let i = from + 1; i < queue.length; i++) {
    if (queue[i]?.status === "ready") return i;
  }
  return null;
}

/** Last index before `from` whose track is playable, or null. */
export function previousPlayableIndex(queue: readonly PlayerTrack[], from: number): number | null {
  for (let i = Math.min(from, queue.length) - 1; i >= 0; i--) {
    if (queue[i]?.status === "ready") return i;
  }
  return null;
}

/** Clamp a requested seek into [0, duration] when the duration is known. */
export function clampSeek(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds)) return 0;
  if (Number.isFinite(duration) && duration > 0) {
    return Math.min(Math.max(seconds, 0), duration);
  }
  return Math.max(seconds, 0);
}

/** 1/s throttle for Media Session position updates (SPEC 8.8). */
export function isPositionUpdateDue(lastAt: number, nowMs: number): boolean {
  return nowMs - lastAt >= POSITION_STATE_THROTTLE_MS;
}

function clampVolume(volume: unknown): number {
  return typeof volume === "number" && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
}

function isRepeat(value: unknown): value is RepeatMode {
  return value === "off" || value === "all" || value === "one";
}

function sameTrack(a: PlayerTrack, b: PlayerTrack): boolean {
  return (
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.coverUrl === b.coverUrl &&
    a.status === b.status &&
    a.durationSec === b.durationSec
  );
}

export function createPlayerStore(deps: PlayerDeps = {}): PlayerStoreApi {
  const fetchPlaybackUrl = deps.fetchPlaybackUrl ?? defaultFetchPlaybackUrl;
  const persistence =
    deps.persistence ?? (typeof window === "undefined" ? noopPersistence : windowPersistence());
  const recordPlay = deps.recordPlay ?? defaultRecordPlay;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;

  let state: PlayerState = {
    queue: [],
    index: -1,
    playing: false,
    position: 0,
    duration: 0,
    error: null,
    shuffle: false,
    repeat: "off",
    volume: 1,
  };
  /** Pre-shuffle order (QueueState.original), kept beside the public state. */
  let original: readonly PlayerTrack[] | null = null;
  const listeners = new Set<() => void>();

  let audio: HTMLAudioElement | null = null;
  let boundElement: HTMLAudioElement | null = null;
  /** trackId -> prefetched playback URL, so `ended` can swap sources synchronously. */
  const urlCache = new Map<string, string>();
  /** One mid-playback URL refetch per track (SPEC 12: expired presign -> refetch once). */
  const refetchedIds = new Set<string>();
  /** Position to apply once loadedmetadata arrives, for resumed sessions. */
  let pendingSeek: number | null = null;
  let lastPositionStateAt = 0;
  let lastSaveAt = 0;
  let restored = false;
  let unbindMediaSession: (() => void) | null = null;

  // Play counting for the current track start (SPEC 8.6).
  let listened = 0;
  let lastTime = 0;
  let playRecorded = false;
  let listeningTrackId: string | null = null;

  function set(patch: Partial<PlayerState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function queueState(): QueueState<PlayerTrack> {
    return { tracks: state.queue, index: state.index, shuffle: state.shuffle, repeat: state.repeat, original };
  }

  /** Apply a queue change (no playback change). */
  function applyQueue(next: QueueState<PlayerTrack>): void {
    original = next.original;
    set({ queue: next.tracks, index: next.index, shuffle: next.shuffle, repeat: next.repeat });
    persist();
  }

  function currentTrack(): PlayerTrack | null {
    return state.queue[state.index] ?? null;
  }

  function persist(): void {
    lastSaveAt = now();
    persistence.save({
      queue: state.queue,
      index: state.index,
      position: audio && audio.src ? audio.currentTime : state.position,
      savedAt: now(),
      shuffle: state.shuffle,
      repeat: state.repeat,
      volume: state.volume,
      original,
    });
  }

  function resetListening(trackId: string | null): void {
    listened = 0;
    lastTime = 0;
    playRecorded = false;
    listeningTrackId = trackId;
  }

  function maybeRecordPlay(force: boolean): void {
    if (playRecorded || !listeningTrackId) return;
    if (!force && listened < PLAY_THRESHOLD_S) return;
    playRecorded = true;
    recordPlay(listeningTrackId, Math.round(listened));
  }

  function syncPositionState(): void {
    if (!audio) return;
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, duration),
      });
    } catch {
      // Some engines reject position updates that race the duration; nothing to recover.
    }
  }

  function setMetadata(track: PlayerTrack): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (typeof MediaMetadata === "undefined") return;
    // Artwork omitted when there is no cover (SPEC 8.8); artwork URLs must be
    // absolute https for the lock screen (SPEC 12). The server supplies them.
    const metadataInit: MediaMetadataInit = {
      title: track.title,
      artist: track.artist,
      ...(track.album ? { album: track.album } : {}),
      ...(track.coverUrl
        ? { artwork: [{ src: track.coverUrl, sizes: "600x600", type: "image/jpeg" }] }
        : {}),
    };
    navigator.mediaSession.metadata = new MediaMetadata(metadataInit);
  }

  function beginPlayback(track: PlayerTrack, url: string, position: number): void {
    if (!audio) return;
    pendingSeek = position > 0 ? position : null;
    audio.src = url;
    setMetadata(track);
    set({ position, error: null });
    audio.play().then(
      () => set({ playing: true }),
      (error: unknown) => {
        // Autoplay refusals and failed loads land here; keep the bar honest.
        set({ playing: false, error: errorText(error) });
      },
    );
  }

  function prefetchNext(): void {
    const nextIdx = nextIndex(queueState(), true);
    if (nextIdx === null) return;
    const next = state.queue[nextIdx];
    if (!next || urlCache.has(next.id)) return;
    fetchPlaybackUrl(next.id).then(
      (url) => {
        urlCache.set(next.id, url);
      },
      (error: unknown) => {
        // The ended handler falls back to fetching on demand; log for diagnosis.
        console.warn(`player: prefetching next track URL failed: ${errorText(error)}`);
      },
    );
  }

  function startTrack(index: number): void {
    const track = state.queue[index];
    if (!track || !audio) return;
    maybeRecordPlay(false);
    resetListening(track.id);
    set({ index, position: 0, duration: track.durationSec ?? 0 });
    const cached = urlCache.get(track.id);
    if (cached) {
      // A blob: URL (a downloaded song, SPEC 8.9) is used once; the offline
      // layer revokes older ones, so the next play asks for a fresh one.
      if (cached.startsWith("blob:")) urlCache.delete(track.id);
      beginPlayback(track, cached, 0);
    } else {
      // Only the cold path awaits the URL; a prefetched `ended` swap is sync.
      fetchPlaybackUrl(track.id).then(
        (url) => {
          if (!url.startsWith("blob:")) urlCache.set(track.id, url);
          if (state.index === index && state.queue[index]?.id === track.id && audio) {
            beginPlayback(track, url, 0);
          }
        },
        (error: unknown) => {
          set({ playing: false, error: errorText(error) });
        },
      );
    }
    prefetchNext();
    persist();
  }

  function resume(): void {
    if (!audio) return;
    const track = currentTrack();
    if (!track) return;
    if (audio.src) {
      audio.play().then(
        () => set({ playing: true }),
        (error: unknown) => set({ playing: false, error: errorText(error) }),
      );
      return;
    }
    // Restored session: the src was never loaded; load at the saved position.
    const position = state.position;
    resetListening(track.id);
    lastTime = position;
    fetchPlaybackUrl(track.id).then(
      (url) => {
        urlCache.set(track.id, url);
        beginPlayback(track, url, position);
        prefetchNext();
      },
      (error: unknown) => set({ playing: false, error: errorText(error) }),
    );
  }

  function pause(): void {
    audio?.pause();
  }

  function handleTimeUpdate(): void {
    if (!audio) return;
    const time = audio.currentTime;
    if (!audio.paused) {
      const step = time - lastTime;
      if (step > 0 && step <= MAX_LISTEN_STEP_S) {
        listened += step;
        maybeRecordPlay(false);
      }
    }
    lastTime = time;
    set({ position: time });
    const t = now();
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      if (isPositionUpdateDue(lastPositionStateAt, t)) {
        lastPositionStateAt = t;
        syncPositionState();
      }
    }
    // Persist the position every 5 s while playing (SPEC 8.8).
    if (state.playing && t - lastSaveAt >= SAVE_INTERVAL_MS) persist();
  }

  function handleEnded(): void {
    // The song ended: that is a play even under 30 seconds (SPEC 8.6).
    maybeRecordPlay(true);
    const nextIdx = nextIndex(queueState(), true);
    if (nextIdx === null) {
      set({ playing: false });
      persist();
      return;
    }
    if (nextIdx === state.index && audio) {
      // Repeat one: same source, replay synchronously (no awaits, SPEC 12).
      resetListening(state.queue[nextIdx]?.id ?? null);
      audio.currentTime = 0;
      audio.play().then(
        () => set({ playing: true }),
        (error: unknown) => set({ playing: false, error: errorText(error) }),
      );
      return;
    }
    // Synchronous when the next URL is prefetched: no awaits before play().
    startTrack(nextIdx);
  }

  function handleAudioError(): void {
    const track = currentTrack();
    if (!audio || !track || !audio.src) return;
    // SPEC 12: a mid-playback failure (expired presign) refetches once and
    // resumes at the same position.
    if (!refetchedIds.has(track.id)) {
      refetchedIds.add(track.id);
      urlCache.delete(track.id);
      const position = audio.currentTime;
      fetchPlaybackUrl(track.id).then(
        (url) => {
          urlCache.set(track.id, url);
          if (audio && state.index >= 0) beginPlayback(track, url, position);
        },
        (error: unknown) => set({ playing: false, error: errorText(error) }),
      );
      return;
    }
    set({ playing: false, error: "The audio file could not be played." });
  }

  function bind(element: HTMLAudioElement): void {
    element.addEventListener("timeupdate", handleTimeUpdate);
    element.addEventListener("ended", handleEnded);
    element.addEventListener("play", onPlayEvent);
    element.addEventListener("pause", onPauseEvent);
    element.addEventListener("loadedmetadata", onLoadedMetadata);
    element.addEventListener("error", handleAudioError);
  }

  function unbind(element: HTMLAudioElement): void {
    element.removeEventListener("timeupdate", handleTimeUpdate);
    element.removeEventListener("ended", handleEnded);
    element.removeEventListener("play", onPlayEvent);
    element.removeEventListener("pause", onPauseEvent);
    element.removeEventListener("loadedmetadata", onLoadedMetadata);
    element.removeEventListener("error", handleAudioError);
  }

  function onPlayEvent(): void {
    if (audio) lastTime = audio.currentTime;
    set({ playing: true });
  }

  function onPauseEvent(): void {
    set({ playing: false });
    persist();
  }

  function onLoadedMetadata(): void {
    if (!audio) return;
    set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
    if (pendingSeek != null) {
      audio.currentTime = clampSeek(pendingSeek, audio.duration);
      lastTime = audio.currentTime;
      pendingSeek = null;
      set({ position: audio.currentTime });
    }
  }

  function restoreFromPersistence(): void {
    if (restored) return;
    restored = true;
    const saved = persistence.load();
    if (!saved || !Array.isArray(saved.queue)) return;
    const volume = clampVolume(saved.volume);
    const shuffle = saved.shuffle === true;
    const repeat = isRepeat(saved.repeat) ? saved.repeat : "off";
    original = Array.isArray(saved.original) ? saved.original : null;
    const validIndex = saved.index >= 0 && saved.index < saved.queue.length;
    const track = validIndex ? saved.queue[saved.index] : undefined;
    if (!track || typeof track.id !== "string") {
      set({ volume, shuffle, repeat });
      return;
    }
    // Reopen paused at the remembered point (SPEC 8.8); the URL loads on resume.
    set({
      queue: saved.queue,
      index: saved.index,
      position: typeof saved.position === "number" ? saved.position : 0,
      volume,
      shuffle,
      repeat,
    });
  }

  function registerMediaSessionHandlers(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler("play", () => resume());
    session.setActionHandler("pause", () => pause());
    session.setActionHandler("previoustrack", () => store.previous());
    session.setActionHandler("nexttrack", () => store.next());
    session.setActionHandler("seekto", (details) => {
      if (details.action !== "seekto") return;
      if (details.seekTime != null) store.seek(details.seekTime);
    });
    session.setActionHandler("seekbackward", (details) => {
      if (!audio) return;
      store.seek(Math.max(0, audio.currentTime - (details.seekOffset ?? SEEK_BACKWARD_S)));
    });
    session.setActionHandler("seekforward", (details) => {
      if (!audio) return;
      store.seek(audio.currentTime + (details.seekOffset ?? SEEK_FORWARD_S));
    });
    unbindMediaSession = () => {
      for (const action of MEDIA_SESSION_ACTIONS) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Clearing handlers during teardown can be rejected; nothing to recover.
        }
      }
    };
  }

  const store: PlayerStoreApi = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachAudio(element) {
      if (boundElement === element) return;
      if (boundElement) unbind(boundElement);
      boundElement = element;
      audio = element;
      if (!element) {
        // Detached (react remount): drop the lock screen handlers with it.
        unbindMediaSession?.();
        unbindMediaSession = null;
        return;
      }
      bind(element);
      restoreFromPersistence();
      try {
        element.volume = state.volume;
      } catch {
        // Some engines expose a read-only volume; nothing to do.
      }
      if (state.index >= 0) {
        const track = currentTrack();
        if (track) setMetadata(track);
      }
      registerMediaSessionHandlers();
    },
    playTracks(tracks, startIndex) {
      if (!audio) return;
      refetchedIds.clear();
      const next = startQueue(queueState(), tracks, startIndex, random);
      original = next.original;
      set({ queue: next.tracks, index: -1, playing: false });
      if (next.index < 0) return;
      startTrack(next.index);
    },
    toggle() {
      if (!audio) return;
      if (audio.paused) resume();
      else pause();
    },
    seek(seconds) {
      if (!audio) return;
      if (!audio.src) {
        // Restored session not loaded yet: remember the position for the load.
        set({ position: clampSeek(seconds, 0) });
        persist();
        return;
      }
      const target = clampSeek(seconds, audio.duration);
      audio.currentTime = target;
      lastTime = target;
      set({ position: target });
      persist();
    },
    next() {
      const nextIdx = nextIndex(queueState(), false);
      if (nextIdx == null) {
        // End of the queue with repeat off: stop.
        audio?.pause();
        set({ playing: false });
        return;
      }
      startTrack(nextIdx);
    },
    previous() {
      if (!audio) return;
      const action = previousAction(queueState(), audio.currentTime);
      if (action.kind === "restart") {
        store.seek(0);
        return;
      }
      startTrack(action.index);
    },
    jumpTo(index) {
      if (!audio || state.queue[index]?.status !== "ready") return;
      startTrack(index);
    },
    playNext(track) {
      const wasEmpty = state.index < 0;
      applyQueue(queuePlayNext(queueState(), track));
      if (wasEmpty && audio) startTrack(state.index);
      else prefetchNext();
    },
    addToQueue(track) {
      const wasEmpty = state.index < 0 && state.queue.length === 0;
      const next = queueAdd(queueState(), track);
      if (wasEmpty) {
        applyQueue({ ...next, index: 0 });
        if (audio) startTrack(0);
        return;
      }
      applyQueue(next);
      prefetchNext();
    },
    removeFromQueue(index) {
      applyQueue(queueRemoveAt(queueState(), index));
      prefetchNext();
    },
    moveInQueue(from, to) {
      applyQueue(queueMove(queueState(), from, to));
      prefetchNext();
    },
    toggleShuffle() {
      applyQueue(queueSetShuffle(queueState(), !state.shuffle, random));
      prefetchNext();
    },
    cycleRepeat() {
      applyQueue({ ...queueState(), repeat: nextRepeat(state.repeat) });
      prefetchNext();
    },
    setVolume(volume) {
      const v = clampVolume(volume);
      if (audio) {
        try {
          audio.volume = v;
        } catch {
          // Read-only volume (iPhone): the slider is hidden there anyway.
        }
      }
      set({ volume: v });
      persist();
    },
    removeTrack(trackId) {
      const { state: next, removedCurrent } = queueRemoveTrack(queueState(), trackId);
      urlCache.delete(trackId);
      if (removedCurrent && audio) {
        audio.pause();
        audio.removeAttribute("src");
        try {
          audio.load();
        } catch {
          // Resetting the element is best effort.
        }
        resetListening(null);
        set({ playing: false, position: 0, duration: 0 });
      }
      applyQueue(next);
    },
    syncTracks(tracks) {
      const byId = new Map(tracks.map((t) => [t.id, t]));
      let changed = false;
      const queue = state.queue.map((queued) => {
        const fresh = byId.get(queued.id);
        if (!fresh || sameTrack(queued, fresh)) return queued;
        changed = true;
        return fresh;
      });
      if (!changed) return;
      const before = currentTrack();
      set({ queue });
      const after = currentTrack();
      if (before && after && !sameTrack(before, after)) setMetadata(after);
      persist();
    },
  };

  return store;
}

export type { PlayerStoreApi as PlayerStore };

/**
 * Hooks the app sets once on the client (web/app/components/PlayerProvider):
 * where audio comes from (the phone's downloaded copy or the server, SPEC
 * 8.9) and how plays are kept while offline (SPEC 8.6). Unset, the store
 * uses the plain network defaults above.
 */
export const playerHooks: { fetchPlaybackUrl: PlaybackUrlFetcher | null; recordPlay: PlayRecorder | null } = {
  fetchPlaybackUrl: null,
  recordPlay: null,
};

/** The app-wide singleton the root layout binds the audio element to. */
export const playerStore: PlayerStoreApi = createPlayerStore({
  fetchPlaybackUrl: (trackId) => (playerHooks.fetchPlaybackUrl ?? defaultFetchPlaybackUrl)(trackId),
  recordPlay: (trackId, seconds) => (playerHooks.recordPlay ?? defaultRecordPlay)(trackId, seconds),
});
