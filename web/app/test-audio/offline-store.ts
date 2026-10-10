/**
 * IndexedDB access for the test page's offline copy, following SPEC 8.9's shape:
 * database tapedeck-offline, store audio, record { blob, bytes, savedAt }.
 * DOM-only module; unit tests cover the pure logic in tones.ts.
 */
import { OFFLINE_AUDIO_STORE, OFFLINE_DB_NAME } from "./tones";

export type OfflineAudioRecord = { blob: Blob; bytes: number; savedAt: number };

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Open without a version so an existing database (the T4 offline code may
    // add stores at a higher version) is never downgraded or blocked.
    const request = indexedDB.open(OFFLINE_DB_NAME);
    request.onupgradeneeded = () => {
      // Runs only when the database is new; add the store if it is missing.
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_AUDIO_STORE)) {
        db.createObjectStore(OFFLINE_AUDIO_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${OFFLINE_DB_NAME}`));
    request.onblocked = () =>
      reject(new Error(`Opening ${OFFLINE_DB_NAME} is blocked by another tab`));
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function saveOfflineAudio(key: string, blob: Blob): Promise<OfflineAudioRecord> {
  const record: OfflineAudioRecord = { blob, bytes: blob.size, savedAt: Date.now() };
  const db = await openOfflineDb();
  try {
    const store = db.transaction(OFFLINE_AUDIO_STORE, "readwrite").objectStore(OFFLINE_AUDIO_STORE);
    await idbRequest(store.put(record, key));
  } finally {
    db.close();
  }
  return record;
}

export async function getOfflineAudio(key: string): Promise<OfflineAudioRecord | null> {
  const db = await openOfflineDb();
  try {
    const store = db.transaction(OFFLINE_AUDIO_STORE, "readonly").objectStore(OFFLINE_AUDIO_STORE);
    const record = await idbRequest(store.get(key) as IDBRequest<OfflineAudioRecord | undefined>);
    return record ?? null;
  } finally {
    db.close();
  }
}

/** SPEC 8.9: call navigator.storage.persist() on first download. Best effort by design. */
export async function requestStoragePersistence(): Promise<boolean> {
  try {
    return await navigator.storage.persist();
  } catch {
    // Safari can throw when storage is unavailable; persistence is a hint, not a requirement.
    return false;
  }
}
