import { describe, expect, it } from "vitest";
import {
  DOWNLOADER_ONLINE_WINDOW_MS,
  STATUS_META,
  downloaderStatus,
  pluralWaiting,
  relativeTimeAgo,
  rowSubtitle,
  summarizeAddResults,
} from "./ui";

const MINUTE_MS = 60_000;

describe("summarizeAddResults", () => {
  it("counts each outcome into the SPEC 8.2 toast copy", () => {
    const results = [
      { index: 0, line: "a", status: "added" as const, message: "Added" },
      { index: 1, line: "b", status: "added" as const, message: "Added" },
      { index: 2, line: "c", status: "added" as const, message: "Added" },
      { index: 3, line: "d", status: "already" as const, message: "Already in your library" },
    ];
    expect(summarizeAddResults(results)).toBe("3 added, 1 already in library");
  });

  it("mentions failures", () => {
    expect(
      summarizeAddResults([
        { index: 0, line: "a", status: "error", message: "Not a YouTube or SoundCloud song link" },
        { index: 1, line: "b", status: "added", message: "Added" },
      ]),
    ).toBe("1 added, 1 failed");
  });

  it("returns null for an empty batch", () => {
    expect(summarizeAddResults([])).toBe(null);
  });
});

describe("relativeTimeAgo", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");

  it("formats minutes, hours and days", () => {
    expect(relativeTimeAgo(new Date(now - 30_000).toISOString(), now)).toBe("just now");
    expect(relativeTimeAgo(new Date(now - MINUTE_MS).toISOString(), now)).toBe("1 minute ago");
    expect(relativeTimeAgo(new Date(now - 5 * MINUTE_MS).toISOString(), now)).toBe("5 minutes ago");
    expect(relativeTimeAgo(new Date(now - 3 * 60 * MINUTE_MS).toISOString(), now)).toBe("3 hours ago");
    expect(relativeTimeAgo(new Date(now - 2 * 24 * 60 * MINUTE_MS).toISOString(), now)).toBe("2 days ago");
  });

  it("is blank for null or unparsable input", () => {
    expect(relativeTimeAgo(null, now)).toBe("");
    expect(relativeTimeAgo("not-a-date", now)).toBe("");
  });
});

describe("downloaderStatus", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");

  it("is online within the 2 minute window", () => {
    const seen = new Date(now - DOWNLOADER_ONLINE_WINDOW_MS + 1000).toISOString();
    expect(downloaderStatus(seen, now)).toEqual({ online: true, text: "Downloader online" });
  });

  it("shows the last seen time when offline", () => {
    const seen = new Date(now - 3 * MINUTE_MS).toISOString();
    expect(downloaderStatus(seen, now)).toEqual({
      online: false,
      text: "Downloader offline, last seen 3 minutes ago",
    });
  });

  it("handles a downloader that never checked in", () => {
    expect(downloaderStatus(null, now)).toEqual({ online: false, text: "Downloader offline" });
  });
});

describe("row and waiting copy", () => {
  it("joins artist and album, skipping blanks", () => {
    expect(rowSubtitle("Artist", "Album")).toBe("Artist · Album");
    expect(rowSubtitle("Artist", null)).toBe("Artist");
    expect(rowSubtitle("", "Album")).toBe("Album");
    expect(rowSubtitle("  ", "")).toBe("");
  });

  it("uses singular for one waiting song", () => {
    expect(pluralWaiting(1)).toBe("1 song waiting for your PC");
    expect(pluralWaiting(3)).toBe("3 songs waiting for your PC");
  });
});

describe("STATUS_META", () => {
  it("labels every status with a dot except ready", () => {
    expect(STATUS_META.waiting).toEqual({ label: "Waiting for your PC", dotClass: "bg-warn" });
    expect(STATUS_META.downloading).toEqual({ label: "Downloading", dotClass: "bg-info" });
    expect(STATUS_META.failed).toEqual({ label: "Failed", dotClass: "bg-bad" });
    expect(STATUS_META.ready).toEqual({ label: "", dotClass: null });
  });
});
