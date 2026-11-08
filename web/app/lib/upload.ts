/**
 * Upload your own songs (T15), browser side: everything that happens to one
 * file, in order.
 *
 *   1. Check it is a song file of a sensible size (lib/upload-rules.ts).
 *   2. Read its tags (title, artist, album, cover art, length) with
 *      music-metadata, loaded only when the first upload starts. A file the
 *      reader can not make sense of is not a song: it stops here.
 *   3. Fingerprint it, so the same file uploaded twice is "Already in your
 *      library" before any bytes move.
 *   4. POST /api/uploads for presigned PUT URLs, then PUT the file straight
 *      to storage (R2) with progress, and the shrunk cover art next to it.
 *   5. POST /api/uploads/<id>/complete: the song is in the library, ready.
 *
 * The queue and the screen live in components/UploadsProvider.tsx.
 */
import {
  COVER_SIZE_PX,
  MAX_COVER_BYTES,
  UPLOAD_FORMATS,
  UPLOAD_MESSAGES,
  uploadExt,
  uploadProblem,
} from "../../lib/upload-rules";

/** A failure with a message meant for the owner. */
export class UploadFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadFailure";
  }
}

export interface SongTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  durationSec: number | null;
  picture: { data: Uint8Array; format: string } | null;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\0/g, "").trim();
  return trimmed || null;
}

/** The parts of a music-metadata result this needs (kept loose for tests). */
export interface ParsedMetadata {
  format: { container?: string; codec?: string; duration?: number; numberOfChannels?: number; sampleRate?: number };
  common: {
    title?: string;
    artist?: string;
    artists?: string[];
    album?: string;
    albumartist?: string;
    picture?: { data: Uint8Array; format: string }[];
  };
}

/**
 * The tags from a parsed file, or an UploadFailure when nothing in it says
 * "audio" (a renamed document or picture parses to an empty result).
 */
export function tagsFromMetadata(meta: ParsedMetadata): SongTags {
  const { format, common } = meta;
  const looksLikeAudio = Boolean(format.codec || format.sampleRate || format.numberOfChannels || format.duration);
  if (!looksLikeAudio) throw new UploadFailure(UPLOAD_MESSAGES.unreadable);
  const duration = format.duration;
  const picture = common.picture?.find((p) => p.data?.byteLength > 0) ?? null;
  return {
    title: clean(common.title),
    artist: clean(common.artist) ?? clean(common.artists?.join(", ")),
    album: clean(common.album),
    albumArtist: clean(common.albumartist),
    durationSec: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
    picture: picture ? { data: picture.data, format: picture.format || "image/jpeg" } : null,
  };
}

/** Step 2: read the tags. Throws UploadFailure for files that are not songs. */
export async function readTags(file: File): Promise<SongTags> {
  const { parseBlob } = await import("music-metadata");
  let meta: ParsedMetadata;
  try {
    meta = (await parseBlob(file, { duration: false })) as unknown as ParsedMetadata;
  } catch {
    throw new UploadFailure(UPLOAD_MESSAGES.unreadable);
  }
  const tags = tagsFromMetadata(meta);
  if (tags.durationSec == null) tags.durationSec = await durationFromPlayer(file);
  return tags;
}

/**
 * Some files (an MP3 without a length header) only reveal their length to
 * a player: ask a muted audio element, giving up after a few seconds.
 */
