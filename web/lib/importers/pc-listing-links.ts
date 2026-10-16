/**
 * Which pasted links the PC listing can read (V2-PLAN T13, adapter 4), and
 * what the PC should do with each one. Pure string logic, no network: the
 * owner gets a plain message right away for a link that cannot work, and
 * the PC gets a clean "target" per link through /api/agent/import/claim.
 *
 * SoundCloud: a profile (its sets and its likes), a profile's sets or likes
 * page, one set, or an on.soundcloud.com share link (the PC follows it).
 * YouTube and YouTube Music: a channel (its playlists tab, which also holds
 * the public "Favorites" list) or one playlist.
 */

import type { ServiceId } from '../import-types'

export type PcTargetKind =
  | 'soundcloud-profile'
  | 'soundcloud-sets'
  | 'soundcloud-likes'
  | 'soundcloud-set'
  | 'soundcloud-short'
  | 'youtube-channel'
  | 'youtube-playlist'

/** One pasted link, cleaned up for the PC. */
export interface PcTarget {
  /** What the owner pasted (trimmed), for messages. */
  link: string
  kind: PcTargetKind
  /** The address the PC hands to yt-dlp. */
  url: string
}

export type LinkCheck = { target: PcTarget } | { error: string }

export const ONE_SONG_MESSAGE = 'is one song, not a playlist. Add single songs with "Paste links" in the Add window.'
export const PRIVATE_LIST_MESSAGE =
  'Your own Liked videos and Watch later lists are private, so a link cannot open them. Paste a public playlist instead.'

const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'])
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])
const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])

/** SoundCloud pages that are not a profile. */
const SOUNDCLOUD_RESERVED = new Set([
  'charts',
  'discover',
  'feed',
  'messages',
  'notifications',
  'pages',
  'people',
  'search',
  'settings',
  'stream',
  'tags',
  'terms-of-use',
  'upload',
  'you',
])
/** Profile tabs that mean "this profile": all of them list its sets and likes. */
const SOUNDCLOUD_PROFILE_TABS = new Set(['tracks', 'popular-tracks', 'reposts', 'spotlight', 'followers', 'following', 'comments'])

/** Lists only the signed-in owner can see; a link never opens them. */
const PRIVATE_LISTS = new Set(['LL', 'WL', 'LM'])
const LIST_ID = /^[A-Za-z0-9_-]{2,64}$/
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/
const HANDLE = /^@[\p{L}\p{N}_.-]{1,100}$/u
const NAME = /^[\w.-]{1,100}$/

