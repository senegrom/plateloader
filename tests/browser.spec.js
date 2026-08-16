'use strict';

const { test, expect } = require('@playwright/test');

function collectRuntimeErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
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

  const countMode = page.locator('[data-mode="count"]');
  await countMode.focus();
  await countMode.press('ArrowRight');
  await expect(page.locator('[data-mode="kg"]')).toHaveAttribute('aria-checked', 'true');

  await page.locator('#customStockDetails > summary').click();
  await page.locator('#customStockToggle').check();
  await expect(page.locator('#stockSlider')).toBeDisabled();
  await page.locator('#customStock-0').fill('1');
  await expect.poll(() => new URL(page.url()).hash).toContain('p=1.2.2.2.2.2.2');
  // Out-of-range typing clamps the model immediately without rewriting the
  // field under the caret; the displayed value is normalised on commit.
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

// The slider paints its own track, so its `outline: none` ties the shared
// focus-visible rule on specificity and wins on source order.
test('the stock slider keeps a visible keyboard focus ring', async ({ page }) => {
  await page.goto('./');
  await page.locator('#input').click();
  await page.keyboard.press('Tab');
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
      input: '60',
      stock: null,
      customStock: [null, 1, 2, 3, 4, 5, 6],
      startStack: [null],
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
  await page.locator('#customStockDetails > summary').click();
  await page.locator('#customStockToggle').check();
  for (let index = 0; index < 7; index++) {
    await page.locator(`#customStock-${index}`).fill('0');
  }
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

test('copy feedback has a stable action name and a separate live announcement', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./#w=60');
  const share = page.locator('#shareBtn');
  await expect(share).toHaveAttribute('aria-label', 'Copy shareable link');
  await share.click();
  await expect(share).toHaveText('Copied!');
  await expect(share).toHaveAttribute('aria-label', 'Copy shareable link');
  await expect(page.locator('#shareStatus')).toHaveText('Shareable link copied.');
});

// Every other test exercises the worker path; this one covers the sync
// fallback end to end — the on-demand algo.js script load and the shared
// pinned-start detection — by removing Worker support before load.
test('missing Worker support falls back to the exact sync optimiser', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { value: undefined });
  });
  await page.goto('./#w=60&i=1');
  await expect(page.locator('#output article.set')).toHaveCount(3);
  await expect(page.locator('#output .set.starting')).toHaveCount(1);
  await expect(page.locator('#output .set.cleanup')).toHaveCount(1);
  await expect(page.locator('#outputStatus')).toContainText('1 valid set');
  expect(runtimeErrors).toEqual([]);
});

test('project-scoped service worker keeps the app usable offline', async ({ page, context }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.goto('./');
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      });
    }
    return registration.scope;
  });
  expect(scope).toMatch(/\/plateloader\/$/);

  try {
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toContainText('Plate Loader');
    await page.locator('#input').fill('60\n80');
    await expect(page.locator('#summaryPanel')).toBeVisible();
    await expect(page.locator('#outputStatus')).toContainText('2 valid sets');
  } finally {
    await context.setOffline(false);
  }
  expect(runtimeErrors).toEqual([]);
});
