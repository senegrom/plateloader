'use strict';

const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

// An isolated origin can be genuinely disconnected without taking down the
// shared suite server. no-store prevents the ordinary HTTP cache from making
// the offline test pass without the service worker.
async function startOfflineOrigin() {
  const root = path.resolve(__dirname, '../_site');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/plateloader/')) {
        response.writeHead(404).end();
        return;
      }
      const file = path.resolve(root, pathname.slice('/plateloader/'.length) || 'index.html');
      if (!file.startsWith(root + path.sep)) {
        response.writeHead(403).end();
        return;
      }
      const body = await fs.readFile(file);
      response.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch (_) {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/plateloader/`,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

function collectRuntimeErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function openSettings(page) {
  if (!await page.locator('#settingsDetails').evaluate((element) => element.open)) {
    await page.locator('#settingsDetails > summary').click();
  }
}

test('primary workflow, bypass navigation and custom stock round-trip', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.goto('./');
  await expect(page.locator('main#mainContent')).toHaveCount(1);
  await expect(page.locator('#results[aria-labelledby="resultsHeading"]')).toHaveCount(1);
  await page.locator('#input').fill('60\n80\n100');
  await expect(page.locator('#summaryPanel')).toBeVisible();
  await expect(page.locator('#output article.set')).toHaveCount(4);
  await expect(page.locator('#outputStatus')).toContainText('3 valid sets');
  const stateUrl = page.url();
  await page.locator('#skipToResults').focus();
  await page.locator('#skipToResults').press('Enter');
  await expect(page.locator('#results')).toBeFocused();
  expect(page.url()).toBe(stateUrl);
  await openSettings(page);
  const countMode = page.locator('[data-mode="count"]');
  await countMode.focus();
  await countMode.press('ArrowRight');
  await expect(page.locator('[data-mode="kg"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#customStockDetails > summary').click();
  await page.locator('#customStockToggle').check();
  await expect(page.locator('#stockSlider')).toBeDisabled();
  await page.locator('#customStock-0').fill('1');
  await expect.poll(() => new URL(page.url()).hash).toContain('p=1.2.2.2.2.2.2');
  // Clamp the model while typing, but only normalise the field on commit.
  await page.locator('#customStock-1').fill('99');
  await expect.poll(() => new URL(page.url()).hash).toContain('p=1.6.2.2.2.2.2');
  await page.locator('#customStock-1').blur();
  await expect(page.locator('#customStock-1')).toHaveValue('6');
  await page.locator('#customStock-1').fill('1.5');
  await page.locator('#customStock-1').blur();
  await expect(page.locator('#customStock-1')).toHaveValue('6');
  await expect.poll(() => new URL(page.url()).hash).toContain('p=1.6.2.2.2.2.2');
  await page.reload();
  await expect(page.locator('#customStockToggle')).toBeChecked();
  await expect(page.locator('#customStock-0')).toHaveValue('1');
  await expect(page.locator('#customStock-1')).toHaveValue('6');
  await expect(page.locator('[data-mode="kg"]')).toHaveAttribute('aria-checked', 'true');
  expect(runtimeErrors).toEqual([]);
});

test('the stock slider keeps a visible keyboard focus ring', async ({ page }) => {
  await page.goto('./');
  await openSettings(page);
  await page.locator('#barWeight').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#stockSlider')).toBeFocused();
  await expect(page.locator('#stockSlider')).toHaveCSS('outline-width', '2px');
});

test('custom counts reach the exact optimiser and malformed vectors are ignored', async ({ page }) => {
  await page.goto('./#w=60&p=0.0.0.0.0.0.0');
  await expect(page.locator('#customStockToggle')).toBeChecked();
  await expect(page.locator('#output .set.invalid')).toHaveCount(1);
  await expect(page.locator('#outputStatus')).toContainText('0 valid sets; 1 invalid set');
  await page.goto('./#w=60&p=0.0.bad');
  await expect(page.locator('#customStockToggle')).not.toBeChecked();
  await expect(page.locator('#output .set.invalid')).toHaveCount(0);
  await expect(page.locator('#outputStatus')).toContainText('1 valid set');
});

test('oversized crafted input is rejected without running the optimiser', async ({ page }) => {
  await page.goto(`./#w=${'1'.repeat(4097)}`);
  await expect(page.locator('#inputErrors')).toContainText('4096 characters');
  await page.goto('./');
  await page.evaluate(() => {
    const input = document.getElementById('input');
    input.value = '1'.repeat(4097);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#inputErrors')).toContainText('4096 characters');
  await expect(page.locator('#summaryPanel')).toBeHidden();
});

test('crafted stored state cannot coerce invalid stock or starting plates', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('plateLoader.v1', JSON.stringify({
      input: '60', stock: null, customStock: [null, 1, 2, 3, 4, 5, 6], startStack: [null],
    }));
  });
  await page.goto('./');
  await expect(page.locator('#stockValue')).toHaveText('2');
  await expect(page.locator('#customStockToggle')).not.toBeChecked();
  await expect(page.locator('#startDetails')).not.toHaveAttribute('open', '');
  await expect(page.locator('#startTotal')).toHaveText('20 kg bar only');
  await expect(page.locator('#outputStatus')).toContainText('1 valid set');
});

