import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { foldDiff, lineDiff } from '../../lib/line-diff.js';
import {
  SCOPE_LABELS, SYNC_FETCH_MAX, SYNC_RPC, SYNC_SCOPES, TYPE_LABELS,
  type SyncCheck, type SyncComponent, type SyncDiff, type SyncJob, type SyncPlanFile, type SyncScope, type SyncState, type SyncType,
} from '../../lib/org-sync-contract.js';
import { requireResult } from './components/client.js';
import { SALESFORCE_STYLES } from './components/styles.js';

type Call = (method: string, args?: Record<string, unknown>) => Promise<unknown>;
type Ready = Extract<SyncJob, { state: 'ready' }>;
type Applied = Extract<SyncJob, { state: 'applied' }>;
type Group = { id: string; title: string; hint: string; preselect: boolean; action: string; rows: SyncComponent[] };

/** Rows rendered per group; selection still covers the whole group. */
const VISIBLE_ROWS = 100;
const POLL_MS = 1000;
const MARK = { add: '+', del: '−', same: ' ' } as const;
const STYLES = `
.sf-sync { width:640px; overflow:hidden; }
/* Header and footer stay put; only the lists scroll, so Fetch and Write are always in reach. */
.sf-sync[open] { display:flex; flex-direction:column; }
.sf-sync .sf-login-body { gap:14px; flex:1 1 auto; min-height:0; overflow:auto; grid-template-columns:minmax(0,1fr); }
.sf-sync-scope { display:flex; gap:6px; flex-wrap:wrap; }
.sf-sync-group { border:1px solid var(--border); border-radius:8px; }
.sf-sync-group > header { display:flex; align-items:center; gap:8px; padding:8px 10px; background:var(--bg-base); border-radius:8px 8px 0 0; }
.sf-sync-group > header small, .sf-sync-row small { color:var(--text-muted); }
.sf-sync-rows { max-height:200px; overflow:auto; }
.sf-sync-row { display:flex; align-items:center; gap:8px; padding:5px 10px; border-top:1px solid var(--border); overflow-wrap:anywhere; }
.sf-sync-row > span { flex:1; min-width:0; }
.sf-sync-more { padding:5px 10px; border-top:1px solid var(--border); color:var(--text-muted); font-size:11px; }
.sf-sync-progress { height:4px; border-radius:2px; background:var(--bg-base); overflow:hidden; }
.sf-sync-progress > span { display:block; height:100%; background:var(--accent); transition:width .3s; }
.sf-sync-choice { display:flex; gap:4px; }
.sf-sync-choice .sf-btn { padding:3px 8px; font-size:11px; }
.sf-sync-choice .sf-btn[aria-pressed=true] { background:var(--accent); color:var(--bg-panel); }
.sf-sync-code { margin:0; padding:6px 0; max-height:260px; overflow:auto; border-top:1px solid var(--border); font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
.sf-sync-line { display:flex; white-space:pre; padding-right:8px; }
.sf-sync-line.is-add { background:color-mix(in srgb,var(--success, #2e844a) 14%,transparent); }
.sf-sync-line.is-del { background:color-mix(in srgb,var(--danger) 14%,transparent); }
.sf-sync-summary { display:grid; gap:8px; }
.sf-sync-card { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:center; border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
.sf-sync-card.is-first { border-color:var(--accent); }
.sf-sync-card small { color:var(--text-muted); }
.sf-sync-card > div:last-child { display:flex; gap:6px; }
.sf-sync-filter { width:100%; }
.sf-sync-pill { flex:none; font-size:11px; font-weight:600; padding:1px 7px; border-radius:999px; background:var(--bg-base); color:var(--text-muted); }
.sf-sync-pill.is-changed, .sf-sync-pill.is-latest { background:color-mix(in srgb,var(--success, #2e844a) 14%,transparent); color:var(--success, #2e844a); }
.sf-sync-pill.is-new { background:color-mix(in srgb,var(--accent) 14%,transparent); color:var(--accent); }
.sf-sync-pill.is-conflict, .sf-sync-pill.is-deleted { background:color-mix(in srgb,var(--danger) 14%,transparent); color:var(--danger); }
.sf-sync-row.is-current { color:var(--text-muted); }
.sf-sync-line.is-gap { color:var(--text-muted); font-style:italic; }
.sf-sync-ln { flex:0 0 22px; text-align:center; color:var(--text-muted); user-select:none; }
@media (prefers-reduced-motion:reduce) { .sf-sync-progress > span { transition:none; } }
`;

