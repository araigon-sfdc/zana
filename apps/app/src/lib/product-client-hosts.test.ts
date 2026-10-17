// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
const http = vi.hoisted(() => ({ apiJson: vi.fn(async () => ({ ok: true })) }));
vi.mock('./fetch-with-app-surface.js', async (orig) => ({ ...(await orig<object>()), apiJson: http.apiJson }));
import { product } from './product-client';

afterEach(() => {
  http.apiJson.mockClear();
  delete (window as { cc?: unknown }).cc;
});

it('relaunches the local host over HTTP without a desktop bridge', async () => {
  await product.hosts.relaunchLocal();
  expect(http.apiJson).toHaveBeenCalledExactlyOnceWith('/hosts/relaunch-local', { method: 'POST', body: '{}' });
});

it('prefers the desktop relaunch IPC when the bridge provides it', async () => {
  const relaunchLocal = vi.fn(async () => ({ ok: true }));
  (window as { cc?: unknown }).cc = { hosts: { relaunchLocal } };
  await product.hosts.relaunchLocal();
  expect(relaunchLocal).toHaveBeenCalledOnce();
  expect(http.apiJson).not.toHaveBeenCalled();
});

it('falls back to HTTP relaunch when the desktop bridge lacks hosts', async () => {
  (window as { cc?: unknown }).cc = {};
  await product.hosts.relaunchLocal();
  expect(http.apiJson).toHaveBeenCalledExactlyOnceWith('/hosts/relaunch-local', { method: 'POST', body: '{}' });
});
