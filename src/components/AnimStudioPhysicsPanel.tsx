/**
 * Animation Studio — Physics panel.
 *
 * Spring-driven physics chains (cape / tail / hair) + sphere
 * colliders. Chains are baked into the retargeted DTO every recompute,
 * so what you see in the target viewport IS what gets written when
 * you bake.
 */

import { useEffect, useMemo, useState } from 'react';
import { MoreVertical as MoreIcon, X as RemoveIcon, FlaskConical as ExperimentalIcon, Eye as EyeIcon, EyeOff as EyeOffIcon, Wand2 as GenerateIcon } from 'lucide-react';
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

/** Built-in fallback for a new chain's slider values. Overridden by
 *  whatever the user last saved via "Set as default" (see
 *  {@link loadChainDefaults}). */
const BUILTIN_CHAIN_DEFAULTS: Omit<PhysicsChain, 'id' | 'boneHashes'> = {
    name: '',
    stiffness: 0.35,
    damping: 0.5,
    gravity: 9.81,
    inertia: 0.5,
    lockLength: true,
    maxSwing: 0,
    solver: 'simple',
    loopBlend: 10,
};

const CHAIN_DEFAULTS_KEY = 'anim-physics-chain-defaults';

/** New-chain defaults = built-in values overlaid with the user's saved
 *  preference (if any). Read fresh at add-time so a just-saved default
 *  applies to the next chain without a reload. */
function loadChainDefaults(): Omit<PhysicsChain, 'id' | 'boneHashes'> {
    try {
        const raw = window.localStorage.getItem(CHAIN_DEFAULTS_KEY);
        if (raw) {
            const saved = JSON.parse(raw) as Partial<PhysicsChain>;
            return { ...BUILTIN_CHAIN_DEFAULTS, ...saved, name: '' };
        }
    } catch { /* ignore corrupt / unavailable storage */ }
    return { ...BUILTIN_CHAIN_DEFAULTS };
}

