import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  outputDir: './playwright/results',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  reporter: [['list', { printSteps: true }]],
  retries: 0,
  testDir: './screenshots',
  testMatch: '**/*.screenshots.ts',
  timeout: 120 * 1000,
  use: {
    baseURL: 'http://localhost:47392',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'pnpm dev --port 47392',
    cwd: '..',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    url: 'http://localhost:47392/admin',
  },
  workers: 1,
})
