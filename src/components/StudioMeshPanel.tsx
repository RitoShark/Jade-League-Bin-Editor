/**
 * Photo Studio — submeshes + texture overrides panel.
 *
 * Two columns of horizontal cards (one per submesh) since this panel
 * docks to the bottom by default and the layout is wider than it is
 * tall. Each card shows:
 *
 *   - Visibility toggle (hides the submesh in the viewport + capture)
 *   - Resolution badge (auto = Jade found a BIN texture, manual = user
 *     linked one, missing = neither)
 *   - "Link texture" button (when missing or manual) that opens a file
 *     dialog and applies the picked .tex / .dds to that submesh
 *
 * Re-renders on every scene change event so loading a new model
 * repopulates without prop wiring.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { useShell } from '../shells/ShellContext';
import PortalDropdown from './PortalDropdown';
import {
    setMeshFaceFlipped,
    isMeshFaceFlipped,
    PROCEDURAL_KINDS,
    PROCEDURAL_LABELS,
    describeProceduralPattern,
    type ProceduralPattern,
} from '../lib/babylon/studioObject';
import './StudioPanels.css';

interface StudioMeshPanelProps {
    studioTabId: string;
}

type Resolution = 'auto' | 'manual' | 'missing';

export default function StudioMeshPanel({ studioTabId }: StudioMeshPanelProps) {
    const s = useShell();
    const [revision, setRevision] = useState(0);
    // Per-slot texture override state is the source of truth on the
    // StudioObject (`model.slotOverrides`) — the panel just reads it
    // and bumps `revision` to re-render after a change. Storing it on
    // the object means scene save/load + undo capture it for free.
    // Which card has its procedural editor open. Single-active so the
    // mesh panel doesn't get visually overwhelming when the model has
    // many submeshes.
    const [openProcIdx, setOpenProcIdx] = useState<number | null>(null);
    // Which card has its UV viewer open. Single-active so the mesh
    // panel stays compact on models with many submeshes.
    const [openUvIdx, setOpenUvIdx] = useState<number | null>(null);
    // Track which submeshes the auto pipeline resolved. Sampled when
    // a model loads, since the texture pipeline is async — checking
    // `albedoTexture` on first render returns null even when a
    // texture is about to arrive.
    const [autoResolved, setAutoResolved] = useState<Set<number>>(new Set());

    useEffect(() => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) return;
        const off = scene.onChange(() => setRevision((r) => r + 1));
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [studioTabId]);

    // Reset transient panel UI when the underlying model changes
    // (open editors don't line up with the new submeshes).
    const scene = s.getStudioScene(studioTabId);
    const model = scene?.getActiveObject() ?? null;
    useEffect(() => {
        setOpenProcIdx(null);
        setOpenUvIdx(null);
        setAutoResolved(new Set());
    }, [model]);

    // Poll the auto pipeline for ~3 seconds after a model loads. The
    // BIN walk + texture decode race the panel mount; without this we'd
    // either freeze the resolution state at "missing" (if we sampled
    // once on mount) or constantly re-sample on every render (wasted
    // work after textures settle).
    useEffect(() => {
        if (!model) return;
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
        if (!model) return [] as { index: number; name: string; visible: boolean; flipped: boolean; resolution: Resolution; texPath: string | null; pattern: ProceduralPattern | null }[];
        return model.slots.map((slot, i) => {
            const ov = model.slotOverrides[i] ?? { kind: 'none' as const };
            const manual = ov.kind === 'file' ? ov.path : null;
            const pattern = ov.kind === 'pattern' ? ov.pattern : null;
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
                pattern,
            };
        });
        // revision in deps so onChange events + apply* calls trigger
        // a re-read of `model.slotOverrides`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [model, autoResolved, revision]);

    const toggleVisibility = (i: number) => {
        if (!model) return;
        const slot = model.slots[i];
        if (!slot) return;
        slot.mesh.setEnabled(!slot.mesh.isEnabled());
        scene?.commitUndoStep();
        setRevision((r) => r + 1);
    };

    const toggleFlip = (i: number) => {
        if (!model) return;
        const slot = model.slots[i];
        if (!slot) return;
        setMeshFaceFlipped(slot.mesh, !isMeshFaceFlipped(slot.mesh));
        scene?.commitUndoStep();
        setRevision((r) => r + 1);
    };

    const linkTexture = async (i: number) => {
        if (!model) return;
        const picked = await openDialog({
            filters: [
                { name: 'Textures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tex', 'dds'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (!picked || Array.isArray(picked)) return;
        const ok = await model.applyUserTexture(i, picked);
        if (ok) {
            // `model.slotOverrides[i]` is updated inside applyUserTexture;
            // bump revision so the panel re-reads it.
            scene?.commitUndoStep();
            setRevision((r) => r + 1);
        } else {
            s.setStatusMessage(`Studio: failed to decode texture ${picked.split(/[\\/]/).pop()}`);
        }
    };

    const applyPattern = (i: number, pattern: ProceduralPattern) => {
        if (!model) return;
        const ok = model.applyProceduralTexture(i, pattern);
        if (!ok) return;
        // `applyProceduralTexture` records the override on the object;
        // re-render to reflect it.
        scene?.commitUndoStep();
        setRevision((r) => r + 1);
    };

    const clearTexture = (i: number) => {
        if (!model) return;
        model.clearUserTexture(i);
        // Auto-resolved status is sticky — clearing a manual override
        // doesn't bring back the auto texture (we'd need to re-run the
        // pipeline). Surface that intent honestly by dropping the auto
        // flag too so the badge shows "missing" until the user re-links.
        setAutoResolved((prev) => {
            if (!prev.has(i)) return prev;
            const next = new Set(prev);
            next.delete(i);
            return next;
        });
        scene?.commitUndoStep();
        setRevision((r) => r + 1);
    };

    if (!model) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel">
                <div className="mop-content">
                    <div className="mop-field-hint">
                        Drop a model on the viewport to manage its submeshes
                        and override textures Jade couldn't resolve.
                    </div>
                </div>
            </div>
        );
    }

    if (submeshes.length === 0) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel">
                <div className="mop-content">
                    <div className="mop-field-hint">Loaded model has no submeshes.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel studio-mesh-panel">
            <div className="mop-content studio-mesh-content">
                {/* Transparency moved to the Spotlight panel — it
                    lives alongside the other rendering options
                    (shading, ground shadow) where users expect to
                    find scene-level appearance controls. */}
                <div className="studio-mesh-grid">
                    {submeshes.map((sm) => (
                        <div key={sm.index} className="studio-mesh-card">
                            <label className="studio-mesh-vis">
                                <input
                                    type="checkbox"
                                    checked={sm.visible}
                                    onChange={() => toggleVisibility(sm.index)}
                                />
                                <span className="studio-mesh-name" title={sm.name}>{sm.name}</span>
                            </label>
                            <div className="studio-mesh-row">
                                <div className={`studio-mesh-badge studio-mesh-badge-${sm.resolution}`}>
                                    {sm.resolution === 'auto' && 'auto-resolved'}
                                    {sm.resolution === 'manual' && 'manual'}
                                    {sm.resolution === 'missing' && 'no texture'}
                                </div>
                                <label className="studio-mesh-flip" title="Flip face winding for this submesh">
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
                            {sm.pattern && (
                                <div className="studio-mesh-path" title={describeProceduralPattern(sm.pattern)}>
                                    {describeProceduralPattern(sm.pattern)}
                                </div>
                            )}
                            <div className="studio-mesh-actions">
                                <button
                                    type="button"
                                    className="mop-btn mop-btn-accept"
                                    onClick={() => linkTexture(sm.index)}
                                >
                                    {sm.resolution === 'missing' ? 'Link…' : 'Change…'}
                                </button>
                                <button
                                    type="button"
                                    className="mop-btn mop-btn-cancel"
                                    onClick={() => setOpenProcIdx(openProcIdx === sm.index ? null : sm.index)}
                                    title="Generate a color / pattern texture without needing a file"
                                >
                                    {sm.pattern ? 'Edit pattern' : 'Pattern…'}
                                </button>
                                <button
                                    type="button"
                                    className="mop-btn mop-btn-cancel"
                                    onClick={() => setOpenUvIdx(openUvIdx === sm.index ? null : sm.index)}
                                    title="Show this submesh's actual UV layout (debug)"
                                >
                                    UV…
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
                            {openProcIdx === sm.index && (
                                <ProceduralEditor
                                    current={sm.pattern}
                                    onApply={(p) => applyPattern(sm.index, p)}
                                    onClose={() => setOpenProcIdx(null)}
                                />
                            )}
                            {openUvIdx === sm.index && model && (
                                <UvViewer
                                    mesh={model.slots[sm.index]?.mesh}
                                    onClose={() => setOpenUvIdx(null)}
                                />
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/**
 * Inline pattern editor that sits inside a mesh card. Composes a
 * `ProceduralPattern` from a kind dropdown + 1-2 color pickers and
 * pushes it to the slot's procedural-texture applier. Auto-applies
 * on every change so users see the pattern paint live as they tweak
 * the colors — no separate "Apply" round-trip needed.
 */
function ProceduralEditor({ current, onApply, onClose }: {
    current: ProceduralPattern | null;
    onApply: (p: ProceduralPattern) => void;
    onClose: () => void;
}) {
    const [kind, setKind] = useState<ProceduralPattern['kind']>(current?.kind ?? 'solid');
    const [colorA, setColorA] = useState<string>(
        current && 'colorA' in current ? current.colorA : '#7aa6ff',
    );
    const [colorB, setColorB] = useState<string>(
        current && current.kind !== 'solid' && current.kind !== 'uv-test' && 'colorB' in current
            ? current.colorB
            : '#ff7aaf',
    );
    // UV-test pattern doesn't take colors — it's a fixed debug
    // texture. Solid uses only color A. Everything else needs both.
    const needsA = kind !== 'uv-test';
    const needsB = kind !== 'solid' && kind !== 'uv-test';

    // Apply on every change. Cheap — pattern repaint is a canvas
    // operation Babylon uploads in one frame.
    useEffect(() => {
        const params: ProceduralPattern =
            kind === 'uv-test' ? { kind } :
            kind === 'solid' ? { kind, colorA } :
            { kind, colorA, colorB };
        onApply(params);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, colorA, colorB]);

    return (
        <div className="studio-proc-editor">
            <div className="studio-proc-row">
                <span className="studio-proc-label">Pattern</span>
                <PortalDropdown
                    options={PROCEDURAL_KINDS.map((k) => ({
                        value: k,
                        label: PROCEDURAL_LABELS[k],
                    }))}
                    value={kind}
                    onChange={(v) => setKind(v as ProceduralPattern['kind'])}
                    style={{ width: '100%' }}
                />
            </div>
            {needsA && (
                <div className="studio-proc-row">
                    <span className="studio-proc-label">{needsB ? 'Color A' : 'Color'}</span>
                    <input
                        type="color"
                        value={colorA}
                        onChange={(e) => setColorA(e.target.value)}
                        className="studio-color-swatch"
                    />
                    <input
                        type="text"
                        value={colorA}
                        onChange={(e) => setColorA(e.target.value)}
                        className="mop-input"
                        style={{ flex: 1, minWidth: 80 }}
                    />
                </div>
            )}
            {needsB && (
                <div className="studio-proc-row">
                    <span className="studio-proc-label">Color B</span>
                    <input
                        type="color"
                        value={colorB}
                        onChange={(e) => setColorB(e.target.value)}
                        className="studio-color-swatch"
                    />
                    <input
                        type="text"
                        value={colorB}
                        onChange={(e) => setColorB(e.target.value)}
                        className="mop-input"
                        style={{ flex: 1, minWidth: 80 }}
                    />
                </div>
            )}
            <div className="studio-proc-row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="mop-btn mop-btn-cancel" onClick={onClose}>Done</button>
            </div>
        </div>
    );
}

/**
 * 2D UV unwrap viewer for a single submesh — Blender's UV editor in
 * miniature. Reads the mesh's UV vertex buffer + index buffer and
 * paints every triangle's UV-space edges onto a canvas.
 *
 * What to look for:
 *
 *   - Edges that all collapse onto a single point → all verts share
 *     one UV (degenerate), every screen pixel samples the same
 *     texel.
 *   - Edges that fall OUTSIDE the [0, 1] box → texture sampling
 *     wraps or clamps in unexpected ways at those triangles.
 *   - Edges packed into one tiny corner → UVs got scaled down by an
 *     unintended factor.
 *   - Edges that look like the model's silhouette → UVs are
 *     position-projected rather than properly authored.
 *   - Edges that look mirrored vs. what you see in Blender → V is
 *     flipped somewhere in the pipeline.
 *
 * Background is a grey grid scaled to [0, 1] so the box is the
 * texture's UV space directly.
 */
function UvViewer({ mesh, onClose }: { mesh: AbstractMesh | undefined; onClose: () => void }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [stats, setStats] = useState<{ verts: number; tris: number; uMin: number; uMax: number; vMin: number; vMax: number } | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !mesh) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
        const indices = mesh.getIndices();
        if (!uvs || !indices) {
            ctx.fillStyle = '#444';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#fff';
            ctx.font = '12px sans-serif';
            ctx.fillText('No UV / index data on this mesh', 10, 20);
            setStats(null);
            return;
        }

        const W = canvas.width;
        const H = canvas.height;

        // First pass: scan UV range so we can auto-fit the view to
        // include any out-of-box UVs (negative V, > 1, etc.). Pad by
        // a 0.1 margin and always include the [0, 1] reference box.
        let uMinScan = Infinity, uMaxScan = -Infinity, vMinScan = Infinity, vMaxScan = -Infinity;
        for (let i = 0; i < uvs.length; i += 2) {
            const u = uvs[i];
            const v = uvs[i + 1];
            if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
            if (u < uMinScan) uMinScan = u;
            if (u > uMaxScan) uMaxScan = u;
            if (v < vMinScan) vMinScan = v;
            if (v > vMaxScan) vMaxScan = v;
        }
        const fitUMin = Math.min(0, Number.isFinite(uMinScan) ? uMinScan : 0) - 0.1;
        const fitUMax = Math.max(1, Number.isFinite(uMaxScan) ? uMaxScan : 1) + 0.1;
        const fitVMin = Math.min(0, Number.isFinite(vMinScan) ? vMinScan : 0) - 0.1;
        const fitVMax = Math.max(1, Number.isFinite(vMaxScan) ? vMaxScan : 1) + 0.1;
        const fitUSpan = fitUMax - fitUMin;
        const fitVSpan = fitVMax - fitVMin;

        // Project a UV onto canvas pixels, with V flipped so V=0 is
        // at the bottom (matches Blender's UV editor convention).
        const drawX = (u: number) => ((u - fitUMin) / fitUSpan) * W;
        const drawY = (v: number) => H - ((v - fitVMin) / fitVSpan) * H;

        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, W, H);

        // Grid lines at integer + half-integer UV values across the
        // fitted range, so the user can read scale even when UVs
        // extend well past `[0, 1]`.
        ctx.strokeStyle = '#2a2a2a';
        ctx.lineWidth = 1;
        const uStart = Math.floor(fitUMin * 2) / 2;
        const uEnd   = Math.ceil(fitUMax * 2) / 2;
        const vStart = Math.floor(fitVMin * 2) / 2;
        const vEnd   = Math.ceil(fitVMax * 2) / 2;
        for (let u = uStart; u <= uEnd + 1e-9; u += 0.5) {
            const x = drawX(u);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
        }
        for (let v = vStart; v <= vEnd + 1e-9; v += 0.5) {
            const y = drawY(v);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
        }
        // Axes through U=0 and V=0 — bolder so the user can see where
        // negative space starts.
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(drawX(0), 0); ctx.lineTo(drawX(0), H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, drawY(0)); ctx.lineTo(W, drawY(0)); ctx.stroke();
        // The [0, 1] reference box — yellow so it stands out against
        // the unwrap.
        ctx.strokeStyle = '#d4b020';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(drawX(0), drawY(1), drawX(1) - drawX(0), drawY(0) - drawY(1));
        // (0, 0) marker — red dot at the corner of the [0, 1] box.
        ctx.fillStyle = '#ff1f3a';
        ctx.beginPath();
        ctx.arc(drawX(0), drawY(0), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(120, 200, 255, 0.65)';
        ctx.lineWidth = 1;
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        const triCount = Math.floor(indices.length / 3);
        for (let t = 0; t < triCount; t++) {
            const i0 = indices[t * 3];
            const i1 = indices[t * 3 + 1];
            const i2 = indices[t * 3 + 2];
            const u0 = uvs[i0 * 2];
            const v0 = uvs[i0 * 2 + 1];
            const u1 = uvs[i1 * 2];
            const v1 = uvs[i1 * 2 + 1];
            const u2 = uvs[i2 * 2];
            const v2 = uvs[i2 * 2 + 1];
            if (Number.isFinite(u0)) {
                uMin = Math.min(uMin, u0, u1, u2);
                uMax = Math.max(uMax, u0, u1, u2);
                vMin = Math.min(vMin, v0, v1, v2);
                vMax = Math.max(vMax, v0, v1, v2);
            }
            ctx.beginPath();
            ctx.moveTo(drawX(u0), drawY(v0));
            ctx.lineTo(drawX(u1), drawY(v1));
            ctx.lineTo(drawX(u2), drawY(v2));
            ctx.closePath();
            ctx.stroke();
        }
        // Vertex dots — small but bright so degenerate clusters jump
        // out.
        ctx.fillStyle = 'rgba(255, 220, 80, 0.85)';
        const vertCount = uvs.length / 2;
        for (let v = 0; v < vertCount; v++) {
            ctx.beginPath();
            ctx.arc(drawX(uvs[v * 2]), drawY(uvs[v * 2 + 1]), 1.5, 0, Math.PI * 2);
            ctx.fill();
        }

        setStats({
            verts: vertCount,
            tris: triCount,
            uMin: Number.isFinite(uMin) ? uMin : 0,
            uMax: Number.isFinite(uMax) ? uMax : 0,
            vMin: Number.isFinite(vMin) ? vMin : 0,
            vMax: Number.isFinite(vMax) ? vMax : 0,
        });
    }, [mesh]);

    return (
        <div className="studio-uv-viewer">
            <div className="studio-uv-header">
                <span>UV layout</span>
                <button type="button" className="studio-uv-close" onClick={onClose}>✕</button>
            </div>
            <canvas
                ref={canvasRef}
                width={280}
                height={280}
                className="studio-uv-canvas"
            />
            {stats && (
                <div className="studio-uv-stats">
                    <div>{stats.tris} tris · {stats.verts} verts</div>
                    <div>U: {stats.uMin.toFixed(3)} → {stats.uMax.toFixed(3)}</div>
                    <div>V: {stats.vMin.toFixed(3)} → {stats.vMax.toFixed(3)}</div>
                </div>
            )}
        </div>
    );
}
