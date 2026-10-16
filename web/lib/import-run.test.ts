/**
 * The import flow (V2-PLAN T13) over real in-memory PGlite: listing, start,
 * the chunked import (50 songs per request, in playlist order), the "already
 * in your library" rules, re-import, the PC helpers, Skip and the live
 * progress. The stand-in importer (lib/importers/fake.ts) and the recorded
 * Deezer fixtures stand in for every outside service.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from './db'
import { fakeImporter } from './importers/fake'
import { PENDING, ImportUserError, type Importer, type ImportTrack } from './importers/types'
import {
  claimPcJobs,
  createJob,
  failPcJob,
  getJob,
  lockJob,
  releasePcJob,
  unlockJob,
  type ImportJob,
} from './import-jobs'
import { cleanPlaylists, cleanTrack, listInputFor, runChunk, runListing, skipItem, startImport, tapedeckPlaylistName } from './import-run'
import { jobView, loadProgress, recentJobSummaries } from './import-progress'

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await sql`truncate import_items, import_jobs, tracks, playlists, playlist_tracks, album_favorites, play_events`
})

async function listedFakeJob(links = ['https://example.com/test-music/me']): Promise<ImportJob> {
  const job = await createJob({ service: 'test', importer: 'fake', method: 'link', payload: { links } })
  return runListing(job, fakeImporter, { method: 'link', links })
}

/** Drives the chunks like the browser does; returns how many requests it took. */
async function importAll(jobId: string, importer: Importer = fakeImporter, chunkSize?: number): Promise<number> {
  for (let requests = 1; requests <= 100; requests++) {
    const outcome = await runChunk(jobId, importer, { chunkSize })
    if (!outcome) throw new Error('job vanished')
    if (outcome.done) return requests
  }
  throw new Error('the import never finished')
}

async function playlistSongs(playlistId: string): Promise<{ source: string; source_id: string; title: string }[]> {
  return (await sql`
    select t.source, t.source_id, t.title from playlist_tracks pt join tracks t on t.id = pt.track_id
    where pt.playlist_id = ${playlistId} order by pt.position`) as { source: string; source_id: string; title: string }[]
}

describe('listing', () => {
  it('lists the playlists, Liked songs first', async () => {
    const job = await listedFakeJob()
    expect(job.status).toBe('listed')
    const view = await jobView(job)
    expect(view.playlists?.map((p) => [p.ref, p.name, p.kind, p.trackCount, p.importedPlaylistId])).toEqual([
      ['liked', 'Liked songs', 'liked', 3, null],
      ['pl-road-trip', 'Road trip', 'playlist', 4, null],
      ['pl-chill', 'Chill', 'playlist', 1, null],
    ])
    expect(view.progress).toBeNull()
  })

  it('shows the adapter\'s own message when it fails', async () => {
    const job = await listedFakeJob(['https://example.com/broken'])
    expect(job).toMatchObject({ status: 'failed', error: "That link didn't work. Check it and try again." })
  })

  it('hides other errors behind a plain message', async () => {
    const crashing: Importer = { ...fakeImporter, listPlaylists: async () => Promise.reject(new Error('parser exploded')) }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const job = await runListing(await createJob({ service: 'test', importer: 'fake', method: 'link' }), crashing, { method: 'link', links: ['x'] })
    spy.mockRestore()
    expect(job).toMatchObject({ status: 'failed', error: "Couldn't read that. Check it and try again." })
  })

  it('fails with "No playlists found there." when the list is empty', async () => {
    const empty: Importer = { ...fakeImporter, listPlaylists: async () => ({ playlists: [] }) }
    const job = await runListing(await createJob({ service: 'test', importer: 'fake', method: 'link' }), empty, { method: 'link', links: ['x'] })
    expect(job).toMatchObject({ status: 'failed', error: 'No playlists found there.' })
  })

  it('cleans what an adapter returns', () => {
    expect(
      cleanPlaylists([
        { ref: 'a', name: '  Mix  ', coverUrl: 'javascript:alert(1)', trackCount: 4.4 },
        { ref: 'a', name: 'Duplicate ref' },
        { ref: '', name: 'No ref' },
        { ref: 'b', name: '', kind: 'liked' },
      ]),
    ).toEqual([
      { ref: 'a', name: 'Mix', coverUrl: null, trackCount: 4, kind: 'playlist' },
      { ref: 'b', name: 'Untitled playlist', coverUrl: null, trackCount: null, kind: 'liked' },
    ])
    expect(cleanTrack({ ref: '', title: '  ', artist: 'x' })).toBeNull()
    expect(cleanTrack({ ref: '', title: 'Song', artist: 'The Band', durationSec: -3, isrc: 'bad', link: 'ftp://x' })).toEqual({
      ref: 'the-band-song',
      title: 'Song',
      artist: 'The Band',
      album: null,
      durationSec: null,
      isrc: null,
      coverUrl: null,
      link: null,
    })
  })

  it('names Liked songs after the service', () => {
    expect(tapedeckPlaylistName({ name: 'Liked Songs', kind: 'liked' }, 'spotify')).toBe('Liked songs from Spotify')
    expect(tapedeckPlaylistName({ name: 'Road trip', kind: 'playlist' }, 'spotify')).toBe('Road trip')
  })
})

