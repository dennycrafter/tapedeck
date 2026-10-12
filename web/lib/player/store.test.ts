import { describe, expect, it, vi } from "vitest";
import {
  clampSeek,
  createPlayerStore,
  isPositionUpdateDue,
  nextPlayableIndex,
  previousPlayableIndex,
  type PersistedPlayer,
  type PlayerDeps,
  type PlayerPersistence,
  type PlayerTrack,
} from "./store";

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

/** Minimal stand-in for the bounded audio surface the store touches. */
class FakeAudio {
  src = "";
  currentTime = 0;
  duration = 0;
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
}

function asAudio(fake: FakeAudio): HTMLAudioElement {
  return fake as unknown as HTMLAudioElement;
}

function memoryPersistence(): PlayerPersistence & { saved: PersistedPlayer[] } {
  const saved: PersistedPlayer[] = [];
  return {
    saved,
    load: () => saved[saved.length - 1] ?? null,
    save: (state) => {
      saved.push(state);
    },
  };
}

function makeStore(overrides: Partial<PlayerDeps> = {}) {
  const urlByTrack = new Map<string, string>();
  const fetchPlaybackUrl = vi.fn((trackId: string) => {
    const url = urlByTrack.get(trackId);
    return url ? Promise.resolve(url) : Promise.reject(new Error(`no url for ${trackId}`));
  });
  const persistence = memoryPersistence();
  const store = createPlayerStore({
    fetchPlaybackUrl,
    persistence,
    now: () => 1_000_000,
    ...overrides,
  });
  const audio = new FakeAudio();
  return { store, audio, fetchPlaybackUrl, persistence, urlByTrack };
}

