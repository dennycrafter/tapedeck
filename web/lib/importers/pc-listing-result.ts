/**
 * What the PC sends back for a listing job (V2-PLAN T13, adapter 4), kept
 * in the job payload under `pcListing` until the songs are read.
 *
 * One round: the PC lists every playlist the pasted links point at AND
 * all their songs, so the checklist shows real song counts and reading the
 * songs never waits for the PC again. The size is capped (MAX_SONGS songs
 * in all), which keeps the request and the stored payload around a
 * megabyte at most.
 *
 * Every song carries its own YouTube or SoundCloud link, so it keeps that
 * link (source youtube or soundcloud, the normal download pipeline). A song
 * without a usable link is dropped here: this import is all about links.
 */

import { parseSongLink } from '../parse-source-url'
import type { ImportPlaylist, ImportTrack } from './types'

/** The payload key the result lives under. */
export const PC_RESULT_KEY = 'pcListing'

/** Songs in one listing, all playlists together (the PC stops there too). */
export const MAX_SONGS = 5_000
/** Playlists in one listing. */
export const MAX_PLAYLISTS = 200
/** Problems kept (plain messages about links that could not be read). */
export const MAX_PROBLEMS = 20
/** The complete request is refused above this (Vercel takes 4.5 MB at most). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface PcTrack {
  ref: string
  title: string
  artist: string
  durationSec: number | null
  link: string
  coverUrl: string | null
}

export interface PcPlaylist {
  ref: string
  name: string
  kind: 'playlist' | 'liked'
  coverUrl: string | null
  trackCount: number
  tracks: PcTrack[]
  /** Set once all its songs were handed to the import (they are dropped then, to keep the payload small). */
  read?: boolean
}

export interface PcResult {
  playlists: PcPlaylist[]
  /** Plain messages for links that could not be read. */
  problems: string[]
  /** The PC stopped early (too many songs, or out of time). */
  truncated: boolean
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1_000) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 60 * 60 ? Math.round(value) : null
}

/** One song from the PC, or null when it has no title or no usable song link. */
export function cleanPcTrack(raw: unknown): PcTrack | null {
  if (!raw || typeof raw !== 'object') return null
  const track = raw as Record<string, unknown>
  const title = text(track.title, 300)
  const parsed = typeof track.link === 'string' ? parseSongLink(track.link) : null
  if (!title || parsed?.kind !== 'link') return null
  return {
    ref: text(track.ref, 100) ?? parsed.link.sourceId,
    title,
    artist: text(track.artist, 300) ?? '',
    durationSec: seconds(track.durationSec),
    link: parsed.link.sourceUrl,
    coverUrl: httpUrl(track.coverUrl),
  }
}

/**
 * The PC's answer, cleaned and capped, or a message when it is not one.
 * Playlists with no usable songs are left out; refs are unique.
 */
export function parsePcResult(body: unknown): { result: PcResult } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Expected a JSON object' }
  const input = body as Record<string, unknown>
  if (!Array.isArray(input.playlists)) return { error: 'playlists must be an array' }
  const problems = Array.isArray(input.problems)
    ? input.problems
        .map((problem) => text(problem, 300))
        .filter((problem): problem is string => problem !== null)
        .slice(0, MAX_PROBLEMS)
    : []
  let truncated = input.truncated === true
  let room = MAX_SONGS
  const seen = new Set<string>()
  const playlists: PcPlaylist[] = []
  for (const raw of input.playlists) {
    if (!raw || typeof raw !== 'object') continue
    const playlist = raw as Record<string, unknown>
    const ref = text(playlist.ref, 200)
    if (!ref || seen.has(ref)) continue
    if (playlists.length >= MAX_PLAYLISTS || room === 0) {
      truncated = true
      break
    }
    const rawTracks = Array.isArray(playlist.tracks) ? playlist.tracks : []
    const tracks: PcTrack[] = []
    for (const rawTrack of rawTracks) {
      const track = cleanPcTrack(rawTrack)
      if (!track) continue
      if (tracks.length >= room) {
        truncated = true
        break
      }
      tracks.push(track)
    }
    if (tracks.length === 0) continue
    seen.add(ref)
    room -= tracks.length
    const kind = playlist.kind === 'liked' ? 'liked' : 'playlist'
    playlists.push({
      ref,
      name: text(playlist.name, 200) ?? (kind === 'liked' ? 'Likes' : 'Untitled playlist'),
      kind,
      coverUrl: httpUrl(playlist.coverUrl) ?? tracks[0].coverUrl,
      trackCount: tracks.length,
      tracks,
    })
  }
  return { result: { playlists, problems, truncated } }
}

/** The PC's answer stored in a job payload, or null while the PC has not answered. */
export function readPcResult(payload: Record<string, unknown>): PcResult | null {
  const stored = payload[PC_RESULT_KEY]
  if (!stored || typeof stored !== 'object') return null
  const result = stored as Partial<PcResult>
  if (!Array.isArray(result.playlists)) return null
  return {
    playlists: result.playlists,
    problems: Array.isArray(result.problems) ? result.problems : [],
    truncated: result.truncated === true,
  }
}

/** The checklist entries (the songs stay in the payload). */
export function checklistOf(result: PcResult): ImportPlaylist[] {
  return result.playlists.map((playlist) => ({
    ref: playlist.ref,
    name: playlist.name,
    kind: playlist.kind,
    coverUrl: playlist.coverUrl,
    trackCount: playlist.trackCount,
  }))
}

export function importTrack(track: PcTrack): ImportTrack {
  return {
    ref: track.ref,
    title: track.title,
    artist: track.artist,
    durationSec: track.durationSec,
    link: track.link,
    coverUrl: track.coverUrl,
  }
}

/** The same result with one playlist's songs dropped, once they are all read. */
export function withPlaylistRead(result: PcResult, ref: string): PcResult {
  return {
    ...result,
    playlists: result.playlists.map((playlist) => (playlist.ref === ref ? { ...playlist, tracks: [], read: true } : playlist)),
  }
}
