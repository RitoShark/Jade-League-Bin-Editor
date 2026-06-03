/**
 * Tiny pointer-event drag-and-drop.
 *
 * HTML5 native DnD is broken inside Tauri 2's webview when
 * `dragDropEnabled: true` — the OS-level interceptor swallows
 * `dragover`/`drop` before they reach the DOM, leaving us with a
 * "forbidden" cursor on any internal drag (refs: tauri#14373,
 * tauri#9445, tauri#4168). The two systems are mutually exclusive
 * in the same window.
 *
 * We want both:
 *   - OS file drops (drag from Windows Explorer → into Jade) —
 *     keeps using `tauri://drag-drop` events, unchanged.
 *   - Internal drags (drag from Jade's File Explorer pane → into
 *     a viewport) — driven by pointer events here, bypassing
 *     HTML5 DnD entirely.
 *
 * Design:
 *   - `DragProvider` owns global state + the body-level
 *     pointermove/pointerup listeners that activate during a drag.
 *   - `useDraggable(payload)` returns props for a drag source.
 *     `onPointerDown` records the start pos + payload; after the
 *     pointer moves past a small threshold, drag becomes active.
 *   - `useDropZone({ ref, accepts, onDrop })` registers a zone
 *     while the component is mounted. Multiple zones can be
 *     registered; the topmost one under the pointer wins.
 *   - A floating ghost element follows the cursor while dragging,
 *     showing a small chip with the filename.
 *
 * The payload is a plain string (path) — keeps the API minimal.
 * Callers do their own extension filtering inside `onDrop`.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';

interface DropZone {
    id: number;
    el: HTMLElement;
    /** Filter — return true if this zone wants the payload. Allows
     *  a zone to opt out of certain payloads without unmounting. */
    accepts?: (payload: string) => boolean;
    onDrop: (payload: string, ev: { clientX: number; clientY: number }) => void;
    onEnter?: () => void;
    onLeave?: () => void;
}

interface DragState {
    payload: string;
    ghostLabel: string;
    startX: number;
    startY: number;
    /** True once pointer has crossed the activation threshold; until
     *  then we're a "pending" drag that hasn't actually started. */
    active: boolean;
    /** Current pointer position — used to position the ghost. */
    x: number;
    y: number;
    /** Currently-hovered zone id, or null. */
    targetId: number | null;
}

interface DragContextValue {
    /** Begin tracking a potential drag — call from pointerdown.
     *  The drag becomes active once the pointer moves past the
     *  threshold (defaults to 4px). */
    beginDrag: (payload: string, ghostLabel: string, x: number, y: number) => void;
    registerZone: (zone: Omit<DropZone, 'id'>) => () => void;
}

const DragCtx = createContext<DragContextValue | null>(null);

const DRAG_THRESHOLD = 4;

