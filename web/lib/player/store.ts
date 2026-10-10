/**
 * The app-wide player store (SPEC 8.8). One vanilla store bound to the single
 * <audio> element mounted once in the root layout; React reads it through
 * useSyncExternalStore (see web/app/components/PlayerProvider.tsx).
 *
 * The iPhone constraint shapes the hot path (SPEC 12): when the next track's
 * source is already known, the `ended` handler sets `src` and calls `play()`
 * synchronously, with no awaits in between. The next URL is prefetched as
 * soon as the current track starts.
 */

export type TrackStatus = "waiting" | "downloading" | "ready" | "failed";

export interface PlayerTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly coverUrl: string | null;
  readonly status: TrackStatus;
  readonly durationSec: number | null;
}

export interface PlayerState {
  /** The list playback was started from (SPEC 8.8 queue basics). */
  readonly queue: readonly PlayerTrack[];
  /** Position in the queue; -1 when nothing is loaded. */
  readonly index: number;
  readonly playing: boolean;
  /** Seconds into the current track. */
  readonly position: number;
  readonly duration: number;
  /** Last playback failure, surfaced in the player bar; null when healthy. */
  readonly error: string | null;
}

export interface PersistedPlayer {
  readonly queue: readonly PlayerTrack[];
  readonly index: number;
  readonly position: number;
  readonly savedAt: number;
}

/** Where the store loads the presigned playback URL from (SPEC 8.8). */
export type PlaybackUrlFetcher = (trackId: string) => Promise<string>;

export interface PlayerPersistence {
  load(): PersistedPlayer | null;
  save(state: PersistedPlayer): void;
}

export interface PlayerDeps {
  fetchPlaybackUrl?: PlaybackUrlFetcher;
  persistence?: PlayerPersistence;
  now?: () => number;
}

export interface PlayerStoreApi {
  getState(): PlayerState;
  subscribe(listener: () => void): () => void;
  /** Bind the one <audio> element; pass null to unbind. Idempotent. */
  attachAudio(element: HTMLAudioElement | null): void;
  /** Set the queue and start the track at `startIndex`; non-ready tracks are skipped. */
  playTracks(tracks: readonly PlayerTrack[], startIndex: number): void;
  toggle(): void;
  seek(seconds: number): void;
  next(): void;
  previous(): void;
}

const STORAGE_KEY = "tapedeck.player.v1";
const SAVE_INTERVAL_MS = 5_000;
const POSITION_STATE_THROTTLE_MS = 1_000;
/** Previous restarts the song when more than this much has been listened (SPEC 8.8). */
const RESTART_THRESHOLD_S = 3;
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
export function nextPlayableIndex(
  queue: readonly PlayerTrack[],
  from: number,
): number | null {
  for (let i = from + 1; i < queue.length; i++) {
    if (queue[i]?.status === "ready") return i;
  }
  return null;
}

