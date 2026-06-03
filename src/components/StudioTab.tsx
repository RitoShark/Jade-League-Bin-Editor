/**
 * Photo Studio tab body.
 *
 * Owns the Babylon canvas, the `StudioScene` lifecycle, and the
 * drag-and-drop affordance that triggers a disk model load. All panel
 * UI (anim picker, background switcher, photo capture) is rendered
 * elsewhere through the VS dock system; the panels read this tab's
 * scene out of `ShellContext`'s studio registry.
 *
 * Drag-and-drop: Tauri's file-drop is global to the window; we listen
 * via `getCurrentWebview().onDragDropEvent` and gate on whether the
 * pointer is over THIS tab's canvas. That keeps drops on other tabs
 * (or empty studio tabs in the background) from hijacking the load.
 */

import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { createStudioScene, type StudioScene } from '../lib/babylon/studioScene';
import { useShell } from '../shells/ShellContext';
import { useDropZone } from '../lib/dnd';

interface TauriDragPayload {
    paths?: string[];
    position?: { x: number; y: number };
}

interface StudioTabProps {
    tabId: string;
}

export default function StudioTab({ tabId }: StudioTabProps) {
    const s = useShell();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const sceneRef = useRef<StudioScene | null>(null);
    const [hover, setHover] = useState(false);
    const [hint, setHint] = useState('Drop a .skn / .scb / .sco / .gltf / .glb / .fbx file to add a model');
    const [loading, setLoading] = useState(false);
    const [hasObjects, setHasObjects] = useState(false);
    // Canvas size, kept in state so the framing overlay re-derives its
    // rectangle when the user resizes the dock / window.
    const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

    // Scene lifecycle. Builds the scene, registers it on the shell so
    // panels can reach it, and tears everything down on tab unmount.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const scene = createStudioScene(canvas);
        sceneRef.current = scene;
        s.registerStudioScene(tabId, scene);
        const off = scene.onChange(() => {
            setHasObjects(scene.getObjects().length > 0);
            // Mirror the scene's dirty state onto the tab so the
            // tab-bar modified dot + save-before-close prompt work.
            s.notifyStudioDirty(tabId, scene.isDirty());
        });
        return () => {
            off();
            s.unregisterStudioScene(tabId);
            sceneRef.current = null;
            scene.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId]);

    // Track the canvas's CSS size so the photo framing overlay knows
    // how big to draw its rectangle. ResizeObserver fires on dock
    // resize, window resize, panel show/hide — same trigger Babylon
    // uses for its engine.resize().
    useEffect(() => {
        const el = canvasRef.current;
        if (!el) return;
        const update = () => {
            const r = el.getBoundingClientRect();
            setCanvasSize({ w: r.width, h: r.height });
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y → studio scene undo / redo.
    // Gated on (a) this tab being the visible one — inactive studio
    // tabs are `display:none` so `offsetParent` is null — and (b)
    // focus NOT being in a text field, so the shortcut still does
    // normal text-edit undo inside the panel inputs.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const key = e.key.toLowerCase();
            if (key !== 'z' && key !== 'y') return;
            const container = containerRef.current;
            if (!container || container.offsetParent === null) return;
            const tgt = e.target as HTMLElement | null;
            if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
            const scene = sceneRef.current;
            if (!scene) return;
            const redo = key === 'y' || (key === 'z' && e.shiftKey);
            e.preventDefault();
            if (redo) void scene.redo();
            else void scene.undo();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Tauri drag-drop listeners. The global App.tsx listener also
    // fires for any drop; non-.skn/scb/sco drops it rejects silently
    // and ours never sees them anyway because of the hit-test below.
    // We hit-test against THIS container's bounding rect so dropping
    // on a different studio tab (or a non-studio surface) doesn't
    // trigger a load here.
    useEffect(() => {
        let unlistenDrop: (() => void) | null = null;
        let unlistenDrag: (() => void) | null = null;
        let unlistenLeave: (() => void) | null = null;
        let cancelled = false;
        const isInsideContainer = (pos?: { x: number; y: number }) => {
            const container = containerRef.current;
            if (!container || !pos) return false;
            const rect = container.getBoundingClientRect();
            return pos.x >= rect.left && pos.x <= rect.right
                && pos.y >= rect.top  && pos.y <= rect.bottom;
        };
        (async () => {
            const u1 = await listen<TauriDragPayload>('tauri://drag-drop', (event) => {
                if (cancelled) return;
                setHover(false);
                if (!isInsideContainer(event.payload.position)) return;
                const path = event.payload.paths?.find((p) => /\.(skn|scb|sco|gltf|glb|fbx)$/i.test(p));
                if (!path) {
                    setHint('Unsupported file — drop a .skn / .scb / .sco / .gltf / .glb / .fbx');
                    return;
                }
                void loadPath(path);
            });
            const u2 = await listen<TauriDragPayload>('tauri://drag', (event) => {
                if (cancelled) return;
                setHover(isInsideContainer(event.payload.position));
            });
            const u3 = await listen('tauri://drag-leave', () => {
                if (cancelled) return;
                setHover(false);
            });
            if (cancelled) { u1(); u2(); u3(); return; }
            unlistenDrop = u1;
            unlistenDrag = u2;
            unlistenLeave = u3;
        })();
        return () => {
            cancelled = true;
            unlistenDrop?.();
            unlistenDrag?.();
            unlistenLeave?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadPath = async (path: string) => {
        const scene = sceneRef.current;
        if (!scene) return;
        setLoading(true);
        setHint(`Loading ${path.split(/[\\/]/).pop() ?? path}…`);
        try {
            // Additive — the studio is multi-object so each drop adds
            // alongside whatever's already in the scene. Use the
            // Objects panel to delete things that don't belong.
            await scene.addModelFromDisk(path);
            setHint('');
            s.setStatusMessage(`Studio: added ${path.split(/[\\/]/).pop() ?? path}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setHint(`Load failed: ${msg}`);
        } finally {
            setLoading(false);
        }
    };

    // Internal drag-from-File-Explorer drop zone. Pointer-event
    // based — Tauri 2's OS-level drag interceptor breaks HTML5
    // DnD inside the webview when `dragDropEnabled` is on, which
    // we need for the `tauri://drag-drop` listener above to keep
    // working. See `lib/dnd.tsx` for the rationale.
    useDropZone({
        ref: containerRef,
        accepts: (path) => /\.(skn|scb|sco|gltf|glb|fbx)$/i.test(path),
        onEnter: () => setHover(true),
        onLeave: () => setHover(false),
        onDrop: (path) => {
            setHover(false);
            void loadPath(path);
        },
    });

    return (
        <div
            ref={containerRef}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                background: 'var(--editor-bg, #1e1e1e)',
            }}
        >
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    outline: 'none',
                }}
            />
            {hasObjects && <PhotoFrameOverlay
                canvasW={canvasSize.w}
                canvasH={canvasSize.h}
                photoW={s.studioPhotoWidth}
                photoH={s.studioPhotoHeight}
            />}
            {hover && (
                <div style={dropOverlayStyle}>
                    <div style={dropBoxStyle}>Drop model file to load</div>
                </div>
            )}
            {!hasObjects && !hover && (
                <div style={hintBadgeStyle}>{loading ? hint : hint || 'Drop a .skn here'}</div>
            )}
        </div>
    );
}

/**
 * Letterbox overlay showing the photo's aspect ratio centred on the
 * viewport, with the cropped area dimmed. The capture's vertical FOV
 * matches the canvas, so framing by aspect ratio gives an honest
 * preview of "what fits inside the photo" — narrower than the canvas
 * when the photo is taller-than-canvas, shorter when it's wider.
 */
function PhotoFrameOverlay({ canvasW, canvasH, photoW, photoH }: {
    canvasW: number; canvasH: number; photoW: number; photoH: number;
}) {
    if (canvasW <= 0 || canvasH <= 0 || photoW <= 0 || photoH <= 0) return null;
    const photoAspect = photoW / photoH;
    const canvasAspect = canvasW / canvasH;
    let frameW: number;
    let frameH: number;
    if (photoAspect > canvasAspect) {
        // Photo is wider — limit by canvas width, scale height down.
        frameW = canvasW;
        frameH = canvasW / photoAspect;
    } else {
        // Photo is taller — limit by canvas height, scale width down.
        frameH = canvasH;
        frameW = canvasH * photoAspect;
    }
    const left = (canvasW - frameW) / 2;
    const top = (canvasH - frameH) / 2;
    return (
        <div
            style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
            }}
        >
            {/* Four dim strips outside the framing rect. Using strips
                rather than a hollow `box-shadow` lets the strip opacity
                stay subtle on light themes without a huge blur. */}
            {top > 0 && <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: top, ...dimStyle }} />}
            {top > 0 && <div style={{ position: 'absolute', left: 0, top: top + frameH, width: '100%', height: canvasH - (top + frameH), ...dimStyle }} />}
            {left > 0 && <div style={{ position: 'absolute', top, left: 0, width: left, height: frameH, ...dimStyle }} />}
            {left > 0 && <div style={{ position: 'absolute', top, left: left + frameW, width: canvasW - (left + frameW), height: frameH, ...dimStyle }} />}
            {/* Corner ticks only — no full outline rectangle. The dim
                strips outside already mark the frame edge; adding a
                continuous border on top reads as a hard crop line and
                competes with the model. Ticks alone are enough to read
                "this is the frame" without sitting on the eye. */}
            {[
                { left, top },
                { left: left + frameW - TICK, top },
                { left, top: top + frameH - TICK },
                { left: left + frameW - TICK, top: top + frameH - TICK },
            ].map((p, i) => (
                <div
                    key={i}
                    style={{
                        position: 'absolute',
                        left: p.left,
                        top: p.top,
                        width: TICK,
                        height: TICK,
                        opacity: 0.55,
                        borderLeft:   i === 0 || i === 2 ? '1px solid var(--text-secondary, #9DA5B4)' : 'none',
                        borderRight:  i === 1 || i === 3 ? '1px solid var(--text-secondary, #9DA5B4)' : 'none',
                        borderTop:    i === 0 || i === 1 ? '1px solid var(--text-secondary, #9DA5B4)' : 'none',
                        borderBottom: i === 2 || i === 3 ? '1px solid var(--text-secondary, #9DA5B4)' : 'none',
                    }}
                />
            ))}
            {/* Aspect-ratio label — bottom-center inside the frame.
                No border / no background tint; just a faint chip so it
                doesn't shout. */}
            <div
                style={{
                    position: 'absolute',
                    left: left + frameW / 2,
                    top: top + frameH - 18,
                    transform: 'translateX(-50%)',
                    padding: '1px 6px',
                    color: 'var(--text-secondary, #9DA5B4)',
                    fontSize: 9.5,
                    fontVariantNumeric: 'tabular-nums',
                    opacity: 0.55,
                    whiteSpace: 'nowrap',
                    letterSpacing: 0.3,
                }}
            >
                {photoW}×{photoH}
            </div>
        </div>
    );
}

const TICK = 10;
const dimStyle: React.CSSProperties = {
    // Soft outside dim — was 0.32, now ~half that so the model and
    // backdrop still read clearly through the cropped area.
    background: 'rgba(0, 0, 0, 0.18)',
};

const dropOverlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'color-mix(in srgb, var(--accent-color, #2196f3) 18%, transparent)',
    border: '2px dashed var(--accent-color, #2196f3)',
    pointerEvents: 'none',
};

const dropBoxStyle: React.CSSProperties = {
    padding: '12px 20px',
    background: 'var(--editor-bg, #1e1e1e)',
    color: 'var(--text-primary, #d4d4d4)',
    border: '1px solid var(--accent-color, #2196f3)',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
};

const hintBadgeStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 12,
    left: 12,
    padding: '6px 10px',
    background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 75%, transparent)',
    color: 'var(--text-secondary, #9DA5B4)',
    fontSize: 11,
    borderRadius: 4,
    pointerEvents: 'none',
    border: '1px solid var(--border-color, #3e3e42)',
    maxWidth: '60%',
};
