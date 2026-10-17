import { useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { EyeOff, GripVertical, SlidersHorizontal } from 'lucide-react';
import type { SidebarRailRow } from '../SidebarRail.js';
import { SortableNavItem, type useSortableSidebarNav } from '../sidebarSortable.js';

export interface SidebarNavigationPopupState {
  kind: 'context' | 'more' | 'customize';
  x: number;
  y: number;
  itemId?: string;
}

/** Portal keeps the menu clear of the rail's scrolling and clipping containers. */
export function SidebarNavigationPopup({
  popup, rows, hidden, pinnedIds, drag, returnFocus, onClose, onCustomize,
  onVisibleChange, onReset, renderHiddenItem
}: {
  popup: SidebarNavigationPopupState;
  rows: readonly SidebarRailRow[];
  hidden: ReadonlySet<string>;
  pinnedIds: readonly string[];
  drag: ReturnType<typeof useSortableSidebarNav>;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onCustomize(): void;
  onVisibleChange(id: string, visible: boolean): void;
  onReset(): void;
  renderHiddenItem(id: string): ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const customize = popup.kind === 'customize';
  const item = rows.find((row) => row.id === popup.itemId);
  useLayoutEffect(() => {
    const el = ref.current!;
    const position = () => {
      const rect = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(popup.x, window.innerWidth - rect.width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(popup.y, window.innerHeight - rect.height - 8))}px`;
    };
    position();
    el.querySelector<HTMLElement>('button:not(:disabled), a:not([aria-disabled="true"]), input:not(:disabled)')?.focus();
    // Plugin destinations can arrive after opening the menu and increase its
    // height. Keep the whole popup reachable as its contents or viewport change.
    const observer = new ResizeObserver(position);
    observer.observe(el);
    window.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
    };
  }, [popup.kind, popup.x, popup.y]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !returnFocus.current?.contains(event.target as Node)) onClose();
    };
    const dismissOnBlur = () => onClose();
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismissOnBlur);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', dismissOnBlur);
      returnFocus.current?.focus();
    };
  }, [onClose, returnFocus]);

  return createPortal(
    <div ref={ref} className="sidebar-navigation-popup" role={customize ? 'dialog' : 'menu'}
      aria-label={customize ? 'Customize navigation' : 'Sidebar navigation options'}
      style={{ left: popup.x, top: popup.y }}
      onKeyDownCapture={(event) => {
        // A mobile drawer owns Escape on its DOM container. Consume it before
        // that listener so closing a popup leaves navigation open.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (!customize && event.key === ' ' && event.target instanceof HTMLAnchorElement) {
          event.preventDefault();
          event.target.click();
        } else if (!customize && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const targets = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a:not([aria-disabled="true"])')];
          const current = targets.indexOf(document.activeElement as HTMLElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + targets.length) % targets.length;
          targets[next]?.focus();
        } else if (!customize && event.key === 'Tab') onClose();
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)
          && !returnFocus.current?.contains(event.relatedTarget as Node)) onClose();
      }}>
      {customize ? <>
        <div className="sidebar-customize-heading">
          <strong>Customize navigation</strong>
          <button type="button" className="btn small" onClick={onClose}>Done</button>
        </div>
        <DndContext sensors={drag.sensors} collisionDetection={drag.collisionDetection}
          onDragStart={drag.onDragStart} onDragCancel={drag.onDragCancel} onDragEnd={drag.onDragEnd}>
          <SortableContext items={drag.sortableNavIds} strategy={verticalListSortingStrategy}>
            <div role="list" aria-label="Sidebar destinations" className="sidebar-customize-list">
              {rows.map((row) => {
                const pinned = pinnedIds.includes(row.id);
                const content = <CustomizeRow row={row} pinned={pinned} checked={!hidden.has(row.id)}
                  onChange={(visible) => onVisibleChange(row.id, visible)} />;
                return pinned ? <div key={row.id}>{content}</div>
                  : <SortableNavItem key={row.id} id={row.id}>{content}</SortableNavItem>;
              })}
            </div>
          </SortableContext>
        </DndContext>
        <button type="button" className="sidebar-navigation-menu-action" onClick={onReset}>Restore defaults</button>
      </> : <>
        {popup.kind === 'context' && item && !hidden.has(item.id) && (
          <button type="button" role="menuitem" className="sidebar-navigation-menu-action" onClick={() => {
            onVisibleChange(item.id, false);
            onClose();
          }}><EyeOff size={16} aria-hidden="true" />Hide from sidebar</button>
        )}
        {popup.kind === 'more' && rows.filter((row) => hidden.has(row.id)).map((row) => (
          <div key={row.id} role="none" onClick={() => { if (!row.disabled) onClose(); }}>
            {renderHiddenItem(row.id)}
          </div>
        ))}
        <button type="button" role="menuitem" className="sidebar-navigation-menu-action" onClick={onCustomize}>
          <SlidersHorizontal size={16} aria-hidden="true" />Customize navigation
        </button>
      </>}
    </div>, returnFocus.current?.closest('[aria-modal="true"]') ?? document.body
  );
}

function CustomizeRow({ row, pinned, checked, onChange, ...dragHandle }: {
  row: SidebarRailRow;
  pinned: boolean;
  checked: boolean;
  onChange(visible: boolean): void;
} & Omit<HTMLAttributes<HTMLButtonElement>, 'onChange'>) {
  return <div role="listitem" className="sidebar-customize-row">
    {pinned ? <span className="sidebar-customize-pinned" /> : (
      <button {...dragHandle} type="button" className="sidebar-customize-grip" aria-label={`Reorder ${row.label}`}>
        <GripVertical size={14} aria-hidden="true" />
      </button>
    )}
    <label>
      <span className="nav-item-icon">{row.icon}</span>
      <span className="sidebar-customize-label">{row.label}</span>
      <input type="checkbox" checked={checked} aria-label={`Show ${row.label} in sidebar`}
        onChange={(event) => onChange(event.target.checked)} />
    </label>
  </div>;
}
