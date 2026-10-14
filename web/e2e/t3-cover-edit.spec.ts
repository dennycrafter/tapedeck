import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, librarySnapshot, seedReadyTracks, uniqueTag } from './helpers/library';
import { BASE_URL } from './helpers/env';

/*
 * T3 leftover @T3 (SPEC 8.4): Edit details has a cover choice, keep / remove
 * / paste an image link. Runs on all three projects: no playback needed.
 * The pasted link points at one of the app's own icons so the test never
 * leaves localhost.
 */

const made: { trackIds: string[] } = { trackIds: [] };

test.beforeEach(async ({ page }) => {
  made.trackIds = [];
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request, made);
});

async function coverOf(page: Page, trackId: string): Promise<string | null | undefined> {
  const snapshot = (await librarySnapshot(page.request)) as unknown as {
    tracks: { id: string; coverUrl: string | null }[];
  };
  return snapshot.tracks.find((track) => track.id === trackId)?.coverUrl;
}

async function openEdit(page: Page, trackId: string): Promise<void> {
  await page.locator(`[data-item-id="${trackId}"]`).first().getByTestId('song-menu-button').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-dialog')).toBeVisible();
}

test.describe('T3 edit details cover @T3', () => {
  test('cover: paste an image link, keep it on the next edit, then remove it', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seedReadyTracks(page.request, [{ title: `Cover me ${tag}`, artist: 'Band' }]);
    made.trackIds.push(song.id);
    const link = `${BASE_URL}/icons/icon-512.png`;
    await page.goto('/');

    // Keep is the default: no link box until "Paste URL" is chosen.
    await openEdit(page, song.id);
    await expect(page.getByTestId('edit-cover-keep')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('edit-cover-link')).toHaveCount(0);

    // A link that is not http(s) is refused and the dialog stays open.
    await page.getByTestId('edit-cover-url').click();
    await page.getByTestId('edit-cover-link').fill('cover.jpg');
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-error')).toContainText('https://');
    await expect(page.getByTestId('edit-dialog')).toBeVisible();

    // A real link saves.
    await page.getByTestId('edit-cover-link').fill(link);
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
    await expect.poll(() => coverOf(page, song.id)).toBe(link);

    // Editing something else with "Keep" leaves the cover alone.
    await openEdit(page, song.id);
    await page.getByTestId('edit-title').fill(`Renamed ${tag}`);
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
    await expect(page.locator(`[data-item-id="${song.id}"]`).first().getByTestId('track-title')).toHaveText(`Renamed ${tag}`);
    expect(await coverOf(page, song.id)).toBe(link);

    // Remove clears it (the row falls back to the blank placeholder).
    await openEdit(page, song.id);
    await page.getByTestId('edit-cover-remove').click();
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
    await expect.poll(() => coverOf(page, song.id)).toBeNull();
  });
});
