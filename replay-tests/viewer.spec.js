import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
for (const [name, size] of [['desktop', { width: 1440, height: 1100 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name}: rendered battlefield, offline controls, and no inference`, async ({ page, context, baseURL }) => {
    await page.setViewportSize(size);
    const requests = [], errors = [];
    page.on('request', r => requests.push({ url: r.url(), method: r.method() }));
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/' + (new URL(baseURL).pathname === '/' ? '' : new URL(baseURL).pathname.slice(1)));
    await expect(page.locator('#play')).toBeEnabled();
    await expect(page.locator('#battlefield canvas')).toBeVisible();
    await page.locator('#scrub').fill('2.5');
    await page.waitForTimeout(200);
    const pixels = await page.locator('canvas').evaluate(canvas => {
      const context = canvas.getContext('2d'); const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set(); for (let i = 0; i < bytes.length; i += 160) colors.add(`${bytes[i]},${bytes[i+1]},${bytes[i+2]}`);
      return { colors: colors.size, width: canvas.width, height: canvas.height };
    });
    expect(pixels.colors).toBeGreaterThan(50); expect(pixels.width).toBe(960);
    await expect(page.locator('#decision-source')).toHaveText('Nimble');
    await expect(page.locator('#raw')).toContainText('retreat');
    const before = await page.locator('canvas').evaluate(c => c.toDataURL());
    await page.locator('#play').click(); await page.waitForTimeout(1100); await page.locator('#play').click();
    const after = await page.locator('canvas').evaluate(c => c.toDataURL()); expect(after).not.toBe(before);
    await mkdir('images', { recursive: true });
    await page.screenshot({ path: `images/replay-${name}.png`, fullPage: name === 'mobile' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); expect(overflow).toBe(false);
    const requestCount = requests.length;
    await context.setOffline(true);
    await page.locator('#scrub').fill('7'); await page.locator('#play').click(); await page.waitForTimeout(600); await page.locator('#play').click();
    expect(requests.length).toBe(requestCount);
    await context.setOffline(false);
    await page.locator('#recording').selectOption('4ad7c124-430c-4723-b338-daf59e4c45da');
    await expect(page.locator('#mission-title')).toHaveText('Hold the crossing');
    await expect(page.locator('#play')).toBeEnabled();
    await page.locator('#scrub').fill('25');
    await expect(page.locator('#clock')).toHaveText('25.00s');
    await page.locator('#results-tab').click();
    await expect(page.locator('#rows tr')).toHaveCount(45);
    await expect(page.locator('#summary tr')).toHaveCount(3);
    if (name === 'desktop') await page.screenshot({ path: 'images/results-desktop.png', fullPage: true });
    await page.locator('#rows button').first().click(); await expect(page.locator('#replay-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#play')).toBeEnabled();
    expect(requests.filter(r => r.method !== 'GET' || new URL(r.url).origin !== new URL(baseURL).origin || /\/api\/|systemone|vercel\.com|typesafe\.ai|11434/.test(r.url))).toEqual([]);
    expect(errors).toEqual([]);
  });
}
test('selection races and invalid deep links do not replace the current recording', async ({ page }) => {
  await page.goto('./?replay=not-a-recording');
  await expect(page.locator('#play')).toBeEnabled();
  await expect(page.locator('#recording')).toHaveValue('832e3d55-2c52-492a-a473-c8a58051e5c0');
  await page.route('**/data/replays/4ad7c124-*.json', async route => { await new Promise(resolve => setTimeout(resolve, 400)); await route.continue().catch(() => {}); });
  await page.locator('#recording').selectOption('4ad7c124-430c-4723-b338-daf59e4c45da');
  await page.locator('#recording').selectOption('832e3d55-2c52-492a-a473-c8a58051e5c0');
  await page.waitForTimeout(700);
  await expect(page.locator('#mission-title')).toHaveText('Withdraw the squad');
  await expect(page.locator('#play')).toBeEnabled();
});
test('every archived replay loads, verifies, and reaches its recorded terminal state', async ({ page }) => {
  await page.goto('./'); await expect(page.locator('#play')).toBeEnabled();
  const ids = await page.locator('#recording option').evaluateAll(options => options.map(o => o.value));
  expect(ids).toHaveLength(48);
  for (const id of ids) {
    await page.locator('#recording').selectOption(id);
    await expect(page.locator('#play')).toBeEnabled();
    await expect(page.locator('#error')).toBeHidden();
    const end = await page.locator('#scrub').getAttribute('max');
    await page.locator('#scrub').fill(end);
    await expect(page.locator('#clock')).toHaveText(`${Number(end).toFixed(2)}s`);
    await expect(page.locator('#units .unit')).toHaveCount(3);
    await expect(page.locator('#metrics')).not.toContainText('undefined');
  }
});
