import { test, expect } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, seedReadyTracks, uniqueTag } from './helpers/library';

/*
 * T6 check @T6 (SPEC 9 T6, 8.11), app side: the profile setting and the
 * song menu's "Add to Apple Music" update the database. The downloader side
 * (finding the folder, copying, apple-music-done) is covered by pytest in
 * agent/tests/test_apple_music.py.
 */

const made: { trackIds: string[] } = { trackIds: [] };

test.beforeEach(async ({ page }) => {
  made.trackIds = [];
  await login(page);
});

test.afterEach(async ({ page }) => {
  await page.request.put('/api/settings/apple-music', { data: { on: false } });
  await cleanup(page.request, made);
});

type Snapshot = {
  appleMusicExport: boolean;
  tracks: { id: string; appleMusic: boolean; status: string }[];
};

async function snapshot(page: import('@playwright/test').Page): Promise<Snapshot> {
  return (await (await page.request.get('/api/library')).json()) as Snapshot;
}

test.describe('T6 Apple Music @T6', () => {
  test('the profile setting and "Add to Apple Music" update the database', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seedReadyTracks(page.request, [{ title: `Apple ${tag}`, artist: 'Band' }]);
    made.trackIds.push(song.id);

    // Setting: off by default, the switch turns it on and off.
    await page.goto('/profile');
    const toggle = page.getByTestId('apple-music-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect((await snapshot(page)).appleMusicExport).toBe(false);
    const saved = () =>
      page.waitForResponse((r) => r.url().includes('/api/settings/apple-music') && r.request().method() === 'PUT');
    let response = saved();
    await toggle.click();
    expect((await response).status()).toBe(200);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect((await snapshot(page)).appleMusicExport).toBe(true);
    response = saved();
    await toggle.click();
    expect((await response).status()).toBe(200);
    expect((await snapshot(page)).appleMusicExport).toBe(false);

    // Song menu: a ready song is flagged and goes back to waiting for the PC.
    await page.goto('/');
    const item = page.locator(`[data-item-id="${song.id}"]`).first();
    await item.getByTestId('song-menu-button').click();
    const added = page.waitForResponse(
      (r) => r.url().includes(`/api/tracks/${song.id}/apple-music`) && r.request().method() === 'POST',
    );
    await page.getByTestId('menu-apple-music').click();
    expect((await added).status()).toBe(200);
    await expect(page.getByTestId('toast')).toContainText('Apple Music');
    const after = (await snapshot(page)).tracks.find((track) => track.id === song.id);
    expect(after).toMatchObject({ appleMusic: true, status: 'waiting' });
    await expect(item.getByTestId('track-status')).toHaveText('Waiting for your PC');

    // Already flagged: the menu no longer offers it.
    await item.getByTestId('song-menu-button').click();
    await expect(page.getByTestId('menu-apple-music')).toHaveCount(0);
  });
});
