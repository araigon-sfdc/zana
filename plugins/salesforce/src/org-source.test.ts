import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_SOURCE_CAP } from '../lib/action-source.js';
import { projectSourceApiVersion, readRetrieved, retrieveInto, sourceApiVersion, tempProject } from '../lib/org-retrieve.js';
import { OrgSourceReader } from '../lib/org-source.js';
import { createNodeDeps } from '../lib/node-deps.js';
import type { ExecSfOptions, ResolvedOrg, SalesforceDeps, SalesforceRequest } from '../lib/types.js';

const org = { alias: 'dev', username: 'dev@example.com', orgId: '00D1', instanceUrl: 'https://dev.my.salesforce.com', accessToken: 'TOKEN', apiVersion: '62.0' } as ResolvedOrg;
const D = 'force-app/main/default';
const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ status: 0, result }), stderr: '' });
const response = (json: unknown, status = 200) => ({ json, status, text: JSON.stringify(json) });
const FLOW_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>Check</label></Flow>\n';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A CLI that writes what the org holds into the retrieve project, and reports it like `sf project retrieve start`. */
function fixture(org_: Record<string, Record<string, string>> = {}) {
  const projects: string[] = [];
  const manifests: string[] = [];
  const execSf = vi.fn(async (args: string[], options?: ExecSfOptions) => {
    const cwd = options!.cwd!;
    projects.push(cwd);
    manifests.push(readFileSync(join(cwd, 'package.xml'), 'utf8') + readFileSync(join(cwd, 'sfdx-project.json'), 'utf8'));
    const files: unknown[] = [];
    for (const [, name] of readFileSync(join(cwd, 'package.xml'), 'utf8').matchAll(/<members>(\w+)<\/members>/g)) {
      for (const [path, content] of Object.entries(org_[name!] ?? {})) {
        const full = join(cwd, D, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
        files.push({ fullName: name, type: path.startsWith('flows/') ? 'Flow' : 'ApexClass', state: 'Created', filePath: full });
      }
    }
    expect(args.slice(0, 7)).toEqual(['project', 'retrieve', 'start', '--manifest', 'package.xml', '--target-org', 'dev']);
    return ok({ success: true, done: true, files, fileProperties: [] });
  });
  const tooling: Record<string, unknown[]> = {};
  const request = vi.fn(async (_org: ResolvedOrg, req: SalesforceRequest) => {
    if (req.path === '/tooling/query') {
      const q = req.query!.q!;
      const name = /(?:Name|DeveloperName) = '(\w+)'/.exec(q)![1]!;
      const type = /FROM (\w+)/.exec(q)![1]!;
      return response({ records: tooling[`${type}:${name}`] ?? [] });
    }
    if (req.path.startsWith('/actions/custom/apex/')) return response({ actions: [{ inputs: [{ name: 'orderId', dataType: 'String', isRequired: true }], outputs: [] }] });
    return response({}, 404);
  });
  const deps = { ...createNodeDeps(), execSf, request } as unknown as SalesforceDeps;
  return { reader: new OrgSourceReader(deps), execSf, request, tooling, projects, manifests, deps };
}

describe('org source reader', () => {
  it('retrieves Apex in source format, reuses it until the class changes, and cleans its temp project', async () => {
    const { reader, execSf, tooling, projects, manifests } = fixture({ Lookup: { 'classes/Lookup.cls': 'public class Lookup {}', 'classes/Lookup.cls-meta.xml': '<meta/>' } });
    tooling['ApexClass:Lookup'] = [{ Id: '01p', LastModifiedDate: '2026-01-01T00:00:00.000+0000' }];
    const first = await reader.read(org, 'apex://Lookup', '66.0');
    expect(first).toMatchObject({ origin: 'org', status: 'ready', content: 'public class Lookup {}', language: 'apex', label: 'dev · Deployed Apex', inputs: [{ name: 'orderId', type: 'String', required: true }] });
    expect(manifests[0]).toContain('<members>Lookup</members>\n    <name>ApexClass</name>');
    expect(manifests[0]).toContain('"sourceApiVersion":"66.0"');
    expect(existsSync(projects[0]!)).toBe(false);
    expect((await reader.read(org, 'apex://Lookup', '66.0')).content).toBe('public class Lookup {}');
    expect(execSf).toHaveBeenCalledTimes(1);
    tooling['ApexClass:Lookup'] = [{ Id: '01p', LastModifiedDate: '2026-02-01T00:00:00.000+0000' }];
    await reader.read(org, 'apex://Lookup', '66.0');
    expect(execSf).toHaveBeenCalledTimes(2);
    // Without a project version, the org's version.
    await reader.read(org, 'apex://Lookup');
    expect(manifests[2]).toContain('<version>62.0</version>');
  });

  it('shows the active Flow version, or the latest one with a note when none is active', async () => {
    const { reader, tooling } = fixture({ Check: { 'flows/Check.flow-meta.xml': FLOW_XML } });
    tooling['FlowDefinition:Check'] = [{ Id: '300', LastModifiedDate: 'a', ActiveVersion: { VersionNumber: 3 }, LatestVersion: { VersionNumber: 4, LastModifiedDate: 'b' } }];
    expect(await reader.read(org, 'flow://Check')).toMatchObject({ status: 'ready', content: FLOW_XML, language: 'xml', version: 3, label: 'dev · Active Flow' });
    tooling['FlowDefinition:Check'] = [{ Id: '300', LastModifiedDate: 'a', ActiveVersion: null, LatestVersion: { VersionNumber: 4, LastModifiedDate: 'c' } }];
    const draft = await reader.read(org, 'flow://Check');
    expect(draft).toMatchObject({ status: 'ready', version: 4, inactive: true, label: 'dev · Latest Flow (inactive)', message: 'This Flow has no active version. Showing the latest version (v4).' });
    tooling['FlowDefinition:Check'] = [{ Id: '300', LastModifiedDate: 'd' }];
    expect(await reader.read(org, 'flow://Check')).toMatchObject({ inactive: true, message: 'This Flow has no active version. Showing the latest version.' });
  });

  it('reports a missing component without retrieving, and an empty retrieve as unavailable', async () => {
    const { reader, execSf, tooling } = fixture();
    expect(await reader.read(org, 'apex://Nope')).toMatchObject({ status: 'missing', message: expect.stringContaining('No accessible Apex class') });
    expect(await reader.read(org, 'flow://Nope')).toMatchObject({ status: 'missing', message: expect.stringContaining('No accessible Flow') });
    expect(execSf).not.toHaveBeenCalled();
    tooling['ApexClass:Hidden'] = [{ Id: '01p', LastModifiedDate: 'x' }];
    expect(await reader.read(org, 'apex://Hidden')).toMatchObject({ status: 'unavailable' });
    await expect(reader.read(org, 'bad')).rejects.toThrow('Only Apex');
  });

  it('reads managed components and failed retrieves from the Tooling API', async () => {
    const { reader, execSf, request, tooling } = fixture();
    request.mockImplementation(async (_org, req) => {
      if (req.path === '/tooling/query' && req.query!.q!.includes('Body')) return response({ records: [{ Id: '01p', Body: 'tooling body' }] });
      if (req.path === '/tooling/query') return response({ records: tooling['ApexClass:Lookup'] ?? [] });
      return response({}, 404);
    });
    expect(await reader.read(org, 'apex://ns.Lookup')).toMatchObject({ status: 'ready', content: 'tooling body' });
    expect(execSf).not.toHaveBeenCalled();
    tooling['ApexClass:Lookup'] = [{ Id: '01p', LastModifiedDate: 'x' }];
    execSf.mockResolvedValueOnce({ code: 1, stdout: JSON.stringify({ status: 1, message: 'INVALID_SESSION_ID' }), stderr: '' });
    const fallback = await reader.read(org, 'apex://Lookup');
    expect(fallback).toMatchObject({ status: 'ready', content: 'tooling body', message: 'Could not retrieve the source (INVALID_SESSION_ID). Showing the Tooling API snapshot.' });
    execSf.mockRejectedValueOnce('boom');
    request.mockImplementation(async (_org, req) => req.path === '/tooling/query' && !req.query!.q!.includes('Body') ? response({ records: [{ Id: '01p', LastModifiedDate: 'y' }] }) : response({ records: [] }));
    expect((await reader.read(org, 'apex://Lookup')).message).toBe('Could not retrieve the source (Unknown error). Showing the Tooling API snapshot. Apex source is unavailable. It may be managed, missing, or restricted by permissions.');
  });

  it('shares one retrieve between concurrent reads and bounds its cache', async () => {
    const classes = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`C${i}`, { [`classes/C${i}.cls`]: `class C${i} {}` }]));
    const { reader, execSf, tooling } = fixture(classes);
    for (const name of Object.keys(classes)) tooling[`ApexClass:${name}`] = [{ Id: '01p', LastModifiedDate: 'x' }];
    const both = await Promise.all([reader.read(org, 'apex://C0'), reader.read(org, 'apex://C0')]);
    expect(both.map(row => row.content)).toEqual(['class C0 {}', 'class C0 {}']);
    expect(execSf).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 26; i++) await reader.read(org, `apex://C${i}`);
    expect(execSf).toHaveBeenCalledTimes(26);
    await reader.read(org, 'apex://C25'); // still cached, and refreshed as most recent
    expect(execSf).toHaveBeenCalledTimes(26);
    await reader.read(org, 'apex://C0'); // evicted
    expect(execSf).toHaveBeenCalledTimes(27);
  });
});

