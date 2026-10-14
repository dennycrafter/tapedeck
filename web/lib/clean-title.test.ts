/**
 * Rule-cleaner fixtures (SPEC 8.4 step 1). The T1 bar is "the rule cleaner
 * pass with the SPEC examples"; the REALISTIC_FIXTURES table below covers
 * the T3 bar of 15+ realistic titles (marketing words, " - Topic", VEVO,
 * feat variants, remixes, "X by Y") with 20+ entries.
 */

import { describe, expect, it } from 'vitest'

import { UNKNOWN_ARTIST, cleanTitleRules, restoreOriginalArtist } from './clean-title'

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
    // SPEC order: the " - " split fires even when a channel name was passed;
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
    expect(cleanYouTube('Daft Punk \u2013 Get Lucky')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk' })
    expect(cleanYouTube('Daft Punk \u2014 Get Lucky')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk' })
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

/**
 * Realistic raw titles (T3: "at least 15 realistic title fixtures"). The
 * first six are the recorded fixtures (e2e/fixtures/youtube-oembed.json and
 * anthropic-messages.json) the T3 e2e and route tests add; the rest are
 * real uploads in the shapes the cleaner meets most: remixes, feat. inside
 * brackets, " - Topic" and VEVO channels, SoundCloud "X by Y".
 */
const REALISTIC_FIXTURES: Array<{
  raw: string
  channel: string
  source?: 'youtube' | 'soundcloud'
  title: string
  artist: string
}> = [
  // Recorded fixtures.
  { raw: 'The Weeknd - Blinding Lights (Official Video)', channel: 'TheWeekndVEVO', title: 'Blinding Lights', artist: 'The Weeknd' },
  { raw: 'Luis Fonsi - Despacito ft. Daddy Yankee', channel: 'LuisFonsiVEVO', title: 'Despacito (feat. Daddy Yankee)', artist: 'Luis Fonsi' },
  { raw: 'PSY - GANGNAM STYLE(강남스타일) M/V', channel: 'officialpsy', title: 'GANGNAM STYLE (강남스타일)', artist: 'PSY' },
  {
    raw: 'Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] Furious 7 Soundtrack',
    channel: 'Wiz Khalifa Music',
    title: 'See You Again (feat. Charlie Puth)',
    artist: 'Wiz Khalifa',
  },
  { raw: 'Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars', channel: 'MarkRonsonVEVO', title: 'Uptown Funk (feat. Bruno Mars)', artist: 'Mark Ronson' },
  { raw: 'Blinding Lights by The Weeknd', channel: 'The Weeknd', source: 'soundcloud', title: 'Blinding Lights', artist: 'The Weeknd' },
  { raw: 'Mystery Upload Official Video', channel: 'Mystery Channel', title: 'Mystery Upload', artist: 'Mystery Channel' },
  { raw: 'Me at the zoo', channel: 'jawed', title: 'Me at the zoo', artist: 'jawed' },
  // Remixes and version info.
  {
    raw: 'Calvin Harris - Summer (R3hab & Ummet Ozcan Remix) [Official Audio]',
    channel: 'CalvinHarrisVEVO',
    title: 'Summer (R3hab & Ummet Ozcan Remix)',
    artist: 'Calvin Harris',
  },
  { raw: 'Lady Gaga - Bloody Mary (Sped Up)', channel: 'Lady Gaga', title: 'Bloody Mary (Sped Up)', artist: 'Lady Gaga' },
  {
    raw: 'Ed Sheeran - Shape of You (Live at the BRITs) ft. Stormzy [HD]',
    channel: 'Ed Sheeran',
    title: 'Shape of You (Live at the BRITs) (feat. Stormzy)',
    artist: 'Ed Sheeran',
  },
  {
    raw: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
    channel: 'Rick Astley',
    title: 'Never Gonna Give You Up (4K Remaster)',
    artist: 'Rick Astley',
  },
  // feat. inside brackets.
  {
    raw: 'DJ Snake - Taki Taki (feat. Selena Gomez, Ozuna & Cardi B) [Official Music Video]',
    channel: 'DJSnakeVEVO',
    title: 'Taki Taki (feat. Selena Gomez, Ozuna & Cardi B)',
    artist: 'DJ Snake',
  },
  { raw: 'Post Malone - Sunflower (feat. Swae Lee) (Spider-Man: Into the Spider-Verse)', channel: 'PostMaloneVEVO', title: 'Sunflower (Spider-Man: Into the Spider-Verse) (feat. Swae Lee)', artist: 'Post Malone' },
  { raw: 'Ariana Grande - 7 rings (Remix ft. 2 Chainz) [Audio]', channel: 'ArianaGrandeVevo', title: '7 rings (Remix) (feat. 2 Chainz)', artist: 'Ariana Grande' },
  // " - Topic" and VEVO channels with no dash in the title.
  { raw: 'Levitating', channel: 'Dua Lipa - Topic', title: 'Levitating', artist: 'Dua Lipa' },
  { raw: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', channel: 'Daft Punk - Topic', title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artist: 'Daft Punk' },
  { raw: 'Rolling in the Deep (Official Music Video)', channel: 'AdeleVEVO', title: 'Rolling in the Deep', artist: 'Adele' },
  // Other marketing shapes.
  { raw: 'Billie Eilish - bad guy (Official Lyric Video)', channel: 'BillieEilishVEVO', title: 'bad guy', artist: 'Billie Eilish' },
  { raw: 'Stromae - Alors on danse (Clip Officiel)', channel: 'stromae', title: 'Alors on danse', artist: 'Stromae' },
  { raw: 'Avicii - Wake Me Up | Official Visualizer', channel: 'AviciiOfficialVEVO', title: 'Wake Me Up', artist: 'Avicii' },
  { raw: '[MV] IU - Blueming', channel: '1theK', title: 'Blueming', artist: 'IU' },
  // SoundCloud uploads.
  { raw: 'Flickermood', channel: 'Forss', source: 'soundcloud', title: 'Flickermood', artist: 'Forss' },
]

describe('realistic raw titles (T3 fixtures)', () => {
  it('has at least 20 realistic fixtures', () => {
    expect(REALISTIC_FIXTURES.length).toBeGreaterThanOrEqual(20)
  })

  for (const fixture of REALISTIC_FIXTURES) {
    it(`cleans ${JSON.stringify(fixture.raw)}`, () => {
      expect(cleanTitleRules(fixture.raw, fixture.channel, fixture.source ?? 'youtube')).toEqual({
        title: fixture.title,
        artist: fixture.artist,
      })
    })
  }
})

describe('bracket and feat boundaries (8.4)', () => {
  it('puts one space before a kept bracket glued to the title', () => {
    expect(cleanYouTube('Artist - Song(Live)').title).toBe('Song (Live)')
    expect(cleanYouTube('Artist - Song  (Live)').title).toBe('Song (Live)')
  })

  it('stops featured names at a bracket, removed or kept', () => {
    expect(cleanYouTube('Artist - Song ft. Alice (Live)').title).toBe('Song (Live) (feat. Alice)')
    expect(cleanYouTube('Artist - Song ft. Alice [Official Video]').title).toBe('Song (feat. Alice)')
  })

  it('drops loose words after a removed marketing bracket but keeps later version brackets', () => {
    expect(cleanYouTube('Artist - Song [Official Video] Some Movie Soundtrack').title).toBe('Song')
    expect(cleanYouTube('Artist - Song (Official Video) (Acoustic)').title).toBe('Song (Acoustic)')
  })

  it('cuts a leading marketing bracket without dropping the song after it', () => {
    expect(cleanYouTube('[MV] Artist - Song')).toEqual({ title: 'Song', artist: 'Artist' })
  })
})

describe('restoreOriginalArtist (8.4 Undo)', () => {
  it('strips only " - Topic" and "VEVO"', () => {
    expect(restoreOriginalArtist('Dua Lipa - Topic')).toBe('Dua Lipa')
    expect(restoreOriginalArtist('TheWeekndVEVO')).toBe('TheWeeknd')
    expect(restoreOriginalArtist('Daft Punk - VEVO')).toBe('Daft Punk')
    expect(restoreOriginalArtist('artist - TOPIC')).toBe('artist')
  })

  it('keeps "Official" in the raw artist', () => {
    expect(restoreOriginalArtist('Daft Punk Official')).toBe('Daft Punk Official')
    expect(restoreOriginalArtist('officialpsy')).toBe('officialpsy')
  })

  it('never returns an empty artist', () => {
    expect(restoreOriginalArtist('VEVO')).toBe('VEVO')
    expect(restoreOriginalArtist('')).toBe(UNKNOWN_ARTIST)
    expect(restoreOriginalArtist('   ')).toBe(UNKNOWN_ARTIST)
  })
})