describe('importing', () => {
  it('turns two ticked playlists into Tapedeck playlists, matched to the catalog, in order', async () => {
    const job = await listedFakeJob()
    const started = await startImport(job.id, ['pl-road-trip', 'liked'])
    if ('error' in started) throw new Error(started.error)
    expect(started.job.status).toBe('importing')
    expect(started.job.selected.map((entry) => entry.name)).toEqual(['Liked songs from Test music service', 'Road trip'])

    await importAll(job.id)
    const done = await getJob(job.id)
    expect(done?.status).toBe('done')

    const [liked, road] = done!.selected
    expect(await playlistSongs(liked.playlistId!)).toEqual([
      { source: 'catalog', source_id: 'deezer:3135556', title: 'Harder, Better, Faster, Stronger' }, // ISRC
      { source: 'catalog', source_id: 'deezer:3135561', title: 'Something About Us' }, // search
      { source: 'catalog', source_id: 'import:test:fake-3', title: 'Paper Lanterns' }, // no match
    ])
    expect(await playlistSongs(road.playlistId!)).toEqual([
      { source: 'catalog', source_id: 'deezer:3135563', title: 'Veridis Quo' },
      { source: 'catalog', source_id: 'deezer:3135556', title: 'Harder, Better, Faster, Stronger' }, // same song, once in the library
      { source: 'catalog', source_id: 'import:test:fake-5', title: 'One More Time' }, // 600 s: too far from 320 s
      { source: 'soundcloud', source_id: 'fixture-sounds/night-drive', title: 'Night Drive' }, // keeps its link
    ])

    const tracks = await sql`select source, source_id, source_url, raw_title, title, artist, album, cover_url, duration_sec, isrc, status from tracks order by source_id`
    expect(tracks).toHaveLength(6)
    const byId = Object.fromEntries(tracks.map((t) => [t.source_id, t]))
    expect(byId['deezer:3135561']).toMatchObject({ source_url: '', album: 'Discovery', isrc: 'GBDUW0000064', status: 'waiting', duration_sec: 232 })
    expect(String(byId['deezer:3135561'].cover_url)).toMatch(/600x600/)
    expect(byId['import:test:fake-3']).toMatchObject({ title: 'Paper Lanterns', artist: 'The Fixture Band', album: 'Stand-in Songs', cover_url: null, isrc: null })
    expect(byId['fixture-sounds/night-drive']).toMatchObject({
      source_url: 'https://soundcloud.com/fixture-sounds/night-drive',
      raw_title: 'Night Drive (Official Audio)',
      title: 'Night Drive',
      artist: 'fixture-sounds',
      cover_url: null,
    })

    const items = await sql`select status, match from import_items where job_id = ${job.id} order by created_at, position`
    expect(items.map((i) => `${i.status}/${i.match}`)).toEqual([
      'added/isrc',
      'added/search',
      'added/none',
      'added/search',
      'already/isrc',
      'added/none',
      'added/link',
    ])

    const progress = await loadProgress(job.id)
    expect(progress).toMatchObject({ total: 6, ready: 0, waiting: 6, needsLook: 0, pending: 0, skipped: 0 })
  })

  it('reuses songs already in the library (same ISRC, same catalog id, same title and artist)', async () => {
    const [byIsrc] = await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, artist, isrc, status)
      values ('youtube', 'abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk', 'x', 'HBFS', 'Daft Punk', 'GBDUW0000059', 'ready')
      returning id`
    const [byTitle] = await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, artist)
      values ('youtube', 'lmnopqrstuv', 'https://www.youtube.com/watch?v=lmnopqrstuv', 'x', 'Paper Lanterns (Live)', 'The Fixture Band')
      returning id`
    const job = await listedFakeJob()
    await startImport(job.id, ['liked'])
    await importAll(job.id)
    const items = await sql`select title, status, track_id from import_items where job_id = ${job.id} order by position`
    expect(items.map((i) => [i.title, i.status])).toEqual([
      ['Harder, Better, Faster, Stronger', 'already'],
      ['Something About Us', 'added'],
      ['Paper Lanterns', 'already'],
    ])
    expect(String(items[0].track_id)).toBe(String(byIsrc.id))
    expect(String(items[2].track_id)).toBe(String(byTitle.id))
    const progress = await loadProgress(job.id)
    expect(progress).toMatchObject({ total: 3, ready: 1, waiting: 2 })
  })

  it('writes 50 songs per request and keeps the playlist order across requests', async () => {
    const songs: ImportTrack[] = Array.from({ length: 120 }, (_, n) => ({
      ref: `big-${n}`,
      title: `Stand-in Song ${n}`,
      artist: 'Bulk Band',
      durationSec: 100 + n,
    }))
    const big: Importer = {
      ...fakeImporter,
      listPlaylists: async () => ({ playlists: [{ ref: 'big', name: 'Big list', trackCount: 120 }] }),
      getTracks: async (_playlist, ctx) => {
        const start = Number(ctx.cursor ?? 0)
        return { tracks: songs.slice(start, start + 40), next: start + 40 < songs.length ? String(start + 40) : null }
      },
    }
    const job = await runListing(await createJob({ service: 'test', importer: 'fake', method: 'link' }), big, { method: 'link', links: ['x'] })
    await startImport(job.id, ['big'])

    const first = await runChunk(job.id, big)
    expect(first?.done).toBe(false)
    expect((await getJob(job.id))?.selected[0]).toMatchObject({ fetched: true, count: 120, cursor: null })
    expect(await loadProgress(job.id)).toMatchObject({ total: 120, pending: 70 })

    expect((await runChunk(job.id, big))?.done).toBe(false)
    expect(await loadProgress(job.id)).toMatchObject({ pending: 20 })
    expect((await runChunk(job.id, big))?.done).toBe(true)
    expect(await loadProgress(job.id)).toMatchObject({ total: 120, pending: 0, waiting: 120 })

    const order = await playlistSongs((await getJob(job.id))!.selected[0].playlistId!)
    expect(order.map((song) => song.title)).toEqual(songs.map((song) => song.title))
    expect(order[0].source_id).toBe('import:test:big-0')
  })

  it('leaves songs it had no time for to the next request, in order', async () => {
    const job = await listedFakeJob()
    await startImport(job.id, ['pl-road-trip'])
    let clock = 0
    // Every clock reading moves 3 s on: reading the songs and a few matches fill the 8 s budget.
    const outcome = await runChunk(job.id, fakeImporter, { concurrency: 1, now: () => (clock += 3_000) })
    expect(outcome?.done).toBe(false)
    const progress = await loadProgress(job.id)
    expect(progress.pending).toBeGreaterThan(0)
    expect(progress.pending).toBeLessThan(4)
    await importAll(job.id)
    const order = await playlistSongs((await getJob(job.id))!.selected[0].playlistId!)
    expect(order.map((song) => song.title)).toEqual(['Veridis Quo', 'Harder, Better, Faster, Stronger', 'One More Time', 'Night Drive'])
  })

  it('answers busy while another request holds the job', async () => {
    const job = await listedFakeJob()
    await startImport(job.id, ['liked'])
    expect(await lockJob(job.id, 60)).toBe(true)
    expect(await runChunk(job.id, fakeImporter)).toMatchObject({ done: false, busy: true })
    await unlockJob(job.id)
    expect((await runChunk(job.id, fakeImporter))?.busy).toBeUndefined()
  })

  it('refuses a second start and unknown playlists', async () => {
    const job = await listedFakeJob()
    expect(await startImport(job.id, [])).toMatchObject({ status: 400 })
    expect(await startImport(job.id, ['nope'])).toMatchObject({ status: 400 })
    expect('job' in (await startImport(job.id, ['liked']))).toBe(true)
    expect(await startImport(job.id, ['liked'])).toMatchObject({ status: 409 })
    expect(await sql`select name from playlists`).toHaveLength(1)
  })

  it('keeps going when one playlist cannot be read', async () => {
    const half: Importer = {
      ...fakeImporter,
      getTracks: async (playlist, ctx) => {
        if (playlist.ref === 'liked') throw new ImportUserError('That playlist is private now.')
        return fakeImporter.getTracks(playlist, ctx)
      },
    }
    const job = await listedFakeJob()
    await startImport(job.id, ['liked', 'pl-chill'])
    await importAll(job.id, half)
    const view = await jobView((await getJob(job.id))!)
    expect(view.status).toBe('done')
    expect(view.selected.map((entry) => [entry.name, entry.error ?? ''])).toEqual([
      ['Liked songs from Test music service', 'That playlist is private now.'],
      ['Chill', ''],
    ])
    expect(view.progress?.total).toBe(1)
  })
})

