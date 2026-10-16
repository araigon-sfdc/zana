/**
 * Design Docs settings inside the workbench: one header button opens a tabbed
 * view (Peers | Agent) that replaces the doc list and doc while open.
 */
import type { ReactNode } from 'react';
import { ArrowLeft, Settings as SettingsIcon } from 'lucide-react';
import type { PeerStatus } from './api.js';
import { usePersistentState } from './hooks.js';
import { PeerSettings } from './PeerSettings.js';

export type SettingsTab = 'peers' | 'agent';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'peers', label: 'Peers' },
  { id: 'agent', label: 'Agent' }
];

/**
 * The header toggle. From the docs it is a compact "Settings" button carrying
 * the peer count once a sync group exists; from settings it is the way back.
 */
export function SettingsToggle({ open, peer, onToggle }: { open: boolean; peer: PeerStatus | null; onToggle(): void }) {
  if (open) {
    return (
      <button
        type="button"
        className="btn dd-head-btn dd-settings-toggle"
        aria-pressed
        aria-label="Back to design docs"
        title="Back to design docs"
        onClick={onToggle}
      >
        <ArrowLeft size={13} aria-hidden /> <span>Design docs</span>
      </button>
    );
  }
  const count = peer?.configured ? peer.members.length : null;
  return (
    <button
      type="button"
      className={`btn dd-head-btn dd-settings-toggle${count === null ? ' dd-head-icon' : ''}`}
      aria-pressed={false}
      aria-label="Settings"
      title={count === null ? 'Design Docs settings: peers and agent' : `Design Docs settings: ${count} sync peers, agent`}
      onClick={onToggle}
    >
      <SettingsIcon size={13} aria-hidden />
      {count !== null ? <span className="dd-head-count">{count}</span> : null}
    </button>
  );
}

/** The settings view: tabs for database sync peers and the agent harness. */
export function SettingsView({ peer, onBack, headerActions }: { peer: PeerStatus | null; onBack(): void; headerActions?: ReactNode }) {
  const [tab, setTab] = usePersistentState<SettingsTab>('settings-tab', 'peers');
  const active = TABS.some((entry) => entry.id === tab) ? tab : 'peers';
  return (
    <div className="dd-peers-view dd-settings-view">
      <div className="dd-list-head dd-peers-view-head">
        <SettingsToggle open peer={peer} onToggle={onBack} />
        <h2 className="dd-list-title dd-peers-view-title">Settings</h2>
        <div className="dd-rail-tabs dd-settings-tabs" role="tablist" aria-label="Design Docs settings">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`dd-settings-tab-${entry.id}`}
              aria-selected={active === entry.id}
              aria-controls={`dd-settings-panel-${entry.id}`}
              className={`dd-rail-tab${active === entry.id ? ' on' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="dd-spacer" />
        {headerActions}
      </div>
      <div className="dd-peers-view-scroll">
        <div
          className="dd-peers-view-body"
          role="tabpanel"
          id={`dd-settings-panel-${active}`}
          aria-labelledby={`dd-settings-tab-${active}`}
        >
          {active === 'peers' ? <PeerSettings /> : <AgentSettings />}
        </div>
      </div>
    </div>
  );
}

/**
 * Which AI harness Design Docs agents run on. Informational: agents always
 * follow the project's AI harness setting (`harness: 'project-default'`).
 *
 * DECISION(design-docs-ai-harness, 2026-10-13): inherit-only. No "Always use"
 * mode and no override pickers here until core offers a plugin-facing harness
 * control (doc-vault zana/design-docs-ai-harness/proposal.md). A read-only
 * "what will this resolve to" summary was skipped: it needs a new SDK surface.
 */
export function AgentSettings() {
  return (
    <section className="dd-agent-settings" aria-label="Agent harness">
      <h3 className="dd-peers-heading">Agent harness</h3>
      <p className="dd-muted dd-agent-intro">
        Design Docs agents (Create &amp; draft, Ask agent and Publish) use the AI harness settings of the doc&apos;s project. They
        look in this order:
      </p>
      <ol className="dd-muted dd-agent-order">
        <li>the doc&apos;s project;</li>
        <li>for a doc with no project, the Default Project;</li>
        <li>anything the project leaves unset, the global AI harness settings.</li>
      </ol>
      <p className="dd-muted dd-agent-help">
        Change these in <strong>Settings → AI Harness</strong>, where you can also install and enable harnesses. If a project
        setting can&apos;t be used by Design Docs agents, the agent won&apos;t start and the error names that setting.
      </p>
    </section>
  );
}
