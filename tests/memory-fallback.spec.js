'use strict';

const { test, expect } = require('@playwright/test');
const { startOfflineOrigin } = require('./offline-origin.js');
const heavy = Array.from({ length: 50 }, (_, i) => i % 2 ? 310 : 320).join('\n');

test('enabled primary actions have normal-text contrast and the worker does not execute the fallback', async ({ page }) => {
  await page.goto('./#w=60');
  await expect(page.locator('#outputStatus')).toContainText('1 valid set');
  expect(await page.evaluate(() => typeof buildFallbackAlgoLib)).toBe('undefined');
  expect(await page.evaluate(() => typeof buildAlgoLib)).toBe('undefined');
  const contrasts = await page.locator('.btn:not(.secondary):enabled').evaluateAll((elements) => {
    const luminance = (css) => {
      const c = css.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
        v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    };
    return elements.filter((e) => e.getBoundingClientRect().height > 0).map((e) => {
      const style = getComputedStyle(e);
      const a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  });
  expect(contrasts.length).toBeGreaterThan(0);
  expect(contrasts.every((value) => value >= 4.5)).toBe(true);
});

test('a real fallback stays responsive, is cancellable and recovers', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { value: undefined });
    window.heartbeat = { ticks: 0, gap: 0 };
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      window.heartbeat.gap = Math.max(window.heartbeat.gap, now - last);
      window.heartbeat.ticks++; last = now;
    }, 10);
  });
  await page.goto(`./#w=${encodeURIComponent(heavy)}&s=6`);
  await expect(page.locator('#cancelCompute')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.heartbeat.ticks)).toBeGreaterThan(10);
  await page.locator('#cancelCompute').click();
  await expect(page.locator('#output')).toContainText('Calculation cancelled');
  expect(await page.evaluate(() => window.heartbeat.gap)).toBeLessThan(500);
  await page.locator('#input').fill('100');
  await expect(page.locator('#outputStatus')).toContainText('1 valid set');
  await expect(page.locator('#output .set-total').first()).toHaveText('100kg');
  expect(await page.evaluate(() => typeof buildFallbackAlgoLib)).toBe('function');
  expect(await page.evaluate(() => typeof buildAlgoLib)).toBe('undefined');
  expect(errors).toEqual([]);
});

test('fallback timeouts remain responsive and publish no partial plan', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { value: undefined });
    window.ticks = 0; setInterval(() => window.ticks++, 20);
  });
  await page.goto(`./#w=${encodeURIComponent(heavy)}&s=6`);
  await expect(page.locator('#output .input-error')).toContainText('without returning an approximate result');
  expect(await page.evaluate(() => window.ticks)).toBeGreaterThan(20);
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#cancelCompute')).toBeHidden();
  await expect(page.locator('#summaryPanel')).toBeHidden();
});

test('late fallback results and finalizers cannot replace a newer request', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { value: undefined });
    window.requests = [];
    window.buildFallbackAlgoLib = () => ({
      optimizeAsync: (...args) => new Promise((resolve, reject) => window.requests.push({ args, resolve, reject })),
      hasPinnedStart: () => false,
    });
  });
  await page.goto('./#w=60');
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1);
  await page.locator('#input').fill('80');
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(2);
  await page.evaluate(() => window.requests[0].reject(new Error('old failure')));
  await expect(page.locator('#cancelCompute')).toBeVisible();
  await page.locator('#input').fill('100');
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(3);
  await page.evaluate(() => {
    const row = (total) => [{ valid: true, total, stack: [1, 1], removedCount: 0, addedCount: 2,
      bothSidesMoves: 4, bothSidesKg: 80, bothSidesSqrtKg: 4 * Math.sqrt(20) }];
    window.requests[2].resolve(row(100));
    window.requests[1].resolve(row(80));
  });
  await expect(page.locator('#outputStatus')).toContainText('1 valid set');
  await expect(page.locator('#output .set-total')).toHaveText('100kg');
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
});

test('the generated fallback is cached and works after the origin is shut down', async ({ page }) => {
  const origin = await startOfflineOrigin();
  try {
    await page.addInitScript(() => { Object.defineProperty(window, 'Worker', { value: undefined }); });
    await page.goto(origin.url);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    await page.reload();
    expect(await page.evaluate(async () => Boolean(await caches.match(new URL('runtime/algo-fallback.js', location.href).href)))).toBe(true);
    await origin.close();
    await expect(fetch(origin.url)).rejects.toThrow();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#input').fill('60\n80');
    await expect(page.locator('#outputStatus')).toContainText('2 valid sets');
    expect(await page.evaluate(() => typeof buildFallbackAlgoLib)).toBe('function');
  } finally { await origin.close(); }
});
