/**
 * Bone Rig mini-viewport scene host.
 *
 * One scene per side (source + target). Renders only the SKL joints
 * in bind / A-pose — no skinned mesh, no materials, just:
 *   - wireframe parent→child lines between joints
 *   - one small sphere mesh per joint, colour-coded by mapping
 *     status, click-pickable for the two-click mapping flow
 *
 * The actual skinned models live in the main viewports; this widget
 * stays clean (no overlays on the playback) so the user can compare
 * joint topology side-by-side at a glance.
 *
 * Stays lightweight: a 200-bone rig is ~200 sphere draw calls plus
 * one line system, well under 1ms / frame on integrated graphics.
 * The two scenes are independent — no shared Babylon resources — so
 * disposing one doesn't strand the other.
 */

import '@babylonjs/core';

import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';

import { createEngine, isAppVisible } from './engine';
import type { SklJointDTO } from './skeletonBuilder';

/** Mapping status reused from the mapping-engine module so colours
 *  stay consistent with the table view. Mirrored here to avoid
 *  importing the whole boneMapping module into this Babylon code
 *  path. */
export type BoneRigStatus = 'exact' | 'fuzzy' | 'override' | 'ignored' | 'unmapped';

const STATUS_COLOURS: Record<BoneRigStatus, [number, number, number]> = {
    exact:    [0.247, 0.729, 0.314],   // #3fb950
    override: [0.345, 0.651, 1.0],     // #58a6ff
    fuzzy:    [0.831, 0.655, 0.173],   // #d4a72c
    unmapped: [0.973, 0.318, 0.286],   // #f85149
    ignored:  [0.545, 0.580, 0.620],   // #8b949e
};

const ARMED_COLOUR: [number, number, number] = [0.0, 0.85, 1.0]; // cyan

/** Predicate the React side passes in to hide bones. Returns `true`
 *  when the bone should be rendered. */
export type BoneVisibility = (joint: SklJointDTO) => boolean;

export interface BoneRigScene {
    engine: Engine;
    scene: Scene;
    camera: ArcRotateCamera;
    /** Replace the rig contents. Disposes the previous meshes and
     *  builds fresh ones from the supplied joints + visibility
     *  predicate + per-joint status map. Cheap to call — re-runs
     *  when the filter chips flip or the mapping status changes.
     *  Pass an empty joint array to clear. */
    rebuild: (
        joints: SklJointDTO[],
        statusByHash: Map<number, BoneRigStatus>,
        visible: BoneVisibility,
    ) => void;
    /** Mark one joint as "armed" (the first click in the two-click
     *  flow), highlighting it cyan. Pass `null` to clear. */
    setArmed: (hash: number | null) => void;
    /** Set the click handler. Receives the joint hash + a ref to the
     *  pointer event so the React side can do hit-test filtering
     *  (e.g. don't treat a drag as a click). */
    onClickJoint: (cb: (hash: number) => void) => () => void;
    /** Auto-frame the camera on the current bone cloud. Called once
     *  after `rebuild` lands data; React can call again on demand. */
    frame: () => void;
    /** Read the camera state for the camera-link feature. */
    getCameraState: () => { alpha: number; beta: number; radius: number; target: [number, number, number] };
    /** Write the camera state, no-op when the values match. Used by
     *  the link to keep both viewports in lockstep without firing a
     *  feedback loop. */
    setCameraState: (state: { alpha: number; beta: number; radius: number; target: [number, number, number] }) => void;
    /** Subscribe to camera changes so the parent can mirror state
     *  into the sibling viewport. */
    onCameraChange: (cb: () => void) => () => void;
    dispose: () => void;
}

const JOINT_TAG_PREFIX = 'rig-joint:';

