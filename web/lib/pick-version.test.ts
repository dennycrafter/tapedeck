/**
 * "Pick another version" (V2-PLAN T12): the option list, which links may be
 * picked, and the one UPDATE that re-queues a catalog song. The database
 * part runs against the real in-memory PGlite (SPEC 4.1).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from './db'
import { SHORTLINK_MESSAGE, resolvePickUrl, sourceLabel, versionOptions } from './pick-version'
import { pickTarget, pickVersion } from './pick-version-db'
import { NOT_A_SONG_LINK_MESSAGE, SOUNDCLOUD_SETS_MESSAGE } from './parse-source-url'
import type { MatchInfo } from './track-v2'

const CHOSEN = {
  title: 'Song (Official Audio)',
  uploader: 'Band - Topic',
  durationSec: 214,
  url: 'https://music.youtube.com/watch?v=AAAAAAAAAAA',
  score: 0.97,
  source: 'ytmusic',
}
const ALT_SC = {
  title: 'Song',
  uploader: 'band',
  durationSec: 215,
  url: 'https://soundcloud.com/band/song',
  score: 0.8,
  source: 'soundcloud',
}
const ALT_YT = {
  title: 'Song (Lyrics)',
  uploader: 'Lyric Channel',
  durationSec: 230,
  url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
  score: 0.6,
  source: 'youtube',
}
const INFO: MatchInfo = { chosen: CHOSEN, score: 0.97, alternatives: [ALT_SC, ALT_YT] }

describe('versionOptions', () => {
  it('lists the chosen copy first, then the alternatives, and flags the downloaded one', () => {
    const options = versionOptions(INFO, CHOSEN.url)
    expect(options.map((option) => option.url)).toEqual([CHOSEN.url, ALT_SC.url, ALT_YT.url])
    expect(options.map((option) => option.current)).toEqual([true, false, false])
    expect(options[0]).toMatchObject({
      title: CHOSEN.title,
      uploader: CHOSEN.uploader,
      durationSec: 214,
      score: 0.97,
      source: 'ytmusic',
    })
  })

  it('flags an alternative when that is what the PC downloaded, and none when nothing matches', () => {
    expect(versionOptions(INFO, ALT_YT.url).map((option) => option.current)).toEqual([false, false, true])
    expect(versionOptions(INFO, null).some((option) => option.current)).toBe(false)
    expect(versionOptions(INFO, 'https://www.youtube.com/watch?v=CCCCCCCCCCC').some((o) => o.current)).toBe(false)
  })

  it('drops repeated urls (the chosen copy listed again as an alternative)', () => {
    const options = versionOptions({ chosen: CHOSEN, alternatives: [CHOSEN, ALT_SC, ALT_SC] }, null)
    expect(options.map((option) => option.url)).toEqual([CHOSEN.url, ALT_SC.url])
  })

  it('works without a chosen copy (the "no match" case keeps only alternatives)', () => {
    const options = versionOptions({ chosen: null, alternatives: [ALT_YT] }, null)
    expect(options.map((option) => option.url)).toEqual([ALT_YT.url])
  })

  it('tolerates malformed matchInfo and skips bad entries', () => {
    expect(versionOptions(null, null)).toEqual([])
    expect(versionOptions(undefined, 'x')).toEqual([])
    expect(versionOptions('nope' as unknown as MatchInfo, null)).toEqual([])
    expect(versionOptions([CHOSEN] as unknown as MatchInfo, null)).toEqual([])
    expect(versionOptions({ alternatives: 'nope' } as unknown as MatchInfo, null)).toEqual([])
    const messy = {
      chosen: 'not an object',
      alternatives: [
        null,
        42,
        [],
        { title: 'No url' },
        { title: 'Bad url', url: 'not a url' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { url: 'https://www.youtube.com/watch?v=DDDDDDDDDDD', durationSec: 'long', score: 'high', title: 7 },
      ],
    } as unknown as MatchInfo
    const options = versionOptions(messy, null)
    expect(options).toHaveLength(1)
    expect(options[0]).toEqual({
      title: 'https://www.youtube.com/watch?v=DDDDDDDDDDD',
      uploader: '',
      durationSec: null,
      url: 'https://www.youtube.com/watch?v=DDDDDDDDDDD',
      score: null,
      source: 'youtube',
      current: false,
    })
  })

  it('guesses the source from the address when the PC did not say', () => {
    const bare = (url: string) => ({ title: 't', uploader: 'u', durationSec: 1, url, score: 1 })
    const options = versionOptions(
      {
        alternatives: [
          bare('https://music.youtube.com/watch?v=EEEEEEEEEEE'),
          bare('https://soundcloud.com/a/b'),
          bare('https://youtu.be/FFFFFFFFFFF'),
          bare('https://example.com/song'),
        ],
      },
      null,
    )
    expect(options.map((option) => option.source)).toEqual(['ytmusic', 'soundcloud', 'youtube', null])
    expect(options.map((option) => sourceLabel(option.source))).toEqual(['YouTube Music', 'SoundCloud', 'YouTube', ''])
  })
})

describe('resolvePickUrl', () => {
  it('keeps a saved candidate url exactly as the PC stored it', () => {
    expect(resolvePickUrl(CHOSEN.url, INFO)).toEqual({ url: CHOSEN.url })
    expect(resolvePickUrl(ALT_SC.url, INFO)).toEqual({ url: ALT_SC.url })
    expect(resolvePickUrl(`  ${ALT_YT.url}\n`, INFO)).toEqual({ url: ALT_YT.url })
  })

  it('turns any other YouTube or SoundCloud song link into its canonical form', () => {
    expect(resolvePickUrl('https://youtu.be/GGGGGGGGGGG?t=10', INFO)).toEqual({
      url: 'https://www.youtube.com/watch?v=GGGGGGGGGGG',
    })
    expect(resolvePickUrl('https://music.youtube.com/watch?v=GGGGGGGGGGG&list=x', null)).toEqual({
      url: 'https://www.youtube.com/watch?v=GGGGGGGGGGG',
    })
    expect(resolvePickUrl('soundcloud.com/someone/a-track?si=abc', null)).toEqual({
      url: 'https://soundcloud.com/someone/a-track',
    })
  })

  it('asks for the full link for SoundCloud short links', () => {
    expect(resolvePickUrl('https://on.soundcloud.com/abc123', INFO)).toEqual({ error: SHORTLINK_MESSAGE })
  })

  it("passes on the link parser's message for anything else", () => {
    expect(resolvePickUrl('https://example.com/song', INFO)).toEqual({ error: NOT_A_SONG_LINK_MESSAGE })
    expect(resolvePickUrl('', INFO)).toEqual({ error: NOT_A_SONG_LINK_MESSAGE })
    expect(resolvePickUrl('https://soundcloud.com/someone/sets/mix', null)).toEqual({ error: SOUNDCLOUD_SETS_MESSAGE })
  })

  it('does not accept a bad entry just because it is saved in matchInfo', () => {
    const info = { alternatives: [{ title: 'x', url: 'javascript:alert(1)' }] } as unknown as MatchInfo
    expect(resolvePickUrl('javascript:alert(1)', info)).toEqual({ error: NOT_A_SONG_LINK_MESSAGE })
  })
})

describe('pickVersion (database)', () => {
  let seq = 0

  beforeAll(() => {
    vi.stubEnv('TAPEDECK_TEST', '1')
    vi.stubEnv('DATABASE_URL', '')
  })

  afterAll(async () => {
    await resetDb()
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events`
  })

  async function insert(source: 'catalog' | 'youtube', status: string): Promise<string> {
    seq += 1
    const sourceId = source === 'catalog' ? `deezer:${seq}` : `pick${String(seq).padStart(7, '0')}`
    const sourceUrl = source === 'catalog' ? '' : `https://www.youtube.com/watch?v=${sourceId}`
    const rows = await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, status, attempts, error,
                          resolved_url, match_info)
      values (${source}, ${sourceId}, ${sourceUrl}, 'Song', 'Song', ${status}, 3, 'Something broke',
              ${CHOSEN.url}, ${JSON.stringify(INFO)}::jsonb)
      returning id`
    return String(rows[0].id)
  }

  async function row(id: string) {
    const [r] = await sql`select status, attempts, error, resolved_url, match_info from tracks where id = ${id}`
    return r
  }

  it('sets the picked copy and re-queues the song with a clean slate, keeping the alternatives', async () => {
    for (const status of ['ready', 'failed', 'waiting']) {
      const id = await insert('catalog', status)
      expect(await pickVersion(id, ALT_SC.url)).toBe('ok')
      const after = await row(id)
      expect(after).toMatchObject({ status: 'waiting', attempts: 0, error: '', resolved_url: ALT_SC.url })
      expect(versionOptions((await pickTarget(id))?.matchInfo, ALT_SC.url)).toHaveLength(3)
    }
  })

  it('Search again clears the pick', async () => {
    const id = await insert('catalog', 'ready')
    expect(await pickVersion(id, null)).toBe('ok')
    expect(await row(id)).toMatchObject({ status: 'waiting', attempts: 0, error: '', resolved_url: null })
  })

  it('leaves a song the PC is downloading alone', async () => {
    const id = await insert('catalog', 'downloading')
    expect(await pickVersion(id, ALT_SC.url)).toBe('busy')
    expect(await row(id)).toMatchObject({ status: 'downloading', attempts: 3, resolved_url: CHOSEN.url })
  })

  it('refuses songs that are not from the catalog, and unknown songs', async () => {
    const id = await insert('youtube', 'ready')
    expect(await pickVersion(id, ALT_SC.url)).toBe('not-catalog')
    expect(await row(id)).toMatchObject({ status: 'ready', resolved_url: CHOSEN.url })
    expect(await pickVersion('00000000-0000-4000-8000-000000000000', null)).toBe('not-found')
  })

  it('pickTarget reads source, status and matchInfo', async () => {
    const id = await insert('catalog', 'failed')
    expect(await pickTarget(id)).toEqual({ source: 'catalog', status: 'failed', matchInfo: INFO })
    expect(await pickTarget('00000000-0000-4000-8000-000000000000')).toBeNull()
  })
})
