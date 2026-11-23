import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 4287;
let server;
test.beforeAll(async () => {
  server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return; } catch {} await delay(200); }
  throw new Error('no server');
});
test.afterAll(async () => { server?.kill(); });

async function frameRegion(page, { startSec, endSec, lowHz, highHz }) {
  const box = await page.locator('#spec-canvas').boundingBox();
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

test('conflict fixture surfaces all candidates with low confidence', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.selectOption('#fixture-select', 'conflict-or-not');
  await expect(page.locator('#status-text')).toHaveText('素材就绪');
  await frameRegion(page, { startSec: 0.97, endSec: 1.04, lowHz: 400, highHz: 1400 });
  await page.click('#complete-btn');
  await expect(page.locator('#report-badge')).toHaveText('完成', { timeout: 20000 });
  await expect(page.locator('.candidate')).toHaveCount(5);
  await expect(page.locator('#report-summary')).toContainText('相斥');
  // The audit + eval blocks must be present, and audio both sides populated.
  await expect(page.locator('#audit-block')).toContainText('未触碰');
  await expect(page.locator('#eval-block')).toBeVisible();
});

test('running the self-check matrix produces a row per fixture', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await expect(page.locator('#status-text')).toHaveText('素材就绪');
  await page.click('#run-matrix');
  await expect(page.locator('.matrix-row')).toHaveCount(6, { timeout: 60000 });
  await expect(page.locator('#status-text')).toContainText('自检');
});
