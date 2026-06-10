import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from './ShellContext';
import type { SplitEdge } from './editorLayout';

/**
 * VSCode-style tab drag-to-split / cross-group move.
 *
 * A tab bar starts a drag here once the pointer leaves its own strip
 * (within-strip movement stays a plain reorder, handled in TabBar). The
 * provider then hit-tests editor groups under the cursor:
 *   - over a group's tab strip, or the CENTRE of its content → MOVE the
 *     tab into that group,
 *   - over an EDGE of a group's content (left/right/top/bottom) → SPLIT
 *     that group on that side and drop the tab into the new group.
 * A floating ghost follows the cursor and a translucent overlay shows
 * the drop zone. Drop dispatches `onMoveTabToGroup` / `onDropTabSplit`.
 *
 * Groups tag themselves so we can find them by `elementsFromPoint`:
 *   - the tab strip: `.tab-bar[data-group-id="<id>"]`
 *   - the content area: `[data-group-content="<id>"]`
 */

type Zone = 'center' | SplitEdge;
interface DragTarget { groupId: string; zone: Zone; rect: DOMRect; }
interface DragState {
  tabId: string;
  label: string;
  fromGroupId: string;
  x: number;
  y: number;
  target: DragTarget | null;
}

interface TabDragCtx {
  beginTabDrag: (tabId: string, label: string, fromGroupId: string, x: number, y: number) => void;
}

const Ctx = createContext<TabDragCtx | null>(null);
export function useTabDrag() { return useContext(Ctx); }

// Fraction of a group's content that counts as an edge (split) zone.
const EDGE = 0.24;

function hitTest(x: number, y: number): DragTarget | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const e = el as HTMLElement;
    // Over a tab strip → move into that group.
    const strip = e.closest?.('.tab-bar[data-group-id]') as HTMLElement | null;
    if (strip) {
      const gid = strip.dataset.groupId!;
      const content = document.querySelector(`[data-group-content="${gid}"]`) as HTMLElement | null;
      return { groupId: gid, zone: 'center', rect: (content ?? strip).getBoundingClientRect() };
    }
    // Over a group's content → centre (move) or an edge (split).
    const content = e.closest?.('[data-group-content]') as HTMLElement | null;
    if (content) {
      const gid = content.dataset.groupContent!;
      const rect = content.getBoundingClientRect();
      const fx = (x - rect.left) / rect.width;
      const fy = (y - rect.top) / rect.height;
      const dl = fx, dr = 1 - fx, dt = fy, db = 1 - fy;
      const min = Math.min(dl, dr, dt, db);
      let zone: Zone = 'center';
      if (min < EDGE) {
        if (min === dl) zone = 'left';
        else if (min === dr) zone = 'right';
        else if (min === dt) zone = 'top';
        else zone = 'bottom';
      }
      return { groupId: gid, zone, rect };
    }
  }
  return null;
}

function zoneStyle(t: DragTarget): { left: number; top: number; width: number; height: number } {
  const r = t.rect;
  switch (t.zone) {
    case 'left': return { left: r.left, top: r.top, width: r.width / 2, height: r.height };
    case 'right': return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
    case 'top': return { left: r.left, top: r.top, width: r.width, height: r.height / 2 };
    case 'bottom': return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
    default: return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
}

export function TabDragProvider({ children }: { children: ReactNode }) {
  const s = useShell();
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const beginTabDrag = useCallback<TabDragCtx['beginTabDrag']>((tabId, label, fromGroupId, x, y) => {
    const init: DragState = { tabId, label, fromGroupId, x, y, target: hitTest(x, y) };
    dragRef.current = init;
    setDrag(init);

    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const next = { ...cur, x: ev.clientX, y: ev.clientY, target: hitTest(ev.clientX, ev.clientY) };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      const cur = dragRef.current;
      if (cur?.target) {
        const { groupId, zone } = cur.target;
        if (zone === 'center') {
          if (groupId !== cur.fromGroupId) s.onMoveTabToGroup(cur.tabId, groupId);
        } else {
          s.onDropTabSplit(cur.tabId, groupId, zone);
        }
      }
      dragRef.current = null;
      setDrag(null);
    };
    document.body.style.cursor = 'grabbing';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [s]);

  const hl = drag?.target ? zoneStyle(drag.target) : null;

  return (
    <Ctx.Provider value={{ beginTabDrag }}>
      {children}
      {drag && createPortal(
        <>
          {hl && (
            <div
              style={{
                position: 'fixed', left: hl.left, top: hl.top, width: hl.width, height: hl.height,
                background: 'color-mix(in srgb, var(--accent-color, #2196f3) 22%, transparent)',
                border: '2px solid var(--accent-color, #2196f3)',
                borderRadius: 2, pointerEvents: 'none', zIndex: 99998,
                transition: 'left .06s, top .06s, width .06s, height .06s',
              }}
            />
          )}
          <div
            style={{
              position: 'fixed', left: drag.x + 12, top: drag.y + 8, pointerEvents: 'none', zIndex: 99999,
              padding: '3px 10px', background: 'var(--tab-bg, #2d2d2d)',
              border: '1px solid var(--accent-color, #2196f3)', borderRadius: 4,
              fontSize: 11, color: 'var(--text-color, #d4d4d4)', whiteSpace: 'nowrap',
              maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
              boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
            }}
          >
            {drag.label}
          </div>
        </>,
        document.body,
      )}
    </Ctx.Provider>
  );
}
