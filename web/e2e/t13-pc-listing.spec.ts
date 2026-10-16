import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { TEST_AGENT_TOKEN } from './helpers/env';
import profileResult from './fixtures/import-pc-listing/soundcloud-profile.json';

/*
 * T13 PC listing checks @T13 (V2-PLAN T13, adapter 4): SoundCloud and YouTube
 * links are read by the PC. The test plays the PC through the real agent
 * endpoints (POST /api/agent/import/claim and /complete with the test agent
 * token), the same way other specs finish songs through the agent API. The
 * PC's answer is e2e/fixtures/import-pc-listing/soundcloud-profile.json, the
 * real output of agent/import_listing.py for recorded yt-dlp listings (a
 * pytest keeps the two in step). yt-dlp never runs here.
 *
 * Everything the import made is deleted in afterEach: the three projects
 * share one in-memory database.
 */

const agentHeaders = { Authorization: `Bearer ${TEST_AGENT_TOKEN}` };
const PROFILE = 'https://soundcloud.com/the-concept-band';
const PLAYLIST_NAMES = ['Liked songs from SoundCloud', 'Royal EP', 'The Royal Concept EP'];
const SONG_LINKS = new Set(profileResult.playlists.flatMap((playlist) => playlist.tracks.map((track) => track.link)));

type Library = {
  tracks: { id: string; source: string; sourceUrl: string; status: string }[];
  playlists: { id: string; name: string; trackIds: string[] }[];
};

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.status()).toBe(200);
  return (await response.json()) as Library;
}

async function cleanup(request: APIRequestContext): Promise<void> {
  const snapshot = await library(request);
  for (const playlist of snapshot.playlists.filter((p) => PLAYLIST_NAMES.includes(p.name))) {
    await request.delete(`/api/playlists/${playlist.id}`);
  }
  for (const track of snapshot.tracks.filter((t) => SONG_LINKS.has(t.sourceUrl))) {
    await request.delete(`/api/tracks/${track.id}`);
  }
}

/** The PC's poll: claims listing jobs until this one comes up (a job left by an earlier failed run is answered too). */
async function pcClaims(request: APIRequestContext, jobId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request.post('/api/agent/import/claim', {
      headers: agentHeaders,
      data: { capabilities: ['catalog', 'import-listing'] },
    });
    expect(response.status()).toBe(200);
    const { jobs } = (await response.json()) as { jobs: { id: string; service: string; targets: { kind: string; url: string }[] }[] };
    const mine = jobs.find((job) => job.id === jobId);
    if (mine) return mine;
    for (const other of jobs) {
      await request.post('/api/agent/import/complete', { headers: agentHeaders, data: { jobId: other.id, playlists: [] } });
    }
  }
  throw new Error(`the PC never got job ${jobId}`);
}

async function pcAnswers(request: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const response = await request.post('/api/agent/import/complete', { headers: agentHeaders, data: body });
  expect(response.status(), await response.text()).toBe(200);
}

async function openService(page: Page, service: string, label: string): Promise<void> {
  await page.goto('/');
  await page.locator('[data-testid="add-open"]:visible').first().click();
  await page.getByTestId('add-tab-import').click();
  await page.locator(`[data-testid="import-service"][data-service="${service}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/import\\?service=${service}$`));
  await expect(page.getByTestId('import-title')).toHaveText(`Import from ${label}`);
}

async function pasteLinks(page: Page, links: string): Promise<string> {
  await page.getByTestId('import-links').fill(links);
  await page.getByTestId('import-find').click();
  await expect(page).toHaveURL(/\/import\?job=/);
  return new URL(page.url()).searchParams.get('job') ?? '';
}

function playlistRow(page: Page, ref: string) {
  return page.locator(`[data-testid="import-playlist"][data-ref="${ref}"]`);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request);
});

test.describe('T13 PC listing @T13', () => {
  test('a SoundCloud profile waits for the PC, then imports with the songs keeping their links', async ({ page }) => {
    test.setTimeout(120_000);
    await openService(page, 'soundcloud', 'SoundCloud');
    // Only "Paste a link", and it says the PC must be on.
    await expect(page.getByTestId('import-slot-link')).toContainText('keep it on with the downloader running');
    await expect(page.getByTestId('import-slot-login')).toHaveCount(0);

    const jobId = await pasteLinks(page, PROFILE);
    await expect(page.getByTestId('import-finding')).toContainText('Waiting for your PC');

    // The PC claims the job: one clean target for the profile.
    const job = await pcClaims(page.request, jobId);
    expect(job).toMatchObject({ service: 'soundcloud', targets: [{ kind: 'soundcloud-profile', url: PROFILE }] });
    await expect(page.getByTestId('import-finding')).toContainText('Waiting for your PC');

    // It answers; the page moves on to the checklist by itself.
    await pcAnswers(page.request, { jobId, ...profileResult });
    await expect(page.getByTestId('import-checklist')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('import-playlist-name')).toHaveText(['Likes', 'Royal EP', 'The Royal Concept EP']);
    await expect(playlistRow(page, 'likes:9615865').getByTestId('import-playlist-facts')).toHaveText('1 song');
    await expect(playlistRow(page, '2284613').getByTestId('import-playlist-facts')).toHaveText('3 songs');
    await expect(page.getByTestId('import-start')).toHaveText('Import 3 playlists');

    await page.getByTestId('import-start').click();
    const progress = page.getByTestId('import-progress');
    await expect(progress).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    // World On Fire is in both sets: one library song.
    await expect(page.getByTestId('import-progress-text')).toHaveText('0 of 5 ready, 5 waiting');
    await expect(page.getByTestId('import-progress-playlist')).toHaveText(PLAYLIST_NAMES);

    const snapshot = await library(page.request);
    const imported = snapshot.tracks.filter((t) => SONG_LINKS.has(t.sourceUrl));
    expect(imported).toHaveLength(5);
    for (const track of imported) expect(track).toMatchObject({ source: 'soundcloud', status: 'waiting' });
    const royalEp = snapshot.playlists.find((p) => p.name === 'Royal EP');
    expect(royalEp?.trackIds.map((id) => snapshot.tracks.find((t) => t.id === id)?.sourceUrl)).toEqual([
      'https://soundcloud.com/the-concept-band/world-on-fire-1',
      'https://soundcloud.com/the-concept-band/shut-the-world',
    ]);
  });

  test('a link that cannot work says so at once, and the PC\'s own problem shows plainly', async ({ page }) => {
    await openService(page, 'soundcloud', 'SoundCloud');
    await page.getByTestId('import-links').fill('https://soundcloud.com/the-concept-band/world-on-fire-1');
    await page.getByTestId('import-find').click();
    await expect(page.getByTestId('import-error')).toContainText('is one song, not a playlist');

    // YouTube: the PC could not open the playlist.
    await openService(page, 'youtube', 'YouTube');
    const jobId = await pasteLinks(page, 'https://www.youtube.com/playlist?list=PLnotreal');
    await expect(page.getByTestId('import-finding')).toContainText('Waiting for your PC');
    const job = await pcClaims(page.request, jobId);
    expect(job.targets).toEqual([expect.objectContaining({ kind: 'youtube-playlist', url: 'https://www.youtube.com/playlist?list=PLnotreal' })]);
    const problem = "Couldn't open https://www.youtube.com/playlist?list=PLnotreal. Check that it exists and is public.";
    await pcAnswers(page.request, { jobId, playlists: [], problems: [problem] });
    await expect(page.getByTestId('import-error')).toHaveText(problem, { timeout: 20_000 });
  });
});
