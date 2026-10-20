/**
 * Windows resolution for the external-editor openers ("Open in VS Code" etc.).
 *
 * On Windows the editors' CLI shims are batch files (`code.cmd`, `cursor.cmd`,
 * `idea.bat`). Node's `spawn` can't start them without a shell: a bare `code`
 * misses PATHEXT (ENOENT) and `code.cmd` is refused outright (EINVAL, the
 * CVE-2024-27980 fix). Going through `cmd.exe` would re-parse project paths as
 * shell syntax, so instead we resolve what the shim runs and spawn that
 * directly: `Code.exe` / `Cursor.exe` as Node on their `cli.js` (like the
 * shim), or `idea64.exe` with the path.
 *
 * Resolution order: the configured binary (absolute path or PATH lookup with
 * PATHEXT) → the `.exe` it names (itself, a quoted `.exe` inside the shim, or a
 * sibling `<name>64.exe`) → the editor's default install folders. Filesystem
 * access is injected so the logic is testable on any host OS.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { win32 as path } from 'node:path';
import type { EditorTarget } from '@zana-ai/zcc-domain/product';

export interface WindowsEditorFs {
  env: NodeJS.ProcessEnv;
  isFile(p: string): boolean;
  /** File text, or null when unreadable. */
  readText(p: string): string | null;
  /** Directory entry names, or [] when unreadable. */
  listDir(p: string): string[];
}

/** Shims are tiny; anything bigger isn't a launcher we can parse. */
const MAX_SHIM_BYTES = 64 * 1024;

