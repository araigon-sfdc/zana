// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCityRenderer } from './scene.js';
import { buildingInterior } from './interior.js';
import { cityBuildings, cityLayout, projectPoint, buildingHeight, projectCity, roofHeight } from './model.js';
afterEach(() => vi.restoreAllMocks());
describe('City renderer', () => {
  it('renders all building sizes, real citizens and traffic and resolves a building hit', () => {
    const fill = vi.fn();
    const context = new Proxy({ fill, createRadialGradient: () => ({ addColorStop: vi.fn() }) }, { get: (obj, key) => key in obj ? obj[key as keyof typeof obj] : vi.fn(), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ backgroundColor: 'rgb(100, 150, 180)' } as CSSStyleDeclaration);
    const canvas = document.createElement('canvas'), root = document.createElement('section'); root.appendChild(canvas);
    const renderer = createCityRenderer(canvas, root)!;
    const projects = [0,1,2].map((i) => ({ id: `p${i}`, name: `Project ${i}` }));
    for (const n of [1, 3, 7, 18, 40]) {
      const members = projects.flatMap((p) => Array.from({ length: n }, (_, i) => ({ key: `${p.id}-${i}`, kind: 'agent' as const, title: String(i), projectId: p.id, status: (['working','idle','needs-you','done','error'] as const)[i%5], live: i%5<3, scheduled: false, detail: '' })));
      const buildings = cityBuildings(projectCity({ projects, members, schedules: [], executions: [], searchQuery: '' }), new Map());
      renderer.draw(buildings, 'p0', 0, true); renderer.draw(buildings, 'p1', 20, false);
    }
    expect(fill).toHaveBeenCalled();
    const buildings = cityBuildings(projectCity({ projects, members: projects.map((p) => ({ key: p.id, projectId: p.id, status: 'idle' as const, live: true, kind: 'agent' as const, title: p.id, detail: '', scheduled: false, harness: 'Codex' })), schedules: [], executions: [], searchQuery: '' }), new Map());
    renderer.draw(buildings, '', 0, false);
    const layout = cityLayout(buildings), p = buildings[0], [x, y] = projectPoint(p.u + p.w / 2, p.v + p.d / 2, buildingHeight(p.count) + 8);
    expect(renderer.hit(layout.x + x * layout.scale, layout.y + y * layout.scale)).toBe('p0'); expect(renderer.hit(-20, -20)).toBeUndefined();
    expect(root.childElementCount).toBe(1);
    Object.defineProperty(canvas, 'clientWidth', { value: 320 });
    renderer.draw([], '', 1, false); expect(canvas.width).toBe(320);
    renderer.refreshPalette();
    const many = Array.from({ length: 200 }, (_, i) => ({ ...buildings[i % 3], id: `many-${i}`, members: [{ key: `member-${i}`, status: 'working', live: true }] }));
    renderer.draw(many as never, '', 30, true);
  });
  it.each(['sf', 'zh'] as const)('draws the %s theme for every building tier and keeps hits on its taller landmarks', (theme) => {
    const fill = vi.fn(), getComputedStyle = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ backgroundColor: 'rgb(100, 150, 180)' } as CSSStyleDeclaration);
    const context = new Proxy({ fill, createRadialGradient: () => ({ addColorStop: vi.fn() }) }, { get: (obj, key) => key in obj ? obj[key as keyof typeof obj] : vi.fn(), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const canvas = document.createElement('canvas'), root = document.createElement('section'); root.appendChild(canvas);
    const renderer = createCityRenderer(canvas, root)!;
    const projects = [0, 1, 2, 3, 4].map((i) => ({ id: `p${i}`, name: `Project ${i}` }));
    const sizes = [1, 3, 7, 18, 40];
    const members = projects.flatMap((p, n) => Array.from({ length: sizes[n] }, (_, i) => ({ key: `${p.id}-${i}`, kind: 'agent' as const, title: String(i), projectId: p.id, status: (['working', 'idle', 'needs-you', 'done', 'error'] as const)[i % 5], live: i % 5 < 3 || i === 0, scheduled: false, detail: '' })));
    const buildings = cityBuildings(projectCity({ projects, members, schedules: [], executions: [], searchQuery: '' }), new Map());
    expect(new Set(buildings.map((b) => b.form))).toEqual(new Set(['house', 'office', 'tower']));
    const reads = getComputedStyle.mock.calls.length;
    renderer.draw(buildings, 'p0', 0, true, undefined, theme); renderer.draw(buildings, 'p1', 20, false, undefined, theme);
    // The palette is re-read once on the switch, not on every frame.
    expect(getComputedStyle.mock.calls.length - reads).toBe(35);
    expect(fill).toHaveBeenCalled();
    // Each tier is hittable just under its label anchor (a tall tower in front may hide a lot behind it; labels stay clickable).
    for (const p of buildings) {
      renderer.draw([p], '', 1, false, undefined, theme);
      const alone = cityLayout([p], 1120, 775, theme), [x, y] = projectPoint(p.u + p.w / 2, p.v + p.d / 2, roofHeight(p, theme) + 8);
      expect(renderer.hit(alone.x + x * alone.scale, alone.y + y * alone.scale)).toBe(p.id);
    }
    renderer.draw(buildings, 'p0', 2, false, undefined, theme);
    const layout = cityLayout(buildings, 1120, 775, theme);
    for (const [id, u, v] of [['station', 160, layout.frontage + 107], ['library', 415, layout.frontage + 110]]) {
      const [x, y] = projectPoint(u as number, v as number, 30);
      expect(renderer.hit(layout.x + x * layout.scale, layout.y + y * layout.scale)).toBe(id);
    }
    const back = getComputedStyle.mock.calls.length;
    renderer.draw(buildings, 'p0', 21, true, buildingInterior(buildings[0]), theme);
    renderer.draw(buildings, 'p0', 22, true, undefined, 'classic');
    expect(getComputedStyle.mock.calls.length - back).toBe(35);
  });
  it('degrades to the roster if 2D canvas is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(createCityRenderer(document.createElement('canvas'), document.createElement('section'))).toBeNull();
  });
});
