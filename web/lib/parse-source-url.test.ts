/**
 * Song-link parsing fixtures (SPEC 8.2 step 1, 7.4): every accepted and
 * rejected format, canonicalization, and the exact per-line messages.
 */

import { describe, expect, it } from 'vitest'

import {
  NOT_A_SONG_LINK_MESSAGE,
  SOUNDCLOUD_SETS_MESSAGE,
  parseSongLink,
} from './parse-source-url'

function expectYouTube(raw: string, videoId: string) {
  const parsed = parseSongLink(raw)
  expect(parsed.kind, raw).toBe('link')
  if (parsed.kind !== 'link') return
  expect(parsed.link.source).toBe('youtube')
  expect(parsed.link.sourceId).toBe(videoId)
  // One canonical form for every accepted shape (8.2).
  expect(parsed.link.sourceUrl).toBe(`https://www.youtube.com/watch?v=${videoId}`)
}

function expectSoundcloud(raw: string, user: string, track: string) {
  const parsed = parseSongLink(raw)
  expect(parsed.kind, raw).toBe('link')
  if (parsed.kind !== 'link') return
  expect(parsed.link.source).toBe('soundcloud')
  expect(parsed.link.sourceId).toBe(`${user}/${track}`)
  expect(parsed.link.sourceUrl).toBe(`https://soundcloud.com/${user}/${track}`)
}

describe('accepted YouTube formats (8.2)', () => {
  it('accepts youtube.com/watch?v=', () => {
    expectYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ')
  })

  it('accepts youtu.be/ short links', () => {
    expectYouTube('https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ')
  })

  it('accepts music.youtube.com/watch?v=', () => {
    expectYouTube('https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ')
  })

  it('accepts youtube.com/shorts/', () => {
    expectYouTube('https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ')
    expectYouTube('https://youtube.com/shorts/dQw4w9WgXcQ/', 'dQw4w9WgXcQ')
  })

  it('strips trailing params (list=, t=, si=, feature=)', () => {
    expectYouTube(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123&t=42s&si=abc',
      'dQw4w9WgXcQ',
    )
    expectYouTube('https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ')
    expectYouTube('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ')
  })

  it('accepts links without a scheme', () => {
    expectYouTube('youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ')
    expectYouTube('www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ')
    expectSoundcloud('soundcloud.com/forss/flickermood', 'forss', 'flickermood')
  })

  it('canonicalizes all forms of the same video to one source_url', () => {
    const forms = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]
    const parsed = forms.map((form) => parseSongLink(form))
    for (const entry of parsed) {
      expect(entry.kind).toBe('link')
      if (entry.kind === 'link') {
        expect(entry.link.sourceUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      }
    }
  })
})

describe('accepted SoundCloud format (7.4)', () => {
  it('accepts soundcloud.com/<user>/<track>', () => {
    expectSoundcloud('https://soundcloud.com/forss/flickermood', 'forss', 'flickermood')
  })

  it('strips trailing query strings', () => {
    expectSoundcloud('https://soundcloud.com/forss/flickermood?in=playlist/123', 'forss', 'flickermood')
  })

  it('reports on.soundcloud.com short links for server-side resolution', () => {
    const parsed = parseSongLink('https://on.soundcloud.com/abc123')
    expect(parsed).toEqual({ kind: 'soundcloud-shortlink', shortUrl: 'https://on.soundcloud.com/abc123' })
  })
})

describe('rejected inputs (8.2, 7.4)', () => {
  it('rejects YouTube playlists, channels and embeds with the exact message', () => {
    for (const link of [
      'https://www.youtube.com/playlist?list=PLtest123',
      'https://www.youtube.com/channel/UCxxx',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(parseSongLink(link), link).toEqual({ kind: 'error', message: NOT_A_SONG_LINK_MESSAGE })
    }
  })

  it('rejects watch?v= values that are not video ids', () => {
    expect(parseSongLink('https://www.youtube.com/watch?v=short')).toEqual({
      kind: 'error',
      message: NOT_A_SONG_LINK_MESSAGE,
    })
  })

  it('rejects SoundCloud sets with the exact message (7.4)', () => {
    for (const link of [
      'https://soundcloud.com/forss/sets/moves',
      'https://soundcloud.com/forss/sets/',
      'https://soundcloud.com/sets/moves',
    ]) {
      expect(parseSongLink(link), link).toEqual({ kind: 'error', message: SOUNDCLOUD_SETS_MESSAGE })
    }
  })

  it('rejects SoundCloud pages that are not single tracks', () => {
    expect(parseSongLink('https://soundcloud.com/forss')).toEqual({
      kind: 'error',
      message: NOT_A_SONG_LINK_MESSAGE,
    })
  })

  it('rejects non-link lines and other hosts', () => {
    for (const line of [
      'just some words',
      '',
      '   ',
      'https://open.spotify.com/track/xyz',
      'https://vimeo.com/12345',
      'ftp://youtu.be/dQw4w9WgXcQ',
      'https://evilyoutu.be/dQw4w9WgXcQ',
      'https://youtube.com.evil.tld/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(parseSongLink(line), line).toEqual({ kind: 'error', message: NOT_A_SONG_LINK_MESSAGE })
    }
  })

  it('trims surrounding whitespace before parsing', () => {
    expectYouTube('  https://youtu.be/dQw4w9WgXcQ  ', 'dQw4w9WgXcQ')
  })

  it('accepts unusual but valid video id characters', () => {
    // 11 chars including - and _
    expectYouTube('https://youtu.be/abcd-efg_h1', 'abcd-efg_h1')
  })
})
