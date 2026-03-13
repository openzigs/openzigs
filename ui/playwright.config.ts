import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 30_000,

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3101',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* In CI: start Next.js directly (skip dev-server proxy — no WebSocket routing needed for E2E) */
  webServer: process.env.CI
    ? {
        command: 'npx next dev --port 3101',
        url: 'http://localhost:3101',
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
});
