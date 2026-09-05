'use strict';

const { test, expect } = require('@playwright/test');
const heavy = Array.from({ length: 50 }, (_, index) => index % 2 ? 310 : 320).join(',');
const ready = async (page, count) => expect(page.locator('#outputStatus')).toContainText(`${count} valid set`);

function runtimeErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('Undo restores the active workout position, loaded stack and reload progress', async ({ page }) => {
  const errors = runtimeErrors(page);
  await page.goto('./#w=60%0A21%0A80%0A100%0A120&i=4');
  await ready(page, 4);
  await page.locator('#startWorkout').click();
  await page.locator('#workoutNext').click();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 4');
  const stack = await page.locator('#workoutCard .stack-chip').allTextContents();
  await page.locator('#replanRemaining').click();
  await ready(page, 2);
  await page.locator('#undoAction').click();
  await expect(page.locator('#workoutPanel')).toBeVisible();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 4');
  await expect(page.locator('#workoutCard .stack-chip')).toHaveText(stack);
  await expect(page.locator('#workoutNextPreview')).toContainText('100 kg');
  await expect(page.locator('#workoutHeading')).toBeFocused();
  await page.reload();
  await expect(page.locator('#workoutPanel')).toBeVisible();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 4');
  await expect(page.locator('#workoutCard .stack-chip')).toHaveText(stack);
  expect(errors).toEqual([]);
});

test('Undo from the planner preserves its view and the previous workout index', async ({ page }) => {
  await page.goto('./#w=60%0A80%0A100%0A120');
  await ready(page, 4);
  await page.locator('#startWorkout').click();
  await page.locator('#workoutNext').click();
  await page.locator('#editPlan').click();
  await page.locator('#example').click();
  await ready(page, 5);
  await page.locator('#clear').click();
  await page.locator('#undoAction').click();
  await ready(page, 5);
  await page.locator('#undoAction').click();
  await ready(page, 4);
  await expect(page.locator('#plannerPanel')).toBeVisible();
  await page.locator('#startWorkout').click();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 4');
});

test('remembered warm-up survives Clear, a non-default hash and reload', async ({ page }) => {
  await page.goto('./#b=15');
  await page.locator('#warmup').click();
  await page.locator('#warmupTarget').fill('100');
  await page.locator('#warmupForm button[type="submit"]').click();
  await expect(page.locator('#summaryPanel')).toBeVisible();
  await page.locator('#clear').click();
  await expect(page.locator('#input')).toHaveValue('');
  expect(new URL(page.url()).hash).toContain('b=15');
  await page.reload();
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupTarget')).toHaveValue('100');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('plateLoader.preferences.v1')).warmupTarget)).toBe(100);
  await page.locator('#warmupCancel').click();
  // Navigating to a shared plan must not change this local preference.
  await page.goto('./#w=60');
  await ready(page, 1);
  await expect(page.locator('#barWeight')).toHaveValue('20');
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupTarget')).toHaveValue('60');
  await page.locator('#warmupCancel').click();
  await page.locator('#clear').click();
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupTarget')).toHaveValue('100');
});

test('legacy warm-up preference migrates without merging stored settings into a shared plan', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('plateLoader.v1', JSON.stringify({
      input: '999', stock: 6, bar: 25, mode: 'sqrt', leaveLoaded: true, warmupTarget: 100,
    }));
  });
  await page.goto('./#b=15');
  await expect(page.locator('#input')).toHaveValue('');
  await expect(page.locator('#barWeight')).toHaveValue('15');
  await expect(page.locator('#stockSlider')).toHaveValue('2');
  await expect(page.locator('[data-mode="count"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#leaveLoadedToggle')).not.toBeChecked();
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupTarget')).toHaveValue('100');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('plateLoader.preferences.v1')).warmupTarget)).toBe(100);
});

