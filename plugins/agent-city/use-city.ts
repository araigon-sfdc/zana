import { useEffect, useRef, useState, type RefObject } from 'react';
import { createCityRenderer } from './scene.js';
import type { CityBuilding } from './model.js';
import type { InteriorModel } from './interior.js';
import type { CityTheme } from './themes.js';
/** One animation loop per mounted view. No work while hidden, offscreen or paused. */
export function useCityCanvas(root: RefObject<HTMLElement | null>, canvas: RefObject<HTMLCanvasElement | null>, buildings: CityBuilding[], selected: string, paused: boolean, onSelect: (key: string) => void, interior?: InteriorModel, onHover?: (key?: string) => void, theme: CityTheme = 'classic') {
  const latest = useRef({ buildings, selected, paused, onSelect, interior, onHover, theme });
  latest.current = { buildings, selected, paused, onSelect, interior, onHover, theme };
  const redraw = useRef<() => void>(() => { });
  const [viewport, setViewport] = useState({ width: 1120, height: 775 });
  const [available, setAvailable] = useState(true);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const el = canvas.current, host = root.current;
    if (!el || !host)
      return;
    const renderer = createCityRenderer(el, host);
    if (!renderer) {
      setAvailable(false);
      return;
    }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true, frame = 0, last = 0, elapsed = 0, disposed = false;
    const moving = () => !latest.current.paused && !media.matches && visible && !document.hidden;
    const draw = () => renderer.draw(latest.current.buildings, latest.current.selected, elapsed, moving(), latest.current.interior, latest.current.theme);
    const tick = (now: number) => {
      frame = 0;
      if (disposed || !moving())
        return;
      // Cap city drawing at 20fps, regardless of a 60/120Hz display.
      if (now - last >= 50) {
        elapsed += last ? Math.min(.1, (now - last) / 1000) : 0;
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const refresh = () => {
      if (disposed)
        return;
      // Re-sync after a hidden window returns; browsers may defer media events.
      setReduced(media.matches);
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (visible && !document.hidden)
        draw();
      if (moving())
        frame = requestAnimationFrame(tick);
    };
    const theme = () => { renderer.refreshPalette(); refresh(); };
    const motion = () => { setReduced(media.matches); refresh(); };
    const click = (event: MouseEvent) => {
      const bounds = el.getBoundingClientRect();
      const key = renderer.hit((event.clientX - bounds.left) * (el.clientWidth / (bounds.width || 1)), (event.clientY - bounds.top) * (el.clientHeight / (bounds.height || 1)));
      if (key)
        latest.current.onSelect(key);
    };
    const hover = (event: PointerEvent) => {
      const bounds = el.getBoundingClientRect();
      latest.current.onHover?.(renderer.hit((event.clientX - bounds.left) * el.clientWidth / (bounds.width || 1), (event.clientY - bounds.top) * el.clientHeight / (bounds.height || 1)));
    };
    const unhover = () => latest.current.onHover?.(undefined);
    const resize = new ResizeObserver(() => {
      if (disposed) return;
      const width = el.clientWidth || 1120, height = el.clientHeight || 775;
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
      refresh();
    });
    resize.observe(el);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; refresh(); });
    intersection.observe(el);
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    document.addEventListener('visibilitychange', refresh);
    media.addEventListener('change', motion);
    el.addEventListener('click', click);
    el.addEventListener('pointermove', hover);
    el.addEventListener('pointerleave', unhover);
    redraw.current = refresh;
    motion();
    return () => {
      disposed = true;
      renderer.dispose();
      cancelAnimationFrame(frame);
      redraw.current = () => { };
      resize.disconnect();
      intersection.disconnect();
      observer.disconnect();
      document.removeEventListener('visibilitychange', refresh);
      media.removeEventListener('change', motion);
      el.removeEventListener('click', click);
      el.removeEventListener('pointermove', hover);
      el.removeEventListener('pointerleave', unhover);
    };
  }, [canvas, root]);
  useEffect(() => { redraw.current(); }, [buildings, selected, paused, interior, theme]);
  return { available, reduced, viewport };
}
