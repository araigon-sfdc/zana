import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { resolveUnderRoot } from './dx-project.js';
import type { SalesforceDeps } from './types.js';

/** One file the CLI wrote, as the CLI reported it. `rest` is relative to the package's `main/default`. */
export interface RetrievedFile { type: string; fullName: string; path: string; rest: string }
export interface RetrieveResult { files: RetrievedFile[]; modified: Map<string, string | null> }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const iso = (value: unknown) => {
  const time = typeof value === 'string' ? Date.parse(value.replace(/\+0000$/, 'Z')) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export function cliResult(result: Awaited<ReturnType<SalesforceDeps['execSf']>>, fallback: string): unknown {
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(result.stdout)); } catch { throw Error('Salesforce CLI returned incomplete output. Check the CLI connection and retry.'); }
  if (result.code !== 0 || payload.status !== 0) throw Error(typeof payload.message === 'string' ? payload.message.slice(0, 400) : fallback);
  return payload.result;
}

export function manifest(keys: string[], apiVersion: string): string {
  const byType = new Map<string, string[]>();
  for (const key of keys) {
    const [type, name] = key.split(':') as [string, string];
    byType.set(type, [...(byType.get(type) ?? []), name]);
  }
  const types = [...byType].map(([type, names]) => `  <types>\n${names.map(name => `    <members>${name}</members>`).join('\n')}\n    <name>${type}</name>\n  </types>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}\n  <version>${apiVersion}</version>\n</Package>\n`;
}

/** `sourceApiVersion` from an sfdx-project.json text, when it is a plain `NN.0`. */
export function sourceApiVersion(text: string | null | undefined): string | undefined {
  try {
    const version = record(JSON.parse(text ?? '')).sourceApiVersion;
    return typeof version === 'string' && /^[0-9]{2,3}\.0$/.test(version) ? version : undefined;
  } catch { return undefined; }
}

/** The project's `sourceApiVersion`, read from its `sfdx-project.json`; undefined when there is no readable one. */
export function projectSourceApiVersion(root: string, deps: Pick<SalesforceDeps, 'realpath' | 'readFile' | 'readFileBounded'>): string | undefined {
  if (!root) return undefined;
  try {
    const config = resolveUnderRoot(deps.realpath(root), 'sfdx-project.json', deps.realpath);
    return config ? sourceApiVersion(deps.readFileBounded ? deps.readFileBounded(config, 64_000) : deps.readFile(config)) : undefined;
  } catch { return undefined; }
}

/** A private, empty DX project the CLI can retrieve into. Its real path, so CLI-reported paths compare. */
export async function tempProject(apiVersion: string, prefix = 'zcc-sf-retrieve-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await mkdir(join(dir, 'force-app'));
  await writeFile(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: apiVersion }), { mode: 0o600 });
  return dir;
}

export const removeTemp = (dir: string | undefined) => dir ? rm(dir, { recursive: true, force: true }) : Promise.resolve();

/**
 * Retrieves `keys` (`Type:Name`) into `project` in source format, the way the VS Code extension does:
 * the CLI places each file, and its `files` list says which component each file belongs to.
 * Only regular files inside `project` are returned.
 */
export async function retrieveInto(execSf: SalesforceDeps['execSf'], project: string, keys: string[], opts: { alias: string; apiVersion: string; timeoutMs: number; signal?: AbortSignal }): Promise<RetrieveResult> {
  await writeFile(join(project, 'package.xml'), manifest(keys, opts.apiVersion), { mode: 0o600 });
  opts.signal?.throwIfAborted();
  const result = record(cliResult(await execSf(
    ['project', 'retrieve', 'start', '--manifest', 'package.xml', '--target-org', opts.alias, '--json', '--wait', String(Math.max(1, Math.ceil(opts.timeoutMs / 60_000)))],
    { cwd: project, timeoutMs: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
  ), 'Salesforce could not retrieve the metadata. Check your org access and retry.'));
  opts.signal?.throwIfAborted();
  if (result.success === false || result.done === false) throw Error('Salesforce did not complete the retrieval. Retry after it finishes.');
  const modified = new Map<string, string | null>();
  for (const row of Array.isArray(result.fileProperties) ? result.fileProperties.map(record) : []) {
    const key = `${row.type}:${String(row.fullName ?? '').split('/')[0]}`;
    if (!modified.get(key)) modified.set(key, iso(row.lastModifiedDate));
  }
  const base = join(project, 'force-app', 'main', 'default');
  const files: RetrievedFile[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(result.files) ? result.files.map(record) : []) {
    if (typeof row.filePath !== 'string' || typeof row.type !== 'string' || typeof row.fullName !== 'string' || row.state === 'Failed') continue;
    let path: string;
    try { path = await realpath(row.filePath); } catch { continue; }
    if (seen.has(path) || !path.startsWith(base + sep)) continue;
    try { if (!(await lstat(path)).isFile()) continue; } catch { continue; }
    seen.add(path);
    files.push({ type: row.type, fullName: row.fullName, path, rest: relative(base, path).split(sep).join('/') });
  }
  return { files, modified };
}

/** Reads a retrieved file with a size cap. */
export async function readRetrieved(path: string, cap: number): Promise<string> {
  const content = await readFile(path);
  if (content.length > cap) throw Error(`This source exceeds the ${Math.round(cap / 1000)} KB preview limit.`);
  return content.toString('utf8');
}
