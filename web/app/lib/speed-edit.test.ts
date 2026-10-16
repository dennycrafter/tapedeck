import { describe, expect, it } from "vitest";
import { initialSpeedDraft, playLengthText, speedPatch } from "./speed-edit";

describe("speed draft (T14)", () => {
  it("starts from the song, with defaults for old data", () => {
    expect(initialSpeedDraft({})).toEqual({ rate: 1, keepPitch: true });
    expect(initialSpeedDraft({ playbackRate: 1.25, preservePitch: false })).toEqual({ rate: 1.25, keepPitch: false });
  });

  it("sends only what changed", () => {
    expect(speedPatch({}, { rate: 1, keepPitch: true })).toEqual({});
    expect(speedPatch({}, { rate: 1.25, keepPitch: false })).toEqual({ playbackRate: 1.25, preservePitch: false });
    expect(speedPatch({ playbackRate: 1.25 }, { rate: 1.25, keepPitch: false })).toEqual({ preservePitch: false });
    expect(speedPatch({ playbackRate: 0.85 }, { rate: 1, keepPitch: true })).toEqual({ playbackRate: 1 });
  });

  it("says how long the song plays at its speed", () => {
    expect(playLengthText(180, 1.25)).toBe("Plays in 2:24 instead of 3:00");
    expect(playLengthText(130, 0.5)).toBe("Plays in 4:20 instead of 2:10");
    expect(playLengthText(180, 1)).toBeNull();
    expect(playLengthText(null, 1.25)).toBeNull();
  });
});
