import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Windows-only Salesforce CLI launch resolution.
 *
 * On Windows `sf` is an `sf.cmd` batch shim. Spawning plain `sf` without a
 * shell cannot start it at all, and running it through cmd.exe re-parses `%*`
 * inside the batch file, where an argument with quotes (a Preview utterance,
 * an SDK caller's value) can escape its quoting. So we find the install the
 * shim belongs to and run its bundled `node.exe` on the CLI entry directly,
 * with no shell involved.
 *
 * Layouts are recognised by directory structure, never by parsing shim text:
 * - installer: `<root>\bin\sf.cmd` with `<root>\client\bin\{node.exe,run.js}`;
 *   when the auto-updater has staged a client under
 *   `%LOCALAPPDATA%\sf\client\<version>\bin`, the shim redirects there, so the
 *   newest staged version wins;
 * - npm: `<prefix>\sf.cmd` with `<prefix>\node_modules\@salesforce\cli\bin\run.js`,
 *   run by `<prefix>\node.exe` or the first `node.exe` on PATH.
 * Only absolute PATH entries are considered. A shim that matches neither layout
 * (for example a wrapper that forwards to another `sf.cmd`) is skipped and the
 * search continues down PATH. The Electron binary is never used as Node.
 */

export interface SfLaunch {
  command: string;
  args: string[];
}

export interface ResolverFs {
  isFile(file: string): boolean;
  readdir(dir: string): string[];
}

export const NODE_FS: ResolverFs = {
  isFile: (file) => {
    try { return statSync(file).isFile(); } catch { return false; }
  },
  readdir: (dir) => {
    try { return readdirSync(dir); } catch { return []; }
  }
};

const { join, isAbsolute } = path.win32;
const STAGED_VERSION = /^(\d+)\.(\d+)\.(\d+)/;

export function resolveWindowsSf(env: NodeJS.ProcessEnv, fs: ResolverFs = NODE_FS): SfLaunch | null {
  const dirs = pathDirs(env);
  for (const dir of dirs) {
    if (fs.isFile(join(dir, 'sf.exe'))) return { command: join(dir, 'sf.exe'), args: [] };
    if (!fs.isFile(join(dir, 'sf.cmd'))) continue;
    const launch = installerLaunch(dir, env, fs) ?? npmLaunch(dir, dirs, fs);
    if (launch) return launch;
  }
  return null;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(';').map((entry) => entry.trim().replace(/^"(.*)"$/, '$1')).filter((entry) => entry && isAbsolute(entry));
}

function clientLaunch(binDir: string, fs: ResolverFs): SfLaunch | null {
  const node = join(binDir, 'node.exe');
  const run = join(binDir, 'run.js');
  return fs.isFile(node) && fs.isFile(run) ? { command: node, args: ['--no-deprecation', run] } : null;
}

function installerLaunch(dir: string, env: NodeJS.ProcessEnv, fs: ResolverFs): SfLaunch | null {
  const bundled = clientLaunch(dir, fs) ?? clientLaunch(join(dir, '..', 'client', 'bin'), fs);
  if (!bundled) return null;
  return stagedLaunch(env, fs) ?? bundled;
}

function stagedLaunch(env: NodeJS.ProcessEnv, fs: ResolverFs): SfLaunch | null {
  const local = env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) return null;
  const clientRoot = join(local, 'sf', 'client');
  if (!fs.isFile(join(clientRoot, 'bin', 'sf.cmd'))) return null;
  const versions = fs.readdir(clientRoot)
    .map((name) => ({ name, version: STAGED_VERSION.exec(name)?.slice(1).map(Number) }))
    .filter((entry): entry is { name: string; version: number[] } => !!entry.version)
    .sort((a, b) => compareVersions(b.version, a.version));
  for (const { name } of versions) {
    const launch = clientLaunch(join(clientRoot, name, 'bin'), fs);
    if (launch) return launch;
  }
  return null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function npmLaunch(dir: string, dirs: string[], fs: ResolverFs): SfLaunch | null {
  const run = join(dir, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js');
  if (!fs.isFile(run)) return null;
  const node = [dir, ...dirs].map((entry) => join(entry, 'node.exe')).find((file) => fs.isFile(file));
  return node ? { command: node, args: ['--no-deprecation', run] } : null;
}
