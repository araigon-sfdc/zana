// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_VIEW, readViewState, saveViewState } from './view-state.js';
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
const key = 'agent-city:view-state:v1';
it('restores scoped navigation and clamps the camera without retaining another scope', () => {
  saveViewState('global', { ...DEFAULT_VIEW, selected: 'p', inside: true, floor: 2, deskPage: 3, focusedKey: 'thread:a', camera: { zoom: 8, x: 999, y: -999 } });
  expect(readViewState('global')).toMatchObject({ selected: 'p', inside: true, floor: 2, deskPage: 3, focusedKey: 'thread:a', camera: { zoom: 4, x: 150, y: -150 } });
  expect(readViewState('p')).toEqual(DEFAULT_VIEW);
  saveViewState('global', DEFAULT_VIEW); expect(JSON.parse(sessionStorage.getItem(key)!)).toHaveLength(1);
  for (let i = 0; i < 20; i++) saveViewState(`p${i}`, { ...DEFAULT_VIEW, selected: `p${i}` });
  expect(JSON.parse(sessionStorage.getItem(key)!)).toHaveLength(12);
  expect(readViewState('p0')).toEqual(DEFAULT_VIEW); expect(readViewState('p19').selected).toBe('p19');
  saveViewState('global', { ...DEFAULT_VIEW, search: 'x'.repeat(1000) }); expect(readViewState('global').search).toHaveLength(500);
  saveViewState('x'.repeat(501), DEFAULT_VIEW); expect(JSON.parse(sessionStorage.getItem(key)!)).toHaveLength(12);
});
it('rejects malformed state, tolerates unavailable storage and repairs corrupt JSON on the next save', () => {
  for (const value of ['not json', '{}', 'x'.repeat(65537), JSON.stringify([null, [], ['x', null]])]) {
    sessionStorage.setItem(key, value); expect(readViewState('global')).toEqual(DEFAULT_VIEW);
  }
  for (const bad of [{ selected: null }, { search: 'x'.repeat(501) }, { page: -1 }, { deskPage: .5 }, { floor: -1 }, { focusedKey: 4 }, { inside: 'true' }, { filter: 'invalid' }, { camera: null }, { camera: { zoom: '2', x: 0, y: 0 } }, { theme: 'tokyo' }, { theme: 3 }]) {
    sessionStorage.setItem(key, JSON.stringify([['global', { ...DEFAULT_VIEW, ...bad }]]));
    expect(readViewState('global')).toEqual(DEFAULT_VIEW);
  }
  sessionStorage.setItem(key, 'bad'); saveViewState('global', { ...DEFAULT_VIEW, filter: 'idle' }); expect(readViewState('global').filter).toBe('idle');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
  expect(readViewState('global')).toEqual(DEFAULT_VIEW);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
  expect(() => saveViewState('global', DEFAULT_VIEW)).not.toThrow();
});
it('restores the chosen city theme per scope and upgrades snapshots saved before themes', () => {
  saveViewState('global', { ...DEFAULT_VIEW, theme: 'zh' });
  saveViewState('p', { ...DEFAULT_VIEW, theme: 'sf' });
  expect(readViewState('global').theme).toBe('zh'); expect(readViewState('p').theme).toBe('sf');
  const { theme: _theme, ...legacy } = { ...DEFAULT_VIEW, selected: 'p1' };
  sessionStorage.setItem(key, JSON.stringify([['global', legacy]]));
  expect(readViewState('global')).toMatchObject({ selected: 'p1', theme: 'classic' });
});
