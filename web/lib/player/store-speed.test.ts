/**
 * Player store, speed and pitch (V2-PLAN T14): every track start puts the
 * song's own speed and pitch on the element, the next song resets them,
 * engines that reset the rate on a new source are corrected, and the lock
 * screen gets the rate. The fake audio element mirrors the one in
 * store.test.ts, plus the speed fields.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayerStore, type PlayerTrack } from "./store";

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
  private source = "";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = true;
  webkitPreservesPitch = true;
  volume = 1;
  /** Like the HTML load algorithm: a new src resets the rate to the default. */
  resetsRateOnLoad = true;

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    if (this.resetsRateOnLoad) this.playbackRate = this.defaultPlaybackRate;
  }

  removeAttribute(name: string): void {
    if (name === "src") this.source = "";
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

  loadMetadata(duration = 180): void {
    this.duration = duration;
    this.emit("loadedmetadata");
  }

  tick(time: number): void {
    this.currentTime = time;
    this.emit("timeupdate");
  }
}

function asAudio(fake: FakeAudio): HTMLAudioElement {
  return fake as unknown as HTMLAudioElement;
}

function makeStore(urls: Record<string, string> = { t1: "/audio/t1.m4a", t2: "/audio/t2.m4a", t3: "blob:t3" }) {
  const fetchPlaybackUrl = vi.fn((trackId: string) => {
    const url = urls[trackId];
    return url ? Promise.resolve(url) : Promise.reject(new Error(`no url for ${trackId}`));
  });
  const store = createPlayerStore({
    fetchPlaybackUrl,
    persistence: { load: () => null, save: () => {} },
    recordPlay: vi.fn(),
    now: () => 1_000_000,
  });
  const audio = new FakeAudio();
  return { store, audio, fetchPlaybackUrl };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const SPED_UP = makeTrack({ id: "t1", playbackRate: 1.25, preservePitch: false });
const NORMAL = makeTrack({ id: "t2", title: "Next" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("player store, speed and pitch (T14)", () => {
  it("puts the song's speed and pitch on the element when it starts", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([SPED_UP, NORMAL], 0);
    await flush();
    expect(audio.src).toBe("/audio/t1.m4a");
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.defaultPlaybackRate).toBe(1.25);
    expect(audio.preservesPitch).toBe(false);
    expect(audio.webkitPreservesPitch).toBe(false);
  });

  it("resets to 1x with the pitch kept for the next song on the synchronous ended path", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([SPED_UP, NORMAL], 0);
    await flush(); // the next URL is prefetched now
    audio.loadMetadata();
    audio.play.mockClear();

    audio.emit("ended");
    // Prefetched: src, speed and play() all happen inside the ended handler.
    expect(audio.src).toBe("/audio/t2.m4a");
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.playbackRate).toBe(1);
    expect(audio.defaultPlaybackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);
    expect(audio.webkitPreservesPitch).toBe(true);
  });

  it("resets at a trim end too (the same path as ended)", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([{ ...SPED_UP, trimEndSec: 150 }, NORMAL], 0);
    await flush();
    audio.loadMetadata();
    audio.paused = false;
    audio.tick(150.1);
    expect(audio.src).toBe("/audio/t2.m4a");
    expect(audio.playbackRate).toBe(1);
  });

  it("goes from a normal song to a slowed one with the pitch dropped", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([NORMAL, makeTrack({ id: "t1", playbackRate: 0.85, preservePitch: false })], 0);
    await flush();
    expect(audio.playbackRate).toBe(1);
    audio.loadMetadata();
    audio.emit("ended");
    expect(audio.src).toBe("/audio/t1.m4a");
    expect(audio.playbackRate).toBe(0.85);
    expect(audio.preservesPitch).toBe(false);
  });

  it("keeps the speed on repeat one", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([SPED_UP, NORMAL], 0);
    store.cycleRepeat();
    store.cycleRepeat();
    expect(store.getState().repeat).toBe("one");
    await flush();
    audio.loadMetadata();
    audio.emit("ended");
    expect(audio.src).toBe("/audio/t1.m4a");
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.preservesPitch).toBe(false);
  });

  it("sets the speed for blob URLs (downloaded songs) like any other", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([NORMAL, makeTrack({ id: "t3", playbackRate: 1.5 })], 0);
    await flush();
    audio.loadMetadata();
    audio.emit("ended");
    expect(audio.src).toBe("blob:t3");
    expect(audio.playbackRate).toBe(1.5);
  });

  it("puts the speed back when the engine resets it on load or play", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([SPED_UP], 0);
    await flush();
    // An engine that ignores defaultPlaybackRate and drops to 1x on load.
    audio.playbackRate = 1;
    audio.preservesPitch = true;
    audio.loadMetadata();
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.preservesPitch).toBe(false);
    audio.playbackRate = 1;
    audio.emit("play");
    expect(audio.playbackRate).toBe(1.25);
  });

  it("applies a speed changed while the song plays", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([NORMAL], 0);
    await flush();
    audio.loadMetadata();
    store.syncTracks([{ ...NORMAL, playbackRate: 1.25, preservePitch: false }]);
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.preservesPitch).toBe(false);
    expect(store.getState().queue[0]?.playbackRate).toBe(1.25);
  });

  it("does not touch the playing song when a queued song's speed changes", async () => {
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([NORMAL, SPED_UP], 0);
    await flush();
    store.syncTracks([{ ...SPED_UP, playbackRate: 0.5 }]);
    expect(audio.playbackRate).toBe(1);
    expect(store.getState().queue[1]?.playbackRate).toBe(0.5);
  });

  it("keeps the old song's speed while the next song's link is still loading", async () => {
    const { store, audio } = makeStore({ t1: "/audio/t1.m4a" });
    store.attachAudio(asAudio(audio));
    store.playTracks([SPED_UP, makeTrack({ id: "t9" })], 0);
    await flush();
    store.next();
    // t9 has no link: the old file and its speed stay until a link arrives.
    audio.emit("play");
    expect(audio.playbackRate).toBe(1.25);
  });

  it("gives the lock screen the playbackRate with media-time positions", async () => {
    const setPositionState = vi.fn();
    vi.stubGlobal("navigator", { mediaSession: { setPositionState, setActionHandler: vi.fn(), metadata: null } });
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([SPED_UP], 0);
    await flush();
    audio.loadMetadata();
    audio.paused = false;
    audio.tick(60);
    expect(setPositionState).toHaveBeenLastCalledWith({ duration: 180, playbackRate: 1.25, position: 60 });
    // The store itself stays in media time; the UI divides by the speed.
    expect(store.getState().position).toBe(60);
    expect(store.getState().duration).toBe(180);
  });

  it("updates the lock screen right away when the speed changes", async () => {
    const setPositionState = vi.fn();
    vi.stubGlobal("navigator", { mediaSession: { setPositionState, setActionHandler: vi.fn(), metadata: null } });
    const { store, audio } = makeStore();
    store.attachAudio(asAudio(audio));
    store.playTracks([NORMAL], 0);
    await flush();
    audio.loadMetadata();
    audio.currentTime = 30;
    store.syncTracks([{ ...NORMAL, playbackRate: 0.85 }]);
    expect(setPositionState).toHaveBeenLastCalledWith({ duration: 180, playbackRate: 0.85, position: 30 });
  });
});
