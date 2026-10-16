/** The wording of the import screens (V2-PLAN T13). */
import { describe, expect, it } from "vitest";
import {
  defaultSelection,
  importButtonLabel,
  jobStatusText,
  pastedLines,
  percentReady,
  progressSentence,
  serviceNames,
  songCount,
} from "./import-view";

describe("progressSentence", () => {
  it("reads like the plan's example", () => {
    expect(progressSentence({ total: 150, ready: 142, waiting: 4, pending: 2, needsLook: 2 })).toBe(
      "142 of 150 ready, 6 waiting, 2 need a look",
    );
  });

  it("leaves out parts that are 0 and says 'needs' for one song", () => {
    expect(progressSentence({ total: 3, ready: 3, waiting: 0, pending: 0, needsLook: 0 })).toBe("3 of 3 ready");
    expect(progressSentence({ total: 3, ready: 2, waiting: 0, pending: 0, needsLook: 1 })).toBe("2 of 3 ready, 1 needs a look");
    expect(progressSentence({ total: 6, ready: 0, waiting: 0, pending: 6, needsLook: 0 })).toBe("0 of 6 ready, 6 waiting");
  });
});

describe("small labels", () => {
  it("counts songs", () => {
    expect(songCount(1)).toBe("1 song");
    expect(songCount(0)).toBe("0 songs");
    expect(songCount(null)).toBe("");
  });

  it("labels the Import button", () => {
    expect(importButtonLabel(0)).toBe("Tick a playlist to import");
    expect(importButtonLabel(1)).toBe("Import 1 playlist");
    expect(importButtonLabel(4)).toBe("Import 4 playlists");
  });

  it("names every job status in plain words", () => {
    expect(jobStatusText("waiting_pc")).toBe("Waiting for your PC");
    expect(jobStatusText("done")).toBe("Imported");
    expect(jobStatusText("failed")).toBe("Didn't work");
  });

  it("names the services on the Home card", () => {
    expect(serviceNames([])).toBe("");
    expect(serviceNames([{ label: "Spotify" }])).toBe("Spotify");
    expect(serviceNames([{ label: "Spotify" }, { label: "Apple Music" }])).toBe("Spotify and Apple Music");
    expect(serviceNames([{ label: "A" }, { label: "B" }, { label: "C" }])).toBe("A, B and C");
    expect(serviceNames([{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }])).toBe("A, B and 2 more");
  });
});

describe("checklist helpers", () => {
  it("ticks every playlist not imported before", () => {
    const base = { name: "x", coverUrl: null, trackCount: 1, kind: "playlist" as const };
    expect(
      defaultSelection([
        { ...base, ref: "a", importedPlaylistId: null },
        { ...base, ref: "b", importedPlaylistId: "some-id" },
        { ...base, ref: "c", importedPlaylistId: null },
      ]),
    ).toEqual(["a", "c"]);
  });

  it("reads one link per line", () => {
    expect(pastedLines(" a \n\n b\r\n")).toEqual(["a", "b"]);
  });

  it("shows the share of ready songs", () => {
    expect(percentReady({ total: 0, ready: 0 })).toBe(0);
    expect(percentReady({ total: 3, ready: 1 })).toBe(33);
  });
});
