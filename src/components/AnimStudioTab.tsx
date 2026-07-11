/**
 * Animation Studio tab body.
 *
 * Hosts the two side-by-side Babylon viewports and the shared
 * scrubber strip at the bottom. Everything else (rig pickers,
 * retarget toggles, bone mapping, bone rig widget) lives in
 * dockable panels (see `AnimStudioOptionsPanel`,
 * `AnimStudioMappingPanel`, `AnimStudioRigPanel`) rendered by the
 * VS dock system — same pattern Photo Studio uses for its Pose /
 * Mesh / Background panels.
 *
 * Drag-and-drop: `.anm` → loads as source clip on whichever side
 * the cursor is over (clip is global; viewport hit-test only
 * decides which side highlights). `.skn / .gltf / .glb / .fbx` →
 * loads as the rig on the hit-tested side.
 */

import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
    Play as PlayIcon,
    Pause as PauseIcon,
    Repeat as LoopIcon,
    Film as FilmIcon,
    Link as LinkIcon,
    X as RemoveIcon,
} from 'lucide-react';
import { createAnimStudioScene, type AnimStudioScene, type AnimStudioSide } from '../lib/babylon/animStudioScene';
import { useShell } from '../shells/ShellContext';
import { useDropZone } from '../lib/dnd';
import './StudioPanels.css';

interface TauriDragPayload {
    paths?: string[];
    position?: { x: number; y: number };
}

interface AnimStudioTabProps {
    tabId: string;
}

const SKN_EXT_RE = /\.(skn|gltf|glb|fbx)$/i;
const ANM_EXT_RE = /\.anm$/i;

const fileNameOf = (p: string | null): string =>
    (p?.split(/[\\/]/).pop() ?? '');

