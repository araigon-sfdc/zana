// @vitest-environment jsdom
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
const renderer = vi.hoisted(() => ({ draw: vi.fn(), refreshPalette: vi.fn(), dispose: vi.fn(), hit: vi.fn(() => 'p0') }));
vi.mock('./scene.js', () => ({ createCityRenderer: vi.fn(() => renderer) }));
import { useCityCanvas } from './use-city.js';
import { createCityRenderer } from './scene.js';
import type { InteriorModel } from './interior.js';
import type { CityTheme } from './themes.js';
let motionChange: () => void, intersect: (entries: { isIntersecting: boolean }[]) => void, resize: () => void, mutate: () => void;
let frame: FrameRequestCallback;
const disconnect = vi.fn();
const media = { matches: false, addEventListener: vi.fn((_key: string, cb: () => void) => { motionChange = cb; }), removeEventListener: vi.fn() };
function setup() {
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { frame = cb; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('IntersectionObserver', class { constructor(cb: typeof intersect) { intersect = cb; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('MutationObserver', class { constructor(cb: () => void) { mutate = cb; } observe() {} disconnect = disconnect; });
}
function Harness({ paused = false, onSelect = vi.fn(), interior, onHover, theme }: { onHover?: (key?: string) => void; paused?: boolean; onSelect?: (key: string) => void; interior?: InteriorModel; theme?: CityTheme }) {
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const state = useCityCanvas(root, canvas, [], 'p0', paused, onSelect, interior, onHover, theme);
  return <section ref={root}><canvas ref={canvas} data-testid="canvas"/><span>{state.reduced ? 'reduced' : 'motion'}</span><span>{state.available ? 'available' : 'unavailable'}</span></section>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); media.matches = false; });
it('pauses offscreen and hidden animation, respects reduced motion, responds to updates and cleans everything on unmount', () => {
  setup(); const select = vi.fn(); const { rerender, unmount } = render(<Harness onSelect={select}/>);
  act(() => { frame(100); frame(120); frame(170); });
  expect(renderer.draw).toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('canvas')); expect(select).toHaveBeenCalledWith('p0');
  act(() => intersect([{ isIntersecting: false }])); renderer.draw.mockClear();
  act(() => frame(200)); expect(renderer.draw).not.toHaveBeenCalled();
  act(() => intersect([{ isIntersecting: true }]));
  act(() => { media.matches = true; motionChange(); }); expect(screen.getByText('reduced')).toBeTruthy();
  act(() => { media.matches = false; motionChange(); resize(); mutate(); }); expect(renderer.refreshPalette).toHaveBeenCalled();
  rerender(<Harness paused onSelect={select}/>); renderer.draw.mockClear(); act(() => frame(250)); expect(renderer.draw).not.toHaveBeenCalled();
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); act(() => document.dispatchEvent(new Event('visibilitychange')));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false }); act(() => document.dispatchEvent(new Event('visibilitychange')));
  unmount(); expect(disconnect).toHaveBeenCalledTimes(3); expect(media.removeEventListener).toHaveBeenCalled(); expect(cancelAnimationFrame).toHaveBeenCalled();
  renderer.draw.mockClear(); act(() => { frame(300); resize(); }); expect(renderer.draw).not.toHaveBeenCalled();
});
it('shows reduced motion from the running loop when the media change event is deferred', () => {
  setup(); render(<Harness/>);
  act(() => frame(100)); expect(screen.getByText('motion')).toBeTruthy();
  vi.mocked(requestAnimationFrame).mockClear();
  act(() => { media.matches = true; frame(200); });
  expect(screen.getByText('reduced')).toBeTruthy(); expect(requestAnimationFrame).not.toHaveBeenCalled();
});
it('reports unavailable canvas without creating observers or animation', () => {
  setup(); vi.mocked(createCityRenderer).mockReturnValueOnce(null); render(<Harness/>);
  expect(screen.getByText('unavailable')).toBeTruthy(); expect(requestAnimationFrame).not.toHaveBeenCalled();
});
it('maps clicks through the zoomed canvas bounds and publishes viewport resizing', () => {
  setup(); const select = vi.fn(), hover = vi.fn(); render(<Harness onSelect={select} onHover={hover}/>);
  const canvas = screen.getByTestId('canvas');
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 500 });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 300 });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 1000, height: 600 } as DOMRect);
  act(() => resize());
  fireEvent.click(canvas, { clientX: 600, clientY: 350 });
  expect(renderer.hit).toHaveBeenLastCalledWith(250, 150);
  expect(select).toHaveBeenCalledWith('p0');
  fireEvent.pointerMove(canvas, { clientX: 600, clientY: 350 }); expect(hover).toHaveBeenLastCalledWith('p0');
  fireEvent.pointerLeave(canvas); expect(hover).toHaveBeenLastCalledWith(undefined);
  renderer.hit.mockReturnValueOnce(undefined as never);
  select.mockClear(); fireEvent.click(canvas); expect(select).not.toHaveBeenCalled();
});
it('redraws floor changes through the existing loop, including while paused, and releases the loop on exit', () => {
  setup(); const interior = { building: { id: 'p0' }, floor: { id: 1 } } as InteriorModel;
  const { rerender, unmount } = render(<Harness interior={interior} paused/>);
  expect(renderer.draw).toHaveBeenLastCalledWith([], 'p0', 0, false, interior, 'classic');
  const next = { ...interior, floor: { ...interior.floor, id: 2 } };
  rerender(<Harness interior={next} paused/>); expect(renderer.draw).toHaveBeenLastCalledWith([], 'p0', 0, false, next, 'classic');
  expect(media.addEventListener).toHaveBeenCalledTimes(1);
  rerender(<Harness paused/>); expect(renderer.draw).toHaveBeenLastCalledWith([], 'p0', 0, false, undefined, 'classic');
  unmount(); expect(disconnect).toHaveBeenCalledTimes(3);
});

it('allows hover-free views and handles a zero-sized canvas without invalid coordinates', () => {
  setup(); const { rerender } = render(<Harness/>); const canvas = screen.getByTestId('canvas');
  fireEvent.pointerMove(canvas); fireEvent.pointerLeave(canvas);
  const hover = vi.fn(); rerender(<Harness onHover={hover}/>);
  fireEvent.pointerMove(canvas, { clientX: 0, clientY: 0 });
  expect(renderer.hit).toHaveBeenLastCalledWith(0, 0);
  expect(hover).toHaveBeenCalledWith('p0');
});
it('redraws a theme switch immediately, even while paused, through the same loop', () => {
  setup(); const { rerender, unmount } = render(<Harness paused/>);
  rerender(<Harness paused theme="zh"/>); expect(renderer.draw).toHaveBeenLastCalledWith([], 'p0', 0, false, undefined, 'zh');
  rerender(<Harness paused theme="sf"/>); expect(renderer.draw).toHaveBeenLastCalledWith([], 'p0', 0, false, undefined, 'sf');
  expect(createCityRenderer).toHaveBeenCalledTimes(1); expect(requestAnimationFrame).not.toHaveBeenCalled();
  unmount(); expect(disconnect).toHaveBeenCalledTimes(3);
});
