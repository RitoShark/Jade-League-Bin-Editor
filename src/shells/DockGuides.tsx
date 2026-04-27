import type { DockSide } from './useToolLayout';

export type DropTarget = { kind: 'dock'; side: DockSide };

interface DockGuidesProps {
    /** Bounding box (in viewport coordinates) of the area that hosts the
     *  guides — usually the `.vs-shell-body`. The outer guides are drawn
     *  centered against each edge of this rect; the center cluster is in
     *  the middle. */
    container: { left: number; top: number; right: number; bottom: number } | null;
    /** Cursor position during the drag, or null when not over the area. */
    cursor: { x: number; y: number } | null;
    /** True while a drag is in flight; the overlay is invisible otherwise. */
    visible: boolean;
}

const GUIDE_SIZE = 36;
const GUIDE_HIT_PAD = 6;
const CENTER_GAP = 6;

interface Guide {
    side: DockSide;
    cx: number;
    cy: number;
    icon: 'left' | 'right' | 'bottom';
    role: 'outer' | 'center';
}

/**
 * Build the list of guide widgets the user can target during a drag.
 * Outer guides sit at the midpoint of each edge of the container; the
 * center cluster sits in the middle of the editor area for quick docks.
 */
function buildGuides(rect: { left: number; top: number; right: number; bottom: number }): Guide[] {
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const edgeOffset = 12;

    return [
        // Outer — anchored against each edge of the body.
        { side: 'left',   role: 'outer', cx: rect.left + edgeOffset + GUIDE_SIZE / 2,    cy, icon: 'left' },
        { side: 'right',  role: 'outer', cx: rect.right - edgeOffset - GUIDE_SIZE / 2,   cy, icon: 'right' },
        { side: 'bottom', role: 'outer', cx,                                              cy: rect.bottom - edgeOffset - GUIDE_SIZE / 2, icon: 'bottom' },

        // Center cluster — three squares around the middle, matching VS's
        // "dock to this side of the editor" widget. We share the same drop
        // result as their outer twins.
        { side: 'left',   role: 'center', cx: cx - GUIDE_SIZE - CENTER_GAP, cy, icon: 'left' },
        { side: 'right',  role: 'center', cx: cx + GUIDE_SIZE + CENTER_GAP, cy, icon: 'right' },
        { side: 'bottom', role: 'center', cx, cy: cy + GUIDE_SIZE + CENTER_GAP, icon: 'bottom' },
    ];
}

/**
 * Hit test a cursor position against the guide widgets and return the
 * matching drop target, or null when the cursor is over the editor area
 * (which means "let go to float").
 */
export function hitTestGuides(
    cursor: { x: number; y: number },
    rect: { left: number; top: number; right: number; bottom: number },
): DropTarget | null {
    const guides = buildGuides(rect);
    const half = GUIDE_SIZE / 2 + GUIDE_HIT_PAD;
    for (const g of guides) {
        if (Math.abs(cursor.x - g.cx) <= half && Math.abs(cursor.y - g.cy) <= half) {
            return { kind: 'dock', side: g.side };
        }
    }
    return null;
}

function previewRect(
    side: DockSide,
    rect: { left: number; top: number; right: number; bottom: number },
) {
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    const sideW = Math.min(360, Math.max(220, w * 0.28));
    const bottomH = Math.min(280, Math.max(140, h * 0.32));
    if (side === 'left')   return { left: rect.left,        top: rect.top,           width: sideW, height: h };
    if (side === 'right')  return { left: rect.right - sideW, top: rect.top,         width: sideW, height: h };
    /* bottom */            return { left: rect.left,        top: rect.bottom - bottomH, width: w,    height: bottomH };
}

export default function DockGuides({ container, cursor, visible }: DockGuidesProps) {
    if (!visible || !container) return null;
    const guides = buildGuides(container);
    const active = cursor ? hitTestGuides(cursor, container) : null;
    const preview = active ? previewRect(active.side, container) : null;

    return (
        <div className="vs-dock-guides" aria-hidden>
            {guides.map((g, i) => {
                const isActive = active?.side === g.side;
                return (
                    <div
                        key={i}
                        className={`vs-guide vs-guide-${g.icon} vs-guide-${g.role}${isActive ? ' active' : ''}`}
                        style={{
                            left: g.cx - GUIDE_SIZE / 2,
                            top: g.cy - GUIDE_SIZE / 2,
                            width: GUIDE_SIZE,
                            height: GUIDE_SIZE,
                        }}
                    >
                        <span className="vs-guide-arrow" />
                    </div>
                );
            })}
            {preview && (
                <div
                    className="vs-guide-preview"
                    style={preview}
                />
            )}
        </div>
    );
}
