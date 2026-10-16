// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerSettings } from './PeerSettings.js';
import { NavPanel } from './slots.js';
import { SettingsView } from './Settings.js';
import { buildInviteLink, EXPIRED_ERROR, LINK_ERROR, NOT_INVITE_LINK, parseInviteInput, parseJoinPayload, summarizeToken } from './invite-format.js';
import { createHarness } from './test-harness.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const makeToken = (over: Record<string, unknown> = {}) =>
  `zccinv1.${b64({ v: 3, id: 'inv-1', name: 'Work Mac', fp: 'ABCD-1234', exp: Date.now() + 600_000, ...over })}`;
const TOKEN = makeToken();
const BASE = 'zana-test://';
const LINK = `${BASE}plugin/design-docs/join?d=${encodeURIComponent(TOKEN)}`;
const PREF = 'zcc.design-docs.invite-format';

const EMPTY = { configured: false, repoId: 'database', replicaId: 'r-a', roster: null, members: [], jobs: [], setup: null, peers: [],
  enrolled: [], lifecycleAvailable: true, introductionsAvailable: true, installerAvailable: false };
const VIEW = { available: true, reason: null, invitations: [], links: [], enableError: null };
const baseRpc = { groupStatus: async () => EMPTY, inviteState: async () => VIEW, peersOutOfSync: async () => ({ outOfSync: false }) };

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => cleanup());

function mount(options: { deepLinkBase?: string | null; token?: string; redeem?: ReturnType<typeof vi.fn> } = {}) {
  const redeem = options.redeem ?? vi.fn(async () => ({ invitationId: 'inv-9', state: 'redeeming' }));
  const harness = createHarness({
    deepLinkBase: options.deepLinkBase,
    rpcOverrides: { ...baseRpc, redeemInvitation: redeem,
      createInvitation: async () => ({ invitationId: 'inv-1', token: options.token ?? TOKEN, expiresAt: Date.now() + 600_000 }) }
  });
  return { harness, redeem };
}

const addPeer = async () => fireEvent.click(await screen.findByRole('button', { name: 'Add peer' }));
const buttons = () => screen.getAllByRole('button').map((button) => button.textContent);

describe('invitation format: copy', () => {
  it('Add peer copies the link by default and offers the code second', async () => {
    const { harness } = mount();
    harness.render(<PeerSettings />);
    await addPeer();
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(LINK));
    expect(harness.toasts).toContainEqual({ message: 'Invitation link copied to clipboard', kind: 'info' });
    const link = await screen.findByRole('button', { name: 'Copy link' });
    const code = screen.getByRole('button', { name: 'Copy invitation' });
    expect(link.className).toContain('primary');
    expect(code.className).not.toContain('primary');
    expect(buttons().indexOf('Copy link')).toBeLessThan(buttons().indexOf('Copy invitation'));
    fireEvent.click(code);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(TOKEN));
    expect(harness.toasts).toContainEqual({ message: 'Invitation copied to clipboard', kind: 'info' });
    fireEvent.click(link);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(LINK));
  });

  it('the code format makes the code primary and is what Add peer copies', async () => {
    localStorage.setItem(PREF, JSON.stringify('code'));
    const { harness } = mount();
    harness.render(<PeerSettings />);
    await addPeer();
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(TOKEN));
    expect(harness.toasts.at(-1)).toEqual({ message: 'Invitation copied to clipboard', kind: 'info' });
    const code = await screen.findByRole('button', { name: 'Copy invitation' });
    expect(code.className).toContain('primary');
    expect(screen.getByRole('button', { name: 'Copy link' }).className).not.toContain('primary');
    expect(buttons().indexOf('Copy invitation')).toBeLessThan(buttons().indexOf('Copy link'));
  });

  it('no link scheme: no Copy link, the code is copied, and even a stored Link preference falls back', async () => {
    localStorage.setItem(PREF, JSON.stringify('link'));
    const { harness } = mount({ deepLinkBase: null });
    harness.render(<PeerSettings />);
    await addPeer();
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(TOKEN));
    await screen.findByRole('button', { name: 'Copy invitation' });
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('an oversized token hides Copy link and falls back to the code', async () => {
    const token = `zccinv1.${'a'.repeat(4100)}`;
    expect(token.length).toBeGreaterThan(4096);
    expect(buildInviteLink(BASE, token)).toBeNull();
    expect(buildInviteLink(BASE, `zccinv1.${'a'.repeat(4000)}`)).toContain('plugin/design-docs/join?d=');
    const { harness } = mount({ token });
    harness.render(<PeerSettings />);
    await addPeer();
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(token));
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('buildInviteLink rejects no base and a link over the host limit', () => {
    expect(buildInviteLink(null, TOKEN)).toBeNull();
    expect(buildInviteLink(`${'x'.repeat(5000)}://`, 'a'.repeat(4096))).toBeNull();
  });
});

