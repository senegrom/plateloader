'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  testMatch: 'browser.spec.js',
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173/plateloader/',
    serviceWorkers: 'allow',
  },
  webServer: {
    command: 'node tests/serve-site.js',
    url: 'http://127.0.0.1:4173/plateloader/',
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
