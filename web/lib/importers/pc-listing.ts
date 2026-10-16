/**
 * SoundCloud and YouTube links, read on the PC (V2-PLAN T13, Adapters item 4).
 *
 * Listing needs yt-dlp, which only the owner's PC runs. So:
 *   1. The owner pastes profile, channel or playlist links. `listPlaylists`
 *      checks them (./pc-listing-links.ts: a plain message right away for a
 *      link that cannot work) and answers PENDING: the job waits for the PC
 *      and the page shows "Waiting for your PC".
 *   2. The downloader claims the job (`POST /api/agent/import/claim`,
 *      capability "import-listing"), runs `yt-dlp --flat-playlist -J` on
 *      each link (agent/import_listing.py) and sends every playlist with all
 *      its songs to `POST /api/agent/import/complete`, which stores them in
 *      the job payload (./pc-listing-result.ts) and hands the job back.
 *   3. The browser lists again: `listPlaylists` now reads the PC's answer.
 *      `getTracks` pages through the stored songs; it never waits again.
 *
 * Each song carries its own link, so it keeps it (source youtube or
 * soundcloud, the normal download pipeline). YouTube Music links are
 * YouTube playlists and channels, read the same way.
 */

import { checkLinks } from './pc-listing-links'
import { checklistOf, importTrack, readPcResult, withPlaylistRead, PC_RESULT_KEY } from './pc-listing-result'
import { ImportUserError, PENDING, type Importer } from './types'

/** Songs per getTracks page (the core inserts them in batches of 200). */
export const PC_PAGE_SIZE = 500

export const NOTHING_FOUND = 'Your PC found no songs there. Check that the playlists are public.'

export const pcListingImporter: Importer = {
  id: 'pc-listing',
  label: 'SoundCloud and YouTube links (on the PC)',
  services: ['soundcloud', 'youtube', 'ytmusic'],
  methods: ['link'],
  // Nothing to configure: the PC is always there, it only has to be on.
  isAvailable: () => true,
  hints: {
    link: 'Paste profile, channel or playlist links, one per line. Your PC reads them, so keep it on with the downloader running.',
  },

  async listPlaylists(input, ctx) {
    if (input.method !== 'link') throw new ImportUserError('Paste a link for this one.')
    const checked = checkLinks(input.links, ctx.job.service)
    if ('error' in checked) throw new ImportUserError(checked.error)
    const result = readPcResult(ctx.job.payload)
    if (!result) return PENDING
    if (result.playlists.length === 0) throw new ImportUserError(result.problems[0] ?? NOTHING_FOUND)
    return { playlists: checklistOf(result) }
  },

  async getTracks(playlist, ctx) {
    const result = readPcResult(ctx.job.payload)
    const found = result?.playlists.find((candidate) => candidate.ref === playlist.ref)
    if (!result || !found) throw new ImportUserError(`The playlist "${playlist.name}" is gone. Import it again.`)
    const start = ctx.cursor ? Number(ctx.cursor) : 0
    const end = start + PC_PAGE_SIZE
    const tracks = found.tracks.slice(start, end).map(importTrack)
    if (end < found.tracks.length) return { tracks, next: String(end) }
    // The last page: drop this playlist's songs from the payload, every later request reads less.
    return { tracks, next: null, payload: { [PC_RESULT_KEY]: withPlaylistRead(result, playlist.ref) } }
  },
}