describe('retrieve primitive', () => {
  it('returns only reported regular files inside the retrieve project', async () => {
    const project = await tempProject('64.0'); dirs.push(project);
    const outside = mkdtempSync(join(tmpdir(), 'sf-outside-')); dirs.push(outside);
    writeFileSync(join(outside, 'Leak.cls'), 'secret');
    const file = join(project, D, 'classes', 'A.cls');
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'class A {}');
    mkdirSync(join(project, D, 'lwc', 'card'), { recursive: true });
    const execSf = vi.fn(async () => ok({
      success: true, done: true,
      fileProperties: [{ type: 'ApexClass', fullName: 'A', lastModifiedDate: '2026-01-01T00:00:00.000+0000' }, { type: 'ApexClass', fullName: 'A', lastModifiedDate: '2026-02-01T00:00:00.000Z' }, { type: 'Package', fullName: 'unpackaged/package.xml', lastModifiedDate: 'not a date' }],
      files: [
        { fullName: 'A', type: 'ApexClass', state: 'Created', filePath: file },
        { fullName: 'A', type: 'ApexClass', state: 'Changed', filePath: file },
        { fullName: 'Leak', type: 'ApexClass', state: 'Created', filePath: join(outside, 'Leak.cls') },
        { fullName: 'B', type: 'ApexClass', state: 'Failed', filePath: file },
        { fullName: 'Gone', type: 'ApexClass', state: 'Created', filePath: join(project, D, 'classes', 'Gone.cls') },
        { fullName: 'card', type: 'LightningComponentBundle', state: 'Created', filePath: join(project, D, 'lwc', 'card') },
        { fullName: 7, type: 'ApexClass', filePath: file },
      ],
    }));
    const result = await retrieveInto(execSf as never, project, ['ApexClass:A'], { alias: 'dev', apiVersion: '64.0', timeoutMs: 90_000 });
    expect(result.files).toEqual([{ type: 'ApexClass', fullName: 'A', path: file, rest: 'classes/A.cls' }]);
    expect(result.modified.get('ApexClass:A')).toBe('2026-01-01T00:00:00.000Z');
    expect((execSf.mock.calls[0] as unknown as [string[]])[0]).toContain('2');
    expect(await readRetrieved(file, 100)).toBe('class A {}');
    await expect(readRetrieved(file, 3)).rejects.toThrow('preview limit');
  });

  it('rejects incomplete or failed CLI results', async () => {
    const project = await tempProject('64.0'); dirs.push(project);
    const run = (stdout: string, code = 0) => retrieveInto(async () => ({ code, stdout, stderr: '' }), project, ['ApexClass:A'], { alias: 'dev', apiVersion: '64.0', timeoutMs: 60_000 });
    await expect(run('nope')).rejects.toThrow('incomplete output');
    await expect(run(JSON.stringify({ status: 1, message: 'No org' }), 1)).rejects.toThrow('No org');
    await expect(run(JSON.stringify({ status: 1 }), 1)).rejects.toThrow('could not retrieve');
    await expect(run(JSON.stringify({ status: 0, result: { success: false } }))).rejects.toThrow('did not complete');
    expect((await run(JSON.stringify({ status: 0, result: {} }))).files).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(retrieveInto(vi.fn() as never, project, ['ApexClass:A'], { alias: 'dev', apiVersion: '64.0', timeoutMs: 60_000, signal: controller.signal })).rejects.toThrow();
  });

  it('reads a plain source API version only', () => {
    expect(sourceApiVersion(JSON.stringify({ sourceApiVersion: '66.0' }))).toBe('66.0');
    for (const text of [JSON.stringify({ sourceApiVersion: '66' }), JSON.stringify({ sourceApiVersion: 66 }), '{', null, undefined]) expect(sourceApiVersion(text)).toBeUndefined();
  });

  it('reads the project source API version from its sfdx-project.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-sf-version-'));
    dirs.push(root);
    const deps = createNodeDeps();
    expect(projectSourceApiVersion('', deps)).toBeUndefined();
    expect(projectSourceApiVersion(root, deps)).toBeUndefined();
    writeFileSync(join(root, 'sfdx-project.json'), JSON.stringify({ sourceApiVersion: '65.0' }));
    expect(projectSourceApiVersion(root, deps)).toBe('65.0');
    const unbounded = { realpath: deps.realpath, readFile: vi.fn(() => JSON.stringify({ sourceApiVersion: '64.0' })) };
    expect(projectSourceApiVersion(root, unbounded)).toBe('64.0');
    expect(projectSourceApiVersion(join(root, 'missing'), deps)).toBeUndefined();
    expect(projectSourceApiVersion(root, { ...unbounded, readFile: () => { throw Error('EACCES'); } })).toBeUndefined();
  });

  it('caps oversized org source at the preview limit', async () => {
    const { reader, tooling, request } = fixture({ Big: { 'classes/Big.cls': 'x'.repeat(ACTION_SOURCE_CAP + 1) } });
    tooling['ApexClass:Big'] = [{ Id: '01p', LastModifiedDate: 'x' }];
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (o, req) => req.query?.q?.includes('Body') ? response({ records: [{ Id: '01p', Body: 'tooling' }] }) : base(o, req));
    expect(await reader.read(org, 'apex://Big')).toMatchObject({ content: 'tooling', message: expect.stringContaining('preview limit') });
  });
});