export function DragProvider({ children }: { children: ReactNode }) {
    // Zones live in a ref Map. Storing in state would re-render
    // every consumer on every register/unregister. We bump a
    // version counter only when we genuinely need a re-render
    // (drag state changes).
    const zonesRef = useRef<Map<number, DropZone>>(new Map());
    const nextZoneIdRef = useRef(1);
    const [drag, setDrag] = useState<DragState | null>(null);
    const dragRef = useRef<DragState | null>(null);
    dragRef.current = drag;

    const registerZone = useCallback<DragContextValue['registerZone']>((zone) => {
        const id = nextZoneIdRef.current++;
        zonesRef.current.set(id, { ...zone, id });
        return () => {
            zonesRef.current.delete(id);
        };
    }, []);

    const beginDrag = useCallback<DragContextValue['beginDrag']>((payload, ghostLabel, x, y) => {
        setDrag({
            payload,
            ghostLabel,
            startX: x,
            startY: y,
            active: false,
            x,
            y,
            targetId: null,
        });
    }, []);

    // While dragging, listen at the document level so we catch
    // pointer events that escape the original target (e.g. when
    // the user drags fast and the pointer leaves the source row).
    useEffect(() => {
        if (!drag) return;

        const hitTest = (x: number, y: number): DropZone | null => {
            // elementsFromPoint walks the stacking order top-down.
            // We pick the first registered zone we find — closest
            // visually to the cursor wins, which is what users
            // expect.
            const els = document.elementsFromPoint(x, y);
            for (const el of els) {
                for (const zone of zonesRef.current.values()) {
                    if (zone.el === el || zone.el.contains(el)) {
                        if (zone.accepts && !zone.accepts(drag.payload)) continue;
                        return zone;
                    }
                }
            }
            return null;
        };

        const onMove = (ev: PointerEvent) => {
            const cur = dragRef.current;
            if (!cur) return;
            const dx = ev.clientX - cur.startX;
            const dy = ev.clientY - cur.startY;
            const moved = Math.hypot(dx, dy);
            const active = cur.active || moved >= DRAG_THRESHOLD;
            const hovered = active ? hitTest(ev.clientX, ev.clientY) : null;
            const targetId = hovered?.id ?? null;
            if (targetId !== cur.targetId) {
                if (cur.targetId !== null) zonesRef.current.get(cur.targetId)?.onLeave?.();
                if (targetId !== null) zonesRef.current.get(targetId)?.onEnter?.();
            }
            setDrag({ ...cur, active, x: ev.clientX, y: ev.clientY, targetId });
        };

        const onUp = (ev: PointerEvent) => {
            const cur = dragRef.current;
            if (!cur) return;
            // If the drag never activated (click without movement),
            // just clean up — don't fire onDrop. Caller's regular
            // onClick will still run via the original mousedown.
            if (cur.active && cur.targetId !== null) {
                const zone = zonesRef.current.get(cur.targetId);
                zone?.onLeave?.();
                zone?.onDrop(cur.payload, { clientX: ev.clientX, clientY: ev.clientY });
            } else if (cur.targetId !== null) {
                zonesRef.current.get(cur.targetId)?.onLeave?.();
            }
            setDrag(null);
        };

        // Escape cancels.
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key !== 'Escape') return;
            const cur = dragRef.current;
            if (cur?.targetId !== undefined && cur?.targetId !== null) {
                zonesRef.current.get(cur.targetId)?.onLeave?.();
            }
            setDrag(null);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            window.removeEventListener('keydown', onKey);
        };
    }, [drag !== null]); // re-bind only on drag start / end

    const value = useMemo<DragContextValue>(() => ({ beginDrag, registerZone }), [beginDrag, registerZone]);

    return (
        <DragCtx.Provider value={value}>
            {children}
            {drag?.active && (
                <div
                    style={{
                        position: 'fixed',
                        left: drag.x + 12,
                        top: drag.y + 8,
                        zIndex: 99999,
                        pointerEvents: 'none',
                        padding: '4px 10px',
                        background: 'var(--vscode-editorWidget-background, var(--editor-bg, #1e1e1e))',
                        border: '1px solid var(--jade-accent, #007acc)',
                        borderRadius: 'var(--border-radius, 4px)',
                        color: 'var(--text-color, #d4d4d4)',
                        fontSize: 11,
                        fontFamily: 'inherit',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.45)',
                        whiteSpace: 'nowrap',
                        maxWidth: 280,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                    aria-hidden
                >
                    {drag.ghostLabel}
                </div>
            )}
        </DragCtx.Provider>
    );
}

/**
 * Drag source hook. Returns `onPointerDown` to spread onto the
 * draggable element. The drag actually starts only after the
 * pointer moves past `DRAG_THRESHOLD` from the down position, so
 * a plain click doesn't initiate a drag — your existing onClick
 * handlers still fire normally.
 *
 * `ghostLabel` is what the floating chip shows during the drag.
 */
export function useDraggable(payload: string | null, ghostLabel: string) {
    const ctx = useContext(DragCtx);
    return useMemo(() => ({
        onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => {
            // Only respond to the primary (left) button. Right-click /
            // middle-click shouldn't start a drag.
            if (ev.button !== 0) return;
            if (!ctx || !payload) return;
            ctx.beginDrag(payload, ghostLabel, ev.clientX, ev.clientY);
        },
    }), [ctx, payload, ghostLabel]);
}

/**
 * Low-level escape hatch — returns the raw context for callers
 * that need to start drags inside event handlers without a hook
 * per row (e.g. a virtual list rendering hundreds of rows where
 * `useDraggable` per row would be wasteful).
 */
export function useDrag() {
    return useContext(DragCtx);
}

/**
 * Drop zone hook. Registers a zone (any DOM element) while the
 * component is mounted. The zone fires `onDrop` when the user
 * releases the pointer over it during an active drag.
 *
 * `accepts` optionally filters payloads — return false to opt out
 * (the drag won't highlight this zone for that payload).
 *
 * `onEnter` / `onLeave` are convenience hooks for hover styling.
 */
export function useDropZone(opts: {
    ref: React.RefObject<HTMLElement | null>;
    accepts?: (payload: string) => boolean;
    onDrop: (payload: string, ev: { clientX: number; clientY: number }) => void;
    onEnter?: () => void;
    onLeave?: () => void;
}) {
    const ctx = useContext(DragCtx);
    const { ref, accepts, onDrop, onEnter, onLeave } = opts;
    // Stash callbacks in a ref so the effect doesn't re-register
    // every render. Without this, hover-state toggles would
    // re-register the zone constantly.
    const cbRef = useRef({ accepts, onDrop, onEnter, onLeave });
    cbRef.current = { accepts, onDrop, onEnter, onLeave };

    useEffect(() => {
        if (!ctx || !ref.current) return;
        const el = ref.current;
        const off = ctx.registerZone({
            el,
            accepts: (p) => cbRef.current.accepts?.(p) ?? true,
            onDrop: (p, ev) => cbRef.current.onDrop(p, ev),
            onEnter: () => cbRef.current.onEnter?.(),
            onLeave: () => cbRef.current.onLeave?.(),
        });
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ctx, ref.current]);
}
