/**
 * Animation Studio — Options panel.
 *
 * Hosts the per-side rig pickers + the retarget option toggles. Same
 * lifecycle pattern as the Photo Studio panels: pulls its scene out
 * of `ShellContext` by `animStudioTabId` and renders nothing useful
 * when that scene isn't ready (the tab body builds the scene on
 * mount; this can re-render once it lands).
 *
 * Phase-4 inline rows it replaces:
 *   - Header chip row (Source / ⇄ / Target / clear buttons)
 *   - Retarget options strip (rescale / rebase toggles)
 * Both move here so the tab body is just the dual viewports + the
 * scrubber strip. Users can dock this panel anywhere or float it.
 */

import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
    ArrowLeftRight as SwapIcon,
    Check as CheckIcon,
    FolderOpen as FolderOpenIcon,
    RotateCcw as ResetIcon,
    RefreshCw as RefreshIcon,
    X as RemoveIcon,
} from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import type { AnimStudioScene, AnimStudioSide } from '../lib/babylon/animStudioScene';
import BoneDropdown from './BoneDropdown';
import './StudioPanels.css';

interface AnimStudioOptionsPanelProps {
    animStudioTabId: string;
}

const SKN_EXT = ['skn', 'gltf', 'glb', 'fbx'];

export default function AnimStudioOptionsPanel({ animStudioTabId }: AnimStudioOptionsPanelProps) {
    const s = useShell();
    // Re-render when the scene fires onChange (clip loaded, side
    // swapped, options toggled, etc). The panel itself owns no
    // state — every render reads fresh values off the scene.
    const [, setTick] = useState(0);
    const scene: AnimStudioScene | null = s.getAnimStudioScene(animStudioTabId);
    useEffect(() => {
        if (!scene) {
            // Scene not built yet (StrictMode double-mount, or the
            // tab is still spinning up). Re-check on a tiny defer
            // so we don't miss the register.
            const t = setTimeout(() => setTick(n => n + 1), 80);
            return () => clearTimeout(t);
        }
        return scene.onChange(() => setTick(n => n + 1));
    }, [animStudioTabId, scene]);
    const sourceInfo = scene?.getSide('source') ?? { path: null, object: null };
    const targetInfo = scene?.getSide('target') ?? { path: null, object: null };
    const opts = scene?.getRetargetOptions() ?? {
        rescaleTranslations: false,
        rebaseRotations: true,
        stripRootMotion: false,
        mirror: false,
        lockBoneLengths: true,
        dropMismatchedParents: false,
        verticalOffset: 0,
        verticalOffsetExcludedMeshes: [],
        fixGroundReference: true,
        fixGroundReferenceDynamicRefNode: true,
        fixAnimations: true,
        rootNodeName: 'Root',
        groundReferenceNodeName: '',
        groundReferenceVerticalAxis: '' as '' | 'X' | 'Y' | 'Z',
    };
    const targetMeshNames = scene?.getTargetMeshNames() ?? [];
    const sourceJointNames = scene?.getSourceJointNames() ?? [];

    // Auto-fill ground reference node when the user hasn't picked
    // one and a foot bone exists on source. Triggers once per
    // source-rig load; subsequent renders preserve the user's
    // choice.
    useEffect(() => {
        if (!scene) return;
        if (opts.groundReferenceNodeName !== '') return;
        if (sourceJointNames.length === 0) return;
        const candidates = ['L_Foot', 'l_foot', 'R_Foot', 'r_foot', 'LeftFoot', 'RightFoot'];
        for (const c of candidates) {
            if (sourceJointNames.includes(c)) {
                scene.setRetargetOptions({ groundReferenceNodeName: c });
                return;
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceJointNames.length, opts.groundReferenceNodeName]);
    const excludedSet = new Set(opts.verticalOffsetExcludedMeshes ?? []);
    const toggleMeshExclusion = (name: string) => {
        if (!scene) return;
        const current = new Set(scene.getRetargetOptions().verticalOffsetExcludedMeshes ?? []);
        if (current.has(name)) current.delete(name);
        else current.add(name);
        scene.setRetargetOptions({ verticalOffsetExcludedMeshes: Array.from(current) });
    };
    const canRetarget = scene?.hasClip() === true
        && sourceInfo.object !== null
        && targetInfo.object !== null;

    const onSwap = () => scene?.swap();
    const onClear = (side: AnimStudioSide) => scene?.clear(side);
    const onPick = async (side: AnimStudioSide) => {
        const picked = await openDialog({
            title: `Pick a ${side} rig`,
            filters: [{ name: 'Skinned model', extensions: SKN_EXT }],
        });
        if (typeof picked !== 'string' || !scene) return;
        try {
            await scene.loadSkn(side, picked);
            s.setStatusMessage(`Anim Studio: loaded ${fileNameOf(picked)} as ${side}`);
        } catch (e) {
            s.setStatusMessage(`Anim Studio: load failed — ${e instanceof Error ? e.message : String(e)}`);
        }
    };
    // Re-read the rig from disk (picks up SKN / .bin / texture edits made in
    // Maya etc. since it was loaded). loadSkn keeps the clip + mapping.
    const onReload = async (side: AnimStudioSide) => {
        const p = scene?.getSide(side).path;
        if (!p || !scene) return;
        try {
            await scene.loadSkn(side, p);
            s.setStatusMessage(`Anim Studio: reloaded ${fileNameOf(p)}`);
        } catch (e) {
            s.setStatusMessage(`Anim Studio: reload failed — ${e instanceof Error ? e.message : String(e)}`);
        }
    };
    const onToggleRescale = () => scene?.setRetargetOptions({ rescaleTranslations: !opts.rescaleTranslations });
    const onToggleRebase = () => scene?.setRetargetOptions({ rebaseRotations: !opts.rebaseRotations });
    const onToggleStripRoot = () => scene?.setRetargetOptions({ stripRootMotion: !opts.stripRootMotion });
    const onToggleLockBoneLengths = () => scene?.setRetargetOptions({ lockBoneLengths: !opts.lockBoneLengths });
    const onToggleMirror = () => scene?.setRetargetOptions({ mirror: !opts.mirror });
    const onToggleFixGround = () => scene?.setRetargetOptions({ fixGroundReference: !opts.fixGroundReference });
    const onToggleFixGroundDynamic = () => scene?.setRetargetOptions({ fixGroundReferenceDynamicRefNode: !opts.fixGroundReferenceDynamicRefNode });
    const onToggleFixAnims = () => scene?.setRetargetOptions({ fixAnimations: !opts.fixAnimations });
    const onToggleCheckHierarchy = () => scene?.setRetargetOptions({ dropMismatchedParents: !opts.dropMismatchedParents });

    // (Bake → .anm moved to the Export panel. Scene Open / Save live in
    // the File menu — see VSTitleBar's onOpen/SaveAnimStudioScene.)

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-padded anim-panel-scroll">
            <div className="mop-content">
            <div className="anim-options-grid">

            <section className="anim-options-section">
            <div className="anim-options-section-head">Rigs</div>
            <div className="anim-options-rigs-row">
                <SideEditor
                    label="Source"
                    path={sourceInfo.path}
                    onPick={() => onPick('source')}
                    onClear={() => onClear('source')}
                    onReload={() => onReload('source')}
                    onSwap={onSwap}
                    swapDisabled={!sourceInfo.path && !targetInfo.path}
                />
                <SideEditor
                    label="Target"
                    path={targetInfo.path}
                    onPick={() => onPick('target')}
                    onClear={() => onClear('target')}
                    onReload={() => onReload('target')}
                    onSwap={onSwap}
                    swapDisabled={!sourceInfo.path && !targetInfo.path}
                />
            </div>
            </section>

            <section className="anim-options-section">
            <div className="anim-options-section-head">Retarget (Babylon)</div>
            <div style={togglesRowStyle}>
                <RetargetToggle
                    label="Retarget keys"
                    title="Babylon's `retargetAnimationKeys`. Full change-of-basis math using source + target reference poses (parent and bone world matrices). Disable for a pure name-based remap with no transform compensation — useful for debugging."
                    checked={opts.rebaseRotations}
                    disabled={!canRetarget}
                    onClick={onToggleRebase}
                />
                <RetargetToggle
                    label="Fix root position"
                    title="Babylon's `fixRootPosition`. Scales root locomotion by the ratio of target / source root-to-ground distances so locomotion clips travel the right distance per step. Requires Root + Ground ref nodes set below."
                    checked={opts.rescaleTranslations}
                    disabled={!canRetarget}
                    onClick={onToggleRescale}
                />
                <RetargetToggle
                    label="Fix ground reference"
                    title="Babylon's `fixGroundReference`. Anchors the ground-reference bone to the source's vertical world position at every frame, so the character doesn't float or sink relative to the floor. Requires Ground ref node set below."
                    checked={opts.fixGroundReference}
                    disabled={!canRetarget}
                    onClick={onToggleFixGround}
                />
                <RetargetToggle
                    label="Fix ground ref. dynamic"
                    title="Babylon's `fixGroundReferenceDynamicRefNode`. Per-frame scan for the lowest bone — keeps grounding correct during kicks and crouches where the configured ref bone is temporarily off the floor. Only matters with Fix ground reference on."
                    checked={opts.fixGroundReferenceDynamicRefNode}
                    disabled={!canRetarget || !opts.fixGroundReference}
                    onClick={onToggleFixGroundDynamic}
                />
                <RetargetToggle
                    label="Check hierarchy"
                    title="Babylon's `checkHierarchy`. Drops tracks whose source parent name doesn't match the target parent name — auto-handles the Jax weapon case (parented to Root on one rig, R_Hand on the other) by dropping the broken track so the bone falls back to bind."
                    checked={opts.dropMismatchedParents}
                    disabled={!canRetarget}
                    onClick={onToggleCheckHierarchy}
                />
                <RetargetToggle
                    label="Fix animations"
                    title="Babylon's `fixAnimations`. Cleans up orthogonal-quaternion data errors in consecutive keyframes (replaces second with first). Safe to leave on."
                    checked={opts.fixAnimations}
                    disabled={!canRetarget}
                    onClick={onToggleFixAnims}
                />
                <RetargetToggle
                    label="Lock bone lengths"
                    title="Keep every non-root bone at the TARGET rig's bind translation + scale, transferring only rotation. Fixes squished / stretched mesh (e.g. shoulders) when retargeting between two skins, because Babylon otherwise drags the target's bones to the source skin's proportions. Turn OFF only for clips that intentionally animate bone translation/scale (stretchy VFX, squash-and-stretch)."
                    checked={opts.lockBoneLengths}
                    disabled={!canRetarget}
                    onClick={onToggleLockBoneLengths}
                />
                <RetargetToggle
                    label="Strip root motion"
                    title="Post-pass after Babylon's retarget: zero the root bone's translation so locomotion clips (walk, dash) play in place."
                    checked={opts.stripRootMotion}
                    disabled={!canRetarget}
                    onClick={onToggleStripRoot}
                />
                <RetargetToggle
                    label="Mirror L / R"
                    title="Swap source L_*/R_* tracks to target's opposite-side bone via Babylon's mapNodeNames. Source's left-arm motion drives target's right arm."
                    checked={opts.mirror}
                    disabled={!canRetarget}
                    onClick={onToggleMirror}
                />
            </div>
            {!canRetarget && (
                <div className="anim-empty-block" style={{ padding: 0 }}>
                    <p>Load source + target rigs and a clip to enable retarget options.</p>
                </div>
            )}
            </section>

            <section className="anim-options-section">
            <div className="anim-options-section-head">Ground reference</div>
            <GroundRefRow
                label="Root node"
                title="Source bone treated as the locomotion root (typically 'Root' on League rigs). Used by Fix root position and Fix ground reference. Empty = auto-detect first bone without a parent."
                value={opts.rootNodeName}
                options={sourceJointNames}
                disabled={!canRetarget}
                emptyLabel="(auto)"
                onChange={(v) => scene?.setRetargetOptions({ rootNodeName: v })}
                onReset={() => scene?.setRetargetOptions({ rootNodeName: '' })}
                canReset={opts.rootNodeName !== ''}
            />
            <GroundRefRow
                label="Ground ref"
                title="Source bone treated as the ground contact (typically L_Foot or R_Foot). Required for Fix root position and Fix ground reference."
                value={opts.groundReferenceNodeName}
                options={sourceJointNames}
                disabled={!canRetarget}
                emptyLabel="(none)"
                onChange={(v) => scene?.setRetargetOptions({ groundReferenceNodeName: v })}
                onReset={() => scene?.setRetargetOptions({ groundReferenceNodeName: '' })}
                canReset={opts.groundReferenceNodeName !== ''}
            />
            <div className="anim-options-form-row">
                <span className="studio-field-label">Vertical axis</span>
                <BoneDropdown
                    value={
                        opts.groundReferenceVerticalAxis === 'X' ? 0
                        : opts.groundReferenceVerticalAxis === 'Y' ? 1
                        : opts.groundReferenceVerticalAxis === 'Z' ? 2
                        : null
                    }
                    options={[
                        { hash: 0, name: 'X' },
                        { hash: 1, name: 'Y' },
                        { hash: 2, name: 'Z' },
                    ]}
                    emptyLabel="(auto)"
                    placeholder="(auto)"
                    disabled={!canRetarget}
                    title="Which world axis is 'up' in the source animation. Empty = auto-detect from root-to-ground vector."
                    onChange={(hash) => scene?.setRetargetOptions({
                        groundReferenceVerticalAxis: hash === 0 ? 'X' : hash === 1 ? 'Y' : hash === 2 ? 'Z' : '',
                    })}
                />
                <button
                    onClick={() => scene?.setRetargetOptions({ groundReferenceVerticalAxis: '' })}
                    disabled={!canRetarget || opts.groundReferenceVerticalAxis === ''}
                    title="Reset to auto"
                    className="anim-reset-btn"
                ><ResetIcon size={12} /></button>
            </div>
            </section>

            <section className="anim-options-section">
            <div className="anim-options-section-head">Vertical offset</div>
            <label className="anim-options-form-row anim-options-form-row--wide">
                <span className="studio-field-label">Offset (Y)</span>
                <input
                    type="number"
                    step="0.5"
                    value={opts.verticalOffset ?? 0}
                    onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        scene?.setRetargetOptions({ verticalOffset: Number.isFinite(v) ? v : 0 });
                    }}
                    disabled={!canRetarget}
                    className="mop-input"
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                    title="Lift the entire model along the world Y axis."
                />
                <button
                    onClick={() => scene?.setRetargetOptions({ verticalOffset: 0 })}
                    disabled={!canRetarget || (opts.verticalOffset ?? 0) === 0}
                    title="Reset to 0"
                    className="anim-reset-btn"
                ><ResetIcon size={12} /></button>
            </label>
            {targetMeshNames.length > 0 && (
                <div style={meshListWrapStyle} className="anim-options-mesh-list">
                    <div style={meshListHeaderStyle}>
                        Apply offset to:
                    </div>
                    <div style={meshListStyle}>
                        {targetMeshNames.map(name => {
                            const included = !excludedSet.has(name);
                            return (
                                <label key={name} style={meshItemStyle} title={name}>
                                    <input
                                        type="checkbox"
                                        checked={included}
                                        onChange={() => toggleMeshExclusion(name)}
                                        disabled={!canRetarget}
                                    />
                                    <span style={{
                                        flex: '1 1 auto',
                                        minWidth: 0,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        opacity: included ? 1 : 0.55,
                                    }}>
                                        {name}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                </div>
            )}
            </section>

            </div>
            </div>
        </div>
    );
}

function fileNameOf(p: string | null): string {
    return p?.split(/[\\/]/).pop() ?? '';
}

function SideEditor({ label, path, onPick, onClear, onReload, onSwap, swapDisabled }: {
    label: string;
    path: string | null;
    onPick: () => void;
    onClear: () => void;
    onReload: () => void;
    onSwap: () => void;
    swapDisabled: boolean;
}) {
    return (
        <div className="anim-side-editor" style={sideEditorStyle}>
            <div style={sideHeadStyle}>
                <span style={sideLabelStyle}>{label}</span>
                <button
                    onClick={onSwap}
                    disabled={swapDisabled}
                    title="Swap source and target rigs"
                    className="anim-mini-btn"
                >
                    <SwapIcon size={12} />
                </button>
            </div>
            <div style={sidePathRowStyle}>
                <div
                    style={sidePathStyle}
                    title={path ?? `Pick a ${label.toLowerCase()} rig`}
                >
                    {path
                        ? fileNameOf(path)
                        : <em style={{ opacity: 0.55 }}>empty</em>
                    }
                </div>
                <button onClick={onPick} title="Pick a rig from disk" className="anim-mini-btn">
                    <FolderOpenIcon size={12} />
                </button>
                <button
                    onClick={onReload}
                    disabled={!path}
                    title="Reload this rig from disk — picks up SKN / .bin / texture edits (e.g. from Maya)"
                    className="anim-mini-btn"
                >
                    <RefreshIcon size={12} />
                </button>
                <button
                    onClick={onClear}
                    disabled={!path}
                    title="Clear"
                    className="anim-mini-btn"
                >
                    <RemoveIcon size={12} />
                </button>
            </div>
        </div>
    );
}

/** Ground-reference dropdown row: label + fixed-width BoneDropdown +
 *  reset button. Three rows of these stack at uniform width so the
 *  dropdowns don't size off their content (e.g. "L_Foot" vs "Root"
 *  used to render at different widths). */
function GroundRefRow({ label, title, value, options, disabled, emptyLabel, onChange, onReset, canReset }: {
    label: string;
    title: string;
    value: string;
    options: string[];
    disabled: boolean;
    emptyLabel: string;
    onChange: (v: string) => void;
    onReset: () => void;
    canReset: boolean;
}) {
    const dropdownOptions = options.map((name, i) => ({ hash: i, name }));
    const selectedHash = value ? options.indexOf(value) : -1;
    return (
        <div className="anim-options-form-row" title={title}>
            <span className="studio-field-label">{label}</span>
            <BoneDropdown
                value={selectedHash >= 0 ? selectedHash : null}
                options={dropdownOptions}
                emptyLabel={emptyLabel}
                placeholder={emptyLabel}
                disabled={disabled}
                onChange={(hash) => onChange(hash === null ? '' : options[hash] ?? '')}
            />
            <button
                onClick={onReset}
                disabled={disabled || !canReset}
                title="Reset"
                className="anim-reset-btn"
            ><ResetIcon size={12} /></button>
        </div>
    );
}

function RetargetToggle({ label, title, checked, disabled, onClick }: {
    label: string;
    title: string;
    checked: boolean;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            className={`anim-chip${checked ? ' active' : ''}`}
            style={{
                // Override default button centering so the checkbox
                // sits at the left edge and the text flows from
                // there — looks consistent across rows since labels
                // have different lengths.
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: 7,
                padding: '4px 10px',
                fontSize: 11,
                textAlign: 'left',
            }}
        >
            <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 12,
                height: 12,
                flexShrink: 0,
                background: checked ? 'var(--jade-accent, #007acc)' : 'transparent',
                border: '1px solid currentColor',
                borderRadius: 2,
                color: checked ? '#fff' : 'currentColor',
            }}>{checked ? <CheckIcon size={9} strokeWidth={3} /> : null}</span>
            <span style={{ flex: '1 1 auto', minWidth: 0 }}>{label}</span>
        </button>
    );
}

// ── Styles ────────────────────────────────────────────────────────

const sideEditorStyle: React.CSSProperties = {
    flex: '1 1 200px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 8,
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid var(--border-color, #3e3e42)',
    borderRadius: 'var(--border-radius, 4px)',
};

const sideHeadStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    minHeight: 22,
};

const sideLabelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-secondary, #9DA5B4)',
    textTransform: 'uppercase',
    letterSpacing: 0.05,
};

const sidePathRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
};

const sidePathStyle: React.CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: 11,
    color: 'var(--text-color, #d4d4d4)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
};

const togglesRowStyle: React.CSSProperties = {
    // Grid (not flex-wrap) so every chip is the same width on a row
    // and the last row doesn't leave a half-empty gap. `auto-fit`
    // packs as many ~140px columns as the panel can fit.
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 6,
};

const meshListWrapStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '6px 8px',
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid var(--border-color, #3e3e42)',
    borderRadius: 'var(--border-radius, 4px)',
};

const meshListHeaderStyle: React.CSSProperties = {
    fontSize: 10,
    color: 'var(--text-secondary, #9DA5B4)',
    textTransform: 'uppercase',
    letterSpacing: 0.05,
    fontWeight: 600,
};

const meshListStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 160,
    overflowY: 'auto',
    gap: 1,
};

const meshItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: 'var(--text-color, #d4d4d4)',
    cursor: 'pointer',
    padding: '1px 3px',
    minWidth: 0,
};

