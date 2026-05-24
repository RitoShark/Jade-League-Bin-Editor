/**
 * Photo Studio — background switcher panel.
 *
 * Three background modes: transparent, solid color, and an imported
 * image. Imported images are kept in a small persistent library
 * (capped at 5, stored under `%APPDATA%/FrogTools/jade-studio/
 * backgrounds/`) so they survive across projects and restarts. The
 * library renders as image cards; clicking a card sets it as the
 * scene background, and users add images by dropping files onto the
 * panel or via the Import button.
 *
 * The panel reads the active studio's scene handle from shell context
 * and mutates it directly — no global state, the scene IS the state.
 */

import { useEffect, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { useShell } from '../shells/ShellContext';
import type { BackgroundFit } from '../lib/babylon/studioScene';
import PortalDropdown from './PortalDropdown';
import './StudioPanels.css';

interface StudioBackgroundPanelProps {
    studioTabId: string;
}

interface BackgroundEntry {
    path: string;
    name: string;
    modified_ms: number;
}

type BgMode = 'transparent' | 'solid' | 'image';

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

export default function StudioBackgroundPanel({ studioTabId }: StudioBackgroundPanelProps) {
    const s = useShell();
    const [mode, setMode] = useState<BgMode>('transparent');
    const [color, setColor] = useState('#1e1e1e');
    const [gridVisible, setGridVisible] = useState(true);
    const [library, setLibrary] = useState<BackgroundEntry[]>([]);
    const [activeImagePath, setActiveImagePath] = useState<string | null>(null);
    const [hoverDrop, setHoverDrop] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Image-background transform state — only meaningful while an
    // image is the active background. Defaults to `cover` (fill the
    // frame, crop overflow) centered at zoom 1.
    const [fit, setFit] = useState<BackgroundFit>('cover');
    const [offsetX, setOffsetX] = useState(0);
    const [offsetY, setOffsetY] = useState(0);
    const [zoom, setZoom] = useState(1);

    // Load the persistent library on mount.
    useEffect(() => {
        let cancelled = false;
        invoke<BackgroundEntry[]>('studio_list_backgrounds')
            .then((list) => { if (!cancelled) setLibrary(list); })
            .catch((e) => { if (!cancelled) setError(String(e)); });
        return () => { cancelled = true; };
    }, []);

    // Drag-drop import. The global App.tsx listener also fires for
    // any drop; non-image drops it ignores and ours hit-tests the
    // panel's own bounding rect so dropping elsewhere doesn't import.
    useEffect(() => {
        let unlistenDrop: (() => void) | null = null;
        let unlistenOver: (() => void) | null = null;
        let unlistenLeave: (() => void) | null = null;
        let cancelled = false;
        const insidePanel = (pos?: { x: number; y: number }) => {
            if (!pos) return false;
            const el = document.getElementById(`studio-bg-drop-${studioTabId}`);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom;
        };
        (async () => {
            const u1 = await listen<{ paths?: string[]; position?: { x: number; y: number } }>(
                'tauri://drag-drop',
                (event) => {
                    if (cancelled) return;
                    setHoverDrop(false);
                    if (!insidePanel(event.payload.position)) return;
                    const img = event.payload.paths?.find((p) => IMAGE_RE.test(p));
                    if (img) void importImage(img);
                },
            );
            const u2 = await listen<{ position?: { x: number; y: number } }>(
                'tauri://drag',
                (event) => {
                    if (cancelled) return;
                    setHoverDrop(insidePanel(event.payload.position));
                },
            );
            const u3 = await listen('tauri://drag-leave', () => {
                if (!cancelled) setHoverDrop(false);
            });
            if (cancelled) { u1(); u2(); u3(); return; }
            unlistenDrop = u1;
            unlistenOver = u2;
            unlistenLeave = u3;
        })();
        return () => {
            cancelled = true;
            unlistenDrop?.();
            unlistenOver?.();
            unlistenLeave?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [studioTabId]);

    const applySolidOrTransparent = (next: { mode?: BgMode; color?: string }) => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) return;
        const m = next.mode ?? mode;
        const c = next.color ?? color;
        if (m === 'transparent') scene.setBackground({ kind: 'transparent' });
        else if (m === 'solid') scene.setBackground({ kind: 'solid', color: c });
    };

    const onModeChange = (next: 'transparent' | 'solid') => {
        setMode(next);
        setActiveImagePath(null);
        applySolidOrTransparent({ mode: next });
    };

    const onColorChange = (next: string) => {
        setColor(next);
        if (mode === 'solid') applySolidOrTransparent({ color: next });
    };

    const onGridToggle = () => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) return;
        const next = !gridVisible;
        setGridVisible(next);
        scene.setGridVisible(next);
    };

    const selectImage = (entry: BackgroundEntry) => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) return;
        setMode('image');
        setActiveImagePath(entry.path);
        scene.setBackground({
            kind: 'image',
            config: { path: entry.path, fit, offsetX, offsetY, zoom },
        });
    };

    // Push a transform tweak to the active image background without
    // reloading the texture. Each setter also updates local state so
    // the controls stay in sync.
    const onFitChange = (next: BackgroundFit) => {
        setFit(next);
        const scene = s.getStudioScene(studioTabId);
        scene?.setBackgroundTransform({ fit: next });
        // Fit is a discrete dropdown pick — commit immediately.
        scene?.commitUndoStep();
    };
    const onOffsetXChange = (next: number) => {
        setOffsetX(next);
        s.getStudioScene(studioTabId)?.setBackgroundTransform({ offsetX: next });
    };
    const onOffsetYChange = (next: number) => {
        setOffsetY(next);
        s.getStudioScene(studioTabId)?.setBackgroundTransform({ offsetY: next });
    };
    const onZoomChange = (next: number) => {
        setZoom(next);
        s.getStudioScene(studioTabId)?.setBackgroundTransform({ zoom: next });
    };
    const resetTransform = () => {
        setFit('cover');
        setOffsetX(0);
        setOffsetY(0);
        setZoom(1);
        const scene = s.getStudioScene(studioTabId);
        scene?.setBackgroundTransform({ fit: 'cover', offsetX: 0, offsetY: 0, zoom: 1 });
        scene?.commitUndoStep();
    };

    // Sliders call `setBackgroundTransform` continuously while
    // dragging (no auto-commit on the scene side); we record ONE
    // undo step when the drag ends.
    const commitTransform = () => {
        s.getStudioScene(studioTabId)?.commitUndoStep();
    };

    const importImage = async (srcPath: string) => {
        setBusy(true);
        setError(null);
        try {
            const list = await invoke<BackgroundEntry[]>('studio_import_background', {
                srcPath,
            });
            setLibrary(list);
            // Auto-select the just-imported image (it's the newest entry).
            if (list[0]) selectImage(list[0]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const onImportClick = async () => {
        const picked = await openDialog({
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
        });
        if (!picked || Array.isArray(picked)) return;
        void importImage(picked);
    };

    const deleteImage = async (entry: BackgroundEntry) => {
        setBusy(true);
        setError(null);
        try {
            const list = await invoke<BackgroundEntry[]>('studio_delete_background', {
                path: entry.path,
            });
            setLibrary(list);
            // If the removed image was the active background, fall back
            // to transparent so the scene doesn't keep a dead layer.
            if (activeImagePath === entry.path) {
                setActiveImagePath(null);
                setMode('transparent');
                applySolidOrTransparent({ mode: 'transparent' });
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel">
            <div className="mop-content">
                <div className="studio-row">
                    <label className="studio-checkbox">
                        <input
                            type="radio"
                            name={`studio-bg-${studioTabId}`}
                            checked={mode === 'transparent'}
                            onChange={() => onModeChange('transparent')}
                        />
                        Transparent
                    </label>
                    <label className="studio-checkbox">
                        <input
                            type="radio"
                            name={`studio-bg-${studioTabId}`}
                            checked={mode === 'solid'}
                            onChange={() => onModeChange('solid')}
                        />
                        Solid
                    </label>
                    <input
                        type="color"
                        value={color}
                        onChange={(e) => onColorChange(e.target.value)}
                        disabled={mode !== 'solid'}
                        className="studio-color-swatch"
                        title="Background color"
                    />
                    <input
                        type="text"
                        value={color}
                        onChange={(e) => onColorChange(e.target.value)}
                        disabled={mode !== 'solid'}
                        className="mop-input"
                        style={{ flex: '0 0 110px' }}
                    />
                    <div className="studio-divider" />
                    <label className="studio-checkbox">
                        <input type="checkbox" checked={gridVisible} onChange={onGridToggle} />
                        Ground grid
                    </label>
                </div>

                <div
                    id={`studio-bg-drop-${studioTabId}`}
                    className={`studio-bg-library${hoverDrop ? ' drag-over' : ''}`}
                >
                    <div className="studio-bg-library-head">
                        <span className="studio-field-label">Image backgrounds</span>
                        <button
                            type="button"
                            className="mop-btn mop-btn-accept"
                            onClick={onImportClick}
                            disabled={busy}
                        >
                            {busy ? '…' : 'Import…'}
                        </button>
                    </div>

                    {library.length === 0 ? (
                        <div className="mop-field-hint" style={{ padding: '8px 0' }}>
                            Drop an image here or click Import. Up to 5 are
                            kept and shared across all studio scenes.
                        </div>
                    ) : (
                        <div className="studio-bg-grid">
                            {library.map((entry) => (
                                <div
                                    key={entry.path}
                                    className={`studio-bg-card${activeImagePath === entry.path ? ' active' : ''}`}
                                    onClick={() => selectImage(entry)}
                                    title={entry.name}
                                >
                                    <img
                                        src={convertFileSrc(entry.path)}
                                        alt={entry.name}
                                        className="studio-bg-card-img"
                                        draggable={false}
                                    />
                                    <span
                                        className="studio-bg-card-remove"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void deleteImage(entry);
                                        }}
                                        title="Remove from library"
                                    >✕</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {hoverDrop && <div className="studio-bg-drop-hint">Drop image to import</div>}
                </div>

                {mode === 'image' && activeImagePath && (
                    <div className="studio-bg-transform">
                        <div className="studio-bg-library-head">
                            <span className="studio-field-label">Image fit</span>
                            <button
                                type="button"
                                className="studio-objects-reset"
                                onClick={resetTransform}
                            >Reset</button>
                        </div>
                        <div className="studio-row">
                            <span className="studio-field-label">Fit</span>
                            <PortalDropdown
                                options={[
                                    { value: 'cover', label: 'Cover (fill, crop)' },
                                    { value: 'contain', label: 'Contain (whole image)' },
                                    { value: 'stretch', label: 'Stretch (distort to fill)' },
                                ]}
                                value={fit}
                                onChange={(v) => onFitChange(v as BackgroundFit)}
                                style={{ flex: 1 }}
                            />
                        </div>
                        <div className="studio-row">
                            <span className="studio-field-label">Zoom</span>
                            <input
                                type="range"
                                min={0.1}
                                max={4}
                                step={0.01}
                                value={zoom}
                                onChange={(e) => onZoomChange(Number(e.target.value))}
                                onPointerUp={commitTransform}
                                className="studio-scrub"
                            />
                            <span className="studio-time">{zoom.toFixed(2)}×</span>
                        </div>
                        <div className="studio-row">
                            <span className="studio-field-label">Pan X</span>
                            <input
                                type="range"
                                min={-1}
                                max={1}
                                step={0.01}
                                value={offsetX}
                                onChange={(e) => onOffsetXChange(Number(e.target.value))}
                                onPointerUp={commitTransform}
                                className="studio-scrub"
                            />
                            <span className="studio-time">{offsetX.toFixed(2)}</span>
                        </div>
                        <div className="studio-row">
                            <span className="studio-field-label">Pan Y</span>
                            <input
                                type="range"
                                min={-1}
                                max={1}
                                step={0.01}
                                value={offsetY}
                                onChange={(e) => onOffsetYChange(Number(e.target.value))}
                                onPointerUp={commitTransform}
                                className="studio-scrub"
                            />
                            <span className="studio-time">{offsetY.toFixed(2)}</span>
                        </div>
                    </div>
                )}

                {error && <div className="studio-status-error">{error}</div>}
            </div>
        </div>
    );
}
