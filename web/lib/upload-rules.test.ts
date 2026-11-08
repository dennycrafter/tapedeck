import { describe, expect, it } from 'vitest'
import {
  fileExtension,
  isFingerprint,
  MAX_UPLOAD_BYTES,
  titleFromFileName,
  UPLOAD_ACCEPT,
  uploadAudioKey,
  uploadCoverPath,
  uploadExt,
  uploadProblem,
} from './upload-rules'

describe('upload rules (T15)', () => {
  it('accepts the four song formats in any letter case', () => {
    expect(uploadExt('a.mp3')).toBe('mp3')
    expect(uploadExt('B.M4A')).toBe('m4a')
    expect(uploadExt('c.Wav')).toBe('wav')
    expect(uploadExt('d.flac')).toBe('flac')
    expect(uploadExt('e.ogg')).toBeNull()
    expect(uploadExt('mp3')).toBeNull()
    expect(fileExtension('song.final.MP3')).toBe('mp3')
  })

  it('explains what is wrong with a file in plain words', () => {
    expect(uploadProblem({ name: 'photo.jpg', size: 10 })).toBe('Not a song file. Upload MP3, M4A, WAV or FLAC.')
    expect(uploadProblem({ name: 'mix.wav', size: MAX_UPLOAD_BYTES + 1 })).toBe('Too big. Songs can be up to 200 MB.')
    expect(uploadProblem({ name: 'empty.mp3', size: 0 })).toBe('This file is empty.')
    expect(uploadProblem({ name: 'ok.mp3', size: MAX_UPLOAD_BYTES })).toBeNull()
  })

  it('names an untagged song after its file', () => {
    expect(titleFromFileName('03 My Song.mp3')).toBe('03 My Song')
    expect(titleFromFileName('  Live at Home.FLAC ')).toBe('Live at Home')
    expect(titleFromFileName('.mp3')).toBe('Untitled')
  })

  it('stores songs next to the downloader files and serves covers from the app', () => {
    expect(uploadAudioKey('abc', 'flac')).toBe('tracks/abc.flac')
    expect(uploadCoverPath('abc')).toBe('/covers/abc')
  })

  it('the file picker offers the extensions and audio types', () => {
    for (const part of ['.mp3', '.m4a', '.wav', '.flac', 'audio/mpeg']) expect(UPLOAD_ACCEPT.split(',')).toContain(part)
  })

  it('fingerprints are lowercase SHA-256 hex', () => {
    expect(isFingerprint('f'.repeat(64))).toBe(true)
    expect(isFingerprint('F'.repeat(64))).toBe(false)
    expect(isFingerprint('f'.repeat(63))).toBe(false)
  })
})
