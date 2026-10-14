/**
 * Offline on the phone (SPEC 8.9), as one small browser store the UI reads
 * through useSyncExternalStore:
 *  - which songs are downloaded on this device, and download progress,
 *  - whether we are online (navigator.onLine, plus "the library came from
 *    the saved snapshot"),
 *  - where the player gets audio: a blob URL for downloaded songs, the
 *    presigned URL otherwise (8.8),
 *  - plays made offline, queued in IndexedDB and sent once back online.
 */
import {
  clearDownloadedAudio,
  deleteAudio,
  deleteQueuedPlay,
  getAudio,
  listAudio,
  listQueuedPlays,
  putAudio,
  queuePlay,
} from "./offline-db";

export interface OfflineState {
  /** False once the browser says offline or the library came from the snapshot. */
  readonly online: boolean;
  /** The library on screen is the saved snapshot, not fresh from the server. */
  readonly fromSnapshot: boolean;
  /** Downloaded track ids and their sizes on this device. */
  readonly downloaded: ReadonlyMap<string, number>;
  /** Downloads in progress: 0 to 1. */
  readonly progress: ReadonlyMap<string, number>;
  readonly loaded: boolean;
}

type Listener = () => void;

let state: OfflineState = {
  online: true,
  fromSnapshot: false,
  downloaded: new Map(),
  progress: new Map(),
  loaded: false,
};
const listeners = new Set<Listener>();
let started = false;
let persistAsked = false;
let downloadChain: Promise<unknown> = Promise.resolve();

