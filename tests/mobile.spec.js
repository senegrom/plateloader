'use strict';

const { test, expect } = require('@playwright/test');

async function ready(page, count) {
  await expect(page.locator('#outputStatus')).toContainText(`${count} valid set`);
}

test('compact view preserves physical order without a diagram', async ({ page }) => {
  await page.goto('./#w=60%0A30&c=1');
  await ready(page, 2);
  const cards = page.locator('#output .set');
  await expect(cards.nth(0).locator('.stack-chip')).toHaveText(['5 kg', '15 kg']);
  await expect(cards.nth(1).locator('.stack-chip')).toHaveText(['5 kg']);
  await expect(cards.nth(1).locator('.set-changes')).toContainText('1/side · 2 moves');
  await expect(cards.nth(0).locator('.bar-wrap')).toBeHidden();
});

test('all seven denominations remain visible without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('./#w=177.5&s=1&c=1');
  await ready(page, 1);
  await expect(page.locator('#output .set').first().locator('.stack-chip')).toHaveCount(7);
  const dimensions = await page.locator('#output .plate-list').first().evaluate((element) => ({
    clipped: getComputedStyle(element).overflowX === 'hidden',
    pageWidth: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(dimensions.clipped).toBe(false);
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewport);
});

test('wide starting and result diagrams have no inaccessible left overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#w=340&i=1.1.1.1.1.1.1.1');
  await ready(page, 1);
  await page.locator('#settingsDetails > summary').click();
  for (const selector of ['#startViz', '#output .bar-wrap']) {
    const dimensions = await page.locator(selector).first().evaluate((element) => {
      const row = element.querySelector('.bar-row');
      element.scrollLeft = 0;
      const left = row.getBoundingClientRect().left - element.getBoundingClientRect().left;
      element.scrollLeft = element.scrollWidth;
      return { left, right: row.getBoundingClientRect().right - element.getBoundingClientRect().right };
    });
    expect(dimensions.left).toBeGreaterThanOrEqual(-0.5);
    expect(dimensions.right).toBeLessThanOrEqual(0.5);
  }
  const targets = await page.locator('.start-btn, #startRemove, #startClear').evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height));
  expect(targets.every((height) => height >= 44)).toBe(true);
});

test('mobile planning is compact and workout navigation survives reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#w=60%0A80%0A100');
  await ready(page, 3);
  await expect(page.locator('#settingsDetails')).not.toHaveAttribute('open', '');
  const results = await page.locator('#results').boundingBox();
  expect(results.y).toBeLessThan(700);
  await page.locator('#startWorkout').click();
  await expect(page.locator('#plannerPanel')).toBeHidden();
  await expect(page.locator('#workoutPrevious')).toBeDisabled();
  await expect(page.locator('#workoutNextPreview')).toContainText('80 kg');
  await page.locator('#workoutNext').click();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 3');
  await page.reload();
  await expect(page.locator('#workoutPanel')).toBeVisible();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 3');
  await page.locator('#workoutPrevious').click();
  await expect(page.locator('#workoutProgress')).toContainText('Set 1 of 3');
  await page.locator('#editPlan').click();
  await expect(page.locator('#plannerPanel')).toBeVisible();
  await expect(page.locator('#input')).toBeFocused();
});

test('replanning pins the physical current stack and keeps skipped entries', async ({ page }) => {
  await page.goto('./#w=60%0A21%0A80%0A100');
  await ready(page, 3);
  const stack = await page.locator('#output .set').first().locator('.stack-chip').allTextContents();
  await page.locator('#startWorkout').click();
  await page.locator('#replanRemaining').click();
  await expect(page.locator('#input')).toHaveValue('21\n80\n100');
  await ready(page, 2);
  await expect(page.locator('#output .starting .stack-chip')).toHaveText(stack);
  await expect(page.locator('#output .invalid')).toHaveCount(1);
  await page.locator('#undoAction').click();
  await expect(page.locator('#input')).toHaveValue('60\n21\n80\n100');
  await ready(page, 3);
  await expect(page.locator('#output .starting')).toHaveCount(0);
});

test('unloaded starting inventory stays available when replanning and sharing', async ({ page, context }) => {
  await page.goto('./#w=20%0A340&s=0&i=1.1.1.1.1.1.1.1');
  await ready(page, 2);
  await page.locator('#startWorkout').click();
  await page.locator('#replanRemaining').click();
  await expect(page.locator('#input')).toHaveValue('340');
  await ready(page, 1);
  await expect(page.locator('#output .invalid')).toHaveCount(0);
  await expect(page.locator('#carriedStockNote')).toContainText('8 × 20 kg');
  expect(new URL(page.url()).hash).toContain('a=0.8.0.0.0.0.0');
  const recipient = await context.newPage();
  await recipient.goto(page.url());
  await ready(recipient, 1);
  await expect(recipient.locator('#output .invalid')).toHaveCount(0);
  await recipient.close();
});

