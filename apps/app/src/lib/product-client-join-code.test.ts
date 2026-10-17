import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('./fetch-with-app-surface.js', () => ({ fetchWithAppSurface: fetchMock, apiJson: vi.fn() }));

import { requestPreferredJoinCode } from './product-client.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('requestPreferredJoinCode', () => {
  afterEach(() => fetchMock.mockReset());

  it('returns the issued code with its pairing URL', async () => {
    fetchMock.mockResolvedValue(json(201, { joinCode: 'c', hostId: 'h', expiresAt: 1, pairingServerUrl: 'https://machine.example' }));
    await expect(requestPreferredJoinCode()).resolves.toEqual({
      ok: true,
      join: { joinCode: 'c', hostId: 'h', expiresAt: 1, pairingServerUrl: 'https://machine.example' }
    });
  });

  it('surfaces a 409 pairing refusal as a typed result', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: 'pairing_unavailable' }));
    await expect(requestPreferredJoinCode()).resolves.toEqual({ ok: false, error: 'pairing_unavailable' });
  });

  it('throws for unknown 409 bodies and other failures', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: 'relay_unavailable' }));
    await expect(requestPreferredJoinCode()).rejects.toMatchObject({ status: 409, code: 'relay_unavailable' });
    fetchMock.mockResolvedValueOnce(json(409, { error: 'other' }));
    await expect(requestPreferredJoinCode()).rejects.toMatchObject({ status: 409, code: 'other' });
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 409 }));
    await expect(requestPreferredJoinCode()).rejects.toMatchObject({ status: 409 });
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(requestPreferredJoinCode()).rejects.toMatchObject({ status: 500, message: '500' });
    fetchMock.mockResolvedValueOnce(json(400, { message: 'bad' }));
    await expect(requestPreferredJoinCode()).rejects.toMatchObject({ message: 'bad' });
  });
});
