/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OrgSyncDialog, agentSelection, syncGroups } from './OrgSyncDialog.js';
import type { SyncCheck, SyncComponent, SyncJob } from '../../lib/org-sync-contract.js';

const call = vi.fn();
const close = vi.fn();
const row = (fullName: string, state: SyncComponent['state'], extra: Partial<SyncComponent> = {}): SyncComponent => ({
  key: `ApexClass:${fullName}`, type: 'ApexClass', fullName, state, modifiedAt: '2026-10-01T10:00:00.000Z', modifiedBy: 'Ada', ...extra,
});
const counts = { changed: 1, conflict: 1, unknown: 1, new: 2, deleted: 1, current: 7 };
const check = (components: SyncComponent[], extra: Partial<SyncCheck> = {}): SyncCheck => ({
  org: { alias: 'dev', orgId: '00D1' }, scope: 'apex', checkedAt: 1, components, counts, truncated: false, ...extra,
});
const standard = check([
  row('Both', 'conflict'), row('Org', 'changed'),
  row('Agent_2', 'new', { key: 'AiAuthoringBundle:Agent_2', type: 'AiAuthoringBundle', latest: true }),
  row('Fresh', 'new', { modifiedAt: null, modifiedBy: null }), row('Never', 'unknown'), row('Gone', 'deleted'),
]);
const ready: SyncJob = {
  state: 'ready', org: { alias: 'dev', orgId: '00D1' }, components: 3, missing: ['ApexClass:Lost'],
  files: [
    { path: 'force-app/main/default/classes/Both.cls', key: 'ApexClass:Both', action: 'conflict', added: 1, removed: 1 },
    { path: 'force-app/main/default/classes/Org.cls', key: 'ApexClass:Org', action: 'update', added: 2, removed: 0 },
    { path: 'force-app/main/default/classes/New.cls', key: 'ApexClass:New', action: 'create' },
    { path: 'force-app/main/default/classes/Plain.cls', key: 'ApexClass:Plain', action: 'update' },
    { path: 'force-app/main/default/classes/Same.cls', key: 'ApexClass:Same', action: 'same' },
  ],
};
let status: SyncJob[];
const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  status = [ready];
  Object.assign(handlers, {
    'sync.check': () => ({ ok: true, data: standard }),
    'sync.fetch.start': () => ({ ok: true, jobId: 'job1' }),
    'sync.fetch.status': () => ({ ok: true, data: status.length > 1 ? status.shift() : status[0] }),
    'sync.diff': () => ({ ok: true, data: { path: 'x', local: 'a\nlocal\nc', org: 'a\norg\nc' } }),
    'sync.apply': () => ({ ok: true, data: { state: 'applied', written: 4, kept: 0, skipped: [{ path: 'force-app/x.cls', reason: 'Changed after review' }] } }),
    'sync.cancel': () => ({ ok: true }),
  });
  call.mockReset(); close.mockReset();
  call.mockImplementation(async (method: string, args: Record<string, unknown> = {}) => handlers[method]!(args));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const show = (scope: 'apex' | 'agentforce' | 'all' = 'apex') => render(<OrgSyncDialog call={call} scope={scope} onClose={close} />);
const calls = (method: string) => call.mock.calls.filter(([name]) => name === method).map(([, args]) => args);
/** Leaves the summary for the full list, which keeps the recommended selection. */
const showAll = async () => fireEvent.click(await screen.findByRole('button', { name: /^Show all/ }));

it('groups a check and preselects only the safe defaults', () => {
  const groups = syncGroups(standard);
  expect(groups.map(group => [group.id, group.preselect, group.rows.map(item => item.fullName)])).toEqual([
    ['conflict', true, ['Both']], ['changed', true, ['Org']], ['latest', true, ['Agent_2']], ['new', false, ['Fresh']], ['unknown', false, ['Never']],
  ]);
  expect(syncGroups(check([]))).toEqual([]);
});

