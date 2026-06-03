/**
 * Animation Studio — Bone Rig picker panel (Phase 5).
 *
 * Two small Babylon mini-viewports stacked side-by-side, each
 * rendering only its rig's joints in bind pose. Joint spheres are
 * colour-coded by mapping status and click-pickable: click a source
 * joint to "arm" it (outlined cyan), click a target joint to commit
 * the mapping. Filter chips at the top hide the bones the user
 * doesn't care about for retargeting (buffbones, FX helpers, etc.).
 *
 * The rigs render their bind pose ONLY — never the animated pose.
 * Picking on a swinging skeleton is frustrating (joints flying past
 * the cursor); bind pose keeps the joint cloud stable so clicks
 * land on the right bone every time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle as CircleIcon, Link as LinkIcon, Link2Off as UnlinkIcon } from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import { createBoneRigScene, type BoneRigScene, type BoneRigStatus } from '../lib/babylon/boneRigScene';
import {
    type AnimStudioScene,
    type MappingRow,
} from '../lib/babylon/animStudioScene';
import type { SklJointDTO } from '../lib/babylon/skeletonBuilder';
import './StudioPanels.css';

interface AnimStudioRigPanelProps {
    animStudioTabId: string;
}

interface Filters {
    hideBuffbones: boolean;
    hideFx: boolean;
    hideCloak: boolean;
    showAll: boolean; // master override — bypasses every hide
    query: string;
}

const DEFAULT_FILTERS: Filters = {
    hideBuffbones: true,
    hideFx: true,
    hideCloak: false,
    showAll: false,
    query: '',
};

const FILTERS_STORAGE = 'anim-studio-rig-filters';
const CAMERA_LINK_STORAGE = 'anim-studio-rig-camera-link';

export default function AnimStudioRigPanel({ animStudioTabId }: AnimStudioRigPanelProps) {
    const s = useShell();
    const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const targetCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const sourceSceneRef = useRef<BoneRigScene | null>(null);
    const targetSceneRef = useRef<BoneRigScene | null>(null);

    // Trigger re-renders when the parent scene's mapping / rigs
    // change so we can pull fresh rows + rebuild the rig viewports.
    const [tick, setTick] = useState(0);
    const scene: AnimStudioScene | null = s.getAnimStudioScene(animStudioTabId);
    useEffect(() => {
        if (!scene) {
            const t = setTimeout(() => setTick(n => n + 1), 80);
            return () => clearTimeout(t);
        }
        return scene.onChange(() => setTick(n => n + 1));
    }, [animStudioTabId, scene]);
    const sourceInfo = scene?.getSide('source') ?? { object: null };
    const targetInfo = scene?.getSide('target') ?? { object: null };
    const sourceJoints = sourceInfo.object?.skn?.joints ?? null;
    const targetJoints = targetInfo.object?.skn?.joints ?? null;

    // Pull bone mapping rows so we can build per-joint status maps
    // for the colour-coded spheres.
    const rows = useMemo<MappingRow[]>(
        () => scene?.getBoneMappingRows() ?? [],
        [scene, tick],
    );
    const sourceStatus = useMemo(() => {
        const m = new Map<number, BoneRigStatus>();
        for (const r of rows) m.set(r.sourceHash, r.status);
        return m;
    }, [rows]);
    const targetStatus = useMemo(() => {
        // The target rig's joints don't have a 1:1 status — each
        // target slot is "claimed" if any source row maps to it. We
        // colour each target sphere by the status of whichever
        // source row currently points at it (override beats fuzzy
        // beats exact for visual priority).
        const claimedBy = new Map<number, BoneRigStatus>();
        const RANK: Record<BoneRigStatus, number> = {
            override: 4, exact: 3, fuzzy: 2, ignored: 1, unmapped: 0,
        };
        for (const r of rows) {
            if (r.targetHash === null) continue;
            const existing = claimedBy.get(r.targetHash);
            if (!existing || RANK[r.status] > RANK[existing]) {
                claimedBy.set(r.targetHash, r.status);
            }
        }
        return claimedBy;
    }, [rows]);

    // ── Filters (persisted) ────────────────────────────────────────
    const [filters, setFilters] = useState<Filters>(() => {
        try {
            const raw = window.localStorage.getItem(FILTERS_STORAGE);
            if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) } as Filters;
        } catch { /* ignore */ }
        return DEFAULT_FILTERS;
    });
    useEffect(() => {
        try { window.localStorage.setItem(FILTERS_STORAGE, JSON.stringify(filters)); }
        catch { /* ignore */ }
    }, [filters]);

    const visibilityPredicate = useCallback(
        (joint: SklJointDTO): boolean => {
            if (filters.showAll) {
                // Search still filters even with show-all, so the
                // user can use show-all as "see all bones" while
                // typing in the search box.
                if (filters.query.trim()) {
                    return joint.name.toLowerCase().includes(filters.query.trim().toLowerCase());
                }
                return true;
            }
            const name = joint.name.toLowerCase();
            // Match ANY occurrence of "buffbone" / "bfb_" anywhere in
            // the name — Riot mixes prefixes, suffixes, and embeds
            // it mid-name on custom rigs, so substring is the only
            // catch-all that actually catches everything.
            if (filters.hideBuffbones && (name.includes('buffbone') || name.includes('bfb_'))) {
                return false;
            }
            if (filters.hideFx && (name.includes('_fx_') || name.includes('_effects_') || name.includes('_helper_') || name.includes('_locator') || name.endsWith('_socket'))) {
                return false;
            }
            if (filters.hideCloak && (name.includes('_cloak_') || name.includes('_cape_') || name.includes('_skirt_'))) {
                return false;
            }
            if (filters.query.trim()) {
                return name.includes(filters.query.trim().toLowerCase());
            }
            return true;
        },
        [filters],
    );

    // ── Camera link (persisted) ────────────────────────────────────
    const [cameraLink, setCameraLink] = useState<boolean>(() => {
        try { return window.localStorage.getItem(CAMERA_LINK_STORAGE) !== '0'; }
        catch { return true; }
    });
    useEffect(() => {
        try { window.localStorage.setItem(CAMERA_LINK_STORAGE, cameraLink ? '1' : '0'); }
        catch { /* ignore */ }
    }, [cameraLink]);

    // ── Two-click mapping state ────────────────────────────────────
    const [armedSource, setArmedSource] = useState<number | null>(null);
    const armedSourceRef = useRef<number | null>(null);
    armedSourceRef.current = armedSource;

    // ── Build the two scenes once + tear down on unmount ──────────
    useEffect(() => {
        const sCanvas = sourceCanvasRef.current;
        const tCanvas = targetCanvasRef.current;
        if (!sCanvas || !tCanvas) return;
        const sSc = createBoneRigScene(sCanvas);
        const tSc = createBoneRigScene(tCanvas);
        sourceSceneRef.current = sSc;
        targetSceneRef.current = tSc;

        // Source click: arm that joint.
        const offSrcClick = sSc.onClickJoint((hash) => {
            // Re-click on the same source bone clears it.
            if (armedSourceRef.current === hash) {
                setArmedSource(null);
                return;
            }
            setArmedSource(hash);
        });
        // Target click: commit the mapping (only meaningful when
        // a source is armed). Otherwise no-op.
        const offTgtClick = tSc.onClickJoint((hash) => {
            const armed = armedSourceRef.current;
            const sc = s.getAnimStudioScene(animStudioTabId);
            if (armed === null || !sc) return;
            sc.setBoneOverride(armed, hash);
            // Reset armed state — user can either pick the next
            // pair or do something else.
            setArmedSource(null);
        });

        return () => {
            offSrcClick();
            offTgtClick();
            sourceSceneRef.current = null;
            targetSceneRef.current = null;
            sSc.dispose();
            tSc.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [animStudioTabId]);

    // ── Camera link wiring ────────────────────────────────────────
    useEffect(() => {
        const sSc = sourceSceneRef.current;
        const tSc = targetSceneRef.current;
        if (!sSc || !tSc) return;
        if (!cameraLink) return;
        const offSrc = sSc.onCameraChange(() => {
            tSc.setCameraState(sSc.getCameraState());
        });
        const offTgt = tSc.onCameraChange(() => {
            sSc.setCameraState(tSc.getCameraState());
        });
        return () => {
            offSrc();
            offTgt();
        };
    }, [cameraLink, tick === 0]);

    // ── Rebuild rigs when joints / status / filters change ────────
    useEffect(() => {
        const sSc = sourceSceneRef.current;
        if (!sSc) return;
        sSc.rebuild(sourceJoints ?? [], sourceStatus, visibilityPredicate);
        sSc.frame();
    }, [sourceJoints, sourceStatus, visibilityPredicate]);
    useEffect(() => {
        const tSc = targetSceneRef.current;
        if (!tSc) return;
        tSc.rebuild(targetJoints ?? [], targetStatus, visibilityPredicate);
        tSc.frame();
    }, [targetJoints, targetStatus, visibilityPredicate]);

    // ── Armed-state mirroring into the source scene ───────────────
    useEffect(() => {
        const sSc = sourceSceneRef.current;
        if (!sSc) return;
        sSc.setArmed(armedSource);
    }, [armedSource, tick]);

    // ── Bone counts for the filter UI ─────────────────────────────
    const counts = useMemo(() => {
        const total = (sourceJoints?.length ?? 0) + (targetJoints?.length ?? 0);
        let visible = 0;
        for (const j of sourceJoints ?? []) if (visibilityPredicate(j)) visible++;
        for (const j of targetJoints ?? []) if (visibilityPredicate(j)) visible++;
        return { total, visible };
    }, [sourceJoints, targetJoints, visibilityPredicate]);

    // Resolve armed source name for the status footer.
    const armedName = useMemo(() => {
        if (armedSource === null || !sourceJoints) return null;
        const j = sourceJoints.find(j => j.name_hash === armedSource);
        return j?.name ?? null;
    }, [armedSource, sourceJoints]);

    const onResetArmed = () => setArmedSource(null);

    // ── Render ────────────────────────────────────────────────────
    if (!scene) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
                <div className="mop-content">
                    <div className="anim-empty">Animation Studio scene initialising…</div>
                </div>
            </div>
        );
    }
    if (!sourceJoints || !targetJoints) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
                <div className="mop-content">
                    <div className="anim-empty">Load source + target rigs to use the bone picker.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
            <div className="mop-content">
            <div className="anim-filter-row">
                <FilterChip
                    label="Hide buffbones"
                    active={filters.hideBuffbones && !filters.showAll}
                    disabled={filters.showAll}
                    onClick={() => setFilters(f => ({ ...f, hideBuffbones: !f.hideBuffbones }))}
                />
                <FilterChip
                    label="Hide FX"
                    active={filters.hideFx && !filters.showAll}
                    disabled={filters.showAll}
                    onClick={() => setFilters(f => ({ ...f, hideFx: !f.hideFx }))}
                />
                <FilterChip
                    label="Hide cloak"
                    active={filters.hideCloak && !filters.showAll}
                    disabled={filters.showAll}
                    onClick={() => setFilters(f => ({ ...f, hideCloak: !f.hideCloak }))}
                />
                <FilterChip
                    label="Show all"
                    active={filters.showAll}
                    onClick={() => setFilters(f => ({ ...f, showAll: !f.showAll }))}
                />
                <input
                    type="text"
                    placeholder="search bones…"
                    value={filters.query}
                    onChange={(e) => setFilters(f => ({ ...f, query: e.target.value }))}
                    className="anim-search"
                />
                <span className="anim-count-chip">
                    {counts.visible} / {counts.total}
                </span>
                <button
                    type="button"
                    onClick={() => setCameraLink(v => !v)}
                    className={`anim-chip${cameraLink ? ' active' : ''}`}
                    title={cameraLink ? 'Cameras linked — click to unlink' : 'Cameras independent — click to link'}
                >
                    {cameraLink
                        ? <LinkIcon size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        : <UnlinkIcon size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />}
                    Link cams
                </button>
            </div>

            <div className="anim-vp-row">
                <div className="anim-vp-col">
                    <div className="anim-vp-label">Source</div>
                    <canvas ref={sourceCanvasRef} className="anim-vp-canvas" />
                </div>
                <div className="anim-vp-divider" />
                <div className="anim-vp-col">
                    <div className="anim-vp-label">Target</div>
                    <canvas ref={targetCanvasRef} className="anim-vp-canvas" />
                </div>
            </div>

            <div className="anim-footer">
                {armedSource !== null ? (
                    <>
                        <span className="anim-footer-armed">
                            <CircleIcon size={8} fill="currentColor" style={{ verticalAlign: 'middle', marginRight: 4 }} />
                            armed:
                        </span>
                        <span>{armedName ?? '?'}</span>
                        <span className="anim-footer-hint">→ click a target joint to map</span>
                        <button onClick={onResetArmed} className="anim-reset-btn" style={{ marginLeft: 'auto' }}>Clear</button>
                    </>
                ) : (
                    <span className="anim-footer-hint">
                        Click a source joint to arm it, then click the target it should map to.
                    </span>
                )}
            </div>
            </div>
        </div>
    );
}

// ── Subcomponents ─────────────────────────────────────────────────

function FilterChip({ label, active, disabled, onClick }: {
    label: string;
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`anim-chip${active ? ' active' : ''}`}
        >{label}</button>
    );
}
