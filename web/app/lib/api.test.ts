/**
 * Client wrappers for the library routes (SPEC 8.6), bottom of api.ts:
 * each one hits the right URL with the right method and JSON body, and an
 * error body `{ error }` becomes an ApiError carrying that message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  addToPlaylist,
  createPlaylist,
  deletePlaylist,
  deleteTrack,
  fetchProfile,
  removeFromPlaylist,
  renamePlaylist,
  reorderPlaylist,
  setAlbumFavorite,
  setDisplayName,
  setTrackLiked,
} from './api'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function reply(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
}

function lastCall(): { url: string; method: string | undefined; body: unknown; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return {
    url: String(url),
    method: init?.method,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    headers: (init?.headers ?? {}) as Record<string, string>,
  }
}

const TRACK = '11111111-1111-4111-8111-111111111111'
const PLAYLIST = '22222222-2222-4222-8222-222222222222'

interface Case {
  name: string
  call: () => Promise<unknown>
  url: string
  method: string | undefined
  body: unknown
  response: unknown
  result: unknown
}

const CASES: Case[] = [
  {
    name: 'setTrackLiked',
    call: () => setTrackLiked(TRACK, true),
    url: `/api/tracks/${TRACK}/like`,
    method: 'PUT',
    body: { liked: true },
    response: { id: TRACK, liked: true },
    result: { id: TRACK, liked: true },
  },
  {
    name: 'deleteTrack',
    call: () => deleteTrack(TRACK),
    url: `/api/tracks/${TRACK}`,
    method: 'DELETE',
    body: undefined,
    response: { ok: true },
    result: undefined,
  },
  {
    name: 'createPlaylist',
    call: () => createPlaylist('Road trip'),
    url: '/api/playlists',
    method: 'POST',
    body: { name: 'Road trip' },
    response: { id: PLAYLIST, name: 'Road trip', trackIds: [] },
    result: { id: PLAYLIST, name: 'Road trip', trackIds: [] },
  },
  {
    name: 'renamePlaylist',
    call: () => renamePlaylist(PLAYLIST, 'New name'),
    url: `/api/playlists/${PLAYLIST}`,
    method: 'PATCH',
    body: { name: 'New name' },
    response: { ok: true },
    result: undefined,
  },
  {
    name: 'deletePlaylist',
    call: () => deletePlaylist(PLAYLIST),
    url: `/api/playlists/${PLAYLIST}`,
    method: 'DELETE',
    body: undefined,
    response: { ok: true },
    result: undefined,
  },
  {
    name: 'addToPlaylist',
    call: () => addToPlaylist(PLAYLIST, [TRACK]),
    url: `/api/playlists/${PLAYLIST}/tracks`,
    method: 'POST',
    body: { trackIds: [TRACK] },
    response: { added: 1 },
    result: { added: 1 },
  },
  {
    name: 'reorderPlaylist',
    call: () => reorderPlaylist(PLAYLIST, [TRACK]),
    url: `/api/playlists/${PLAYLIST}/tracks`,
    method: 'PUT',
    body: { trackIds: [TRACK] },
    response: { ok: true },
    result: undefined,
  },
  {
    name: 'removeFromPlaylist',
    call: () => removeFromPlaylist(PLAYLIST, TRACK),
    url: `/api/playlists/${PLAYLIST}/tracks/${TRACK}`,
    method: 'DELETE',
    body: undefined,
    response: { ok: true },
    result: undefined,
  },
  {
    name: 'setAlbumFavorite',
    call: () => setAlbumFavorite('Discovery', 'Daft Punk', false),
    url: '/api/albums/favorite',
    method: 'PUT',
    body: { album: 'Discovery', albumArtist: 'Daft Punk', favorite: false },
    response: { ok: true },
    result: undefined,
  },
  {
    name: 'fetchProfile',
    call: () => fetchProfile(),
    url: '/api/profile',
    method: undefined,
    body: undefined,
    response: { displayName: 'Denis', stats: {}, topArtists: [] },
    result: { displayName: 'Denis', stats: {}, topArtists: [] },
  },
  {
    name: 'setDisplayName',
    call: () => setDisplayName('Dee'),
    url: '/api/profile',
    method: 'PATCH',
    body: { displayName: 'Dee' },
    response: { displayName: 'Dee' },
    result: { displayName: 'Dee' },
  },
]

describe('library client functions', () => {
  it.each(CASES)('$name sends the right request and returns the body', async (c) => {
    reply(200, c.response)
    const result = await c.call()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = lastCall()
    expect(call.url).toBe(c.url)
    expect(call.method).toBe(c.method)
    expect(call.body).toEqual(c.body)
    expect(call.headers['Content-Type']).toBe('application/json')
    expect(result).toEqual(c.result)
  })

  it.each(CASES)('$name turns an { error } body into an ApiError with that message', async (c) => {
    reply(409, { error: 'The playlist changed. Reload and try again.' })
    const error = await c.call().then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).message).toBe('The playlist changed. Reload and try again.')
  })

  it('falls back to a generic message when the error body has no error text', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }))
    await expect(setTrackLiked(TRACK, false)).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: `PUT /api/tracks/${TRACK}/like failed (500)`,
    })
  })

  it('encodes ids into the URL path', async () => {
    reply(200, { ok: true })
    await removeFromPlaylist('a/b', 'c d')
    expect(lastCall().url).toBe('/api/playlists/a%2Fb/tracks/c%20d')
  })
})
