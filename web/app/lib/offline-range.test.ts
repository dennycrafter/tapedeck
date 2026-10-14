import { describe, expect, it } from "vitest";
import { audioResponse, offlineAudioUrl, parseRange, trackIdFromOfflinePath } from "./offline-range";

const ID = "11111111-2222-4333-8444-555555555555";
const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i)).buffer;

describe("offline audio addresses", () => {
  it("round trips a track id", () => {
    expect(trackIdFromOfflinePath(offlineAudioUrl(ID))).toBe(ID);
  });
  it("rejects other paths and non-ids", () => {
    expect(trackIdFromOfflinePath("/api/tracks/x")).toBeNull();
    expect(trackIdFromOfflinePath("/offline-audio/../secret")).toBeNull();
  });
});

describe("parseRange", () => {
  it("reads start-end, open ended and suffix ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
  });
  it("no header means the whole file; nonsense or out of range is invalid", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBe("invalid");
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
    expect(parseRange("bytes=9-3", 100)).toBe("invalid");
  });
});

describe("audioResponse", () => {
  it("200 with the whole file when no range is asked", async () => {
    const response = audioResponse(bytes, null);
    expect(response.status).toBe(200);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe("100");
    expect(response.headers.get("Content-Type")).toBe("audio/mp4");
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });
  it("206 with exactly the asked bytes", async () => {
    const response = audioResponse(bytes, "bytes=10-19");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
  it("416 outside the file", () => {
    const response = audioResponse(bytes, "bytes=200-300");
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */100");
  });
});