function set(patch: Partial<OfflineState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export const offlineStore = {
  getState: (): OfflineState => state,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const SERVER_STATE: OfflineState = {
  online: true,
  fromSnapshot: false,
  downloaded: new Map(),
  progress: new Map(),
  loaded: false,
};
export const getServerOfflineState = (): OfflineState => SERVER_STATE;

/** True when a song can play right now: ready, and downloaded if we are offline. */
export function canPlayNow(track: { id: string; status: string }, current: OfflineState = state): boolean {
  if (track.status !== "ready") return false;
  return current.online || current.downloaded.has(track.id);
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Load what is on this device and start listening for online/offline. Idempotent. */
export function startOffline(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  set({ online: browserOnline() });
  window.addEventListener("online", () => {
    set({ online: true });
    void flushPlays();
  });
  window.addEventListener("offline", () => set({ online: false }));
  void listAudio().then((entries) => {
    set({ downloaded: new Map(entries.map((entry) => [entry.id, entry.bytes])), loaded: true });
  });
  void flushPlays();
}

/** The library provider reports whether it is showing the saved snapshot. */
export function setFromSnapshot(fromSnapshot: boolean): void {
  if (state.fromSnapshot === fromSnapshot && state.online === (browserOnline() && !fromSnapshot)) return;
  set({ fromSnapshot, online: browserOnline() && !fromSnapshot });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

async function playbackUrlFromServer(trackId: string, download = false): Promise<string> {
  const query = download ? "?download=1" : "";
  const response = await fetch(`/api/tracks/${encodeURIComponent(trackId)}/url${query}`);
  if (!response.ok) throw new Error(`Could not get the song (${response.status})`);
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string" || !body.url) throw new Error("The song link was missing");
  return body.url;
}

/** Fetch the whole file, reporting progress when the size is known. */
async function fetchBlob(url: string, onProgress: (fraction: number) => void): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!response.body || !total) {
    const blob = await response.blob();
    onProgress(1);
    return new Blob([blob], { type: "audio/mp4" });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReported = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const fraction = Math.min(1, received / total);
    if (fraction - lastReported >= 0.02 || fraction === 1) {
      lastReported = fraction;
      onProgress(fraction);
    }
  }
  return new Blob(chunks as BlobPart[], { type: "audio/mp4" });
}

function setProgress(trackId: string, fraction: number | null): void {
  const progress = new Map(state.progress);
  if (fraction == null) progress.delete(trackId);
  else progress.set(trackId, fraction);
  set({ progress });
}

async function downloadOne(trackId: string): Promise<void> {
  if (state.downloaded.has(trackId)) return;
  if (!persistAsked) {
    persistAsked = true;
    // SPEC 8.9 and 12: ask the phone to keep downloads even when space runs low.
    void navigator.storage?.persist?.().catch(() => false);
  }
  setProgress(trackId, 0);
  try {
    const url = await playbackUrlFromServer(trackId);
    const blob = await fetchBlob(url, (fraction) => setProgress(trackId, fraction));
    const record = await putAudio(trackId, blob);
    const downloaded = new Map(state.downloaded);
    downloaded.set(trackId, record.bytes);
    set({ downloaded });
  } finally {
    setProgress(trackId, null);
  }
}

/** Download songs one after another (ready songs only); resolves with how many failed. */
export function downloadTracks(tracks: readonly { id: string; status: string }[]): Promise<number> {
  const ids = tracks
    .filter((track) => track.status === "ready" && !state.downloaded.has(track.id) && !state.progress.has(track.id))
    .map((track) => track.id);
  // Show them as queued straight away.
  for (const id of ids) setProgress(id, 0);
  const run = downloadChain.then(async () => {
    let failed = 0;
    for (const id of ids) {
      try {
        await downloadOne(id);
      } catch (error) {
        failed += 1;
        console.warn(`offline: download of ${id} failed`, error);
      }
    }
    return failed;
  });
  downloadChain = run.catch(() => undefined);
  return run;
}

export async function removeDownload(trackId: string): Promise<void> {
  await deleteAudio(trackId);
  forgetObjectUrl(trackId);
  const downloaded = new Map(state.downloaded);
  downloaded.delete(trackId);
  set({ downloaded });
}

export async function removeAllDownloads(): Promise<void> {
  await clearDownloadedAudio();
  forgetAllObjectUrls();
  set({ downloaded: new Map() });
}

export function downloadedBytes(current: OfflineState = state): number {
  let total = 0;
  for (const bytes of current.downloaded.values()) total += bytes;
  return total;
}

// ---------------------------------------------------------------------------
// Player source (SPEC 8.8, 8.9)
// ---------------------------------------------------------------------------

/**
 * Blob URLs handed to the player, oldest first. Every call makes a fresh one
 * (a retry after an audio error must not get the same link back); the last
 * few stay alive for the current and next song, older ones are revoked
 * (SPEC 8.9: revoke the previous object URL on track change).
 */
const objectUrls: { trackId: string; url: string }[] = [];
const KEEP_OBJECT_URLS = 4;

function forgetObjectUrl(trackId: string): void {
  for (let i = objectUrls.length - 1; i >= 0; i--) {
    if (objectUrls[i]?.trackId === trackId) {
      URL.revokeObjectURL(objectUrls[i]!.url);
      objectUrls.splice(i, 1);
    }
  }
}

function forgetAllObjectUrls(): void {
  for (const entry of objectUrls) URL.revokeObjectURL(entry.url);
  objectUrls.length = 0;
}

/** Where the player loads a song from: the downloaded copy if there is one, else the server. */
export async function resolvePlaybackUrl(trackId: string): Promise<string> {
  if (state.downloaded.has(trackId) || !state.loaded) {
    const record = await getAudio(trackId);
    if (record) {
      const url = URL.createObjectURL(record.blob);
      objectUrls.push({ trackId, url });
      while (objectUrls.length > KEEP_OBJECT_URLS) {
        const oldest = objectUrls.shift();
        if (oldest) URL.revokeObjectURL(oldest.url);
      }
      return url;
    }
  }
  if (!state.online) throw new Error("This song isn't downloaded, and you're offline");
  return playbackUrlFromServer(trackId);
}

// ---------------------------------------------------------------------------
// Plays (SPEC 8.6: offline plays queue in IndexedDB and flush when back online)
// ---------------------------------------------------------------------------

async function postPlay(trackId: string, seconds: number, playedAt?: string): Promise<boolean> {
  try {
    const response = await fetch("/api/plays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(playedAt ? { trackId, seconds, playedAt } : { trackId, seconds }),
      keepalive: true,
    });
    // 4xx means the server read it and said no (a deleted song): do not retry.
    return response.ok || (response.status >= 400 && response.status < 500);
  } catch {
    return false;
  }
}

/** Records a play; when the network is down it waits in IndexedDB instead. Never throws. */
export function recordPlay(trackId: string, seconds: number): void {
  const playedAt = new Date().toISOString();
  const keep = () =>
    queuePlay({ trackId, seconds, playedAt }).catch((error: unknown) => {
      console.warn("offline: could not keep a play for later", error);
    });
  if (!state.online || !browserOnline()) {
    void keep();
    return;
  }
  void postPlay(trackId, seconds, playedAt).then((sent) => {
    if (!sent) void keep();
  });
}

let flushing = false;

/** Send plays made offline, oldest first, with the time they happened. */
export async function flushPlays(): Promise<number> {
  if (flushing || !browserOnline()) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const { key, play } of await listQueuedPlays()) {
      if (!(await postPlay(play.trackId, play.seconds, play.playedAt))) break;
      await deleteQueuedPlay(key);
      sent += 1;
    }
  } finally {
    flushing = false;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Save to Files needs the presigned attachment URL on PC
// ---------------------------------------------------------------------------

export function attachmentUrl(trackId: string): Promise<string> {
  return playbackUrlFromServer(trackId, true);
}

export async function songBlob(trackId: string): Promise<Blob> {
  const record = state.downloaded.has(trackId) ? await getAudio(trackId) : null;
  if (record) return record.blob;
  const url = await playbackUrlFromServer(trackId);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not get the song (${response.status})`);
  return response.blob();
}
