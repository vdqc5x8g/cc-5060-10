import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 4281;
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

// Map seconds/Hz to canvas pixels using the displayed axes, so the test tracks
// the real display span rather than assuming 0..duration fills the width.
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
  return axes;
}

test('frame a region, complete, switch candidate, undo', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await expect(page.locator('#fixture-desc')).toContainText('谐波音符');
  await expect(page.locator('#status-text')).toHaveText('素材就绪');

  await frameRegion(page, { startSec: 0.90, endSec: 0.95, lowHz: 520, highHz: 980 });
  // The readout must reflect the drawn box, not an arbitrary default.
  const info = await page.locator('#sel-info').textContent();
  const m = info.match(/^([\d.]+)–([\d.]+) s · ([\d.]+)–([\d.]+) Hz$/);
  expect(m, `selection readout was "${info}"`).not.toBeNull();
  expect(Math.abs(Number(m[1]) - 0.90)).toBeLessThan(0.01);
  expect(Math.abs(Number(m[2]) - 0.95)).toBeLessThan(0.01);
  expect(Math.abs(Number(m[3]) - 520)).toBeLessThan(40);
  expect(Math.abs(Number(m[4]) - 980)).toBeLessThan(40);
  await expect(page.locator('#complete-btn')).toBeEnabled();
  await page.click('#complete-btn');
  await expect(page.locator('#report-badge')).toHaveText('完成', { timeout: 20000 });
  await expect(page.locator('#eval-block')).toBeVisible();
  await expect(page.locator('.candidate')).toHaveCount(2);
  await expect(page.locator('#audio-result')).toHaveAttribute('src', /data:audio\/wav/);
  await page.locator('.candidate').nth(1).click();
  await expect(page.locator('.candidate').nth(1)).toHaveClass(/selected/);
  await expect(page.locator('#undo-btn')).toBeEnabled();
  await page.click('#undo-btn');
  await expect(page.locator('#status-text')).toHaveText('已撤销到上一状态');
});

test('refuses an over-wide region without filling it', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.selectOption('#fixture-select', 'wide-gap');
  await expect(page.locator('#status-text')).toHaveText('素材就绪');
  await frameRegion(page, { startSec: 0.95, endSec: 1.0, lowHz: 300, highHz: 2400 });
  await page.click('#complete-btn');
  await expect(page.locator('#report-badge')).toHaveText('已拒绝', { timeout: 20000 });
  await expect(page.locator('#report-summary')).toContainText('不支持补全');
  await expect(page.locator('.candidate')).toHaveCount(0);
});
