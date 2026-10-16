import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';

/*
 * T13 Apple Music link checks @T13 (V2-PLAN T13, Adapters item 3): paste
 * shared Apple Music playlist links, see them in the checklist with their
 * song counts, import one, and read the plain messages for a library link, a
 * profile link, a playlist that is gone and a page Apple changed.
 *
 * The app server runs with TAPEDECK_TEST=1, so the Apple pages come from the
 * recordings in e2e/fixtures/import-apple-link/ (lib/importers/apple-source.ts)
 * and catalog matching from the recorded Deezer answers; nothing calls Apple.
 * The three projects share one in-memory database, so afterEach deletes the
 * playlists this spec made and the songs it added.
 */

const DAFT_PUNK = 'pl.74657640b88c4587a426160f7441de46';
const USER_PLAYLIST = 'pl.u-11zB9vyskDZ1AX';
const DAFT_PUNK_LINK = `https://music.apple.com/us/playlist/daft-punk-essentials/${DAFT_PUNK}`;
const USER_LINK = `https://music.apple.com/gb/playlist/track-star/${USER_PLAYLIST}`;
const DAFT_PUNK_NAME = 'Daft Punk Essentials';
const USER_NAME = 'Track Star \u{1F45F}✨\u{1F308}';

type Library = { tracks: { id: string; title: string }[]; playlists: { id: string; name: string; trackIds: string[] }[] };

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.status()).toBe(200);
  return (await response.json()) as Library;
}

let songsBefore = new Set<string>();

async function openApple(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('[data-testid="add-open"]:visible').first().click();
  await page.getByTestId('add-tab-import').click();
  await page.locator('[data-testid="import-service"][data-service="apple"]').click();
  await expect(page).toHaveURL(/\/import\?service=apple$/);
  await expect(page.getByTestId('import-title')).toHaveText('Import from Apple Music');
}

async function pasteLinks(page: Page, links: string[]): Promise<void> {
  await page.getByTestId('import-links').fill(links.join('\n'));
  await page.getByTestId('import-find').click();
}

async function expectError(page: Page, links: string[], message: string | RegExp): Promise<void> {
  await page.goto('/import?service=apple');
  await pasteLinks(page, links);
  await expect(page.getByTestId('import-error')).toHaveText(message);
  await page.getByTestId('import-again').click();
  await expect(page.getByTestId('import-connect')).toBeVisible();
}

function playlistRow(page: Page, ref: string) {
  return page.locator(`[data-testid="import-playlist"][data-ref="${ref}"]`);
}

test.beforeEach(async ({ page }) => {
  await login(page);
  songsBefore = new Set((await library(page.request)).tracks.map((track) => track.id));
});

test.afterEach(async ({ page }) => {
  // Only what this spec made: its playlists, and the songs it added to them.
  const snapshot = await library(page.request);
  for (const playlist of snapshot.playlists.filter((p) => p.name === DAFT_PUNK_NAME || p.name === USER_NAME)) {
    for (const id of playlist.trackIds.filter((trackId) => !songsBefore.has(trackId))) await page.request.delete(`/api/tracks/${id}`);
    await page.request.delete(`/api/playlists/${playlist.id}`);
  }
});

test.describe('T13 Apple Music link @T13', () => {
  test('paste two shared playlist links, import one, songs keep their order', async ({ page }) => {
    test.setTimeout(120_000);
    await openApple(page);
    const slot = page.getByTestId('import-slot-link');
    await expect(slot).toContainText('Share Playlist');
    await expect(slot).toContainText('Up to 300 songs per playlist');

    await pasteLinks(page, [DAFT_PUNK_LINK, USER_LINK]);
    await expect(page).toHaveURL(/\/import\?job=/);
    await expect(page.getByTestId('import-checklist')).toBeVisible();
    await expect(page.getByTestId('import-playlist-name')).toHaveText([DAFT_PUNK_NAME, USER_NAME]);
    await expect(playlistRow(page, DAFT_PUNK).getByTestId('import-playlist-facts')).toHaveText('16 songs');
    await expect(playlistRow(page, USER_PLAYLIST).getByTestId('import-playlist-facts')).toHaveText('21 songs');

    await playlistRow(page, USER_PLAYLIST).getByTestId('import-playlist-check').click();
    await expect(page.getByTestId('import-start')).toHaveText('Import 1 playlist');
    await page.getByTestId('import-start').click();
    await expect(page.getByTestId('import-progress')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    await expect(page.getByTestId('import-progress-playlist')).toHaveText([DAFT_PUNK_NAME]);
    await expect(page.getByTestId('import-progress-text')).toContainText('of 16 ready');

    const snapshot = await library(page.request);
    const playlist = snapshot.playlists.find((p) => p.name === DAFT_PUNK_NAME);
    expect(playlist?.trackIds).toHaveLength(16);
    const titles = playlist?.trackIds.map((id) => snapshot.tracks.find((t) => t.id === id)?.title);
    expect(titles?.slice(0, 4)).toEqual(['Instant Crush', 'Veridis Quo', 'Around the World', 'One More Time']);
    expect(snapshot.playlists.some((p) => p.name === USER_NAME)).toBe(false);
  });

  test('library, profile, missing and changed pages read plainly', async ({ page }) => {
    await openApple(page);
    await expectError(
      page,
      ['https://music.apple.com/us/library/playlist/p.ZOAXxZ7HKKK6NP'],
      'That link is to a playlist in your own library, which only you can open. In Apple Music, open the playlist, tap the three dots, then Share Playlist, then Copy, and paste that link here.',
    );
    await expectError(
      page,
      [DAFT_PUNK_LINK, 'https://music.apple.com/profile/someone'],
      "The link on line 2 is to a profile. Apple doesn't let apps list a profile's playlists, so paste a link to each playlist instead.",
    );
    await expectError(
      page,
      ['https://music.apple.com/us/playlist/pl.u-zzzzzzzzzzzzzz'],
      "Apple Music couldn't find that playlist. Check the link, and that the playlist is shared.",
    );
    await expectError(page, ['https://music.apple.com/us/playlist/x/pl.u-tapedeckchanged'], /^Apple Music changed something/);
  });
});
