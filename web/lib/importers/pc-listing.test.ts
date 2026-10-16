/**
 * The PC listing adapter (V2-PLAN T13, adapter 4): which links it takes,
 * how the PC's answer is cleaned, and how the importer waits for the PC and
 * then reads the stored songs. The PC's answer here is the real output of
 * agent/import_listing.py for the recorded SoundCloud profile
 * (e2e/fixtures/import-pc-listing/soundcloud-profile.json; a pytest checks
 * it matches).
 */
import { describe, expect, it } from 'vitest'
import profileResult from '../../e2e/fixtures/import-pc-listing/soundcloud-profile.json'
import { checkLink, checkLinks, ONE_SONG_MESSAGE, PRIVATE_LIST_MESSAGE } from './pc-listing-links'
import { MAX_SONGS, parsePcResult, PC_RESULT_KEY, readPcResult, type PcResult } from './pc-listing-result'
import { NOTHING_FOUND, PC_PAGE_SIZE, pcListingImporter } from './pc-listing'
import { isPending, ImportUserError, type ImportContext, type ImportPlaylist, type TrackPage } from './types'
import type { ServiceId } from '../import-types'

function target(link: string, service: ServiceId = 'soundcloud') {
  const checked = checkLink(link, service)
  if ('error' in checked) throw new Error(checked.error)
  return { kind: checked.target.kind, url: checked.target.url }
}

function error(link: string, service: ServiceId = 'soundcloud'): string {
  const checked = checkLink(link, service)
  if (!('error' in checked)) throw new Error(`expected an error for ${link}`)
  return checked.error
}

describe('links the PC can read', () => {
  it('takes SoundCloud profiles, their sets and likes, single sets and share links', () => {
    expect(target('https://soundcloud.com/the-concept-band')).toEqual({ kind: 'soundcloud-profile', url: 'https://soundcloud.com/the-concept-band' })
    expect(target('soundcloud.com/the-concept-band/tracks?si=abc')).toEqual({
      kind: 'soundcloud-profile',
      url: 'https://soundcloud.com/the-concept-band',
    })
    expect(target('https://m.soundcloud.com/the-concept-band/likes')).toEqual({
      kind: 'soundcloud-likes',
      url: 'https://soundcloud.com/the-concept-band/likes',
    })
    expect(target('https://soundcloud.com/the-concept-band/sets')).toEqual({
      kind: 'soundcloud-sets',
      url: 'https://soundcloud.com/the-concept-band/sets',
    })
    expect(target('https://soundcloud.com/the-concept-band/albums')).toMatchObject({ kind: 'soundcloud-sets' })
    expect(target('https://soundcloud.com/the-concept-band/sets/royal-ep?utm_source=clipboard')).toEqual({
      kind: 'soundcloud-set',
      url: 'https://soundcloud.com/the-concept-band/sets/royal-ep',
    })
    expect(target('https://on.soundcloud.com/AbC123xyz')).toEqual({ kind: 'soundcloud-short', url: 'https://on.soundcloud.com/AbC123xyz' })
  })

  it('takes YouTube and YouTube Music channels and playlists', () => {
    expect(target('https://www.youtube.com/@daftpunk', 'youtube')).toEqual({ kind: 'youtube-channel', url: 'https://www.youtube.com/@daftpunk' })
    expect(target('youtube.com/@daftpunk/videos?si=x', 'youtube')).toEqual({ kind: 'youtube-channel', url: 'https://www.youtube.com/@daftpunk' })
    expect(target('https://www.youtube.com/channel/UC_kRDKYrUlrbtrSiyu5Tflg', 'youtube')).toEqual({
      kind: 'youtube-channel',
      url: 'https://www.youtube.com/channel/UC_kRDKYrUlrbtrSiyu5Tflg',
    })
    expect(target('https://www.youtube.com/user/daftpunkalive', 'youtube')).toMatchObject({ kind: 'youtube-channel' })
    const playlist = { kind: 'youtube-playlist', url: 'https://www.youtube.com/playlist?list=PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV' }
    expect(target('https://youtube.com/playlist?list=PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV&si=abc', 'youtube')).toEqual(playlist)
    expect(target('https://www.youtube.com/watch?v=A2VpR8HahKc&list=PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV', 'youtube')).toEqual(playlist)
    expect(target('https://music.youtube.com/playlist?list=PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV', 'ytmusic')).toEqual(playlist)
    expect(target('https://music.youtube.com/browse/VLPLSdoVPM5WnndSQEXRz704yQkKwx76GvPV', 'ytmusic')).toEqual(playlist)
    expect(target('https://music.youtube.com/channel/UC_kRDKYrUlrbtrSiyu5Tflg', 'ytmusic')).toMatchObject({ kind: 'youtube-channel' })
  })

  it('says plainly why a link cannot work', () => {
    expect(error('https://soundcloud.com/the-concept-band/world-on-fire-1')).toBe(
      `https://soundcloud.com/the-concept-band/world-on-fire-1 ${ONE_SONG_MESSAGE}`,
    )
    expect(error('https://www.youtube.com/watch?v=A2VpR8HahKc', 'youtube')).toContain(ONE_SONG_MESSAGE)
    expect(error('https://youtu.be/A2VpR8HahKc', 'youtube')).toContain(ONE_SONG_MESSAGE)
    expect(error('https://www.youtube.com/playlist?list=LL', 'youtube')).toBe(PRIVATE_LIST_MESSAGE)
    expect(error('https://music.youtube.com/playlist?list=LM', 'ytmusic')).toBe(PRIVATE_LIST_MESSAGE)
    expect(error('https://www.youtube.com/@daftpunk', 'soundcloud')).toBe("That isn't a SoundCloud link: https://www.youtube.com/@daftpunk")
    expect(error('https://soundcloud.com/the-concept-band', 'youtube')).toBe(
      "That isn't a YouTube link: https://soundcloud.com/the-concept-band",
    )
    expect(error('https://soundcloud.com/discover')).toContain('has no playlists')
    expect(error('https://www.youtube.com/feed/library', 'youtube')).toContain('has no playlists')
    expect(error('not a link at all')).toContain("isn't a SoundCloud link")
  })

  it('checks every line, skips repeats and needs at least one link', () => {
    const many = checkLinks(['https://soundcloud.com/a', ' soundcloud.com/a/tracks ', 'https://soundcloud.com/b/likes'], 'soundcloud')
    expect('targets' in many && many.targets.map((t) => t.url)).toEqual(['https://soundcloud.com/a', 'https://soundcloud.com/b/likes'])
    expect(checkLinks(['https://soundcloud.com/a', 'https://example.com'], 'soundcloud')).toEqual({
      error: "That isn't a SoundCloud link: https://example.com",
    })
    expect(checkLinks(['  '], 'soundcloud')).toEqual({ error: 'Paste at least one link.' })
  })
})

