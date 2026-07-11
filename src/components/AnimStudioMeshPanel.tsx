/**
 * Animation Studio — submeshes + texture overrides panel.
 *
 * Trimmed clone of Photo Studio's mesh panel — same per-submesh
 * visibility toggle / face-flip / texture override, minus the
 * procedural-pattern editor and UV-debug viewer (animation
 * retargeting doesn't need either). Renders two stacked sections
 * (Source / Target) so users can hide buffbone meshes on either
 * rig before baking.
 *
 * Visibility is the whole card — click anywhere on the card (except
 * the action buttons) to toggle. Visible cards have the standard
 * surface; hidden cards dim down so the on/off state reads at a
 * glance without scanning for a tiny checkbox.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useShell } from '../shells/ShellContext';
import {
    setMeshFaceFlipped,
    isMeshFaceFlipped,
    type StudioObject,
} from '../lib/babylon/studioObject';
import { setFaceOrientationOverlay } from '../lib/babylon/faceOrientation';
import { applyShadingMode, setEdgesOverlay, loadShadePref, saveShadePref } from '../lib/babylon/viewportShading';
import StudioShadingToolbar from './StudioShadingToolbar';
import type { AnimStudioScene, AnimStudioSide } from '../lib/babylon/animStudioScene';
import './StudioPanels.css';

interface Props {
    animStudioTabId: string;
}

type Resolution = 'auto' | 'manual' | 'missing';

export default function AnimStudioMeshPanel({ animStudioTabId }: Props) {
    const s = useShell();
    const [tick, setTick] = useState(0);
    const scene: AnimStudioScene | null = s.getAnimStudioScene(animStudioTabId);
    useEffect(() => {
        if (!scene) {
            const t = setTimeout(() => setTick(n => n + 1), 80);
            return () => clearTimeout(t);
        }
        return scene.onChange(() => setTick(n => n + 1));
    }, [animStudioTabId, scene]);
    void tick;

    // Viewport shading is a PERSISTENT per-studio preference (localStorage),
    // so it survives this panel remounting on a tab switch AND app restarts,
    // and Animation Studio keeps its own choice separate from Photo Studio.
    // Initialised from storage; `patchShade` writes both state + storage.
    const [shade, setShade] = useState(() => loadShadePref('anim'));
    const shadeMode = shade.mode;
    const flatShade = shade.flat;
    const edges = shade.edges;
    const showFaceDirs = shade.faceDirs;
    const patchShade = (patch: Partial<ReturnType<typeof loadShadePref>>) => {
        setShade(prev => {
            const next = { ...prev, ...patch };
            saveShadePref('anim', next);
            return next;
        });
    };

    // Every submesh across both loaded rigs. `tick` (rig load / structural
    // change, not per-frame) re-derives it so late-loaded rigs pick up the mode.
    const collectMeshes = () => {
        const src = scene?.getSide('source').object;
        const tgt = scene?.getSide('target').object;
        return [...(src?.slots ?? []), ...(tgt?.slots ?? [])].map(sl => sl.mesh);
    };
    useEffect(() => {
        const meshes = collectMeshes();
        if (meshes.length === 0) return;
        try { applyShadingMode(meshes, shadeMode, flatShade); } catch { /* noop */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scene, tick, shadeMode, flatShade]);
    useEffect(() => {
        const meshes = collectMeshes();
        if (meshes.length === 0) return;
        try { setEdgesOverlay(meshes, edges); } catch { /* noop */ }
        return () => { const m = collectMeshes(); if (m.length) { try { setEdgesOverlay(m, false); } catch { /* noop */ } } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scene, tick, edges]);

    if (!scene) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
                <div className="mop-content">
                    <div className="anim-empty">Animation Studio scene initialising…</div>
                </div>
            </div>
        );
    }

    const sourceObj = scene.getSide('source').object;
    const targetObj = scene.getSide('target').object;

    if (!sourceObj && !targetObj) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
                <div className="mop-content">
                    <div className="anim-empty">Load a rig to manage its submeshes.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush anim-panel-scroll">
            <div className="mop-content">
                <StudioShadingToolbar
                    mode={shadeMode} onMode={(m) => patchShade({ mode: m })}
                    flat={flatShade} onFlat={() => patchShade({ flat: !flatShade })}
                    edges={edges} onEdges={() => patchShade({ edges: !edges })}
                    faceDirs={showFaceDirs} onFaceDirs={() => patchShade({ faceDirs: !showFaceDirs })}
                />
                {sourceObj && (
                    <SideSection
                        title="Source"
                        model={sourceObj}
                        side="source"
                        showFaceDirs={showFaceDirs}
                    />
                )}
                {targetObj && (
                    <SideSection
                        title="Target"
                        model={targetObj}
                        side="target"
                        showFaceDirs={showFaceDirs}
                    />
                )}
            </div>
        </div>
    );
}

