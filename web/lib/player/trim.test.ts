import { describe, expect, it } from "vitest";
import {
  effectiveEnd,
  effectiveStart,
  formatTrimTime,
  isTrimmed,
  parseTrimTime,
  pastTrimEnd,
  playRange,
  rangeLength,
  sameTrim,
  toMediaTime,
  toTrimmedTime,
  trimProblem,
  type TrimSource,
} from "./trim";

function song(overrides: Partial<TrimSource> = {}): TrimSource {
  return { durationSec: 180, ...overrides };
}

describe("effective trim (V2-PLAN T10 coalesce rule)", () => {
  it("uses the hand value, else the PC's suggestion, else the whole song", () => {
    expect(effectiveStart(song())).toBe(0);
    expect(effectiveEnd(song())).toBe(180);
    expect(effectiveStart(song({ autoTrimStartSec: 12.3 }))).toBe(12.3);
    expect(effectiveEnd(song({ autoTrimEndSec: 170 }))).toBe(170);
    expect(effectiveStart(song({ autoTrimStartSec: 12.3, trimStartSec: 4 }))).toBe(4);
    expect(effectiveEnd(song({ autoTrimEndSec: 170, trimEndSec: 175.5 }))).toBe(175.5);
    // "Don't trim" is a hand value of 0 that beats the suggestion.
    expect(effectiveStart(song({ autoTrimStartSec: 12.3, trimStartSec: 0 }))).toBe(0);
  });

  it("has no end when the length is unknown", () => {
    expect(effectiveEnd({ durationSec: null })).toBeNull();
  });
});

describe("playRange", () => {
  it("plays the whole file when nothing is trimmed", () => {
    expect(playRange(song())).toEqual({ start: 0, end: null });
    expect(isTrimmed(playRange(song()))).toBe(false);
  });

  it("uses the effective start and end", () => {
    expect(playRange(song({ autoTrimStartSec: 12, autoTrimEndSec: 170 }))).toEqual({ start: 12, end: 170 });
    expect(playRange(song({ trimStartSec: 20, trimEndSec: 150, autoTrimStartSec: 12 }))).toEqual({ start: 20, end: 150 });
    expect(isTrimmed(playRange(song({ trimStartSec: 20 })))).toBe(true);
  });

  it("an end at or past the stored length plays to the natural end", () => {
    expect(playRange(song({ trimStartSec: 0, trimEndSec: 180 }))).toEqual({ start: 0, end: null });
    // The file is a little longer than the stored whole seconds.
    expect(playRange(song({ trimEndSec: 180 }), 180.4)).toEqual({ start: 0, end: null });
    // Or a little shorter.
    expect(playRange({ durationSec: 181, trimEndSec: 180.8 }, 180.6)).toEqual({ start: 0, end: null });
  });

  it("ignores nonsense ranges instead of skipping the song", () => {
    expect(playRange(song({ trimStartSec: 200 }))).toEqual({ start: 0, end: null });
    expect(playRange(song({ trimStartSec: 100, trimEndSec: 100.5 }))).toEqual({ start: 0, end: null });
  });
});

describe("clock conversion", () => {
  const range = { start: 20, end: 150 };
  const length = rangeLength(range, 180);

  it("measures the trimmed length", () => {
    expect(length).toBe(130);
    expect(rangeLength({ start: 20, end: null }, 180)).toBe(160);
    expect(rangeLength({ start: 20, end: null }, Number.NaN)).toBe(0);
  });

  it("converts media time to trimmed time and back, clamped into the range", () => {
    expect(toTrimmedTime(20, range, length)).toBe(0);
    expect(toTrimmedTime(65, range, length)).toBe(45);
    expect(toTrimmedTime(5, range, length)).toBe(0);
    expect(toTrimmedTime(175, range, length)).toBe(130);
    expect(toMediaTime(45, range, length)).toBe(65);
    expect(toMediaTime(-10, range, length)).toBe(20);
    expect(toMediaTime(999, range, length)).toBe(150);
    expect(toMediaTime(Number.NaN, range, length)).toBe(20);
  });

  it("does not clamp while the length is unknown", () => {
    expect(toTrimmedTime(500, { start: 0, end: null }, 0)).toBe(500);
    expect(toMediaTime(500, { start: 10, end: null }, 0)).toBe(510);
  });

  it("knows when the trim end is reached", () => {
    expect(pastTrimEnd(149.9, range)).toBe(false);
    expect(pastTrimEnd(150, range)).toBe(true);
    expect(pastTrimEnd(179, { start: 0, end: null })).toBe(false);
  });

  it("compares trims", () => {
    expect(sameTrim(song(), song({ trimStartSec: null }))).toBe(true);
    expect(sameTrim(song(), song({ trimStartSec: 1 }))).toBe(false);
    expect(sameTrim(song({ autoTrimEndSec: 170 }), song())).toBe(false);
  });
});

describe("trimProblem (editor and PATCH validation)", () => {
  it("accepts a sensible trim", () => {
    expect(trimProblem(0, 180, 180)).toBeNull();
    expect(trimProblem(12.5, 170, 180)).toBeNull();
    expect(trimProblem(0, 10, 180)).toBeNull();
  });

  it("explains each problem", () => {
    expect(trimProblem(-1, 100, 180)).toBe("The start can't be before 0:00.");
    expect(trimProblem(0, 181, 180)).toBe("The end can't be past the end of the song.");
    expect(trimProblem(50, 50, 180)).toBe("The start must be before the end.");
    expect(trimProblem(60, 50, 180)).toBe("The start must be before the end.");
    expect(trimProblem(50, 59.9, 180)).toBe("Keep at least 10 seconds of the song.");
    expect(trimProblem(Number.NaN, 50, 180)).toMatch(/m:ss\.s/);
  });

  it("allows half a second past the stored whole-second length", () => {
    expect(trimProblem(0, 180.4, 180)).toBeNull();
  });

  it("skips the length check when the length is unknown", () => {
    expect(trimProblem(0, 999, null)).toBeNull();
  });
});

describe("m:ss.s fields", () => {
  it("formats", () => {
    expect(formatTrimTime(0)).toBe("0:00.0");
    expect(formatTrimTime(5)).toBe("0:05.0");
    expect(formatTrimTime(65.34)).toBe("1:05.3");
    expect(formatTrimTime(59.96)).toBe("1:00.0");
    expect(formatTrimTime(180)).toBe("3:00.0");
    expect(formatTrimTime(null)).toBe("");
  });

  it("parses m:ss.s, m:ss and plain seconds", () => {
    expect(parseTrimTime("1:05.3")).toBe(65.3);
    expect(parseTrimTime(" 0:12 ")).toBe(12);
    expect(parseTrimTime("2:5")).toBe(125);
    expect(parseTrimTime("75.55")).toBe(75.6);
    expect(parseTrimTime("1:05,5")).toBe(65.5);
    expect(parseTrimTime("1:75")).toBeNull();
    expect(parseTrimTime("abc")).toBeNull();
    expect(parseTrimTime("")).toBeNull();
    expect(parseTrimTime("-3")).toBeNull();
  });
});