describe('invitation format setting', () => {
  const settings = () => {
    const { harness } = mount();
    harness.render(<SettingsView peer={null} onBack={() => undefined} />);
    return harness;
  };

  it('lives under Sharing, defaults to Link, persists, and drives the Peers view', async () => {
    settings();
    localStorage.setItem('zcc.design-docs.settings-tab', JSON.stringify('agent'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sharing' }));
    const select = await screen.findByRole('combobox', { name: 'Invitation format' }) as HTMLSelectElement;
    expect(select.value).toBe('link');
    expect([...select.options].map((option) => option.textContent)).toEqual(['Link (clickable)', 'Code (paste)']);
    fireEvent.change(select, { target: { value: 'code' } });
    expect(localStorage.getItem(PREF)).toBe(JSON.stringify('code'));
    // Choosing a section is still remembered separately.
    expect(localStorage.getItem('zcc.design-docs.settings-tab')).toBe(JSON.stringify('sharing'));
    fireEvent.click(screen.getByRole('button', { name: 'Peers' }));
    await addPeer();
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(TOKEN));
  });

  it('shows Code when this build has no link scheme', async () => {
    const { harness } = mount({ deepLinkBase: null });
    harness.render(<SettingsView peer={null} onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sharing' }));
    expect((screen.getByRole('combobox', { name: 'Invitation format' }) as HTMLSelectElement).value).toBe('code');
    expect(screen.getByText(/Links need the Zana desktop app/)).toBeTruthy();
  });
});

describe('invitation format: join side', () => {
  const field = () => screen.findByLabelText('Paste invitation') as Promise<HTMLInputElement>;

  it('shows the helper and accepts a raw code, a link, and an opaque code the server will judge', async () => {
    const { harness, redeem } = mount();
    harness.render(<PeerSettings />);
    expect(await screen.findByText('Paste an invitation code or link.')).toBeTruthy();
    const input = await field();
    fireEvent.change(input, { target: { value: `  ${TOKEN}  ` } });
    expect((await screen.findByRole('status')).textContent).toMatch(/Join Work Mac\?.*ABCD-1234/);
    fireEvent.click(screen.getByRole('button', { name: 'Join peer' }));
    await waitFor(() => expect(redeem).toHaveBeenLastCalledWith({ token: TOKEN }));
    await waitFor(() => expect(input.value).toBe(''));
    fireEvent.change(input, { target: { value: LINK.replace('zana-test', 'zana-dev') } });
    fireEvent.click(screen.getByRole('button', { name: 'Join peer' }));
    await waitFor(() => expect(redeem).toHaveBeenCalledTimes(2));
    expect(redeem).toHaveBeenLastCalledWith({ token: TOKEN });
    await waitFor(() => expect(input.value).toBe(''));
    fireEvent.change(input, { target: { value: 'zccinv1.opaque' } });
    expect(screen.queryByText(/Join Work Mac/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Join peer' }));
    await waitFor(() => expect(redeem).toHaveBeenLastCalledWith({ token: 'zccinv1.opaque' }));
  });

  it.each([
    ['another plugin', 'zana://plugin/other/join?d=x', NOT_INVITE_LINK],
    ['another route', `zana://plugin/design-docs/other?d=${TOKEN}`, NOT_INVITE_LINK],
    ['an unknown scheme', `https://plugin/design-docs/join?d=${TOKEN}`, LINK_ERROR],
    ['an extra parameter', `zana://plugin/design-docs/join?d=${TOKEN}&x=1`, LINK_ERROR],
    ['no payload', 'zana://plugin/design-docs/join', LINK_ERROR],
    ['bad percent-encoding', 'zana://plugin/design-docs/join?d=%E0%A4%A', LINK_ERROR],
    ['an oversized link', `zana://plugin/design-docs/join?d=${'a'.repeat(9000)}`, LINK_ERROR]
  ])('a pasted link with %s is rejected without redeeming', async (_name, text, message) => {
    const { harness, redeem } = mount();
    harness.render(<PeerSettings />);
    const input = await field();
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Join peer' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(redeem).not.toHaveBeenCalled();
    expect(input.value).toBe(text);
  });

  it('parsers: tokens, scheme variants and malformed bodies', () => {
    expect(summarizeToken(TOKEN)).toMatchObject({ name: 'Work Mac', fingerprint: 'ABCD-1234' });
    for (const bad of ['zccinv1.', 'zccinv1.!!', `zccinv1.${b64('str')}`, `zccinv1.${b64(null)}`, `zccinv1.${b64({ name: '', fp: 'x', exp: 1 })}`,
      `zccinv1.${b64({ name: 'n', fp: 'x', exp: 'soon' })}`, `zccinv1.${b64({ name: 'n\u0001', fp: 'x', exp: 1 })}`, `zccinv1.${b64({ name: 'n', fp: 1, exp: 1 })}`, 'other.abc'])
      expect(summarizeToken(bad)).toBeNull();
    expect(summarizeToken(`zccinv1.${Buffer.from([0xff, 0xfe]).toString('base64url')}`)).toBeNull();
    expect(summarizeToken('zccinv1.bm90LWpzb24')).toBeNull();
    expect(parseInviteInput(LINK.replace('zana-test', 'zana-dev'))).toMatchObject({ kind: 'token', token: TOKEN });
    expect(parseInviteInput(`zana://plugin/design-docs/join/?d=${TOKEN}`)).toMatchObject({ kind: 'token' });
    expect(parseJoinPayload(null)).toEqual({ kind: 'invalid', message: LINK_ERROR });
    expect(parseJoinPayload('zccinv1.opaque')).toEqual({ kind: 'invalid', message: LINK_ERROR });
    expect(parseJoinPayload(makeToken({ exp: 5 }))).toEqual({ kind: 'invalid', message: EXPIRED_ERROR });
  });
});

describe('invitation link received', () => {
  const open = () => {
    const { harness, redeem } = mount();
    harness.render(<NavPanel pluginId="design-docs" subPath="" />);
    return { harness, redeem };
  };

  it('opens Settings → Peers with the field prefilled and a confirmation, and never joins by itself', async () => {
    localStorage.setItem('zcc.design-docs.settings-tab', JSON.stringify('agent'));
    const { harness, redeem } = open();
    await screen.findByRole('button', { name: 'Settings' });
    harness.emitDeepLink('join', TOKEN);
    const input = await screen.findByLabelText('Paste invitation') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(TOKEN));
    expect((await screen.findByRole('status')).textContent).toMatch(/Join Work Mac\?.*ABCD-1234/);
    expect(screen.getByRole('button', { name: 'Peers' }).getAttribute('aria-current')).toBe('page');
    // The remembered tab is untouched.
    expect(localStorage.getItem('zcc.design-docs.settings-tab')).toBe(JSON.stringify('agent'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redeem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Join peer' }));
    await waitFor(() => expect(redeem).toHaveBeenCalledExactlyOnceWith({ token: TOKEN }));
  });

  it('a link arriving while Settings is on another section switches to Peers', async () => {
    const { harness } = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }));
    harness.emitDeepLink('join', TOKEN);
    const input = await screen.findByLabelText('Paste invitation') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(TOKEN));
  });

  it.each([
    ['missing', null, LINK_ERROR],
    ['malformed', 'not-a-token', LINK_ERROR],
    ['expired', makeToken({ exp: 1 }), EXPIRED_ERROR]
  ])('a %s payload shows an inline error and leaves the field alone', async (_name, payload, message) => {
    const { harness, redeem } = open();
    await screen.findByRole('button', { name: 'Settings' });
    harness.emitDeepLink('join', payload);
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect((screen.getByLabelText('Paste invitation') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
    expect(redeem).not.toHaveBeenCalled();
  });

  it('returning to the documents clears the request so it is not applied again', async () => {
    const { harness } = open();
    await screen.findByRole('button', { name: 'Settings' });
    harness.emitDeepLink('join', TOKEN);
    await waitFor(() => expect((screen.getByLabelText('Paste invitation') as HTMLInputElement).value).toBe(TOKEN));
    fireEvent.click(screen.getByRole('button', { name: 'Back to design docs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect((await screen.findByLabelText('Paste invitation') as HTMLInputElement).value).toBe('');
  });
});
