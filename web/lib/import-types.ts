/**
 * Playlist import (V2-PLAN T13): the shapes the import routes send to the
 * browser. No server imports here, so client components can use them. The
 * adapter interface itself lives in lib/importers/types.ts.
 */

/** The music services the picker can show, in the plan's order. */
export const SERVICE_IDS = ['spotify', 'apple', 'ytmusic', 'soundcloud', 'youtube', 'tidal', 'deezer', 'test'] as const
export type ServiceId = (typeof SERVICE_IDS)[number]

export const SERVICE_LABELS: Readonly<Record<ServiceId, string>> = {
  spotify: 'Spotify',
  apple: 'Apple Music',
  ytmusic: 'YouTube Music',
  soundcloud: 'SoundCloud',
  youtube: 'YouTube',
  tidal: 'Tidal',
  deezer: 'Deezer',
  test: 'Test music service',
}

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === 'string' && (SERVICE_IDS as readonly string[]).includes(value)
}

/** How the owner connects: log in, paste links, or upload a file. */
export type ConnectMethod = 'login' | 'link' | 'file'
export const CONNECT_METHODS: readonly ConnectMethod[] = ['login', 'link', 'file']

export function isConnectMethod(value: unknown): value is ConnectMethod {
  return value === 'login' || value === 'link' || value === 'file'
}

/** One connect slot on the connect step, backed by one importer. */
export interface ConnectOption {
  method: ConnectMethod
  /** The importer id that handles this slot. */
  importer: string
  /** Short help under the slot, in plain words. */
  hint: string
  /** For the file slot: the `accept` attribute of the file picker. */
  accept?: string
}

/** GET /api/import/services: only services with at least one available importer. */
export interface ServiceOption {
  id: ServiceId
  label: string
  options: ConnectOption[]
}

export type ImportJobStatus = 'login' | 'new' | 'waiting_pc' | 'listed' | 'importing' | 'done' | 'failed'

/** One playlist on the checklist. */
export interface ChecklistPlaylist {
  ref: string
  name: string
  coverUrl: string | null
  trackCount: number | null
  /** "liked" is the source's Liked songs. */
  kind: 'playlist' | 'liked'
  /** Imported before: the Tapedeck playlist it went into, else null. */
  importedPlaylistId: string | null
}

/** A song that needs a look on the progress screen. */
export interface NeedsLookSong {
  /** The import item (Skip takes this id). */
  itemId: string
  trackId: string | null
  title: string
  artist: string
  /** tracks.source: only 'catalog' songs can pick another version. */
  source: string | null
  error: string
  matchInfo: unknown
  resolvedUrl: string | null
}

/**
 * Live counts for "142 of 150 ready, 6 waiting, 2 need a look". A song in
 * two ticked playlists counts once; skipped songs do not count.
 */
export interface ImportProgress {
  total: number
  ready: number
  waiting: number
  needsLook: number
  /** Songs not matched and added yet (they count as waiting too). */
  pending: number
  skipped: number
  /** Up to 50 of the songs that need a look. */
  needsLookSongs: NeedsLookSong[]
}

/** GET /api/import/jobs/:id and the other job routes. */
export interface ImportJobView {
  id: string
  service: ServiceId
  serviceLabel: string
  importer: string
  method: ConnectMethod
  status: ImportJobStatus
  error: string
  /** Null until listed. */
  playlists: ChecklistPlaylist[] | null
  /** The ticked playlists with their Tapedeck playlist ids; `error` when its songs could not be read. */
  selected: { ref: string; name: string; playlistId: string | null; fetched: boolean; error?: string }[]
  createdAt: string | null
  /** Present once the import has started. */
  progress: ImportProgress | null
}

/** POST /api/import/jobs: a login job also carries where to send the browser. */
export interface CreateJobResponse {
  job: ImportJobView
  redirectUrl?: string
}

/** POST /api/import/jobs/:id/chunk. */
export interface ChunkResponse {
  job: ImportJobView
  /** True when nothing is left for the browser to drive. */
  done: boolean
  /** Another request is working on this job; wait a moment and try again. */
  busy?: boolean
}

/** GET /api/import/jobs: recent imports for "Your imports". */
export interface ImportJobSummary {
  id: string
  service: ServiceId
  serviceLabel: string
  status: ImportJobStatus
  createdAt: string | null
  playlistNames: string[]
  progress: Pick<ImportProgress, 'total' | 'ready' | 'waiting' | 'needsLook'> | null
}