test('malformed Unicode state is safely shared, stored and validated', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.goto('./');
  await page.evaluate(() => {
    const input = document.getElementById('input');
    input.value = `60\n${String.fromCharCode(0xD800)}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#inputErrors')).toContainText('not a decimal weight');
  await expect.poll(() => new URL(page.url()).hash).toContain('%EF%BF%BD');
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('plateLoader.v1'));
    return saved && saved.input;
  })).toBe('60\n�');
  expect(runtimeErrors).toEqual([]);
});

test('custom inventory drives warm-up limits and generated weights', async ({ page }) => {
  await page.goto('./');
  await openSettings(page);
  await page.locator('#customStockDetails > summary').click();
  await page.locator('#customStockToggle').check();
  for (let index = 0; index < 7; index++) await page.locator(`#customStock-${index}`).fill('0');
  await page.locator('#customStock-0').fill('1');
  await expect(page.locator('#warmupNote')).toContainText('available denominations use 50 kg total increments');
  await expect(page.locator('#warmupNote')).toContainText('maximum 70 kg');
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupDialog')).toBeVisible();
  await page.locator('#warmupTarget').fill('70');
  await page.locator('#warmupForm button[type="submit"]').click();
  await expect(page.locator('#input')).toHaveValue('20\n70');
  await expect(page.locator('#outputStatus')).toContainText('2 valid sets');
});

test('copy feedback has a stable action name and a separate live announcement', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  } else {
    // WebKit has no equivalent permission override. Check its UI contract
    // without claiming to exercise the native iPhone clipboard permission UI.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
    });
  }
  await page.goto('./#w=60');
  const share = page.locator('#shareBtn');
  await expect(share).toHaveAttribute('aria-label', 'Copy shareable link');
  await share.click();
  await expect(share).toHaveText('Copied!');
  await expect(share).toHaveAttribute('aria-label', 'Copy shareable link');
  await expect(page.locator('#shareStatus')).toHaveText('Shareable link copied.');
});

test('missing Worker support falls back to the exact sync optimiser', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => { Object.defineProperty(window, 'Worker', { value: undefined }); });
  await page.goto('./#w=60&i=1');
  await expect(page.locator('#output article.set')).toHaveCount(3);
  await expect(page.locator('#output .set.starting')).toHaveCount(1);
  await expect(page.locator('#output .set.cleanup')).toHaveCount(1);
  await expect(page.locator('#outputStatus')).toContainText('1 valid set');
  expect(runtimeErrors).toEqual([]);
});

test('project-scoped service worker keeps the app usable offline', async ({ page, context, browserName }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  const origin = await startOfflineOrigin();
  try {
    await page.goto(origin.url);
    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        });
      }
      const worker = navigator.serviceWorker.controller;
      if (worker.state !== 'activated') {
        await new Promise((resolve) => {
          worker.addEventListener('statechange', function activated() {
            if (worker.state !== 'activated') return;
            worker.removeEventListener('statechange', activated);
            resolve();
          });
        });
      }
      return registration.scope;
    });
    expect(scope).toBe(origin.url);
    // Establish a controlled document before disconnecting the origin.
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => navigator.serviceWorker.controller.state)).toBe('activated');
    const cached = await page.evaluate(async () => {
      const files = ['index.html', 'plateloader.js', 'plateloader.css', 'state.js', 'algo.js', 'algo-worker.js'];
      return Promise.all(files.map(async (file) => Boolean(await caches.match(new URL(file, location.href).href))));
    });
    expect(cached.every(Boolean)).toBe(true);
    await origin.close();
    await expect(fetch(origin.url)).rejects.toThrow();
    // Emulated offline reload returned an internal error in mobile WebKit.
    // Use actual origin unavailability rather than skipping its offline test;
    // Chromium additionally retains the emulated-disconnection coverage.
    if (browserName === 'chromium') await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toContainText('Plate Loader');
    await page.locator('#input').fill('60\n80');
    await expect(page.locator('#summaryPanel')).toBeVisible();
    await expect(page.locator('#outputStatus')).toContainText('2 valid sets');
  } finally {
    if (browserName === 'chromium') await context.setOffline(false);
    await origin.close();
  }
  expect(runtimeErrors).toEqual([]);
});
