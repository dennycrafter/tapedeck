/**
 * The phone's offline store (SPEC 8.9): IndexedDB database `tapedeck-offline`
 * with three stores:
 *  - `library`: the last GET /api/library snapshot (key "snapshot"),
 *  - `audio`: downloaded songs keyed by track id, `{ blob, bytes, savedAt }`
 *    (the /test-audio page keeps its own test tone here too, key "test1"),
 *  - `plays`: plays made offline, sent to POST /api/plays once back online.
 * Browser only. Every function is safe to call when IndexedDB is missing or
 * blocked: reads come back empty and writes reject with a plain error.
 */
import type { LibraryResponse } from "./api";

export const OFFLINE_DB_NAME = "tapedeck-offline";
/** Version 1 is the /test-audio page's database with only `audio`. */
export const OFFLINE_DB_VERSION = 2;
export const LIBRARY_STORE = "library";
export const AUDIO_STORE = "audio";
export const PLAYS_STORE = "plays";
const SNAPSHOT_KEY = "snapshot";

export interface AudioRecord {
  blob: Blob;
  bytes: number;
  savedAt: number;
}

export interface QueuedPlay {
  trackId: string;
  seconds: number;
  /** ISO time the play happened. */
  playedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser has no offline storage"));
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [LIBRARY_STORE, AUDIO_STORE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      if (!db.objectStoreNames.contains(PLAYS_STORE)) db.createObjectStore(PLAYS_STORE, { autoIncrement: true });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab (or the test page) asking for a newer version: step aside.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error("Could not open offline storage"));
    };
    request.onblocked = () => {
      opening = null;
      reject(new Error("Offline storage is busy in another tab"));
    };
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage request failed"));
  });
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

// ---------------------------------------------------------------------------
// Library snapshot
// ---------------------------------------------------------------------------

export async function saveSnapshot(snapshot: LibraryResponse): Promise<void> {
  await done((await store(LIBRARY_STORE, "readwrite")).put(snapshot, SNAPSHOT_KEY));
}

export async function loadSnapshot(): Promise<LibraryResponse | null> {
  try {
    const value = await done((await store(LIBRARY_STORE, "readonly")).get(SNAPSHOT_KEY));
    return (value as LibraryResponse | undefined) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Downloaded songs
// ---------------------------------------------------------------------------

export async function putAudio(trackId: string, blob: Blob): Promise<AudioRecord> {
  const record: AudioRecord = { blob, bytes: blob.size, savedAt: Date.now() };
  await done((await store(AUDIO_STORE, "readwrite")).put(record, trackId));
  return record;
}

export async function getAudio(trackId: string): Promise<AudioRecord | null> {
  try {
    const value = await done((await store(AUDIO_STORE, "readonly")).get(trackId));
    return (value as AudioRecord | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function deleteAudio(trackId: string): Promise<void> {
  await done((await store(AUDIO_STORE, "readwrite")).delete(trackId));
}

/** Downloaded songs only (track ids), with their sizes; the test page's tone is skipped. */
export async function listAudio(): Promise<{ id: string; bytes: number }[]> {
  try {
    const audio = await store(AUDIO_STORE, "readonly");
    const keys = (await done(audio.getAllKeys())) as IDBValidKey[];
    const values = (await done((await store(AUDIO_STORE, "readonly")).getAll())) as AudioRecord[];
    return keys
      .map((key, i) => ({ id: String(key), bytes: values[i]?.bytes ?? 0 }))
      .filter((entry) => UUID.test(entry.id));
  } catch {
    return [];
  }
}

export async function clearDownloadedAudio(): Promise<void> {
  for (const entry of await listAudio()) await deleteAudio(entry.id);
}

// ---------------------------------------------------------------------------
// Plays made offline (SPEC 8.6: they queue and flush when back online)
// ---------------------------------------------------------------------------

export async function queuePlay(play: QueuedPlay): Promise<void> {
  await done((await store(PLAYS_STORE, "readwrite")).add(play));
}

export async function listQueuedPlays(): Promise<{ key: IDBValidKey; play: QueuedPlay }[]> {
  try {
    const keys = (await done((await store(PLAYS_STORE, "readonly")).getAllKeys())) as IDBValidKey[];
    const plays = (await done((await store(PLAYS_STORE, "readonly")).getAll())) as QueuedPlay[];
    return keys.map((key, i) => ({ key, play: plays[i] as QueuedPlay }));
  } catch {
    return [];
  }
}

export async function deleteQueuedPlay(key: IDBValidKey): Promise<void> {
  await done((await store(PLAYS_STORE, "readwrite")).delete(key));
}
