/**
 * Animation Studio — Guides panel.
 *
 * Lets the user pin specific target bones to their parent at a
 * tweakable XYZ offset, overriding whatever the retarget pipeline
 * would produce for that bone. Designed for the canonical "weapon
 * sits wrong in the hand" case:
 *
 *   1. Click "+ Add" → pick "Weapon" from the target rig
 *   2. The Weapon bone becomes a rigid follower of its parent
 *      (R_Hand) at target's bind offset.
 *   3. Dial in the XYZ offset (numerically or via the gizmo button)
 *      until the weapon lands in the grip visually.
 */

import { useEffect, useMemo, useState } from 'react';
import {
    ArrowLeftRight as PosIcon,
    RotateCw as RotIcon,
    RotateCcw as ResetIcon,
    X as RemoveIcon,
} from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import type { AnimStudioScene, BoneGuide } from '../lib/babylon/animStudioScene';
import BoneDropdown from './BoneDropdown';
import './StudioPanels.css';

interface AnimStudioGuidesPanelProps {
    animStudioTabId: string;
}

export default function AnimStudioGuidesPanel({ animStudioTabId }: AnimStudioGuidesPanelProps) {
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
    const guides = useMemo(() => scene?.getGuides() ?? [], [scene, tick]);
    const targetJoints = useMemo(() => scene?.getTargetJoints() ?? [], [scene, tick]);

    void tick;
    const editingHash = scene?.getEditingGuideHash() ?? null;
    const editingMode = scene?.getEditingGuideMode() ?? null;

    const nameByHash = useMemo(() => {
        const m = new Map<number, string>();
        for (const j of targetJoints) m.set(j.hash, j.name);
        return m;
    }, [targetJoints]);

    const guidedHashes = useMemo(() => new Set(guides.map(g => g.targetBoneHash)), [guides]);
    const availableTargets = useMemo(() =>
        targetJoints.filter(j => !guidedHashes.has(j.hash)),
        [targetJoints, guidedHashes],
    );

    const onCommitNew = (targetHash: number | null) => {
        if (targetHash === null) return;
        scene?.setGuide({
            targetBoneHash: targetHash,
            offsetX: 0,
            offsetY: 0,
            offsetZ: 0,
        });
    };

    const onPatch = (g: BoneGuide, patch: Partial<BoneGuide>) => {
        scene?.setGuide({ ...g, ...patch });
    };

    if (!scene) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
                <div className="mop-content">
                    <div className="anim-empty">Animation Studio scene initialising…</div>
                </div>
            </div>
        );
    }

    if (targetJoints.length === 0) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
                <div className="mop-content">
                    <div className="anim-empty">Load a target rig to add guides.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush anim-panel-scroll">
            <div className="mop-content">
                <div className="anim-section-head" style={{ padding: '6px 8px' }}>
                    <span className="anim-section-title">
                        {guides.length} guide{guides.length === 1 ? '' : 's'}
                    </span>
                    <div style={{ flex: '0 0 200px', minWidth: 0, maxWidth: 220 }}>
                        <BoneDropdown
                            value={null}
                            options={availableTargets}
                            onChange={onCommitNew}
                            placeholder={availableTargets.length === 0
                                ? 'all bones already guided'
                                : '+ Add guide…'}
                            disabled={availableTargets.length === 0}
                            title="Add a guide for a target bone"
                        />
                    </div>
                </div>

                {guides.length === 0 && (
                    <div className="anim-empty-block">
                        <p>
                            No guides yet. Add one to pin a target bone to its
                            parent at a tweakable XYZ offset.
                        </p>
                        <p>
                            Use this for the weapon when the retarget can't
                            sit it in the hand correctly: add a guide on
                            Weapon, then dial X/Y/Z until it looks right.
                        </p>
                    </div>
                )}

                <div className="anim-list">
                    {guides.map((g) => {
                        const name = nameByHash.get(g.targetBoneHash) ?? `bone#${g.targetBoneHash.toString(16)}`;
                        const isEditingPos = editingHash === g.targetBoneHash && editingMode === 'position';
                        const isEditingRot = editingHash === g.targetBoneHash && editingMode === 'rotation';
                        const posZeroed = g.offsetX === 0 && g.offsetY === 0 && g.offsetZ === 0;
                        const rotZeroed = (g.rotX ?? 0) === 0 && (g.rotY ?? 0) === 0 && (g.rotZ ?? 0) === 0;
                        return (
                            <div key={g.targetBoneHash} className="anim-card">
                                <div className="anim-card-head">
                                    <span className="anim-card-title">{name}</span>
                                    <button
                                        type="button"
                                        onClick={() => scene?.setEditingGuide(
                                            isEditingPos ? null : g.targetBoneHash,
                                            isEditingPos ? null : 'position',
                                        )}
                                        title="Drag a position gizmo in the target viewport"
                                        className={`anim-mini-btn${isEditingPos ? ' active' : ''}`}
                                    ><PosIcon size={12} /></button>
                                    <button
                                        type="button"
                                        onClick={() => scene?.setEditingGuide(
                                            isEditingRot ? null : g.targetBoneHash,
                                            isEditingRot ? null : 'rotation',
                                        )}
                                        title="Drag a rotation gizmo in the target viewport"
                                        className={`anim-mini-btn${isEditingRot ? ' active' : ''}`}
                                    ><RotIcon size={12} /></button>
                                    <button
                                        type="button"
                                        onClick={() => scene?.removeGuide(g.targetBoneHash)}
                                        title="Remove this guide"
                                        className="anim-card-remove"
                                    ><RemoveIcon size={13} /></button>
                                </div>

                                <div
                                    className="anim-field-row"
                                    title="Glue this bone to the picked follow bone. Default = the SKL parent."
                                >
                                    <span className="anim-field-label">Glue</span>
                                    <BoneDropdown
                                        value={g.followBoneHash ?? null}
                                        options={targetJoints}
                                        emptyLabel="(SKL parent — default)"
                                        placeholder="(SKL parent — default)"
                                        onChange={(hash) => onPatch(g, { followBoneHash: hash })}
                                    />
                                </div>

                                <div className="anim-field-row" title="Position offset in the follow bone's local frame">
                                    <span className="anim-field-label">Pos</span>
                                    <div className="anim-axis-group">
                                        <AxisField label="X" value={g.offsetX} onChange={(v) => onPatch(g, { offsetX: v })} />
                                        <AxisField label="Y" value={g.offsetY} onChange={(v) => onPatch(g, { offsetY: v })} />
                                        <AxisField label="Z" value={g.offsetZ} onChange={(v) => onPatch(g, { offsetZ: v })} />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => onPatch(g, { offsetX: 0, offsetY: 0, offsetZ: 0 })}
                                        title="Reset position offset"
                                        className="anim-reset-btn"
                                        disabled={posZeroed}
                                    ><ResetIcon size={12} /></button>
                                </div>

                                <div
                                    className="anim-field-row"
                                    title="Rotation offset in degrees (XYZ Tait-Bryan)."
                                >
                                    <span className="anim-field-label">Rot°</span>
                                    <div className="anim-axis-group">
                                        <AxisField label="X" value={g.rotX ?? 0} onChange={(v) => onPatch(g, { rotX: v })} />
                                        <AxisField label="Y" value={g.rotY ?? 0} onChange={(v) => onPatch(g, { rotY: v })} />
                                        <AxisField label="Z" value={g.rotZ ?? 0} onChange={(v) => onPatch(g, { rotZ: v })} />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => onPatch(g, { rotX: 0, rotY: 0, rotZ: 0 })}
                                        title="Reset rotation offset"
                                        className="anim-reset-btn"
                                        disabled={rotZeroed}
                                    ><ResetIcon size={12} /></button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function AxisField({ label, value, onChange }: {
    label: string;
    value: number;
    onChange: (v: number) => void;
}) {
    const [text, setText] = useState(String(value));
    useEffect(() => { setText(String(value)); }, [value]);
    const commit = () => {
        const v = parseFloat(text);
        onChange(Number.isFinite(v) ? v : 0);
        setText(String(Number.isFinite(v) ? v : 0));
    };
    return (
        <label className="anim-axis-field">
            <span className="anim-axis-letter">{label}</span>
            <input
                type="number"
                step="0.5"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
                className="anim-axis-input"
            />
        </label>
    );
}
