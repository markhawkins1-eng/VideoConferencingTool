// End-to-end browser tests. Each test starts its own Python server (see tests/e2e/helpers.js).
// Run: npx playwright test --trace off
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    browserName: 'chromium',
    trace: 'off',
    launchOptions: {
      // Fake camera/mic so calls work headless and without permission prompts.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
});
