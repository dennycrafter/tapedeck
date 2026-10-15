import { describe, expect, it } from "vitest";
import {
  clampEnd,
  clampStart,
  draftEdges,
  initialTrimDraft,
  trimDraftProblem,
  trimPatch,
  trimSummary,
  type TrimDraft,
} from "./trim-edit";

const plain = { durationSec: 180 };
const auto = { durationSec: 180, autoTrimStartSec: 12.3, autoTrimEndSec: 175 };
const draft = (start: number | null, end: number | null, typing: string | null = null): TrimDraft => ({ start, end, typing });

describe("trim editor rules (T10)", () => {
  it("starts from the stored hand values", () => {
    expect(initialTrimDraft({ ...auto, trimStartSec: 4, trimEndSec: null })).toEqual(draft(4, null));
  });

  it("shows hand values, else the suggestion, else the whole song", () => {
    expect(draftEdges(plain, draft(null, null))).toEqual({ start: 0, end: 180 });
    expect(draftEdges(auto, draft(null, null))).toEqual({ start: 12.3, end: 175 });
    expect(draftEdges(auto, draft(2, null))).toEqual({ start: 2, end: 175 });
  });

  it("says what happened", () => {
    expect(trimSummary(plain, draft(null, null))).toBe("Not trimmed");
    expect(trimSummary(auto, draft(null, null))).toBe("Trimmed automatically: 12.3 s cut from the start, 5.0 s cut from the end");
    expect(trimSummary(auto, draft(20, null))).toBe("Trimmed: 20.0 s cut from the start, 5.0 s cut from the end");
    expect(trimSummary(auto, draft(0, 180))).toBe("Not trimmed");
    expect(trimSummary(plain, draft(null, 150))).toBe("Trimmed: 30.0 s cut from the end");
  });

  it("validates like the server", () => {
    expect(trimDraftProblem(plain, draft(20, 150))).toBeNull();
    expect(trimDraftProblem(plain, draft(20, 25))).toBe("Keep at least 10 seconds of the song.");
    expect(trimDraftProblem(plain, draft(null, 190))).toBe("The end can't be past the end of the song.");
    expect(trimDraftProblem(plain, draft(20, 150, "Enter the start as m:ss.s, for example 0:12.5."))).toMatch(/Enter the start/);
  });

  it("only sends a patch when the trim changed", () => {
    expect(trimPatch(auto, draft(null, null))).toEqual({});
    expect(trimPatch(auto, draft(20, null))).toEqual({ trimStartSec: 20, trimEndSec: null });
    expect(trimPatch({ ...auto, trimStartSec: 20 }, draft(null, null))).toEqual({ trimStartSec: null, trimEndSec: null });
  });

  it("keeps dragged handles at least 10 seconds apart and inside the song", () => {
    expect(clampStart(50, 150)).toBe(50);
    expect(clampStart(145, 150)).toBe(140);
    expect(clampStart(-3, 150)).toBe(0);
    expect(clampEnd(100, 20, 180)).toBe(100);
    expect(clampEnd(25, 20, 180)).toBe(30);
    expect(clampEnd(200, 20, 180)).toBe(180);
  });
});
