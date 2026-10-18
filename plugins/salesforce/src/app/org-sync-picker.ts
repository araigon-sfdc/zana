import { agentVersion, SYNC_TYPES, type SyncCheck, type SyncCurrent, type SyncState, type SyncType } from '../../lib/org-sync-contract.js';

/** How a whole type is picked; `custom` is any hand-picked set that matches none of the others. */
export type PickMode = 'none' | 'changes' | 'latest' | 'all';
export type PickRow = SyncCurrent & { state: SyncState | 'current'; latest?: boolean };
export type AgentGroup = { base: string; rows: PickRow[]; latest: PickRow; local: number | null };

export const PICK_TYPES: Array<[SyncType, string]> = [
  ['AiAuthoringBundle', 'Agents'], ['ApexClass', 'Apex classes'], ['ApexTrigger', 'Apex triggers'], ['LightningComponentBundle', 'Lightning web components'],
  ['Flow', 'Flows'], ['GenAiPromptTemplate', 'Prompt templates'], ['LightningTypeBundle', 'Lightning types'],
];
export const PICK_STATES: Record<PickRow['state'], string> = {
  conflict: 'Edited in both', changed: 'Changed in org', new: 'Only in org', unknown: 'Not compared', current: 'Up to date', deleted: 'Gone from org',
};

/** A deleted component has nothing left to retrieve. */
export const selectable = (row: PickRow) => row.state !== 'deleted';
/** Differs from the project in a way fetching resolves. */
export const isChange = (row: PickRow) => row.state === 'conflict' || row.state === 'changed' || row.state === 'new';
/** What the dialog preselects: conflicts, org changes and newer versions of agents the project has. */
export const needsAttention = (row: PickRow) => row.state === 'conflict' || row.state === 'changed' || (row.state === 'new' && Boolean(row.latest));

/** Every row of a check, up-to-date ones included, by type and newest change first. */
export function pickRows(check: SyncCheck): Map<SyncType, PickRow[]> {
  const byType = new Map<SyncType, PickRow[]>(SYNC_TYPES.map(type => [type, []]));
  const rows: PickRow[] = [...check.components, ...(check.current ?? []).map(row => ({ ...row, state: 'current' as const }))];
  for (const row of rows) byType.get(row.type)?.push(row);
  for (const list of byType.values()) list.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || a.fullName.localeCompare(b.fullName));
  return byType;
}

/** Agent versions under their agent, newest version first; agents most recently changed first. */
export function agentGroups(rows: PickRow[]): AgentGroup[] {
  const groups = new Map<string, PickRow[]>();
  for (const row of rows) {
    const { base } = agentVersion(row.fullName);
    groups.set(base, [...(groups.get(base) ?? []), row]);
  }
  return [...groups].map(([base, list]) => {
    list.sort((a, b) => agentVersion(b.fullName).version - agentVersion(a.fullName).version);
    const local = list.filter(row => row.state !== 'new').map(row => agentVersion(row.fullName).version);
    return { base, rows: list, latest: list.find(selectable) ?? list[0]!, local: local.length ? Math.max(...local) : null };
  }).sort((a, b) => newest(b.rows).localeCompare(newest(a.rows)) || a.base.localeCompare(b.base));
}
const newest = (rows: PickRow[]) => rows.reduce((top, row) => (row.modifiedAt ?? '') > top ? row.modifiedAt! : top, '');

/** The keys a whole-type mode selects. */
export function modeKeys(type: SyncType, mode: PickMode, rows: PickRow[]): string[] {
  const open = rows.filter(selectable);
  if (mode === 'all') return open.map(row => row.key);
  if (mode === 'changes') return open.filter(isChange).map(row => row.key);
  if (mode === 'latest') return type === 'AiAuthoringBundle' ? agentGroups(open).map(group => group.latest.key) : open.map(row => row.key);
  return [];
}

/** Which mode a type's current selection matches, or `custom`. */
export function typeMode(type: SyncType, rows: PickRow[], selected: Set<string>): PickMode | 'custom' {
  const picked = rows.filter(row => selected.has(row.key)).length;
  if (!picked) return 'none';
  const modes: PickMode[] = type === 'AiAuthoringBundle' ? ['all', 'latest', 'changes'] : ['all', 'changes'];
  return modes.find(mode => {
    const keys = modeKeys(type, mode, rows);
    return keys.length === picked && keys.every(key => selected.has(key));
  }) ?? 'custom';
}

/** The tray label for one type: `All 24`, `Latest of 5`, `Changes · 6`, `3 picked`. */
export function modeLabel(type: SyncType, rows: PickRow[], selected: Set<string>): string {
  const picked = rows.filter(row => selected.has(row.key)).length;
  const mode = typeMode(type, rows, selected);
  if (mode === 'none') return '';
  if (mode === 'all') return `All ${picked.toLocaleString('en-US')}`;
  if (mode === 'latest') return `Latest of ${picked.toLocaleString('en-US')}`;
  if (mode === 'changes') return `Changes · ${picked.toLocaleString('en-US')}`;
  return `${picked.toLocaleString('en-US')} picked`;
}

/** `next` with the keys of one type replaced by `keys`. */
export function replaceType(selected: Set<string>, type: SyncType, keys: string[]): Set<string> {
  const next = new Set([...selected].filter(key => !key.startsWith(`${type}:`)));
  for (const key of keys) next.add(key);
  return next;
}

/** Remembered whole-type modes; hand-picked sets are not remembered. */
export type PickMemory = Partial<Record<SyncType, PickMode>>;

export function readMemory(key: string | undefined): PickMemory | null {
  if (!key) return null;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const modes: PickMemory = {};
    for (const [type, mode] of Object.entries(value)) {
      if (SYNC_TYPES.includes(type as SyncType) && ['none', 'changes', 'latest', 'all'].includes(mode as string)) modes[type as SyncType] = mode as PickMode;
    }
    return Object.keys(modes).length ? modes : null;
  } catch { return null; }
}

export function writeMemory(key: string | undefined, modes: PickMemory | null) {
  if (!key) return;
  try { if (modes && Object.keys(modes).length) localStorage.setItem(key, JSON.stringify(modes)); else localStorage.removeItem(key); }
  catch { /* storage is optional */ }
}
