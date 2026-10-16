import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readProductInstanceId } from './instance-identity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'zcc-instance-')); roots.push(path); return path; };
it('persists one private identity independent of other instances', () => {
  const dir = root(), id = readProductInstanceId(dir);
  expect(readProductInstanceId(dir)).toBe(id);
  expect(readProductInstanceId(root())).not.toBe(id);
  expect(statSync(join(dir, 'product-instance.json')).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(['product-instance.json']);
});
it('rejects symlinks, hard links, public files and unsafe directories', () => {
  for (const kind of ['symlink', 'hardlink', 'public', 'directory']) {
    const dir = root(), other = root(), id = readProductInstanceId(other), file = join(dir, 'product-instance.json');
    if (kind === 'symlink') symlinkSync(join(other, 'product-instance.json'), file);
    if (kind === 'hardlink') linkSync(join(other, 'product-instance.json'), file);
    if (kind === 'public') writeFileSync(file, JSON.stringify({ id }), { mode: 0o644 });
    if (kind === 'directory') mkdirSync(file);
    expect(() => readProductInstanceId(dir)).toThrow();
  }
  const dir = root(); chmodSync(dir, 0o777);
  expect(() => readProductInstanceId(dir)).toThrow('Invalid product instance directory');
});
it('refuses to silently replace damaged identities', () => {
  for (const contents of ['{}', 'invalid', '{"id":"other"}', 'x'.repeat(1025)]) {
    const dir = root(), path = join(dir, 'product-instance.json'); writeFileSync(path, contents);
    expect(() => readProductInstanceId(dir)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(contents);
  }
});
it('refuses to mint a replacement when established pair storage loses its identity', () => {
  const dir = root(); mkdirSync(join(dir, 'peer-pairs'), { mode: 0o700 });
  expect(() => readProductInstanceId(dir)).toThrow('Product instance identity missing after peer initialization');
  expect(readdirSync(dir)).toEqual(['peer-pairs']);
});
