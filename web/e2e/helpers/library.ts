import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import { TEST_AGENT_TOKEN, WEB_ROOT } from './env';

/*
 * T2 test data (SPEC 9 T2: "seeded ready tracks with made-up titles").
 * Songs are inserted through the test-only /api/test/seed route (the app's
 * in-memory database lives in the server process), then made ready through
 * the real downloader API: upload-url, PUT a test tone, complete. That is
 * the same path --selftest takes, without its claim step, so it can not
 * race other waiting songs in the shared library (see the T3 spec notes).
 *
 * Every helper takes the logged-in page's request context (page.request),
 * which carries the session cookie.
 */

const TONE = readFileSync(path.join(WEB_ROOT, 'public', 'test-audio', 'test1.m4a'));
/** The test tone is 3 minutes long (SPEC T0 step 8). */
export const TONE_SECONDS = 180;

export type SeedInput = {
  title: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
};

export type Seeded = { id: string; title: string };

const agentHeaders = { Authorization: `Bearer ${TEST_AGENT_TOKEN}` };

/** Unique made-up names so parallel projects and reruns never collide. */
export function uniqueTag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function seedReadyTracks(request: APIRequestContext, tracks: SeedInput[]): Promise<Seeded[]> {
  const seeded = await request.post('/api/test/seed', { data: { tracks } });
  expect(seeded.status(), 'the test seed route is on (TAPEDECK_TEST=1)').toBe(201);
  const created = ((await seeded.json()) as { tracks: Seeded[] }).tracks;
  for (const track of created) {
    const upload = await request.post('/api/agent/upload-url', { headers: agentHeaders, data: { trackId: track.id } });
    expect(upload.status()).toBe(200);
    const { url, key } = (await upload.json()) as { url: string; key: string };
    const put = await request.put(url, { data: TONE, headers: { 'Content-Type': 'audio/mp4' } });
    expect(put.ok(), `PUT the test tone for ${track.title}`).toBeTruthy();
    const complete = await request.post('/api/agent/complete', {
      headers: agentHeaders,
      data: { trackId: track.id, key, bytes: TONE.length, durationSec: TONE_SECONDS },
    });
    expect(complete.status()).toBe(200);
  }
  return created;
}

export type Counts = {
  tracks: number;
  storageBytes: number;
  playEvents: number;
  secondsListened: number;
  playsThisMonth: number;
  playEventsForTrack: number;
};

export async function dbCounts(request: APIRequestContext, trackId?: string): Promise<Counts> {
  const response = await request.get(`/api/test/seed${trackId ? `?trackId=${trackId}` : ''}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Counts;
}

type Snapshot = {
  tracks: { id: string; album: string | null; albumArtist: string | null; artist: string }[];
  playlists: { id: string; name: string }[];
  favoriteAlbums: { album: string; albumArtist: string }[];
};

export async function librarySnapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get('/api/library');
  expect(response.status()).toBe(200);
  return (await response.json()) as Snapshot;
}

/**
 * Remove what a test made: its songs (file and row), the given playlists,
 * and any favourite albums left behind. All three Playwright projects share
 * one in-memory database and the iphone T1 check expects an empty library.
 */
export async function cleanup(
  request: APIRequestContext,
  made: { trackIds?: string[]; playlistIds?: string[] },
): Promise<void> {
  for (const id of made.playlistIds ?? []) {
    await request.delete(`/api/playlists/${id}`);
  }
  const snapshot = await librarySnapshot(request);
  for (const fav of snapshot.favoriteAlbums) {
    await request.put('/api/albums/favorite', { data: { ...fav, favorite: false } });
  }
  for (const id of made.trackIds ?? []) {
    await request.delete(`/api/tracks/${id}`);
  }
}