it('checks, fetches the chosen components, resolves a conflict with its diff and writes', async () => {
  show();
  await showAll();
  expect(await screen.findByText('Fetch 3 components')).toBeTruthy();
  expect(screen.getByText(/7 components up to date/)).toBeTruthy();
  expect(screen.getByText(/No longer in the org, kept locally: Gone/)).toBeTruthy();
  expect(calls('sync.check')).toEqual([{ scope: 'apex' }]);
  const fresh = within(screen.getByRole('region', { name: 'Only in org' }));
  fireEvent.click(fresh.getByRole('checkbox', { name: 'Select all Only in org' }));
  fireEvent.click(within(screen.getByRole('region', { name: 'Changed in org' })).getByRole('checkbox', { name: /^Org/ }));
  expect(screen.getByText('Fetch 3 components')).toBeTruthy();
  fireEvent.click(screen.getByText('Fetch 3 components'));
  expect(await screen.findByText(/Retrieving 3 components/)).toBeTruthy();
  await screen.findByText(/1 in conflict/);
  expect(calls('sync.fetch.start')).toEqual([{ components: ['ApexClass:Both', 'AiAuthoringBundle:Agent_2', 'ApexClass:Fresh'], orgId: '00D1' }]);
  expect(screen.getByRole('status').textContent).toBe('2 to update · 1 new · 1 in conflict · 1 already identical');
  expect(screen.getByText('+2 −0')).toBeTruthy();
  expect(screen.getByTitle('force-app/main/default/classes/New.cls').textContent).toBe('classes/New.cls');
  expect(screen.getByText('new')).toBeTruthy();
  expect(screen.getByText(/Not returned by the org: ApexClass:Lost/)).toBeTruthy();
  expect(screen.getByText('Write 3 files')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
  const diff = await screen.findByLabelText(/Local to org changes/);
  expect(diff.textContent).toContain('−local');
  expect(diff.textContent).toContain('+org');
  expect(calls('sync.diff')).toEqual([{ jobId: 'job1', path: 'force-app/main/default/classes/Both.cls' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
  expect(screen.queryByLabelText(/Local to org changes/)).toBeNull();
  handlers['sync.diff'] = () => ({ ok: true, data: { path: 'x', local: 'a', org: 'b', truncated: true } });
  fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
  expect(await screen.findByText(/only its start is compared/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Diff' }));

  fireEvent.click(screen.getByRole('button', { name: 'Take org' }));
  expect(screen.getByRole('button', { name: 'Take org' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('Write 4 files')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep local for all' }));
  expect(screen.getByText('Write 3 files')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Take org for all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));
  fireEvent.click(screen.getByRole('button', { name: 'Take org' }));
  fireEvent.click(screen.getByText('Write 4 files'));
  await screen.findByText('Wrote 4 files.');
  expect(calls('sync.apply')).toEqual([{ jobId: 'job1', take: ['force-app/main/default/classes/Both.cls'] }]);
  expect(screen.getByText(/Changed after review/)).toBeTruthy();
  fireEvent.click(screen.getByText('Close'));
  expect(close).toHaveBeenCalledOnce();
  expect(calls('sync.cancel')).toEqual([]);
});

it('polls a running fetch and cancels it when the dialog closes', async () => {
  status = [{ state: 'running', done: 1, total: 3 }, ready];
  show();
  await showAll();
  fireEvent.click(await screen.findByText('Fetch 3 components'));
  await screen.findByText('1 of 3 retrieved', {}, { timeout: 2000 });
  await screen.findByText(/1 in conflict/, {}, { timeout: 2500 });
  expect(calls('sync.fetch.status').length).toBe(2);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
  expect(calls('sync.cancel')).toEqual([{ jobId: 'job1' }]);
});

it('stops polling and releases the job when unmounted mid-fetch', async () => {
  status = [{ state: 'running', done: 0, total: 3 }];
  const mounted = show();
  await showAll();
  fireEvent.click(await screen.findByText('Fetch 3 components'));
  await screen.findByText('0 of 3 retrieved');
  mounted.unmount();
  expect(calls('sync.cancel')).toEqual([{ jobId: 'job1' }]);
});

it('switches scope, reports check and fetch failures and the empty states', async () => {
  handlers['sync.check'] = ({ scope }) => scope === 'agentforce' ? { ok: false, error: 'Org expired' } : { ok: true, data: check([], { truncated: true }) };
  show('all');
  expect(await screen.findByText(/Nothing new in the org · Showing the first results only/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Org expired');
  expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-pressed')).toBe('true');

  handlers['sync.check'] = () => ({ ok: true, data: standard });
  fireEvent.click(screen.getByRole('button', { name: 'Apex & LWC' }));
  await showAll();
  status = [{ state: 'failed', error: 'Retrieve failed: INVALID_SESSION' }];
  fireEvent.click(await screen.findByText('Fetch 3 components'));
  expect((await screen.findByRole('alert')).textContent).toBe('Retrieve failed: INVALID_SESSION');
  expect(screen.getByText('Fetch 3 components')).toHaveProperty('disabled', false);

  handlers['sync.fetch.start'] = () => { throw Error('Another fetch is running'); };
  fireEvent.click(screen.getByText('Fetch 3 components'));
  expect((await screen.findByRole('alert')).textContent).toBe('Another fetch is running');
  fireEvent.click(screen.getByText('Cancel'));
  expect(calls('sync.cancel')).toEqual([]);
});

it('ends a fetch that changes nothing and reports an expired apply', async () => {
  status = [{ ...ready, files: [{ path: 'a.cls', key: 'ApexClass:A', action: 'same' }], missing: [] } as SyncJob];
  const mounted = show();
  await showAll();
  fireEvent.click(await screen.findByText('Fetch 3 components'));
  expect(await screen.findByText('Your project already matches the org for 3 components.')).toBeTruthy();
  expect(calls('sync.cancel')).toEqual([{ jobId: 'job1' }]);
  expect(screen.queryByText(/Write/)).toBeNull();
  mounted.unmount();

  status = [ready];
  handlers['sync.apply'] = () => ({ ok: true, data: { state: 'failed', error: 'Fetch expired' } });
  handlers['sync.diff'] = () => ({ ok: false, error: 'Diff unavailable' });
  show();
  await showAll();
  fireEvent.click(await screen.findByText('Fetch 3 components'));
  fireEvent.click(await screen.findByRole('button', { name: 'Diff' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Diff unavailable');
  fireEvent.click(screen.getByText('Write 3 files'));
  await waitFor(() => expect(screen.getAllByRole('alert').map(node => node.textContent)).toContain('Fetch expired'));
  handlers['sync.apply'] = () => ({ ok: true, data: { state: 'running', done: 0, total: 1 } });
  fireEvent.click(screen.getByText('Write 3 files'));
  await waitFor(() => expect(calls('sync.apply')).toHaveLength(1));
  expect(screen.getByText('Write 3 files')).toHaveProperty('disabled', false);
});

it('caps long lists and shows the full diff fallback for very large files', async () => {
  const many = Array.from({ length: 105 }, (_, index) => row(`C${index}`, 'changed'));
  const deleted = Array.from({ length: 22 }, (_, index) => row(`D${index}`, 'deleted'));
  handlers['sync.check'] = () => ({ ok: true, data: check([...many, ...deleted]) });
  const files = Array.from({ length: 102 }, (_, index) => ({ path: `f${index}.cls`, key: `ApexClass:C${index}`, action: 'create' as const }));
  status = [{ ...ready, files: [{ path: 'big.cls', key: 'ApexClass:C0', action: 'conflict' }, ...files], missing: Array.from({ length: 21 }, (_, index) => `ApexClass:M${index}`) }];
  handlers['sync.diff'] = () => ({ ok: true, data: { path: 'big.cls', local: Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n'), org: Array.from({ length: 2000 }, (_, i) => `o${i}`).join('\n') } });
  handlers['sync.apply'] = () => ({ ok: true, data: { state: 'applied', written: 102, kept: 1, skipped: [] } });
  show();
  expect(await screen.findByText(/No longer in the org, kept locally: D0, .* and 2 more$/)).toBeTruthy();
  await showAll();
  expect(await screen.findByText('and 5 more')).toBeTruthy();
  expect(screen.getByText(/and 2 more$/)).toBeTruthy();
  fireEvent.click(screen.getByText('Fetch 105 components'));
  expect(await screen.findByText('and 2 more')).toBeTruthy();
  expect(screen.getByText(/and 1 more$/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
  expect(await screen.findByText(/too many lines/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByText('Write 102 files')); });
  expect(await screen.findByText(/Kept 1 local file\./)).toBeTruthy();
});

it('blocks fetching more than the per-fetch maximum', async () => {
  handlers['sync.check'] = () => ({ ok: true, data: check(Array.from({ length: 5001 }, (_, index) => row(`C${index}`, 'changed'))) });
  show();
  expect(await screen.findByRole('button', { name: 'Update 5,000' })).toBeTruthy();
  await showAll();
  expect(await screen.findByText('Fetch 5,001 components')).toHaveProperty('disabled', true);
  expect(screen.getByText('Fetch at most 5,000 components at a time.')).toBeTruthy();
});

it('opens on a summary with one action per group, and Choose narrows the list to that group', async () => {
  show();
  const changed = within(await screen.findByRole('region', { name: 'Changed in org' }));
  expect(changed.getByText('1 · Changed in org')).toBeTruthy();
  expect(changed.getByText(/Latest: Ada,/)).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Changed in both' })).getByRole('button', { name: 'Review' }).className).toContain('primary');
  expect(within(screen.getByRole('region', { name: 'Not compared yet' })).getByRole('button', { name: 'Compare' })).toBeTruthy();
  expect(screen.getByText(/No longer in the org, kept locally: Gone/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Show all 5 components' })).toBeTruthy();

  fireEvent.click(within(screen.getByRole('region', { name: 'Only in org' })).getByRole('button', { name: 'Choose…' }));
  expect(screen.getByText('Fetch 1 component')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter components' }), { target: { value: 'zzz' } });
  expect(screen.getByText(/No names match/)).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter components' }), { target: { value: 'ORG' } });
  expect(screen.getAllByRole('region').map(node => node.getAttribute('aria-label'))).toEqual(['Changed in org']);
  fireEvent.click(screen.getByRole('button', { name: '← Summary' }));

  fireEvent.click(within(screen.getByRole('region', { name: 'Changed in org' })).getByRole('button', { name: 'Update' }));
  await screen.findByText(/1 in conflict/);
  expect(calls('sync.fetch.start')).toEqual([{ components: ['ApexClass:Org'], orgId: '00D1' }]);
});

it('checks one agent, lists what it uses by kind with up-to-date rows, and fetches all of it by default', async () => {
  const agentCheck = check([
    row('Support_3', 'new', { key: 'AiAuthoringBundle:Support_3', type: 'AiAuthoringBundle', latest: true }),
    row('Route', 'unknown', { key: 'Flow:Route', type: 'Flow' }),
    row('Edited', 'conflict'), row('Old', 'deleted'),
  ], { agent: {
    name: 'Support',
    current: [{ key: 'GenAiPromptTemplate:Summarize', type: 'GenAiPromptTemplate', fullName: 'Summarize', modifiedAt: null, modifiedBy: null }],
    missing: ['ApexClass:Ghost'],
  } });
  handlers['sync.check'] = () => ({ ok: true, data: agentCheck });
  expect([...agentSelection(agentCheck)]).toEqual(['AiAuthoringBundle:Support_3', 'Flow:Route', 'ApexClass:Edited']);
  render(<OrgSyncDialog call={call} scope="agentforce" agent="Support" onClose={close} />);
  expect(screen.getByText(/Comparing Support and what it uses/)).toBeTruthy();
  expect(await screen.findByText('Fetch 3 components')).toBeTruthy();
  expect(calls('sync.check')).toEqual([{ agent: 'Support' }]);
  expect(screen.getByRole('heading').textContent).toBe('Fetch Support from org');
  expect(screen.queryByRole('group', { name: 'What to fetch' })).toBeNull();
  expect(screen.getAllByRole('region').map(node => node.getAttribute('aria-label'))).toEqual(['Agent', 'Apex', 'Flows', 'Prompt templates']);
  expect(within(screen.getByRole('region', { name: 'Agent' })).getByText('Newer version')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Apex' })).getByText('Gone from org')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Summarize is up to date' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/4 components to compare · 1 up to date/)).toBeTruthy();
  expect(screen.getByText('Used by the agent but not in the org: Ghost')).toBeTruthy();
  fireEvent.click(within(screen.getByRole('region', { name: 'Flows' })).getByRole('checkbox'));
  expect(screen.getByText('Fetch 2 components')).toBeTruthy();
  fireEvent.click(within(screen.getByRole('region', { name: 'Flows' })).getByRole('checkbox'));
  fireEvent.click(screen.getByText('Fetch 3 components'));
  await screen.findByText(/1 in conflict/);
  expect(calls('sync.fetch.start')).toEqual([{ components: ['AiAuthoringBundle:Support_3', 'ApexClass:Edited', 'Flow:Route'], orgId: '00D1' }]);
});

it('says an agent is up to date when nothing related changed', async () => {
  handlers['sync.check'] = () => ({ ok: true, data: check([], { agent: { name: 'Support', current: [], missing: [] } }) });
  render(<OrgSyncDialog call={call} scope="agentforce" agent="Support" onClose={close} />);
  expect(await screen.findByText('Support and what it uses are up to date.')).toBeTruthy();
  expect(screen.getByText('Fetch 0 components')).toHaveProperty('disabled', true);
});
