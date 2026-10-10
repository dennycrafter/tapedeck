import { describe, expect, it } from "vitest";
import {
  OFFLINE_AUDIO_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_TEST1_KEY,
  POSITION_UPDATE_INTERVAL_MS,
  RESTART_THRESHOLD_SECONDS,
  TONES,
  clampSeekTime,
  formatBytes,
  isPositionUpdateDue,
  mediaSessionPayload,
  nextIndex,
  playbackState,
  previousAction,
} from "./tones";

describe("TONES", () => {
  it("defines the two tones with the SPEC titles and public paths", () => {
    expect(TONES.map((tone) => tone.id)).toEqual(["test1", "test2"]);
    expect(TONES.map((tone) => tone.src)).toEqual([
      "/test-audio/test1.m4a",
      "/test-audio/test2.m4a",
    ]);
    expect(TONES.map((tone) => tone.title)).toEqual(["Test tone 1", "Test tone 2"]);
  });
});

describe("nextIndex", () => {
  it("advances from the first tone to the second", () => {
    expect(nextIndex(0)).toBe(1);
  });

  it("returns null after the last tone so the queue stops", () => {
    expect(nextIndex(1)).toBeNull();
  });
});

describe("previousAction (8.8 previous rule)", () => {
  it("restarts when more than 3 s in", () => {
    expect(previousAction(RESTART_THRESHOLD_SECONDS + 0.1, 1)).toEqual({ kind: "restart" });
  });

  it("goes to the previous tone when not more than 3 s in", () => {
    expect(previousAction(1, 1)).toEqual({ kind: "previous", index: 0 });
  });

  it("restarts at the first tone when not more than 3 s in", () => {
    expect(previousAction(1, 0)).toEqual({ kind: "restart" });
  });

  it("uses the strict threshold: exactly 3 s is not more than 3 s", () => {
    expect(previousAction(RESTART_THRESHOLD_SECONDS, 1)).toEqual({ kind: "previous", index: 0 });
  });
});

describe("clampSeekTime", () => {
  it("moves inside the duration unchanged", () => {
    expect(clampSeekTime(100, -10, 180)).toBe(90);
    expect(clampSeekTime(100, 10, 180)).toBe(110);
  });

  it("clamps the forward seek at the duration", () => {
    expect(clampSeekTime(175, 10, 180)).toBe(180);
  });

  it("clamps the backward seek at zero", () => {
    expect(clampSeekTime(5, -10, 180)).toBe(0);
  });

  it("only clamps at zero when the duration is unknown", () => {
    expect(clampSeekTime(5, -10, Number.NaN)).toBe(0);
    expect(clampSeekTime(5, 10, Number.NaN)).toBe(15);
  });
});

describe("playbackState (setPositionState input)", () => {
  it("returns the position, duration and rate when known", () => {
    expect(playbackState({ currentTime: 10, duration: 180, playbackRate: 1 })).toEqual({
      position: 10,
      duration: 180,
      playbackRate: 1,
    });
  });

  it("returns null while the duration is unknown", () => {
    expect(playbackState({ currentTime: 10, duration: Number.NaN, playbackRate: 1 })).toBeNull();
  });

  it("clamps the position into the duration", () => {
    expect(playbackState({ currentTime: 200, duration: 180, playbackRate: 1 })?.position).toBe(180);
  });
});

describe("isPositionUpdateDue (1/s throttle)", () => {
  it("is due after the interval", () => {
    expect(isPositionUpdateDue(0, POSITION_UPDATE_INTERVAL_MS)).toBe(true);
    expect(isPositionUpdateDue(1000, 2500)).toBe(true);
  });

  it("is not due inside the interval", () => {
    expect(isPositionUpdateDue(1000, 1999)).toBe(false);
  });
});

describe("mediaSessionPayload (8.8 metadata)", () => {
  it("carries the tone title and no artwork (tones have no cover)", () => {
    const payload = mediaSessionPayload(TONES[0]);
    expect(payload.title).toBe("Test tone 1");
    expect(payload).not.toHaveProperty("artwork");
  });
});

describe("offline constants (8.9 shape)", () => {
  it("targets the tapedeck-offline audio store with the test1 key", () => {
    expect(OFFLINE_DB_NAME).toBe("tapedeck-offline");
    expect(OFFLINE_AUDIO_STORE).toBe("audio");
    expect(OFFLINE_TEST1_KEY).toBe("test1");
  });
});

describe("formatBytes", () => {
  it("formats megabytes with one decimal", () => {
    expect(formatBytes(2_917_751)).toBe("2.8 MB");
  });
});