describe("the PC's answer", () => {
  it('keeps the recorded profile as it is', () => {
    const parsed = parsePcResult(profileResult)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.result.playlists.map((p) => [p.ref, p.name, p.kind, p.trackCount])).toEqual([
      ['10258832', 'Royal EP', 'playlist', 2],
      ['2284613', 'The Royal Concept EP', 'playlist', 3],
      ['likes:9615865', 'Likes', 'liked', 1],
    ])
    expect(parsed.result.playlists[0].tracks[0]).toEqual(profileResult.playlists[0].tracks[0])
    expect(parsed.result.playlists[0].coverUrl).toBe(profileResult.playlists[0].coverUrl)
  })

  it('drops songs without a song link, empty playlists and repeats; canonical links', () => {
    const parsed = parsePcResult({
      playlists: [
        {
          ref: 'a',
          name: '  Mix  ',
          tracks: [
            { ref: '1', title: 'Song', artist: 'X', durationSec: 200.4, link: 'https://youtube.com/watch?v=A2VpR8HahKc&t=5' },
            { ref: '2', title: 'Set, not a song', link: 'https://soundcloud.com/x/sets/y' },
            { ref: '3', title: '', link: 'https://soundcloud.com/x/y' },
            { ref: '4', title: 'API address', link: 'https://api-v2.soundcloud.com/tracks/1' },
            'junk',
          ],
        },
        { ref: 'a', name: 'Repeat', tracks: [{ title: 'S', link: 'https://soundcloud.com/x/y' }] },
        { ref: 'b', name: 'Empty', tracks: [] },
        { name: 'No ref', tracks: [{ title: 'S', link: 'https://soundcloud.com/x/y' }] },
      ],
      problems: ['Bad link', 42],
    })
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.result).toEqual({
      playlists: [
        {
          ref: 'a',
          name: 'Mix',
          kind: 'playlist',
          coverUrl: null,
          trackCount: 1,
          tracks: [{ ref: '1', title: 'Song', artist: 'X', durationSec: 200, link: 'https://www.youtube.com/watch?v=A2VpR8HahKc', coverUrl: null }],
        },
      ],
      problems: ['Bad link'],
      truncated: false,
    })
  })

  it(`stops at ${MAX_SONGS} songs`, () => {
    const tracks = Array.from({ length: 3_000 }, (_, i) => ({ ref: String(i), title: `Song ${i}`, link: `https://soundcloud.com/x/song-${i}` }))
    const parsed = parsePcResult({ playlists: [{ ref: 'a', tracks }, { ref: 'b', tracks }, { ref: 'c', tracks }] })
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.result.playlists.map((p) => p.trackCount)).toEqual([3_000, 2_000])
    expect(parsed.result.truncated).toBe(true)
  })

  it('refuses something that is not an answer', () => {
    expect(parsePcResult(null)).toEqual({ error: 'Expected a JSON object' })
    expect(parsePcResult({ playlists: 'no' })).toEqual({ error: 'playlists must be an array' })
  })
})

