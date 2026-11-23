import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 90000,
  use: {
    ...devices['Desktop Firefox'],
    headless: true,
    viewport: { width: 1280, height: 1000 },
  },
  reporter: [['list']],
});
