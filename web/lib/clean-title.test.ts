/**
 * Rule-cleaner fixtures (SPEC 8.4 step 1). The T1 bar is "the rule cleaner
 * pass with the SPEC examples"; these fixtures already cover the T3 bar of
 * 15+ realistic titles (marketing words, " - Topic", VEVO, feat variants,
 * remixes, "X by Y").
 */

import { describe, expect, it } from 'vitest'

import { UNKNOWN_ARTIST, cleanTitleRules } from './clean-title'

function cleanYouTube(title: string, artist = '') {
  return cleanTitleRules(title, artist, 'youtube')
}

describe('marketing text removal (8.4)', () => {
  it('removes a bracketed (Official Video)', () => {
    expect(cleanYouTube('Get Lucky (Official Video)', 'Daft Punk')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
  })

  it('removes square-bracket marketing', () => {
    expect(cleanYouTube('Song [Official Music Video]')).toEqual({
      title: 'Song',
      artist: UNKNOWN_ARTIST,
    })
  })

  it('is case-insensitive', () => {
    expect(cleanYouTube('Song (OFFICIAL VIDEO)')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song (Official VIDEO)')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
  })

  it('removes every listed marketing phrase', () => {
    for (const phrase of [
      'Official Video',
      'Official Music Video',
      'Official Audio',
      'Official Lyric Video',
      'Lyric Video',
      'Music Video',
      'Clip Officiel',
    ]) {
      expect(cleanYouTube(`Song (${phrase})`).title, phrase).toBe('Song')
    }
  })

  it('removes single marketing tokens in brackets', () => {
    for (const token of ['Lyrics', 'Audio', 'Visualizer', 'Visualiser', 'HD', 'HQ', '4K', 'MV', 'M/V', 'Explicit']) {
      expect(cleanYouTube(`Song (${token})`).title, token).toBe('Song')
    }
  })

  it('removes combinations of marketing tokens in one bracket', () => {
    expect(cleanYouTube('Song (HD 4K)')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song (Official 4K)')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
  })

  it('strips empty brackets left behind, including nested ones', () => {
    expect(cleanYouTube('Song (Official Video) ()')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song ((Official Video))')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song ( ) [Lyrics]')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
  })

  it('keeps brackets that are not marketing', () => {
    expect(cleanYouTube('Song (2011 Remaster)', 'Artist')).toEqual({
      title: 'Song (2011 Remaster)',
      artist: 'Artist',
    })
  })

  it('removes trailing marketing after a separator, without brackets', () => {
    expect(cleanYouTube('Song | Official Video')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Get Lucky - Official Video', 'Daft Punk')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
    expect(cleanYouTube('Artist - Song | Official Visualizer')).toEqual({
      title: 'Song',
      artist: 'Artist',
    })
  })

  it('strips bare trailing marketing words', () => {
    expect(cleanYouTube('Song Official Video')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song Lyrics')).toEqual({ title: 'Song', artist: UNKNOWN_ARTIST })
  })

  it('prefers the dash split over the channel fallback', () => {
    // SPEC order: the " - " split fires even when a channel name was passed —
    // the raw artist is only the no-split fallback.
    expect(cleanYouTube('Song - Live Version', 'Artist')).toEqual({
      title: 'Live Version',
      artist: 'Song',
    })
  })
})

describe('artist/title split (8.4)', () => {
  it('splits on the first " - " into artist and title', () => {
    expect(cleanYouTube('Daft Punk - Get Lucky (Official Video)')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
    expect(cleanYouTube('Artist - Song - Radio Edit')).toEqual({
      title: 'Song - Radio Edit',
      artist: 'Artist',
    })
  })

  it('splits on Unicode en and em dashes with spaces', () => {
    expect(cleanYouTube('Daft Punk – Get Lucky')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk' })
    expect(cleanYouTube('Daft Punk — Get Lucky')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk' })
  })

  it('falls back to the channel name with suffixes removed', () => {
    expect(cleanYouTube('Get Lucky', 'Daft Punk - Topic')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
    expect(cleanYouTube('Get Lucky', 'DaftPunkVEVO')).toEqual({
      title: 'Get Lucky',
      artist: 'DaftPunk',
    })
    expect(cleanYouTube('Get Lucky', 'Daft Punk - VEVO')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
    expect(cleanYouTube('Get Lucky', 'Daft Punk Official')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
    expect(cleanYouTube('Get Lucky', 'Daft Punk')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk' })
  })

  it('is case-insensitive on the channel suffixes', () => {
    expect(cleanYouTube('Get Lucky', 'Artist - TOPIC').artist).toBe('Artist')
    expect(cleanYouTube('Get Lucky', 'artistvevo').artist).toBe('artist')
  })

  it('turns an empty artist into Unknown Artist', () => {
    expect(cleanYouTube('Song', '').artist).toBe(UNKNOWN_ARTIST)
    expect(cleanYouTube('Song', '   ').artist).toBe(UNKNOWN_ARTIST)
  })
})

describe('featured artists (8.4)', () => {
  it('normalises feat. variants to (feat. Name) at the end of the title', () => {
    expect(cleanYouTube('Song feat. Alice')).toEqual({ title: 'Song (feat. Alice)', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song ft. Alice')).toEqual({ title: 'Song (feat. Alice)', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song ft Alice')).toEqual({ title: 'Song (feat. Alice)', artist: UNKNOWN_ARTIST })
    expect(cleanYouTube('Song featuring Alice')).toEqual({
      title: 'Song (feat. Alice)',
      artist: UNKNOWN_ARTIST,
    })
  })

  it('moves featured artists from the artist field into the title', () => {
    expect(cleanYouTube('Song', 'Alice ft. Bob')).toEqual({
      title: 'Song (feat. Bob)',
      artist: 'Alice',
    })
  })

  it('normalises a feat that was already parenthesised', () => {
    expect(cleanYouTube('Song (feat. Alice)')).toEqual({ title: 'Song (feat. Alice)', artist: UNKNOWN_ARTIST })
  })

  it('does not fire inside other words (Daft Punk)', () => {
    expect(cleanYouTube('Daft Punk - Get Lucky', 'Daft Punk')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
  })

  it('joins featured names from both fields', () => {
    expect(cleanYouTube('Song feat. Alice', 'Bob ft. Carol')).toEqual({
      title: 'Song (feat. Alice, Carol)',
      artist: 'Bob',
    })
  })
})

describe('SoundCloud "X by Y" (8.4)', () => {
  it('splits the oEmbed title form', () => {
    expect(cleanTitleRules('Get Lucky by Daft Punk', 'Radio Record', 'soundcloud')).toEqual({
      title: 'Get Lucky',
      artist: 'Daft Punk',
    })
  })

  it('keeps the uploader when the title has no "by"', () => {
    expect(cleanTitleRules('Flickermood', 'Forss', 'soundcloud')).toEqual({
      title: 'Flickermood',
      artist: 'Forss',
    })
  })

  it('prefers the dash split on SoundCloud when both appear', () => {
    expect(cleanTitleRules('Daft Punk - Get Lucky by Nobody', 'Uploader', 'soundcloud')).toEqual({
      title: 'Get Lucky by Nobody',
      artist: 'Daft Punk',
    })
  })
})

describe('version info survives (8.4 keep-list)', () => {
  it('keeps remix, live and acoustic markers in parentheses', () => {
    expect(cleanYouTube('Song (Alice Remix) (Official Video)')).toEqual({
      title: 'Song (Alice Remix)',
      artist: UNKNOWN_ARTIST,
    })
    expect(cleanYouTube('Artist - Song (Live)', 'Artist')).toEqual({
      title: 'Song (Live)',
      artist: 'Artist',
    })
    expect(cleanYouTube('Artist - Song (Acoustic) [HD]', 'Artist')).toEqual({
      title: 'Song (Acoustic)',
      artist: 'Artist',
    })
  })
})

describe('degenerate inputs', () => {
  it('never returns an empty title when raw text exists', () => {
    expect(cleanYouTube('Official Video', 'Artist').title).toBe('Official Video')
  })

  it('handles the T1 fixture video end to end', () => {
    expect(cleanYouTube('Me at the zoo', 'jawed')).toEqual({ title: 'Me at the zoo', artist: 'jawed' })
  })
})