/** Resolve the store's microtask chains before asserting on element state. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("queue helpers", () => {
  it("nextPlayableIndex skips tracks that are not ready", () => {
    const queue = [
      makeTrack({ id: "a", status: "waiting" }),
      makeTrack({ id: "b", status: "ready" }),
      makeTrack({ id: "c", status: "failed" }),
      makeTrack({ id: "d", status: "ready" }),
    ];
    expect(nextPlayableIndex(queue, -1)).toBe(1);
    expect(nextPlayableIndex(queue, 1)).toBe(3);
    expect(nextPlayableIndex(queue, 3)).toBe(null);
  });

  it("previousPlayableIndex walks backwards over non-ready tracks", () => {
    const queue = [
      makeTrack({ id: "a", status: "ready" }),
      makeTrack({ id: "b", status: "waiting" }),
      makeTrack({ id: "c", status: "ready" }),
    ];
    expect(previousPlayableIndex(queue, 2)).toBe(0);
    expect(previousPlayableIndex(queue, 0)).toBe(null);
  });

  it("clampSeek clamps into [0, duration] and tolerates an unknown duration", () => {
    expect(clampSeek(30, 100)).toBe(30);
    expect(clampSeek(-5, 100)).toBe(0);
    expect(clampSeek(500, 100)).toBe(100);
    expect(clampSeek(500, 0)).toBe(500);
    expect(clampSeek(Number.NaN, 100)).toBe(0);
  });

  it("isPositionUpdateDue throttles to 1/s", () => {
    expect(isPositionUpdateDue(0, 999)).toBe(false);
    expect(isPositionUpdateDue(0, 1000)).toBe(true);
  });
});

describe("player store", () => {
  it("starts the requested track and prefetches the next URL", async () => {
    const { store, audio, fetchPlaybackUrl, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    urlByTrack.set("t2", "/audio/t2.m4a");
    store.attachAudio(asAudio(audio));

    store.playTracks([makeTrack({ id: "t1" }), makeTrack({ id: "t2" })], 0);
    await flush();

    expect(audio.src).toBe("/audio/t1.m4a");
    expect(audio.play).toHaveBeenCalled();
    expect(store.getState().index).toBe(0);
    // One fetch for the current track, one prefetch for the next.
    expect(fetchPlaybackUrl.mock.calls.map((call) => call[0])).toEqual(["t1", "t2"]);
  });

  it("advances on ended using the prefetched URL without a new fetch", async () => {
    const { store, audio, fetchPlaybackUrl, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    urlByTrack.set("t2", "/audio/t2.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" }), makeTrack({ id: "t2" })], 0);
    await flush();

    audio.emit("ended");
    await flush();

    expect(store.getState().index).toBe(1);
    expect(audio.src).toBe("/audio/t2.m4a");
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(fetchPlaybackUrl).toHaveBeenCalledTimes(2);
  });

  it("stops at the end of the queue", async () => {
    const { store, audio, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" })], 0);
    await flush();

    audio.emit("ended");
    await flush();

    expect(store.getState().playing).toBe(false);
    expect(store.getState().index).toBe(0);
  });

  it("restarts the song from previous when more than 3 s have been listened", async () => {
    const { store, audio, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    urlByTrack.set("t2", "/audio/t2.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" }), makeTrack({ id: "t2" })], 1);
    await flush();

    audio.currentTime = 5;
    store.previous();

    expect(audio.currentTime).toBe(0);
    expect(store.getState().index).toBe(1);
  });

  it("goes to the previous track from previous when within 3 s", async () => {
    const { store, audio, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    urlByTrack.set("t2", "/audio/t2.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" }), makeTrack({ id: "t2" })], 1);
    await flush();

    audio.currentTime = 1;
    store.previous();
    await flush();

    expect(store.getState().index).toBe(0);
    expect(audio.src).toBe("/audio/t1.m4a");
  });

  it("clamps seeks to the audio duration", async () => {
    const { store, audio, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" })], 0);
    await flush();

    audio.duration = 100;
    store.seek(500);
    expect(audio.currentTime).toBe(100);
  });

  it("pauses and resumes with toggle", async () => {
    const { store, audio, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" })], 0);
    await flush();

    store.toggle();
    expect(audio.paused).toBe(true);
    expect(store.getState().playing).toBe(false);

    store.toggle();
    expect(audio.paused).toBe(false);
  });

  it("reopens a saved session paused at the remembered position", async () => {
    const { store, audio, urlByTrack, persistence } = makeStore();
    urlByTrack.set("t1", "/audio/t1.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" })], 0);
    await flush();
    audio.currentTime = 42;
    store.toggle();
    expect(persistence.saved.length).toBeGreaterThan(0);

    // A fresh store over the same persistence (simulates a page reload).
    const reloaded = createPlayerStore({
      fetchPlaybackUrl: (trackId) => {
        const url = urlByTrack.get(trackId);
        return url ? Promise.resolve(url) : Promise.reject(new Error(`no url for ${trackId}`));
      },
      persistence,
      now: () => 2_000_000,
    });
    const freshAudio = new FakeAudio();
    reloaded.attachAudio(asAudio(freshAudio));

    expect(reloaded.getState().index).toBe(0);
    expect(reloaded.getState().position).toBe(42);
    expect(reloaded.getState().playing).toBe(false);

    // Resume loads the source and seeks to the saved position.
    reloaded.toggle();
    await flush();
    freshAudio.duration = 180;
    freshAudio.emit("loadedmetadata");

    expect(freshAudio.src).toBe("/audio/t1.m4a");
    expect(freshAudio.currentTime).toBe(42);
  });

  it("refetches the URL once when playback fails mid-stream", async () => {
    const { store, audio, urlByTrack } = makeStore();
    urlByTrack.set("t1", "/audio/stale.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks([makeTrack({ id: "t1" })], 0);
    await flush();

    // The presign expired: the next fetch hands out a fresh URL.
    urlByTrack.set("t1", "/audio/fresh.m4a");
    audio.currentTime = 17;
    audio.emit("error");
    await flush();

    expect(audio.src).toBe("/audio/fresh.m4a");
    expect(store.getState().playing).toBe(true);

    // A second failure does not loop the refetch forever (SPEC 12: once).
    audio.emit("error");
    await flush();
    expect(store.getState().playing).toBe(false);
    expect(store.getState().error).toBe("The audio file could not be played.");
  });

  it("skips non-ready tracks at the requested start index", async () => {
    const { store, audio, urlByTrack } = makeStore();
    urlByTrack.set("t2", "/audio/t2.m4a");
    store.attachAudio(asAudio(audio));
    store.playTracks(
      [makeTrack({ id: "t1", status: "waiting" }), makeTrack({ id: "t2" })],
      0,
    );
    await flush();

    expect(store.getState().index).toBe(1);
    expect(audio.src).toBe("/audio/t2.m4a");
  });
});

describe("player store, T2 behaviour", () => {
  function playing(ids: string[], start = 0, overrides: Partial<PlayerDeps> = {}) {
    const ctx = makeStore(overrides);
    for (const id of ids) ctx.urlByTrack.set(id, `/audio/${id}.m4a`);
    ctx.store.attachAudio(asAudio(ctx.audio));
    ctx.store.playTracks(ids.map((id) => makeTrack({ id })), start);
    return ctx;
  }

  /** Simulate steady playback: timeupdate every 0.25 s up to `seconds`. */
  function listen(audio: FakeAudio, seconds: number): void {
    const start = audio.currentTime;
    for (let t = start + 0.25; t <= start + seconds + 1e-9; t += 0.25) {
      audio.currentTime = t;
      audio.emit("timeupdate");
    }
  }

  it("records one play after 30 seconds of listening, not before, and only once", async () => {
    const recordPlay = vi.fn();
    const { audio } = playing(["t1", "t2"], 0, { recordPlay });
    await flush();
    listen(audio, 29.5);
    expect(recordPlay).not.toHaveBeenCalled();
    listen(audio, 1);
    expect(recordPlay).toHaveBeenCalledTimes(1);
    expect(recordPlay).toHaveBeenCalledWith("t1", 30);
    listen(audio, 40);
    expect(recordPlay).toHaveBeenCalledTimes(1);
  });

  it("seeking forward does not count as listening", async () => {
    const recordPlay = vi.fn();
    const { audio, store } = playing(["t1"], 0, { recordPlay });
    await flush();
    audio.duration = 180;
    store.seek(120);
    audio.emit("timeupdate");
    listen(audio, 5);
    expect(recordPlay).not.toHaveBeenCalled();
  });

  it("records a play when the song ends before 30 seconds", async () => {
    const recordPlay = vi.fn();
    const { audio } = playing(["t1", "t2"], 0, { recordPlay });
    await flush();
    listen(audio, 4);
    audio.emit("ended");
    expect(recordPlay).toHaveBeenCalledWith("t1", 4);
  });

  it("repeat one replays the same song on ended without a new source", async () => {
    const { audio, store, fetchPlaybackUrl } = playing(["t1", "t2"]);
    await flush();
    store.cycleRepeat();
    store.cycleRepeat();
    expect(store.getState().repeat).toBe("one");
    audio.currentTime = 179;
    audio.emit("ended");
    expect(store.getState().index).toBe(0);
    expect(audio.src).toBe("/audio/t1.m4a");
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(fetchPlaybackUrl).toHaveBeenCalledTimes(2);
  });

  it("repeat all wraps from the last song to the first", async () => {
    const { audio, store } = playing(["t1", "t2"], 1);
    await flush();
    store.cycleRepeat();
    audio.emit("ended");
    await flush();
    expect(store.getState().index).toBe(0);
    expect(audio.src).toBe("/audio/t1.m4a");
  });

  it("play next queues a song right after the current one", async () => {
    const { store } = playing(["t1", "t2"]);
    await flush();
    store.playNext(makeTrack({ id: "x" }));
    expect(store.getState().queue.map((t) => t.id)).toEqual(["t1", "x", "t2"]);
  });

  it("shuffle keeps the current song first", async () => {
    const { store } = playing(["t1", "t2", "t3", "t4"], 2);
    await flush();
    store.toggleShuffle();
    expect(store.getState().shuffle).toBe(true);
    expect(store.getState().index).toBe(0);
    expect(store.getState().queue[0]?.id).toBe("t3");
  });

  it("remembers shuffle, repeat and volume across a reload", async () => {
    const { store, persistence } = playing(["t1", "t2", "t3"]);
    await flush();
    store.toggleShuffle();
    store.cycleRepeat();
    store.setVolume(0.4);
    const reloaded = createPlayerStore({ fetchPlaybackUrl: () => Promise.resolve("/x"), persistence });
    reloaded.attachAudio(asAudio(new FakeAudio()));
    const s = reloaded.getState();
    expect(s.shuffle).toBe(true);
    expect(s.repeat).toBe("all");
    expect(s.volume).toBe(0.4);
    expect(s.queue.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("removing the playing song stops it and drops it from the queue", async () => {
    const { store, audio } = playing(["t1", "t2"]);
    await flush();
    store.removeTrack("t1");
    expect(store.getState().queue.map((t) => t.id)).toEqual(["t2"]);
    expect(store.getState().index).toBe(-1);
    expect(store.getState().playing).toBe(false);
    expect(audio.pause).toHaveBeenCalled();
  });

  it("syncTracks refreshes queued copies after an edit", async () => {
    const { store } = playing(["t1", "t2"]);
    await flush();
    store.syncTracks([makeTrack({ id: "t2", title: "Renamed" })]);
    expect(store.getState().queue[1]?.title).toBe("Renamed");
  });
});
