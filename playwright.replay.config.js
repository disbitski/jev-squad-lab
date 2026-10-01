import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './replay-tests', workers: 1, timeout: 45000, reporter: 'list',
  use: { baseURL: process.env.REPLAY_URL || 'http://127.0.0.1:4214', channel: 'chrome', headless: true },
  webServer: process.env.REPLAY_URL ? undefined : { command: 'npm run replays:serve', url: 'http://127.0.0.1:4214', reuseExistingServer: false },
});
