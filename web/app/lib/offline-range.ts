/**
 * Serving a downloaded song from the phone's offline store at a normal
 * address (`/offline-audio/<track id>`), answered by the service worker
 * (app/sw.ts). Media players ask for byte ranges; this builds the right
 * 200 or 206 answer from the stored bytes. Pure, so it is unit tested.
 */

export const OFFLINE_AUDIO_PATH = "/offline-audio/";

export function offlineAudioUrl(trackId: string): string {
  return `${OFFLINE_AUDIO_PATH}${encodeURIComponent(trackId)}`;
}

/** The track id from an /offline-audio/<id> path, or null. */
export function trackIdFromOfflinePath(pathname: string): string | null {
  if (!pathname.startsWith(OFFLINE_AUDIO_PATH)) return null;
  const id = decodeURIComponent(pathname.slice(OFFLINE_AUDIO_PATH.length));
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** Parse "bytes=start-end" (also "bytes=start-" and "bytes=-suffix"); null when absent or unusable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** 200 with the whole file, 206 with the asked range, or 416 when the range is outside it. */
export function audioResponse(bytes: ArrayBuffer, rangeHeader: string | null, type = "audio/mp4"): Response {
  const size = bytes.byteLength;
  const range = parseRange(rangeHeader, size);
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  }
  if (range === null) {
    return new Response(bytes, { status: 200, headers: { ...base, "Content-Length": String(size) } });
  }
  const chunk = bytes.slice(range.start, range.end + 1);
  return new Response(chunk, {
    status: 206,
    headers: {
      ...base,
      "Content-Length": String(chunk.byteLength),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}
