/**
 * Apple Music link importer (V2-PLAN T13, Adapters item 3, "Apple Music link").
 *
 * The owner pastes shared playlist links (music.apple.com/.../playlist/...),
 * several at once, one per line. Each playlist's public page is read on the
 * server (./apple-source.ts fetches it, ./apple-page.ts reads it; that file
 * is the only one that knows Apple's page layout). No login and no keys.
 *
 * Limits, from what Apple's public page gives (checked 2026-10-16):
 *   - Profiles cannot be listed, so the hint asks for playlist links.
 *   - Library links (`/library/playlist/p.xxx`) only open for their owner:
 *     the owner is told to use Share Playlist, which gives a public link.
 *   - The page lists at most 300 songs, so only those come over. All of them
 *     arrive in one getTracks page (no cursor needed).
 *   - No ISRCs: songs are matched by artist, title and length.
 */

import { HttpError } from '../http'
import { ApplePageError, APPLE_PAGE_SONG_LIMIT, parseAppleLink, parseApplePlaylistPage, type ApplePlaylistPage } from './apple-page'
import { fetchApplePlaylistPage } from './apple-source'
import { ImportUserError, type ImportPlaylist, type Importer } from './types'

/** Pages read at once while listing (up to 50 links per paste). */
const LIST_CONCURRENCY = 4

export const APPLE_CHANGED = "Apple Music changed something, so Tapedeck can't read this playlist right now. Try again later."
export const APPLE_UNREACHABLE = "Couldn't reach Apple Music. Try again in a minute."
const HOW_TO_SHARE =
  'In Apple Music, open the playlist, tap the three dots, then Share Playlist, then Copy, and paste that link here.'

/** Kept in the job payload: each playlist's storefront (country), to read its songs later. */
const PAYLOAD_KEY = 'appleStorefronts'
const STOREFRONT = /^[a-z]{2}$/

/** "That link" for one pasted link, "The link on line 3" for several. */
function which(index: number, total: number): string {
  return total > 1 ? `The link on line ${index + 1}` : 'That link'
}

/** The playlist a pasted line points at, or a plain message saying what to paste instead. */
function playlistOf(link: string, index: number, total: number): { storefront: string; id: string } {
  const parsed = parseAppleLink(link)
  const it = which(index, total)
  switch (parsed.kind) {
    case 'playlist':
      return { storefront: parsed.storefront, id: parsed.id }
    case 'library':
      throw new ImportUserError(`${it} is to a playlist in your own library, which only you can open. ${HOW_TO_SHARE}`)
    case 'profile':
      throw new ImportUserError(
        `${it} is to a profile. Apple doesn't let apps list a profile's playlists, so paste a link to each playlist instead.`,
      )
    case 'other':
      throw new ImportUserError(`${it} is not to a playlist. Paste playlist links, one per line.`)
    default:
      throw new ImportUserError(`${it} is not an Apple Music link.`)
  }
}

/** One playlist page, read, or a plain message for the owner. */
async function readPlaylist(storefront: string, id: string, missing: string): Promise<ApplePlaylistPage> {
  let response
  try {
    response = await fetchApplePlaylistPage(storefront, id)
  } catch (cause) {
    if (cause instanceof HttpError) {
      console.warn(`[import] apple-link: could not fetch ${storefront}/${id}: ${cause.message}`)
      throw new ImportUserError(APPLE_UNREACHABLE)
    }
    throw cause
  }
  if (response.status === 404) throw new ImportUserError(missing)
  try {
    return parseApplePlaylistPage(response.html)
  } catch (cause) {
    if (cause instanceof ApplePageError) {
      // Logged for whoever fixes ./apple-page.ts; the owner gets the plain message.
      console.error(`[import] apple-link: could not read the page of ${storefront}/${id}: ${cause.message}`)
      throw new ImportUserError(APPLE_CHANGED)
    }
    throw cause
  }
}

/** Runs `work` over `items`, at most `limit` at once, keeping the order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function storefrontsOf(payload: Record<string, unknown>): Record<string, unknown> {
  const value = payload[PAYLOAD_KEY]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export const appleLinkImporter: Importer = {
  id: 'apple-link',
  label: 'Apple Music link',
  services: ['apple'],
  methods: ['link'],
  // Public pages only: nothing to configure. Under TAPEDECK_TEST=1 it reads the recordings.
  isAvailable: () => true,
  hints: {
    link: `Paste playlist links, one per line. In Apple Music, open a playlist, tap the three dots, then Share Playlist, then Copy. Up to ${APPLE_PAGE_SONG_LIMIT} songs per playlist come over.`,
  },

  async listPlaylists(input) {
    if (input.method !== 'link') throw new ImportUserError('Paste Apple Music playlist links.')
    const links = input.links.map((link) => link.trim()).filter(Boolean)
    if (links.length === 0) throw new ImportUserError('Paste at least one link.')

    // Check every line before reading any page: a wrong line is the owner's to fix.
    const wanted = links.map((link, index) => ({ ...playlistOf(link, index, links.length), index }))
    const unique = wanted.filter((entry, at) => wanted.findIndex((other) => other.id === entry.id) === at)

    const pages = await mapLimited(unique, LIST_CONCURRENCY, (entry) =>
      readPlaylist(
        entry.storefront,
        entry.id,
        links.length > 1
          ? `Apple Music couldn't find the playlist on line ${entry.index + 1}. Check the link, and that the playlist is shared.`
          : "Apple Music couldn't find that playlist. Check the link, and that the playlist is shared.",
      ),
    )

    const storefronts: Record<string, string> = {}
    const playlists: ImportPlaylist[] = pages.map((page, at) => {
      storefronts[page.id] = unique[at].storefront
      if (page.hasMore) {
        console.info(`[import] apple-link: ${page.id} has more than ${APPLE_PAGE_SONG_LIMIT} songs; only the first ${APPLE_PAGE_SONG_LIMIT} come over`)
      }
      return { ref: page.id, name: page.name, coverUrl: page.coverUrl, trackCount: page.trackCount, kind: 'playlist' }
    })
    return { playlists, payload: { [PAYLOAD_KEY]: storefronts } }
  },

  async getTracks(playlist, ctx) {
    const parsed = parseAppleLink(`https://music.apple.com/us/playlist/${playlist.ref}`)
    if (parsed.kind !== 'playlist' || parsed.id !== playlist.ref) {
      throw new ImportUserError(`"${playlist.name}" is not an Apple Music playlist.`)
    }
    const kept = storefrontsOf(ctx.job.payload)[playlist.ref]
    const storefront = typeof kept === 'string' && STOREFRONT.test(kept) ? kept : 'us'
    const page = await readPlaylist(
      storefront,
      playlist.ref,
      `Apple Music couldn't find "${playlist.name}" any more. Check that it is still shared.`,
    )
    // All the songs the page has (up to 300) in one page: the core stores them in batches.
    return { tracks: page.tracks, next: null }
  },
}
