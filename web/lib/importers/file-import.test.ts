/**
 * File upload importer (V2-PLAN T13, adapter 5): Exportify CSV and zip,
 * TuneMyMusic CSV, Apple Music Library.xml, recognised by content, read into
 * a compact job payload and paged back out. The fixtures are hand-made
 * (e2e/fixtures/import-file-import/), shaped like the real exports.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { connectOptions, findImporter } from './index'
import {
  FILE_PAGE_SIZE,
  MAX_FILE_SONGS,
  UNKNOWN_FILE,
  decodeText,
  fileImporter,
  packUpload,
  readUpload,
} from './file-import'
import { nameFromFile, parseCsv } from './file-import-csv'
import { parsePlist } from './file-import-plist'
import { songHash } from './file-import-shared'
import { ImportUserError, isPending, type ImportFile, type ImportPlaylist, type ListResult, type ServiceId, type TrackPage } from './types'

const FIXTURES = path.join(__dirname, '..', '..', 'e2e', 'fixtures', 'import-file-import')
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)))
const utf8 = (text: string) => new TextEncoder().encode(text)

function upload(name: string, bytes: Uint8Array): ImportFile {
  return {
    name,
    type: '',
    size: bytes.length,
    text: async () => new TextDecoder().decode(bytes),
    bytes: async () => bytes,
  }
}

function ctx(payload: Record<string, unknown> = {}, service: ServiceId = 'spotify') {
  return { job: { id: 'job-1', service, method: 'file' as const, payload } }
}

async function list(name: string, bytes: Uint8Array, service: ServiceId = 'spotify'): Promise<ListResult> {
  const result = await fileImporter.listPlaylists({ method: 'file', file: upload(name, bytes) }, ctx({}, service))
  if (isPending(result)) throw new Error('a file never waits for the PC')
  return result
}

async function page(payload: Record<string, unknown>, playlist: ImportPlaylist, cursor: string | null = null): Promise<TrackPage> {
  const result = await fileImporter.getTracks(playlist, { ...ctx(payload), cursor })
  if (isPending(result)) throw new Error('a file never waits for the PC')
  return result
}

function exportifyZip(): Uint8Array {
  return zipSync({
    'liked.csv': fixture('liked.csv'),
    'road_trip.csv': fixture('road_trip.csv'),
    'chill.csv': fixture('chill.csv'),
    '__MACOSX/._road_trip.csv': utf8('junk'),
    'cover.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  })
}

async function userError(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (cause) {
    expect(cause).toBeInstanceOf(ImportUserError)
    return (cause as Error).message
  }
  throw new Error('expected an ImportUserError')
}

describe('the file upload importer', () => {
  it('fills the file slot for Spotify and Apple Music, with the accepted types', () => {
    expect(findImporter('file-import', {} as NodeJS.ProcessEnv)).toBe(fileImporter)
    for (const service of ['spotify', 'apple'] as const) {
      const slot = connectOptions(service, {} as NodeJS.ProcessEnv).find((option) => option.method === 'file')
      expect(slot).toMatchObject({ importer: 'file-import', accept: expect.stringContaining('.zip') })
      expect(slot?.hint).toContain('Exportify')
    }
  })
})

describe('Exportify', () => {
  it('reads one playlist CSV: name from the file, songs in order, podcast episodes left out', () => {
    const [playlist, ...rest] = readUpload('road_trip.csv', fixture('road_trip.csv'), 'spotify')
    expect(rest).toEqual([])
    expect(playlist).toMatchObject({ ref: 'file:road-trip', name: 'Road trip', kind: 'playlist' })
    expect(playlist.songs.map((song) => song.title)).toEqual(['Veridis Quo', 'Harder, Better, Faster, Stronger', 'Paper Lanterns', 'Kitchen Radio'])
    expect(playlist.songs[1]).toEqual({
      ref: '0fFxTd1Ml9MhVb9pvsp3Kd',
      title: 'Harder, Better, Faster, Stronger',
      artist: 'Daft Punk',
      album: 'Discovery',
      durationSec: 225,
      isrc: 'GBDUW0000059',
      coverUrl: 'https://i.scdn.co/image/ab67616d0000b273a1b2c3d4e5f60718293a4b5c',
    })
    // A local file has no Spotify id: a stable made-up one.
    const local = playlist.songs[3]
    expect(local).toMatchObject({ artist: 'The Fixture Band', album: 'Stand-in Songs', durationSec: 198, isrc: null, coverUrl: null })
    expect(local.ref).toBe(songHash(['The Fixture Band', 'Kitchen Radio', 'Stand-in Songs', 198]))
    expect(local.ref).toMatch(/^h[0-9a-z]+$/)
  })

  it('reads a header in another language by column place, and unescapes commas in artist names', () => {
    const [playlist] = readUpload('chill.csv', fixture('chill.csv'), 'spotify')
    expect(playlist.name).toBe('Chill')
    expect(playlist.songs).toEqual([
      expect.objectContaining({ ref: '3hJk8LmN2pQr5StUvWxYz0', title: 'Slow Morning', artist: 'The Fixture Band', durationSec: 240 }),
      expect.objectContaining({ title: 'September Haze', artist: 'Earth, Wind & Fixture, Nile Stand-in', album: 'Fixture Funk' }),
    ])
  })

  it('makes liked.csv the Liked songs entry', () => {
    const [playlist] = readUpload('liked.csv', fixture('liked.csv'), 'spotify')
    expect(playlist).toMatchObject({ ref: 'liked', name: 'Liked songs', kind: 'liked' })
    expect(playlist.songs).toHaveLength(2)
  })

  it('lists the playlists of an "Export All" zip and keeps each song once', async () => {
    const result = await list('spotify_playlists.zip', exportifyZip())
    expect(result.playlists).toEqual([
      { ref: 'liked', name: 'Liked songs', kind: 'liked', trackCount: 2, coverUrl: 'https://i.scdn.co/image/ab67616d0000b273a1b2c3d4e5f60718293a4b5c' },
      { ref: 'file:road-trip', name: 'Road trip', kind: 'playlist', trackCount: 4, coverUrl: 'https://i.scdn.co/image/ab67616d0000b273a1b2c3d4e5f60718293a4b5c' },
      { ref: 'file:chill', name: 'Chill', kind: 'playlist', trackCount: 2, coverUrl: 'https://i.scdn.co/image/ab67616d0000b2730f1e2d3c4b5a69788796a5b4' },
    ])
    const stored = result.payload?.fileUpload as { songs: unknown[] }
    // 2 + 4 + 2 songs, Harder, Better, Faster, Stronger in two of them.
    expect(stored.songs).toHaveLength(7)
    // Compact: a song without album, length, ISRC or cover is just [ref, title, artist].
    expect(JSON.stringify(result.payload).length).toBeLessThan(2_000)
  })

  it('reads the songs back from the payload, in order, after the upload is gone', async () => {
    const { playlists, payload = {} } = await list('spotify_playlists.zip', exportifyZip())
    const roadTrip = playlists[1]
    const { tracks, next } = await page(payload, roadTrip)
    expect(next).toBeNull()
    expect(tracks.map((track) => [track.title, track.artist, track.durationSec, track.isrc])).toEqual([
      ['Veridis Quo', 'Daft Punk', 345, 'GBDUW0000060'],
      ['Harder, Better, Faster, Stronger', 'Daft Punk', 225, 'GBDUW0000059'],
      ['Paper Lanterns', 'The Fixture Band', 201, 'QZFX72300003'],
      ['Kitchen Radio', 'The Fixture Band', 198, null],
    ])
    expect(tracks[0]).toMatchObject({ ref: '2LD2gT7gwAurzdQDQtILds', album: 'Discovery' })
    expect(tracks[3]).toMatchObject({ album: 'Stand-in Songs', coverUrl: null })

    // Listing again (after a reload) uses the kept copy.
    const again = await fileImporter.listPlaylists({ method: 'file', file: null }, ctx(payload))
    expect(again).toEqual({ playlists })
  })

  it('gives each playlist a unique ref when two files have the same name', async () => {
    const zip = zipSync({ 'road_trip.csv': fixture('road_trip.csv'), 'Road Trip.csv': fixture('road_trip.csv') })
    const { playlists } = await list('two.zip', zip)
    expect(playlists.map((playlist) => [playlist.ref, playlist.name])).toEqual([
      ['file:road-trip', 'Road trip'],
      ['file:road-trip-2', 'Road Trip'],
    ])
  })
})

describe('TuneMyMusic', () => {
  it('groups one CSV by playlist name, Favorite rows are the liked list, artists are skipped', () => {
    const playlists = readUpload('My Spotify Library.csv', fixture('tunemymusic.csv'), 'spotify')
    expect(playlists.map((playlist) => [playlist.ref, playlist.name, playlist.kind, playlist.songs.length])).toEqual([
      ['liked', 'Favorite Songs', 'liked', 2],
      ['file:late-night-drive', 'Late Night Drive', 'playlist', 3],
    ])
    const [veridis, paper, slow] = playlists[1].songs
    expect(veridis).toMatchObject({ ref: '2LD2gT7gwAurzdQDQtILds', title: 'Veridis Quo', album: 'Discovery', isrc: 'GBDUW0000060', durationSec: null })
    expect(paper.ref).toBe('7aQk2mN4pLs9XeR1bT6uVc')
    expect(slow.ref).toMatch(/^h[0-9a-z]+$/)
  })

  it("uses the service's own id column when the file has one", () => {
    const csv = [
      'Track name,Artist name,Album,Playlist name,Type,ISRC,Spotify - id,Apple Music - id',
      '"Slow Morning","The Fixture Band","Stand-in Songs","Rainy days","Playlist","","3hJk8LmN2pQr5StUvWxYz0","1712345678"',
    ].join('\n')
    expect(readUpload('tmm.csv', utf8(csv), 'apple')[0].songs[0].ref).toBe('1712345678')
    expect(readUpload('tmm.csv', utf8(csv), 'spotify')[0].songs[0].ref).toBe('3hJk8LmN2pQr5StUvWxYz0')
  })
})

describe('Apple Music Library.xml', () => {
  it('offers only the user-made playlists, plus the loved songs as Liked songs', async () => {
    const { playlists, payload = {} } = await list('Library.xml', fixture('Library.xml'), 'apple')
    // Library, Downloaded, Music, Purchased, Podcasts, the old "Recently Added" smart list
    // and the "Mixes" folder are left out; "Empty For Now" has no songs.
    expect(playlists.map((playlist) => [playlist.ref, playlist.name, playlist.kind, playlist.trackCount])).toEqual([
      ['liked', 'Loved songs', 'liked', 1],
      ['apple:7C1D2E3F4051627A', 'Sunday Morning', 'playlist', 3],
      ['apple:7C1D2E3F4051627B', 'Road Trip', 'playlist', 2],
      ['apple:7C1D2E3F4051627C', 'Only Daft Punk', 'playlist', 2],
    ])
    const sunday = await page(payload, playlists[1])
    expect(sunday.tracks).toEqual([
      { ref: '4F2A1C0D9E8B7A65', title: 'Slow Morning', artist: 'The Fixture Band', album: 'Stand-in Songs', durationSec: 240, isrc: null, coverUrl: null },
      { ref: '4F2A1C0D9E8B7A62', title: 'Something About Us', artist: 'Daft Punk', album: 'Discovery', durationSec: 232, isrc: null, coverUrl: null },
      { ref: '4F2A1C0D9E8B7A66', title: 'Café & Rain', artist: 'Ana <Fixture> Lima', album: 'Wet Streets', durationSec: 187, isrc: null, coverUrl: null },
    ])
    // The podcast episode in Road Trip is not a song.
    expect((await page(payload, playlists[2])).tracks.map((track) => track.title)).toEqual(['Harder, Better, Faster, Stronger', 'Paper Lanterns'])
  })

  it('uses Apple\'s "Favourite Songs" list as Liked songs when there is one', () => {
    const xml = new TextDecoder()
      .decode(fixture('Library.xml'))
      .replace('<key>Name</key><string>Downloaded</string>', '<key>Name</key><string>Favourite Songs</string>')
    const playlists = readUpload('Library.xml', utf8(xml), 'apple')
    expect(playlists.filter((playlist) => playlist.kind === 'liked').map((playlist) => [playlist.name, playlist.songs.length])).toEqual([
      ['Favourite Songs', 1],
    ])
    expect(playlists.map((playlist) => playlist.name)).not.toContain('Loved songs')
  })

  it('is recognised by its content whatever the file is called, also inside a zip', async () => {
    expect(readUpload('export.txt', fixture('Library.xml'), 'apple').map((playlist) => playlist.name)).toContain('Sunday Morning')
    const zipped = zipSync({ 'Library.xml': fixture('Library.xml') })
    expect((await list('Library.zip', zipped, 'apple')).playlists).toHaveLength(4)
  })

  it('says so plainly when there are no playlists of its own, or the XML is not a library', async () => {
    const onlySystem = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Tracks</key><dict><key>1</key><dict><key>Track ID</key><integer>1</integer><key>Name</key><string>Song</string></dict></dict>
<key>Playlists</key><array>
<dict><key>Name</key><string>Library</string><key>Master</key><true/><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1</integer></dict></array></dict>
</array></dict></plist>`
    expect(await userError(() => readUpload('Library.xml', utf8(onlySystem), 'apple'))).toBe(
      'That library has no playlists of your own yet. Make one in the Music app, then export again.',
    )
    const notLibrary = '<?xml version="1.0"?><plist version="1.0"><dict><key>Name</key><string>x</string></dict></plist>'
    expect(await userError(() => readUpload('Info.xml', utf8(notLibrary), 'apple'))).toContain("isn't a Music app library")
    expect(await userError(() => readUpload('Library.xml', utf8('<plist version="1.0"><dict><key>Tracks</key><dict>'), 'apple'))).toContain(
      "isn't a Music app library",
    )
  })
})

describe('anything else', () => {
  it('names the accepted files when it cannot read one', async () => {
    expect(UNKNOWN_FILE).toBe(
      "Tapedeck can't read that file. Upload an Exportify CSV or zip, a TuneMyMusic CSV, or a Library.xml from the Music app.",
    )
    expect(await userError(() => list('notes.txt', utf8('Buy milk\nCall mum\n')))).toBe(UNKNOWN_FILE)
    expect(await userError(() => list('page.html', utf8('<!doctype html><html><body>Hi</body></html>')))).toBe(UNKNOWN_FILE)
    expect(await userError(() => list('photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])))).toBe(UNKNOWN_FILE)
    expect(await userError(() => list('songs.csv', utf8('a,b,c\n1,2,3\n')))).toBe(UNKNOWN_FILE)
  })

  it('reports a zip with nothing readable, a damaged zip, and a zip that holds too much', async () => {
    expect(await userError(() => list('pics.zip', zipSync({ 'a.png': new Uint8Array([1, 2, 3]) })))).toContain('no files Tapedeck can read')
    const damaged = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9])
    expect(await userError(() => list('broken.zip', damaged))).toBe('That zip file looks damaged. Download it again and upload the new one.')
    const many: Record<string, Uint8Array> = {}
    for (let i = 0; i < 501; i++) many[`p${i}.csv`] = utf8('Track name,Artist name\nA,B\n')
    expect(await userError(() => list('many.zip', zipSync(many)))).toBe('That zip holds too much to read at once. Upload fewer playlists at a time.')
  })

  it('reads any CSV with title and artist columns, with ; or tab separators, UTF-16 and old Windows text', () => {
    const semicolon = 'Title;Artist;Album;Duration\n"Slow Morning";"The Fixture Band";"Stand-in Songs";"4:00"\n'
    expect(readUpload('rainy_days.csv', utf8(semicolon), 'spotify')[0]).toMatchObject({
      name: 'Rainy days',
      songs: [{ title: 'Slow Morning', artist: 'The Fixture Band', durationSec: 240 }],
    })
    const tabs = 'Song\tArtist\tLength\nCafé & Rain\tAna Lima\t187\n'
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...tabs].map((c) => c.charCodeAt(0))).buffer)])
    expect(readUpload('x.csv', utf16, 'spotify')[0].songs[0]).toMatchObject({ title: 'Café & Rain', durationSec: 187 })
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe('Café')
  })

  it('parses quoted fields with separators, quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ])
    expect(nameFromFile('folder/road_trip (1).csv')).toBe('Road trip (1)')
    expect(nameFromFile('Gym Mix.csv')).toBe('Gym Mix')
  })

  it('pages a long playlist and refuses a file with too many songs', async () => {
    const rows = Array.from({ length: 1_200 }, (_, i) => `"Song ${i}","Artist ${i % 7}"`)
    const { playlists, payload = {} } = await list('long.csv', utf8(['Title,Artist', ...rows].join('\n')))
    expect(playlists[0].trackCount).toBe(1_200)
    const first = await page(payload, playlists[0])
    expect(first.tracks).toHaveLength(FILE_PAGE_SIZE)
    expect(first.next).toBe(String(FILE_PAGE_SIZE))
    const last = await page(payload, playlists[0], '1000')
    expect(last.tracks.map((track) => track.title)).toEqual(Array.from({ length: 200 }, (_, i) => `Song ${1_000 + i}`))
    expect(last.next).toBeNull()

    const third = Math.ceil((MAX_FILE_SONGS + 1) / 3)
    const songs = (from: number) =>
      Array.from({ length: third }, (_, i) => ({
        ref: `s${from + i}`,
        title: `Song ${from + i}`,
        artist: 'A',
        album: null,
        durationSec: null,
        isrc: null,
        coverUrl: null,
      }))
    const big = [0, 1, 2].map((n) => ({ ref: `p${n}`, name: `Big ${n}`, kind: 'playlist' as const, songs: songs(n * third) }))
    expect(await userError(() => packUpload(big))).toBe(
      'That file has more than 20,000 songs. Export fewer playlists at a time.',
    )
  })

  it('asks for the file again when the kept copy is missing', async () => {
    const message = 'This upload has expired. Upload the file again.'
    expect(await userError(() => fileImporter.listPlaylists({ method: 'file', file: null }, ctx()))).toBe(message)
    expect(await userError(() => fileImporter.getTracks({ ref: 'liked', name: 'Liked songs' }, { ...ctx(), cursor: null }))).toBe(message)
  })
})

describe('the property list reader', () => {
  it('reads nested dicts and arrays, numbers, booleans and empty values', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "x" "y"><plist version="1.0"><dict>
      <!-- a comment --><key>a</key><array><integer>1</integer><real>2.5</real><true/><false/><string/><dict/></array>
      <key>__proto__</key><string>safe</string><key>b</key><dict><key>c</key><string>&#x1F3B5; &amp; more</string></dict>
    </dict></plist>`
    const value = parsePlist(xml) as Record<string, unknown>
    expect(value.a).toEqual([1, 2.5, true, false, '', {}])
    expect(value.b).toEqual({ c: '\u{1F3B5} & more' })
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(value['__proto__']).toBe('safe')
  })
})