describe('the importer', () => {
  const links = ['https://soundcloud.com/the-concept-band']
  const ctx = (payload: Record<string, unknown> = {}): ImportContext => ({
    job: { id: 'job-1', service: 'soundcloud', method: 'link', payload: { links, ...payload } },
  })
  const stored = (): Record<string, unknown> => {
    const parsed = parsePcResult(profileResult)
    if ('error' in parsed) throw new Error(parsed.error)
    return { [PC_RESULT_KEY]: parsed.result }
  }

  it('is on, for SoundCloud, YouTube and YouTube Music links, and says the PC must be on', () => {
    expect(pcListingImporter.isAvailable({} as NodeJS.ProcessEnv)).toBe(true)
    expect(pcListingImporter.services).toEqual(['soundcloud', 'youtube', 'ytmusic'])
    expect(pcListingImporter.methods).toEqual(['link'])
    expect(pcListingImporter.hints?.link).toContain('keep it on')
  })

  it('checks the links right away, then waits for the PC', async () => {
    await expect(pcListingImporter.listPlaylists({ method: 'link', links: ['https://soundcloud.com/a/b'] }, ctx())).rejects.toThrow(ImportUserError)
    expect(isPending(await pcListingImporter.listPlaylists({ method: 'link', links }, ctx()))).toBe(true)
  })

  it("lists the PC's playlists once it answered", async () => {
    const listed = await pcListingImporter.listPlaylists({ method: 'link', links }, ctx(stored()))
    if (isPending(listed)) throw new Error('still pending')
    expect(listed.playlists).toEqual([
      { ref: '10258832', name: 'Royal EP', kind: 'playlist', coverUrl: profileResult.playlists[0].coverUrl, trackCount: 2 },
      { ref: '2284613', name: 'The Royal Concept EP', kind: 'playlist', coverUrl: profileResult.playlists[1].coverUrl, trackCount: 3 },
      { ref: 'likes:9615865', name: 'Likes', kind: 'liked', coverUrl: profileResult.playlists[2].coverUrl, trackCount: 1 },
    ])
  })

  it("tells the PC's problem when nothing could be read", async () => {
    const empty = { [PC_RESULT_KEY]: { playlists: [], problems: ['Couldn\'t open https://soundcloud.com/a. Check that it exists and is public.'], truncated: false } }
    await expect(pcListingImporter.listPlaylists({ method: 'link', links }, ctx(empty))).rejects.toThrow(
      "Couldn't open https://soundcloud.com/a. Check that it exists and is public.",
    )
    const nothing = { [PC_RESULT_KEY]: { playlists: [], problems: [], truncated: false } }
    await expect(pcListingImporter.listPlaylists({ method: 'link', links }, ctx(nothing))).rejects.toThrow(NOTHING_FOUND)
  })

  it('pages through the stored songs, each with its link, then drops them from the payload', async () => {
    const tracks = Array.from({ length: PC_PAGE_SIZE + 3 }, (_, i) => ({
      ref: String(i),
      title: `Song ${i}`,
      artist: 'A',
      durationSec: 100,
      link: `https://soundcloud.com/a/song-${i}`,
      coverUrl: null,
    }))
    const result: PcResult = {
      playlists: [
        { ref: 'big', name: 'Big', kind: 'playlist', coverUrl: null, trackCount: tracks.length, tracks },
        { ref: 'other', name: 'Other', kind: 'playlist', coverUrl: null, trackCount: 1, tracks: tracks.slice(0, 1) },
      ],
      problems: [],
      truncated: false,
    }
    const playlist: ImportPlaylist = { ref: 'big', name: 'Big' }
    const first = (await pcListingImporter.getTracks(playlist, { ...ctx({ [PC_RESULT_KEY]: result }), cursor: null })) as TrackPage
    expect(first.tracks).toHaveLength(PC_PAGE_SIZE)
    expect(first.tracks[0]).toEqual({ ref: '0', title: 'Song 0', artist: 'A', durationSec: 100, link: 'https://soundcloud.com/a/song-0', coverUrl: null })
    expect(first.next).toBe(String(PC_PAGE_SIZE))
    expect(first.payload).toBeUndefined()
    const last = (await pcListingImporter.getTracks(playlist, { ...ctx({ [PC_RESULT_KEY]: result }), cursor: first.next ?? null })) as TrackPage
    expect(last.tracks.map((t) => t.title)).toEqual([`Song ${PC_PAGE_SIZE}`, `Song ${PC_PAGE_SIZE + 1}`, `Song ${PC_PAGE_SIZE + 2}`])
    expect(last.next).toBeNull()
    const after = readPcResult(last.payload ?? {})
    expect(after?.playlists.map((p) => [p.ref, p.tracks.length, p.read ?? false])).toEqual([
      ['big', 0, true],
      ['other', 1, false],
    ])
  })

  it('says so when a playlist is not in the answer', async () => {
    await expect(pcListingImporter.getTracks({ ref: 'nope', name: 'Gone' }, { ...ctx(stored()), cursor: null })).rejects.toThrow(
      'The playlist "Gone" is gone. Import it again.',
    )
  })
})
