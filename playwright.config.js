'use strict';

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.js',
  workers: 1,
  retries: 0,
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173/plateloader/',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/serve-site.js',
    url: 'http://127.0.0.1:4173/plateloader/',
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