export function createBoneRigScene(canvas: HTMLCanvasElement): BoneRigScene {
    const engine = createEngine(canvas);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.08, 1.0);

    const camera = new ArcRotateCamera(
        'rig-cam',
        Math.PI / 2 + Math.PI / 8,
        Math.PI / 2 - Math.PI / 8,
        20,
        Vector3.Zero(),
        scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 0.5;
    camera.upperRadiusLimit = 5000;
    camera.wheelDeltaPercentage = 0.05;
    camera.panningSensibility = 100;
    camera.lowerBetaLimit = 0.01;
    camera.upperBetaLimit = Math.PI - 0.01;

    // Soft hemi just to give the spheres a hint of shading — enough
    // depth cue to read the rig as 3D without the lit colours
    // distorting our status palette.
    const hemi = new HemisphericLight('rig-hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    hemi.groundColor = new Color3(0.3, 0.3, 0.35);

    // ── Per-status shared materials (one per status, not per joint).
    // Spheres switch materials when their status changes — cheap
    // since materials don't get GC'd until scene dispose.
    const materials: Record<BoneRigStatus, StandardMaterial> = {
        exact:    makeStatusMaterial(scene, 'exact'),
        override: makeStatusMaterial(scene, 'override'),
        fuzzy:    makeStatusMaterial(scene, 'fuzzy'),
        unmapped: makeStatusMaterial(scene, 'unmapped'),
        ignored:  makeStatusMaterial(scene, 'ignored'),
    };
    const armedMat = new StandardMaterial('rig-armed-mat', scene);
    armedMat.emissiveColor = new Color3(...ARMED_COLOUR);
    armedMat.disableLighting = true;

    // ── Live state owned by this scene host ────────────────────────
    let currentJoints: SklJointDTO[] = [];
    let currentStatus: Map<number, BoneRigStatus> = new Map();
    let currentVisibility: BoneVisibility = () => true;
    let armedHash: number | null = null;
    /** Live sphere meshes keyed by joint hash for fast status / armed
     *  updates without re-walking the joint array. */
    const sphereByHash = new Map<number, Mesh>();
    let linesMesh: LinesMesh | null = null;

    const clickListeners = new Set<(hash: number) => void>();
    const cameraListeners = new Set<() => void>();

    // Fire the click handlers via scene.onPointerObservable so we
    // get a proper PointerInfo (already filters out drag noise via
    // Babylon's internal threshold). Filter to POINTERTAP for "real"
    // clicks; POINTERPICK fires on drag-release too which would
    // misfire mapping every time the user orbits the camera.
    const onPointerObs = scene.onPointerObservable.add((info) => {
        // 32 = POINTERTAP. Avoid importing the enum just for one
        // constant — value is stable across Babylon versions.
        if (info.type !== 32) return;
        const picked = scene.pick(scene.pointerX, scene.pointerY);
        const name = picked?.pickedMesh?.name ?? '';
        if (!name.startsWith(JOINT_TAG_PREFIX)) return;
        const hash = Number.parseInt(name.slice(JOINT_TAG_PREFIX.length), 10);
        if (Number.isNaN(hash)) return;
        for (const cb of clickListeners) {
            try { cb(hash); } catch { /* ignore */ }
        }
    });

    // Camera change observer for the link feature. We compare
    // before/after the apply in `setCameraState` to avoid an
    // infinite feedback loop when both sides mirror each other.
    const onCameraObs = camera.onViewMatrixChangedObservable.add(() => {
        for (const cb of cameraListeners) {
            try { cb(); } catch { /* ignore */ }
        }
    });

    // Render loop. We tried render-on-demand here as a CPU
    // optimisation, but Babylon's input pipeline (ArcRotateCamera's
    // `_checkInputs`/`update`) only runs inside `scene.render()`,
    // so without a continuous loop the pointer events never
    // translate into camera movement and the rigs appear stuck on
    // the initial framing (or invisible if the camera lands inside
    // the model). For a small static viewport this isn't worth the
    // complexity of input-driven render scheduling.
    engine.runRenderLoop(() => {
        if (!isAppVisible()) return;
        scene.render();
    });
    const ro = new ResizeObserver(() => engine.resize());
    ro.observe(canvas);

    // ── Rebuild — disposes + recreates lines + spheres ────────────
    const rebuild = (
        joints: SklJointDTO[],
        statusByHash: Map<number, BoneRigStatus>,
        visible: BoneVisibility,
    ) => {
        currentJoints = joints;
        currentStatus = statusByHash;
        currentVisibility = visible;
        clearRigGeometry();

        if (joints.length === 0) return;

        // Build the set of visible joints first — we need it to
        // decide which parent→child links to draw and which spheres
        // to spawn. Hidden joints still let their children be
        // skipped by the line builder (avoids dangling segments
        // pointing at empty space).
        const visibleHashes = new Set<number>();
        for (const j of joints) {
            if (currentVisibility(j)) visibleHashes.add(j.name_hash);
        }

        // Lines: parent → joint, but only when BOTH ends are
        // visible. A hidden parent collapses the chain — we don't
        // attempt to skip past it to a visible grandparent (would
        // distort the topology read).
        const linePts: Vector3[][] = [];
        const lineColors: Color4[][] = [];
        const lineColor = new Color4(0.55, 0.65, 0.75, 1.0);
        for (const j of joints) {
            if (j.parent_id < 0) continue;
            const p = joints[j.parent_id];
            if (!p) continue;
            if (!visibleHashes.has(j.name_hash) || !visibleHashes.has(p.name_hash)) continue;
            linePts.push([
                new Vector3(...p.world_position),
                new Vector3(...j.world_position),
            ]);
            lineColors.push([lineColor, lineColor]);
        }
        if (linePts.length > 0) {
            linesMesh = CreateLineSystem(
                'rig-lines',
                { lines: linePts, colors: lineColors, useVertexAlpha: false, updatable: false },
                scene,
            );
            // Lines on top of spheres so the rig topology stays
            // readable when joints overlap.
            linesMesh.renderingGroupId = 1;
            linesMesh.isPickable = false;
        }

        // Spheres: one per VISIBLE joint. We use named meshes so
        // `scene.pick` can identify the joint by parsing the name.
        // Performance: ~200 sphere meshes per scene is fine.
        // Sphere radius scales with the rig's diagonal so big rigs
        // get bigger dots — keeps clickability consistent.
        const diag = rigDiagonal(joints);
        const radius = Math.max(0.25, diag * 0.008);
        for (const j of joints) {
            if (!visibleHashes.has(j.name_hash)) continue;
            const sphere = CreateSphere(
                `${JOINT_TAG_PREFIX}${j.name_hash}`,
                { diameter: radius * 2, segments: 8 },
                scene,
            );
            sphere.position.set(...j.world_position);
            const status = statusByHash.get(j.name_hash) ?? 'unmapped';
            sphere.material = (armedHash === j.name_hash) ? armedMat : materials[status];
            sphere.isPickable = true;
            sphereByHash.set(j.name_hash, sphere);
        }
    };

    const setArmed = (hash: number | null) => {
        if (armedHash === hash) return;
        // Revert the previously-armed sphere to its status colour.
        if (armedHash !== null) {
            const sphere = sphereByHash.get(armedHash);
            if (sphere) {
                const st = currentStatus.get(armedHash) ?? 'unmapped';
                sphere.material = materials[st];
            }
        }
        armedHash = hash;
        if (hash !== null) {
            const sphere = sphereByHash.get(hash);
            if (sphere) sphere.material = armedMat;
        }
    };

    const onClickJoint = (cb: (hash: number) => void) => {
        clickListeners.add(cb);
        return () => { clickListeners.delete(cb); };
    };

    const frame = () => {
        if (currentJoints.length === 0) {
            camera.setTarget(Vector3.Zero());
            camera.radius = 20;
            return;
        }
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const j of currentJoints) {
            const [x, y, z] = j.world_position;
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
        }
        if (!isFinite(minX)) {
            camera.setTarget(Vector3.Zero());
            camera.radius = 20;
            return;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const cz = (minZ + maxZ) / 2;
        const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
        camera.setTarget(new Vector3(cx, cy, cz));
        camera.radius = Math.max(5, span * 1.6);
    };

    const getCameraState = () => ({
        alpha: camera.alpha,
        beta: camera.beta,
        radius: camera.radius,
        target: [camera.target.x, camera.target.y, camera.target.z] as [number, number, number],
    });

    const setCameraState = (state: { alpha: number; beta: number; radius: number; target: [number, number, number] }) => {
        const EPS = 1e-4;
        const targetChanged = Math.abs(camera.target.x - state.target[0]) > EPS
            || Math.abs(camera.target.y - state.target[1]) > EPS
            || Math.abs(camera.target.z - state.target[2]) > EPS;
        const angleChanged = Math.abs(camera.alpha - state.alpha) > EPS
            || Math.abs(camera.beta - state.beta) > EPS
            || Math.abs(camera.radius - state.radius) > EPS;
        if (!targetChanged && !angleChanged) return;
        // Skip the observer for the duration of this apply — the
        // parent already knows about the change, no point bouncing
        // it back to the sibling. We use a guard flag because
        // observable.remove() in the middle of the firing cycle is
        // racy.
        suspendCameraEvents = true;
        try {
            if (targetChanged) camera.setTarget(new Vector3(...state.target));
            camera.alpha = state.alpha;
            camera.beta = state.beta;
            camera.radius = state.radius;
        } finally {
            // Defer re-enabling until after the current event tick
            // so any cascading observers from this write don't fire
            // the listeners we just guarded out.
            queueMicrotask(() => { suspendCameraEvents = false; });
        }
    };

    let suspendCameraEvents = false;
    const onCameraChange = (cb: () => void) => {
        const wrapped = () => { if (!suspendCameraEvents) cb(); };
        cameraListeners.add(wrapped);
        return () => { cameraListeners.delete(wrapped); };
    };

    const clearRigGeometry = () => {
        for (const s of sphereByHash.values()) {
            try { s.dispose(); } catch { /* ignore */ }
        }
        sphereByHash.clear();
        if (linesMesh) {
            try { linesMesh.dispose(); } catch { /* ignore */ }
            linesMesh = null;
        }
    };

    const dispose = () => {
        scene.onPointerObservable.remove(onPointerObs);
        camera.onViewMatrixChangedObservable.remove(onCameraObs);
        clickListeners.clear();
        cameraListeners.clear();
        clearRigGeometry();
        try { ro.disconnect(); } catch { /* ignore */ }
        try { scene.dispose(); } catch { /* ignore */ }
        try { engine.dispose(); } catch { /* ignore */ }
    };

    return {
        engine,
        scene,
        camera,
        rebuild,
        setArmed,
        onClickJoint,
        frame,
        getCameraState,
        setCameraState,
        onCameraChange,
        dispose,
    };
}

// ── Helpers ────────────────────────────────────────────────────────

function makeStatusMaterial(scene: Scene, status: BoneRigStatus): StandardMaterial {
    const mat = new StandardMaterial(`rig-mat-${status}`, scene);
    const [r, g, b] = STATUS_COLOURS[status];
    mat.emissiveColor = new Color3(r, g, b);
    // Disable scene lighting so the colour reads as exactly the
    // status palette — important for the user reading status across
    // tens of joints at once.
    mat.disableLighting = true;
    return mat;
}

function rigDiagonal(joints: SklJointDTO[]): number {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const j of joints) {
        const [x, y, z] = j.world_position;
        if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
        if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (Number.isFinite(z)) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
    }
    if (!isFinite(minX)) return 100;
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