/** Last index before `from` whose track is playable, or null. */
export function previousPlayableIndex(
  queue: readonly PlayerTrack[],
  from: number,
): number | null {
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

export function createPlayerStore(deps: PlayerDeps = {}): PlayerStoreApi {
  const fetchPlaybackUrl = deps.fetchPlaybackUrl ?? defaultFetchPlaybackUrl;
  const persistence =
    deps.persistence ??
    (typeof window === "undefined" ? noopPersistence : windowPersistence());
  const now = deps.now ?? (() => Date.now());

  let state: PlayerState = {
    queue: [],
    index: -1,
    playing: false,
    position: 0,
    duration: 0,
    error: null,
  };
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

  function set(patch: Partial<PlayerState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function currentTrack(): PlayerTrack | null {
    return state.queue[state.index] ?? null;
  }

  function persist(): void {
    if (state.index < 0) return;
    lastSaveAt = now();
    persistence.save({
      queue: state.queue,
      index: state.index,
      position: audio ? audio.currentTime : state.position,
      savedAt: now(),
    });
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
    // Artwork omitted when there is no cover (SPEC 8.8); artwork URLs must be
    // absolute https for the lock screen (SPEC 12) — the server supplies them.
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

  function prefetchNext(index: number): void {
    const nextIdx = nextPlayableIndex(state.queue, index);
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
    set({ index, position: 0, duration: track.durationSec ?? 0 });
    const cached = urlCache.get(track.id);
    if (cached) {
      beginPlayback(track, cached, 0);
    } else {
      // Only the cold path awaits the URL; a prefetched `ended` swap is sync.
      fetchPlaybackUrl(track.id).then(
        (url) => {
          urlCache.set(track.id, url);
          if (state.index === index && audio) beginPlayback(track, url, 0);
        },
        (error: unknown) => {
          set({ playing: false, error: errorText(error) });
        },
      );
    }
    prefetchNext(index);
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
    fetchPlaybackUrl(track.id).then(
      (url) => {
        urlCache.set(track.id, url);
        beginPlayback(track, url, position);
        prefetchNext(state.index);
      },
      (error: unknown) => set({ playing: false, error: errorText(error) }),
    );
  }

  function pause(): void {
    audio?.pause();
  }

  function handleTimeUpdate(): void {
    if (!audio) return;
    set({ position: audio.currentTime });
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
    // Synchronous when the next URL is prefetched: no awaits before play().
    const nextIdx = nextPlayableIndex(state.queue, state.index);
    if (nextIdx === null) {
      set({ playing: false });
      persist();
      return;
    }
    startTrack(nextIdx);
  }

  function handleAudioError(): void {
    const track = currentTrack();
    if (!audio || !track || !audio.src) return;
    // SPEC 12: a mid-playback failure (expired presign) refetches once and
    // resumes at the same position.
    if (!refetchedIds.has(track.id)) {
      refetchedIds.add(track.id);
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
      pendingSeek = null;
      set({ position: audio.currentTime });
    }
  }

  function restoreFromPersistence(): void {
    if (restored) return;
    restored = true;
    const saved = persistence.load();
    if (!saved || !Array.isArray(saved.queue)) return;
    if (saved.index < 0 || saved.index >= saved.queue.length) return;
    const track = saved.queue[saved.index];
    if (!track || typeof track.id !== "string") return;
    // Reopen paused at the remembered point (SPEC 8.8); the URL loads on resume.
    set({ queue: saved.queue, index: saved.index, position: saved.position });
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
      if (state.index >= 0) {
        const track = currentTrack();
        if (track) setMetadata(track);
      }
      registerMediaSessionHandlers();
    },
    playTracks(tracks, startIndex) {
      if (!audio) return;
      refetchedIds.clear();
      set({ queue: [...tracks], index: -1, playing: false });
      // Guard: tapping must start a playable track even if the caller passed
      // a non-ready index; waiting/failed entries are skipped (SPEC 8.8).
      const first = tracks[startIndex]?.status === "ready" ? startIndex : nextPlayableIndex(tracks, startIndex - 1);
      if (first == null) return;
      startTrack(first);
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
      set({ position: target });
      persist();
    },
    next() {
      const nextIdx = nextPlayableIndex(state.queue, state.index);
      if (nextIdx == null) {
        // End of the queue: stop (repeat modes arrive with the full player, T2).
        set({ playing: false });
        return;
      }
      startTrack(nextIdx);
    },
    previous() {
      if (!audio) return;
      // More than 3 s in restarts the song; otherwise go to the previous one.
      if (audio.currentTime > RESTART_THRESHOLD_S) {
        store.seek(0);
        return;
      }
      const prevIdx = previousPlayableIndex(state.queue, state.index);
      if (prevIdx == null) {
        store.seek(0);
        return;
      }
      startTrack(prevIdx);
    },
  };

  return store;
}

export type { PlayerStoreApi as PlayerStore };

/** The app-wide singleton the root layout binds the audio element to. */
export const playerStore: PlayerStoreApi = createPlayerStore();
