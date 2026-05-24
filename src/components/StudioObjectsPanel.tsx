/**
 * Photo Studio — scene objects panel.
 *
 * Shows every object currently in the studio scene (SKNs, GLTFs,
 * primitives) plus position / rotation / scale inputs for whichever
 * object is selected. Insert buttons at the bottom spawn primitives
 * the user can texture into custom backdrops via the mesh panel.
 *
 * This is the heart of the multi-object refactor — the anim and mesh
 * panels both follow whichever object the user picks here.
 */

import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useShell } from '../shells/ShellContext';
import type { StudioObject, PrimitiveKind, GizmoMode } from '../lib/babylon/studioScene';
import './StudioPanels.css';

interface StudioObjectsPanelProps {
    studioTabId: string;
}

export default function StudioObjectsPanel({ studioTabId }: StudioObjectsPanelProps) {
    const s = useShell();
    const [, setRevision] = useState(0);

    useEffect(() => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) return;
        const off = scene.onChange(() => setRevision((r) => r + 1));
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [studioTabId]);

    const scene = s.getStudioScene(studioTabId);
    const objects: StudioObject[] = scene?.getObjects() ?? [];
    const active = scene?.getActiveObject() ?? null;
    const gizmoMode: GizmoMode = scene?.getGizmoMode() ?? 'none';

    const setGizmo = (mode: GizmoMode) => {
        scene?.setGizmoMode(scene.getGizmoMode() === mode ? 'none' : mode);
    };

    const addPrimitive = (kind: PrimitiveKind) => {
        scene?.addPrimitive(kind);
    };

    const addModel = async () => {
        const picked = await openDialog({
            filters: [
                { name: 'Models', extensions: ['skn', 'scb', 'sco', 'gltf', 'glb', 'fbx'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (!picked || Array.isArray(picked) || !scene) return;
        try {
            await scene.addModelFromDisk(picked);
        } catch (e) {
            s.setStatusMessage(`Studio: load failed — ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const canUndo = scene?.canUndo() ?? false;
    const canRedo = scene?.canRedo() ?? false;

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel">
            <div className="mop-content">
                <div className="studio-row">
                    <button
                        type="button"
                        className="mop-btn mop-btn-cancel"
                        onClick={() => { void scene?.undo(); }}
                        disabled={!canUndo}
                        title="Undo (Ctrl+Z)"
                        style={{ flex: 1 }}
                    >↶ Undo</button>
                    <button
                        type="button"
                        className="mop-btn mop-btn-cancel"
                        onClick={() => { void scene?.redo(); }}
                        disabled={!canRedo}
                        title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
                        style={{ flex: 1 }}
                    >↷ Redo</button>
                </div>
                <div className="studio-row" style={{ flexWrap: 'wrap' }}>
                    <button type="button" className="mop-btn mop-btn-cancel" onClick={() => addPrimitive('cube')}>+ Cube</button>
                    <button type="button" className="mop-btn mop-btn-cancel" onClick={() => addPrimitive('plane')}>+ Plane</button>
                    <button type="button" className="mop-btn mop-btn-cancel" onClick={() => addPrimitive('sphere')}>+ Sphere</button>
                    <button type="button" className="mop-btn mop-btn-accept" onClick={addModel} style={{ marginLeft: 'auto' }}>Open model…</button>
                </div>
                <div className="studio-row">
                    <button
                        type="button"
                        className="mop-btn mop-btn-cancel"
                        onClick={() => scene?.frameCamera()}
                        disabled={objects.length === 0}
                        style={{ width: '100%' }}
                        title="Recenter the camera on the selected object and reset zoom / pan speed (Maya F / Blender numpad-dot)"
                    >
                        ⛶ {active ? `Frame camera on ${active.name}` : 'Frame camera on scene'}
                    </button>
                </div>

                <div className="studio-objects-list">
                    {objects.length === 0 && (
                        <div className="mop-field-hint" style={{ padding: '6px 0' }}>
                            Empty scene. Drop a model on the viewport or use the buttons above.
                        </div>
                    )}
                    {objects.map((o) => {
                        const visible = o.root.isEnabled();
                        return (
                            <button
                                key={o.id}
                                type="button"
                                className={`studio-objects-row${active?.id === o.id ? ' active' : ''}`}
                                onClick={() => scene?.setActiveObject(o.id)}
                            >
                                <span className={`studio-objects-kind kind-${o.kind}`}>{kindLabel(o.kind)}</span>
                                <span className="studio-objects-name">{o.name}</span>
                                <span
                                    className={`studio-objects-eye${visible ? ' visible' : ' hidden'}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        // Toggle the whole hierarchy at the root —
                                        // Babylon propagates `isEnabled` to children,
                                        // so flipping it on the TransformNode hides
                                        // every submesh in one call without touching
                                        // their individual enabled flags. Per-submesh
                                        // visibility (set via the Mesh panel) survives
                                        // the round-trip when we toggle back on.
                                        o.root.setEnabled(!visible);
                                        setRevision((r) => r + 1);
                                    }}
                                    title={visible ? 'Hide object' : 'Show object'}
                                >
                                    {/* Both icons live in the DOM — CSS swaps which
                                        one is visible based on hover state so the
                                        button previews what the click will do. */}
                                    <Eye size={14} className="studio-objects-eye-idle" />
                                    <EyeOff size={14} className="studio-objects-eye-hover" />
                                </span>
                                <span
                                    className="studio-objects-remove"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        scene?.removeObject(o.id);
                                    }}
                                    title="Remove from scene"
                                >✕</span>
                            </button>
                        );
                    })}
                </div>

                {active && (
                    <>
                        <div className="studio-objects-gizmo-row">
                            <span className="studio-objects-gizmo-label">Gizmo</span>
                            <button
                                type="button"
                                className={`studio-gizmo-btn${gizmoMode === 'move' ? ' active' : ''}`}
                                onClick={() => setGizmo('move')}
                                title="Move (translate arrows)"
                            >Move</button>
                            <button
                                type="button"
                                className={`studio-gizmo-btn${gizmoMode === 'rotate' ? ' active' : ''}`}
                                onClick={() => setGizmo('rotate')}
                                title="Rotate (orbit rings)"
                            >Rotate</button>
                            <button
                                type="button"
                                className={`studio-gizmo-btn${gizmoMode === 'scale' ? ' active' : ''}`}
                                onClick={() => setGizmo('scale')}
                                title="Scale (cube handles)"
                            >Scale</button>
                            {gizmoMode !== 'none' && (
                                <button
                                    type="button"
                                    className="studio-gizmo-btn"
                                    onClick={() => scene?.setGizmoMode('none')}
                                    title="Hide gizmo"
                                >✕</button>
                            )}
                        </div>
                        <TransformInputs
                            key={active.id /* re-mount when active changes so inputs reset */}
                            obj={active}
                            onChange={() => setRevision((r) => r + 1)}
                            onCommit={() => scene?.commitUndoStep()}
                        />
                    </>
                )}
            </div>
        </div>
    );
}

