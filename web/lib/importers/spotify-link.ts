/**
 * Spotify link importer (V2-PLAN T13, Adapters item 2, "Spotify link").
 *
 * The owner pastes Spotify links, one per line:
 *   - a playlist link lists that playlist (name, cover, song count);
 *   - a profile link lists the profile's public playlists.
 * Ticking a playlist reads its songs: title, artists and length. Spotify's
 * public pages have no album and no ISRC, so the core matches each song by
 * artist + title + length.
 *
 * Limits of the public pages (unofficial, see ./spotify-pages.ts, which
 * holds every guess about Spotify's pages):
 *   - only public playlists (private ones and Liked songs need the login);
 *   - a playlist brings its first 100 songs (the embed page shows no more,
 *     and there is no next page to ask for);
 *   - a profile link shows the profile's first 10 public playlists.
 * The connect hint says all three in plain words.
 *
 * Under TAPEDECK_TEST=1 the recorded pages in
 * e2e/fixtures/import-spotify-link/ are read instead of the network
 * (./spotify-fixtures.ts).
 */

import { fetchRecordedSpotifyPage, spotifyUsesFixtures } from './spotify-fixtures'
import {
  embedPath,
  fetchSpotifyPage,
  parseEmbedPage,
  parseProfilePage,
  parseSpotifyLink,
  profilePath,
  SpotifyChangedError,
  SpotifyNotFoundError,
  SpotifyUnavailableError,
  type EmbedSong,
  type PageFetcher,
  type SpotifyLink,
} from './spotify-pages'
import { ImportUserError, type ImportPlaylist, type ImportTrack, type Importer } from './types'

export const SPOTIFY_CHANGED_MESSAGE = 'Spotify changed something, try the login option.'
export const SPOTIFY_DOWN_MESSAGE = "Spotify didn't answer. Try again in a minute."
export const SPOTIFY_LINK_HINT =
  'Public playlists only. Paste playlist links, or a profile link (it shows up to 10 playlists). Each playlist brings its first 100 songs.'

/** Pages read at once while listing many links. */
const LIST_CONCURRENCY = 4

function pageFetcher(env: NodeJS.ProcessEnv = process.env): PageFetcher {
  return spotifyUsesFixtures(env) ? fetchRecordedSpotifyPage : fetchSpotifyPage
}

/** A pasted link, shortened for a message. */
function shown(link: string): string {
  const text = link.trim()
  return text.length > 70 ? `${text.slice(0, 67)}...` : text
}

/** A plain message for a link Spotify cannot be asked about. */
function linkProblem(link: string, parsed: Exclude<SpotifyLink, { kind: 'playlist' | 'profile' }>): string {
  if (parsed.kind === 'invalid') return `This is not a Spotify playlist or profile link: ${shown(link)}`
  if (parsed.what === 'Liked songs') {
    return 'Spotify keeps Liked songs private, so a link cannot read them. Use the login option, or add them to a public playlist and paste that link.'
  }
  if (parsed.what === 'short link') {
    return `Open this short link in your browser first, then copy the address that starts with open.spotify.com: ${shown(link)}`
  }
  return `This is a Spotify ${parsed.what} link. Paste a playlist or profile link instead: ${shown(link)}`
}

/** Turns a page failure into the message the owner sees. */
function userError(cause: unknown, notFound: string): never {
  if (cause instanceof SpotifyNotFoundError) throw new ImportUserError(notFound)
  if (cause instanceof SpotifyUnavailableError) {
    console.warn('[spotify-link]', cause.message)
    throw new ImportUserError(SPOTIFY_DOWN_MESSAGE)
  }
  if (cause instanceof SpotifyChangedError) {
    // Logged: the owner only sees the short message, the log says what moved.
    console.error('[spotify-link]', cause.message)
    throw new ImportUserError(SPOTIFY_CHANGED_MESSAGE)
  }
  throw cause
}

async function listOne(link: string, parsed: SpotifyLink, fetchPage: PageFetcher): Promise<ImportPlaylist[]> {
  if (parsed.kind === 'playlist') {
    try {
      const playlist = parseEmbedPage(await fetchPage(embedPath(parsed.id)), parsed.id)
      return [{ ref: parsed.id, name: playlist.name, coverUrl: playlist.coverUrl, trackCount: playlist.songs.length, kind: 'playlist' }]
    } catch (cause) {
      userError(cause, `Couldn't open this playlist. Check the link, and that the playlist is public: ${shown(link)}`)
    }
  }
  if (parsed.kind === 'profile') {
    try {
      const found = parseProfilePage(await fetchPage(profilePath(parsed.user)), parsed.user)
      return found.playlists.map((playlist) => ({
        ref: playlist.id,
        name: playlist.name,
        coverUrl: playlist.coverUrl,
        trackCount: null,
        kind: 'playlist' as const,
      }))
    } catch (cause) {
      userError(cause, `Couldn't find this Spotify profile: ${shown(link)}`)
    }
  }
  return []
}

/** Runs `work` over `items`, at most `limit` at once, keeping the order. */
async function inOrder<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

export const spotifyLinkImporter: Importer = {
  id: 'spotify-link',
  label: 'Spotify link',
  services: ['spotify'],
  methods: ['link'],
  // Needs no keys; under TAPEDECK_TEST=1 it reads the recorded pages.
  isAvailable: () => true,
  hints: { link: SPOTIFY_LINK_HINT },

  async listPlaylists(input) {
    if (input.method !== 'link') throw new ImportUserError('Paste a Spotify link.')
    const links = input.links.map((link) => link.trim()).filter((link) => link !== '')
    if (links.length === 0) throw new ImportUserError('Paste a Spotify playlist or profile link.')

    // Every line is checked before Spotify is asked anything.
    const parsed = links.map((link) => ({ link, parsed: parseSpotifyLink(link) }))
    for (const { link, parsed: what } of parsed) {
      if (what.kind !== 'playlist' && what.kind !== 'profile') throw new ImportUserError(linkProblem(link, what))
    }

    const fetchPage = pageFetcher()
    const lists = await inOrder(parsed, LIST_CONCURRENCY, ({ link, parsed: what }) => listOne(link, what, fetchPage))
    // The same playlist from two links (a profile and its playlist) is listed once.
    const seen = new Set<string>()
    const playlists: ImportPlaylist[] = []
    for (const playlist of lists.flat()) {
      if (seen.has(playlist.ref)) continue
      seen.add(playlist.ref)
      playlists.push(playlist)
    }
    return { playlists }
  },

  async getTracks(playlist) {
    const id = playlist.ref
    if (parseSpotifyLink(`spotify:playlist:${id}`).kind !== 'playlist') {
      throw new ImportUserError(`The playlist "${playlist.name}" is not a Spotify playlist.`)
    }
    let songs: EmbedSong[] = []
    try {
      songs = parseEmbedPage(await pageFetcher()(embedPath(id)), id).songs
    } catch (cause) {
      userError(cause, `Couldn't open "${playlist.name}" on Spotify. Check that it is still public.`)
    }
    const tracks: ImportTrack[] = songs.map((song) => ({
      ref: song.ref,
      title: song.title,
      artist: song.artist,
      durationSec: song.durationSec,
    }))
    // One page: the embed page has the first 100 songs and nothing to page through.
    return { tracks, next: null }
  },
}