/** Format a time in seconds as `M:SS.cc` for the scrubber readout. */
function fmtTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00.00';
    const total = Math.max(0, seconds);
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export default function AnimStudioTab({ tabId }: AnimStudioTabProps) {
    const s = useShell();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const targetCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<AnimStudioScene | null>(null);
    const [, setSceneTick] = useState(0);
    const [hover, setHover] = useState<AnimStudioSide | null>(null);

    // Build the scene once + attach both canvases. The scene is
    // built lazily inside the effect because creating Babylon
    // Engines before the canvases exist would throw.
    useEffect(() => {
        const sourceCanvas = sourceCanvasRef.current;
        const targetCanvas = targetCanvasRef.current;
        if (!sourceCanvas || !targetCanvas) return;

        const scene = createAnimStudioScene();
        sceneRef.current = scene;
        scene.attachCanvas('source', sourceCanvas);
        scene.attachCanvas('target', targetCanvas);
        s.registerAnimStudioScene(tabId, scene);
        const off = scene.onChange(() => {
            setSceneTick(n => n + 1);
            // Mirror the scene's dirty state onto the tab so the tab-bar
            // modified dot + save-before-close prompt work (same as Photo
            // Studio's StudioTab).
            s.notifyStudioDirty(tabId, scene.isDirty());
        });

        return () => {
            off();
            s.unregisterAnimStudioScene(tabId);
            sceneRef.current = null;
            scene.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId]);

    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y → scene undo / redo. Mirrors
    // Photo Studio's StudioTab. Gated on (a) this tab being the visible
    // one — inactive tabs are display:none so `offsetParent` is null —
    // and (b) focus NOT being in a text field, so the shortcut still
    // does normal text-edit undo inside the panel inputs.
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

    // Hit-test a viewport position to decide source vs target side.
    // Shared between the Tauri OS-drag listeners and the HTML5
    // internal-drag handlers below.
    const sideAt = (x: number, y: number): AnimStudioSide | null => {
        const sourceEl = sourceCanvasRef.current;
        const targetEl = targetCanvasRef.current;
        if (sourceEl) {
            const r = sourceEl.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return 'source';
        }
        if (targetEl) {
            const r = targetEl.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return 'target';
        }
        return null;
    };

    // Apply a dropped path to the correct side. Works for both Tauri
    // OS-level drops (from the system File Explorer) and HTML5
    // drops (from Jade's own File Explorer pane).
    const applyDroppedPath = (path: string, side: AnimStudioSide) => {
        const scene = sceneRef.current;
        if (!scene) return;
        if (ANM_EXT_RE.test(path)) {
            scene.loadSourceClip(path)
                .then((meta) => s.setStatusMessage(
                    `Anim Studio: clip ${fileNameOf(path)} — `
                    + `${meta.frameCount} frames @ ${Math.round(meta.fps)} fps `
                    + `(source ${meta.sourceMatched} bones, target ${meta.targetMatched} bones)`
                ))
                .catch((e) => s.setStatusMessage(`Anim Studio: clip load failed — ${e instanceof Error ? e.message : String(e)}`));
            return;
        }
        if (SKN_EXT_RE.test(path)) {
            scene.loadSkn(side, path)
                .then(() => s.setStatusMessage(`Anim Studio: loaded ${fileNameOf(path)} as ${side}`))
                .catch((e) => s.setStatusMessage(`Anim Studio: load failed — ${e instanceof Error ? e.message : String(e)}`));
            return;
        }
        s.setStatusMessage('Anim Studio: drop a .skn / .gltf / .glb / .fbx (rig) or .anm (clip)');
    };

    // Tauri drag-drop listeners: catch files dragged in from the OS
    // file explorer / desktop. HTML5 listeners on the viewport
    // canvases (further down) catch drags from Jade's own File
    // Explorer pane.
    useEffect(() => {
        let unlistenDrop: (() => void) | null = null;
        let unlistenDrag: (() => void) | null = null;
        let unlistenLeave: (() => void) | null = null;
        let cancelled = false;

        (async () => {
            const u1 = await listen<TauriDragPayload>('tauri://drag-drop', (event) => {
                if (cancelled) return;
                setHover(null);
                const pos = event.payload.position;
                if (!pos) return;
                const side = sideAt(pos.x, pos.y);
                if (!side) return;
                const paths = event.payload.paths ?? [];
                // Prefer .anm if present, otherwise pick the first
                // .skn-family file. Mirrors the precedence the HTML5
                // handler uses for single-file drops.
                const anmPath = paths.find((p) => ANM_EXT_RE.test(p));
                const sknPath = paths.find((p) => SKN_EXT_RE.test(p));
                const pick = anmPath ?? sknPath;
                if (!pick) {
                    s.setStatusMessage('Anim Studio: drop a .skn / .gltf / .glb / .fbx (rig) or .anm (clip)');
                    return;
                }
                applyDroppedPath(pick, side);
            });
            const u2 = await listen<TauriDragPayload>('tauri://drag', (event) => {
                if (cancelled) return;
                const pos = event.payload.position;
                setHover(pos ? sideAt(pos.x, pos.y) : null);
            });
            const u3 = await listen('tauri://drag-leave', () => {
                if (cancelled) return;
                setHover(null);
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

    // Internal drag-from-File-Explorer drop target. We use the
    // pointer-event drag system in `lib/dnd.tsx` instead of HTML5
    // native DnD because Tauri 2's OS-level drag interceptor
    // (needed for the `tauri://drag-drop` events above) breaks
    // HTML5 dragover/drop inside the webview (tauri#14373).
    //
    // `accepts` filters by extension. On drop, we hit-test the
    // pointer position against the two canvases to pick a side.
    const dropZoneRef = useRef<HTMLDivElement | null>(null);
    useDropZone({
        ref: dropZoneRef,
        accepts: (path) => ANM_EXT_RE.test(path) || SKN_EXT_RE.test(path),
        onDrop: (path, ev) => {
            const side = sideAt(ev.clientX, ev.clientY);
            if (!side) return;
            applyDroppedPath(path, side);
        },
    });

    // Clock readout — always read live from `scene.getTime()` on
    // every render so the scrubber thumb reflects the truth, no
    // stale-state snap-back when the user drags the slider.
    //
    // To get re-renders during playback (where the clock advances
    // without firing an emit per frame), we run a tiny "force a
    // re-render" rAF only while playing. Paused / no-clip states
    // get their updates from `scene.onChange` via sceneTick — the
    // parent already increments that on seek and play/pause edges.
    const scene = sceneRef.current;
    const isPlaying = scene?.isPlaying() ?? false;
    const [, forceRender] = useState(0);
    const clockTime = scene?.getTime() ?? 0;
    useEffect(() => {
        if (!scene || !isPlaying) return;
        let rafId = 0;
        let cancelled = false;
        const tick = () => {
            if (cancelled) return;
            // Bump a dummy counter to force a re-render; the inline
            // `clockTime = scene.getTime()` above reads fresh each
            // render so the slider value tracks playback.
            forceRender(n => (n + 1) | 0);
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
        };
    }, [scene, isPlaying]);

    // Keyboard: Space = play/pause, ←/→ = frame step. Gated on this
    // tab being visible + focus not in an input/select.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const sc = sceneRef.current;
            if (!sc || !sc.hasClip()) return;
            const container = containerRef.current;
            if (!container || container.offsetParent === null) return;
            const tgt = e.target as HTMLElement | null;
            if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
            if (e.key === ' ') {
                e.preventDefault();
                if (sc.isPlaying()) sc.pause(); else sc.play();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const meta = sc.getClipMetadata();
                if (meta.fps <= 0) return;
                const step = 1 / meta.fps;
                const next = sc.getTime() + (e.key === 'ArrowRight' ? step : -step);
                sc.seek(next);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const mode = scene?.getMode() ?? 'retarget';
    const sourceInfo = scene?.getSide('source') ?? { path: null, object: null };
    const targetInfo = scene?.getSide('target') ?? { path: null, object: null };
    const clipPath = scene?.getClipPath() ?? null;
    const clipMeta = scene?.getClipMetadata() ?? { duration: 0, fps: 30, frameCount: 0 };
    const speed = scene?.getSpeed() ?? 1;
    const loop = scene?.getLoop() ?? true;
    const cameraLink = scene?.getCameraLink() ?? true;
    const hasClip = clipMeta.duration > 0;

    const togglePlay = () => {
        if (!scene) return;
        if (scene.isPlaying()) scene.pause(); else scene.play();
    };
    const onSeek = (t: number) => scene?.seek(t);
    const onCycleSpeed = () => {
        if (!scene) return;
        const cycle = [1, 2, 0.5, 0.25];
        const i = cycle.findIndex(v => Math.abs(v - scene.getSpeed()) < 1e-3);
        const next = cycle[(i + 1) % cycle.length];
        scene.setSpeed(next);
    };
    const onToggleLoop = () => scene?.setLoop(!scene.getLoop());
    const onClearClip = () => scene?.clearClip();
    // A/B target offset — null when synced (default), seconds when
    // A/B mode is engaged. We treat any non-zero value as "A/B on"
    // so the toggle button + indicator follow.
    const targetOffset = scene?.getTargetOffset() ?? 0;
    const abMode = targetOffset !== 0;

    return (
        <div
            ref={containerRef}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--editor-bg, #1e1e1e)',
                color: 'var(--text-primary, #d4d4d4)',
            }}
        >
            {/* ── Mode switch — Retarget (dual rig) vs Physics (single) ─ */}
            <div className="anim-mode-bar">
                <div className="anim-mode-seg" role="tablist" aria-label="Editor mode">
                    <button
                        role="tab"
                        aria-selected={mode === 'retarget'}
                        className={`anim-mode-seg-btn${mode === 'retarget' ? ' is-on' : ''}`}
                        onClick={() => scene?.setMode('retarget')}
                        title="Retarget a clip from a source rig onto a target rig (physics optional on top)"
                    >Retarget</button>
                    <button
                        role="tab"
                        aria-selected={mode === 'physics'}
                        className={`anim-mode-seg-btn${mode === 'physics' ? ' is-on' : ''}`}
                        onClick={() => scene?.setMode('physics')}
                        title="Add physics to a single rig + clip — no retargeting"
                    >Physics</button>
                </div>
                <span className="anim-mode-hint">
                    {mode === 'retarget'
                        ? 'Retarget: source rig → target rig'
                        : 'Physics: bake cloth / hair / tail onto one rig'}
                </span>
            </div>

            {/* ── Viewport(s). Retarget = source + target side by side;
                    Physics = a single rig viewport. ────────────────── */}
            <div
                ref={dropZoneRef}
                style={{
                    flex: '1 1 auto',
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'row',
                }}
            >
                {/* Both panes stay mounted in every mode so their Babylon
                    canvas bindings survive a mode toggle — Physics mode
                    just hides the divider + target pane via CSS. */}
                <ViewportPane
                    canvasRef={sourceCanvasRef}
                    side="source"
                    path={sourceInfo.path}
                    isHover={hover === 'source'}
                    label={mode === 'physics' ? 'Rig' : 'Source'}
                    emptyHint={mode === 'physics' ? 'Drop a .skn here to load your rig' : 'Drop a .skn here as source'}
                />
                <div style={{
                    width: 1,
                    background: 'var(--border-color, #3e3e42)',
                    flex: '0 0 auto',
                    display: mode === 'physics' ? 'none' : undefined,
                }} />
                <ViewportPane
                    canvasRef={targetCanvasRef}
                    side="target"
                    path={targetInfo.path}
                    isHover={hover === 'target'}
                    hidden={mode === 'physics'}
                />
            </div>

            {/* ── Shared scrubber strip ─────────────────────────── */}
            <div className="anim-scrubber">
                <button
                    onClick={togglePlay}
                    disabled={!hasClip}
                    title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                    className="studio-icon-btn"
                >
                    {isPlaying ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
                </button>
                <input
                    type="range"
                    min={0}
                    max={hasClip ? clipMeta.duration : 1}
                    step={0.001}
                    value={hasClip ? clockTime : 0}
                    disabled={!hasClip}
                    onChange={(e) => onSeek(parseFloat(e.target.value))}
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                />
                <span className="anim-scrubber-time">
                    {fmtTime(clockTime)} / {fmtTime(clipMeta.duration)}
                </span>
                <button
                    onClick={onCycleSpeed}
                    disabled={!hasClip}
                    title="Playback speed"
                    className="studio-icon-btn"
                >
                    {speed === 1 ? '1x' : `${speed}x`}
                </button>
                <button
                    onClick={onToggleLoop}
                    disabled={!hasClip}
                    title={loop ? 'Loop on (click to disable)' : 'Loop off'}
                    className={`studio-icon-btn anim-scrubber-loop${loop ? '' : ' is-off'}`}
                >
                    <LoopIcon size={13} />
                </button>
                {mode === 'retarget' && (
                    <button
                        onClick={() => scene?.setCameraLink(!scene.getCameraLink())}
                        title={cameraLink
                            ? 'Camera link on — source/target viewports mirror each other (click to unlink)'
                            : 'Camera link off — click to mirror cameras'}
                        className={`studio-icon-btn anim-scrubber-loop${cameraLink ? '' : ' is-off'}`}
                    >
                        <LinkIcon size={13} />
                    </button>
                )}
                {/* A/B offset — retarget mode only (it compares the target
                    against the source). The button resets to sync
                    (offset = 0); the slider sets the target's lag/lead. */}
                {hasClip && mode === 'retarget' && (
                    <>
                        <button
                            onClick={() => scene?.setTargetOffset(0)}
                            disabled={!abMode}
                            title={abMode
                                ? `A/B offset: target +${(targetOffset * (clipMeta.fps || 30)).toFixed(0)} frames (click to sync)`
                                : 'Synchronised playback'}
                            className={`studio-icon-btn anim-scrubber-ab${abMode ? '' : ' is-sync'}`}
                        >
                            {abMode
                                ? `A/B ${targetOffset > 0 ? '+' : ''}${(targetOffset * (clipMeta.fps || 30)).toFixed(0)}f`
                                : 'A=B'}
                        </button>
                        <input
                            type="range"
                            min={-clipMeta.duration / 2}
                            max={clipMeta.duration / 2}
                            step={1 / (clipMeta.fps || 30)}
                            value={targetOffset}
                            onChange={(e) => scene?.setTargetOffset(parseFloat(e.target.value))}
                            title="Drag to offset the target's playback time vs the source"
                            style={{ width: 100, flex: '0 0 auto' }}
                        />
                    </>
                )}
                <span className="anim-scrubber-clip" title={clipPath ?? 'Drop a .anm to load a clip'}>
                    <FilmIcon size={12} />
                    {clipPath
                        ? fileNameOf(clipPath)
                        : <span className="anim-scrubber-clip-empty">no clip — drop a .anm</span>
                    }
                </span>
                {clipPath && (
                    <button
                        onClick={onClearClip}
                        title="Unload clip"
                        className="studio-icon-btn"
                    >
                        <RemoveIcon size={12} />
                    </button>
                )}
            </div>
        </div>
    );
}

function ViewportPane({ canvasRef, side, path, isHover, label, emptyHint, hidden }: {
    canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
    side: AnimStudioSide;
    path: string | null;
    isHover: boolean;
    label?: string;
    emptyHint?: string;
    hidden?: boolean;
}) {
    return (
        <div
            style={{
                position: 'relative',
                flex: hidden ? '0 0 0' : '1 1 0',
                minWidth: 0,
                minHeight: 0,
                display: hidden ? 'none' : undefined,
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
            <div style={sideBadgeStyle}>
                {label ?? (side === 'source' ? 'Source' : 'Target')}
            </div>
            {!path && (
                <div style={emptyHintStyle}>
                    {emptyHint ?? `Drop a .skn here as ${side}`}
                </div>
            )}
            {isHover && (
                <div style={dropOverlayStyle}>
                    <div style={dropBoxStyle}>Drop to load as {side}</div>
                </div>
            )}
        </div>
    );
}

const sideBadgeStyle: React.CSSProperties = {
    position: 'absolute',
    top: 8,
    left: 8,
    padding: '2px 8px',
    background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 75%, transparent)',
    color: 'var(--text-secondary, #9DA5B4)',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    border: '1px solid var(--border-color, #3e3e42)',
    borderRadius: 3,
    pointerEvents: 'none',
};

const emptyHintStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    padding: '8px 14px',
    color: 'var(--text-secondary, #9DA5B4)',
    fontSize: 12,
    pointerEvents: 'none',
    border: '1px dashed var(--border-color, #3e3e42)',
    borderRadius: 4,
    background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 60%, transparent)',
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
    padding: '10px 16px',
    background: 'var(--editor-bg, #1e1e1e)',
    color: 'var(--text-primary, #d4d4d4)',
    border: '1px solid var(--accent-color, #2196f3)',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
};
