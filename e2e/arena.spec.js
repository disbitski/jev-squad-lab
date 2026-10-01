import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeEach(async ({ request }) => {
  const config = await (await request.get('/api/config')).json();
  expect(config.provider.name === 'ollama' || !config.provider.ready, 'Browser checks require local Nimble or disabled paid inference').toBe(true);
});

test('desktop battlefield renders, moves, pauses and resets', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 1000 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('#access')).toHaveText(/Jev key required|Jev configured \/ paused|Nimble connected \/ local/);
  await page.getByRole('button', { name: 'Reset battle', exact: true }).click();
  await page.getByRole('button', { name: 'Start battle', exact: true }).click();
  await expect(page.locator('#clock')).not.toHaveText('00:00');
  const snapshot = async () => page.evaluate(() => { const canvas = document.querySelector('canvas'); const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let nonblank = 0, checksum = 0; for (let i = 0; i < data.length; i += 64) { if (data[i] > 20 || data[i + 1] > 20) nonblank++; checksum += data[i] + data[i + 1] * 3 + data[i + 2] * 7; } return { nonblank, checksum }; });
  const before = await snapshot(); expect(before.nonblank).toBeGreaterThan(5000);
  await expect(page.locator('#clock')).toHaveText('00:03');
  const after = await snapshot(); expect(after.checksum).not.toBe(before.checksum);
  await page.getByRole('button', { name: 'Pause battle', exact: true }).click(); await expect(page.locator('#run-status')).toHaveText('paused');
  await mkdir('.local/screenshots', { recursive: true }); await page.screenshot({ path: '.local/screenshots/desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('replay scrub and playback make no further network requests', async ({ page, context }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Replays', exact: true }).click();
  await page.getByRole('button', { name: 'Watch replay', exact: true }).first().click();
  await expect(page.locator('#run-status')).toHaveText('Recorded replay');
  await expect(page.locator('#access')).toHaveText('Recorded replay / no API calls');
  await context.setOffline(true);
  const lastFrame = Number(await page.locator('#scrub').getAttribute('max'));
  expect(lastFrame).toBeGreaterThan(1);
  await page.locator('#scrub').fill(String(Math.floor(lastFrame / 2)));
  await expect(page.locator('#scrub')).not.toHaveValue('0');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click(); const before = await page.locator('#scrub').inputValue();
  await expect.poll(() => page.locator('#scrub').inputValue()).not.toBe(before);
  await context.setOffline(false);
});

test('recorded Nimble and historical Jev keep distinct identities without inference', async ({ page, request, browser }) => {
  const before = await (await request.get('/api/state')).json();
  const records = await (await request.get('/api/runs')).json();
  const nimble = records.find(r => r.meta.provider === 'ollama' && r.meta.controller === 'jev' && r.meta.mode === 'scored');
  test.skip(!nimble, 'No scored Nimble fixture recorded yet');
  const outbound = [];
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith('http://127.0.0.1:4196/')) outbound.push(r.url()); });
  await page.goto('/'); await page.getByRole('button', { name: 'Replays', exact: true }).click();
  await page.locator(`[data-replay="${nimble.meta.id}"]`).click();
  await expect(page.locator('#run-status')).toHaveText('Recorded replay');
  await expect(page.locator('#model')).toHaveText('nimble:latest');
  await expect(page.locator('#model-controller')).toHaveText('Nimble');
  await expect(page.locator('#cost-basis')).toHaveText('Local / no API charge');
  const last = Number(await page.locator('#scrub').getAttribute('max'));
  expect(last).toBeGreaterThan(1);
  await page.locator('#scrub').evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true })); }, Math.floor(last / 2));
  await expect(page.locator('#clock')).not.toHaveText('00:00');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await expect.poll(() => page.locator('#scrub').inputValue()).not.toBe(String(Math.floor(last / 2)));
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  const profile = nimble.meta.tacticalBrief === 'guided-v2' ? 'guided-v2' : 'v1';
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page.screenshot({ path: `.local/screenshots/nimble-${profile}-replay-desktop.png`, fullPage: true });
  // Fresh viewport avoids carrying desktop scroll/compositor state into phone captures.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  mobile.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith('http://127.0.0.1:4196/')) outbound.push(r.url()); });
  try {
    await mobile.goto(`http://127.0.0.1:4196/?replay=${nimble.meta.id}`);
    await expect(mobile.locator('#run-status')).toHaveText('Recorded replay');
    await mobile.locator('#scrub').fill(String(Math.floor(last / 2)));
    for (const [selector, suffix] of [['body', '-controls'], ['#battlefield', ''], ['.evidence', '-evidence']]) {
      await mobile.locator(selector).evaluate(el => el.scrollIntoView({ block: 'start' }));
      await mobile.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await mobile.screenshot({ path: `.local/screenshots/nimble-${profile}-replay-mobile${suffix}.png`, animations: 'disabled' });
    }
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await mobile.close(); }
  const jev = records.find(r => r.meta.provider === 'vercel' && r.meta.controller === 'jev');
  if (jev) {
    await page.getByRole('button', { name: 'Replays', exact: true }).click();
    await page.locator(`[data-replay="${jev.meta.id}"]`).click();
    await expect(page.locator('#model')).toHaveText('typesafe-ai/jev');
    await expect(page.locator('#model-controller')).toHaveText('Jev');
    await expect(page.locator('#provider-status')).toHaveText('vercel / typesafe-ai/jev / recorded');
  }
  const after = await (await request.get('/api/state')).json();
  expect(after.provider.budget.requests).toBe(before.provider.budget.requests);
  expect(outbound).toEqual([]);
});