const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
const when = (at: string | null) => at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
/** `force-app/main/default/classes/A.cls` → `classes/A.cls`; the full path stays in the tooltip. */
const short = (path: string) => path.replace(/^(?:.*\/)?main\/default\//, '');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Splits a check into the groups the user picks from; agent versions they already work on come first. */
export function syncGroups(check: SyncCheck): Group[] {
  const by = (test: (row: SyncComponent) => boolean) => check.components.filter(test);
  return [
    { id: 'conflict', title: 'Changed in both', hint: 'Local edits since the last fetch. You choose per file before anything is written.', preselect: true, action: 'Review', rows: by(row => row.state === 'conflict') },
    { id: 'changed', title: 'Changed in org', hint: 'Untouched locally, so taking the org version is safe.', preselect: true, action: 'Update', rows: by(row => row.state === 'changed') },
    { id: 'latest', title: 'Newer agent versions', hint: 'The newest org version of agents in this project.', preselect: true, action: 'Update', rows: by(row => row.state === 'new' && Boolean(row.latest)) },
    { id: 'new', title: 'Only in org', hint: 'Not in this project yet.', preselect: false, action: 'Add', rows: by(row => row.state === 'new' && !row.latest) },
    { id: 'unknown', title: 'Not compared yet', hint: 'Never fetched here. Fetching compares contents and only changed files are offered.', preselect: false, action: 'Compare', rows: by(row => row.state === 'unknown') },
  ].filter(group => group.rows.length);
}

/** What an agent check shows per state; up-to-date rows come from `check.agent.current`. */
const STATE_LABELS: Record<SyncState | 'latest' | 'current', string> = {
  changed: 'Changed in org', conflict: 'Edited in both', unknown: 'Not compared', new: 'Not in project', latest: 'Newer version', deleted: 'Gone from org', current: 'Up to date',
};
const AGENT_SECTIONS: Array<[string, SyncType]> = [['Agent', 'AiAuthoringBundle'], ['Apex', 'ApexClass'], ['Flows', 'Flow'], ['Prompt templates', 'GenAiPromptTemplate']];

/** The groups a scope check recommends: conflicts, org changes and newer agent versions. */
const defaultSelection = (check: SyncCheck) => new Set(syncGroups(check).filter(group => group.preselect).flatMap(group => group.rows.map(row => row.key)));

/** Everything an agent check found except deletions; fetching compares contents, so unchanged files are dropped. */
export const agentSelection = (check: SyncCheck) => new Set(check.components.filter(row => row.state !== 'deleted').map(row => row.key));

/**
 * Fetch latest. With `agent`, it covers that agent and what its actions call; otherwise a scope opens on a
 * summary of what changed, with one action per group and a full list behind Choose.
 */
export function OrgSyncDialog({ call, scope: initialScope, agent, onClose }: { call: Call; scope: SyncScope; agent?: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const alive = useRef(true);
  const job = useRef('');
  const [scope, setScope] = useState(initialScope);
  const [check, setCheck] = useState<SyncCheck | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [plan, setPlan] = useState<Ready | null>(null);
  const [take, setTake] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);

  const cancelJob = () => {
    const id = job.current;
    job.current = '';
    if (id) void call(SYNC_RPC.cancel, { jobId: id }).catch(() => undefined);
  };
  const close = () => { cancelJob(); onClose(); };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      alive.current = false;
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  // A closed panel must not leave a temp retrieve behind.
  useEffect(() => () => cancelJob(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let current = true;
    setBusy(true); setError(''); setCheck(null); setChoosing(false);
    call(SYNC_RPC.check, agent ? { agent } : { scope }).then(value => {
      const data = requireResult<{ data: SyncCheck }>(value).data;
      if (!current) return;
      setCheck(data);
      setSelected(agent ? agentSelection(data) : defaultSelection(data));
    }).catch(e => { if (current) setError(message(e)); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [agent, call, scope]);

  async function fetchSelected(keys = [...selected]) {
    if (!check || !keys.length) return;
    setBusy(true); setError(''); setProgress({ done: 0, total: keys.length });
    try {
      const started = requireResult<{ jobId: string }>(await call(SYNC_RPC.start, { components: keys, orgId: check.org.orgId }));
      job.current = started.jobId;
      for (;;) {
        const state = requireResult<{ data: SyncJob }>(await call(SYNC_RPC.status, { jobId: started.jobId })).data;
        if (!alive.current || job.current !== started.jobId) return;
        if (state.state === 'failed') throw Error(state.error);
        if (state.state === 'ready') {
          setPlan(state);
          setTake(new Set());
          if (!state.files.some(file => file.action !== 'same')) cancelJob();
          return;
        }
        if (state.state === 'running') setProgress({ done: state.done, total: state.total });
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
      }
    } catch (e) {
      job.current = '';
      if (alive.current) { setError(message(e)); setProgress(null); }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function apply() {
    const id = job.current;
    if (!id) return;
    setBusy(true); setError('');
    try {
      const state = requireResult<{ data: SyncJob }>(await call(SYNC_RPC.apply, { jobId: id, take: [...take] })).data;
      job.current = '';
      if (!alive.current) return;
      if (state.state !== 'applied') throw Error(state.state === 'failed' ? state.error : 'The fetch is no longer available. Check again.');
      setResult(state);
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const step = result ? 'done' : plan ? 'plan' : progress ? 'fetching' : 'check';
  const changes = plan?.files.filter(file => file.action !== 'same') ?? [];
  const conflicts = changes.filter(file => file.action === 'conflict');
  const writes = changes.length - conflicts.length + take.size;
  let footer: ReactNode;
  const listing = Boolean(agent) || choosing;
  if (step === 'check' && listing) footer = <button type="button" className="sf-btn primary" disabled={busy || !selected.size || selected.size > SYNC_FETCH_MAX} onClick={() => void fetchSelected()}>
    {busy && !check ? 'Checking…' : `Fetch ${plural(selected.size, 'component')}`}</button>;
  else if (step === 'plan' && changes.length) footer = <button type="button" className="sf-btn primary" disabled={busy || !writes} onClick={() => void apply()}>
    {busy ? 'Applying…' : `Write ${plural(writes, 'file')}`}</button>;

  return <dialog className="sf-login-dialog sf-sync" ref={ref} aria-labelledby={title} onCancel={event => { event.preventDefault(); closeRef.current(); }}>
    <style>{SALESFORCE_STYLES + STYLES}</style>
    <div className="sf-login-heading">
      <h2 id={title}>{agent ? `Fetch ${agent} from org` : 'Fetch latest from org'}</h2>
      <p>{check ? `${check.org.alias} · ` : ''}Nothing is written until you review the changes.</p>
    </div>
    <div className="sf-login-body">
      {step === 'check' && <>
        {!agent && <div className="sf-sync-scope" role="group" aria-label="What to fetch">
          {SYNC_SCOPES.map(value => <button key={value} type="button" className={`sf-btn${value === scope ? ' primary' : ' quiet'}`} aria-pressed={value === scope} disabled={busy} onClick={() => setScope(value)}>{SCOPE_LABELS[value]}</button>)}
        </div>}
        {!check && busy && <p className="sf-muted" role="status">{agent ? `Comparing ${agent} and what it uses with the org…` : 'Comparing with the org…'}</p>}
        {check && agent && <AgentView check={check} selected={selected} onSelect={setSelected} />}
        {check && !agent && !choosing && <SummaryView check={check} busy={busy}
          onFetch={keys => void fetchSelected(keys)}
          onChoose={keys => { setSelected(keys ? new Set(keys) : defaultSelection(check)); setChoosing(true); }} />}
        {check && !agent && choosing && <>
          <button type="button" className="sf-btn quiet" style={{ justifySelf: 'start' }} onClick={() => setChoosing(false)}>← Summary</button>
          <CheckView check={check} selected={selected} onSelect={setSelected} />
        </>}
      </>}
      {step === 'fetching' && progress && <div role="status">
        <p>Retrieving {plural(progress.total, 'component')} into a temporary folder…</p>
        <div className="sf-sync-progress" aria-hidden="true"><span style={{ width: `${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%` }} /></div>
        <p className="sf-muted sf-small">{progress.done.toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')} retrieved</p>
      </div>}
      {step === 'plan' && plan && <PlanView plan={plan} changes={changes} take={take} onTake={setTake} call={call} jobId={job.current} />}
      {step === 'done' && result && <ResultView result={result} />}
      {error && <p className="sf-login-error" role="alert">{error}</p>}
    </div>
    <div className="sf-login-footer">
      <p>{step === 'check' && selected.size > SYNC_FETCH_MAX ? `Fetch at most ${SYNC_FETCH_MAX.toLocaleString('en-US')} components at a time.` : 'Local edits are never overwritten without your choice.'}</p>
      <div className="sf-login-buttons">
        <button type="button" className="sf-btn quiet" onClick={close}>{step === 'done' || (step === 'plan' && !changes.length) ? 'Close' : 'Cancel'}</button>
        {footer}
      </div>
    </div>
  </dialog>;
}

/** One card per group: its count, who changed it last, and a single action. Choose opens the full list on that group. */
function SummaryView({ check, busy, onFetch, onChoose }: { check: SyncCheck; busy: boolean; onFetch(keys: string[]): void; onChoose(keys?: string[]): void }) {
  const groups = useMemo(() => syncGroups(check), [check]);
  const listed = groups.reduce((sum, group) => sum + group.rows.length, 0);
  if (!groups.length) return <p className="sf-muted" role="status">{plural(check.counts.current, 'component')} up to date · Nothing new in the org{check.truncated ? ' · Showing the first results only' : ''}</p>;
  return <div className="sf-sync-summary">
    {groups.map((group, index) => {
      const keys = group.rows.map(row => row.key);
      const last = group.rows.find(row => row.modifiedBy || row.modifiedAt);
      const fetchable = Math.min(keys.length, SYNC_FETCH_MAX);
      return <section key={group.id} className={`sf-sync-card${index === 0 ? ' is-first' : ''}`} aria-label={group.title}>
        <div>
          <strong>{keys.length.toLocaleString('en-US')} · {group.title}</strong><br />
          <small>{group.hint}{last ? ` Latest: ${[last.modifiedBy, when(last.modifiedAt)].filter(Boolean).join(', ')}.` : ''}</small>
        </div>
        <div>
          <button type="button" className="sf-btn quiet" disabled={busy} onClick={() => onChoose(keys.slice(0, fetchable))}>Choose…</button>
          <button type="button" className={`sf-btn${index === 0 ? ' primary' : ''}`} disabled={busy} onClick={() => onFetch(keys.slice(0, fetchable))}>
            {keys.length === 1 ? group.action : fetchable === keys.length ? `${group.action} all` : `${group.action} ${fetchable.toLocaleString('en-US')}`}</button>
        </div>
      </section>;
    })}
    <p className="sf-muted sf-small" role="status">{plural(check.counts.current, 'component')} up to date{check.truncated ? ' · Showing the first results only' : ''}</p>
    <DeletedNote check={check} />
    <button type="button" className="sf-btn quiet" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => onChoose()}>Show all {plural(listed, 'component')}</button>
  </div>;
}

function DeletedNote({ check }: { check: SyncCheck }) {
  const deleted = check.components.filter(row => row.state === 'deleted');
  return deleted.length > 0 && <p className="sf-muted sf-small">No longer in the org, kept locally: {deleted.slice(0, 20).map(row => row.fullName).join(', ')}{deleted.length > 20 ? ` and ${deleted.length - 20} more` : ''}</p>;
}

/** The agent and what it uses, by kind, with up-to-date rows shown but not selectable. */
function AgentView({ check, selected, onSelect }: { check: SyncCheck; selected: Set<string>; onSelect(next: Set<string>): void }) {
  const current = check.agent?.current ?? [];
  const missing = check.agent?.missing ?? [];
  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key); else next.delete(key);
    onSelect(next);
  };
  const sections = AGENT_SECTIONS.map(([label, type]) => ({ label, rows: check.components.filter(row => row.type === type), current: current.filter(row => row.type === type) }))
    .filter(section => section.rows.length || section.current.length);
  return <>
    <p className="sf-muted" role="status">{check.components.length
      ? `${plural(check.components.length, 'component')} to compare · ${current.length.toLocaleString('en-US')} up to date`
      : `${check.agent?.name ?? 'This agent'} and what it uses are up to date.`}</p>
    {sections.map(section => <section key={section.label} className="sf-sync-group" aria-label={section.label}>
      <header><span className="sf-grow"><strong>{section.label}</strong> <small>{section.rows.length + section.current.length}</small></span></header>
      <div className="sf-sync-rows">
        {section.rows.map(row => {
          const state = row.state === 'new' && row.latest ? 'latest' : row.state;
          return <label key={row.key} className="sf-sync-row">
            <input type="checkbox" checked={selected.has(row.key)} disabled={row.state === 'deleted'} onChange={event => toggle(row.key, event.target.checked)} />
            <span>{row.fullName} <small>{[row.modifiedBy, when(row.modifiedAt)].filter(Boolean).join(' · ')}</small></span>
            <span className={`sf-sync-pill is-${state}`}>{STATE_LABELS[state]}</span>
          </label>;
        })}
        {section.current.map(row => <div key={row.key} className="sf-sync-row is-current">
          <input type="checkbox" checked={false} disabled aria-label={`${row.fullName} is up to date`} />
          <span>{row.fullName}</span>
          <span className="sf-sync-pill">{STATE_LABELS.current}</span>
        </div>)}
      </div>
    </section>)}
    {missing.length > 0 && <p className="sf-muted sf-small">Used by the agent but not in the org: {missing.slice(0, 20).map(key => key.split(':')[1]).join(', ')}{missing.length > 20 ? ` and ${missing.length - 20} more` : ''}</p>}
  </>;
}

function CheckView({ check, selected, onSelect }: { check: SyncCheck; selected: Set<string>; onSelect(next: Set<string>): void }) {
  const [filter, setFilter] = useState('');
  const all = useMemo(() => syncGroups(check), [check]);
  const needle = filter.trim().toLowerCase();
  const groups = needle ? all.map(group => ({ ...group, rows: group.rows.filter(row => row.fullName.toLowerCase().includes(needle)) })).filter(group => group.rows.length) : all;
  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(selected);
    for (const key of keys) if (on) next.add(key); else next.delete(key);
    onSelect(next);
  };
  return <>
    <input type="search" className="sf-input sf-sync-filter" aria-label="Filter components" placeholder="Filter by name" value={filter} onChange={event => setFilter(event.target.value)} />
    <p className="sf-muted" role="status">
      {plural(check.counts.current, 'component')} up to date{all.length ? '' : ' · Nothing new in the org'}{needle && !groups.length ? ' · No names match' : ''}{check.truncated ? ' · Showing the first results only' : ''}
    </p>
    {groups.map(group => {
      const keys = group.rows.map(row => row.key);
      const count = keys.filter(key => selected.has(key)).length;
      return <section key={group.id} className="sf-sync-group" aria-label={group.title}>
        <header>
          <input type="checkbox" aria-label={`Select all ${group.title}`} checked={count === keys.length}
            ref={input => { if (input) input.indeterminate = count > 0 && count < keys.length; }}
            onChange={event => toggle(keys, event.target.checked)} />
          <span className="sf-grow"><strong>{group.title}</strong> <small>{count} of {keys.length}</small><br /><small>{group.hint}</small></span>
        </header>
        <div className="sf-sync-rows">
          {group.rows.slice(0, VISIBLE_ROWS).map(row => <label key={row.key} className="sf-sync-row">
            <input type="checkbox" checked={selected.has(row.key)} onChange={event => toggle([row.key], event.target.checked)} />
            <span>{row.fullName} <small>{TYPE_LABELS[row.type]}</small></span>
            <small>{[row.modifiedBy, when(row.modifiedAt)].filter(Boolean).join(' · ')}</small>
          </label>)}
          {group.rows.length > VISIBLE_ROWS && <div className="sf-sync-more">and {(group.rows.length - VISIBLE_ROWS).toLocaleString('en-US')} more</div>}
        </div>
      </section>;
    })}
    <DeletedNote check={check} />
  </>;
}

function PlanView({ plan, changes, take, onTake, call, jobId }: { plan: Ready; changes: SyncPlanFile[]; take: Set<string>; onTake(next: Set<string>): void; call: Call; jobId: string }) {
  const [open, setOpen] = useState('');
  const count = (action: SyncPlanFile['action']) => plan.files.filter(file => file.action === action).length;
  const conflicts = changes.filter(file => file.action === 'conflict');
  const choose = (path: string, org: boolean) => {
    const next = new Set(take);
    if (org) next.add(path); else next.delete(path);
    onTake(next);
  };
  const summary = [[count('update'), 'to update'], [count('create'), 'new'], [count('conflict'), 'in conflict'], [count('same'), 'already identical']] as const;
  return <>
    <p role="status">{changes.length
      ? summary.filter(([n]) => n).map(([n, label]) => `${n.toLocaleString('en-US')} ${label}`).join(' · ')
      : `Your project already matches the org for ${plural(plan.components, 'component')}.`}</p>
    {conflicts.length > 0 && <section className="sf-sync-group" aria-label="Conflicts">
      <header>
        <span className="sf-grow"><strong>Changed in both</strong><br /><small>Keep local leaves your file alone. Take org replaces it.</small></span>
        <button type="button" className="sf-btn quiet" onClick={() => onTake(take.size === conflicts.length ? new Set() : new Set(conflicts.map(file => file.path)))}>
          {take.size === conflicts.length ? 'Keep local for all' : 'Take org for all'}</button>
      </header>
      <div className="sf-sync-rows" style={{ maxHeight: 320 }}>
        {conflicts.map(file => <div key={file.path}>
          <div className="sf-sync-row">
            <span title={file.path}>{short(file.path)} {file.added !== undefined && <small>+{file.added} −{file.removed}</small>}</span>
            <button type="button" className="sf-btn quiet" aria-expanded={open === file.path} onClick={() => setOpen(open === file.path ? '' : file.path)}>Diff</button>
            <div className="sf-sync-choice" role="group" aria-label={`Resolve ${file.path}`}>
              <button type="button" className="sf-btn quiet" aria-pressed={!take.has(file.path)} onClick={() => choose(file.path, false)}>Keep local</button>
              <button type="button" className="sf-btn quiet" aria-pressed={take.has(file.path)} onClick={() => choose(file.path, true)}>Take org</button>
            </div>
          </div>
          {open === file.path && <FileDiff call={call} jobId={jobId} path={file.path} />}
        </div>)}
      </div>
    </section>}
    {changes.length > conflicts.length && <section className="sf-sync-group" aria-label="Files to write">
      <header><span className="sf-grow"><strong>Will be written</strong></span></header>
      <div className="sf-sync-rows">
        {changes.filter(file => file.action !== 'conflict').slice(0, VISIBLE_ROWS).map(file => <div key={file.path} className="sf-sync-row">
          <span title={file.path}>{short(file.path)}</span><small>{file.action === 'create' ? 'new' : file.added !== undefined ? `+${file.added} −${file.removed}` : 'update'}</small>
        </div>)}
        {changes.length - conflicts.length > VISIBLE_ROWS && <div className="sf-sync-more">and {(changes.length - conflicts.length - VISIBLE_ROWS).toLocaleString('en-US')} more</div>}
      </div>
    </section>}
    {plan.missing.length > 0 && <p className="sf-muted sf-small">Not returned by the org: {plan.missing.slice(0, 20).join(', ')}{plan.missing.length > 20 ? ` and ${plan.missing.length - 20} more` : ''}</p>}
  </>;
}

function FileDiff({ call, jobId, path }: { call: Call; jobId: string; path: string }) {
  const [diff, setDiff] = useState<SyncDiff | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    call(SYNC_RPC.diff, { jobId, path })
      .then(value => { if (current) setDiff(requireResult<{ data: SyncDiff }>(value).data); })
      .catch(e => { if (current) setError(message(e)); });
    return () => { current = false; };
  }, [call, jobId, path]);
  const lines = useMemo(() => diff ? lineDiff(diff.local, diff.org) : null, [diff]);
  if (error) return <p className="sf-login-error sf-small" role="alert">{error}</p>;
  if (!diff) return <p className="sf-muted sf-small" role="status">Loading diff…</p>;
  if (!lines) return <p className="sf-muted sf-small" role="status">These versions differ in too many lines to diff here.</p>;
  return <>{diff.truncated && <p className="sf-muted sf-small" role="status">The file is large, so only its start is compared here.</p>}<pre className="sf-sync-code" aria-label={`Local to org changes in ${path}`}>{foldDiff(lines).map((hunk, index) => hunk.type === 'gap'
    ? <span key={index} className="sf-sync-line is-gap"><span className="sf-sync-ln" />⋯ {hunk.count} unchanged line{hunk.count === 1 ? '' : 's'}</span>
    : hunk.lines.map((line, row) => <span key={`${index}:${row}`} className={`sf-sync-line${line.type === 'same' ? '' : ` is-${line.type}`}`}>
      <span className="sf-sync-ln">{MARK[line.type]}</span>{line.text}</span>))}</pre></>;
}

function ResultView({ result }: { result: Applied }) {
  return <div role="status">
    <p><strong>Wrote {plural(result.written, 'file')}.</strong>{result.kept ? ` Kept ${plural(result.kept, 'local file')}.` : ''}</p>
    {result.skipped.length > 0 && <>
      <p className="sf-muted">Skipped {plural(result.skipped.length, 'file')}:</p>
      <ul className="sf-small">{result.skipped.slice(0, 50).map(row => <li key={row.path}>{row.path}: {row.reason}</li>)}</ul>
    </>}
  </div>;
}
