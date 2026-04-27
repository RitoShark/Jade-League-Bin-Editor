import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface VSDockPaneProps {
    /** Where the pane is anchored. Determines which edge has the resize
     *  handle and whether width or height is what the user controls. */
    side: 'right' | 'left' | 'bottom';
    /** Initial pixel size — width for left/right, height for bottom. */
    defaultSize: number;
    /** Minimum size before the pane stops shrinking. */
    minSize?: number;
    /** Maximum size — defaults to half the viewport on the relevant axis. */
    maxSize?: number;
    /** Persistence key for `localStorage`. If omitted, size resets every
     *  reload. Each named pane is remembered independently. */
    storageKey?: string;
    /** Tabs across the top of the pane (Visual Studio always shows tabs,
     *  even with a single window). Pass an empty array to hide them. */
    tabs?: { id: string; label: string }[];
    activeTabId?: string;
    onTabSelect?: (id: string) => void;
    /** Pointerdown on a tab — used by the parent to start a tool-window
     *  drag. The tab id is passed so the shell knows which tool moved. */
    onTabPointerDown?: (e: React.PointerEvent, id: string) => void;
    onClose?: () => void;
    /** Title shown in the tool window header when there are no tabs. */
    title?: string;
    /** Pointerdown on the header (used to initiate tool-window drag when
     *  there are no tabs — the whole header acts as a drag handle). */
    onHeaderPointerDown?: (e: React.PointerEvent) => void;
    children: ReactNode;
}

/**
 * A resizable, dockable tool window used by the Visual Studio shell.
 * Click-and-drag the inner edge to resize. Size persists per `storageKey`.
 *
 * Phase 3a: docks are stationary (right/left/bottom). Phase 3b will add
 * drag-to-rearrange and float behavior.
 */
export default function VSDockPane({
    side,
    defaultSize,
    minSize = 160,
    maxSize,
    storageKey,
    tabs,
    activeTabId,
    onTabSelect,
    onTabPointerDown,
    onClose,
    title,
    onHeaderPointerDown,
    children,
}: VSDockPaneProps) {
    const horizontal = side === 'left' || side === 'right';
    const computedMax = maxSize ?? (horizontal ? Math.floor(window.innerWidth / 2) : Math.floor(window.innerHeight / 2));

    const [size, setSize] = useState<number>(() => {
        if (typeof window !== 'undefined' && storageKey) {
            const raw = window.localStorage.getItem(storageKey);
            const n = raw ? parseInt(raw, 10) : NaN;
            if (Number.isFinite(n) && n >= minSize && n <= computedMax) return n;
        }
        return defaultSize;
    });

    const draggingRef = useRef(false);
    const startPosRef = useRef(0);
    const startSizeRef = useRef(0);

    // Persist size whenever it changes.
    useEffect(() => {
        if (storageKey) {
            try { window.localStorage.setItem(storageKey, String(size)); } catch { /* quota / private mode */ }
        }
    }, [size, storageKey]);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        draggingRef.current = true;
        startPosRef.current = horizontal ? e.clientX : e.clientY;
        startSizeRef.current = size;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
    }, [horizontal, size]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        const cur = horizontal ? e.clientX : e.clientY;
        let delta = cur - startPosRef.current;
        // For right/bottom panes, dragging away from the edge grows the
        // pane → invert the delta (the handle is on the inside edge).
        if (side === 'right' || side === 'bottom') delta = -delta;
        const next = Math.max(minSize, Math.min(computedMax, startSizeRef.current + delta));
        setSize(next);
    }, [horizontal, side, minSize, computedMax]);

    const stopDrag = useCallback((e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }, []);

    const style = horizontal ? { width: `${size}px` } : { height: `${size}px` };

    return (
        <div className={`vs-dock-pane vs-dock-${side}`} style={style}>
            {(side === 'right' || side === 'bottom') && (
                <div
                    className={`vs-dock-handle vs-dock-handle-${horizontal ? 'h' : 'v'}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                />
            )}

            <div
                className={`vs-dock-header${onHeaderPointerDown ? ' draggable' : ''}`}
                onPointerDown={onHeaderPointerDown}
            >
                {tabs && tabs.length > 0 ? (
                    <div className="vs-dock-tabs">
                        {tabs.map(t => (
                            <button
                                key={t.id}
                                type="button"
                                className={`vs-dock-tab${activeTabId === t.id ? ' active' : ''}`}
                                onClick={() => onTabSelect?.(t.id)}
                                onPointerDown={e => onTabPointerDown?.(e, t.id)}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                ) : (
                    <span className="vs-dock-title">{title}</span>
                )}
                {onClose && (
                    <button
                        type="button"
                        className="vs-dock-close"
                        onClick={onClose}
                        onPointerDown={e => e.stopPropagation()}
                        aria-label="Close tool window"
                    >
                        &times;
                    </button>
                )}
            </div>

            <div className="vs-dock-body">{children}</div>

            {(side === 'left') && (
                <div
                    className="vs-dock-handle vs-dock-handle-h vs-dock-handle-right"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                />
            )}
        </div>
    );
}
