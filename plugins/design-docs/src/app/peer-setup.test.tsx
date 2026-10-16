// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestPluginRuntime } from '@zana-ai/zcc-plugin-sdk/testing/app';
import { INVITE_POLL_MS, INVITE_WAITING_POLL_MS, PeerSettings } from './PeerSettings.js';
import type { InviteItem, InviteView, PeerLink } from './api.js';
import { createHarness } from './test-harness.js';
import { createApi } from './api.js';

afterEach(() => { vi.useRealTimers(); });
// These tests cover the code format; the link format is covered in invite-links.test.tsx.
beforeEach(() => localStorage.setItem('zcc.design-docs.invite-format', JSON.stringify('code')));
/** Manual Refresh is gone: status reloads on the poll interval, so tests drive that interval. */
const fakePolling = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
const pollOnce = () => act(async () => { vi.advanceTimersByTime(INVITE_WAITING_POLL_MS); });

describe('database peer settings UI', () => {
  it('shows honest installer blocker; enables selected core peer and shows pending jobs', async () => {
    const harness = createHarness();
    const status = { configured: false, repoId: 'database', replicaId: 'r-a', roster: null, members: [], jobs: [], setup: null,
      peers: [], enrolled: [{ id: 'app-b', name: 'Laptop', connected: true }], lifecycleAvailable: true, introductionsAvailable: true, installerAvailable: false };
    const enable = vi.fn(async () => ({ ...status, setup: { peerId: 'app-b', repoId: 'database', state: 'pending', error: 'bilateral database enablement required' },
      jobs: [{ id: 'job0', peerId: 'app-b', state: 'pending' }] }));
    installTestPluginRuntime({ rpc: { groupStatus: async () => status, enablePeer: enable } });
    harness.render(<PeerSettings />);
    expect(await screen.findByText(/No sync group/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add peer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry|Refresh/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Sponsors|reserved seats|introductions/i);
    expect((screen.getByRole('button', { name: 'Enable Database Sync' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Enrolled peer'), { target: { value: 'app-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable Database Sync' }));
    await screen.findByText(/Setup pending/);
    expect(enable).toHaveBeenCalledExactlyOnceWith({ peerId: 'app-b' });
    expect(screen.getByText(/app-b: pending/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('no authorized links and failed setup never claim completion', async () => {
    const harness = createHarness();
    let fail = false;
    installTestPluginRuntime({ rpc: { groupStatus: async () => {
      if (fail) throw new Error('core unavailable');
      return { configured: false, repoId: 'database', members: [], jobs: [], peers: [], enrolled: [], setup: null, roster: null };
    } } });
    harness.render(<PeerSettings />);
    await screen.findByText(/No sync group/);
    expect(screen.queryByLabelText('Enrolled peer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable Database Sync' })).toBeNull();
    fakePolling();
    cleanup();
    harness.render(<PeerSettings />);
    await screen.findByText(/No sync group/);
    fail = true; await pollOnce();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'core unavailable');
    expect(screen.queryByText(/Group:/)).toBeNull();
  });

  it('typed API forwards lifecycle identifiers only', async () => {
    const call = vi.fn(async () => ({})); const api = createApi(call);
    await api.groupStatus(); await api.enablePeer('app'); await api.retryIntroductions(); await api.removePeer('replica'); await api.revokePeer('app');
    expect(call.mock.calls).toEqual([['groupStatus', undefined], ['enablePeer', { peerId: 'app' }],
      ['retryIntroductions', undefined], ['removePeer', { replicaId: 'replica' }], ['revokePeer', { peerId: 'app' }]]);
  });

  it('confirms link disable separately from membership removal; two-member group cannot shrink', async () => {
    const harness = createHarness();
    const members = ['a', 'b'].map((name) => ({ replicaId: `r-${name}`, machineId: `app-${name}`, authorized: true, connected: true, grantEpoch: 1, joinedAt: 1, sponsorReplicaId: null }));
    const status = { configured: true, repoId: 'database', replicaId: 'r-a', roster: { rosterEpoch: 1 },
      members, jobs: [], setup: null, peers: [], enrolled: [], lifecycleAvailable: true, introductionsAvailable: true, installerAvailable: false };
    const revoked = { ...status, members: members.map((member) => member.machineId === 'app-b' ? { ...member, authorized: false } : member) };
    const revoke = vi.fn(async () => revoked), remove = vi.fn();
    installTestPluginRuntime({ rpc: { groupStatus: async () => status, revokePeer: revoke, removePeer: remove } });
    const priorConfirm = window.confirm;
    const confirm = vi.fn(() => false); window.confirm = confirm;
    try {
      harness.render(<PeerSettings />);
      await screen.findByText('Sync group: 2 of 8 computers');
      expect(screen.getByText('This computer: connected')).toBeTruthy();
      expect(screen.getByText('Unnamed computer: connected').getAttribute('title')).toBe('Computer id app-b');
      expect(screen.getByText('Unnamed computer: connected').textContent).not.toContain('app-b');
      expect(screen.getByRole('button', { name: 'Remove Member' })).toHaveProperty('disabled', true);
      expect(screen.getByRole('button', { name: 'Leave Group' })).toHaveProperty('disabled', true);
      fireEvent.click(screen.getByRole('button', { name: 'Disable Link' }));
      expect(revoke).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith('Disable this local database link? Group membership is unchanged.');
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole('button', { name: 'Disable Link' }));
      await waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith({ peerId: 'app-b' }));
      expect(remove).not.toHaveBeenCalled();
      expect(screen.getByText('Sync group: 2 of 8 computers')).toBeTruthy();
    } finally { window.confirm = priorConfirm; }
  });

  it('non-founder can remove or leave; capacity wait stays visible without success claim', async () => {
    const harness = createHarness();
    const members = ['a', 'b', 'c'].map((name) => ({ replicaId: `r-${name}`, machineId: `app-${name}`, authorized: true, connected: true }));
    const status = { configured: true, repoId: 'database', replicaId: 'r-c', roster: { rosterEpoch: 3 }, members,
      jobs: [], peers: [], enrolled: [], lifecycleAvailable: true, introductionsAvailable: true,
      setup: { peerId: 'app-d', state: 'pending', error: 'waiting for reserved capacity' } };
    const remove = vi.fn(async () => status);
    installTestPluginRuntime({ rpc: { groupStatus: async () => status, removePeer: remove } });
    const priorConfirm = window.confirm; window.confirm = vi.fn(() => true);
    try {
      harness.render(<PeerSettings />);
      await screen.findByText(/Setup pending: app-d: waiting for reserved capacity/);
      expect(screen.getAllByRole('button', { name: 'Remove Member' })).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Leave Group' }));
      await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith({ replicaId: 'r-c' }));
      expect(window.confirm).toHaveBeenCalledWith('Remove this member? Syncing with them stops on this computer now. If they are offline, removal finishes when they reconnect.');
    } finally { window.confirm = priorConfirm; }
  });

  it('missing protected storage disables lifecycle actions and reports introductions unavailable', async () => {
    const harness = createHarness();
    installTestPluginRuntime({ rpc: { groupStatus: async () => ({ configured: false, repoId: 'database', replicaId: 'r-a', roster: null,
      members: [], jobs: [], setup: null, peers: [], enrolled: [{ id: 'app-b', name: 'Laptop', connected: true }],
      lifecycleAvailable: false, introductionsAvailable: false, installerAvailable: false }) } });
    harness.render(<PeerSettings />);
    await screen.findByText(/Database sync cannot start on this app yet: Core peer lifecycle needs protected key storage/);
    expect(screen.queryByText(/Automatic introductions are unavailable/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Enrolled peer'), { target: { value: 'app-b' } });
    expect(screen.getByRole('button', { name: 'Enable Database Sync' })).toHaveProperty('disabled', true);
  });

  it('pending retirement keeps member visible without data authorization or removal success', async () => {
    const harness = createHarness();
    const members = ['a', 'b', 'c'].map((name) => ({ replicaId: `r-${name}`, machineId: `app-${name}`,
      retiring: name === 'b', authorized: name !== 'b', connected: name !== 'b' }));
    const status = { configured: true, repoId: 'database', replicaId: 'r-a', roster: { rosterEpoch: 4 }, members,
      jobs: [{ id: 'retire', kind: 'retire', peerId: 'app-b', state: 'blocked', error: 'waiting for committed frontier' }],
      peers: [], enrolled: [], setup: null, lifecycleAvailable: true, introductionsAvailable: true };
    installTestPluginRuntime({ rpc: { groupStatus: async () => status } });
    harness.render(<PeerSettings />);
    await screen.findByText('Sync group: 3 of 8 computers');
    expect(screen.getByText(/Unnamed computer: retiring - waiting for committed frontier; data sync disabled/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Remove Member' })[0]).toHaveProperty('disabled', true);
    expect(screen.getAllByRole('button', { name: 'Disable Link' })[0]).toHaveProperty('disabled', false);
    expect(screen.getByText(/app-b: blocked: waiting for committed frontier/)).toBeTruthy();
  });

  it('leads with copy/paste pairing and never requires Settings or Machines', async () => {
    const harness = createHarness();
    installTestPluginRuntime({ rpc: { groupStatus: async () => ({ configured: false, repoId: 'database', replicaId: 'r-a', roster: null,
      members: [], jobs: [{ id: 'done', peerId: 'app-b', state: 'done', error: null }], setup: null, peers: [], enrolled: [],
      lifecycleAvailable: true, introductionsAvailable: true, installerAvailable: false }) } });
    harness.render(<PeerSettings />);
    const section = await screen.findByRole('region', { name: 'Database sync peers' });
    expect(section.hasAttribute('data-plugin-setting-key')).toBe(false);
    expect(screen.getByRole('heading', { name: 'Pair another computer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add peer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Join peer' })).toHaveProperty('disabled', true);
    await screen.findByText(/No sync group/);
    expect(section.textContent).not.toMatch(/Machines|Add a machine/);
    expect(screen.queryByRole('list', { name: 'Members' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Pending work' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Pairing' })).toBeNull();
    expect(screen.queryByText(/Database sync cannot start/)).toBeNull();
    expect(screen.queryByText(/Automatic introductions are unavailable/)).toBeNull();
  });

  it('explains missing introductions when lifecycle is ready; offline enrolled peers cannot be chosen', async () => {
    const harness = createHarness();
    installTestPluginRuntime({ rpc: { groupStatus: async () => ({ configured: false, repoId: 'database', replicaId: 'r-a', roster: null,
      members: [], jobs: [], setup: { peerId: 'app-b', repoId: 'database', state: 'joining', error: null }, peers: [],
      enrolled: [{ id: 'app-b', name: 'Desk', connected: false }], lifecycleAvailable: true, introductionsAvailable: false, installerAvailable: false }) } });
    harness.render(<PeerSettings />);
    await screen.findByText(/Automatic introductions are unavailable on this app/);
    expect(screen.getByRole('status').textContent).toBe('Setup joining: app-b');
    const option = screen.getByRole('option', { name: 'Desk - offline' }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(screen.queryByText(/No enrolled peer is online yet/)).toBeNull();
  });

  it('initial load failure shows the error and shows no lifecycle buttons', async () => {
    const harness = createHarness();
    const groupStatus = vi.fn(async () => { throw new Error('database group setup is unavailable'); });
    installTestPluginRuntime({ rpc: { groupStatus } });
    harness.render(<PeerSettings />);
    expect((await screen.findByRole('alert')).textContent).toBe('database group setup is unavailable');
    expect(screen.queryByText('Loading peers')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable Database Sync' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh|Retry/ })).toBeNull();
  });

  it('cancelled retirement confirmation leaves membership untouched', async () => {
    const harness = createHarness();
    const members = ['a', 'b', 'c'].map((name) => ({ replicaId: `r-${name}`, machineId: `app-${name}`, authorized: true, connected: true }));
    const remove = vi.fn();
    installTestPluginRuntime({ rpc: { groupStatus: async () => ({ configured: true, repoId: 'database', replicaId: 'r-a', roster: { rosterEpoch: 2 },
      members, jobs: [], peers: [], enrolled: [], setup: null, lifecycleAvailable: true, introductionsAvailable: true }), removePeer: remove } });
    const priorConfirm = window.confirm; window.confirm = vi.fn(() => false);
    try {
      harness.render(<PeerSettings />);
      await screen.findByText('Sync group: 3 of 8 computers');
      fireEvent.click(screen.getAllByRole('button', { name: 'Remove Member' })[0]!);
      expect(window.confirm).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
    } finally { window.confirm = priorConfirm; }
  });

  it('typed API forwards invitation actions with identifiers and the pasted token only', async () => {
    const call = vi.fn(async () => ({})); const api = createApi(call);
    await api.inviteState(); await api.createInvitation(); await api.openInvitation(); await api.redeemInvitation('zccinv1.x'); await api.invitationApproval('i');
    await api.decideInvitation({ invitationId: 'i', decision: 'approved', ownerProof: 'p' }); await api.decideInvitation({ invitationId: 'i', decision: 'denied', ownerProof: undefined });
    await api.cancelInvitation('i'); await api.reconnectPeer('app'); await api.peersOutOfSync();
    expect(call.mock.calls).toEqual([['inviteState', undefined], ['createInvitation', undefined], ['openInvitation', undefined], ['redeemInvitation', { token: 'zccinv1.x' }],
      ['invitationApproval', { invitationId: 'i' }], ['decideInvitation', { invitationId: 'i', decision: 'approved', ownerProof: 'p' }],
      ['decideInvitation', { invitationId: 'i', decision: 'denied' }], ['cancelInvitation', { invitationId: 'i' }],
      ['reconnectPeer', { peerId: 'app' }], ['peersOutOfSync', undefined]]);
  });
});

const EMPTY = { configured: false, repoId: 'database', replicaId: 'r-a', roster: null, members: [] as unknown[], jobs: [], setup: null, peers: [],
  enrolled: [] as Array<{ id: string; name: string; connected: boolean }>, lifecycleAvailable: true, introductionsAvailable: true, installerAvailable: false };
const item = (over: Partial<InviteItem> = {}): InviteItem => ({ invitationId: 'inv-1', role: 'inviter', state: 'open', reason: null, peer: null, localFingerprint: 'LOCAL-0001',
  myDecision: 'pending', theirDecision: 'pending', awaitingMyApproval: false, expiresAt: Date.now() + 600_000, consentExpiresAt: null, ...over });
const view = (over: Partial<InviteView> = {}): InviteView => ({ available: true, reason: null, invitations: [], links: [], enableError: null, ...over });
const peer = { instanceId: 'app-b', name: 'Laptop', fingerprint: 'ABCD-1234' };
const lnk = (over: Partial<PeerLink> = {}): PeerLink => ({ pairingId: 'pair-1', peerInstanceId: 'app-b', scope: 'database', role: 'inviter', phase: 'linked', state: 'connected', ...over });
function mount(rpc: Record<string, (args?: any) => unknown>, props: Parameters<typeof PeerSettings>[0] = {}) {
  const harness = createHarness();
  installTestPluginRuntime({ rpc: { groupStatus: async () => EMPTY, inviteState: async () => view(), ...rpc } });
  return harness.render(<PeerSettings {...props} />);
}

describe('invitation pairing UI', () => {
  it.each([
    ['ssh_remote_login_off', /Remote Login is turned off/, /System Settings > General > Sharing/],
    ['ssh_unreachable', /cannot be reached/, /same Wi-Fi or wired network/],
    ['ssh_auth_refused', /would not accept the connection/, /authorized_keys/],
    ['ssh_forwarding_refused', /does not allow the connection Zana needs/, /TCP forwarding/],
    ['ssh_host_key_mismatch', /not the one that made the invitation/, /new invitation/]
  ] as const)('Add peer failing with %s shows a guided setup card with steps', async (code, title, step) => {
    const harness = createHarness();
    installTestPluginRuntime({ rpc: { groupStatus: async () => EMPTY, inviteState: async () => view(),
      createInvitation: async () => { throw new Error(code); } } });
    harness.render(<PeerSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add peer' }));
    const alert = await screen.findByText(title);
    expect(alert.closest('[role="alert"]')?.textContent).toMatch(step);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('tells owners both computers must be on the same network and where Remote Login lives', async () => {
    const harness = createHarness();
    installTestPluginRuntime({ rpc: { groupStatus: async () => EMPTY, inviteState: async () => view() } });
    harness.render(<PeerSettings />);
    expect(await screen.findByText(/Both computers must be on the same network/)).toBeTruthy();
    expect(screen.getByText(/System Settings > General > Sharing > Remote Login/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Zana Connect/);
  });

  it('Add peer copies a one-time invitation, shows time left and issues a replacement on demand', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const create = vi.fn().mockResolvedValueOnce({ invitationId: 'inv-1', token: 'zccinv1.first', expiresAt: Date.now() + 9 * 60_000 + 30_000 })
      .mockResolvedValueOnce({ invitationId: 'inv-2', token: 'zccinv1.second', expiresAt: Date.now() + 30_000 });
    const cancel = vi.fn(async () => undefined);
    let state = view();
    fakePolling();
    mount({ createInvitation: create, cancelInvitation: cancel, inviteState: async () => state });
    expect(await screen.findByText(/An invitation works once and must be pasted on the other computer within 10 minutes\./)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Add peer' }));
    expect(await screen.findByText(/Expires in 9:30/)).toBeTruthy();
    expect((screen.getByLabelText('Invitation') as HTMLInputElement).value).toBe('zccinv1.first');
    expect(writeText).toHaveBeenCalledWith('zccinv1.first');
    await screen.findByRole('button', { name: 'Copy invitation' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy invitation' }));
    expect(writeText).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'New invitation' }));
    await waitFor(() => expect((screen.getByLabelText('Invitation') as HTMLInputElement).value).toBe('zccinv1.second'));
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ invitationId: 'inv-1' });
    expect(screen.getByText(/Expires in 0:\d\d/)).toBeTruthy();
    // Once the other computer redeems it, the token is gone from the screen.
    state = view({ invitations: [item({ invitationId: 'inv-2', state: 'reserved', peer })] });
    await pollOnce();
    await waitFor(() => expect(screen.queryByLabelText('Invitation')).toBeNull());
    expect(document.body.textContent).not.toContain('zccinv1');
  });

  it('shows an expired invitation without its token and lets the owner cancel one', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    const cancel = vi.fn(async () => undefined);
    mount({ createInvitation: async () => ({ invitationId: 'inv-1', token: 'zccinv1.old', expiresAt: Date.now() - 1 }), cancelInvitation: cancel });
    fireEvent.click(await screen.findByRole('button', { name: 'Add peer' }));
    expect(await screen.findByText(/Invitation expired\./)).toBeTruthy();
    expect(screen.queryByLabelText('Invitation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy invitation' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New invitation' })).toBeNull());
    expect(cancel).toHaveBeenCalledWith({ invitationId: 'inv-1' });
  });

  it('keeps the invitation visible with a manual-copy message when the clipboard is blocked, and reports exact create errors', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    const create = vi.fn().mockResolvedValueOnce({ invitationId: 'inv-1', token: 'zccinv1.manual', expiresAt: Date.now() + 600_000 })
      .mockRejectedValueOnce(new Error('Could not create the invitation.'));
    mount({ createInvitation: create, cancelInvitation: async () => undefined });
    fireEvent.click(await screen.findByRole('button', { name: 'Add peer' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Copy failed/);
    expect((screen.getByLabelText('Invitation') as HTMLInputElement).value).toBe('zccinv1.manual');
    fireEvent.focus(screen.getByLabelText('Invitation'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy invitation' }));
    fireEvent.click(screen.getByRole('button', { name: 'New invitation' }));
    expect((await screen.findByText('Could not create the invitation.'))).toBeTruthy();
  });

  it('copies through the legacy path when the desktop denies navigator.clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    mount({ createInvitation: async () => ({ invitationId: 'inv-1', token: 'zccinv1.legacy', expiresAt: Date.now() + 600_000 }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Add peer' }));
    expect(await screen.findByRole('button', { name: 'Copy invitation' })).toBeTruthy();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(screen.queryByText(/Copy failed/)).toBeNull();
    Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true });
  });

  it('Join peer redeems the pasted invitation once and clears the field', async () => {
    const redeem = vi.fn().mockResolvedValueOnce(item({ role: 'redeemer', state: 'redeeming' })).mockRejectedValueOnce(new Error('This invitation was already used'));
    mount({ redeemInvitation: redeem });
    const field = await screen.findByLabelText('Paste invitation') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '  zccinv1.pasted  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join peer' }));
    await waitFor(() => expect(redeem).toHaveBeenCalledExactlyOnceWith({ token: 'zccinv1.pasted' }));
    await waitFor(() => expect(field.value).toBe(''));
    fireEvent.change(field, { target: { value: 'zccinv1.again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join peer' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This invitation was already used');
    expect(field.value).toBe('zccinv1.again');
  });

  it('older hosts: only the new action is blocked, with the stable reason; an existing group still renders and syncs', async () => {
    const members = ['a', 'b'].map((name) => ({ replicaId: `r-${name}`, machineId: `app-${name}`, authorized: true, connected: true }));
    mount({ inviteState: async () => view({ available: false, reason: 'host cannot invite peers' }),
      groupStatus: async () => ({ ...EMPTY, configured: true, roster: { rosterEpoch: 1 }, members }) });
    expect(await screen.findByText(/Host cannot invite peers\. Your existing sync group keeps working/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add peer' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Paste invitation')).toHaveProperty('disabled', true);
    expect(await screen.findByText('Sync group: 2 of 8 computers')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Peer links' })).toBeNull();
  });

  it('inviteState failure leaves pairing actions usable and shows no invitation list', async () => {
    mount({ inviteState: async () => { throw new Error('rpc down'); } });
    await screen.findByText(/No sync group/);
    expect(screen.getByRole('button', { name: 'Add peer' })).toHaveProperty('disabled', false);
    expect(screen.queryByRole('list', { name: 'Pairing' })).toBeNull();
  });

  it.each([
    ['open', {}, /Pending: waiting for the other computer/, true],
    ['redeeming', {}, /Pending: contacting the other computer/, true],
    ['consented', { peer }, /Approved\. Connecting to Laptop/, false],
    ['connecting', { peer }, /Approved\. Connecting to Laptop/, false],
    ['ready', { peer }, /Ready: paired with Laptop/, false]
  ] as const)('shows %s as a pending/ready step', async (state, extra, text, cancellable) => {
    mount({ inviteState: async () => view({ invitations: [item({ state, ...extra })] }) });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' }) !== null).toBe(cancellable);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it.each([
    ['denied', 'denied', /Pairing was declined/],
    ['cancelled', null, /Pairing was cancelled/],
    ['expired', null, /expired\. Start a new invitation/],
    ['failed', 'ssh_remote_login_off', /Remote Login is turned off/],
    ['failed', 'ssh_host_key_mismatch', /not the one that made the invitation/],
    ['failed', 'own_invitation', /created on this computer/],
    ['failed', 'unreachable', /^The other computer is not reachable yet; retrying\. Keep both computers open and online\.$/],
    ['failed', 'unavailable', /^Pairing is unavailable right now\. Check that both computers/],
    ['failed', null, /^Pairing failed\. Start a new invitation\.$/],
    ['expired', 'expired', /expired\. Start a new invitation/],
    ['failed', 'identity_mismatch', /did not prove the identity/]
  ] as const)('blocks %s/%s with the exact reason and lets the owner dismiss it', async (state, reason, text) => {
    mount({ inviteState: async () => view({ invitations: [item({ state, reason: reason as InviteItem['reason'] })] }) });
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Pairing' })).toBeNull());
  });

  it.each(['unavailable', 'unreachable'])('%s never claims an account mismatch', async (reason) => {
    mount({ inviteState: async () => view({ invitations: [item({ state: 'failed', reason: reason as InviteItem['reason'] })] }) });
    expect((await screen.findByRole('alert')).textContent).not.toMatch(/same Zana Connect account/);
  });

  it('unknown reasons fall back to a generic blocked message', async () => {
    mount({ inviteState: async () => view({ invitations: [item({ state: 'blocked' as never, reason: 'zzz' as never })] }) });
    expect((await screen.findByRole('alert')).textContent).toBe('Pairing could not continue.');
  });

  it.each([
    ['expired', null], ['expired', 'expired'], ['failed', 'attempt_limit'], ['failed', 'already_redeemed']
  ] as const)('offers a one-click new invitation for %s/%s', async (state, reason) => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    const create = vi.fn(async () => ({ invitationId: 'inv-2', token: 'zccinv1.fresh', expiresAt: Date.now() + 600_000 }));
    mount({ inviteState: async () => view({ invitations: [item({ role: 'redeemer', state, reason: reason as InviteItem['reason'] })] }), createInvitation: create });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Start a new invitation/);
    fireEvent.click(screen.getByRole('button', { name: 'Start new invitation' }));
    await waitFor(() => expect((screen.getByLabelText('Invitation') as HTMLInputElement).value).toBe('zccinv1.fresh'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Start new invitation' })).toBeNull();
  });

  it.each([['denied', 'denied'], ['cancelled', null], ['failed', 'ssh_remote_login_off'], ['failed', 'unreachable']] as const)('does not offer renewal for %s/%s', async (state, reason) => {
    mount({ inviteState: async () => view({ invitations: [item({ state, reason: reason as InviteItem['reason'] })] }) });
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Start new invitation' })).toBeNull();
  });

  it('disables renewal when the host cannot invite', async () => {
    mount({ inviteState: async () => view({ available: false, reason: 'host cannot invite peers', invitations: [item({ state: 'expired' })] }) });
    expect(await screen.findByRole('button', { name: 'Start new invitation' })).toHaveProperty('disabled', true);
  });

  it('shows the consent deadline as approve by HH:MM on a reserved pairing', async () => {
    const at = new Date(2026, 9, 14, 9, 5).getTime();
    mount({ inviteState: async () => view({ invitations: [item({ state: 'reserved', peer, awaitingMyApproval: true, consentExpiresAt: at })] }) });
    expect(await screen.findByText(/Approve by 09:05\./)).toBeTruthy();
  });

  it('backs invitation polling off from 5 s to 30 s while every live pairing waits on an owner', async () => {
    fakePolling();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const polls = () => spy.mock.calls.map((call) => call[1]).filter((ms) => ms === INVITE_POLL_MS || ms === INVITE_WAITING_POLL_MS);
    let next = view({ invitations: [item({ state: 'redeeming' })] });
    try {
      mount({ inviteState: async () => next });
      await screen.findByText(/Pending: contacting the other computer/);
      expect(polls()).toEqual([INVITE_POLL_MS]);
      next = view({ invitations: [item({ state: 'reserved', peer }), item({ invitationId: 'inv-0', state: 'expired' })] });
      await pollOnce();
      await screen.findByText(/Awaiting the other owner's approval/);
      await waitFor(() => expect(polls().at(-1)).toBe(INVITE_WAITING_POLL_MS));
      next = view({ invitations: [item({ state: 'consented', peer })] });
      await pollOnce();
      await screen.findByText(/Approved\. Connecting/);
      await waitFor(() => expect(polls().at(-1)).toBe(INVITE_POLL_MS));
    } finally { spy.mockRestore(); }
  });

  it('asks the owner to confirm the fingerprint and approve database sync only; the other side waits', async () => {
    const { rerender } = { rerender: null };
    void rerender;
    let next = view({ invitations: [item({ state: 'reserved', peer, awaitingMyApproval: true })] });
    fakePolling();
    mount({ inviteState: async () => next });
    expect(await screen.findByText(/Approve pairing with Laptop/)).toBeTruthy();
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText(/Confirm this matches the other machine's screen/)).toBeTruthy();
    expect(screen.getByText(/Design Docs database sync with this peer only/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    next = view({ invitations: [item({ state: 'reserved', peer, myDecision: 'approved' })] });
    await pollOnce();
    expect(await screen.findByText(/Awaiting the other owner's approval for Laptop/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
  });

  it('Approve opens the core approval sheet and sends only its owner proof; Deny needs none; Cancel needs none', async () => {
    const sheet = { binding: { action: 'x', target: 't', targetLabel: 'l', subject: 's' }, title: 'Pair with Laptop' };
    const decide = vi.fn(async () => item({ state: 'consented' })), cancel = vi.fn(async () => undefined);
    const requestApproval = vi.fn(async () => ({ approved: true as const, token: 'owner-proof', expiresAt: 1 }));
    mount({ inviteState: async () => view({ invitations: [item({ state: 'reserved', peer, awaitingMyApproval: true })] }), invitationApproval: async () => sheet,
      decideInvitation: decide, cancelInvitation: cancel }, { requestApproval });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decide).toHaveBeenCalledExactlyOnceWith({ invitationId: 'inv-1', decision: 'approved', ownerProof: 'owner-proof' }));
    expect(requestApproval).toHaveBeenCalledExactlyOnceWith('design-docs', sheet);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(decide).toHaveBeenLastCalledWith({ invitationId: 'inv-1', decision: 'denied' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith({ invitationId: 'inv-1' }));
  });

  it.each([
    ['cancelled', null],
    ['unavailable', 'Approval needs the Zana desktop app on this computer.'],
    ['busy', 'Another approval is already open on this window.'],
    ['invalid', 'The approval could not be shown. Refresh and try again.']
  ] as const)('an approval sheet that ends %s never decides', async (reason, message) => {
    const decide = vi.fn();
    mount({ inviteState: async () => view({ invitations: [item({ state: 'reserved', peer, awaitingMyApproval: true })] }),
      invitationApproval: async () => ({ binding: { action: 'x', target: 't', targetLabel: 'l', subject: 's' }, title: 't' }), decideInvitation: decide },
      { requestApproval: async () => ({ approved: false, reason }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    if (message) expect((await screen.findByRole('alert')).textContent).toBe(message);
    else await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', false));
    expect(decide).not.toHaveBeenCalled();
    if (!message) expect(screen.queryByRole('alert')).toBeNull();
  });

  it('without a host that can draw the sheet, Approve fails closed', async () => {
    const decide = vi.fn();
    mount({ inviteState: async () => view({ invitations: [item({ state: 'reserved', peer, awaitingMyApproval: true })] }),
      invitationApproval: async () => ({ binding: { action: 'x', target: 't', targetLabel: 'l', subject: 's' }, title: 't' }), decideInvitation: decide });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/desktop app/);
    expect(decide).not.toHaveBeenCalled();
  });

  it('shows Connected, Reconnecting and Disconnected with exact reasons, a Disconnected notice and Reconnect', async () => {
    const reconnect = vi.fn(async () => [lnk({ state: 'reconnecting' })]);
    const links = [lnk(), lnk({ pairingId: 'p2', peerInstanceId: 'app-c', state: 'reconnecting', reason: 'peer-offline' }),
      lnk({ pairingId: 'p3', peerInstanceId: 'app-d', state: 'disconnected', reason: 'credential-expired' }),
      lnk({ pairingId: 'p4', peerInstanceId: 'app-e', state: 'disconnected', reason: 'ssh-down' }),
      lnk({ pairingId: 'p5', peerInstanceId: 'app-f', state: 'disconnected', reason: 'revoked' }),
      lnk({ pairingId: 'p6', peerInstanceId: 'app-g', state: 'disconnected' }),
      lnk({ pairingId: 'p10', peerInstanceId: 'app-j', state: 'disconnected', reason: 'paused' }),
      lnk({ pairingId: 'p7', peerInstanceId: 'app-h', phase: 'removed', state: 'disconnected' }),
      // A declined or replayed attempt never linked: not shown, and it never shadows the live link to the same peer.
      lnk({ pairingId: 'p8', peerInstanceId: 'app-i', phase: 'failed', state: 'disconnected', reason: 'peer-offline' }),
      lnk({ pairingId: 'p9', peerInstanceId: 'app-b', phase: 'failed', state: 'disconnected', reason: 'peer-offline' })];
    mount({ inviteState: async () => view({ links }), reconnectPeer: reconnect,
      groupStatus: async () => ({ ...EMPTY, enrolled: [{ id: 'app-b', name: 'Laptop', connected: true }] }) });
    const list = await screen.findByRole('list', { name: 'Peer links' });
    const rows = within(list).getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual([
      'Laptop: Connected', 'app-c: Reconnecting automatically... (the other computer is offline)Reconnect',
      'app-d: Disconnected (the link credential expired)Reconnect', 'app-e: Disconnected (the secure connection to the other computer is down)Reconnect',
      'app-f: Disconnected (the link was revoked). Add peer to pair again.', 'app-g: DisconnectedReconnect', 'app-j: Paused (Disconnected on this computer. Reconnect from Settings → Peers.)']);
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts).toContain('Disconnected from app-d (the link credential expired). Sync is paused and resumes when the link is back.');
    expect(alerts).toContain('Disconnected from app-g. Sync is paused and resumes when the link is back.');
    expect(alerts.some((text) => text?.includes('app-j'))).toBe(false);
    expect(alerts.some((text) => text?.includes('app-h') || text?.includes('app-i') || text?.includes('Laptop'))).toBe(false);
    fireEvent.click(within(list).getAllByRole('button', { name: 'Reconnect' })[1]!);
    await waitFor(() => expect(reconnect).toHaveBeenCalledExactlyOnceWith({ peerId: 'app-d' }));
  });

  it('reports a failed reconnect', async () => {
    mount({ inviteState: async () => view({ links: [lnk({ state: 'disconnected', reason: 'peer-offline' })] }), reconnectPeer: async () => { throw new Error('Pairing is not ready for that action'); } });
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain('Pairing is not ready for that action'));
  });

  it('Enable Database Sync is only for peers enrolled without an invitation; invited peers enable themselves', async () => {
    const enrolled = [{ id: 'app-b', name: 'Laptop', connected: true }, { id: 'app-legacy', name: 'Desk', connected: true }];
    const enable = vi.fn(async () => EMPTY);
    mount({ inviteState: async () => view({ links: [lnk()] }), groupStatus: async () => ({ ...EMPTY, enrolled }), enablePeer: enable });
    const select = await screen.findByLabelText('Enrolled peer');
    expect(within(select).queryByRole('option', { name: 'Laptop' })).toBeNull();
    expect(within(select).getByRole('option', { name: 'Desk' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'app-legacy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable Database Sync' }));
    await waitFor(() => expect(enable).toHaveBeenCalledExactlyOnceWith({ peerId: 'app-legacy' }));
  });

  it('with only invitation-founded peers there is no Enable button', async () => {
    mount({ inviteState: async () => view({ links: [lnk()] }), groupStatus: async () => ({ ...EMPTY, enrolled: [{ id: 'app-b', name: 'Laptop', connected: true }] }) });
    await screen.findByText(/No sync group/);
    expect(screen.queryByRole('button', { name: 'Enable Database Sync' })).toBeNull();
    expect(screen.queryByLabelText('Enrolled peer')).toBeNull();
  });

  it('surfaces an automatic enable failure', async () => {
    mount({ inviteState: async () => view({ enableError: 'mutually enrolled peer unavailable' }) });
    expect((await screen.findByRole('alert')).textContent).toBe('mutually enrolled peer unavailable');
  });

  describe('out of sync notice', () => {
    const configured = { ...EMPTY, configured: true, roster: { rosterEpoch: 1 }, members: ['a', 'b'].map((name) => ({ replicaId: `r-${name}`, machineId: `app-${name}`, authorized: true, connected: true })) };

    it('says only that the sides differ; Sync Now is explicit and then hides the notice', async () => {
      let differs = true;
      const sync = vi.fn(async () => { differs = false; return { attempted: 1, synced: 1, blocked: 0 }; });
      const harness = mountWith({ groupStatus: async () => configured, peersOutOfSync: async () => ({ outOfSync: differs }), syncNow: sync });
      const notice = await screen.findByText('This database and a paired peer are out of sync.');
      expect(notice.parentElement!.textContent).toBe('This database and a paired peer are out of sync.Sync NowCancel');
      expect(sync).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Sync Now' }));
      await waitFor(() => expect(screen.queryByText(/out of sync/)).toBeNull());
      expect(sync).toHaveBeenCalledOnce();
      expect(harness.toasts.at(-1)?.message).toBe('Synced 1 peers');
    });

    it('Sync Now re-checks and keeps the notice while the sides still differ', async () => {
      const check = vi.fn(async () => ({ outOfSync: true }));
      mountWith({ groupStatus: async () => configured, peersOutOfSync: check, syncNow: async () => ({ attempted: 1, synced: 1, blocked: 0 }) });
      await screen.findByText(/out of sync/);
      const before = check.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Sync Now' }));
      await waitFor(() => expect(check.mock.calls.length).toBeGreaterThan(before));
      expect(screen.getByText(/out of sync/)).toBeTruthy();
    });

    it('a peer state push re-checks at once and clears the notice on the receiving side', async () => {
      let differs = true;
      const check = vi.fn(async () => ({ outOfSync: differs }));
      const runtime = mountWith({ groupStatus: async () => configured, peersOutOfSync: check });
      await screen.findByText(/out of sync/);
      differs = false;
      await runtime.emitRealtime('peer-state', {});
      await waitFor(() => expect(screen.queryByText(/out of sync/)).toBeNull());
    });

    it('ignores a peer state push before a group exists', async () => {
      const check = vi.fn(async () => ({ outOfSync: true }));
      const runtime = mountWith({ peersOutOfSync: check });
      await screen.findByText(/No sync group/);
      await runtime.emitRealtime('peer-state', {});
      expect(check).not.toHaveBeenCalled();
    });

    it('Cancel hides the notice until the sides converge; later drift shows it again', async () => {
      let differs = true;
      const runtime = mountWith({ groupStatus: async () => configured, peersOutOfSync: async () => ({ outOfSync: differs }) });
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await runtime.emitRealtime('peer-state', {});
      expect(screen.queryByText(/out of sync/)).toBeNull();
      differs = false;
      await runtime.emitRealtime('peer-state', {});
      differs = true;
      await runtime.emitRealtime('peer-state', {});
      await screen.findByText(/out of sync/);
    });

    it('Cancel leaves documents untouched and keeps the notice away', async () => {
      const sync = vi.fn();
      mountWith({ groupStatus: async () => configured, peersOutOfSync: async () => ({ outOfSync: true }), syncNow: sync });
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByText(/out of sync/)).toBeNull());
      expect(sync).not.toHaveBeenCalled();
    });

    it('a failed Sync Now keeps the notice and shows the error', async () => {
      mountWith({ groupStatus: async () => configured, peersOutOfSync: async () => ({ outOfSync: true }), syncNow: async () => { throw new Error('peer unavailable'); } });
      fireEvent.click(await screen.findByRole('button', { name: 'Sync Now' }));
      expect((await screen.findByRole('alert')).textContent).toBe('peer unavailable');
      expect(screen.getByText(/out of sync/)).toBeTruthy();
    });

    it('reports a partially blocked sync and never checks before a group exists', async () => {
      const check = vi.fn(async () => ({ outOfSync: false }));
      const harness = mountWith({ groupStatus: async () => configured, peersOutOfSync: async () => ({ outOfSync: true }), syncNow: async () => ({ attempted: 2, synced: 1, blocked: 1 }) });
      fireEvent.click(await screen.findByRole('button', { name: 'Sync Now' }));
      await waitFor(() => expect(harness.toasts.at(-1)?.message).toBe('Synced 1/2; 1 blocked'));
      cleanup();
      mountWith({ peersOutOfSync: check });
      await screen.findByText(/No sync group/);
      expect(check).not.toHaveBeenCalled();
    });

    it('stays quiet when in sync or when the check fails', async () => {
      mountWith({ groupStatus: async () => configured, peersOutOfSync: async () => ({ outOfSync: false }) });
      await screen.findByText('Sync group: 2 of 8 computers');
      expect(screen.queryByText(/out of sync/)).toBeNull();
      cleanup();
      mountWith({ groupStatus: async () => configured, peersOutOfSync: async () => { throw new Error('x'); } });
      await screen.findByText('Sync group: 2 of 8 computers');
      expect(screen.queryByText(/out of sync/)).toBeNull();
    });

    function mountWith(rpc: Record<string, (args?: any) => unknown>) {
      const harness = createHarness();
      const installed = installTestPluginRuntime({ rpc: { groupStatus: async () => EMPTY, inviteState: async () => view(), ...rpc } });
      (globalThis as { __ZCC_PLUGIN_RUNTIME__: { toast: unknown } }).__ZCC_PLUGIN_RUNTIME__.toast = (message: string, kind = 'info') => { harness.toasts.push({ message, kind } as never); };
      harness.render(<PeerSettings />);
      return Object.assign(harness, { emitRealtime: installed.emitRealtime });
    }
  });
});

describe('invitation pairing UI robustness', () => {
  const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

  it('re-shows the still-open invitation token after a remount and never for another invitation', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = vi.fn(async () => ({ invitationId: 'inv-1', token: 'zccinv1.again', expiresAt: Date.now() + 600_000 }));
    mount({ inviteState: async () => view({ invitations: [item()] }), openInvitation: open });
    await waitFor(() => expect((screen.getByLabelText('Invitation') as HTMLInputElement).value).toBe('zccinv1.again'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy invitation' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('zccinv1.again'));
    cleanup();
    mount({ inviteState: async () => view({ invitations: [item({ invitationId: 'inv-9' })] }), openInvitation: open });
    await screen.findByText(/Pending: waiting for the other computer/);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText('Invitation')).toBeNull();
    cleanup();
    mount({ inviteState: async () => view({ invitations: [item()] }), openInvitation: async () => null });
    await screen.findByText(/Pending: waiting for the other computer/);
    expect(screen.queryByLabelText('Invitation')).toBeNull();
    cleanup();
    mount({ inviteState: async () => view({ invitations: [item()] }), openInvitation: async () => { throw new Error('gone'); } });
    await screen.findByText(/Pending: waiting for the other computer/);
    expect(screen.queryByLabelText('Invitation')).toBeNull();
  });

  it('a slow earlier invite response cannot overwrite a newer one', async () => {
    const slow = deferred<InviteView>();
    const replies = [() => slow.promise, async () => view({ available: false, reason: 'host cannot invite peers' })];
    let call = 0;
    fakePolling();
    mount({ inviteState: () => (replies[Math.min(call++, 1)] ?? replies[1]!)() });
    await waitFor(() => expect(call).toBe(1));
    await pollOnce();
    await screen.findByRole('note');
    slow.resolve(view());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByRole('note').textContent).toMatch(/Host cannot invite peers/);
    expect((screen.getByRole('button', { name: 'Add peer' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the last good invite view when a refresh fails', async () => {
    let fail = false;
    fakePolling();
    mount({ inviteState: async () => { if (fail) throw new Error('flaky'); return view({ available: false, reason: 'host cannot invite peers' }); } });
    await screen.findByRole('note');
    fail = true;
    await pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByRole('note').textContent).toMatch(/Host cannot invite peers/);
    expect((screen.getByRole('button', { name: 'Add peer' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('async completions after unmount are ignored', async () => {
    const status = deferred<typeof EMPTY>(), sync = deferred<{ attempted: number; synced: number; blocked: number }>(), reconnect = deferred<PeerLink[]>();
    const configured = { ...EMPTY, configured: true, roster: { rosterEpoch: 1 }, members: [{ replicaId: 'r-a', machineId: 'app-a', authorized: true, connected: true, retiring: false }],
      enrolled: [], lifecycleAvailable: true };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let first = true;
    fakePolling();
    mount({ groupStatus: () => { if (first) { first = false; return Promise.resolve(configured); } return status.promise; },
      inviteState: async () => view({ links: [lnk({ state: 'disconnected', reason: 'peer-offline' })] }), peersOutOfSync: async () => ({ outOfSync: true }),
      syncNow: () => sync.promise, reconnectPeer: () => reconnect.promise });
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Now' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await pollOnce();
    cleanup();
    status.resolve(EMPTY); sync.resolve({ attempted: 1, synced: 1, blocked: 0 }); reconnect.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejected sync after unmount does not set state', async () => {
    const sync = deferred<never>();
    const configured = { ...EMPTY, configured: true, roster: { rosterEpoch: 1 }, members: ['a', 'b'].map((n) => ({ replicaId: `r-${n}`, machineId: `app-${n}`, authorized: true, connected: true, retiring: false })) };
    mount({ groupStatus: async () => configured, peersOutOfSync: async () => ({ outOfSync: true }), syncNow: () => sync.promise });
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Now' }));
    cleanup();
    sync.reject(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('never renders the Retry/Refresh buttons or the membership paragraph, even with three members', async () => {
    const members = ['a', 'b', 'c'].map((n) => ({ replicaId: `r-${n}`, machineId: `app-${n}`, authorized: true, connected: true, retiring: false }));
    mount({ groupStatus: async () => ({ ...EMPTY, configured: true, roster: { rosterEpoch: 1 }, lifecycleAvailable: true, members }) });
    await screen.findByText('Sync group: 3 of 8 computers');
    expect(screen.queryByRole('button', { name: /Retry|Refresh/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/sponsor|reserved|seal|epoch|introduction/i);
  });

  it('explains the invitation is only for setup and the connection reconnects by itself', async () => {
    mount({});
    expect(await screen.findByText(/This invitation is only for setting up the pairing\. Once paired, the connection stays up and reconnects by itself\./)).toBeTruthy();
  });

  it('a link that is reconnecting says so and still offers Reconnect', async () => {
    mount({ inviteState: async () => view({ links: [lnk({ state: 'reconnecting' })] }) });
    const list = await screen.findByRole('list', { name: 'Peer links' });
    expect(list.textContent).toBe('app-b: Reconnecting automatically...Reconnect');
  });

  it('a revoked link has no Reconnect and points at Add peer', async () => {
    mount({ inviteState: async () => view({ links: [lnk({ state: 'disconnected', reason: 'revoked' })] }) });
    const list = await screen.findByRole('list', { name: 'Peer links' });
    expect(list.textContent).toBe('app-b: Disconnected (the link was revoked). Add peer to pair again.');
  });

  it('a reconnect failing with an ssh_* reason shows the guidance card', async () => {
    mount({ inviteState: async () => view({ links: [lnk({ state: 'disconnected', reason: 'ssh-down' })] }), reconnectPeer: async () => { throw new Error('ssh_remote_login_off'); } });
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    expect(await screen.findByText(/Remote Login is turned off/)).toBeTruthy();
  });

  it('counts down the invitation and offers Create new invitation once it expires', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const create = vi.fn()
        .mockResolvedValueOnce({ invitationId: 'inv-1', token: 'zccinv1.timed', expiresAt: Date.now() + 65_000 })
        .mockResolvedValueOnce({ invitationId: 'inv-2', token: 'zccinv1.next', expiresAt: Date.now() + 600_000 });
      mount({ createInvitation: create, cancelInvitation: async () => undefined });
      fireEvent.click(await screen.findByRole('button', { name: 'Add peer' }));
      expect(await screen.findByText(/Expires in 1:05/)).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(screen.getByText(/Expires in 1:00/)).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(screen.getByText(/Invitation expired\./)).toBeTruthy();
      expect(screen.queryByLabelText('Invitation')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Create new invitation' }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(await screen.findByText(/Expires in 8:55/)).toBeTruthy();
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