describe('re-importing', () => {
  it('marks imported playlists and adds to the same Tapedeck playlist', async () => {
    const first = await listedFakeJob()
    await startImport(first.id, ['liked', 'pl-road-trip'])
    await importAll(first.id)
    const [liked, road] = (await getJob(first.id))!.selected

    const second = await listedFakeJob()
    const view = await jobView(second)
    expect(view.playlists?.map((p) => [p.ref, p.importedPlaylistId])).toEqual([
      ['liked', liked.playlistId],
      ['pl-road-trip', road.playlistId],
      ['pl-chill', null],
    ])

    const restarted = await startImport(second.id, ['liked', 'pl-chill'])
    if ('error' in restarted) throw new Error(restarted.error)
    expect(restarted.job.selected[0].playlistId).toBe(liked.playlistId)
    await importAll(second.id)
    expect(await sql`select id from playlists`).toHaveLength(3)
    expect(await playlistSongs(liked.playlistId!)).toHaveLength(3)
    expect(await sql`select id from tracks`).toHaveLength(7)
    const items = await sql`select status from import_items where job_id = ${second.id} and playlist_ref = 'liked'`
    expect(items.map((i) => i.status)).toEqual(['already', 'already', 'already'])
  })

  it('does not mark a playlist whose Tapedeck playlist was deleted', async () => {
    const first = await listedFakeJob()
    await startImport(first.id, ['pl-chill'])
    await importAll(first.id)
    await sql`delete from playlists`
    const view = await jobView(await listedFakeJob())
    expect(view.playlists?.find((p) => p.ref === 'pl-chill')?.importedPlaylistId).toBeNull()
  })
})

