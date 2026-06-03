/**
 * Animation Studio — Physics panel.
 *
 * Spring-driven physics chains (cape / tail / hair) + sphere
 * colliders. Chains are baked into the retargeted DTO every recompute,
 * so what you see in the target viewport IS what gets written when
 * you bake.
 */

import { useEffect, useMemo, useState } from 'react';
import { MoreVertical as MoreIcon, X as RemoveIcon, FlaskConical as ExperimentalIcon } from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import type {
    AnimStudioScene,
    PhysicsChain,
    PhysicsCollider,
} from '../lib/babylon/animStudioScene';
import BoneDropdown from './BoneDropdown';
import './StudioPanels.css';

interface Props {
    animStudioTabId: string;
}

function newId(): string {
    return Math.random().toString(36).slice(2, 10);
}

const DEFAULT_CHAIN: Omit<PhysicsChain, 'id' | 'boneHashes'> = {
    name: '',
    stiffness: 0.35,
    damping: 0.86,
    gravity: 9.81,
    inertia: 0.5,
    lockLength: true,
    solver: 'simple',
    loopBlend: 0,
};

const DEFAULT_COLLIDER: Omit<PhysicsCollider, 'id' | 'boneHash'> = {
    radius: 50,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
};

export default function AnimStudioPhysicsPanel({ animStudioTabId }: Props) {
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
    const chains = useMemo(() => scene?.getPhysicsChains() ?? [], [scene, tick]);
    const colliders = useMemo(() => scene?.getPhysicsColliders() ?? [], [scene, tick]);
    const targetJoints = useMemo(() => scene?.getTargetJoints() ?? [], [scene, tick]);

    const nameByHash = useMemo(() => {
        const m = new Map<number, string>();
        for (const j of targetJoints) m.set(j.hash, j.name);
        return m;
    }, [targetJoints]);

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
                    <div className="anim-empty">Load a target rig to set up physics.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush anim-panel-scroll">
            <div className="mop-content">
                <div className="anim-experimental-banner" role="note">
                    <ExperimentalIcon size={14} className="anim-experimental-icon" />
                    <span>
                        <strong>Physics are experimental.</strong> Results can look
                        wrong (floating, clipping, jitter) and parameters are still
                        being tuned. Use sparingly and double-check the bake before
                        you rely on it.
                    </span>
                </div>
                <ChainsSection
                    scene={scene}
                    chains={chains}
                    targetJoints={targetJoints}
                    nameByHash={nameByHash}
                />
                <CollidersSection
                    scene={scene}
                    colliders={colliders}
                    targetJoints={targetJoints}
                    nameByHash={nameByHash}
                />
            </div>
        </div>
    );
}

// ── Chains ────────────────────────────────────────────────────────