function durationFromPlayer(file: File, timeoutMs = 8000): Promise<number | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const finish = (value: number | null) => {
      window.clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    audio.preload = "metadata";
    audio.muted = true;
    audio.onloadedmetadata = () =>
      finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

const FINGERPRINT_SLICE = 1024 * 1024;

/**
 * Step 3: SHA-256 over the size, the first MB and the last MB. Reading the
 * whole file would mean holding it all in memory on the phone; these parts
 * already tell two different songs apart.
 */
export async function fingerprint(file: Blob): Promise<string> {
  const head = await file.slice(0, FINGERPRINT_SLICE).arrayBuffer();
  const tail = file.size > FINGERPRINT_SLICE ? await file.slice(-FINGERPRINT_SLICE).arrayBuffer() : new ArrayBuffer(0);
  const size = new TextEncoder().encode(`${file.size}:`);
  const all = new Uint8Array(size.byteLength + head.byteLength + tail.byteLength);
  all.set(size, 0);
  all.set(new Uint8Array(head), size.byteLength);
  all.set(new Uint8Array(tail), size.byteLength + head.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The picture as a JPEG no bigger than COVER_SIZE_PX; null when it can not be drawn. */
export async function shrinkCover(picture: { data: Uint8Array; format: string }): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const source = new Blob([picture.data as BlobPart], { type: picture.format.includes("/") ? picture.format : "image/jpeg" });
  const url = URL.createObjectURL(source);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("cover did not load"));
      img.src = url;
    });
    const scale = Math.min(1, COVER_SIZE_PX / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    return jpeg && jpeg.size > 0 && jpeg.size <= MAX_COVER_BYTES ? jpeg : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const CONNECTION_PROBLEM = "Upload failed. Check your connection and try again.";

/** PUT a file to a presigned URL, reporting progress from 0 to 1. */
export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new UploadFailure(`Upload failed (${xhr.status}). Try again.`));
      }
    };
    xhr.onerror = () => reject(new UploadFailure(CONNECTION_PROBLEM));
    xhr.onabort = () => reject(new UploadFailure("Upload stopped."));
    xhr.send(body);
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new UploadFailure(CONNECTION_PROBLEM);
  }
  const json = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!response.ok || !json) {
    const message = typeof json?.error === "string" && json.error ? json.error : `Upload failed (${response.status}). Try again.`;
    throw new UploadFailure(message);
  }
  return json;
}

type StartResponse =
  | { status: "already"; trackId: string; message: string }
  | { status: "ready"; id: string; contentType: string; uploadUrl: string; coverUploadUrl: string | null };

type CompleteResponse =
  | { status: "added"; message: string; track: { id: string; title: string } }
  | { status: "already"; trackId: string; message: string };

export type UploadStage = "reading" | "uploading" | "saving";

export interface UploadOutcome {
  status: "added" | "already";
  /** The title the song got (from its tags, or its file name). */
  title: string | null;
  trackId: string;
}

/** Steps 1 to 5 for one file. Throws UploadFailure with the message to show. */
export async function uploadSong(
  file: File,
  report: (stage: UploadStage, progress: number, title: string | null) => void,
): Promise<UploadOutcome> {
  const problem = uploadProblem(file);
  if (problem) throw new UploadFailure(problem);
  const ext = uploadExt(file.name)!;

  report("reading", 0, null);
  const tags = await readTags(file);
  const title = tags.title;
  report("reading", 0, title);
  const [cover, print] = await Promise.all([tags.picture ? shrinkCover(tags.picture) : Promise.resolve(null), fingerprint(file)]);

  const start = await postJson<StartResponse>("/api/uploads", {
    fileName: file.name,
    bytes: file.size,
    fingerprint: print,
    ...(cover ? { coverBytes: cover.size } : {}),
  });
  if (start.status === "already") return { status: "already", title, trackId: start.trackId };

  report("uploading", 0, title);
  await putWithProgress(start.uploadUrl, file, start.contentType || UPLOAD_FORMATS[ext], (fraction) =>
    report("uploading", fraction, title),
  );
  let coverStored = false;
  if (cover && start.coverUploadUrl) {
    // A cover that fails to upload never fails the song: it shows the blank cover.
    coverStored = await putWithProgress(start.coverUploadUrl, cover, "image/jpeg", () => {}).then(
      () => true,
      () => false,
    );
  }

  report("saving", 1, title);
  const done = await postJson<CompleteResponse>(`/api/uploads/${encodeURIComponent(start.id)}/complete`, {
    fileName: file.name,
    fingerprint: print,
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    albumArtist: tags.albumArtist,
    durationSec: tags.durationSec,
    cover: coverStored,
  });
  if (done.status === "already") return { status: "already", title, trackId: done.trackId };
  return { status: "added", title: done.track.title, trackId: done.track.id };
}

/** "2 added, 1 already in library, 1 failed": the same toast copy as pasted links. */
export function summarizeUploads(counts: { added: number; already: number; failed: number }): string | null {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.already > 0) parts.push(`${counts.already} already in library`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.length > 0 ? parts.join(", ") : null;
}
