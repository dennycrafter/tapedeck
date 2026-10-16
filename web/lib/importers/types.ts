/**
 * The importer interface (V2-PLAN T13, "Adapters"). Every import source is
 * one file in web/lib/importers that exports one `Importer`, registered with
 * one line in ./index.ts. The core (job routes, chunked import, catalog
 * matching, progress) is generic over this interface: an adapter only lists
 * playlists and reads their songs; it never writes tracks or playlists.
 *
 * The two calls the plan names are `listPlaylists(input)` and
 * `getTracks(playlistRef)`. Both also get a context with the job, and both
 * may answer "pending" when the work happens on the PC (SoundCloud and
 * YouTube listing need yt-dlp, which only the PC downloader has).
 */

import type { ConnectMethod, ServiceId } from '../import-types'

export type { ConnectMethod, ServiceId } from '../import-types'

/** One playlist the source has. */
export interface ImportPlaylist {
  /**
   * Stable id at the source, unique within the job. Use the service's own
   * playlist id (for example Spotify's 22-character id) so a later import of
   * the same playlist, by any method, is marked "Imported". `liked` for the
   * Liked songs list.
   */
  ref: string
  name: string
  coverUrl?: string | null
  trackCount?: number | null
  /** "liked" shows first, labelled the way the source names it. Default "playlist". */
  kind?: 'playlist' | 'liked'
}

/** One song of a playlist, with the source's own metadata. */
export interface ImportTrack {
  /**
   * The source's own song id. A song with no catalog match is stored as
   * `import:<service>:<ref>`, so it must be stable and unique per service.
   */
  ref: string
  title: string
  artist: string
  album?: string | null
  durationSec?: number | null
  /** Matched first (Deezer `track/isrc:`), when the source has it. */
  isrc?: string | null
  /** The source's cover, used only when the catalog has no match. */
  coverUrl?: string | null
  /**
   * A direct YouTube or SoundCloud song link. The song then keeps that link
   * (source youtube or soundcloud, the normal download pipeline) instead of
   * waiting for the PC to find a copy. Leave empty for catalog songs.
   */
  link?: string | null
}

/** "Not yet: the PC is working on it." The UI shows "Waiting for your PC". */
export interface Pending {
  pending: true
}

export const PENDING: Pending = Object.freeze({ pending: true as const })

export function isPending(value: unknown): value is Pending {
  return typeof value === 'object' && value !== null && (value as Pending).pending === true
}

/** An uploaded file (method "file"), read on the server. */
export interface ImportFile {
  name: string
  type: string
  size: number
  text(): Promise<string>
  bytes(): Promise<Uint8Array>
}

/** What the owner gave on the connect step. */
export type ListInput =
  | { method: 'link'; links: string[] }
  /**
   * `file` is null when listing again after the PC answered (the upload is
   * gone by then): read what you kept from ctx.job.payload.
   */
  | { method: 'file'; file: ImportFile | null }
  /** After the login came back: what `login.finish` stored is in `ctx.job.payload`. */
  | { method: 'login' }

/** The job as an adapter sees it. */
export interface ImporterJob {
  id: string
  service: ServiceId
  method: ConnectMethod
  /**
   * The adapter's own data, kept between requests: what `listPlaylists`,
   * `getTracks` or `login.finish` returned as `payload`, and what the PC
   * sent back (lib/import-jobs.ts `releasePcJob`). Plain JSON. The core sets
   * one key itself: `links`, the pasted links of a "link" job.
   */
  payload: Record<string, unknown>
}

export interface ImportContext {
  job: ImporterJob
}

export interface ListResult {
  playlists: ImportPlaylist[]
  /** Merged into the job payload (for example the parsed links, to read songs later). */
  payload?: Record<string, unknown>
}

export interface TracksContext extends ImportContext {
  /** The `next` value from the previous page of this playlist, or null for the first page. */
  cursor: string | null
}

export interface TrackPage {
  tracks: ImportTrack[]
  /** More songs follow: the core calls again with this as `cursor`. Null or absent on the last page. */
  next?: string | null
  /** Merged into the job payload. */
  payload?: Record<string, unknown>
}

/**
 * A failure to show the owner as is. Write it in plain words, for example
 * "Spotify changed something, try the login option". Any other error shows a
 * generic "Could not read that. Try again." and is logged.
 */
export class ImportUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportUserError'
  }
}

/** The log-in flow (method "login"), for example MusicAPI's OAuth. */
export interface LoginFlow {
  /**
   * Where to send the browser to log in. `callbackUrl` is the app's fixed
   * return address for this importer (`/api/import/callback/<importer id>`);
   * carry `jobId` through the provider, usually in its `state` parameter.
   */
  start(ctx: { jobId: string; service: ServiceId; callbackUrl: string }): Promise<{ redirectUrl: string }>
  /**
   * The browser came back to `callbackUrl` with these query parameters.
   * Return the job it belongs to and what to keep in that job's payload (the
   * provider's user id, per job only). Throw ImportUserError when the log in
   * was cancelled or failed.
   */
  finish(params: URLSearchParams, ctx: { callbackUrl: string }): Promise<{ jobId: string; payload: Record<string, unknown> }>
}

export interface Importer {
  /** The file name without `.ts`, for example `spotify-link`. Stored on the job. */
  id: string
  /** For logs and DECISIONS, for example "Spotify link". */
  label: string
  /** The services this importer can read. */
  services: readonly ServiceId[]
  /** The connect slots it fills: "login", "link" (paste links) and/or "file". */
  methods: readonly ConnectMethod[]
  /**
   * False hides the importer everywhere (picker, connect step, routes). For
   * example: MusicAPI only when its keys are set. Stubs return false until
   * their adapter is built.
   */
  isAvailable(env?: NodeJS.ProcessEnv): boolean
  /** Short help under each slot, plain words. Defaults are used when missing. */
  hints?: Partial<Record<ConnectMethod, string>>
  /** For the file slot: the `accept` attribute, for example ".csv,.zip,.xml". */
  fileAccept?: string
  /** Every playlist the input points at, or PENDING while the PC lists them. */
  listPlaylists(input: ListInput, ctx: ImportContext): Promise<ListResult | Pending>
  /** One page of a playlist's songs, in playlist order, or PENDING while the PC reads them. */
  getTracks(playlist: ImportPlaylist, ctx: TracksContext): Promise<TrackPage | Pending>
  /** Required when `methods` has "login". */
  login?: LoginFlow
}
