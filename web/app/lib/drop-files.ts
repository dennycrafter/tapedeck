/**
 * Folders of songs (T15 follow-up): turn a drop, or a folder picked on PC,
 * into the song files inside it. A dropped album folder (also one with
 * "Disc 1" and "Disc 2" inside) is walked for MP3, M4A, WAV and FLAC files in
 * track order; everything else in it (cover.jpg, .cue, .log, .txt) is left out
 * quietly, since album folders are full of those. Loose files keep their own
 * checks, so a dropped photo still says "Not a song file".
 */
import { uploadExt } from "../../lib/upload-rules";

/** At most this many songs from one drop or one picked folder. */
export const MAX_FOLDER_SONGS = 500;
/** Stop walking after this many entries (a whole drive dropped by mistake). */
const MAX_ENTRIES_WALKED = 20000;

export const FOLDER_MESSAGES = {
  noSongs: "No songs in that folder. Upload MP3, M4A, WAV or FLAC.",
  leftOut: `Only the first ${MAX_FOLDER_SONGS} songs were added. Add the rest after these finish.`,
  unreadable: "Could not read that folder. Try again.",
} as const;

// The parts of the browser's file system entry API used here (tests pass fakes).
export interface DropFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  fullPath: string;
  file(ok: (file: File) => void, fail?: (error: unknown) => void): void;
}

export interface DropDirectoryEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  fullPath: string;
  createReader(): { readEntries(ok: (entries: DropEntry[]) => void, fail?: (error: unknown) => void): void };
}

export type DropEntry = DropFileEntry | DropDirectoryEntry;

export type DropItem = { kind: "file"; file: File } | { kind: "folder"; entry: DropDirectoryEntry };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Hidden files and folders (".DS_Store", "._01.mp3") and Mac zip leftovers. */
function hiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX");
}

/**
 * The songs among `list`, in track order ("2 B" before "10 A", "Disc 1"
 * before "Disc 2"), at most `limit`. `more` says some were left out.
 */
export function pickSongs<T>(list: T[], pathOf: (item: T) => string, limit = MAX_FOLDER_SONGS): { songs: T[]; more: boolean } {
  const songs = list
    .map((item) => ({ item, path: pathOf(item) }))
    .filter(({ path }) => !hiddenPath(path) && uploadExt(path.split("/").pop() ?? "") !== null)
    .sort((a, b) => collator.compare(a.path, b.path))
    .map(({ item }) => item);
  return { songs: songs.slice(0, limit), more: songs.length > limit };
}

/**
 * What a drop holds. Must run inside the drop event: the browser empties
 * the drop's item list as soon as the event is over.
 */
export function dropItems(data: DataTransfer): DropItem[] {
  const items = Array.from(data.items ?? []);
  if (items.length === 0) return Array.from(data.files ?? []).map((file) => ({ kind: "file", file }));
  const out: DropItem[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = (item.webkitGetAsEntry?.() ?? null) as unknown as DropEntry | null;
    if (entry?.isDirectory) {
      out.push({ kind: "folder", entry });
      continue;
    }
    const file = item.getAsFile();
    if (file) out.push({ kind: "file", file });
  }
  return out;
}

function readBatch(reader: ReturnType<DropDirectoryEntry["createReader"]>): Promise<DropEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: DropFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Every file entry under `roots`, walking subfolders. */
async function walk(roots: DropDirectoryEntry[]): Promise<DropFileEntry[]> {
  const found: DropFileEntry[] = [];
  const folders = [...roots];
  let seen = 0;
  while (folders.length > 0 && seen < MAX_ENTRIES_WALKED) {
    const folder = folders.shift()!;
    if (hiddenPath(folder.name)) continue;
    const reader = folder.createReader();
    // Chrome hands out at most 100 entries per call: read until empty.
    for (;;) {
      const batch = await readBatch(reader);
      if (batch.length === 0) break;
      seen += batch.length;
      for (const entry of batch) {
        if (entry.isDirectory) folders.push(entry);
        else found.push(entry);
      }
      if (seen >= MAX_ENTRIES_WALKED) break;
    }
  }
  return found;
}

export interface DropResult {
  /** Loose files first (in drop order), then the songs from the folders. */
  files: File[];
  /** How many folders were dropped. */
  folders: number;
  /** True when a folder held more than MAX_FOLDER_SONGS songs. */
  more: boolean;
}

export async function filesFromDrop(items: DropItem[], limit = MAX_FOLDER_SONGS): Promise<DropResult> {
  const loose = items.flatMap((item) => (item.kind === "file" ? [item.file] : []));
  const roots = items.flatMap((item) => (item.kind === "folder" ? [item.entry] : []));
  if (roots.length === 0) return { files: loose, folders: 0, more: false };
  const entries = await walk(roots);
  const { songs, more } = pickSongs(entries, (entry) => entry.fullPath, limit);
  const files = await Promise.all(songs.map(fileOf));
  return { files: [...loose, ...files], folders: roots.length, more };
}