function ChainsSection({ scene, chains, targetJoints, nameByHash }: {
    scene: AnimStudioScene;
    chains: PhysicsChain[];
    targetJoints: Array<{ hash: number; name: string }>;
    nameByHash: Map<number, string>;
}) {
    const childrenByParent = useMemo(() => {
        const m = new Map<number, number[]>();
        const sc = scene as AnimStudioScene & {
            getSide?: (s: 'source' | 'target') => { object: { skn?: { joints: Array<{ name_hash: number; parent_id: number }> } } | null };
        };
        const obj = sc.getSide?.('target').object;
        const joints = obj?.skn?.joints;
        if (!joints) return m;
        for (let i = 0; i < joints.length; i++) {
            const j = joints[i];
            if (j.parent_id < 0) continue;
            const parentHash = joints[j.parent_id]?.name_hash;
            if (parentHash === undefined) continue;
            const arr = m.get(parentHash);
            if (arr) arr.push(j.name_hash);
            else m.set(parentHash, [j.name_hash]);
        }
        return m;
    }, [scene, targetJoints]);

    const autoExtendChain = (rootHash: number): number[] => {
        const out = [rootHash];
        let cur = rootHash;
        for (let safety = 0; safety < 64; safety++) {
            const kids = childrenByParent.get(cur);
            if (!kids || kids.length !== 1) break;
            out.push(kids[0]);
            cur = kids[0];
        }
        return out;
    };

    const chainHashes = useMemo(() => {
        const set = new Set<number>();
        for (const c of chains) for (const h of c.boneHashes) set.add(h);
        return set;
    }, [chains]);
    const availableRoots = useMemo(() =>
        targetJoints.filter(j => !chainHashes.has(j.hash)),
        [targetJoints, chainHashes],
    );

    const onAddChain = (rootHash: number | null) => {
        if (rootHash === null) return;
        const boneHashes = autoExtendChain(rootHash);
        scene.setPhysicsChain({ id: newId(), boneHashes, ...DEFAULT_CHAIN });
    };

    return (
        <div className="anim-panel-section">
            <div className="anim-section-head" style={{ padding: '6px 8px' }}>
                <span className="anim-section-title">
                    Chains <span className="anim-count-chip">{chains.length}</span>
                </span>
                <div style={{ flex: '0 0 200px', minWidth: 0, maxWidth: 220 }}>
                    <BoneDropdown
                        value={null}
                        options={availableRoots}
                        onChange={onAddChain}
                        placeholder={availableRoots.length === 0
                            ? 'all bones are in a chain'
                            : '+ Chain (pick root)…'}
                        disabled={availableRoots.length === 0}
                        title="Add a physics chain rooted at a target bone"
                    />
                </div>
            </div>

            {chains.length === 0 && (
                <div className="anim-empty-block">
                    <p>
                        No physics chains yet. Add one rooted at a cape /
                        tail / hair bone — it'll auto-walk the SKL to cover
                        the chain.
                    </p>
                    <p>
                        Tip: tweak stiffness lower for floppier swing, damping
                        lower for more bounce.
                    </p>
                </div>
            )}

            <div className="anim-list">
                {chains.map(c => (
                    <ChainRow
                        key={c.id}
                        scene={scene}
                        chain={c}
                        nameByHash={nameByHash}
                        targetJoints={targetJoints}
                    />
                ))}
            </div>
        </div>
    );
}

