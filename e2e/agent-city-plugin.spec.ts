import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { startMobileGateway } from '../apps/server/src/mobile/gateway.js';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from './fixtures/app.js';
import { interiorLayout, interiorScreen } from '../plugins/agent-city/interior.js';

const exec = promisify(execFile);
test.use({ initialConfig: { sponsorPromptDismissed: true }, launchEnv: { ZCC_FAKE_PROVIDER: '1' } });

test('Agent City adds the fourth Agents view, opens real work, reloads and falls back on disable', async ({ app, home }, testInfo) => {
  // Full desktop and three mobile sizes, including two real plugin builds.
  test.setTimeout(480_000);
  const source = join(home, 'agent-city');
  cpSync(resolve('plugins/agent-city'), source, { recursive: true, filter: (path) => !path.includes('node_modules') });
  const copiedCli = join(home, 'cli');
  cpSync(resolve('packages/cli/dist'), copiedCli, { recursive: true, dereference: true });
  const env = { ...process.env, HOME: home, ZCC_DATA_DIR: join(home, '.zcc'), ZCC_SERVER_URL: new URL(app.window.url()).origin,
    ZCC_SESSION_ID: undefined, ZCC_SESSION_TOKEN: undefined, ZCC_SKIP_PLUGIN_NPM: '1', NODE_PATH: '', ESBUILD_BINARY_PATH: '' };
  async function run(args: string[]) {
    return exec(process.execPath, [join(copiedCli, 'bin/zcc'), ...args], { cwd: source, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  }
  // Seed real host-owned pending state, as in the approval-layout boundary spec.
  const auth = JSON.parse(readFileSync(join(home, '.zcc', 'auth.json'), 'utf8'));
  async function hostRequest(path: string, body: unknown) {
    const response = await fetch(new URL(`/internal/hosts/${path}`, app.window.url()), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-zcc-host-id': auth.hostId, authorization: `Bearer ${auth.hostKey}` }, body: JSON.stringify(body)
    });
    const result = await response.json(); expect(response.ok).toBe(true); expect(result.outcome).not.toBe('rejected'); return result;
  }
  const root = join(home, 'city-project'); mkdirSync(root);
  const seed = await app.window.evaluate(async (path) => {
    const projectResponse = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    if (!projectResponse.ok) throw new Error(await projectResponse.text());
    const { project } = await projectResponse.json();
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.id, providerId: 'fake', title: 'City live agent', input: 'Hello' }) });
    if (!response.ok) throw new Error(await response.text());
    const { thread } = await response.json();
    return { projectId: project.id, threadId: thread.id };
  }, root);
  const additionalRoots = Array.from({ length: 10 }, (_, i) => join(home, `city-neighbor-${i + 1}`));
  for (const path of additionalRoots) mkdirSync(path);
  const waitForIdle = async (id: string) => {
    await expect.poll(() => app.window.evaluate(async (id) =>
      (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id), { timeout: 30_000 }).toBe('idle');
  };
  await waitForIdle(seed.threadId);
  const projectIds = await app.window.evaluate(async (paths) => {
    const ids: string[] = [];
    for (const [i, path] of paths.entries()) {
      const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      if (!response.ok) throw new Error(await response.text());
      const { project } = await response.json();
      ids.push(project.id);
      if (i === 8) {
        const plan = await window.cc.scheduler.create({ projectId: project.id, scope: { projectId: project.id }, name: 'City scheduled arrival', every: '24h', profile: 'codex', enabled: false });
        if (!plan.ok) throw new Error(JSON.stringify(plan));
      }
    }
    return ids;
  }, additionalRoots);
  async function addIdleWorker(projectId: string, title: string) {
    const id = await app.window.evaluate(async (row) => {
      const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...row, providerId: 'fake', input: 'Hello' }) });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).thread.id as string;
    }, { projectId, title });
    // Establish the state required by the interior assertions before starting
    // the next fake session; concurrent startup is a separate runtime concern.
    await waitForIdle(id);
    return id;
  }
  for (let i = 0; i < 8; i++) {
    await addIdleWorker(projectIds[i], `Neighbor ${i}`);
    if (i < 2) for (let j = 0; j < (i === 0 ? 4 : 2); j++) {
      await addIdleWorker(projectIds[i], `${i === 0 ? 'Tower' : 'Office'} worker ${j}`);
    }
  }
  const errors: string[] = [];
  app.window.on('pageerror', (error) => errors.push(error.message));
  await run(['plugin', 'install', '.']);
  const navigate = async (path: string) => app.window.evaluate((url) => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await navigate('/extensions/plugins');
  await expect(app.window.locator('a[href*="/extensions/pages/agent-city/"]')).toHaveCount(0);
  await navigate('/agents');
  const toggle = app.window.getByRole('group', { name: 'Agents view', exact: true }).filter({ visible: true });
  await expect(toggle.getByRole('button')).toHaveCount(4);
  await expect(toggle.getByRole('button').nth(3)).toHaveAccessibleName('World view');
  const calendar = app.window.getByRole('group', { name: 'Scheduled column' }).filter({ visible: true }).getByRole('button');
  if (await calendar.getAttribute('aria-pressed') !== 'true') await calendar.click();
  await toggle.getByRole('button', { name: 'World view' }).click();
  const city = app.window.getByTestId('agent-city');
  await expect(city).toBeVisible();
  await expect.poll(() => app.window.evaluate(async () =>
    (await window.cc.config.get()).agentsBoardView)).toBe('plugin:agent-city/world');
  async function expectCityAfterReload() {
    try {
      // A reload rehydrates config and imports the installed plugin bundle.
      // Keep this startup budget distinct from ordinary in-view assertions.
      await expect(city).toBeVisible({ timeout: 60_000 });
    } catch (error) {
      const state = await app.window.evaluate(() => ({
        url: location.href, title: document.title, desktop: 'cc' in window,
        body: document.body.innerText.slice(0, 12_000),
        views: [...document.querySelectorAll('.agents-view-toggle button')].map(button => ({
          label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed')
        }))
      }));
      await testInfo.attach('city-reload-state', {
        body: Buffer.from(JSON.stringify({ ...state, errors })), contentType: 'application/json'
      });
      throw error;
    }
  }
  await city.getByRole('button', { name: 'Pause motion' }).click();
  await expect(city.getByRole('button', { name: /district/i })).toHaveCount(0);
  const map = city.locator('.city-world');
  await expect(city).toHaveCSS('border-radius', '0px');
  await expect(map).toHaveCSS('border-radius', '0px');
  async function expectBuildingsInsideMap() {
    const { bounds, boxes } = await city.evaluate(root => {
      const bounds = root.querySelector('.city-world')!.getBoundingClientRect().toJSON();
      const boxes = [...root.querySelectorAll('.city-label')].map(label => label.getBoundingClientRect().toJSON());
      return { bounds, boxes };
    });
    expect(bounds.width).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.y).toBeGreaterThanOrEqual(bounds.y);
      expect(box.right).toBeLessThanOrEqual(bounds.right);
      expect(box.bottom).toBeLessThanOrEqual(bounds.bottom);
    }
  }
  // Hash all pixels: tiny thumbnails can erase subpixel commuter motion on
  // software-rendered Linux. Keep the trace bounded to a digest per sample.
  const frame = () => city.locator('canvas').evaluate(async (canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  });
  for (let i = 1; i <= 8; i++) await expect(city.getByRole('button', { name: new RegExp(`city-neighbor-${i}, ${i === 1 ? 5 : i === 2 ? 3 : 1} live`) })).toBeInViewport();
  await expect(city.getByRole('button', { name: /city-neighbor-9, 0 live agents.*1 scheduled plans/ })).toBeInViewport();
  await expect(city.getByRole('button', { name: /city-neighbor-10,/ })).toHaveCount(0);
  await expect(city.getByRole('button', { name: /city-project, 1 live/ })).toHaveAttribute('data-building-form', 'house');
  await expect(city.getByRole('button', { name: /city-neighbor-1, 5 live/ })).toHaveAttribute('data-building-form', 'tower');
  await expect(city.getByRole('button', { name: /city-neighbor-2, 3 live/ })).toHaveAttribute('data-building-form', 'office');
  await expect(city.getByRole('button', { name: /city-neighbor-9,/ })).toHaveAttribute('data-building-form', 'house');
  await expect(city.getByRole('button', { name: /city-project, 1 live/ })).toHaveAttribute('data-commuters', '8');
  await expect(city.getByRole('button', { name: /city-neighbor-1, 5 live/ })).toHaveAttribute('data-commuters', '40');
  await expect(city.getByRole('button', { name: /city-neighbor-9,/ })).toHaveAttribute('data-commuters', '4');
  await expect(city.getByLabel('Worker colors by harness')).toContainText('Codex');
  await expect(city.getByLabel('Worker colors by harness')).toContainText('Fake');
  const plots = await city.locator('.city-label').evaluateAll((labels) => labels.map((el) => [el.getAttribute('data-project-id'), el.getAttribute('style')]));
  const search = app.window.getByLabel('Filter agents');
  await search.fill('Tower worker');
  await expect(city.getByRole('button', { name: /city-neighbor-1, 5 live/ })).toHaveAttribute('data-building-form', 'tower');
  expect(await city.locator('.city-label').evaluateAll((labels) => labels.map((el) => [el.getAttribute('data-project-id'), el.getAttribute('style')]))).toEqual(plots);
  await search.fill('no-agent-matches-this');
  await expect(city.locator('.city-label[data-search-match=true]')).toHaveCount(0);
  await expect(city.locator('.city-label')).toHaveCount(plots.length);
  await search.fill('');
  expect(await city.locator('.city-label').evaluateAll((labels) => labels.map((el) => [el.getAttribute('data-project-id'), el.getAttribute('style')]))).toEqual(plots);
  // Themes change only artwork: the same buildings stay labeled, inside the map and reachable.
  const themePicker = city.getByLabel('City theme');
  const classicFrame = await frame();
  for (const [value, tagline] of [['sf', 'one city by the Bay'], ['zh', 'one city on the lake']]) {
    await themePicker.selectOption(value);
    await expect(city).toHaveAttribute('data-city-theme', value);
    await expect(city.getByText(tagline)).toBeVisible();
    await expect(city.locator('.city-label')).toHaveCount(plots.length);
    await expect.poll(frame).not.toBe(classicFrame);
    await expectBuildingsInsideMap();
    await app.window.screenshot({ path: testInfo.outputPath(`city-theme-${value}.png`) });
  }
  await themePicker.selectOption('classic');
  await expect(city).toHaveAttribute('data-city-theme', 'classic');
  expect(await city.locator('.city-label').evaluateAll((labels) => labels.map((el) => [el.getAttribute('data-project-id'), el.getAttribute('style')]))).toEqual(plots);
  await city.getByRole('button', { name: /city-neighbor-9,/ }).click();
  await expect(city.getByRole('button', { name: 'Schedule board: City scheduled arrival' })).toBeVisible();
  await expect(city.getByRole('group', { name: 'Agents on this floor' }).getByRole('button')).toHaveCount(1);
  await expect(map).toHaveAttribute('data-interior-workers', '1');
  await expect(map).toHaveAttribute('data-desk-workers', '1');
  await expect(map).toHaveAttribute('data-idle-workers', '0');
  await expect(city.getByText('1 on this floor · 0 live agents in building · 1 planned')).toBeVisible();
  await app.window.screenshot({ path: testInfo.outputPath('city-interior-planned.png') });
  await city.getByRole('button', { name: /Back to city/ }).click();
  await city.getByRole('button', { name: /city-neighbor-1, 5 live/ }).click();
  await expect(city.getByLabel('Building floor')).toHaveValue('1');
  await expect(city.getByLabel('Agents on this floor').getByRole('button')).toHaveCount(4);
  await expect(map).toHaveAttribute('data-interior-workers', '4');
  await expect(map).toHaveAttribute('data-idle-workers', '4');
  await expect(map).toHaveAttribute('data-desk-workers', '0');
  await expect(city.getByText('4 on this floor · 5 live agents in building')).toBeVisible();
  const seatedNames = await city.locator('.city-workstation strong').allTextContents();
  const towerId = await city.getByLabel('Find a project building').inputValue();
  const newWorkerId = await addIdleWorker(towerId, 'Interior arrival');
  await expect(city.getByText('4 on this floor · 6 live agents in building')).toBeVisible();
  expect(await city.locator('.city-workstation strong').allTextContents()).toEqual(seatedNames);
  await hostRequest('interactive-request', { sessionId: newWorkerId, interaction: {
    threadId: newWorkerId, turnId: 'turn-1', providerId: 'fake', providerThreadId: 'provider-1', providerRequestId: 'city-request',
    payload: { kind: 'approval', reason: 'City attention fixture', availableDecisions: ['allow_once', 'deny'],
      subject: { kind: 'command', itemId: 'city-request', command: 'true', cwd: root, actions: [], sessionGrant: null } }
  } });
  await city.getByRole('button', { name: 'Find next request · 1', exact: true }).click();
  await expect(city.getByLabel('Building floor')).toHaveValue('2');
  await expect(city.getByRole('button', { name: 'Worker Interior arrival, Needs you', exact: true })).toHaveAttribute('data-highlighted', 'true');
  await expect(map).toHaveAttribute('data-desk-workers', '1');
  await app.window.screenshot({ path: testInfo.outputPath('city-interior-request.png') });
  await city.getByLabel('Building floor').selectOption('1');
  await hostRequest('interactive-request/interrupt', { sessionId: newWorkerId, providerId: 'fake', threadIds: [newWorkerId], reason: 'City attention fixture complete' });
  await app.window.evaluate(async (id) => {
    const response = await fetch(`/api/v1/threads/${id}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(await response.text());
  }, newWorkerId);
  await expect(city.getByText('4 on this floor · 5 live agents in building')).toBeVisible();
  expect(await city.locator('.city-workstation strong').allTextContents()).toEqual(seatedNames);
  await app.window.screenshot({ path: testInfo.outputPath('city-interior-tower.png') });
  await city.getByLabel('Building floor').selectOption('2');
  await expect(city.getByLabel('Agents on this floor').getByRole('button')).toHaveCount(1);
  const upperWorker = city.getByLabel('Agents on this floor').getByRole('button');
  const upperTitle = await upperWorker.locator('strong').innerText();
  await city.getByRole('button', { name: 'Take elevator to Floor 3' }).click();
  await expect(city.getByLabel('Building floor')).toHaveValue('3');
  await city.getByRole('button', { name: `Find worker ${upperTitle}`, exact: true }).click();
  await expect(city.getByLabel('Building floor')).toHaveValue('2');
  await expect(city.getByLabel('Agents on this floor').getByRole('button')).toHaveAttribute('data-highlighted', 'true');
  await city.getByLabel('Building floor').selectOption('0');
  await expect(city.getByText(/Welcome in/)).toBeVisible();
  await app.window.screenshot({ path: testInfo.outputPath('city-interior-lobby.png') });
  await city.getByLabel('Building floor').selectOption('6');
  await expect(city.getByText(/breathing room/)).toBeVisible();
  await app.window.screenshot({ path: testInfo.outputPath('city-interior-roof.png') });
  await city.getByRole('button', { name: /Back to city/ }).click();
  await city.getByRole('button', { name: /city-neighbor-2, 3 live/ }).click();
  await expect(city.getByLabel('Building floor')).toHaveValue('0');
  await expect(city.getByLabel('Agents on this floor').getByRole('button')).toHaveCount(3);
  await app.window.screenshot({ path: testInfo.outputPath('city-interior-office.png') });
  await app.window.keyboard.press('Escape');
  await expect(city.getByRole('button', { name: /city-neighbor-2, 3 live/ })).toBeFocused();
  await app.window.bringToFront();
  await expect.poll(() => app.window.evaluate(() => document.visibilityState)).toBe('visible');
  await city.getByRole('button', { name: 'Resume motion' }).click();
  const firstFrame = await frame();
  // SwiftShader canvas readback can take several seconds under Xvfb.
  await expect.poll(frame, { timeout: 60_000 }).not.toBe(firstFrame);
  await city.getByRole('button', { name: 'Pause motion' }).click();
  await expectBuildingsInsideMap();
  await city.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(city.getByLabel('Map zoom level')).toHaveText('125%');
  const mapBounds = (await map.boundingBox())!;
  await app.window.mouse.move(mapBounds.x + 25, mapBounds.y + 80);
  await app.window.mouse.down();
  await app.window.mouse.move(mapBounds.x + 100, mapBounds.y + 100, { steps: 5 });
  await app.window.mouse.up();
  await expect(map).toHaveAttribute('data-dragging', 'false');
  await expect(city.getByRole('complementary')).toHaveCount(0);
  await city.getByRole('button', { name: 'Fit city', exact: true }).click();
  await expect(city.getByLabel('Map zoom level')).toHaveText('100%');
  await expectBuildingsInsideMap();
  const arrival = join(home, 'city-new-arrival'); mkdirSync(arrival);
  const arrivalProjectId = await app.window.evaluate(async (path) => {
    const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).project.id as string;
  }, arrival);
  await expect(city.getByRole('button', { name: /city-new-arrival,/ })).toHaveCount(0);
  await app.window.evaluate(async (projectId) => {
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, providerId: 'fake', title: 'New commuter', input: 'Hello' }) });
    if (!response.ok) throw new Error(await response.text());
  }, arrivalProjectId);
  await expect(city.getByRole('button', { name: /city-new-arrival, 1 live/ })).toBeInViewport();
  await expectBuildingsInsideMap();
  await app.window.screenshot({ path: testInfo.outputPath('city-continuous.png') });
  await city.getByLabel('Find a project building').selectOption(seed.projectId);
  await expect(city.locator('.city-member').filter({ hasText: 'City live agent' })).toBeVisible();
  await expect(city.getByRole('button', { name: /Worker City live agent,/ })).toBeVisible();
  await expect(map).toHaveAttribute('data-interior-workers', '1');
  await expect(map).toHaveAttribute('data-idle-workers', '1');
  await expect(map).toHaveAttribute('data-desk-workers', '0');
  await expect(city.getByRole('button', { name: 'Resume motion' })).toHaveAttribute('aria-pressed', 'true');
  // Selecting an interior schedules one paint even while motion is paused.
  // Wait for that scene paint, then require a stable interval.
  await expect.poll(async () => {
    const pausedFrame = await frame();
    await app.window.waitForTimeout(250);
    return await frame() === pausedFrame;
  }).toBe(true);
  await app.window.screenshot({ path: testInfo.outputPath('city-desktop.png') });
  const canvasBounds = (await city.locator('canvas').boundingBox())!;
  const [deskX, deskY] = interiorScreen(42, 198, 69, interiorLayout(canvasBounds.width, canvasBounds.height));
  await city.locator('canvas').click({ position: { x: deskX, y: deskY } });
  const inspector = app.window.getByRole('dialog', { name: 'City live agent', exact: true });
  await expect(inspector).toBeVisible();
  await inspector.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(city.getByRole('button', { name: /Back to city/ })).toBeVisible();
  await app.window.keyboard.press('Escape');
  await expect(city.getByLabel('Map zoom level')).toHaveText('100%');
  await navigate('/agents');
  await expect(city).toBeVisible();
  // Motion was verified above. Keep cold reload checks still on software GPUs.
  await app.window.emulateMedia({ reducedMotion: 'reduce' });
  await app.window.reload();
  await expectCityAfterReload();
  const station = city.getByRole('button', { name: /Scheduler station/ });
  await station.focus();
  await station.press('Enter');
  await expect(city.getByRole('heading', { name: 'Scheduler station' })).toBeVisible();
  // Live reload proves the host drops the old generation and mounts the rebuilt plugin.
  const appPath = join(source, 'city-app.tsx');
  writeFileSync(appPath, readFileSync(appPath, 'utf8').replace('Your agents, a little more alive.', 'City reload verified'));
  await run(['plugin', 'dev', '--once']);
  await expect(city.getByRole('heading', { name: 'City reload verified' })).toBeVisible();
  await app.window.bringToFront();
  await app.window.reload();
  await expectCityAfterReload();
  await expect(city.getByRole('button', { name: 'Reduced motion' })).toBeDisabled();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const serverUrl = `http://127.0.0.1:${port}`;
  const gateway = await startMobileGateway({ upstream: new URL(app.window.url()).origin, publicUrl: serverUrl, port });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const paired = await context.request.post(`${serverUrl}/_mobile/pair`, { data: { code: gateway.pair().code, label: 'City E2E' } });
    const credential = await paired.json();
    expect((await context.request.post(`${serverUrl}/_mobile/session`, { headers: { authorization: `Bearer ${credential.credential}` } })).ok()).toBe(true);
    const phone = await context.newPage();
    await phone.goto(serverUrl + '/agents');
    await phone.getByRole('button', { name: 'Agents actions', exact: true }).click();
    await phone.getByRole('button', { name: 'World view', exact: true }).filter({ visible: true }).click();
    await expect(phone.getByTestId('agent-city')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Reduced motion' })).toBeDisabled();
    await phone.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(phone.getByRole('button', { name: 'Pause motion' })).toBeEnabled();
    await phone.emulateMedia({ reducedMotion: 'reduce' });
    await expect(phone.getByRole('button', { name: 'Reduced motion' })).toBeDisabled();
    for (const width of [320, 390, 820]) {
      await phone.setViewportSize({ width, height: 844 });
      await phone.getByLabel('Find a project building').selectOption(seed.projectId);
      await expect(phone.getByRole('button', { name: /Worker City live agent,/ })).toBeVisible();
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await phone.getByRole('button', { name: /Back to city/ }).scrollIntoViewIfNeeded();
      await phone.screenshot({ path: testInfo.outputPath(`city-interior-mobile-${width}.png`) });
      await phone.getByRole('button', { name: /Worker City live agent,/ }).click();
      // The mobile host opens its first-class conversation page instead of the desktop overlay.
      await expect(phone).toHaveURL(new RegExp(`/threads/${seed.threadId}`));
      await expect(phone.getByRole('heading', { name: 'City live agent', exact: true })).toBeVisible();
      await phone.getByRole('link', { name: 'Back to agents', exact: true }).click();
      await expect(phone.getByTestId('agent-city')).toBeVisible();
      await expect(phone.getByRole('button', { name: /Worker City live agent,/ })).toHaveAttribute('data-highlighted', 'true');
      await expect(phone.getByRole('button', { name: /Back to city/ })).toBeVisible();
      await phone.getByRole('button', { name: /Back to city/ }).click();
      const tower = phone.getByRole('button', { name: /city-neighbor-1, 5 live/ });
      await tower.click();
      await phone.getByLabel('Building floor').selectOption('2');
      await expect(phone.getByLabel('Agents on this floor').getByRole('button')).toHaveCount(1);
      const towerWorker = phone.getByLabel('Agents on this floor').getByRole('button'), towerTitle = await towerWorker.locator('strong').innerText();
      await towerWorker.click();
      await expect(phone.getByRole('heading', { name: towerTitle, exact: true })).toBeVisible();
      await phone.getByRole('link', { name: 'Back to agents', exact: true }).click();
      await expect(phone.getByLabel('Building floor')).toHaveValue('2');
      await expect(phone.getByLabel('Agents on this floor').getByRole('button')).toHaveAttribute('data-highlighted', 'true');
      await phone.getByLabel('Building floor').selectOption('6');
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await phone.getByRole('button', { name: /Back to city/ }).click();
    }
  } finally {
    await browser.close();
    await gateway.close();
  }
  await run(['plugin', 'disable', 'agent-city']);
  await expect(city).toHaveCount(0);
  await expect(app.window.getByRole('button', { name: 'World view', exact: true })).toHaveCount(0);
  await expect(app.window.getByRole('button', { name: 'Board view', exact: true }).filter({ visible: true })).toHaveAttribute('aria-pressed', 'true');
  await run(['plugin', 'enable', 'agent-city']);
  await expect(city).toBeVisible();
  // The guide's selector marker must open the new API documentation in the built host.
  const guideSource = join(home, 'plugin-guide');
  cpSync(resolve('plugins/plugin-guide'), guideSource, { recursive: true, filter: (path) => !path.includes('node_modules') });
  await run(['plugin', 'install', guideSource]);
  await navigate('/extensions/pages/plugin-guide/plugin-guide/project-shell');
  const viewMarker = app.window.locator('a[data-guide-region="experimental_agentsView"]').filter({ visible: true });
  await expect(viewMarker).toBeVisible();
  await viewMarker.click();
  const guideCard = app.window.getByRole('dialog', { name: 'Agents view', exact: true });
  await expect(guideCard).toBeVisible();
  await expect(guideCard).toContainText('Board, List and Flow');
  await expect(guideCard).toContainText('onInspect(item.key)');
  await expect(guideCard.getByRole('button', { name: 'Copy for agent', exact: true })).toBeVisible();
  await guideCard.scrollIntoViewIfNeeded();
  await expect(guideCard.getByRole('button', { name: 'Copy for agent', exact: true })).toBeInViewport();
  await app.window.screenshot({ path: testInfo.outputPath('agents-view-guide.png') });
  expect(errors).toEqual([]);
});
