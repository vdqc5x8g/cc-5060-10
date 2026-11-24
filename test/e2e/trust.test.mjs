import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 4291;
let server;

test.beforeAll(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe',
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error('server did not start');
});

test.afterAll(async () => { server?.kill(); });

async function frameRegion(page, { startSec, endSec, lowHz, highHz }) {
  const canvas = page.locator('#spec-canvas');
  const box = await canvas.boundingBox();
  const axes = await page.evaluate(() => ({
    t0: parseFloat(document.querySelector('#axis-left').textContent),
    t1: parseFloat(document.querySelector('#axis-right').textContent),
    nyquist: parseFloat(document.querySelector('#axis-note').textContent.replace(/[^0-9.]/g, '')),
  }));
  const xOf = (t) => box.x + box.width * ((t - axes.t0) / (axes.t1 - axes.t0));
  const yOf = (f) => box.y + box.height * (1 - f / axes.nyquist);
  await page.mouse.move(xOf(startSec), yOf(highHz));
  await page.mouse.down();
  await page.mouse.move(xOf(endSec), yOf(lowHz), { steps: 8 });
  await page.mouse.up();
}

test('trust panel lists fixtures and clean harmonic run passes', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await expect(page.locator('#status-text')).toHaveText('素材就绪');
  const options = await page.locator('#trust-select option').allTextContents();
  expect(options.length).toBeGreaterThanOrEqual(7);
  await page.selectOption('#trust-select', 'pairA-harmonic');
  await page.selectOption('#trust-fault', '');
  await page.click('#trust-run');
  await expect(page.locator('#trust-output .badge')).toHaveText('验收通过', { timeout: 30000 });
  await expect(page.locator('#trust-output')).toContainText('已知区误差');
  await expect(page.locator('#trust-output')).toContainText('子带守恒');
  await expect(page.locator('#trust-output')).toContainText('投影下界');
});

test('trust panel flags injected known-region pollution as a named failure', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.selectOption('#trust-select', 'pairA-harmonic');
  await page.selectOption('#trust-fault', 'known-region-pollution');
  await page.click('#trust-run');
  await expect(page.locator('#trust-output .badge')).toHaveText('验收失败', { timeout: 30000 });
  await expect(page.locator('#trust-output')).toContainText('known-pollution');
});

test('trust panel flags false confidence on the conflict fixture', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.selectOption('#trust-select', 'prior-mismatch-noise');
  await page.selectOption('#trust-fault', 'false-confidence');
  await page.click('#trust-run');
  await expect(page.locator('#trust-output .badge')).toHaveText('验收失败', { timeout: 30000 });
  await expect(page.locator('#trust-output')).toContainText('false-confidence');
});

test('run-all trust suite renders a row per fixture/fault combination', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.click('#trust-all');
  // 5 completable fixtures x 4 runs + 2 refused fixtures x 1 run = 22 rows.
  await expect(page.locator('.trust-row')).toHaveCount(22, { timeout: 120000 });
});

test('switching candidates swaps the result audio to that candidate reconstruction', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.selectOption('#fixture-select', 'harmonic-short');
  await frameRegion(page, { startSec: 0.9, endSec: 0.95, lowHz: 520, highHz: 980 });
  await page.click('#complete-btn');
  await expect(page.locator('#report-badge')).toHaveText('完成', { timeout: 30000 });
  const firstSrc = await page.locator('#audio-result').getAttribute('src');
  expect(firstSrc).toMatch(/^data:audio\/wav;base64,/);
  await page.locator('.candidate').nth(1).click();
  await expect(page.locator('.candidate').nth(1)).toHaveClass(/selected/);
  const secondSrc = await page.locator('#audio-result').getAttribute('src');
  // Distinct candidate target grids must produce distinct reconstructed WAVs.
  expect(secondSrc).toMatch(/^data:audio\/wav;base64,/);
  expect(secondSrc).not.toEqual(firstSrc);
});