test('results review URL opens the table and its replay controls', async ({ page, request }) => {
  const results = await (await request.get('/api/results')).json();
  await page.goto('/?view=trials');
  await expect(page.locator('#trials-view')).toBeVisible();
  await expect(page.locator('#trial-rows tr')).toHaveCount(results.rows.length);
  const recorded = results.rows.find(r => r.controller === 'jev');
  test.skip(!recorded, 'No model trial recorded yet');
  await page.locator(`#trial-rows [data-replay="${recorded.id}"]`).click();
  await expect(page.locator('#run-status')).toHaveText('Recorded replay');
});

test('evaluation history separates calibration from scored results without inference', async ({ page, request }) => {
  const before = await (await request.get('/api/state')).json();
  const history = await (await request.get('/api/evaluations')).json();
  const baseline = history.find(e => e.profile === 'unbriefed-v1');
  const calibration = history.find(e => e.phase === 'calibration');
  test.skip(!baseline || !calibration, 'History fixtures not available');
  await page.goto('/?view=trials');
  await page.locator('#evaluation').selectOption(baseline.id);
  await expect(page.locator('#trial-rows tr')).toHaveCount(baseline.count);
  await page.locator('#evaluation').selectOption(calibration.id);
  await expect(page.locator('#trial-status')).toHaveText(/Exploratory calibration only/);
  await expect(page.locator('#trial-rows tr')).toHaveCount(calibration.count);
  await page.locator('#evaluation').selectOption('');
  const latest = await (await request.get('/api/results')).json();
  await expect(page.locator('#trial-rows tr')).toHaveCount(latest.rows.length);
  await expect(page.locator('#trial-summary tr')).toHaveCount(latest.controllers?.length === 3 ? 9 : 6);
  const after = await (await request.get('/api/state')).json();
  expect(after.provider.budget.requests).toBe(before.provider.budget.requests);
});

