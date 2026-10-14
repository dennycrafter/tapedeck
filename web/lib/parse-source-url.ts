/**
 * Song-link parsing (SPEC 8.2 step 1, 7.4): the one place that decides
 * whether a pasted line is a YouTube or SoundCloud song, and what its
 * canonical identity is.
 *
 * Pure string logic: no network. `on.soundcloud.com` short links cannot be
 * resolved purely: the parser reports them as `soundcloud-shortlink` and the
 * caller resolves the redirect server-side (7.4) before parsing again.
 *
 * Accepted YouTube forms (8.2): `youtube.com/watch?v=ID`, `youtu.be/ID`,
 * `music.youtube.com/watch?v=ID`, `youtube.com/shorts/ID`. `list=` and `t=`
 * params are ignored, and every form canonicalizes to the same `source_url`.
 * Accepted SoundCloud form (7.4): `soundcloud.com/<user>/<track>`, query
 * strings stripped; `/sets/` links are rejected with the SPEC's exact message.
 */

export type TrackSource = 'youtube' | 'soundcloud'

export interface ParsedSongLink {
  source: TrackSource
  /** YouTube video id, or the SoundCloud `user/track` path (7.4). */
  sourceId: string
  /** Canonical URL handed to yt-dlp and stored in `tracks.source_url`. */
  sourceUrl: string
}

export type SongLinkParse =
  | { kind: 'link'; link: ParsedSongLink }
  /** Not a song link: SPEC 8.2's per-line message below. */
  | { kind: 'error'; message: string }
  /** An on.soundcloud.com short link; resolve it, then parse the target. */
  | { kind: 'soundcloud-shortlink'; shortUrl: string }

/** SPEC 8.2: the per-line error for anything that is not a song link. */
export const NOT_A_SONG_LINK_MESSAGE = 'Not a YouTube or SoundCloud song link'

/** SPEC 7.4: the per-line error for SoundCloud sets. */
export const SOUNDCLOUD_SETS_MESSAGE =
  'Playlists from SoundCloud are not supported yet. Paste single songs.'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'music.youtube.com'])
const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])
const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com'])

/** YouTube video ids are always 11 characters of this alphabet. */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

function notASongLink(): { kind: 'error'; message: string } {
  return { kind: 'error', message: NOT_A_SONG_LINK_MESSAGE }
}

/** Pasted lines often lack the scheme ("youtu.be/x"); https is the only reality. */
function withScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
}

function youtubeLink(videoId: string): { kind: 'link'; link: ParsedSongLink } {
  return {
    kind: 'link',
    link: {
      source: 'youtube',
      sourceId: videoId,
      // SPEC 8.2: one canonical form for every accepted YouTube shape.
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    },
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null // malformed %-sequence, not a real track path
  }
}

export function parseSongLink(raw: string): SongLinkParse {
  const trimmed = raw.trim()
  if (!trimmed) return notASongLink()

  let url: URL
  try {
    url = new URL(withScheme(trimmed))
  } catch {
    return notASongLink()
  }
  // Schemeless input is upgraded to https; any other explicit scheme (ftp:,
  // javascript:, …) is not a song link.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return notASongLink()
  const host = url.hostname.toLowerCase()

  if (host === 'on.soundcloud.com') {
    return { kind: 'soundcloud-shortlink', shortUrl: url.toString() }
  }

  if (YOUTUBE_SHORT_HOSTS.has(host)) {
    // Exactly one path segment: the video id.
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length === 1) {
      const id = safeDecode(segments[0])
      if (id && VIDEO_ID_PATTERN.test(id)) return youtubeLink(id)
    }
    return notASongLink()
  }

  if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      // list= / t= and any other params are simply never read (8.2).
      const v = url.searchParams.get('v') ?? ''
      if (VIDEO_ID_PATTERN.test(v)) return youtubeLink(v)
      return notASongLink()
    }
    const shorts = url.pathname.match(/^\/shorts\/([^/]+)\/?$/)
    if (shorts) {
      const id = safeDecode(shorts[1])
      if (id && VIDEO_ID_PATTERN.test(id)) return youtubeLink(id)
    }
    // /playlist, /channel, /embed and everything else is not a song link.
    return notASongLink()
  }

  if (SOUNDCLOUD_HOSTS.has(host)) {
    const segments = url.pathname.split('/').filter(Boolean).map(safeDecode)
    if (segments.some((segment) => segment === null)) return notASongLink()
    const [user, track, ...rest] = segments as string[]
    // /sets/… in any position (with or without a user segment) is a
    // playlist, not a song (7.4).
    if (user === 'sets' || track === 'sets' || rest[0] === 'sets') {
      return { kind: 'error', message: SOUNDCLOUD_SETS_MESSAGE }
    }
    if (user && track && rest.length === 0) {
      // Query strings are stripped (7.4); the canonical form is rebuilt.
      return {
        kind: 'link',
        link: {
          source: 'soundcloud',
          sourceId: `${user}/${track}`,
          sourceUrl: `https://soundcloud.com/${user}/${track}`,
        },
      }
    }
    return notASongLink()
  }

  return notASongLink()
}
