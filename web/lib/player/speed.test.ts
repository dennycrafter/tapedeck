import { describe, expect, it } from "vitest";
import {
  applySpeed,
  fromShownTime,
  isNormalSpeed,
  keepsPitch,
  normalizeRate,
  presetFor,
  rateOf,
  sameSpeed,
  speedLabel,
  speedProblem,
  toShownTime,
  type SpeedTarget,
} from "./speed";

describe("speed math (T14)", () => {
  it("normalizes rates onto the 0.05 grid between 0.5 and 1.5", () => {
    expect(normalizeRate(1.25)).toBe(1.25);
    expect(normalizeRate(0.85)).toBe(0.85);
    expect(normalizeRate(1.26)).toBe(1.25);
    expect(normalizeRate(3)).toBe(1.5);
    expect(normalizeRate(0.1)).toBe(0.5);
    expect(normalizeRate(0)).toBe(1);
    expect(normalizeRate(Number.NaN)).toBe(1);
    expect(normalizeRate("1.25")).toBe(1);
  });

  it("reads a song's speed and pitch with defaults for old data", () => {
    expect(rateOf({})).toBe(1);
    expect(rateOf(null)).toBe(1);
    expect(rateOf({ playbackRate: 0.85 })).toBe(0.85);
    expect(keepsPitch({})).toBe(true);
    expect(keepsPitch({ preservePitch: false })).toBe(false);
    expect(isNormalSpeed({ playbackRate: 1 })).toBe(true);
    expect(isNormalSpeed({ playbackRate: 1.25 })).toBe(false);
  });

  it("compares speed settings", () => {
    expect(sameSpeed({}, { playbackRate: 1, preservePitch: true })).toBe(true);
    expect(sameSpeed({ playbackRate: 1.25 }, { playbackRate: 1 })).toBe(false);
    expect(sameSpeed({ preservePitch: false }, {})).toBe(false);
  });

  it("labels speeds and finds presets", () => {
    expect(speedLabel(1.25)).toBe("1.25x");
    expect(speedLabel(0.85)).toBe("0.85x");
    expect(speedLabel(1)).toBe("1x");
    expect(speedLabel(1.5)).toBe("1.5x");
    expect(presetFor(1.25)?.label).toBe("Sped up");
    expect(presetFor(0.85)?.label).toBe("Slowed");
    expect(presetFor(1)?.label).toBe("Normal");
    expect(presetFor(1.1)).toBeNull();
  });

  it("divides shown times by the speed and back", () => {
    expect(toShownTime(180, 1.25)).toBe(144);
    expect(toShownTime(85, 0.85)).toBeCloseTo(100);
    expect(fromShownTime(144, 1.25)).toBe(180);
    expect(toShownTime(130, 1)).toBe(130);
  });

  it("checks stored speeds", () => {
    expect(speedProblem(1.25)).toBeNull();
    expect(speedProblem(0.5)).toBeNull();
    expect(speedProblem(1.5)).toBeNull();
    expect(speedProblem(0.85)).toBeNull();
    expect(speedProblem(1.55)).toBe("Speed must be between 0.5x and 1.5x.");
    expect(speedProblem(1.12)).toBe("Speed goes up and down in steps of 0.05.");
    expect(speedProblem(undefined)).toBe("Speed must be a number, for example 1.25.");
  });
});

describe("applySpeed (T14)", () => {
  function element(): SpeedTarget & { writes: string[] } {
    const writes: string[] = [];
    const values: Record<string, number | boolean> = {
      playbackRate: 1,
      defaultPlaybackRate: 1,
      preservesPitch: true,
      webkitPreservesPitch: true,
    };
    const target = { writes } as SpeedTarget & { writes: string[] };
    for (const key of Object.keys(values)) {
      Object.defineProperty(target, key, {
        enumerable: true,
        get: () => values[key],
        set: (value: number | boolean) => {
          writes.push(key);
          values[key] = value;
        },
      });
    }
    return target;
  }

  it("sets the rate, the default rate and both pitch flags", () => {
    const audio = element();
    applySpeed(audio, { playbackRate: 1.25, preservePitch: false });
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.defaultPlaybackRate).toBe(1.25);
    expect(audio.preservesPitch).toBe(false);
    expect(audio.webkitPreservesPitch).toBe(false);
    // Pitch before rate: some engines pick the pitch mode when the rate changes.
    expect(audio.writes.indexOf("preservesPitch")).toBeLessThan(audio.writes.indexOf("playbackRate"));
  });

  it("writes nothing when the element already matches", () => {
    const audio = element();
    applySpeed(audio, {});
    expect(audio.writes).toEqual([]);
  });

  it("skips pitch flags the engine does not have", () => {
    const audio: SpeedTarget = { playbackRate: 1 };
    applySpeed(audio, { playbackRate: 0.85, preservePitch: false });
    expect(audio).toEqual({ playbackRate: 0.85 });
  });
});
