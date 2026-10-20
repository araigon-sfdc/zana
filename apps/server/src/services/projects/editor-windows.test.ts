import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { realWindowsEditorFs, resolveWindowsEditor, windowsEditorVersion, type WindowsEditorFs } from './editor-windows.js';

/**
 * In-memory Windows filesystem keyed by case-insensitive win32 paths, so the
 * resolver runs the same on a Linux/macOS CI runner as on Windows.
 */
function fakeFs(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): WindowsEditorFs {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const byPath = new Map(Object.entries(files).map(([p, text]) => [norm(p), text]));
  return {
    env,
    isFile: (p) => byPath.has(norm(p)),
    readText: (p) => byPath.get(norm(p)) ?? null,
    listDir: (p) => {
      const prefix = `${norm(p)}\\`;
      const children = Object.keys(files).filter((f) => norm(f).startsWith(prefix));
      return [...new Set(children.map((f) => f.slice(prefix.length).split('\\')[0]))];
    }
  };
}

const VSCODE_SHIM =
  '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\6d62b1d5da\\resources\\app\\out\\cli.js" %*\r\nendlocal\r\n';

describe('resolveWindowsEditor', () => {
  it('follows the code.cmd shim on PATH to Code.exe, skipping the extensionless POSIX script', () => {
    const fs = fakeFs(
      {
        'C:\\Microsoft VS Code\\bin\\code': '#!/usr/bin/env sh',
        'C:\\Microsoft VS Code\\bin\\code.cmd': VSCODE_SHIM,
        'C:\\Microsoft VS Code\\Code.exe': ''
      },
      { Path: 'C:\\Windows;"C:\\Microsoft VS Code\\bin"', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    );
    expect(resolveWindowsEditor('code', 'code', fs)).toBe('C:\\Microsoft VS Code\\Code.exe');
  });

  it('follows the Cursor shim that sits three folders below Cursor.exe', () => {
    const fs = fakeFs(
      {
        'D:\\Apps\\cursor\\resources\\app\\bin\\cursor.cmd': '@echo off\r\n"%~dp0..\\..\\..\\Cursor.exe" "%~dp0..\\out\\cli.js" %*\r\n',
        'D:\\Apps\\cursor\\Cursor.exe': ''
      },
      { PATH: 'D:\\Apps\\cursor\\resources\\app\\bin' }
    );
    expect(resolveWindowsEditor('cursor', 'cursor', fs)).toBe('D:\\Apps\\cursor\\Cursor.exe');
  });

  it('reads an absolute exe from a Toolbox-style script, ignoring unexpanded variables', () => {
    const fs = fakeFs(
      {
        'C:\\Toolbox\\scripts\\idea.cmd': '@echo off\r\nstart "" "%IDEA_HOME%\\idea64.exe"\r\nstart "" "C:\\JB\\IDEA\\bin\\idea64.exe" %*\r\n',
        'C:\\JB\\IDEA\\bin\\idea64.exe': ''
      },
      { PATH: 'C:\\Toolbox\\scripts' }
    );
    expect(resolveWindowsEditor('intellij', 'idea', fs)).toBe('C:\\JB\\IDEA\\bin\\idea64.exe');
  });

  it('uses the sibling idea64.exe next to the idea.bat launcher', () => {
    const fs = fakeFs(
      { 'C:\\IDEA\\bin\\idea.bat': '@echo off\r\n:: java launcher\r\n', 'C:\\IDEA\\bin\\idea64.exe': '' },
      { PATH: 'C:\\IDEA\\bin' }
    );
    expect(resolveWindowsEditor('intellij', 'idea', fs)).toBe('C:\\IDEA\\bin\\idea64.exe');
  });

  it('accepts a configured absolute exe, or a path without its extension', () => {
    const fs = fakeFs({ 'E:\\Tools\\Code.exe': '' }, { PATHEXT: '.EXE;.CMD' });
    expect(resolveWindowsEditor('code', 'E:\\Tools\\Code.exe', fs)).toBe('E:\\Tools\\Code.exe');
    expect(resolveWindowsEditor('code', 'E:\\Tools\\Code', fs)).toBe('E:\\Tools\\Code.exe');
  });

  it('falls back to the default per-user and machine-wide install folders', () => {
    const local = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    expect(
      resolveWindowsEditor('code', 'code', fakeFs({ 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe': '' }, local))
    ).toBe('C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe');
    expect(
      resolveWindowsEditor('cursor', '', fakeFs({ 'C:\\Program Files\\Cursor\\Cursor.exe': '' }, { ProgramFiles: 'C:\\Program Files' }))
    ).toBe('C:\\Program Files\\Cursor\\Cursor.exe');
  });

  it('picks the newest IntelliJ IDEA install folder', () => {
    const fs = fakeFs(
      {
        'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.9\\bin\\idea64.exe': '',
        'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.10\\bin\\idea64.exe': '',
        'C:\\Program Files\\JetBrains\\PyCharm 2024.1\\bin\\pycharm64.exe': ''
      },
      { PROGRAMFILES: 'C:\\Program Files' }
    );
    expect(resolveWindowsEditor('intellij', 'idea', fs)).toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.10\\bin\\idea64.exe');
  });

  it('returns null when neither a shim nor an install is found', () => {
    const fs = fakeFs(
      { 'C:\\bin\\code.cmd': '@echo off\r\n"%~dp0missing.exe" %*\r\n' },
      { PATH: 'C:\\bin', LOCALAPPDATA: 'C:\\Local', PROGRAMFILES: 'C:\\PF' }
    );
    expect(resolveWindowsEditor('code', 'code', fs)).toBeNull();
    expect(resolveWindowsEditor('intellij', 'idea', fakeFs({}))).toBeNull();
  });
});

describe('windowsEditorVersion', () => {
  it('reads VS Code’s version from the commit-named resources folder', () => {
    const fs = fakeFs({
      'C:\\VSC\\Code.exe': '',
      'C:\\VSC\\6d62b1d5da\\resources\\app\\package.json': '{"name":"code-oss-dev","version":"1.105.1"}'
    });
    expect(windowsEditorVersion('code', 'C:\\VSC\\Code.exe', fs)).toBe('1.105.1');
  });

  it('reads Cursor’s version from resources next to the exe', () => {
    const fs = fakeFs({ 'C:\\Cur\\Cursor.exe': '', 'C:\\Cur\\resources\\app\\package.json': '{"version":"1.7.2"}' });
    expect(windowsEditorVersion('cursor', 'C:\\Cur\\Cursor.exe', fs)).toBe('1.7.2');
  });

  it('reads IntelliJ’s name and version from product-info.json', () => {
    const fs = fakeFs({ 'C:\\IDEA\\product-info.json': '{"name":"IntelliJ IDEA","version":"2025.2.3"}' });
    expect(windowsEditorVersion('intellij', 'C:\\IDEA\\bin\\idea64.exe', fs)).toBe('IntelliJ IDEA 2025.2.3');
  });

  it('returns undefined for missing or malformed install files', () => {
    expect(windowsEditorVersion('code', 'C:\\VSC\\Code.exe', fakeFs({ 'C:\\VSC\\resources\\app\\package.json': '{not json' }))).toBeUndefined();
    expect(windowsEditorVersion('intellij', 'C:\\IDEA\\bin\\idea64.exe', fakeFs({ 'C:\\IDEA\\product-info.json': '{"version":"1"}' }))).toBeUndefined();
  });
});

describe('realWindowsEditorFs', () => {
  it('reads files and folders, and reports missing or oversized ones as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcc-editor-windows-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'code.cmd'), '@echo off');
      writeFileSync(join(dir, 'huge.cmd'), 'x'.repeat(64 * 1024 + 1));
      expect(realWindowsEditorFs.isFile(join(dir, 'bin', 'code.cmd'))).toBe(true);
      expect(realWindowsEditorFs.isFile(join(dir, 'bin'))).toBe(false);
      expect(realWindowsEditorFs.isFile(join(dir, 'missing'))).toBe(false);
      expect(realWindowsEditorFs.readText(join(dir, 'bin', 'code.cmd'))).toBe('@echo off');
      expect(realWindowsEditorFs.readText(join(dir, 'huge.cmd'))).toBeNull();
      expect(realWindowsEditorFs.readText(join(dir, 'missing'))).toBeNull();
      expect(realWindowsEditorFs.listDir(dir).sort()).toEqual(['bin', 'huge.cmd']);
      expect(realWindowsEditorFs.listDir(join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
