/**
 * "In library" rules for catalog results (V2-PLAN T11 item 2): same catalog
 * id, same ISRC, or the same normalised title and a matching artist (SPEC
 * 8.5 normalise rules). Pure: the index is built from plain rows.
 */
import { describe, expect, it } from 'vitest'

import { buildLibraryIndex, type LibraryTrackRow } from './catalog-library'

function row(input: Partial<LibraryTrackRow>): LibraryTrackRow {
  return {
    source: 'youtube',
    source_id: 'abc',
    isrc: null,
    title: '',
    artist: '',
    album: null,
    album_artist: null,
    ...input,
  }
}

const song = { id: 'deezer:1', isrc: null, title: 'Song', artist: 'Band' }

describe('tracks', () => {
  it('matches the same catalog id', () => {
    const index = buildLibraryIndex([row({ source: 'catalog', source_id: 'deezer:3135556', title: 'Edited by hand' })])
    expect(index.hasTrack({ ...song, id: 'deezer:3135556' })).toBe(true)
    expect(index.hasTrack({ ...song, id: 'deezer:3135557' })).toBe(false)
  })

  it('a YouTube row with the same number as source_id is not the catalog song', () => {
    const index = buildLibraryIndex([row({ source: 'youtube', source_id: 'deezer:3135556' })])
    expect(index.hasTrack({ ...song, id: 'deezer:3135556' })).toBe(false)
  })

  it('matches the same ISRC in any case', () => {
    const index = buildLibraryIndex([row({ isrc: 'gbduw0000059', title: 'Other' })])
    expect(index.hasTrack({ ...song, isrc: 'GBDUW0000059' })).toBe(true)
  })

  it('matches the normalised title with a matching artist (8.5 rules)', () => {
    const index = buildLibraryIndex([
      row({ title: 'Get Lucky (Official Audio)', artist: 'Daft Punk & Pharrell Williams' }),
      row({ title: 'Harder, Better, Faster, Stronger', artist: 'Daft Punk' }),
    ])
    expect(index.hasTrack({ ...song, title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', artist: 'Daft Punk' })).toBe(true)
    expect(index.hasTrack({ ...song, title: 'Harder Better Faster Stronger', artist: 'DAFT PUNK' })).toBe(true)
  })

  it('does not match the same title by another artist, or a different title', () => {
    const index = buildLibraryIndex([row({ title: 'Starboy', artist: 'The Weeknd' })])
    expect(index.hasTrack({ ...song, title: 'Starboy', artist: 'Someone Else' })).toBe(false)
    expect(index.hasTrack({ ...song, title: 'Starboy Remix Edition', artist: 'The Weeknd' })).toBe(false)
    expect(index.hasTrack({ ...song, title: 'Starboy', artist: '' })).toBe(false)
  })
})

describe('albums and artists', () => {
  const index = buildLibraryIndex([
    row({ title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', album_artist: 'Daft Punk' }),
    row({ title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', album_artist: null }),
  ])

  it('matches an album by normalised name and artist', () => {
    expect(index.hasAlbum({ title: 'Discovery', artist: 'Daft Punk' })).toBe(true)
    expect(index.hasAlbum({ title: 'After Hours', artist: 'The Weeknd' })).toBe(true)
    expect(index.hasAlbum({ title: 'Discovery', artist: 'Someone Else' })).toBe(false)
    expect(index.hasAlbum({ title: 'Homework', artist: 'Daft Punk' })).toBe(false)
  })

  it('matches an artist only by the exact normalised name', () => {
    expect(index.hasArtist({ name: 'Daft Punk' })).toBe(true)
    expect(index.hasArtist({ name: 'Weeknd' })).toBe(true) // "The" is dropped by the 8.5 normaliser
    expect(index.hasArtist({ name: 'Daft Punk - Stardust' })).toBe(false)
    expect(index.hasArtist({ name: '' })).toBe(false)
  })
})
