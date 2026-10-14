import { test, expect } from '@playwright/test';
import { login } from './helpers/login';

// Throwaway probe (never merged): which offline audio sources does WebKit play?
test('probe blob playback @PROBE', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const out: string[] = [];
    const bytes = await (await fetch('/test-audio/test1.m4a')).arrayBuffer();
    async function tryPlay(label: string, src: string): Promise<void> {
      const audio = new Audio();
      audio.preload = 'auto';
      const outcome = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(`timeout rs=${audio.readyState} ns=${audio.networkState} t=${audio.currentTime.toFixed(2)}`), 8000);
        audio.addEventListener('error', () => { clearTimeout(timer); resolve(`error ${audio.error?.code} ${audio.error?.message ?? ''}`); });
        audio.addEventListener('timeupdate', () => { if (audio.currentTime > 0.3) { clearTimeout(timer); resolve('PLAYED'); } });
        audio.src = src;
        audio.play().catch((e) => { clearTimeout(timer); resolve(`play() rejected ${e.name}`); });
      });
      audio.pause();
      out.push(`${label}: ${outcome}`);
    }
    for (let i = 0; i < 3; i++) {
      await tryPlay(`blob audio/mp4 #${i}`, URL.createObjectURL(new Blob([bytes], { type: 'audio/mp4' })));
      await tryPlay(`blob no type #${i}`, URL.createObjectURL(new Blob([bytes])));
      await tryPlay(`blob audio/x-m4a #${i}`, URL.createObjectURL(new Blob([bytes], { type: 'audio/x-m4a' })));
      await tryPlay(`blob audio/aac-mp4 video/mp4 #${i}`, URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' })));
      await tryPlay(`plain url #${i}`, '/test-audio/test1.m4a');
    }
    return out.join('\n');
  });
  expect(results, 'probe results').toBe('see message');
});
