// SPEC 9 T2 unit check: queue logic (play next, add to queue, shuffle keeps
// current first, repeat off/all/one, previous after 3 seconds restarts).
import { describe, expect, it } from "vitest";
import {
  addToQueue,
  emptyQueue,
  move,
  nextIndex,
  nextRepeat,
  playNext,
  previousAction,
  removeAt,
  removeTrack,
  setShuffle,
  shuffled,
  startQueue,
  upNext,
  type QueueState,
  type QueueTrack,
} from "./queue";

type T = QueueTrack & { title: string };
const track = (id: string, status = "ready"): T => ({ id, status, title: `Song ${id}` });
const ids = (state: QueueState<T>) => state.tracks.map((t) => t.id);
const current = (state: QueueState<T>) => state.tracks[state.index]?.id;

/** Deterministic "random" so shuffles are reproducible. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const list = ["a", "b", "c", "d", "e"].map((id) => track(id));

describe("startQueue", () => {
  it("sets the queue to the list starting at the tapped song", () => {
    const q = startQueue(emptyQueue<T>(), list, 2);
    expect(ids(q)).toEqual(["a", "b", "c", "d", "e"]);
    expect(current(q)).toBe("c");
  });

  it("skips a tapped song that is not ready to the next playable one", () => {
    const mixed = [track("a"), track("b", "waiting"), track("c")];
    expect(current(startQueue(emptyQueue<T>(), mixed, 1))).toBe("c");
  });

  it("has nothing to play when no song is ready", () => {
    const q = startQueue(emptyQueue<T>(), [track("a", "failed")], 0);
    expect(q.index).toBe(-1);
  });

  it("with shuffle on, the tapped song plays first and the rest are shuffled", () => {
    const q = startQueue({ ...emptyQueue<T>(), shuffle: true }, list, 3, seeded(7));
    expect(current(q)).toBe("d");
    expect(q.index).toBe(0);
    expect([...ids(q)].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(q.original?.map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("play next and add to queue", () => {
  const playing = startQueue(emptyQueue<T>(), list, 1); // current b

  it("play next inserts right after the current song", () => {
    const q = playNext(playing, track("x"));
    expect(ids(q)).toEqual(["a", "b", "x", "c", "d", "e"]);
    expect(current(q)).toBe("b");
  });

  it("play next moves a song that is already queued instead of duplicating it", () => {
    const q = playNext(playing, track("e"));
    expect(ids(q)).toEqual(["a", "b", "e", "c", "d"]);
    expect(current(q)).toBe("b");
  });

  it("play next on a song that was played earlier keeps the current index right", () => {
    const q = playNext(playing, track("a"));
    expect(ids(q)).toEqual(["b", "a", "c", "d", "e"]);
    expect(current(q)).toBe("b");
  });

  it("play next of the current song changes nothing", () => {
    expect(playNext(playing, track("b"))).toBe(playing);
  });

  it("add to queue appends at the end", () => {
    const q = addToQueue(playing, track("x"));
    expect(ids(q)).toEqual(["a", "b", "c", "d", "e", "x"]);
    expect(current(q)).toBe("b");
  });

  it("add to queue moves an already queued song to the end", () => {
    const q = addToQueue(playing, track("c"));
    expect(ids(q)).toEqual(["a", "b", "d", "e", "c"]);
  });

  it("works on an empty player", () => {
    expect(ids(playNext(emptyQueue<T>(), track("x")))).toEqual(["x"]);
    expect(ids(addToQueue(emptyQueue<T>(), track("x")))).toEqual(["x"]);
  });

  it("upNext lists only the songs after the current one", () => {
    expect(upNext(playing).map(({ track: t }) => t.id)).toEqual(["c", "d", "e"]);
  });
});

describe("shuffle", () => {
  it("keeps the current song first and shuffles every other song", () => {
    const playing = startQueue(emptyQueue<T>(), list, 2);
    const q = setShuffle(playing, true, seeded(3));
    expect(q.index).toBe(0);
    expect(current(q)).toBe("c");
    expect([...ids(q)].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("current stays first for many different random seeds", () => {
    for (let seed = 1; seed < 40; seed++) {
      const playing = startQueue(emptyQueue<T>(), list, 4);
      const q = setShuffle(playing, true, seeded(seed));
      expect(q.tracks[0]?.id).toBe("e");
    }
  });

  it("turning shuffle off restores the list order at the current song", () => {
    const playing = startQueue(emptyQueue<T>(), list, 2);
    const shuffledQ = setShuffle(playing, true, seeded(5));
    const advanced = { ...shuffledQ, index: 3 };
    const nowPlaying = current(advanced);
    const q = setShuffle(advanced, false);
    expect(ids(q)).toEqual(["a", "b", "c", "d", "e"]);
    expect(current(q)).toBe(nowPlaying);
  });

  it("songs added while shuffled survive turning shuffle off", () => {
    const q0 = setShuffle(startQueue(emptyQueue<T>(), list, 0), true, seeded(2));
    const q1 = addToQueue(q0, track("x"));
    const q2 = setShuffle(q1, false);
    expect(ids(q2)).toEqual(["a", "b", "c", "d", "e", "x"]);
  });

  it("shuffled() never loses or duplicates items", () => {
    const out = shuffled([1, 2, 3, 4, 5, 6], seeded(9));
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("repeat and next", () => {
  const at = (index: number, repeat: "off" | "all" | "one"): QueueState<T> => ({
    ...startQueue(emptyQueue<T>(), list, index),
    repeat,
  });

  it("repeat cycles off, all, one, off", () => {
    expect(nextRepeat("off")).toBe("all");
    expect(nextRepeat("all")).toBe("one");
    expect(nextRepeat("one")).toBe("off");
  });

  it("repeat off: next goes forward and stops at the end", () => {
    expect(nextIndex(at(1, "off"), true)).toBe(2);
    expect(nextIndex(at(4, "off"), true)).toBeNull();
  });

  it("repeat all: wraps to the first song at the end", () => {
    expect(nextIndex(at(4, "all"), true)).toBe(0);
    expect(nextIndex(at(2, "all"), false)).toBe(3);
  });

  it("repeat one: the song replays when it ends, a tap on Next moves on", () => {
    expect(nextIndex(at(2, "one"), true)).toBe(2);
    expect(nextIndex(at(2, "one"), false)).toBe(3);
  });

  it("next skips songs that are not ready", () => {
    const q = startQueue(emptyQueue<T>(), [track("a"), track("b", "waiting"), track("c", "failed"), track("d")], 0);
    expect(nextIndex(q, true)).toBe(3);
  });
});

describe("previous", () => {
  const playing = startQueue(emptyQueue<T>(), list, 2);

  it("more than 3 seconds in restarts the song", () => {
    expect(previousAction(playing, 3.5)).toEqual({ kind: "restart" });
    expect(previousAction(playing, 60)).toEqual({ kind: "restart" });
  });

  it("3 seconds or less goes to the previous song", () => {
    expect(previousAction(playing, 3)).toEqual({ kind: "go", index: 1 });
    expect(previousAction(playing, 0)).toEqual({ kind: "go", index: 1 });
  });

  it("at the first song it restarts, or wraps to the last with repeat all", () => {
    const first = startQueue(emptyQueue<T>(), list, 0);
    expect(previousAction(first, 1)).toEqual({ kind: "restart" });
    expect(previousAction({ ...first, repeat: "all" }, 1)).toEqual({ kind: "go", index: 4 });
  });

  it("skips songs that are not ready", () => {
    const q = startQueue(emptyQueue<T>(), [track("a"), track("b", "failed"), track("c")], 2);
    expect(previousAction(q, 0)).toEqual({ kind: "go", index: 0 });
  });
});

describe("editing the queue", () => {
  const playing = startQueue(emptyQueue<T>(), list, 2); // current c

  it("removes an upcoming song", () => {
    const q = removeAt(playing, 3);
    expect(ids(q)).toEqual(["a", "b", "c", "e"]);
    expect(current(q)).toBe("c");
  });

  it("removing an earlier song keeps the current song current", () => {
    const q = removeAt(playing, 0);
    expect(current(q)).toBe("c");
  });

  it("will not remove the current song from the queue view", () => {
    expect(removeAt(playing, 2)).toBe(playing);
  });

  it("reorders by drag and keeps the current song", () => {
    const q = move(playing, 4, 3);
    expect(ids(q)).toEqual(["a", "b", "c", "e", "d"]);
    expect(current(q)).toBe("c");
    const q2 = move(playing, 0, 4);
    expect(ids(q2)).toEqual(["b", "c", "d", "e", "a"]);
    expect(current(q2)).toBe("c");
  });

  it("removeTrack drops a deleted song and reports when it was playing", () => {
    const gone = removeTrack(playing, "c");
    expect(gone.removedCurrent).toBe(true);
    expect(gone.state.index).toBe(-1);
    const other = removeTrack(playing, "a");
    expect(other.removedCurrent).toBe(false);
    expect(current(other.state)).toBe("c");
  });
});