test('fresh desktop and mobile evaluation captures retain the complete result table', async ({ browser, request }) => {
  const before = await (await request.get('/api/state')).json();
  const results = await (await request.get('/api/results')).json();
  await mkdir('.local/screenshots', { recursive: true });
  for (const [label, viewport] of [['desktop', { width: 1512, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await page.goto('http://127.0.0.1:4196/?view=trials');
      await expect(page.locator('#trial-rows tr')).toHaveCount(results.rows.length);
      await expect(page.locator('#trial-summary tr')).toHaveCount(results.controllers?.length === 3 ? 9 : 6);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.local/screenshots/evaluation-${label}.png`, animations: 'disabled' });
    } finally { await page.close(); }
  }
  const after = await (await request.get('/api/state')).json();
  expect(after.provider.budget.requests).toBe(before.provider.budget.requests);
});

test('direct winning replay link retains objective and tactical reference is playable', async ({ page, request }) => {
  const records = await (await request.get('/api/runs')).json();
  const win = records.find(r => r.meta.tacticalBrief === 'guided-v2' && r.meta.controller === 'jev' && r.meta.mode === 'scored' && r.result.success);
  test.skip(!win, 'No scored model success available');
  await page.goto(`/?replay=${win.meta.id}`);
  await expect(page.locator('#run-status')).toHaveText('Recorded replay');
  await expect(page.locator('#brief-status')).toHaveText('Brief: guided-v2');
  const max = await page.locator('#scrub').getAttribute('max');
  await page.locator('#scrub').fill(max);
  await expect(page.locator('#outcome')).toContainText('Objective met');
  const reference = records.find(r => r.meta.controller === 'rules-tactical' && r.meta.mode === 'scored');
  await page.goto(`/?replay=${reference.meta.id}`);
  await expect(page.locator('#run-status')).toHaveText('Recorded replay');
  await expect(page.locator('#battle-decisions')).toHaveText('Tactical rules controller');
  await expect(page.locator('input[value="rules-tactical"]')).toBeChecked();
});

test('all missions and disabled-provider state are usable without paid calls', async ({ page, request }) => {
  const config = await (await request.get('/api/config')).json();
  await page.goto('/'); await page.getByRole('button', { name: 'Reset battle', exact: true }).click();
  await page.locator('#mission').selectOption('withdraw'); await page.getByRole('button', { name: 'Reset battle', exact: true }).click();
  await expect(page.locator('#mission-title')).toHaveText('Withdraw the squad');
  await page.locator('#model-controller').click();
  if (!config.provider.ready) {
    await page.getByRole('button', { name: 'Start battle', exact: true }).click();
    await expect(page.locator('#toast')).toHaveText(config.provider.reason);
  } else await expect(page.locator('#model-controller')).toHaveText('Nimble');
  await page.getByText('Rules', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Reset battle', exact: true }).click();
  const results = await (await request.get('/api/results')).json();
  await page.getByRole('button', { name: 'Trials', exact: true }).click(); await expect(page.locator('#trial-rows tr')).toHaveCount(results.rows.length);
});

test('mobile arena and results have no page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('#units .unit')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/screenshots/mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Trials', exact: true }).click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('connection labels distinguish configured access from temporary provider failures', async ({ page }) => {
  let state = 'not_checked';
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.provider = { ...data.provider, name: 'vercel', label: 'Jev', configured: true, ready: true, reason: 'Ready', throttleWaitMs: state === 'busy' ? 3000 : 0, connection: { state, checkedAt: '2026-09-26T22:00:00Z', httpStatus: state === 'busy' ? 429 : state === 'unavailable' ? 503 : 200 } };
    data.controller = 'jev';
    data.usage = { knownCostUsd: .00009513, attempts: 2, jevDecisions: 1, fallbackCount: 1, attemptsWithoutUsage: 1, throttledRequests: 1, inputTokens: 2265, costBasis: 'reported' };
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  for (const [next, label] of [['not_checked', 'Jev access configured'], ['busy', 'Jev throttled / cooldown 3s'], ['unavailable', 'Jev request failed'], ['available', 'Jev connected']]) {
    state = next;
    await expect(page.locator('#access')).toHaveText(label);
    await expect(page.locator('body')).not.toContainText('Jev access pending');
  }
  await expect(page.locator('#battle-cost')).toHaveText('$0.000095');
  await expect(page.locator('#cost-basis')).toHaveText('Gateway reported');
  await expect(page.locator('#battle-requests')).toHaveText('2');
  await expect(page.locator('#battle-usage-warning')).toContainText('1 request without usage');
  await expect(page.locator('#battle-decisions')).toHaveText('1 Jev decision / 1 rules fallback');
});

test('compact phone, tablet and wide desktop retain readable controls', async ({ page }) => {
  for (const width of [320, 360, 768, 1920]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/'); await expect(page.locator('canvas')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}px`).toBe(true);
    const start = await page.locator('#start').boundingBox(), clock = await page.locator('.clock').boundingBox();
    expect(start.x + start.width).toBeLessThan(clock.x);
  }
});
