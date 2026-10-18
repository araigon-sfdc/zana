// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { SyncCheck } from '../../lib/org-sync-contract.js';
import { agentGroups, isChange, modeKeys, modeLabel, needsAttention, pickRows, readMemory, replaceType, selectable, typeMode, writeMemory, type PickRow } from './org-sync-picker.js';

const row = (fullName: string, state: PickRow['state'], extra: Partial<PickRow> = {}): PickRow =>
  ({ key: `ApexClass:${fullName}`, type: 'ApexClass', fullName, modifiedAt: null, modifiedBy: null, state, ...extra });
const agent = (fullName: string, state: PickRow['state'], modifiedAt: string | null = null, extra: Partial<PickRow> = {}) =>
  row(fullName, state, { key: `AiAuthoringBundle:${fullName}`, type: 'AiAuthoringBundle', modifiedAt, ...extra });

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('classifies rows for selection and preselection', () => {
  expect(selectable(row('A', 'deleted'))).toBe(false);
  expect(selectable(row('A', 'current'))).toBe(true);
  expect(['conflict', 'changed', 'new', 'unknown', 'current'].map(state => isChange(row('A', state as PickRow['state'])))).toEqual([true, true, true, false, false]);
  expect(needsAttention(row('A', 'new'))).toBe(false);
  expect(needsAttention(row('A', 'new', { latest: true }))).toBe(true);
  expect(needsAttention(row('A', 'changed'))).toBe(true);
});

it('lists every row by type, newest first, with up-to-date rows included', () => {
  const check = {
    components: [row('B', 'changed', { modifiedAt: '2026-01-01' }), row('A', 'new', { modifiedAt: '2026-01-01' }), row('C', 'new', { modifiedAt: '2026-02-01' }), row('X', 'new', { type: 'Nope' as never })],
    current: [{ key: 'Flow:F', type: 'Flow', fullName: 'F', modifiedAt: null, modifiedBy: null }],
  } as unknown as SyncCheck;
  const rows = pickRows(check);
  expect(rows.get('ApexClass')!.map(item => item.fullName)).toEqual(['C', 'A', 'B']);
  expect(rows.get('Flow')).toEqual([expect.objectContaining({ fullName: 'F', state: 'current' })]);
  expect(pickRows({ components: [] } as unknown as SyncCheck).get('Flow')).toEqual([]);
});

it('groups agent versions, finds the newest retrievable and the project version', () => {
  const groups = agentGroups([
    agent('Bot_2', 'deleted', '2026-03-01'), agent('Bot_10', 'new', '2026-01-01'), agent('Bot_3', 'changed', null),
    agent('Solo', 'new', null), agent('Gone_1', 'deleted', null), agent('Alpha', 'new', null),
  ]);
  expect(groups.map(group => group.base)).toEqual(['Bot', 'Alpha', 'Gone', 'Solo']);
  expect(groups[0]).toMatchObject({ latest: { fullName: 'Bot_10' }, local: 3 });
  expect(groups[0]!.rows.map(item => item.fullName)).toEqual(['Bot_10', 'Bot_3', 'Bot_2']);
  expect(groups[3]).toMatchObject({ local: null, latest: { fullName: 'Solo' } });
  expect(groups[2]!.latest.fullName).toBe('Gone_1');
});

it('maps whole-type modes to keys and back, and labels them', () => {
  const apex = [row('A', 'changed'), row('B', 'current'), row('C', 'deleted')];
  expect(modeKeys('ApexClass', 'all', apex)).toEqual(['ApexClass:A', 'ApexClass:B']);
  expect(modeKeys('ApexClass', 'changes', apex)).toEqual(['ApexClass:A']);
  expect(modeKeys('ApexClass', 'latest', apex)).toEqual(['ApexClass:A', 'ApexClass:B']);
  expect(modeKeys('ApexClass', 'none', apex)).toEqual([]);
  expect(typeMode('ApexClass', apex, new Set())).toBe('none');
  expect(typeMode('ApexClass', apex, new Set(['ApexClass:A']))).toBe('changes');
  expect(typeMode('ApexClass', apex, new Set(['ApexClass:B']))).toBe('custom');
  expect(modeLabel('ApexClass', apex, new Set())).toBe('');
  expect(modeLabel('ApexClass', apex, new Set(['ApexClass:A', 'ApexClass:B']))).toBe('All 2');
  expect(modeLabel('ApexClass', apex, new Set(['ApexClass:A']))).toBe('Changes · 1');
  expect(modeLabel('ApexClass', apex, new Set(['ApexClass:B']))).toBe('1 picked');

  const agents = [agent('Bot_2', 'current'), agent('Bot_1', 'current'), agent('Other', 'current')];
  expect(modeKeys('AiAuthoringBundle', 'latest', agents)).toEqual(['AiAuthoringBundle:Bot_2', 'AiAuthoringBundle:Other']);
  expect(modeLabel('AiAuthoringBundle', agents, new Set(['AiAuthoringBundle:Bot_2', 'AiAuthoringBundle:Other']))).toBe('Latest of 2');
  expect(replaceType(new Set(['ApexClass:A', 'Flow:F']), 'ApexClass', ['ApexClass:B'])).toEqual(new Set(['Flow:F', 'ApexClass:B']));
});

it('reads only valid remembered modes and writes or clears them', () => {
  expect(readMemory(undefined)).toBeNull();
  writeMemory(undefined, { ApexClass: 'all' });
  expect(readMemory('k')).toBeNull();
  writeMemory('k', { ApexClass: 'all', Flow: 'changes' });
  expect(readMemory('k')).toEqual({ ApexClass: 'all', Flow: 'changes' });
  writeMemory('k', {});
  expect(localStorage.getItem('k')).toBeNull();
  writeMemory('k', { ApexClass: 'all' });
  writeMemory('k', null);
  expect(localStorage.getItem('k')).toBeNull();
  for (const raw of ['[1]', '"text"', '{"Nope":"all","ApexClass":"sometimes"}', '{bad']) {
    localStorage.setItem('k', raw);
    expect(readMemory('k')).toBeNull();
  }
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('full'); });
  expect(() => writeMemory('k', { ApexClass: 'all' })).not.toThrow();
});

void ({} as SyncComponent);