function kindLabel(kind: StudioObject['kind']): string {
    if (kind === 'skn') return 'SKN';
    if (kind === 'gltf') return 'GLTF';
    if (kind === 'fbx') return 'FBX';
    if (kind === 'cube') return 'CUBE';
    if (kind === 'plane') return 'PLANE';
    if (kind === 'sphere') return 'SPH';
    return kind;
}

/**
 * Pos / rot / scale numeric inputs bound directly to the object's
 * root TransformNode. We read live from the node each render (cheap)
 * so spinner increments and dock-resize re-renders stay in sync; we
 * write directly back when the user types so the change is visible
 * on the next frame.
 */
function TransformInputs({ obj, onChange, onCommit }: {
    obj: StudioObject;
    onChange: () => void;
    /** Called when the user finishes editing a field (blur) or hits
     *  Reset — records one undo step for the whole edit gesture
     *  rather than one per keystroke. */
    onCommit: () => void;
}) {
    // Local state mirrors the node for input editing so partial typing
    // (e.g. "1." while typing "1.5") doesn't snap back. We commit on
    // change / blur.
    const [tick, setTick] = useState(0);
    void tick;

    const writePos = (axis: 'x' | 'y' | 'z', v: number) => {
        obj.root.position[axis] = v;
        setTick((t) => t + 1);
        onChange();
    };
    const writeRot = (axis: 'x' | 'y' | 'z', deg: number) => {
        obj.root.rotation[axis] = (deg * Math.PI) / 180;
        setTick((t) => t + 1);
        onChange();
    };
    const writeScale = (axis: 'x' | 'y' | 'z', v: number) => {
        obj.root.scaling[axis] = v;
        setTick((t) => t + 1);
        onChange();
    };
    const resetTransform = () => {
        obj.root.position.setAll(0);
        obj.root.rotation.setAll(0);
        obj.root.scaling.setAll(1);
        setTick((t) => t + 1);
        onChange();
        onCommit();
    };

    return (
        <div className="studio-objects-transform">
            <div className="studio-objects-section-head">
                <span>Transform</span>
                <button type="button" className="studio-objects-reset" onClick={resetTransform}>Reset</button>
            </div>
            <TransformRow
                label="Pos"
                vec={[obj.root.position.x, obj.root.position.y, obj.root.position.z]}
                step={1}
                onChange={writePos}
                onCommit={onCommit}
            />
            <TransformRow
                label="Rot°"
                vec={[
                    (obj.root.rotation.x * 180) / Math.PI,
                    (obj.root.rotation.y * 180) / Math.PI,
                    (obj.root.rotation.z * 180) / Math.PI,
                ]}
                step={5}
                onChange={writeRot}
                onCommit={onCommit}
            />
            <TransformRow
                label="Scl"
                vec={[obj.root.scaling.x, obj.root.scaling.y, obj.root.scaling.z]}
                step={0.1}
                onChange={writeScale}
                onCommit={onCommit}
            />
        </div>
    );
}

function TransformRow({
    label, vec, step, onChange, onCommit,
}: {
    label: string;
    vec: [number, number, number];
    step: number;
    onChange: (axis: 'x' | 'y' | 'z', v: number) => void;
    onCommit: () => void;
}) {
    const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
    return (
        <div className="studio-objects-transform-row">
            <span className="studio-objects-transform-label">{label}</span>
            {axes.map((ax, i) => (
                <input
                    key={ax}
                    type="number"
                    step={step}
                    value={Number.isFinite(vec[i]) ? round(vec[i]) : 0}
                    onChange={(e) => onChange(ax, Number(e.target.value))}
                    onBlur={onCommit}
                    className="mop-input studio-objects-axis-input"
                    title={ax.toUpperCase()}
                />
            ))}
        </div>
    );
}

function round(n: number): number {
    return Math.round(n * 1000) / 1000;
}