// ── Side section ──────────────────────────────────────────────────

function SideSection({ title, model, side, showFaceDirs }: {
    title: string;
    model: StudioObject;
    side: AnimStudioSide;
    showFaceDirs: boolean;
}) {
    const s = useShell();
    const [revision, setRevision] = useState(0);
    void side; // reserved for future per-side hooks (e.g. mesh
                // toggle that survives a clip reload).

    // Blender-style face-orientation overlay for THIS rig (blue = outward,
    // red = inverted). Reads gl_FrontFacing live, so flipping a submesh
    // recolors it without a rebuild. Restored on toggle off / unmount.
    useEffect(() => {
        if (!showFaceDirs) return;
        const meshes = model.slots.map(sl => sl.mesh);
        try { setFaceOrientationOverlay(meshes, true); } catch { /* noop */ }
        return () => { try { setFaceOrientationOverlay(meshes, false); } catch { /* noop */ } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showFaceDirs, model]);

    // Re-poll auto-resolved textures after model load — Babylon's
    // texture pipeline is async, so an empty `albedoTexture` on the
    // first render doesn't mean missing.
    const [autoResolved, setAutoResolved] = useState<Set<number>>(new Set());
    useEffect(() => {
        setAutoResolved(new Set());
        let cancelled = false;
        const sampleAt = [100, 300, 600, 1200, 2400];
        const timers: ReturnType<typeof setTimeout>[] = [];
        for (const ms of sampleAt) {
            timers.push(setTimeout(() => {
                if (cancelled) return;
                const next = new Set<number>();
                for (let i = 0; i < model.slots.length; i++) {
                    if (model.slots[i].mat.albedoTexture) next.add(i);
                }
                setAutoResolved(next);
            }, ms));
        }
        return () => {
            cancelled = true;
            for (const t of timers) clearTimeout(t);
        };
    }, [model]);

    const submeshes = useMemo(() => {
        return model.slots.map((slot, i) => {
            const ov = model.slotOverrides[i] ?? { kind: 'none' as const };
            const manual = ov.kind === 'file' ? ov.path : null;
            const resolution: Resolution = ov.kind !== 'none'
                ? 'manual'
                : (autoResolved.has(i) ? 'auto' : 'missing');
            return {
                index: i,
                name: slot.mesh.name || `Submesh ${i}`,
                visible: slot.mesh.isEnabled(),
                flipped: isMeshFaceFlipped(slot.mesh),
                resolution,
                texPath: manual,
            };
        });
        // revision in deps so emit + apply calls trigger a re-read.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [model, autoResolved, revision]);

    // Spam guard — same 80ms per-slot lock the Photo Studio panel
    // uses. Mashing flip or rapid-clicking the card stops fighting
    // the render loop.
    const lockedSlotsRef = useRef<Set<number>>(new Set());
    const lockSlot = (i: number): boolean => {
        if (lockedSlotsRef.current.has(i)) return false;
        lockedSlotsRef.current.add(i);
        setTimeout(() => lockedSlotsRef.current.delete(i), 80);
        return true;
    };

    // ── Drag-to-paint visibility ──────────────────────────────────
    // Press on a card and drag across others to hide/show them in one
    // gesture. The first card sets the target state; every card entered is
    // forced to it (so a drag never flip-flops a card). Per-side.
    const paintDragRef = useRef(false);
    const paintTargetRef = useRef(true);
    const paintedRef = useRef<Set<number>>(new Set());

    const setSlotVisible = (i: number, visible: boolean) => {
        const slot = model.slots[i];
        if (!slot || slot.mesh.isEnabled() === visible) return;
        slot.mesh.setEnabled(visible);
        setRevision(r => r + 1);
    };

    const isInteractiveTarget = (el: EventTarget | null) =>
        el instanceof Element && !!el.closest('button, input, label, .studio-mesh-actions');

    const beginPaint = (i: number, e: React.MouseEvent) => {
        if (e.button !== 0 || isInteractiveTarget(e.target)) return;
        const slot = model.slots[i];
        if (!slot) return;
        e.preventDefault();
        paintDragRef.current = true;
        paintTargetRef.current = !slot.mesh.isEnabled();
        paintedRef.current = new Set([i]);
        setSlotVisible(i, paintTargetRef.current);
    };

    const paintEnter = (i: number) => {
        if (!paintDragRef.current || paintedRef.current.has(i)) return;
        paintedRef.current.add(i);
        setSlotVisible(i, paintTargetRef.current);
    };

    useEffect(() => {
        const onUp = () => { paintDragRef.current = false; };
        window.addEventListener('mouseup', onUp);
        return () => window.removeEventListener('mouseup', onUp);
    }, []);

    const toggleFlip = (i: number) => {
        if (!lockSlot(i)) return;
        const slot = model.slots[i];
        if (!slot) return;
        setMeshFaceFlipped(slot.mesh, !isMeshFaceFlipped(slot.mesh));
        setRevision(r => r + 1);
    };

    const linkTexture = async (i: number) => {
        const picked = await openDialog({
            filters: [
                { name: 'Textures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tex', 'dds'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (!picked || Array.isArray(picked)) return;
        const ok = await model.applyUserTexture(i, picked);
        if (ok) {
            setRevision(r => r + 1);
            // The scene-level emit also fires (StudioObject doesn't
            // emit to AnimStudioScene), so we re-poll texture status
            // by bumping the autoResolved sampler? Not needed —
            // manual overrides reflect immediately via slotOverrides.
        } else {
            s.setStatusMessage(`Anim Studio: failed to decode texture ${picked.split(/[\\/]/).pop()}`);
        }
    };

    const clearTexture = (i: number) => {
        model.clearUserTexture(i);
        setAutoResolved(prev => {
            if (!prev.has(i)) return prev;
            const next = new Set(prev);
            next.delete(i);
            return next;
        });
        setRevision(r => r + 1);
    };

    if (submeshes.length === 0) {
        return (
            <section className="anim-mesh-section">
                <div className="anim-mesh-section-head">{title}</div>
                <div className="anim-empty-block">
                    <p>No submeshes.</p>
                </div>
            </section>
        );
    }

    return (
        <section className="anim-mesh-section">
            <div className="anim-mesh-section-head">{title}</div>
            <div className="studio-mesh-grid">
                {submeshes.map(sm => (
                    <div
                        key={sm.index}
                        className={`studio-mesh-card ${sm.visible ? 'is-visible' : 'is-hidden'}`}
                        onMouseDown={(e) => beginPaint(sm.index, e)}
                        onMouseEnter={() => paintEnter(sm.index)}
                        title={sm.visible ? `Click / drag to hide ${sm.name}` : `Click / drag to show ${sm.name}`}
                    >
                        <div className="studio-mesh-name" title={sm.name}>{sm.name}</div>
                        <div className="studio-mesh-row">
                            <div className={`studio-mesh-badge studio-mesh-badge-${sm.resolution}`}>
                                {sm.resolution === 'auto' && 'auto-resolved'}
                                {sm.resolution === 'manual' && 'manual'}
                                {sm.resolution === 'missing' && 'no texture'}
                            </div>
                            <button
                                type="button"
                                className={`studio-mesh-flip-btn ${sm.flipped ? 'is-on' : ''}`}
                                title={sm.flipped
                                    ? 'Faces are flipped — click to flip back'
                                    : 'Flip this submesh’s face winding'}
                                onClick={(e) => { e.stopPropagation(); toggleFlip(sm.index); }}
                            >
                                Flip
                            </button>
                        </div>
                        {sm.texPath && (
                            <div className="studio-mesh-path" title={sm.texPath}>
                                {sm.texPath.split(/[\\/]/).pop()}
                            </div>
                        )}
                        <div className="studio-mesh-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                                type="button"
                                className="mop-btn mop-btn-accept"
                                onClick={() => linkTexture(sm.index)}
                            >
                                {sm.resolution === 'missing' ? 'Link…' : 'Change…'}
                            </button>
                            {sm.resolution === 'manual' && (
                                <button
                                    type="button"
                                    className="mop-btn mop-btn-cancel"
                                    onClick={() => clearTexture(sm.index)}
                                >
                                    Clear
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
