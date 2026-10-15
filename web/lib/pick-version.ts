/**
 * "Pick another version" (V2-PLAN T12, item 5), the pure part: which copies
 * of a catalog song the PC found, and which links a user may pick. No
 * database here, so the client dialog can import it too; the UPDATE lives in
 * lib/pick-version-db.ts.
 *
 * matchInfo comes from the PC as jsonb and is only size-checked on the way
 * in (app/api/agent/v2-fields.ts), so everything here reads it defensively:
 * entries without an http(s) url are skipped.
 */

import type { MatchInfo } from './track-v2'
import { parseSongLink } from './parse-source-url'

export type VersionSource = 'ytmusic' | 'soundcloud' | 'youtube'

/** One copy the dialog lists. */
export interface VersionOption {
  title: string
  uploader: string
  durationSec: number | null
  url: string
  score: number | null
  /** Where the copy lives; null when neither the PC nor the url says. */
  source: VersionSource | null
  /** This is the copy the PC downloaded (resolved_url). */
  current: boolean
}

export const SHORTLINK_MESSAGE = 'Paste the full SoundCloud link (open it first, then copy the address)'

const SOURCE_LABELS: Record<VersionSource, string> = {
  ytmusic: 'YouTube Music',
  soundcloud: 'SoundCloud',
  youtube: 'YouTube',
}

export function sourceLabel(source: VersionSource | null): string {
  return source ? SOURCE_LABELS[source] : ''
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/** The PC's own label, else a guess from the address. */
function sourceOf(value: unknown, url: string): VersionSource | null {
  if (value === 'ytmusic' || value === 'soundcloud' || value === 'youtube') return value
  const host = new URL(url).hostname.toLowerCase()
  if (host === 'music.youtube.com') return 'ytmusic'
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'soundcloud'
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube'
  return null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Every saved candidate with a usable url: chosen first, then the alternatives. */
function candidates(matchInfo: unknown): Omit<VersionOption, 'current'>[] {
  if (!matchInfo || typeof matchInfo !== 'object' || Array.isArray(matchInfo)) return []
  const info = matchInfo as Record<string, unknown>
  const raw: unknown[] = [info.chosen, ...(Array.isArray(info.alternatives) ? info.alternatives : [])]
  const out: Omit<VersionOption, 'current'>[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const item = entry as Record<string, unknown>
    const url = httpUrl(item.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const duration = finiteOrNull(item.durationSec)
    out.push({
      title: text(item.title) || url,
      uploader: text(item.uploader),
      durationSec: duration != null && duration > 0 ? duration : null,
      url,
      score: finiteOrNull(item.score),
      source: sourceOf(item.source, url),
    })
  }
  return out
}

/** The dialog's list: chosen first, then alternatives, no repeats, the downloaded one flagged. */
export function versionOptions(
  matchInfo: MatchInfo | null | undefined,
  resolvedUrl: string | null | undefined,
): VersionOption[] {
  return candidates(matchInfo).map((option) => ({
    ...option,
    current: resolvedUrl != null && option.url === resolvedUrl,
  }))
}

export type PickUrl = { url: string; error?: undefined } | { url?: undefined; error: string }

/**
 * Which address the PC should download. A saved candidate's url is used as
 * is (the PC found it, so it may be a music.youtube.com link); anything else
 * must be a YouTube or SoundCloud song link and is stored in its canonical form.
 */
export function resolvePickUrl(url: string, matchInfo: MatchInfo | null | undefined): PickUrl {
  const trimmed = url.trim()
  if (trimmed && candidates(matchInfo).some((option) => option.url === trimmed)) {
    return { url: trimmed }
  }
  const parsed = parseSongLink(trimmed)
  if (parsed.kind === 'link') return { url: parsed.link.sourceUrl }
  if (parsed.kind === 'soundcloud-shortlink') return { error: SHORTLINK_MESSAGE }
  return { error: parsed.message }
}