export const realWindowsEditorFs: WindowsEditorFs = {
  env: process.env,
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readText: (p) => {
    try {
      if (statSync(p).size > MAX_SHIM_BYTES) return null;
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  }
};

/**
 * Completes "install it (…)" in Settings → Editor and "Install it … in
 * Settings → Editor." in the opener's failure toast.
 */
export const WINDOWS_INSTALL_HINTS: Record<EditorTarget, string> = {
  cursor: 'from cursor.com, or set its CLI launcher to the full path of Cursor.exe',
  code: 'from code.visualstudio.com, or set its CLI launcher to the full path of Code.exe',
  intellij: 'from jetbrains.com, or set its CLI launcher to the full path of idea64.exe'
};

function envDir(env: NodeJS.ProcessEnv, key: string): string | null {
  // Windows env names are case-insensitive; Node preserves the original case.
  const hit = Object.keys(env).find((k) => k.toUpperCase() === key);
  const value = hit ? env[hit]?.trim() : '';
  return value || null;
}

/** Find `binary` the way cmd.exe would: as a path, else on PATH with PATHEXT. */
function findOnPath(binary: string, fs: WindowsEditorFs): string | null {
  // Like cmd.exe, an extensionless name only matches PATHEXT files — VS Code's
  // `bin` folder also holds an extensionless `code` script for POSIX shells.
  const exts = path.extname(binary)
    ? ['']
    : (envDir(fs.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const withExts = (base: string) => exts.map((e) => base + e);
  if (path.isAbsolute(binary) || /[\\/]/.test(binary)) {
    return withExts(binary).find((p) => fs.isFile(p)) ?? null;
  }
  const dirs = (envDir(fs.env, 'PATH') ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    const hit = withExts(path.join(dir, binary)).find((p) => fs.isFile(p));
    if (hit) return hit;
  }
  return null;
}

/**
 * Existing files a shim names in double quotes with extension `ext`, e.g.
 * `"%~dp0..\Code.exe"` (VS Code / Cursor) or an absolute `"C:\…\idea64.exe"`
 * (JetBrains Toolbox scripts). `%~dp0` is the shim's own folder.
 */
function quotedFiles(shim: string, ext: string, fs: WindowsEditorFs): string[] {
  const dir = path.dirname(shim);
  const text = fs.readText(shim) ?? '';
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(`"([^"\\r\\n]+?\\${ext})"`, 'gi'))) {
    const raw = match[1].replace(/%~dp0/gi, dir + path.sep);
    if (raw.includes('%')) continue;
    const file = path.resolve(dir, raw);
    if (fs.isFile(file)) found.push(file);
  }
  return found;
}

/** The GUI executable a shim launches: a quoted `.exe` it names, else a sibling. */
function exeFromShim(shim: string, fs: WindowsEditorFs): string | null {
  if (path.extname(shim).toLowerCase() === '.exe') return shim;
  const [named] = quotedFiles(shim, '.exe', fs);
  if (named) return named;
  const dir = path.dirname(shim);
  const base = path.basename(shim, path.extname(shim));
  return [`${base}64.exe`, `${base}.exe`].map((n) => path.join(dir, n)).find((p) => fs.isFile(p)) ?? null;
}

/**
 * The `cli.js` that VS Code / Cursor's shim runs with the exe as Node
 * (`ELECTRON_RUN_AS_NODE=1 Code.exe …\out\cli.js %*`). Read from the shim that
 * named `exe`, else from the one shipped in the install (`bin\code.cmd`,
 * `resources\app\bin\cursor.cmd`), so an exe found directly gets it too.
 */
function cliJsFor(target: EditorTarget, exe: string, shim: string | null, fs: WindowsEditorFs): string | undefined {
  if (target === 'intellij') return undefined;
  const dir = path.dirname(exe);
  const name = path.basename(exe, path.extname(exe)).toLowerCase();
  const shims = [shim, path.join(dir, 'bin', `${name}.cmd`), path.join(dir, 'resources', 'app', 'bin', `${name}.cmd`)];
  for (const candidate of shims) {
    // Only a shim that launches this very exe knows its matching cli.js.
    if (!candidate || !quotedFiles(candidate, '.exe', fs).some((e) => e.toLowerCase() === exe.toLowerCase())) continue;
    const [cliJs] = quotedFiles(candidate, '.js', fs);
    if (cliJs) return cliJs;
  }
  return undefined;
}

/** Default per-user and machine-wide install locations, newest IntelliJ first. */
function defaultInstalls(target: EditorTarget, fs: WindowsEditorFs): string[] {
  const local = envDir(fs.env, 'LOCALAPPDATA');
  const programs = [envDir(fs.env, 'PROGRAMFILES'), envDir(fs.env, 'PROGRAMFILES(X86)')].filter((d): d is string => !!d);
  const under = (roots: (string | null)[], ...rel: string[]) =>
    roots.filter((r): r is string => !!r).map((r) => path.join(r, ...rel));
  switch (target) {
    case 'code':
      return [
        ...under([local], 'Programs', 'Microsoft VS Code', 'Code.exe'),
        ...under(programs, 'Microsoft VS Code', 'Code.exe')
      ];
    case 'cursor':
      return [...under([local], 'Programs', 'cursor', 'Cursor.exe'), ...under(programs, 'Cursor', 'Cursor.exe')];
    case 'intellij': {
      const parents = [...under([local], 'Programs'), ...under(programs, 'JetBrains')];
      return parents.flatMap((parent) =>
        fs
          .listDir(parent)
          .filter((name) => /^IntelliJ IDEA/i.test(name))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .map((name) => path.join(parent, name, 'bin', 'idea64.exe'))
      );
    }
  }
}

/** How to start an editor on Windows without a shell. */
export interface WindowsEditorLaunch {
  /** The editor's own executable. */
  exe: string;
  /**
   * VS Code / Cursor's CLI script. When set, run `exe cliJs …args` with
   * `ELECTRON_RUN_AS_NODE=1`, exactly as the shim does: launching the GUI exe
   * with `-n <folder>` while the editor is already running opens nothing.
   */
  cliJs?: string;
}

/**
 * Resolve how to launch `target` (directly, no shell), given the configured
 * CLI name or path (`code`, a user override, …). Null when the editor can't be
 * found.
 */
export function resolveWindowsEditorLaunch(
  target: EditorTarget,
  binary: string,
  fs: WindowsEditorFs = realWindowsEditorFs
): WindowsEditorLaunch | null {
  const shim = binary.trim() ? findOnPath(binary.trim(), fs) : null;
  const viaShim = shim ? exeFromShim(shim, fs) : null;
  const exe = viaShim ?? defaultInstalls(target, fs).find((p) => fs.isFile(p));
  if (!exe) return null;
  const cliJs = cliJsFor(target, exe, viaShim ? shim : null, fs);
  return cliJs ? { exe, cliJs } : { exe };
}

/** The editor's executable (see `resolveWindowsEditorLaunch`), or null. */
export function resolveWindowsEditor(target: EditorTarget, binary: string, fs: WindowsEditorFs = realWindowsEditorFs): string | null {
  return resolveWindowsEditorLaunch(target, binary, fs)?.exe ?? null;
}

function jsonField(file: string, fs: WindowsEditorFs, ...keys: string[]): string[] {
  const text = fs.readText(file);
  if (!text) return [];
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return keys.map((k) => (typeof json[k] === 'string' ? (json[k] as string).trim() : '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The editor's version, read from its install files rather than by running it
 * (`Code.exe --version` would open a window). VS Code and Cursor report their
 * `resources\app\package.json` version, the same one `code --version` prints;
 * newer VS Code builds keep `resources` under a commit-named subfolder.
 * IntelliJ reports `product-info.json`'s name and version.
 */
export function windowsEditorVersion(
  target: EditorTarget,
  exe: string,
  fs: WindowsEditorFs = realWindowsEditorFs
): string | undefined {
  const dir = path.dirname(exe);
  if (target === 'intellij') {
    const parts = jsonField(path.join(dir, '..', 'product-info.json'), fs, 'name', 'version');
    return parts.length === 2 ? parts.join(' ') : undefined;
  }
  const appDirs = [dir, ...fs.listDir(dir).map((name) => path.join(dir, name))].map((d) =>
    path.join(d, 'resources', 'app', 'package.json')
  );
  for (const pkg of appDirs) {
    const [version] = jsonField(pkg, fs, 'version');
    if (version) return version;
  }
  return undefined;
}
