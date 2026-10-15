import { describe, expect, it } from 'vitest'
import { normalizeLibrary } from '../app/lib/library-view'
import type { LibraryResponse } from '../app/lib/api'
import { TRACK_V2_DEFAULTS, v2FieldsFromRow, withV2Defaults } from './track-v2'

// V2-PLAN T9: the v2 song fields and their defaults.

describe('v2FieldsFromRow', () => {
  it('maps the columns to camelCase and reads numeric strings', () => {
    expect(
      v2FieldsFromRow({
        isrc: 'GBDUW0000059',
        resolved_url: 'https://music.youtube.com/watch?v=abc',
        match_info: '{"score":0.9}',
        auto_trim_start_sec: '1.2',
        auto_trim_end_sec: 220.5,
        trim_start_sec: null,
        trim_end_sec: '200',
        playback_rate: '1.25',
        preserve_pitch: false,
      }),
    ).toEqual({
      isrc: 'GBDUW0000059',
      resolvedUrl: 'https://music.youtube.com/watch?v=abc',
      matchInfo: { score: 0.9 },
      autoTrimStartSec: 1.2,
      autoTrimEndSec: 220.5,
      trimStartSec: null,
      trimEndSec: 200,
      playbackRate: 1.25,
      preservePitch: false,
    })
  })

  it('gives the defaults for a row without the columns', () => {
    expect(v2FieldsFromRow({})).toEqual(TRACK_V2_DEFAULTS)
  })
})

describe('withV2Defaults', () => {
  it('keeps values that are there, including 0 and false', () => {
    const track = withV2Defaults({ id: 'a', trimStartSec: 0, preservePitch: false, playbackRate: 0.85 })
    expect(track).toMatchObject({ id: 'a', trimStartSec: 0, preservePitch: false, playbackRate: 0.85, isrc: null })
  })
})

describe('an offline snapshot saved before v2', () => {
  it('still loads, with the defaults filled in', () => {
    const old = {
      tracks: [
        {
          id: 't1',
          source: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=abc',
          title: 'Song',
          artist: 'Artist',
          album: null,
          coverUrl: null,
          durationSec: 180,
          status: 'ready',
          error: '',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      downloader: { lastSeenAt: null, waitingCount: 0 },
    } as LibraryResponse
    const library = normalizeLibrary(old)
    expect(library.tracks[0]).toMatchObject({ id: 't1', title: 'Song', ...TRACK_V2_DEFAULTS })
  })
})
