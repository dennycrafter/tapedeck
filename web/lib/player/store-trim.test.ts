/**
 * Player store, trim behaviour (V2-PLAN T10): starts at the trim start,
 * treats the trim end like `ended`, and shows trimmed time everywhere.
 * The fake audio element mirrors the one in store.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayerStore, type PersistedPlayer, type PlayerDeps, type PlayerPersistence, type PlayerTrack } from "./store";

function makeTrack(overrides: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    id: "t1",
    title: "Song",
    artist: "Artist",
    album: null,
    coverUrl: null,
    status: "ready",
    durationSec: 180,
    ...overrides,
  };
}

class FakeAudio {
  src = "";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playbackRate = 1;
  volume = 1;

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  load(): void {}

  readonly play = vi.fn((): Promise<void> => {
    this.paused = false;
    this.emit("play");
    return Promise.resolve();
  });

  readonly pause = vi.fn((): void => {
    this.paused = true;
    this.emit("pause");
  });

  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  /** The browser read the file header: duration known, metadata event. */
  loadMetadata(duration = 180): void {
    this.duration = duration;
    this.emit("loadedmetadata");
  }

  /** Playback moved to `time` (a timeupdate). */
  tick(time: number): void {
    this.currentTime = time;
    this.emit("timeupdate");
  }
}

function asAudio(fake: FakeAudio): HTMLAudioElement {
  return fake as unknown as HTMLAudioElement;
}