describe('waiting for the PC', () => {
  it('lists after the PC claims the job and hands the result back', async () => {
    const job = await listedFakeJob(['https://example.com/waiting-for-pc'])
    expect(job.status).toBe('waiting_pc')
    expect(await claimPcJobs('other-importer')).toEqual([])
    const [claimed] = await claimPcJobs('fake')
    expect(claimed).toMatchObject({ id: job.id, attempts: 1 })
    expect(claimed.claimedAt).not.toBeNull()
    expect(await claimPcJobs('fake')).toEqual([]) // claimed, not stale yet

    expect(await releasePcJob(job.id, { pcListed: true })).toBe(true)
    const back = await getJob(job.id)
    expect(back).toMatchObject({ status: 'new', attempts: 0, claimedAt: null, payload: { links: ['https://example.com/waiting-for-pc'], pcListed: true } })
    const listed = await runListing(back!, fakeImporter, listInputFor(back!))
    expect(listed.status).toBe('listed')
    expect(await releasePcJob(job.id, {})).toBe(false)
  })

  it('takes a stale claim again and fails after the third attempt', async () => {
    const job = await listedFakeJob(['https://example.com/waiting-for-pc'])
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sql`update import_jobs set claimed_at = now() - interval '20 minutes' where id = ${job.id}`
      const [claimed] = await claimPcJobs('fake')
      expect(claimed.attempts).toBe(attempt)
      expect(await failPcJob(job.id, 'yt-dlp could not open that profile')).toBe(attempt < 3 ? 'waiting_pc' : 'failed')
    }
    expect(await getJob(job.id)).toMatchObject({ status: 'failed', error: 'yt-dlp could not open that profile' })
  })

  it('pauses the import while the PC reads a playlist', async () => {
    const pcSongs: Importer = {
      ...fakeImporter,
      getTracks: async (playlist, ctx) =>
        ctx.job.payload.pcSongs === true ? fakeImporter.getTracks(playlist, ctx) : PENDING,
    }
    const job = await listedFakeJob()
    await startImport(job.id, ['pl-chill'])
    expect(await runChunk(job.id, pcSongs)).toMatchObject({ done: false, job: { status: 'waiting_pc' } })
    expect(await runChunk(job.id, pcSongs)).toMatchObject({ done: false }) // still waiting
    expect((await jobView((await getJob(job.id))!)).progress).toMatchObject({ total: 0 })
    await claimPcJobs('fake')
    expect(await releasePcJob(job.id, { pcSongs: true })).toBe(true)
    expect((await getJob(job.id))?.status).toBe('importing')
    await importAll(job.id, pcSongs)
    expect(await loadProgress(job.id)).toMatchObject({ total: 1 })
  })
})