test('unavailable storage does not break loading or Undo', async ({ page }) => {
  const errors = runtimeErrors(page);
  await page.addInitScript(() => {
    Storage.prototype.getItem = function () { throw new DOMException('Blocked', 'SecurityError'); };
    Storage.prototype.setItem = function () { throw new DOMException('Blocked', 'SecurityError'); };
  });
  await page.goto('./#w=60%0A80%0A100');
  await ready(page, 3);
  await page.locator('#startWorkout').click();
  await page.locator('#workoutNext').click();
  await page.locator('#replanRemaining').click();
  await ready(page, 1);
  await page.locator('#undoAction').click();
  await expect(page.locator('#workoutPanel')).toBeVisible();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 3');
  expect(errors).toEqual([]);
});

test('invalid remembered targets are ignored and a valid local preference wins over legacy state', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('plateLoader.preferences.v1', '{broken');
    localStorage.setItem('plateLoader.v1', JSON.stringify({ warmupTarget: '100' }));
  });
  await page.goto('./#w=');
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupTarget')).toHaveValue('140');
  await page.locator('#warmupCancel').click();
  await page.evaluate(() => {
    localStorage.setItem('plateLoader.preferences.v1', JSON.stringify({ warmupTarget: 110 }));
    localStorage.setItem('plateLoader.v1', JSON.stringify({ warmupTarget: 100 }));
    loadLocalPreferences();
  });
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupTarget')).toHaveValue('110');
});

for (const hideScheduler of [false, true]) {
test(`no-worker fallback stays responsive and cancels (${hideScheduler ? 'without' : 'with'} native scheduler)`, async ({ page }) => {
  const errors = runtimeErrors(page);
  await page.addInitScript((hideScheduler) => {
    window.Worker = undefined;
    if (hideScheduler) Object.defineProperty(window, 'scheduler', { value: undefined });
    window.timerGaps = [];
    let last = performance.now();
    setInterval(() => { const now = performance.now(); window.timerGaps.push(now - last); last = now; }, 10);
  }, hideScheduler);
  await page.goto(`./#w=${heavy}&s=6`);
  await expect(page.locator('#cancelCompute')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.timerGaps.length)).toBeGreaterThan(10);
  await page.locator('#cancelCompute').click();
  await expect(page.locator('#output')).toContainText('Calculation cancelled');
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#cancelCompute')).toBeHidden();
  const maximumGap = await page.evaluate(() => Math.max(...window.timerGaps));
  // Generous cross-engine CI margin, still detects the former 3-second block.
  expect(maximumGap).toBeLessThan(750);
  await page.locator('#input').fill('60\n80');
  await ready(page, 2);
  await expect(page.locator('#startWorkout')).toBeEnabled();
  expect(errors).toEqual([]);
});

}

test('late fallback rejections and results cannot clear or overwrite a newer request', async ({ page }) => {
  const errors = runtimeErrors(page);
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto('./#w=60');
  await ready(page, 1);
  await page.evaluate(() => {
    window.pendingFallbacks = [];
    algoLib.optimizeAsync = (...args) => new Promise((resolve, reject) => {
      window.pendingFallbacks.push({ args, resolve, reject });
    });
  });
  await page.locator('#input').fill('80');
  await expect.poll(() => page.evaluate(() => window.pendingFallbacks.length)).toBe(1);
  await page.locator('#input').fill('100');
  await expect.poll(() => page.evaluate(() => window.pendingFallbacks.length)).toBe(2);
  expect(await page.evaluate(() => window.pendingFallbacks[0].args[8].signal.aborted)).toBe(true);
  await page.evaluate(() => window.pendingFallbacks[0].reject(new Error('late failure')));
  await expect(page.locator('#cancelCompute')).toBeVisible();
  await page.evaluate(() => {
    const latest = window.pendingFallbacks[1];
    latest.resolve(algoLib.optimize(...latest.args));
  });
  await ready(page, 1);
  await expect(page.locator('#output .set-total').first()).toHaveText('100kg');
  // A late success after Cancel must also remain invisible.
  await page.locator('#input').fill('120');
  await expect.poll(() => page.evaluate(() => window.pendingFallbacks.length)).toBe(3);
  await expect(page.locator('#cancelCompute')).toBeVisible();
  await page.locator('#cancelCompute').click();
  await page.evaluate(() => window.pendingFallbacks[2].resolve([]));
  await expect(page.locator('#output')).toContainText('Calculation cancelled');
  expect(errors).toEqual([]);
});