/** Persist a chain's slider values as the default for future chains. */
function saveChainDefaults(chain: PhysicsChain): void {
    const d = {
        stiffness: chain.stiffness,
        damping: chain.damping,
        gravity: chain.gravity,
        inertia: chain.inertia,
        lockLength: chain.lockLength,
        maxSwing: chain.maxSwing ?? 0,
        solver: chain.solver ?? 'simple',
        loopBlend: chain.loopBlend ?? 0,
    };
    try { window.localStorage.setItem(CHAIN_DEFAULTS_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

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
    // The rig physics attach to depends on the mode: the target rig in
    // Retarget mode, the single source rig in Physics mode.
    const targetJoints = useMemo(() => scene?.getPhysicsJoints() ?? [], [scene, tick]);
    const mode = scene?.getMode() ?? 'retarget';

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
                    <div className="anim-empty">
                        {mode === 'physics'
                            ? 'Load a rig to set up physics.'
                            : 'Load a target rig to set up physics.'}
                    </div>
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
                        <strong>Physics are still being tuned.</strong> The Jade
                        solver now uses a stable Verlet/PBD sim (no more blow-ups),
                        but colliders and per-rig scale still need a careful eye —
                        double-check the bake before you rely on it.
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
                <MeshCollisionSection scene={scene} />
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
        const obj = sc.getSide?.(scene.getPhysicsRigSide()).object;
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
        scene.setPhysicsChain({ id: newId(), boneHashes, ...loadChainDefaults() });
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
    const s = useShell();
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

            <div className="anim-solver-row" title="Jade = fast built-in Verlet/PBD solver (stable at any setting; recommended). Havok = deterministic rigid-body sim (bakes on a background WASM instance) — more physically accurate but scale-sensitive.">
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
            <SliderRow
                label="Swing"
                value={chain.maxSwing ?? 0}
                min={0} max={180} step={5}
                title="Swing limit — max angle each bone may swing from its combed rest pose. Stops hair from folding through the body or turning inside-out on fast attacks. 0 = off (unlimited). Try ~60–90° for hair. (Jade solver.)"
                onChange={(v) => patch({ maxSwing: Math.round(v) })}
                format={(v) => (v < 1 || v >= 180 ? 'off' : `${Math.round(v)}°`)}
            />
            <label className="anim-check-row">
                <input
                    type="checkbox"
                    checked={chain.lockLength}
                    onChange={(e) => patch({ lockLength: e.target.checked })}
                />
                <span>Lock chain length (no stretch)</span>
            </label>
            <button
                type="button"
                className="anim-set-default-btn"
                title="Save these slider values (stiffness, damping, gravity, inertia, loop, lock, solver) as the default for new chains"
                onClick={() => {
                    saveChainDefaults(chain);
                    s.setStatusMessage('Physics: saved these settings as the default for new chains.');
                }}
            >
                Set as default
            </button>
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
    const s = useShell();
    const onAdd = (boneHash: number | null) => {
        if (boneHash === null) return;
        scene.setPhysicsCollider({ id: newId(), boneHash, ...DEFAULT_COLLIDER });
    };
    const onGenerate = () => {
        const n = scene.generateCollidersFromMesh();
        s.setStatusMessage(n > 0
            ? `Physics: generated ${n} body collider${n === 1 ? '' : 's'} from the mesh.`
            : 'Physics: no new colliders generated (rig has none to fit, or they already exist).');
    };

    const showColliders = scene.getShowColliders();
    return (
        <div className="anim-panel-section">
            <div className="anim-section-head" style={{ padding: '6px 8px' }}>
                <span className="anim-section-title">
                    Colliders <span className="anim-count-chip">{colliders.length}</span>
                </span>
                <button
                    type="button"
                    className="anim-mini-btn"
                    title="Auto-fit body colliders (capsules per bone) from the mesh — like an Unreal Physics Asset. Skips hair/chain bones; dedupes existing."
                    onClick={onGenerate}
                >
                    <GenerateIcon size={12} />
                </button>
                <button
                    type="button"
                    className={`anim-mini-btn${showColliders ? ' active' : ''}`}
                    title={showColliders
                        ? 'Hide the collider preview spheres'
                        : 'Show translucent spheres in the viewport so you can size-check colliders during playback'}
                    onClick={() => scene.setShowColliders(!showColliders)}
                >
                    {showColliders ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
                </button>
                <div style={{ flex: '0 0 150px', minWidth: 0, maxWidth: 170 }}>
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
                        No colliders yet. Hit the <GenerateIcon size={11} style={{ verticalAlign: 'middle' }} /> wand
                        to auto-fit body capsules from the mesh, or add one
                        manually on a Spine / Thigh bone. Span a collider to a
                        second bone (e.g. Hip → Knee) to wrap a whole limb.
                    </p>
                </div>
            )}

            <div className="anim-list">
                {colliders.map(c => (
                    <ColliderRow key={c.id} scene={scene} col={c} nameByHash={nameByHash} targetJoints={targetJoints} />
                ))}
            </div>
        </div>
    );
}

function ColliderRow({ scene, col, nameByHash, targetJoints }: {
    scene: AnimStudioScene;
    col: PhysicsCollider;
    nameByHash: Map<number, string>;
    targetJoints: Array<{ hash: number; name: string }>;
}) {
    const name = nameByHash.get(col.boneHash) ?? `bone#${col.boneHash.toString(16)}`;
    const toName = col.boneHashB !== undefined ? (nameByHash.get(col.boneHashB) ?? '') : '';
    const patch = (p: Partial<PhysicsCollider>) => scene.setPhysicsCollider({ ...col, ...p });
    const spanCandidates = useMemo(
        () => targetJoints.filter(j => j.hash !== col.boneHash),
        [targetJoints, col.boneHash],
    );
    return (
        <div className="anim-card">
            <div className="anim-card-head">
                <span className="anim-card-title">
                    {name}{toName ? ` → ${toName}` : ''}
                </span>
                <span className="anim-card-sub">{toName ? 'capsule' : 'sphere'}</span>
                <button
                    type="button"
                    onClick={() => scene.removePhysicsCollider(col.id)}
                    className="anim-card-remove"
                    title="Remove this collider"
                ><RemoveIcon size={13} /></button>
            </div>
            <div className="anim-field-row" title="Make this a bone-shaped CAPSULE by spanning to a second bone (e.g. Hip → Knee for a thigh). Empty = plain sphere.">
                <span className="anim-field-label">Span</span>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <BoneDropdown
                        value={col.boneHashB ?? null}
                        options={spanCandidates}
                        onChange={(h) => patch({ boneHashB: h ?? undefined })}
                        emptyLabel="(sphere — no span)"
                        placeholder="+ Span to bone (capsule)…"
                    />
                </div>
            </div>
            <SliderRow
                label="Rad"
                value={col.radius}
                min={1} max={300} step={1}
                title="Sphere / capsule radius in world units."
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

// ── Mesh collision (Maya-style) ───────────────────────────────────

function MeshCollisionSection({ scene }: { scene: AnimStudioScene }) {
    const cfg = scene.getMeshCollision();
    const meshNames = scene.getPhysicsMeshNames();
    const excluded = new Set(cfg.excludedMeshes);
    const toggleExcluded = (name: string) => {
        const next = new Set(excluded);
        if (next.has(name)) next.delete(name); else next.add(name);
        scene.setMeshCollision({ excludedMeshes: Array.from(next) });
    };
    return (
        <div className="anim-panel-section">
            <div className="anim-section-head" style={{ padding: '6px 8px' }}>
                <span className="anim-section-title">Mesh collision</span>
                <span className="anim-card-sub">{cfg.enabled ? 'on' : 'off'}</span>
            </div>
            <p className="anim-batch-hint" style={{ padding: '0 8px' }}>
                Collide chains against the rig's actual mesh (Maya-style), for
                precision capsules can't reach. Costs more per bake — a lower-poly
                rig is faster. <strong>Exclude the hair/cape mesh below</strong> so
                it doesn't collide with itself.
            </p>
            <label className="anim-check-row" style={{ padding: '0 8px' }}>
                <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) => scene.setMeshCollision({ enabled: e.target.checked })}
                    disabled={meshNames.length === 0}
                />
                <span>Enable mesh collision</span>
            </label>
            {cfg.enabled && (
                <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <SliderRow
                        label="Thick"
                        value={cfg.thickness}
                        min={0.1} max={30} step={0.1}
                        title="Collision shell radius — how far chain bones stay off the mesh surface (Maya's 'thickness'). Bump it if hair pokes through; lower it if it floats off the body."
                        onChange={(v) => scene.setMeshCollision({ thickness: v })}
                    />
                    <div className="anim-options-mesh-list" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color, #3e3e42)', borderRadius: 4 }}>
                        <div style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.05, fontWeight: 600 }}>
                            Collider submeshes
                        </div>
                        {meshNames.length === 0 ? (
                            <div className="anim-empty" style={{ padding: 2 }}>Load a rig.</div>
                        ) : meshNames.map((name, i) => {
                            const included = !excluded.has(name);
                            return (
                                <label key={`${name}:${i}`} className="anim-check-row" title={name} style={{ padding: 0 }}>
                                    <input type="checkbox" checked={included} onChange={() => toggleExcluded(name)} />
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: included ? 1 : 0.55 }}>
                                        {name}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                </div>
            )}
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
