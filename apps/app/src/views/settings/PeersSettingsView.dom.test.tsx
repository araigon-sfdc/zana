// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), removeUse: vi.fn(), removeLink: vi.fn() }));
vi.mock('../../lib/product-client.js', () => ({ peerLinks: api }));

import { PeersSettingsView } from './PeersSettingsView';

const link = (over: Record<string, unknown> = {}) => ({
  hostId: 'h1',
  peerInstanceId: 'p1',
  peerName: 'Studio laptop',
  state: 'linked',
  connected: true,
  uses: [
    { pluginId: 'a', label: 'Alpha plugin', scope: 'proj-1', since: 1_700_000_000_000 },
    { pluginId: 'b', label: 'Beta plugin', scope: 'proj-2', since: 1_700_000_000_000 }
  ],
  ...over
});

beforeEach(() => {
  api.list.mockReset().mockResolvedValue({ links: [link()] });
  api.removeUse.mockReset().mockResolvedValue({ ok: true, linkRemoved: false });
  api.removeLink.mockReset().mockResolvedValue({ ok: true, linkRemoved: true });
});
afterEach(cleanup);

describe('PeersSettingsView', () => {
  it('shows the empty state', async () => {
    api.list.mockResolvedValue({ links: [] });
    render(<PeersSettingsView />);
    expect(await screen.findByText(/No peer links yet/)).toBeTruthy();
  });

  it('tolerates a malformed list body', async () => {
    api.list.mockResolvedValue({});
    render(<PeersSettingsView />);
    expect(await screen.findByText(/No peer links yet/)).toBeTruthy();
  });

  it('lists links with state, connection, reason and uses', async () => {
    api.list.mockResolvedValue({ links: [link({ state: 'failed', reason: 'handshake refused', connected: false }), link({ hostId: 'h2', peerName: 'Bare', uses: [], state: 'unclaimed', connected: false })] });
    render(<PeersSettingsView />);
    expect(await screen.findByText('Studio laptop')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('handshake refused')).toBeTruthy();
    expect(screen.getByText('Alpha plugin')).toBeTruthy();
    expect(screen.getByText('Unclaimed')).toBeTruthy();
    expect(screen.getByText('No plugin uses this link.')).toBeTruthy();
    expect(screen.getAllByTestId('peer-link')).toHaveLength(2);
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('removes a single use with its scope and reloads', async () => {
    render(<PeersSettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Beta plugin use' }));
    await waitFor(() => expect(api.removeUse).toHaveBeenCalledWith('h1', 'b', 'proj-2'));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('requires confirmation before removing a link, and can back out', async () => {
    render(<PeersSettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep link' }));
    expect(api.removeLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(api.removeLink).toHaveBeenCalledWith('h1'));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('surfaces a list failure', async () => {
    api.list.mockRejectedValue(new Error('server down'));
    render(<PeersSettingsView />);
    expect((await screen.findByRole('alert')).textContent).toBe('server down');
  });

  it('surfaces a removal failure and a non-Error rejection', async () => {
    api.removeUse.mockRejectedValueOnce(new Error('denied'));
    render(<PeersSettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Alpha plugin use' }));
    expect((await screen.findByRole('alert')).textContent).toBe('denied');
    api.removeLink.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Request failed'));
  });
});
