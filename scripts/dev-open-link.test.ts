import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOpenLinkLaunch, validateLinkArg } from './dev-open-link.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dev-open-link', () => {
  it('accepts dev and prod plugin links', () => {
    expect(validateLinkArg('zana-dev://plugin/design-docs/peer/join?d=abc')).toBeNull();
    expect(validateLinkArg('zana://plugin/a/b')).toBeNull();
  });

  it.each([undefined, '', 'https://plugin/a/b', 'zana-dev://other/a', 'evil://plugin/a/b', 'zana-dev://plugin/a/b c', `zana-dev://plugin/a/b?d=${'x'.repeat(9000)}`])(
    'rejects %s',
    (link) => {
      expect(validateLinkArg(link as string)).toEqual(expect.any(String));
    }
  );

  it('launches the dev entry with the link, the isolated dev data dir, and no E2E home', () => {
    const home = mkdtempSync(join(tmpdir(), 'zcc-open-link-'));
    dirs.push(home);
    const launch = buildOpenLinkLaunch('zana-dev://plugin/a/b', { HOME: home, ZCC_E2E_HOME: '/leak' }, '/electron');
    expect(launch.command).toBe('/electron');
    expect(launch.args[0]).toMatch(/out-dev\/main\/index\.js$/);
    expect(launch.args[1]).toBe('zana-dev://plugin/a/b');
    expect(launch.env.ZCC_DATA_DIR).toBe(join(home, '.zcc-dev'));
    expect(launch.env.ZCC_E2E_HOME).toBeUndefined();
  });
});