test('leaving the bar loaded changes the optimisation totals and round-trips', async ({ page }) => {
  await page.goto('./#w=60');
  await ready(page, 1);
  await expect(page.locator('#output .cleanup')).toHaveCount(1);
  await page.locator('#settingsDetails > summary').click();
  await page.locator('#leaveLoadedToggle').check();
  await expect(page.locator('#output .cleanup')).toHaveCount(0);
  await expect(page.locator('#summary > div').nth(1).locator('b')).toHaveText('2');
  expect(new URL(page.url()).hash).toContain('l=1');
  await page.reload();
  await ready(page, 1);
  await expect(page.locator('#leaveLoadedToggle')).toBeChecked();
  await expect(page.locator('#output .cleanup')).toHaveCount(0);
  await page.locator('#startWorkout').click();
  await expect(page.locator('#workoutNext')).toBeDisabled();
  await expect(page.locator('#workoutNextPreview')).toContainText('leave this stack loaded');
});

test('warm-up targets follow the entered working weight and replacements are undoable', async ({ page }) => {
  await page.goto('./#w=60%0A120');
  await ready(page, 2);
  await page.locator('#warmup').click();
  await expect(page.locator('#warmupTarget')).toHaveValue('120');
  await page.locator('#warmupTarget').fill('100');
  await page.locator('#warmupForm button[type="submit"]').click();
  await expect(page.locator('#input')).toHaveValue('50\n70\n85\n95\n100');
  await page.locator('#undoAction').click();
  await expect(page.locator('#input')).toHaveValue('60\n120');
  await page.locator('#example').click();
  await expect(page.locator('#input')).toHaveValue('60\n80\n100\n120\n140');
  await page.locator('#undoAction').click();
  await expect(page.locator('#input')).toHaveValue('60\n120');
  await page.locator('#clear').click();
  await expect(page.locator('#input')).toHaveValue('');
  await page.locator('#undoAction').click();
  await expect(page.locator('#input')).toHaveValue('60\n120');
});

test('cancel and rapid edits ignore stale worker replies without disabling future calculations', async ({ page }) => {
  await page.addInitScript(() => {
    window.pendingWorkers = [];
    window.Worker = class {
      postMessage(data) {
        const callback = this.onmessage;
        window.pendingWorkers.push({ data, callback });
        callback({ data: { reqId: data.reqId, type: 'started' } });
      }
      terminate() {}
    };
  });
  await page.goto('./#w=60');
  await expect(page.locator('#cancelCompute')).toBeVisible();
  await page.locator('#cancelCompute').click();
  await expect(page.locator('#output')).toContainText('Calculation cancelled');
  await page.evaluate(() => {
    const stale = window.pendingWorkers[0];
    stale.callback({ data: { reqId: stale.data.reqId, results: [] } });
  });
  await expect(page.locator('#output')).toContainText('Calculation cancelled');
  await page.locator('#input').fill('80');
  await expect.poll(() => page.evaluate(() => window.pendingWorkers.length)).toBe(2);
  await page.locator('#input').fill('100');
  await expect.poll(() => page.evaluate(() => window.pendingWorkers.length)).toBe(3);
  await page.evaluate(() => {
    const stale = window.pendingWorkers[1];
    stale.callback({ data: { reqId: stale.data.reqId, error: 'stale failure' } });
    const latest = window.pendingWorkers[2];
    latest.callback({ data: { reqId: latest.data.reqId, hasStart: false, results: [{
      valid: true, total: 100, stack: [1, 1], removedCount: 0, addedCount: 2,
      bothSidesMoves: 4, bothSidesKg: 80, bothSidesSqrtKg: 4 * Math.sqrt(20),
    }] } });
  });
  await ready(page, 1);
  await expect(page.locator('#output .set-total')).toHaveText('100kg');
  await expect(page.locator('#startWorkout')).toBeEnabled();
});

test('worker runtime failures never trigger a synchronous retry', async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = class {
      postMessage(data) {
        queueMicrotask(() => {
          this.onmessage?.({ data: { reqId: data.reqId, type: 'started' } });
          setTimeout(() => this.onerror?.({ message: 'simulated runtime failure' }), 10);
        });
      }
      terminate() {}
    };
  });
  await page.goto('./#w=60');
  await expect(page.locator('#output .input-error')).toContainText('not repeated on the main thread');
  expect(await page.evaluate(() => typeof buildAlgoLib)).toBe('undefined');
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#cancelCompute')).toBeHidden();
});