describe('needs a look, and Skip', () => {
  async function importedLiked(): Promise<{ job: ImportJob; trackIds: Record<string, string> }> {
    const job = await listedFakeJob()
    await startImport(job.id, ['liked', 'pl-road-trip'])
    await importAll(job.id)
    const rows = await sql`select id, source_id from tracks`
    return { job: (await getJob(job.id))!, trackIds: Object.fromEntries(rows.map((r) => [String(r.source_id), String(r.id)])) }
  }

  it('counts ready, waiting and failed songs live', async () => {
    const { job, trackIds } = await importedLiked()
    await sql`update tracks set status = 'ready' where id = ${trackIds['deezer:3135556']}`
    await sql`update tracks set status = 'failed', error = 'Couldn''t find a matching version' where id = ${trackIds['import:test:fake-3']}`
    const progress = await loadProgress(job.id)
    expect(progress).toMatchObject({ total: 6, ready: 1, waiting: 4, needsLook: 1 })
    expect(progress.needsLookSongs).toEqual([
      expect.objectContaining({
        trackId: trackIds['import:test:fake-3'],
        title: 'Paper Lanterns',
        source: 'catalog',
        error: "Couldn't find a matching version",
      }),
    ])
    const [summary] = await recentJobSummaries()
    expect(summary).toMatchObject({ id: job.id, status: 'done', progress: { total: 6, ready: 1, waiting: 4, needsLook: 1 } })
    expect(summary.playlistNames).toEqual(['Liked songs from Test music service', 'Road trip'])
  })

  it('stops counting a song deleted from the library since', async () => {
    const { job, trackIds } = await importedLiked()
    await sql`delete from tracks where id = ${trackIds['deezer:3135561']}`
    expect(await loadProgress(job.id)).toMatchObject({ total: 5, waiting: 5 })
  })

  it('Skip removes a song this import added from its playlists and the library', async () => {
    const { job, trackIds } = await importedLiked()
    const failedId = trackIds['import:test:fake-3']
    await sql`update tracks set status = 'failed' where id = ${failedId}`
    const { needsLookSongs } = await loadProgress(job.id)
    expect(await skipItem(job.id, needsLookSongs[0].itemId)).toBe('ok')
    expect(await sql`select id from tracks where id = ${failedId}`).toHaveLength(0)
    expect(await loadProgress(job.id)).toMatchObject({ total: 5, needsLook: 0, skipped: 1 })
    expect(await playlistSongs(job.selected[0].playlistId!)).toHaveLength(2)
  })

  it('Skip keeps a song that was in the library before the import', async () => {
    const { job, trackIds } = await importedLiked()
    // "Harder" was added by Liked songs and is "already" in Road trip; make the second import own nothing.
    const second = await listedFakeJob()
    await startImport(second.id, ['pl-road-trip'])
    await importAll(second.id)
    const harder = trackIds['deezer:3135556']
    await sql`update tracks set status = 'failed' where id = ${harder}`
    const [item] = await sql`select id from import_items where job_id = ${second.id} and track_id = ${harder}`
    expect(await skipItem(second.id, String(item.id))).toBe('ok')
    expect(await sql`select id from tracks where id = ${harder}`).toHaveLength(1)
    // Gone from the re-imported Road trip, still in Liked songs.
    expect((await playlistSongs(job.selected[1].playlistId!)).map((s) => s.source_id)).not.toContain('deezer:3135556')
    expect((await playlistSongs(job.selected[0].playlistId!)).map((s) => s.source_id)).toContain('deezer:3135556')
  })

  it('Skip answers not-found for an item of another import', async () => {
    const { job } = await importedLiked()
    const other = await createJob({ service: 'test', importer: 'fake', method: 'link' })
    const [item] = await sql`select id from import_items where job_id = ${job.id} limit 1`
    expect(await skipItem(other.id, String(item.id))).toBe('not-found')
  })
})
