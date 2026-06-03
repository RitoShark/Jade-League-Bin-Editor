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
                {sourceObj && (
                    <SideSection
                        title="Source"
                        model={sourceObj}
                        side="source"
                    />
                )}
                {targetObj && (
                    <SideSection
                        title="Target"
                        model={targetObj}
                        side="target"
                    />
                )}
            </div>
        </div>
    );
}

// ── Side section ──────────────────────────────────────────────────

function SideSection({ title, model, side }: {
    title: string;
    model: StudioObject;
    side: AnimStudioSide;
}) {
    const s = useShell();
    const [revision, setRevision] = useState(0);
    void side; // reserved for future per-side hooks (e.g. mesh
                // toggle that survives a clip reload).

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

    const toggleVisibility = (i: number) => {
        if (!lockSlot(i)) return;
        const slot = model.slots[i];
        if (!slot) return;
        slot.mesh.setEnabled(!slot.mesh.isEnabled());
        setRevision(r => r + 1);
    };

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
                        onClick={() => toggleVisibility(sm.index)}
                        title={sm.visible ? `Click to hide ${sm.name}` : `Click to show ${sm.name}`}
                    >
                        <div className="studio-mesh-name" title={sm.name}>{sm.name}</div>
                        <div className="studio-mesh-row">
                            <div className={`studio-mesh-badge studio-mesh-badge-${sm.resolution}`}>
                                {sm.resolution === 'auto' && 'auto-resolved'}
                                {sm.resolution === 'manual' && 'manual'}
                                {sm.resolution === 'missing' && 'no texture'}
                            </div>
                            <label
                                className="studio-mesh-flip"
                                title="Flip face winding for this submesh"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <input
                                    type="checkbox"
                                    checked={sm.flipped}
                                    onChange={() => toggleFlip(sm.index)}
                                />
                                Flip
                            </label>
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