function parseUrl(raw: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

function segmentsOf(url: URL): string[] | null {
  const out: string[] = []
  for (const part of url.pathname.split('/').filter(Boolean)) {
    try {
      out.push(decodeURIComponent(part))
    } catch {
      return null
    }
  }
  return out
}

function soundcloudTarget(link: string, url: URL): LinkCheck {
  const host = url.hostname.toLowerCase()
  if (host === 'on.soundcloud.com') {
    const [code] = segmentsOf(url) ?? []
    if (!code || !NAME.test(code)) return { error: `That isn't a SoundCloud link: ${link}` }
    return { target: { link, kind: 'soundcloud-short', url: `https://on.soundcloud.com/${code}` } }
  }
  const parts = segmentsOf(url)
  const [user, second, third, ...rest] = parts ?? []
  if (!user || !NAME.test(user) || SOUNDCLOUD_RESERVED.has(user.toLowerCase())) {
    return { error: `That SoundCloud page has no playlists: ${link}. Paste a profile or playlist link.` }
  }
  const profile = `https://soundcloud.com/${user}`
  if (!second || SOUNDCLOUD_PROFILE_TABS.has(second)) return { target: { link, kind: 'soundcloud-profile', url: profile } }
  if (second === 'likes' && !third) return { target: { link, kind: 'soundcloud-likes', url: `${profile}/likes` } }
  if ((second === 'sets' || second === 'albums') && !third) {
    return { target: { link, kind: 'soundcloud-sets', url: `${profile}/${second}` } }
  }
  if (second === 'sets' && third && NAME.test(third) && rest.length === 0) {
    // A private set's share link carries its secret as a fourth part; that is not supported.
    return { target: { link, kind: 'soundcloud-set', url: `${profile}/sets/${third}` } }
  }
  if (!third && NAME.test(second)) return { error: `${link} ${ONE_SONG_MESSAGE}` }
  return { error: `That SoundCloud link can't be read: ${link}. Paste a profile or playlist link.` }
}

function youtubeTarget(link: string, url: URL): LinkCheck {
  const host = url.hostname.toLowerCase()
  if (YOUTUBE_SHORT_HOSTS.has(host)) return { error: `${link} ${ONE_SONG_MESSAGE}` }
  const parts = segmentsOf(url) ?? []
  // A playlist, also when opened from one of its videos (watch?v=...&list=...).
  let list = url.searchParams.get('list')
  // YouTube Music opens playlists as /browse/VL<list id>.
  if (!list && parts[0] === 'browse' && parts[1]?.startsWith('VL')) list = parts[1].slice(2)
  if (list) {
    if (PRIVATE_LISTS.has(list)) return { error: PRIVATE_LIST_MESSAGE }
    if (!LIST_ID.test(list)) return { error: `That YouTube playlist link can't be read: ${link}` }
    return { target: { link, kind: 'youtube-playlist', url: `https://www.youtube.com/playlist?list=${list}` } }
  }
  if (parts[0] === 'watch' || parts[0] === 'shorts' || parts[0] === 'live') return { error: `${link} ${ONE_SONG_MESSAGE}` }
  const [first, second] = parts
  if (first && HANDLE.test(first)) return { target: { link, kind: 'youtube-channel', url: `https://www.youtube.com/${first}` } }
  if (first === 'channel' && second && CHANNEL_ID.test(second)) {
    return { target: { link, kind: 'youtube-channel', url: `https://www.youtube.com/channel/${second}` } }
  }
  if ((first === 'c' || first === 'user') && second && NAME.test(second)) {
    return { target: { link, kind: 'youtube-channel', url: `https://www.youtube.com/${first}/${second}` } }
  }
  if (first === 'playlist') return { error: `That YouTube playlist link can't be read: ${link}` }
  return { error: `That YouTube page has no playlists: ${link}. Paste a channel or playlist link.` }
}

/** Checks one pasted link for one service. */
export function checkLink(raw: string, service: ServiceId): LinkCheck {
  const link = raw.trim()
  const url = parseUrl(link)
  const host = url?.hostname.toLowerCase() ?? ''
  if (service === 'soundcloud') {
    if (!url || !(SOUNDCLOUD_HOSTS.has(host) || host === 'on.soundcloud.com')) {
      return { error: `That isn't a SoundCloud link: ${link}` }
    }
    return soundcloudTarget(link, url)
  }
  if (service === 'youtube' || service === 'ytmusic') {
    if (!url || !(YOUTUBE_HOSTS.has(host) || YOUTUBE_SHORT_HOSTS.has(host))) {
      return { error: `That isn't a ${service === 'ytmusic' ? 'YouTube Music' : 'YouTube'} link: ${link}` }
    }
    return youtubeTarget(link, url)
  }
  return { error: 'This service is not read by the PC.' }
}

/**
 * The targets for every pasted link, the same address only once, or the
 * message for the first link that cannot work.
 */
export function checkLinks(links: readonly string[], service: ServiceId): { targets: PcTarget[] } | { error: string } {
  const targets: PcTarget[] = []
  const seen = new Set<string>()
  for (const raw of links) {
    if (!raw.trim()) continue
    const checked = checkLink(raw, service)
    if ('error' in checked) return checked
    if (seen.has(checked.target.url)) continue
    seen.add(checked.target.url)
    targets.push(checked.target)
  }
  if (targets.length === 0) return { error: 'Paste at least one link.' }
  return { targets }
}
