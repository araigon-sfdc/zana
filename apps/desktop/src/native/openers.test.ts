import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every spawn is recorded; `failing` commands emit ENOENT like a missing binary.
const h = vi.hoisted(() => ({
  spawns: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  failing: new Set<string>(),
  exes: new Map<string, string>()
}));
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    h.spawns.push({ cmd, args, opts });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), stderr: null });
    queueMicrotask(() => {
      if (h.failing.has(cmd)) child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      else child.emit('spawn');
    });
    return child;
  }
}));
vi.mock('electron', () => ({ shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() } }));
vi.mock('@zana-ai/zcc-server/services/projects/editor-windows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@zana-ai/zcc-server/services/projects/editor-windows')>()),
  resolveWindowsEditor: (_target: string, binary: string) => h.exes.get(binary) ?? null
}));

const { openIn } = await import('./openers.js');

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  onPlatform(realPlatform);
  h.spawns = [];
  h.failing = new Set();
  h.exes = new Map();
});

describe('openIn editors on Windows', () => {
  it('spawns the resolved Code.exe directly with the shim’s arguments, no shell', async () => {
    onPlatform('win32');
    h.exes.set('code', 'C:\\Microsoft VS Code\\Code.exe');
    const result = await openIn('code', 'C:\\work\\my project & co');
    expect(result).toEqual({ ok: true });
    expect(h.spawns).toEqual([
      { cmd: 'C:\\Microsoft VS Code\\Code.exe', args: ['-n', 'C:\\work\\my project & co'], opts: { detached: true, stdio: 'ignore' } }
    ]);
  });

  it('resolves the configured CLI launcher and passes IntelliJ just the path', async () => {
    onPlatform('win32');
    h.exes.set('D:\\IDEA\\bin\\idea.bat', 'D:\\IDEA\\bin\\idea64.exe');
    await openIn('intellij', 'C:\\work', { intellijBinary: ' D:\\IDEA\\bin\\idea.bat ' });
    expect(h.spawns.map((s) => [s.cmd, s.args])).toEqual([['D:\\IDEA\\bin\\idea64.exe', ['C:\\work']]]);
  });

  it('reports a Windows install hint, without spawning, when the editor isn’t found', async () => {
    onPlatform('win32');
    const result = await openIn('cursor', 'C:\\work');
    expect(h.spawns).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Could not launch Cursor. Install it from cursor.com, or set its CLI launcher to the full path of Cursor.exe in Settings → Editor.'
    );
  });

  it('includes the spawn error when the resolved executable fails to start', async () => {
    onPlatform('win32');
    h.exes.set('code', 'C:\\VSC\\Code.exe');
    h.failing.add('C:\\VSC\\Code.exe');
    const result = await openIn('code', 'C:\\work');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Could not launch VS Code\. .*Code\.exe in Settings → Editor\. \(spawn C:\\VSC\\Code\.exe ENOENT\)$/);
  });
});

describe('openIn editors elsewhere', () => {
  it('keeps launching the CLI shim on Linux and returns the macOS-style hint on failure', async () => {
    onPlatform('linux');
    expect(await openIn('code', '/work')).toEqual({ ok: true });
    expect(h.spawns.map((s) => [s.cmd, s.args])).toEqual([['code', ['-n', '/work']]]);

    h.failing.add('idea');
    const failed = await openIn('intellij', '/work');
    expect(failed).toEqual({ ok: false, message: expect.stringContaining('Create Command-line Launcher') });
  });
});
