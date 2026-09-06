'use strict';

const { test, expect } = require('@playwright/test');

async function ready(page, count) {
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#outputStatus')).toContainText(`${count} valid set`);
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoClipping(page) {
  const geometry = await page.locator('#output .set').evaluateAll((cards) => ({
    pageFits: document.documentElement.scrollWidth <= innerWidth,
    cardsFit: cards.every((card) => {
      const bounds = card.getBoundingClientRect();
      const visible = [...card.querySelectorAll('.stack-chip, .set-total, .set-changes')]
        .filter((element) => element.getClientRects().length);
      return card.scrollWidth <= card.clientWidth + 1 && visible.every((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= bounds.left - 0.5 && rect.right <= bounds.right + 0.5;
      });
    }),
  }));
  expect(geometry).toEqual({ pageFits: true, cardsFit: true });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const width of [320, 390, 768, 1280]) {
  test(`compact cards use available space without clipping at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('./#w=60%0A80%0A100%0A120%0A140');
    await ready(page, 5);
    const first = page.locator('#output .set').first();
    const fullHeight = (await first.boundingBox()).height;
    await expect(first.locator('.stack-order')).toBeHidden();
    await expect(first.locator('.plate-list')).toBeVisible();
    await expect(page.locator('#endStateNote')).toBeHidden();

    await page.locator('#compactToggle').click();
    const compactHeight = (await first.boundingBox()).height;
    expect(compactHeight).toBeLessThan(width >= 768 ? 80 : 105);
    expect(compactHeight).toBeLessThan(fullHeight - 40);
    await expect(first.locator('.stack-order')).toBeVisible();
    await expect(first.locator('.plate-list')).toBeHidden();
    await expect(first.locator('.bar-wrap')).toBeHidden();
    await expect(page.locator('#legend')).toBeHidden();
    await expectNoClipping(page);

    if (width <= 600) {
      const columns = await page.locator('#summary').evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(2);
      const heights = await page.locator('.config-actions .btn').evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height));
      expect(heights.every((height) => height >= 44)).toBe(true);
    }
  });
}

test('full, workout and print views keep diagrams without repeating ordered text', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#w=60%0A80&c=1');
  await ready(page, 2);
  const first = page.locator('#output .set').first();
  await page.locator('#compactToggle').click();
  await expect(first.locator('.bar-row')).toHaveAttribute('aria-label', /each side, from collar outward: 20 kg/);
  await expect(first.locator('.stack-order')).toBeHidden();
  await expect(page.locator('#legend')).toBeVisible();

  await page.locator('#compactToggle').click();
  await page.locator('#startWorkout').click();
  await expect(page.locator('#workoutCard .bar-wrap')).toBeVisible();
  await expect(page.locator('#workoutCard .plate-list')).toBeVisible();
  await expect(page.locator('#workoutCard .plate-list')).toHaveCSS('text-align', 'center');
  await expect(page.locator('#workoutCard .stack-order')).toBeHidden();
  await page.locator('#workoutNext').click();
  await expect(page.locator('#workoutProgress')).toContainText('Set 2 of 2');

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#workoutPanel')).toBeHidden();
  await expect(first.locator('.bar-wrap')).toBeVisible();
  await expect(first.locator('.plate-list')).toBeVisible();
  await expect(first.locator('.stack-order')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('#workoutPanel')).toBeVisible();
});

for (const { name, weight, flag, scope } of [
  { name: 'symmetric', weight: '177.5', flag: '', scope: 'Each side' },
  { name: 'one-sided', weight: '98.75', flag: '&x=1', scope: 'Loaded side' },
]) {
  test(`all seven denominations remain readable for ${name} loading in every mode`, async ({ page }) => {
    await page.goto(`./#w=${weight}&s=1&c=1${flag}`);
    await ready(page, 1);
    await page.locator('#settingsDetails > summary').click();
    for (const width of [320, 601]) {
      await page.setViewportSize({ width, height: 844 });
      for (const mode of ['count', 'kg', 'sqrt']) {
        await page.locator(`.mode-btn[data-mode="${mode}"]`).click();
        await ready(page, 1);
        await expect(page.locator('#output .stack-chip')).toHaveCount(7);
        await expect(page.locator('#output .stack-order')).toContainText(scope);
        await expectNoClipping(page);
      }
    }
  });
}

test('long pinned stacks, invalid entries and final unload fit a narrow compact card', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('./#w=340%0A21&s=0&i=1.1.1.1.1.1.1.1&c=1');
  await ready(page, 1);
  await expect(page.locator('#output .starting .stack-chip')).toHaveCount(8);
  await expect(page.locator('#output .invalid')).toHaveCount(1);
  await expect(page.locator('#output .cleanup')).toHaveCount(1);
  await expectNoClipping(page);
});

test('empty summaries reserve no note space but the leave-loaded warning remains visible', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#resultsToolbar')).toBeHidden();
  await page.locator('#input').fill('60');
  await ready(page, 1);
  await expect(page.locator('#endStateNote')).toBeHidden();
  await page.locator('#settingsDetails > summary').click();
  await page.locator('#leaveLoadedToggle').check();
  await expect(page.locator('#endStateNote')).toBeVisible();
  await expect(page.locator('#endStateNote')).toContainText('stays loaded');
  await expect(page.locator('#output .cleanup')).toHaveCount(0);
});