function makeStore(overrides: Partial<PlayerDeps> = {}) {
  const urlByTrack = new Map<string, string>([
    ["t1", "/audio/t1.m4a"],
    ["t2", "/audio/t2.m4a"],
  ]);
  const fetchPlaybackUrl = vi.fn((trackId: string) => {
    const url = urlByTrack.get(trackId);
    return url ? Promise.resolve(url) : Promise.reject(new Error(`no url for ${trackId}`));
  });
  const saved: PersistedPlayer[] = [];
  const persistence: PlayerPersistence = {
    load: () => saved[saved.length - 1] ?? null,
    save: (state) => {
      saved.push(state);
    },
  };
  const recordPlay = vi.fn();
  const store = createPlayerStore({ fetchPlaybackUrl, persistence, recordPlay, now: () => 1_000_000, ...overrides });
  const audio = new FakeAudio();
  return { store, audio, fetchPlaybackUrl, saved, recordPlay };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const TRIMMED = makeTrack({ id: "t1", trimStartSec: 20, trimEndSec: 150 });
const NEXT = makeTrack({ id: "t2", title: "Next" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("player store, trim (T10)", () => {
  it("seeks to the trim start before playing and shows trimmed time", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([TRIMMED, NEXT], 0);
    // Before the file loads, the total is already the trimmed length.
    expect(store.getState().duration).toBe(130);
    await flush();

    audio.loadMetadata();
    expect(audio.currentTime).toBe(20);
    expect(store.getState().position).toBe(0);
    expect(store.getState().duration).toBe(130);

    audio.tick(65);
    expect(store.getState().position).toBe(45);
  });

  it("uses the PC's suggestion when nothing was set by hand", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ autoTrimStartSec: 12.5, autoTrimEndSec: 170 })], 0);
    await flush();
    audio.loadMetadata();
    expect(audio.currentTime).toBe(12.5);
    expect(store.getState().duration).toBe(157.5);
  });

  it("reaching the trim end starts the next song synchronously (prefetched)", async () => {
    const { store, audio, fetchPlaybackUrl } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([TRIMMED, NEXT], 0);
    await flush();
    audio.loadMetadata();

    audio.tick(149.7);
    expect(store.getState().index).toBe(0);
    audio.tick(150.1);
    // Same tick, no awaits: the next source is set and play() called.
    expect(store.getState().index).toBe(1);
    expect(audio.src).toBe("/audio/t2.m4a");
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(fetchPlaybackUrl).toHaveBeenCalledTimes(2);
  });

  it("a trim end counts as a finished play even under 30 seconds", async () => {
    const { store, audio, recordPlay } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ trimStartSec: 0, trimEndSec: 12 }), NEXT], 0);
    await flush();
    audio.loadMetadata();
    for (let t = 1; t <= 12; t++) audio.tick(t);
    expect(recordPlay).toHaveBeenCalledWith("t1", 11);
  });

  it("stops at the trim end of the last song, and play starts it again from the trim start", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([TRIMMED], 0);
    await flush();
    audio.loadMetadata();

    audio.tick(150.2);
    expect(audio.pause).toHaveBeenCalled();
    expect(store.getState().playing).toBe(false);
    expect(store.getState().index).toBe(0);

    store.toggle();
    expect(audio.currentTime).toBe(20);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("repeat one restarts at the trim start", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([TRIMMED, NEXT], 0);
    store.cycleRepeat(); // all
    store.cycleRepeat(); // one
    expect(store.getState().repeat).toBe("one");
    await flush();
    audio.loadMetadata();

    audio.tick(150);
    expect(store.getState().index).toBe(0);
    expect(audio.src).toBe("/audio/t1.m4a");
    expect(audio.currentTime).toBe(20);
  });

  it("seeks are in trimmed time and clamped into the trim", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([TRIMMED], 0);
    await flush();
    audio.loadMetadata();

    store.seek(30);
    expect(audio.currentTime).toBe(50);
    expect(store.getState().position).toBe(30);
    store.seek(-5);
    expect(audio.currentTime).toBe(20);
    store.seek(999);
    expect(audio.currentTime).toBe(150);
    expect(store.getState().position).toBe(130);
  });

  it("previous restarts at the trim start", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([NEXT, TRIMMED], 1);
    await flush();
    audio.loadMetadata();
    audio.tick(40); // 20 s into the trimmed song
    store.previous();
    expect(store.getState().index).toBe(1);
    expect(audio.currentTime).toBe(20);
  });

  it("the lock screen sees the trimmed range, and its seekto seeks in it", async () => {
    const setPositionState = vi.fn();
    const handlers: Record<string, ((details: MediaSessionActionDetails) => void) | null> = {};
    vi.stubGlobal("navigator", {
      mediaSession: {
        metadata: null,
        setPositionState,
        setActionHandler: (action: string, handler: ((details: MediaSessionActionDetails) => void) | null) => {
          handlers[action] = handler;
        },
      },
    });
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([TRIMMED], 0);
    await flush();
    audio.loadMetadata();

    audio.tick(65);
    expect(setPositionState).toHaveBeenLastCalledWith({ duration: 130, playbackRate: 1, position: 45 });

    handlers.seekto?.({ action: "seekto", seekTime: 100 });
    expect(audio.currentTime).toBe(120);
    handlers.seekforward?.({ action: "seekforward" });
    expect(audio.currentTime).toBe(130);
  });

  it("saves trimmed positions and resumes a reloaded session at the same point", async () => {
    const first = makeStore();
    first.store.attachAudio(asAudio(first.audio));
    first.store.playTracks([TRIMMED], 0);
    await flush();
    first.audio.loadMetadata();
    first.audio.tick(80);
    first.store.toggle(); // pause, which saves
    expect(first.saved[first.saved.length - 1]?.position).toBe(60);

    // A reload: a new store reads what the first one saved.
    const second = makeStore({ persistence: { load: () => first.saved[first.saved.length - 1] ?? null, save: () => {} } });
    second.store.attachAudio(asAudio(second.audio));
    expect(second.store.getState().position).toBe(60);
    expect(second.store.getState().duration).toBe(130);
    second.store.toggle();
    await flush();
    second.audio.loadMetadata();
    expect(second.audio.currentTime).toBe(80);
    expect(second.store.getState().position).toBe(60);
  });

  it("an edited trim on the playing song applies straight away", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack()], 0);
    await flush();
    audio.loadMetadata();
    audio.tick(30);
    expect(store.getState().duration).toBe(180);

    store.syncTracks([makeTrack({ trimStartSec: 10, trimEndSec: 100 })]);
    expect(store.getState().duration).toBe(90);
    expect(store.getState().position).toBe(20);
    audio.tick(100.2);
    expect(audio.pause).toHaveBeenCalled();
  });

  it("an untrimmed song behaves exactly as before", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack(), NEXT], 0);
    await flush();
    audio.loadMetadata(180.4);
    expect(audio.currentTime).toBe(0);
    expect(store.getState().duration).toBe(180.4);
    audio.tick(180.3);
    expect(store.getState().index).toBe(0);
    expect(store.getState().position).toBe(180.3);
  });

  it("the previous song's file never triggers the next song's trim end", async () => {
    const { store, audio, fetchPlaybackUrl } = makeStore();
    // The next song's URL never arrives (slow network): no prefetch, a cold start.
    fetchPlaybackUrl.mockImplementation((id: string) =>
      id === "t2" ? new Promise<string>(() => {}) : Promise.resolve(`/audio/${id}.m4a`),
    );
    store.attachAudio(asAudio(audio));
    const short = makeTrack({ id: "t2", trimEndSec: 30 });
    store.playTracks([makeTrack(), short], 0);
    await flush();
    audio.loadMetadata();
    audio.tick(120);
    store.next();
    await flush();
    // The old file still plays at 121 s while the new URL loads.
    audio.tick(121);
    expect(store.getState().index).toBe(1);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.src).toBe("/audio/t1.m4a");
  });
});
