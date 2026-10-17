import { clampCamera, FIT_CAMERA, type Camera } from './use-camera.js';
import { STATUS_LABELS, type StatusFilter } from './model.js';
import { isCityTheme, type CityTheme } from './themes.js';

export type CityViewState = { selected: string; inside: boolean; floor?: number; deskPage: number; inspecting: boolean; filter: StatusFilter; search: string; page: number; paused: boolean; camera: Camera; focusedKey?: string; theme: CityTheme };
const STORAGE_KEY = 'agent-city:view-state:v1', MAX_SCOPES = 12;
export const DEFAULT_VIEW: CityViewState = { selected: 'all', inside: false, deskPage: 0, inspecting: false, filter: 'all', search: '', page: 0, paused: false, camera: FIT_CAMERA, theme: 'classic' };
const shortString = (value: unknown): value is string => typeof value === 'string' && value.length <= 500;
const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function snapshots(): [string, CityViewState][] {
  const raw = sessionStorage.getItem(STORAGE_KEY) ?? '[]';
  const parsed: unknown = raw.length <= 65536 ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed.slice(-MAX_SCOPES).filter((row) => Array.isArray(row) && shortString(row[0]) && row[1] && typeof row[1] === 'object') : [];
}
/** Only bounded view preferences, never agents, prompts, or server data. Per-browser-tab scope. */
export function readViewState(scope: string): CityViewState {
  try {
    const saved = snapshots().find(([key]) => key === scope)?.[1];
    if (!saved || !shortString(saved.selected) || !shortString(saved.search) || !index(saved.deskPage) || !index(saved.page)
      || (saved.floor !== undefined && !index(saved.floor)) || (saved.focusedKey !== undefined && !shortString(saved.focusedKey))
      || !['inside', 'inspecting', 'paused'].every((key) => typeof saved[key as keyof CityViewState] === 'boolean')
      || !(saved.filter === 'all' || Object.hasOwn(STATUS_LABELS, saved.filter))
      || (saved.theme !== undefined && !isCityTheme(saved.theme))
      || !saved.camera || !['zoom', 'x', 'y'].every((key) => Number.isFinite(saved.camera[key as keyof Camera]))) return DEFAULT_VIEW;
    // Snapshots saved before themes existed keep their navigation and use the original city.
    return { ...saved, theme: saved.theme ?? 'classic', camera: clampCamera(saved.camera) };
  } catch { return DEFAULT_VIEW; }
}
export function saveViewState(scope: string, state: CityViewState) {
  if (!shortString(scope)) return;
  const bounded = { ...state, selected: state.selected.slice(0, 500), search: state.search.slice(0, 500), focusedKey: shortString(state.focusedKey) ? state.focusedKey : undefined };
  try {
    let previous: [string, CityViewState][];
    try { previous = snapshots(); } catch { previous = []; }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...previous.filter(([key]) => key !== scope), [scope, bounded]].slice(-MAX_SCOPES)));
  } catch { /* Storage may be disabled; navigation remains usable. */ }
}