function ChainRow({ scene, chain, nameByHash, targetJoints }: {
    scene: AnimStudioScene;
    chain: PhysicsChain;
    nameByHash: Map<number, string>;
    targetJoints: Array<{ hash: number; name: string }>;
}) {
    const rootName = nameByHash.get(chain.boneHashes[0]) ?? `bone#${chain.boneHashes[0].toString(16)}`;
    const tipName = nameByHash.get(chain.boneHashes[chain.boneHashes.length - 1]) ?? '';
    const patch = (p: Partial<PhysicsChain>) => scene.setPhysicsChain({ ...chain, ...p });
    const [editingBones, setEditingBones] = useState(false);
    const inChain = useMemo(() => new Set(chain.boneHashes), [chain.boneHashes]);
    const boneCandidates = useMemo(() =>
        targetJoints.filter(j => !inChain.has(j.hash)),
        [targetJoints, inChain],
    );

    return (
        <div className="anim-card">
            <div className="anim-card-head">
                <span className="anim-card-title">
                    {chain.name || rootName} → {tipName}
                </span>
                <span className="anim-card-sub">{chain.boneHashes.length} bones</span>
                <button
                    type="button"
                    onClick={() => setEditingBones(e => !e)}
                    className={`anim-mini-btn${editingBones ? ' active' : ''}`}
                    title="Edit chain bones"
                ><MoreIcon size={12} /></button>
                <button
                    type="button"
                    onClick={() => scene.removePhysicsChain(chain.id)}
                    className="anim-card-remove"
                    title="Remove this chain"
                ><RemoveIcon size={13} /></button>
            </div>

            {editingBones && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 6, background: 'rgba(255, 255, 255, 0.02)', borderRadius: 3 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {chain.boneHashes.map((h, i) => {
                            const weights = chain.boneHashes.map((_, idx) => chain.boneWeights?.[idx] ?? 1);
                            return (
                                <div key={`${h}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span className="anim-bone-chip" style={{ flex: 1, minWidth: 0 }}>
                                        <span className="anim-bone-chip-idx">{i}.</span>
                                        {nameByHash.get(h) ?? h.toString(16)}
                                        {i > 0 && (
                                            <button
                                                type="button"
                                                onClick={() => patch({
                                                    boneHashes: chain.boneHashes.filter((_, idx) => idx !== i),
                                                    boneWeights: weights.filter((_, idx) => idx !== i),
                                                })}
                                                className="anim-bone-chip-x"
                                                title="Remove from chain"
                                            ><RemoveIcon size={10} /></button>
                                        )}
                                    </span>
                                    {i > 0 && (
                                        <label
                                            className="anim-bone-weight"
                                            title="Weight — heavier bones are pulled down harder by gravity. Bump the tip bones so the cape/tail drops instead of gliding. (Havok solver)"
                                        >
                                            <span>×</span>
                                            <input
                                                type="number"
                                                min={0.1}
                                                max={20}
                                                step={0.5}
                                                value={weights[i]}
                                                onChange={(e) => {
                                                    const v = Math.max(0.1, Math.min(20, parseFloat(e.target.value) || 1));
                                                    const next = weights.slice();
                                                    next[i] = v;
                                                    patch({ boneWeights: next });
                                                }}
                                            />
                                        </label>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <BoneDropdown
                        value={null}
                        options={boneCandidates}
                        onChange={(hash) => {
                            if (hash !== null) {
                                const weights = chain.boneHashes.map((_, idx) => chain.boneWeights?.[idx] ?? 1);
                                patch({ boneHashes: [...chain.boneHashes, hash], boneWeights: [...weights, 1] });
                            }
                        }}
                        placeholder="+ Add bone to tip…"
                        disabled={boneCandidates.length === 0}
                    />
                </div>
            )}

            <div className="anim-solver-row" title="Jade = fast built-in spring solver. Havok = deterministic rigid-body sim for more accurate cloth / hair (bakes on a background WASM instance).">
                <span className="anim-solver-label">Solver</span>
                <div className="anim-solver-toggle">
                    <button
                        type="button"
                        className={`anim-solver-btn${(chain.solver ?? 'simple') === 'simple' ? ' is-on' : ''}`}
                        onClick={() => patch({ solver: 'simple' })}
                    >Jade</button>
                    <button
                        type="button"
                        className={`anim-solver-btn${chain.solver === 'havok' ? ' is-on' : ''}`}
                        onClick={() => patch({ solver: 'havok' })}
                    >Havok</button>
                </div>
            </div>

            <SliderRow
                label="Stiff"
                value={chain.stiffness}
                min={0} max={1} step={0.01}
                title="How hard the chain pulls toward the rigid pose. Higher = stiffer."
                onChange={(v) => patch({ stiffness: v })}
            />
            <SliderRow
                label="Damp"
                value={chain.damping}
                min={0} max={1} step={0.01}
                title="Velocity damping per step. 1 = no damping (bouncy), 0 = snaps to target."
                onChange={(v) => patch({ damping: v })}
            />
            <SliderRow
                label="Grav"
                value={chain.gravity}
                min={0} max={50} step={0.1}
                title="Gravity acceleration. 0 = floating hair."
                onChange={(v) => patch({ gravity: v })}
            />
            <SliderRow
                label="Iner"
                value={chain.inertia}
                min={0} max={1} step={0.01}
                title="Anchor velocity propagated into the chain — drags the tail when the anchor swings."
                onChange={(v) => patch({ inertia: v })}
            />
            <SliderRow
                label="Loop"
                value={chain.loopBlend ?? 0}
                min={0} max={30} step={1}
                title="Seamless-loop blend (frames). Eases the last N frames toward the first frame's pose so cyclic clips (run / idle) don't pop at the loop seam. 0 = off. Leave off for one-shot clips."
                onChange={(v) => patch({ loopBlend: Math.round(v) })}
                format={(v) => (v < 1 ? 'off' : `${Math.round(v)}f`)}
            />
            <label className="anim-check-row">
                <input
                    type="checkbox"
                    checked={chain.lockLength}
                    onChange={(e) => patch({ lockLength: e.target.checked })}
                />
                <span>Lock chain length (no stretch)</span>
            </label>
        </div>
    );
}

// ── Colliders ─────────────────────────────────────────────────────

function CollidersSection({ scene, colliders, targetJoints, nameByHash }: {
    scene: AnimStudioScene;
    colliders: PhysicsCollider[];
    targetJoints: Array<{ hash: number; name: string }>;
    nameByHash: Map<number, string>;
}) {
    const onAdd = (boneHash: number | null) => {
        if (boneHash === null) return;
        scene.setPhysicsCollider({ id: newId(), boneHash, ...DEFAULT_COLLIDER });
    };

    return (
        <div className="anim-panel-section">
            <div className="anim-section-head" style={{ padding: '6px 8px' }}>
                <span className="anim-section-title">
                    Colliders <span className="anim-count-chip">{colliders.length}</span>
                </span>
                <div style={{ flex: '0 0 200px', minWidth: 0, maxWidth: 220 }}>
                    <BoneDropdown
                        value={null}
                        options={targetJoints}
                        onChange={onAdd}
                        placeholder="+ Sphere on bone…"
                        title="Add a sphere collider on a body bone"
                    />
                </div>
            </div>

            {colliders.length === 0 && (
                <div className="anim-empty-block">
                    <p>
                        No sphere colliders. Add them on Spine / Thigh bones
                        to stop the cape from clipping through legs.
                    </p>
                </div>
            )}

            <div className="anim-list">
                {colliders.map(c => (
                    <ColliderRow key={c.id} scene={scene} col={c} nameByHash={nameByHash} />
                ))}
            </div>
        </div>
    );
}

function ColliderRow({ scene, col, nameByHash }: {
    scene: AnimStudioScene;
    col: PhysicsCollider;
    nameByHash: Map<number, string>;
}) {
    const name = nameByHash.get(col.boneHash) ?? `bone#${col.boneHash.toString(16)}`;
    const patch = (p: Partial<PhysicsCollider>) => scene.setPhysicsCollider({ ...col, ...p });
    return (
        <div className="anim-card">
            <div className="anim-card-head">
                <span className="anim-card-title">{name}</span>
                <button
                    type="button"
                    onClick={() => scene.removePhysicsCollider(col.id)}
                    className="anim-card-remove"
                    title="Remove this collider"
                ><RemoveIcon size={13} /></button>
            </div>
            <SliderRow
                label="Rad"
                value={col.radius}
                min={1} max={300} step={1}
                title="Sphere radius in world units."
                onChange={(v) => patch({ radius: v })}
            />
            <div className="anim-field-row" title="Offset in the bone's local frame">
                <span className="anim-field-label">Off</span>
                <div className="anim-axis-group">
                    <AxisField label="X" value={col.offsetX} onChange={(v) => patch({ offsetX: v })} />
                    <AxisField label="Y" value={col.offsetY} onChange={(v) => patch({ offsetY: v })} />
                    <AxisField label="Z" value={col.offsetZ} onChange={(v) => patch({ offsetZ: v })} />
                </div>
            </div>
        </div>
    );
}

// ── Shared inputs ─────────────────────────────────────────────────

function SliderRow({ label, value, min, max, step, title, onChange, format }: {
    label: string;
    value: number;
    min: number; max: number; step: number;
    title?: string;
    onChange: (v: number) => void;
    format?: (v: number) => string;
}) {
    return (
        <label className="anim-slider-row" title={title}>
            <span className="anim-field-label" style={{ width: 38 }}>{label}</span>
            <input
                type="range"
                min={min} max={max} step={step}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
            />
            <span className="anim-slider-value">{format ? format(value) : value.toFixed(2)}</span>
        </label>
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
