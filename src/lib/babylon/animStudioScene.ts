/**
 * Animation Studio scene host — two Babylon viewports side by side.
 *
 * Sibling of Photo Studio's `StudioScene`. The two intentionally
 * don't share a base class: their lifecycles and panel needs diverge
 * fast (Photo Studio has shadow / glow / capture; Animation Studio
 * needs paired engines, a shared scrubber, bone-mapping state).
 * Keeping them separate is cheaper than hoisting common bits into a
 * shape that fits neither cleanly.
 *
 * Phase 2 adds naive retargeting: a single source clip (ANM) is
 * loaded once and an `AnimationPlayer` is built on each side. The
 * source player resolves tracks against the source skeleton (= the
 * clip's native rig), the target player resolves the SAME DTO
 * against the target skeleton — which auto-skips tracks whose
 * `joint_hash` isn't in the target's `boneIndexByHash`. Bones whose
 * names match across champs (Root, Spine, L_Hand, etc.) drive the
 * target correctly without any rescaling / rebasing. Bones with no
 * match stay at rest. Phase 3 layers translation rescale + rotation
 * rebase on top.
 *
 * Both players are kept in `paused = true` mode and share a
 * scene-owned clock — the React scrubber writes `playerTime`, the
 * scene's per-frame observer copies that into both players and
 * calls `tick(0)` so the pose lands. Means a single timeline drives
 * both viewports with zero drift.
 */

import '@babylonjs/core';
import '@babylonjs/materials';

import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial';
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Observer } from '@babylonjs/core/Misc/observable';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Quaternion as BabylonQuaternion, Vector3 as BabylonVector3 } from '@babylonjs/core/Maths/math';
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager';
// Havok offline-bake imports. Granular paths keep tree-shaking happy;
// the WASM itself is dynamically imported in `loadFreshHavok()` so it
// only downloads when a chain actually uses the Havok solver.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody';
import { PhysicsShapeSphere } from '@babylonjs/core/Physics/v2/physicsShape';
import { Physics6DoFConstraint } from '@babylonjs/core/Physics/v2/physicsConstraint';
import { PhysicsMotionType, PhysicsConstraintAxis, PhysicsConstraintAxisLimitMode, PhysicsActivationControl } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import '@babylonjs/core/Physics/v2/physicsEngineComponent';
import { EngineStore } from '@babylonjs/core/Engines/engineStore';

import { createEngine, isAppVisible } from './engine';
import { createSknObject, type StudioObject } from './studioObject';
import { AnimationPlayer, type BakedAnimationDTO } from './animationPlayer';
import { loadDiskAnimation } from './studioLoad';
import {
    DEFAULT_RETARGET_OPTIONS,
    type RetargetOptions,
    type BoneGuide,
    type PhysicsChain,
    type PhysicsCollider,
} from '../animation/retarget';
import { retargetViaBabylon } from '../animation/babylonRetarget';
import {
    type MeshColliderBind,
    type SkinnedCollider,
    makeSkinnedCollider,
    updateSkinnedCollider,
    pushOutOfMesh,
} from './meshCollisionSolver';
import {
    autoMapBones,
    applyOverrides,
    buildMappingRows,
    type BoneMapping,
    type MappingEntry,
    type MappingRow,
} from '../animation/boneMapping';

export type AnimStudioSide = 'source' | 'target';

/** Editing mode for the studio.
 *   - `retarget`: the classic two-viewport flow — retarget a clip from
 *     the source rig onto the target rig (physics optional on top).
 *   - `physics`: a single-viewport flow — load one rig + one clip and
 *     bake physics onto it directly, no retargeting. The single rig
 *     lives on the `source` side. */
export type AnimStudioMode = 'retarget' | 'physics';

/** Maya-style mesh-collision configuration. */
export interface MeshCollisionConfig {
    /** Collide physics chains against the rig's skinned mesh. */
    enabled: boolean;
    /** Collision shell radius (world units) — how far chain bones stay off
     *  the mesh surface. Maya's "thickness". */
    thickness: number;
    /** Submesh names to EXCLUDE from the collider — always exclude the
     *  dynamic mesh itself (the hair/cape) so it doesn't collide with its
     *  own bind-pose surface. */
    excludedMeshes: string[];
}

/** `.animstudio.json` schema. Versioned so future format changes
 *  can be back-compat'd via a switch on `version`. */
export interface AnimStudioSceneData {
    version: 1;
    /** Active editing mode. Optional for back-compat with scene files
     *  written before the mode switch existed (default `retarget`). */
    mode?: AnimStudioMode;
    sourceSknPath: string | null;
    targetSknPath: string | null;
    sourceClipPath: string | null;
    retargetOptions: RetargetOptions;
    /** Source-bone-hash → target-hash | 'ignore'. Maps with non-
     *  primitive values don't round-trip through JSON, so we
     *  serialise as `[hash, entry][]` (entry is number | -1 for
     *  IGNORED — chosen because real hashes are positive 32-bit
     *  values so -1 is safely unambiguous). */
    boneOverrides: Array<[number, number]>;
    /** A/B scrubber target offset in seconds. */
    targetOffset: number;
    /** Per-bone guides (rigid + XYZ offset). Optional for back-
     *  compat with older scene files that predate the guides
     *  feature. */
    guides?: BoneGuide[];
    /** Spring-chain physics rigs (cape / tail / hair). Optional for
     *  back-compat with scene files predating the physics feature. */
    physicsChains?: PhysicsChain[];
    /** Sphere colliders preventing chain particles from clipping
     *  through body bones. */
    physicsColliders?: PhysicsCollider[];
    /** Maya-style mesh-collision config. Optional for back-compat. */
    meshCollision?: MeshCollisionConfig;
}

const IGNORED_SERIALISED = -1;

// Re-export so consumers can import RetargetOptions from the scene
// module — they're conceptually a scene concern even though the
// pure transform lives in `../animation/retarget`.
export type { RetargetOptions };
export type { BoneGuide };
export type { PhysicsChain, PhysicsCollider };
export type { MappingRow, MappingEntry } from '../animation/boneMapping';
export { IGNORED } from '../animation/boneMapping';

// ── Guide application helper ─────────────────────────────────────

type Quat = [number, number, number, number]; // x, y, z, w
type Vec3 = [number, number, number];

/**
 * Apply per-bone guides on top of a retargeted DTO. Each guide
 * forces its target bone to ride a "follow" bone (defaulting to
 * the bone's SKL parent) with a user-set XYZ offset.
 *
 * The math is world-space hierarchical: we walk the target rig
 * each frame, compose every bone's animated world TRS from the
 * DTO's local TRS chained through the parent, then convert the
 * desired world pose for each guided bone back into local against
 * its actual SKL parent so the player applies it normally.
 *
 * Costs O(frames × joints) per call. Runs once per retarget
 * recompute, not per render frame, so it's cheap in practice.
 */
function applyGuidesWorldSpace(
    dto: BakedAnimationDTO,
    joints: import('./skeletonBuilder').SklJointDTO[],
    guides: BoneGuide[],
): void {
    if (guides.length === 0) return;
    const guidedHashes = new Set(guides.map(g => g.targetBoneHash));
    const jointById = joints;
    const jointByHash = new Map<number, import('./skeletonBuilder').SklJointDTO>();
    for (const j of joints) jointByHash.set(j.name_hash, j);

    const trackByHash = new Map<number, BakedAnimationDTO['tracks'][number]>();
    for (const t of dto.tracks) trackByHash.set(t.joint_hash, t);

    // For each guided bone, ensure a track exists in the DTO so
    // we can write into it. Bones Babylon dropped (no track) need
    // a fresh one initialised to bind values; we'll overwrite
    // each frame anyway.
    for (const guide of guides) {
        if (trackByHash.has(guide.targetBoneHash)) continue;
        const bind = jointByHash.get(guide.targetBoneHash);
        if (!bind) continue;
        const frames = new Array(dto.frame_count);
        for (let i = 0; i < dto.frame_count; i++) {
            frames[i] = {
                translation: [...bind.local_translation] as Vec3,
                rotation: [...bind.local_rotation] as Quat,
                scale: [1, 1, 1] as Vec3,
            };
        }
        const t = { joint_hash: guide.targetBoneHash, frames };
        dto.tracks.push(t);
        trackByHash.set(guide.targetBoneHash, t);
    }

    // Per-frame world TRS scratch arrays. Sized once at frame_count
    // × joints; reused inside the loop.
    const worldRot: Quat[] = new Array(joints.length);
    const worldPos: Vec3[] = new Array(joints.length);

    for (let frame = 0; frame < dto.frame_count; frame++) {
        // Step 1: compose world TRS for every joint at this frame.
        for (let i = 0; i < jointById.length; i++) {
            const j = jointById[i];
            // Use the (post-guide-overwrite) track for this bone if
            // present, falling back to bind.
            const track = trackByHash.get(j.name_hash);
            let lr: Quat;
            let lt: Vec3;
            if (track && track.frames[frame]) {
                const f = track.frames[frame];
                lr = f.rotation as Quat;
                lt = f.translation as Vec3;
            } else {
                lr = j.local_rotation as Quat;
                lt = j.local_translation as Vec3;
            }
            if (j.parent_id < 0 || j.parent_id >= i) {
                worldRot[i] = [lr[0], lr[1], lr[2], lr[3]];
                worldPos[i] = [lt[0], lt[1], lt[2]];
            } else {
                const pr = worldRot[j.parent_id];
                const pp = worldPos[j.parent_id];
                worldRot[i] = quatMul(pr, lr);
                const rotated = quatRotateVec3(pr, lt);
                worldPos[i] = [pp[0] + rotated[0], pp[1] + rotated[1], pp[2] + rotated[2]];
            }
        }

        // Step 2: for each guide, compute desired world TRS using
        // the follow bone, then convert to local against the
        // bone's SKL parent. The order matters: process guides
        // AFTER step 1 used the existing (Babylon-retargeted)
        // tracks so the follow bone's world TRS reflects whatever
        // animation drives it. If a follow bone is also guided
        // and processed in this loop later, its earlier world
        // value is "stale" but the visible effect is usually fine
        // for the common case (weapon glued to a hand that is
        // itself ordinary-retargeted).
        for (const guide of guides) {
            const bone = jointByHash.get(guide.targetBoneHash);
            if (!bone) continue;
            // Determine follow bone — explicit guide.followBoneHash
            // overrides; otherwise use the SKL parent.
            const followHash = guide.followBoneHash ?? (
                bone.parent_id >= 0 && bone.parent_id < jointById.length
                    ? jointById[bone.parent_id].name_hash
                    : null
            );
            if (followHash === null) continue; // root bone with no follow target
            const followBone = jointByHash.get(followHash);
            if (!followBone) continue;
            const followIdx = jointById.findIndex(j => j.name_hash === followHash);
            if (followIdx < 0) continue;

            const followRot = worldRot[followIdx];
            const followPos = worldPos[followIdx];

            // World rotation = followBone.worldRot · bind.localRot · eulerOffset.
            //   The eulerOffset multiplies on the right so its
            //   axes are in the bone's own LOCAL frame after the
            //   bind orientation — intuitive for "spin around the
            //   bone's local Y by 90°" style tweaks.
            // World position = followBone.worldPos
            //                + followBone.worldRot · (bind.localTrans + offset).
            const bindLocalRot = bone.local_rotation as Quat;
            const bindLocalTrans = bone.local_translation as Vec3;
            const offsetTrans: Vec3 = [
                bindLocalTrans[0] + guide.offsetX,
                bindLocalTrans[1] + guide.offsetY,
                bindLocalTrans[2] + guide.offsetZ,
            ];
            let desiredWorldRot = quatMul(followRot, bindLocalRot);
            const hasRot = (guide.rotX ?? 0) !== 0
                || (guide.rotY ?? 0) !== 0
                || (guide.rotZ ?? 0) !== 0;
            if (hasRot) {
                const eulerQuat = eulerDegreesToQuat(
                    guide.rotX ?? 0,
                    guide.rotY ?? 0,
                    guide.rotZ ?? 0,
                );
                desiredWorldRot = quatMul(desiredWorldRot, eulerQuat);
            }
            const rotatedOffset = quatRotateVec3(followRot, offsetTrans);
            const desiredWorldPos: Vec3 = [
                followPos[0] + rotatedOffset[0],
                followPos[1] + rotatedOffset[1],
                followPos[2] + rotatedOffset[2],
            ];

            // Convert world TRS to local against the bone's SKL
            // parent. The runtime player composes per-bone via the
            // SKL parent chain, so the local we emit must produce
            // the right world when re-composed against that parent.
            let parentRot: Quat = IDENTITY_QUAT_LOCAL;
            let parentPos: Vec3 = ZERO_VEC_LOCAL;
            if (bone.parent_id >= 0 && bone.parent_id < jointById.length) {
                parentRot = worldRot[bone.parent_id];
                parentPos = worldPos[bone.parent_id];
            }
            const parentRotInv: Quat = [-parentRot[0], -parentRot[1], -parentRot[2], parentRot[3]];
            const localRot = quatMul(parentRotInv, desiredWorldRot);
            const dx = desiredWorldPos[0] - parentPos[0];
            const dy = desiredWorldPos[1] - parentPos[1];
            const dz = desiredWorldPos[2] - parentPos[2];
            const localTrans = quatRotateVec3(parentRotInv, [dx, dy, dz]);

            // Write back into the track + into the world arrays so
            // any later guide that uses this bone as a follow sees
            // the updated world position.
            const track = trackByHash.get(guide.targetBoneHash);
            if (track) {
                track.frames[frame] = {
                    translation: localTrans,
                    rotation: [localRot[0], localRot[1], localRot[2], localRot[3]],
                    scale: [1, 1, 1],
                };
            }
            const bidx = jointById.findIndex(j => j.name_hash === guide.targetBoneHash);
            if (bidx >= 0) {
                worldRot[bidx] = desiredWorldRot;
                worldPos[bidx] = desiredWorldPos;
            }
        }

        // Suppress unused-var warnings for guidedHashes; we keep
        // the set around for potential future debugging.
        void guidedHashes;
    }
}

const IDENTITY_QUAT_LOCAL: Quat = [0, 0, 0, 1];
const ZERO_VEC_LOCAL: Vec3 = [0, 0, 0];

/**
 * Bake a set of physics chains into the target DTO using a stable
 * Verlet + Position-Based-Dynamics (PBD) solver.
 *
 * The previous implementation used an explicit-Euler spring, which
 * blows up whenever `stiffness·dt` exceeds ~2 (i.e. at any usable
 * stiffness) and injects energy when damping is high — that was the
 * jitter/flailing. PBD replaces the spring with *geometric position
 * projection*, which is unconditionally stable at any parameter value:
 *
 *   Per substep (dt/SUBSTEPS):
 *     1. Verlet integrate each free particle:
 *          vel   = (pos - prevPos) · velRetain          (implicit damping)
 *          prev  = pos
 *          pos  += vel + gravity·dt²
 *     2. Pin the anchor (bone 0) to its animated world position.
 *     3. Iterate constraints (each is a pure position projection):
 *          - stiffness: ease every bone toward its RIGID rest pose
 *            (the shape it would have if rigidly parented to the
 *            anchor, in the anchor's animated orientation). This is
 *            both the "return to combed pose" spring and the follow-
 *            the-body behaviour, with no stability cost.
 *          - distance: clamp each segment to its bind length (soft
 *            when `lockLength` is off, so it can stretch a little).
 *          - collision: push particles out of sphere colliders.
 *
 * `inertia` lags the rest-pose orientation behind the true anchor so a
 * fast body swing drags the tail. `damping` maps to velRetain (1 =
 * bouncy free swing, 0 = dead). Gravity is scaled by mean segment
 * length so the drape looks the same on any rig size (g/L invariant).
 *
 * Once world positions settle per frame we synthesise each simulated
 * bone's LOCAL TRS the same way as before (look-at toward the next
 * bone; bind local translation), so playback + .anm export are
 * unchanged. We seed at the rigid bind pose and warm up at frame 0 so
 * recording starts from a settled hang, not mid-fall.
 */
function applyPhysicsChains(
    dto: BakedAnimationDTO,
    joints: import('./skeletonBuilder').SklJointDTO[],
    chains: import('../animation/retarget').PhysicsChain[],
    colliders: import('../animation/retarget').PhysicsCollider[],
    meshCol: SkinnedCollider | null = null,
): void {
    if (chains.length === 0) return;

    // Bind-pose world rot/pos per joint — needed to skin the mesh collider
    // each frame (M = animWorld · bindWorld⁻¹). Computed once.
    let bindRotArr: Quat[] | null = null;
    let bindPosArr: Vec3[] | null = null;
    if (meshCol) {
        bindRotArr = new Array(joints.length);
        bindPosArr = new Array(joints.length);
        for (let i = 0; i < joints.length; i++) {
            const j = joints[i];
            const lt = j.local_translation as Vec3;
            const lr = j.local_rotation as Quat;
            if (j.parent_id < 0 || j.parent_id >= i) {
                bindPosArr[i] = [lt[0], lt[1], lt[2]];
                bindRotArr[i] = [lr[0], lr[1], lr[2], lr[3]];
            } else {
                const pr = bindRotArr[j.parent_id];
                const pp = bindPosArr[j.parent_id];
                bindRotArr[i] = quatMul(pr, lr);
                const r = quatRotateVec3(pr, lt);
                bindPosArr[i] = [pp[0] + r[0], pp[1] + r[1], pp[2] + r[2]];
            }
        }
    }

    const jointByHash = new Map<number, import('./skeletonBuilder').SklJointDTO>();
    const idxByHash = new Map<number, number>();
    for (let i = 0; i < joints.length; i++) {
        jointByHash.set(joints[i].name_hash, joints[i]);
        idxByHash.set(joints[i].name_hash, i);
    }

    const trackByHash = new Map<number, BakedAnimationDTO['tracks'][number]>();
    for (const t of dto.tracks) trackByHash.set(t.joint_hash, t);

    // Ensure every simulated bone in any chain has a track we can
    // write into. Bones without a track (Babylon dropped them or
    // they were never animated) get a bind-pose stub.
    const ensureTrack = (hash: number) => {
        if (trackByHash.has(hash)) return trackByHash.get(hash)!;
        const bind = jointByHash.get(hash);
        if (!bind) return null;
        const frames = new Array(dto.frame_count);
        for (let i = 0; i < dto.frame_count; i++) {
            frames[i] = {
                translation: [...bind.local_translation] as Vec3,
                rotation: [...bind.local_rotation] as Quat,
                scale: [1, 1, 1] as Vec3,
            };
        }
        const t = { joint_hash: hash, frames };
        dto.tracks.push(t);
        trackByHash.set(hash, t);
        return t;
    };

    // Compose every joint's world TRS at frame f, honouring whatever
    // is in the DTO (so anchor bones and parent-driving bones are
    // already updated by Babylon's retarget pass).
    const composeWorld = (frame: number, outRot: Quat[], outPos: Vec3[]) => {
        for (let i = 0; i < joints.length; i++) {
            const j = joints[i];
            const track = trackByHash.get(j.name_hash);
            let lr: Quat, lt: Vec3;
            if (track && track.frames[frame]) {
                const fr = track.frames[frame];
                lr = fr.rotation as Quat;
                lt = fr.translation as Vec3;
            } else {
                lr = j.local_rotation as Quat;
                lt = j.local_translation as Vec3;
            }
            if (j.parent_id < 0 || j.parent_id >= i) {
                outRot[i] = [lr[0], lr[1], lr[2], lr[3]];
                outPos[i] = [lt[0], lt[1], lt[2]];
            } else {
                const pr = outRot[j.parent_id];
                const pp = outPos[j.parent_id];
                outRot[i] = quatMul(pr, lr);
                const rotated = quatRotateVec3(pr, lt);
                outPos[i] = [pp[0] + rotated[0], pp[1] + rotated[1], pp[2] + rotated[2]];
            }
        }
    };

    const fps = dto.fps && dto.fps > 0 ? dto.fps : 30;
    const dt = 1 / fps;

    // Pre-fetch each chain's bind data + initial particle state.
    interface SimChain {
        chain: import('../animation/retarget').PhysicsChain;
        boneIdxs: number[]; // joint indices
        restLen: number[];  // distance from previous bone in bind pose (index 0 unused)
        bindLocalT: Vec3[]; // per bone bind local translation
        bindLocalRot: Quat[]; // per bone bind local rotation (for the rigid rest pose)
        bindLocalDir: Vec3[]; // unit direction of bind local T per bone (defines "down the bone")
        bindLocalLen: number[]; // length of bind local T (== restLen[i] for i>0 typically)
        restDirAnchor: Vec3[]; // segment i's rest direction expressed in the anchor's frame
        meanSeg: number;     // average segment length — rig scale, for gravity scaling
        particlePos: Vec3[]; // current world pos per simulated bone
        particlePrev: Vec3[]; // previous world pos (Verlet — encodes velocity)
        lagRot: Quat | null; // inertia-lagged anchor rotation for the rest pose
    }
    const sims: SimChain[] = [];
    for (const chain of chains) {
        if (chain.boneHashes.length < 2) continue;
        const boneIdxs: number[] = [];
        let ok = true;
        for (const h of chain.boneHashes) {
            const idx = idxByHash.get(h);
            if (idx === undefined) { ok = false; break; }
            boneIdxs.push(idx);
        }
        if (!ok) continue;
        const restLen: number[] = new Array(boneIdxs.length);
        const bindLocalT: Vec3[] = new Array(boneIdxs.length);
        const bindLocalRot: Quat[] = new Array(boneIdxs.length);
        const bindLocalDir: Vec3[] = new Array(boneIdxs.length);
        const bindLocalLen: number[] = new Array(boneIdxs.length);
        for (let i = 0; i < boneIdxs.length; i++) {
            const j = joints[boneIdxs[i]];
            const lt = j.local_translation as Vec3;
            bindLocalT[i] = [lt[0], lt[1], lt[2]];
            const lr = j.local_rotation as Quat;
            bindLocalRot[i] = [lr[0], lr[1], lr[2], lr[3]];
            const len = Math.hypot(lt[0], lt[1], lt[2]);
            bindLocalLen[i] = len;
            bindLocalDir[i] = len > 1e-6
                ? [lt[0] / len, lt[1] / len, lt[2] / len]
                : [0, 1, 0];
            restLen[i] = i === 0 ? 0 : len;
        }
        let segSum = 0, segN = 0;
        for (let i = 1; i < restLen.length; i++) if (restLen[i] > 1e-4) { segSum += restLen[i]; segN++; }
        const meanSeg = segN > 0 ? segSum / segN : 1;
        // Rest direction of each segment, expressed in the ANCHOR's frame.
        // Segment i runs bone(i-1)→bone(i); its bind direction lives in
        // bone(i-1)'s local frame, so we transport it up to the anchor by
        // the running product of bind local rotations. Used by the
        // bending constraint to place each bone at its authored angle
        // RELATIVE TO ITS PARENT (not rigidly off the anchor) so the whole
        // chain can bend + droop, not just the first link.
        const restDirAnchor: Vec3[] = new Array(boneIdxs.length);
        restDirAnchor[0] = [0, 1, 0];
        {
            let R: Quat = [0, 0, 0, 1];
            for (let i = 1; i < boneIdxs.length; i++) {
                restDirAnchor[i] = quatRotateVec3(R, bindLocalDir[i]);
                R = quatMul(R, bindLocalRot[i]);
            }
        }
        sims.push({
            chain,
            boneIdxs,
            restLen,
            bindLocalT,
            bindLocalRot,
            bindLocalDir,
            bindLocalLen,
            restDirAnchor,
            meanSeg,
            particlePos: new Array(boneIdxs.length),
            particlePrev: new Array(boneIdxs.length),
            lagRot: null,
        });
    }
    if (sims.length === 0) return;

    // Build colliders lookup (joint index + offset/radius). `boneIdxB`
    // is the capsule's second endpoint, or -1 for a plain sphere.
    interface SimCollider {
        boneIdx: number;
        boneIdxB: number;
        offset: Vec3;
        radius: number;
    }
    const simColliders: SimCollider[] = [];
    for (const c of colliders) {
        const idx = idxByHash.get(c.boneHash);
        if (idx === undefined) continue;
        const idxB = c.boneHashB !== undefined ? (idxByHash.get(c.boneHashB) ?? -1) : -1;
        simColliders.push({
            boneIdx: idx,
            boneIdxB: idxB,
            offset: [c.offsetX, c.offsetY, c.offsetZ],
            radius: Math.max(0, c.radius),
        });
    }

    // Ensure all simulated tracks exist BEFORE we start walking
    // frames — the world-compose for later frames must see the
    // tracks we've been writing into.
    for (const sim of sims) {
        for (let i = 1; i < sim.chain.boneHashes.length; i++) {
            ensureTrack(sim.chain.boneHashes[i]);
        }
    }

    // Scratch arrays reused per frame.
    const worldRot: Quat[] = new Array(joints.length);
    const worldPos: Vec3[] = new Array(joints.length);

    // Seed: compose frame 0 + place every simulated particle at the
    // bind-attached world position. Run a handful of warmup frames
    // at frame 0 so the chain starts settled.
    composeWorld(0, worldRot, worldPos);
    for (const sim of sims) {
        sim.particlePos[0] = [...worldPos[sim.boneIdxs[0]]] as Vec3;
        for (let i = 1; i < sim.boneIdxs.length; i++) {
            const parentPos = sim.particlePos[i - 1];
            const parentRot = worldRot[sim.boneIdxs[i - 1]];
            // Rigid-attached world pos = parent worldPos + parent worldRot · bind local T
            const off = quatRotateVec3(parentRot, sim.bindLocalT[i]);
            sim.particlePos[i] = [parentPos[0] + off[0], parentPos[1] + off[1], parentPos[2] + off[2]];
        }
        // Verlet seeds prev == pos → zero initial velocity. Rest-pose
        // orientation starts locked to the anchor (no lag yet).
        sim.particlePrev = sim.particlePos.map(p => [p[0], p[1], p[2]] as Vec3);
        sim.lagRot = [...worldRot[sim.boneIdxs[0]]] as Quat;
    }
    // Skin the mesh collider to frame 0 so the warmup already collides
    // against the body in its starting pose.
    if (meshCol && bindRotArr && bindPosArr) {
        updateSkinnedCollider(meshCol, worldRot, worldPos, bindRotArr, bindPosArr);
    }
    // Warmup at frame 0 so the chain settles into its hanging rest pose
    // before recording — with rig-scaled gravity it takes a few dozen
    // steps to fall from the bind pose into the natural droop.
    for (let warm = 0; warm < 40; warm++) {
        stepSims(sims, simColliders, worldRot, worldPos, dt, meshCol);
    }

    for (let frame = 0; frame < dto.frame_count; frame++) {
        composeWorld(frame, worldRot, worldPos);
        // Re-skin the mesh collider to this frame's animated pose before
        // the chain steps against it.
        if (meshCol && bindRotArr && bindPosArr) {
            updateSkinnedCollider(meshCol, worldRot, worldPos, bindRotArr, bindPosArr);
        }
        stepSims(sims, simColliders, worldRot, worldPos, dt, meshCol);

        // Convert simulated world positions into local TRS against
        // each bone's actual SKL parent. The parent for chain bone
        // i>0 is whatever the SKL says (usually chain bone i-1, but
        // we don't assume).
        for (const sim of sims) {
            for (let i = 1; i < sim.boneIdxs.length; i++) {
                const myIdx = sim.boneIdxs[i];
                const myPos = sim.particlePos[i];
                const myJoint = joints[myIdx];
                const parentId = myJoint.parent_id;
                let parentRot: Quat = IDENTITY_QUAT_LOCAL;
                let parentPos: Vec3 = ZERO_VEC_LOCAL;
                if (parentId >= 0 && parentId < joints.length) {
                    parentRot = worldRot[parentId];
                    parentPos = worldPos[parentId];
                }
                // Local translation = inv(parentRot) · (myPos - parentPos).
                const dx = myPos[0] - parentPos[0];
                const dy = myPos[1] - parentPos[1];
                const dz = myPos[2] - parentPos[2];
                const parentRotInv: Quat = [-parentRot[0], -parentRot[1], -parentRot[2], parentRot[3]];
                const localTrans = quatRotateVec3(parentRotInv, [dx, dy, dz]);

                // Rotation: look-at from my world pos toward next
                // bone's world pos. For the tip (no next bone),
                // reuse the previous frame's direction by keeping
                // bind local rotation.
                let localRot: Quat = [
                    myJoint.local_rotation[0],
                    myJoint.local_rotation[1],
                    myJoint.local_rotation[2],
                    myJoint.local_rotation[3],
                ];
                if (i + 1 < sim.boneIdxs.length) {
                    const nextPos = sim.particlePos[i + 1];
                    const dirWorld: Vec3 = [
                        nextPos[0] - myPos[0],
                        nextPos[1] - myPos[1],
                        nextPos[2] - myPos[2],
                    ];
                    const len = Math.hypot(dirWorld[0], dirWorld[1], dirWorld[2]);
                    if (len > 1e-6) {
                        const dirWorldUnit: Vec3 = [dirWorld[0] / len, dirWorld[1] / len, dirWorld[2] / len];
                        // Convert into MY local frame relative to parent.
                        // myWorldRot = parentRot · myLocalRot
                        // We want myLocalRot such that myLocalRot · bindLocalDir(next) = dirLocal.
                        // Simpler: build a "world rotation" that maps the next bone's bind
                        // direction (in MY local frame's parent-rotated sense) onto the
                        // simulated direction, then strip the parent.
                        // Concretely: desiredWorldRot rotates the bind axis
                        // (sim.bindLocalDir[i+1] interpreted as "down the next bone in my
                        // local frame") into dirWorldUnit, parameterised by parentRot.
                        const bindAxisLocal = sim.bindLocalDir[i + 1];
                        // Convert bindAxisLocal to "in parent frame" space (where myLocalRot
                        // lives). The bind local-rot's identity case is when the bone is
                        // authored s.t. its local T already lies along the desired axis;
                        // we'll rotate bindAxisLocal by IDENTITY then by parentRotInv·dirWorldUnit.
                        const targetInParent = quatRotateVec3(parentRotInv, dirWorldUnit);
                        localRot = quatFromTo(bindAxisLocal, targetInParent);
                    }
                }

                const track = trackByHash.get(myJoint.name_hash);
                if (track) {
                    track.frames[frame] = {
                        translation: localTrans,
                        rotation: localRot,
                        scale: [1, 1, 1],
                    };
                }
                // Reflect the new local TRS into the world arrays so
                // subsequent chain bones (and the next frame's
                // composeWorld at the *current* frame, not needed
                // here) see the updated values.
                worldPos[myIdx] = myPos;
                worldRot[myIdx] = quatMul(parentRot, localRot);
            }
        }
    }

    // Loop-blend each chain so cyclic clips wrap seamlessly.
    for (const sim of sims) applyChainLoopBlend(dto, sim.chain);
}

/** One Verlet + PBD integration step for every chain, internally
 *  sub-stepped for stability. Reads `worldRot`/`worldPos` for the
 *  anchor bones (already composed from this frame's animation), then
 *  advances each chain particle by geometric position projection —
 *  no explicit spring, so it is unconditionally stable at any
 *  stiffness / damping / gravity. */
function stepSims(
    sims: Array<{
        chain: import('../animation/retarget').PhysicsChain;
        boneIdxs: number[];
        restLen: number[];
        bindLocalT: Vec3[];
        bindLocalRot: Quat[];
        bindLocalDir: Vec3[];
        bindLocalLen: number[];
        restDirAnchor: Vec3[];
        meanSeg: number;
        particlePos: Vec3[];
        particlePrev: Vec3[];
        lagRot: Quat | null;
    }>,
    simColliders: Array<{ boneIdx: number; boneIdxB: number; offset: Vec3; radius: number }>,
    worldRot: Quat[],
    worldPos: Vec3[],
    dt: number,
    meshCol: SkinnedCollider | null = null,
): void {
    // Scratch buffers for the capsule/sphere collision solve — reused
    // across every particle so the inner loop stays allocation-free.
    const coreP: Vec3 = [0, 0, 0];
    const coreQ: Vec3 = [0, 0, 0];
    const hitH: Vec3 = [0, 0, 0];
    const hitC: Vec3 = [0, 0, 0];
    // Split the frame into short substeps: PBD is stable regardless, but
    // substepping keeps a fast anchor swing from overshooting and lets
    // the constraints converge to a taut chain.
    const SUBSTEPS = 6;
    const ITERS = 6;
    const dts = dt / SUBSTEPS;
    const dts2 = dts * dts;
    const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

    for (const sim of sims) {
        const n = sim.boneIdxs.length;
        if (n < 2) continue;
        const anchorIdx = sim.boneIdxs[0];
        const anchorPos = worldPos[anchorIdx];
        const anchorRot = worldRot[anchorIdx];

        const stiff = clamp01(sim.chain.stiffness);
        const damping = clamp01(sim.chain.damping);
        const inertia = clamp01(sim.chain.inertia);

        // Rest-pose orientation lags the true anchor by `inertia`, so a
        // fast body turn/swing drags the chain instead of the rest pose
        // snapping rigidly. Updated once per frame. inertia 0 → locked
        // to the anchor, 1 → very laggy tail-drag.
        if (!sim.lagRot) sim.lagRot = [anchorRot[0], anchorRot[1], anchorRot[2], anchorRot[3]];
        else sim.lagRot = quatSlerp(sim.lagRot, anchorRot, 1 - inertia * 0.85);
        const restRot = sim.lagRot;

        // Per-substep bending stiffness: how hard each bone is eased
        // toward its authored angle RELATIVE TO ITS PARENT. Squared so the
        // low end stays genuinely floppy (gravity wins → the cape hangs +
        // swings); the high end holds the combed shape. This is a LOCAL
        // constraint, so unlike a global rigid-pose pull it lets the whole
        // chain droop + bend instead of only the top link moving.
        const kStiff = 0.02 + stiff * stiff * 0.5;
        // Verlet velocity retention (damping). 1 = keep all momentum
        // (bouncy free swing), 0 = dead-stop each step.
        const velRetain = damping;
        // Gravity along world -Y, scaled by rig size so the drape is
        // scale-invariant (same g/L on any rig). GRAV_SCALE dialed for
        // the default gravity slider.
        const GRAV_SCALE = 3;
        const gAccel = sim.chain.gravity * GRAV_SCALE * sim.meanSeg;
        // Distance-constraint strength: hard when length is locked, soft
        // (partial projection) otherwise so it may stretch a little.
        const distK = sim.chain.lockLength ? 1 : 0.5;

        // World rest direction of each segment — constant across substeps
        // (restRot is per-frame). Reused by the bending force AND the swing
        // limit below, so we build it once here.
        const worldRestDir: Vec3[] = new Array(n);
        for (let i = 1; i < n; i++) {
            worldRestDir[i] = quatRotateVec3(restRot, sim.restDirAnchor[i]);
        }
        // Swing limit: cap how far each bone may deviate from its combed rest
        // direction, so fast attacks can't fling the hair through the body or
        // fold it inside-out. `maxSwing` is the cone half-angle in degrees;
        // 0 or ≥180 = off (unlimited).
        const maxSwing = sim.chain.maxSwing ?? 0;
        const swingLimited = maxSwing > 0 && maxSwing < 180;
        const maxSwingCos = swingLimited ? Math.cos(maxSwing * Math.PI / 180) : -1;
        const maxSwingSin = swingLimited ? Math.sqrt(Math.max(0, 1 - maxSwingCos * maxSwingCos)) : 0;

        const pos = sim.particlePos;
        const prev = sim.particlePrev;

        for (let s = 0; s < SUBSTEPS; s++) {
            // 1. Verlet integrate the free particles (implicit velocity
            //    from pos−prev, damped by velRetain, plus gravity).
            for (let i = 1; i < n; i++) {
                const p = pos[i], pr = prev[i];
                const vx = (p[0] - pr[0]) * velRetain;
                const vy = (p[1] - pr[1]) * velRetain;
                const vz = (p[2] - pr[2]) * velRetain;
                pr[0] = p[0]; pr[1] = p[1]; pr[2] = p[2];
                p[0] = p[0] + vx;
                p[1] = p[1] + vy - gAccel * dts2;
                p[2] = p[2] + vz;
            }
            // 2. Pin the anchor to its animated world position.
            pos[0] = [anchorPos[0], anchorPos[1], anchorPos[2]];

            // 3. Bending (once per substep — inside the iteration loop it
            //    would compound and over-lock). This is the shape-restoring
            //    force, and the fix for "only the top flaps": each bone is
            //    eased toward its authored REST DIRECTION relative to its
            //    ACTUAL parent segment — NOT a rigid pose bolted to the
            //    anchor. So when the chain swings, every segment's rest
            //    target rotates with its parent, and the bend cascades all
            //    the way down. Gravity is free to droop the whole chain
            //    because the constraint only fixes relative angle, not
            //    absolute position.
            {
                // Bone 1: eased toward the anchor's rest direction (this is
                // the one link whose "parent" is the animated body). Its
                // droop is the tug-of-war between kStiff (toward rest dir)
                // and gravity — low stiffness → it hangs straight down.
                const wrd1 = worldRestDir[1];
                const rl1 = sim.restLen[1];
                pos[1][0] += (pos[0][0] + wrd1[0] * rl1 - pos[1][0]) * kStiff;
                pos[1][1] += (pos[0][1] + wrd1[1] * rl1 - pos[1][1]) * kStiff;
                pos[1][2] += (pos[0][2] + wrd1[2] * rl1 - pos[1][2]) * kStiff;
                // Bones 2..n: target = parent pos + (rest child direction,
                // transported by however far the parent segment has rotated
                // from ITS rest). Gauss-Seidel ascending so the corrected
                // parent feeds the child in the same pass.
                for (let i = 2; i < n; i++) {
                    const ax = pos[i - 1][0] - pos[i - 2][0];
                    const ay = pos[i - 1][1] - pos[i - 2][1];
                    const az = pos[i - 1][2] - pos[i - 2][2];
                    const alen = Math.hypot(ax, ay, az);
                    if (alen < 1e-6) continue;
                    const actualDir: Vec3 = [ax / alen, ay / alen, az / alen];
                    const restParent = worldRestDir[i - 1];
                    const restChild = worldRestDir[i];
                    // Rotate the rest child direction by the same rotation
                    // that carries the rest parent dir onto the actual one.
                    const align = quatFromTo(restParent, actualDir);
                    const tgtDir = quatRotateVec3(align, restChild);
                    const rl = sim.restLen[i];
                    const p = pos[i];
                    p[0] += (pos[i - 1][0] + tgtDir[0] * rl - p[0]) * kStiff;
                    p[1] += (pos[i - 1][1] + tgtDir[1] * rl - p[1]) * kStiff;
                    p[2] += (pos[i - 1][2] + tgtDir[2] * rl - p[2]) * kStiff;
                }
            }

            // 4. Constraint iterations — pure position projections that
            //    keep segment lengths and resolve collisions.
            for (let iter = 0; iter < ITERS; iter++) {
                // 4a. Distance: clamp each segment toward its bind length.
                //     Move only the child (the parent is nearer the
                //     pinned anchor, so treat it as the heavier end).
                for (let i = 1; i < n; i++) {
                    const a = pos[i - 1], b = pos[i];
                    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
                    const len = Math.hypot(dx, dy, dz);
                    const rest = sim.restLen[i];
                    if (len > 1e-6 && rest > 1e-6) {
                        const diff = ((len - rest) / len) * distK;
                        b[0] -= dx * diff;
                        b[1] -= dy * diff;
                        b[2] -= dz * diff;
                    }
                }
                // 4b. Collision: push particles out of sphere / capsule
                //     colliders. We test the whole hair SEGMENT (parent→bone)
                //     against the collider's CORE (a point for a sphere, a
                //     bone-to-bone segment for a capsule) via closest-segment
                //     distance — so a fast swing whose endpoints straddle the
                //     limb still gets caught instead of slipping through, and
                //     capsules wrap a whole limb with no gaps. Verlet turns
                //     the position change into a velocity change for free.
                for (let i = 1; i < n; i++) {
                    const a = pos[i - 1], b = pos[i];
                    for (const c of simColliders) {
                        if (c.radius <= 0) continue;
                        const boneRot = worldRot[c.boneIdx];
                        const bonePos = worldPos[c.boneIdx];
                        const o = quatRotateVec3(boneRot, c.offset);
                        coreP[0] = bonePos[0] + o[0];
                        coreP[1] = bonePos[1] + o[1];
                        coreP[2] = bonePos[2] + o[2];
                        if (c.boneIdxB >= 0) {
                            const bq = worldPos[c.boneIdxB];
                            coreQ[0] = bq[0]; coreQ[1] = bq[1]; coreQ[2] = bq[2];
                        } else {
                            coreQ[0] = coreP[0]; coreQ[1] = coreP[1]; coreQ[2] = coreP[2];
                        }
                        // Closest points between the hair segment and the core.
                        closestSegSeg(a, b, coreP, coreQ, hitH, hitC);
                        let nx = hitH[0] - hitC[0], ny = hitH[1] - hitC[1], nz = hitH[2] - hitC[2];
                        const d2 = nx * nx + ny * ny + nz * nz;
                        const r = c.radius;
                        if (d2 < r * r) {
                            let d = Math.sqrt(d2);
                            if (d < 1e-6) {
                                // Hair runs through the core — push out along
                                // the bone→particle direction instead.
                                nx = b[0] - hitC[0]; ny = b[1] - hitC[1]; nz = b[2] - hitC[2];
                                d = Math.hypot(nx, ny, nz);
                                if (d < 1e-6) { nx = 0; ny = 1; nz = 0; d = 1; }
                            }
                            const pen = r - d;
                            b[0] += (nx / d) * pen;
                            b[1] += (ny / d) * pen;
                            b[2] += (nz / d) * pen;
                        }
                    }
                }
                // 4c. Swing limit: clamp each segment's direction to within
                //     `maxSwing` of its combed rest direction. This is the
                //     hard stop that keeps hair from folding through the body
                //     or turning inside-out on a fast attack. Runs after
                //     collision so it also reels back anything a collider
                //     shoved too far.
                if (swingLimited) {
                    for (let i = 1; i < n; i++) {
                        const rd = worldRestDir[i];
                        const a = pos[i - 1], b = pos[i];
                        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
                        const len = Math.hypot(dx, dy, dz);
                        if (len < 1e-6) continue;
                        const ux = dx / len, uy = dy / len, uz = dz / len;
                        const cosA = ux * rd[0] + uy * rd[1] + uz * rd[2];
                        if (cosA >= maxSwingCos) continue; // within the cone
                        // Perpendicular component of the actual direction
                        // relative to the rest axis, used to rebuild the
                        // direction exactly on the cone boundary.
                        let px = ux - rd[0] * cosA, py = uy - rd[1] * cosA, pz = uz - rd[2] * cosA;
                        const plen = Math.hypot(px, py, pz);
                        let cxi: number, cyi: number, czi: number;
                        if (plen < 1e-6) {
                            // Antiparallel to rest — collapse straight to rest.
                            cxi = rd[0]; cyi = rd[1]; czi = rd[2];
                        } else {
                            px /= plen; py /= plen; pz /= plen;
                            cxi = rd[0] * maxSwingCos + px * maxSwingSin;
                            cyi = rd[1] * maxSwingCos + py * maxSwingSin;
                            czi = rd[2] * maxSwingCos + pz * maxSwingSin;
                        }
                        b[0] = a[0] + cxi * len;
                        b[1] = a[1] + cyi * len;
                        b[2] = a[2] + czi * len;
                    }
                }
            }
            // 5. Mesh collision (Maya-style): push every particle out of the
            //    skinned collision mesh's thickness shell. Done once per
            //    substep (it's the costly one); Verlet carries the correction
            //    and the next substep re-enforces distance + swing.
            if (meshCol) {
                for (let i = 1; i < n; i++) pushOutOfMesh(meshCol, pos[i]);
            }
        }
    }
}

// ── Havok offline-bake solver ───────────────────────────────────────
//
// An alternative to the `applyPhysicsChains` spring solver for chains
// flagged `solver: 'havok'`. It runs a deterministic, headless Havok
// rigid-body simulation and writes the SAME baked keyframes back into
// the DTO — so playback, scrubbing, and .anm export are identical to
// the simple solver's output, just with more accurate cloth/hair swing.
//
// Determinism note (proven by spike before building this): a reused
// Havok WASM instance drifts across runs even after disposing the
// plugin + engine. So every bake gets a FRESH instance via
// `loadFreshHavok()`, and within a bake we build one short-lived
// NullEngine world that we tear down at the end.

type HavokInstance = Awaited<ReturnType<typeof import('@babylonjs/havok')['default']>>;

/** Load a brand-new Havok WASM instance. The dynamic import keeps the
 *  ~1.5 MB JS loader out of the main bundle until a Havok chain is used.
 *
 *  We fetch the .wasm ourselves from a stable public-asset path and hand
 *  the bytes to the loader as `wasmBinary`. If we let Havok's Emscripten
 *  loader fetch on its own it guesses a URL that, under the Tauri/Vite
 *  SPA server, resolves to `index.html` — the loader then chokes on the
 *  HTML ("expected magic word 00 61 73 6d, found 3c 21 64 6f" = "<!do").
 *  Passing the bytes directly also sidesteps the streaming-compile MIME
 *  check.
 *
 *  The wasm lives in `public/havok/` (committed) because the package's
 *  `exports` map blocks importing it via a bundler `?url` subpath. If
 *  `@babylonjs/havok` is ever bumped, re-copy
 *  `node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm` to
 *  `public/havok/HavokPhysics.wasm`. */
export async function loadFreshHavok(): Promise<HavokInstance> {
    const mod = await import('@babylonjs/havok');
    const wasmUrl = `${import.meta.env.BASE_URL}havok/HavokPhysics.wasm`;
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error(`fetch havok wasm ${wasmUrl} -> ${res.status}`);
    const wasmBinary = await res.arrayBuffer();
    return mod.default({ wasmBinary });
}

function applyPhysicsChainsHavok(
    dto: BakedAnimationDTO,
    joints: import('./skeletonBuilder').SklJointDTO[],
    chains: import('../animation/retarget').PhysicsChain[],
    colliders: import('../animation/retarget').PhysicsCollider[],
    havok: HavokInstance,
): void {
    if (chains.length === 0) return;

    const jointByHash = new Map<number, import('./skeletonBuilder').SklJointDTO>();
    const idxByHash = new Map<number, number>();
    for (let i = 0; i < joints.length; i++) {
        jointByHash.set(joints[i].name_hash, joints[i]);
        idxByHash.set(joints[i].name_hash, i);
    }
    const trackByHash = new Map<number, BakedAnimationDTO['tracks'][number]>();
    for (const t of dto.tracks) trackByHash.set(t.joint_hash, t);

    const ensureTrack = (hash: number) => {
        if (trackByHash.has(hash)) return trackByHash.get(hash)!;
        const bind = jointByHash.get(hash);
        if (!bind) return null;
        const frames = new Array(dto.frame_count);
        for (let i = 0; i < dto.frame_count; i++) {
            frames[i] = {
                translation: [...bind.local_translation] as Vec3,
                rotation: [...bind.local_rotation] as Quat,
                scale: [1, 1, 1] as Vec3,
            };
        }
        const t = { joint_hash: hash, frames };
        dto.tracks.push(t);
        trackByHash.set(hash, t);
        return t;
    };

    const composeWorld = (frame: number, outRot: Quat[], outPos: Vec3[]) => {
        for (let i = 0; i < joints.length; i++) {
            const j = joints[i];
            const track = trackByHash.get(j.name_hash);
            let lr: Quat, lt: Vec3;
            if (track && track.frames[frame]) {
                const fr = track.frames[frame];
                lr = fr.rotation as Quat;
                lt = fr.translation as Vec3;
            } else {
                lr = j.local_rotation as Quat;
                lt = j.local_translation as Vec3;
            }
            if (j.parent_id < 0 || j.parent_id >= i) {
                outRot[i] = [lr[0], lr[1], lr[2], lr[3]];
                outPos[i] = [lt[0], lt[1], lt[2]];
            } else {
                const pr = outRot[j.parent_id];
                const pp = outPos[j.parent_id];
                outRot[i] = quatMul(pr, lr);
                const rotated = quatRotateVec3(pr, lt);
                outPos[i] = [pp[0] + rotated[0], pp[1] + rotated[1], pp[2] + rotated[2]];
            }
        }
    };

    const fps = dto.fps && dto.fps > 0 ? dto.fps : 30;
    const dt = 1 / fps;

    // Resolve each chain's bone indices + bind data. Skip chains that
    // don't fully resolve against this skeleton.
    interface HChain {
        chain: import('../animation/retarget').PhysicsChain;
        boneIdxs: number[];
        bindLocalT: Vec3[];
        bindLocalDir: Vec3[];
        restLen: number[];
        anchorBody: PhysicsBody;
        dynBodies: PhysicsBody[];   // index aligned to boneIdxs (0 = anchor placeholder = anchorBody)
        dynNodes: TransformNode[];
    }

    const worldRot: Quat[] = new Array(joints.length);
    const worldPos: Vec3[] = new Array(joints.length);
    composeWorld(0, worldRot, worldPos);

    // Babylon tracks a global "last created scene" that texture /
    // material factories fall back on when no scene is passed. Creating
    // (and disposing) our headless bake scene below would leave that
    // global dangling at the dead bake scene — which made the studio's
    // textures render white after a bake. Snapshot it and restore on
    // every exit so the main studio scene stays the implicit default.
    const prevLastScene = EngineStore._LastCreatedScene;

    // Fresh headless world. Constant frame delta → deterministic steps.
    const engine = new NullEngine();
    engine.getDeltaTime = () => dt * 1000;
    const scene = new Scene(engine);
    new FreeCamera('havok-bake-cam', new Vector3(0, 0, -1), scene);
    const plugin = new HavokPlugin(true, havok);
    // Base gravity is unit -Y; each dynamic body scales it via its
    // gravity factor so per-chain `gravity` (in skeleton world units)
    // is honoured without a per-chain world.
    scene.enablePhysics(new Vector3(0, -1, 0), plugin);
    // Sub-step the solver: break each 1/fps frame into ~4ms internal
    // steps. Without this, a fast-swinging anchor injects enough
    // velocity per 33ms step to blow the length constraints apart
    // (chain flails wildly). Proven necessary by the bake spike.
    scene.getPhysicsEngine()?.setSubTimeStep(1000 / 240);

    const makeSphereBody = (
        pos: Vec3,
        radius: number,
        motion: number,
    ): { body: PhysicsBody; node: TransformNode } => {
        const node = new TransformNode('hk', scene);
        node.position.set(pos[0], pos[1], pos[2]);
        node.computeWorldMatrix(true);
        const body = new PhysicsBody(node, motion, false, scene);
        body.shape = new PhysicsShapeSphere(new Vector3(0, 0, 0), Math.max(radius, 1e-3), scene);
        // CRITICAL: disablePreStep controls whether Havok copies the
        // transform node back INTO the body before each step.
        //   - ANIMATED (kinematic, we drive it): false → it reads the
        //     node we move every frame.
        //   - DYNAMIC (free-swinging): true → it must NOT be reset from
        //     the node, or it gets teleported back every frame and never
        //     actually simulates (this was the "looks identical" bug).
        body.disablePreStep = motion !== PhysicsMotionType.ANIMATED;
        return { body, node };
    };

    const hchains: HChain[] = [];
    for (const chain of chains) {
        if (chain.boneHashes.length < 2) continue;
        const boneIdxs: number[] = [];
        let ok = true;
        for (const h of chain.boneHashes) {
            const idx = idxByHash.get(h);
            if (idx === undefined) { ok = false; break; }
            boneIdxs.push(idx);
        }
        if (!ok) continue;

        const bindLocalT: Vec3[] = [];
        const bindLocalDir: Vec3[] = [];
        const restLen: number[] = [];
        for (let i = 0; i < boneIdxs.length; i++) {
            const lt = joints[boneIdxs[i]].local_translation as Vec3;
            bindLocalT.push([lt[0], lt[1], lt[2]]);
            const len = Math.hypot(lt[0], lt[1], lt[2]);
            bindLocalDir.push(len > 1e-6 ? [lt[0] / len, lt[1] / len, lt[2] / len] : [0, 1, 0]);
            restLen.push(i === 0 ? 0 : len);
        }
        // Radius for the chain's collision spheres — a fraction of the
        // shortest segment so neighbours don't perpetually overlap.
        let minSeg = Infinity;
        for (let i = 1; i < restLen.length; i++) if (restLen[i] > 1e-4) minSeg = Math.min(minSeg, restLen[i]);
        const boneRadius = Number.isFinite(minSeg) ? minSeg * 0.3 : 0.01;

        // Rigid-attached world positions at frame 0 = where the chain
        // sits as a stiff stick off the anchor. Bodies start here.
        const rigid0: Vec3[] = new Array(boneIdxs.length);
        rigid0[0] = [...worldPos[boneIdxs[0]]] as Vec3;
        let rr: Quat = [...worldRot[boneIdxs[0]]] as Quat;
        let rp: Vec3 = [...worldPos[boneIdxs[0]]] as Vec3;
        for (let i = 1; i < boneIdxs.length; i++) {
            const off = quatRotateVec3(rr, bindLocalT[i]);
            rp = [rp[0] + off[0], rp[1] + off[1], rp[2] + off[2]];
            rigid0[i] = [rp[0], rp[1], rp[2]];
        }

        // Parameter mapping — express the chain knobs through Havok's
        // real per-body / per-constraint controls rather than a post-
        // process blend, so the solver's inertia + collision response
        // actually drive the result.
        const stiffness = Math.max(0, Math.min(1, chain.stiffness));
        const damping = Math.max(0, Math.min(1, chain.damping));
        const inertia = Math.max(0, Math.min(1, chain.inertia));
        // Heavier bones carry more momentum, so they lag + overshoot the
        // anchor more — that's what `inertia` means to the user.
        const mass = 1 + inertia * 3;
        // `damping` is 0..1 with 1 = no damping (free swing). Havok
        // damping rises with resistance, so invert.
        const linDamp = (1 - damping) * 2;
        const angDamp = (1 - damping) * 4;
        // Mean segment length — used to scale joint forces so a long
        // cape and a short tassel feel similar at the same knob values.
        let segSum = 0, segN = 0;
        for (let i = 1; i < restLen.length; i++) if (restLen[i] > 1e-4) { segSum += restLen[i]; segN++; }
        const meanSeg = segN > 0 ? segSum / segN : 1;
        // Stiffness → how far each joint may bend from its rest pose.
        // A floppy chain (stiffness 0) can swing up to MAX_BEND per
        // joint; a rigid one (stiffness 1) is locked. Using angular
        // limits rather than restoring motors keeps the dynamics intact
        // (motors pinned everything rigid → "looks the same" bug) while
        // still giving the stiffness slider real meaning.
        const MAX_BEND = Math.PI / 3; // 60° per joint at fully floppy
        const maxBend = (1 - stiffness) * MAX_BEND;
        // Joint friction resists bending speed → extra damping at the
        // articulation, on top of the per-body damping.
        const jointFriction = (1 - damping) * mass * meanSeg * 2;

        const anchor = makeSphereBody(rigid0[0], boneRadius, PhysicsMotionType.ANIMATED);
        const dynBodies: PhysicsBody[] = [anchor.body];
        const dynNodes: TransformNode[] = [anchor.node];
        for (let i = 1; i < boneIdxs.length; i++) {
            const d = makeSphereBody(rigid0[i], boneRadius, PhysicsMotionType.DYNAMIC);
            // Per-bone weight multiplier — a heavier bone exerts more
            // gravitational force on the chain, so weighting the tip
            // drags the whole structure down (the "add weight to the
            // last child" knob).
            const boneWeight = chain.boneWeights?.[i] ?? 1;
            d.body.setMassProperties({ mass: mass * boneWeight });
            d.body.setLinearDamping(linDamp);
            d.body.setAngularDamping(angDamp);
            // Never let a chain body sleep — a settled body stops
            // responding to gravity / the anchor, which reads as "physics
            // does nothing". Keep them always active for the whole bake.
            plugin.setActivationControl(d.body, PhysicsActivationControl.ALWAYS_ACTIVE);
            // Gravity is scaled by segment length so it's scale-invariant
            // across rigs (keeps g/L constant → same drape on any rig
            // size). Kept in step with the simple solver's GRAV_SCALE (3)
            // so the two solvers drape similarly at the same gravity knob
            // — the old 5× over-drove the chain and read as "flailing".
            const GRAVITY_CALIBRATION = 3;
            d.body.setGravityFactor(chain.gravity * meanSeg * GRAVITY_CALIBRATION);
            dynBodies.push(d.body);
            dynNodes.push(d.node);
        }
        // Point-to-point rods between consecutive bones — child centre
        // pinned to a point fixed on the parent at the bind distance.
        // When `lockLength` is off, the linear axes get a small ± limit
        // so the chain can stretch a little under load.
        const ANGULAR_AXES = [
            PhysicsConstraintAxis.ANGULAR_X,
            PhysicsConstraintAxis.ANGULAR_Y,
            PhysicsConstraintAxis.ANGULAR_Z,
        ];
        for (let i = 1; i < boneIdxs.length; i++) {
            const parentPos = rigid0[i - 1];
            const childPos = rigid0[i];
            // Ball joint located at the PARENT's centre, so the child
            // swings around its parent (a proper hanging chain link).
            //   pivotA = 0           → joint at parent centre
            //   pivotB = -(child-parent) in child frame → child's pivot
            //            point coincides with the parent centre
            // The earlier symmetric/at-child pivots PINNED each bone's
            // own centre in world space, so the chain physically could
            // not fall (it "floated") and collapsed/bundled — this was
            // the root cause, confirmed by spike. Bodies start unrotated
            // so world delta == local delta here.
            const dxp = childPos[0] - parentPos[0];
            const dyp = childPos[1] - parentPos[1];
            const dzp = childPos[2] - parentPos[2];
            const stretch = chain.lockLength ? 0 : meanSeg * 0.15;
            const c = new Physics6DoFConstraint(
                { pivotA: new Vector3(0, 0, 0), pivotB: new Vector3(-dxp, -dyp, -dzp), collision: false },
                [
                    { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: -stretch, maxLimit: stretch },
                    { axis: PhysicsConstraintAxis.LINEAR_Y, minLimit: -stretch, maxLimit: stretch },
                    { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: -stretch, maxLimit: stretch },
                ],
                scene,
            );
            dynBodies[i - 1].addConstraint(dynBodies[i], c);
            // Stiffness → angular bend limits (LOCKED when fully stiff,
            // otherwise ±maxBend). Plus joint friction for damping.
            for (const ax of ANGULAR_AXES) {
                if (maxBend <= 1e-3) {
                    c.setAxisMode(ax, PhysicsConstraintAxisLimitMode.LOCKED);
                } else {
                    c.setAxisMode(ax, PhysicsConstraintAxisLimitMode.LIMITED);
                    c.setAxisMinLimit(ax, -maxBend);
                    c.setAxisMaxLimit(ax, maxBend);
                }
                if (jointFriction > 0) c.setAxisFriction(ax, jointFriction);
            }
        }

        hchains.push({ chain, boneIdxs, bindLocalT, bindLocalDir, restLen, anchorBody: anchor.body, dynBodies, dynNodes });
        // Ensure tracks exist for every simulated bone.
        for (let i = 1; i < chain.boneHashes.length; i++) ensureTrack(chain.boneHashes[i]);
    }

    if (hchains.length === 0) {
        plugin.dispose();
        engine.dispose();
        EngineStore._LastCreatedScene = prevLastScene;
        return;
    }

    // Collider spheres — kinematic bodies repositioned each frame.
    interface HCollider { boneIdx: number; offset: Vec3; node: TransformNode; body: PhysicsBody; }
    const hcolliders: HCollider[] = [];
    for (const c of colliders) {
        const idx = idxByHash.get(c.boneHash);
        if (idx === undefined || c.radius <= 0) continue;
        const cb = makeSphereBody([0, 0, 0], c.radius, PhysicsMotionType.ANIMATED);
        hcolliders.push({ boneIdx: idx, offset: [c.offsetX, c.offsetY, c.offsetZ], node: cb.node, body: cb.body });
    }

    // Drive anchors + colliders to a given frame's animated world pose.
    const driveTo = (frame: number) => {
        composeWorld(frame, worldRot, worldPos);
        for (const hc of hchains) {
            const ap = worldPos[hc.boneIdxs[0]];
            const ar = worldRot[hc.boneIdxs[0]];
            hc.anchorBody.setTargetTransform(
                new BabylonVector3(ap[0], ap[1], ap[2]),
                new BabylonQuaternion(ar[0], ar[1], ar[2], ar[3]),
            );
        }
        for (const col of hcolliders) {
            const br = worldRot[col.boneIdx];
            const bp = worldPos[col.boneIdx];
            const o = quatRotateVec3(br, col.offset);
            col.body.setTargetTransform(
                new BabylonVector3(bp[0] + o[0], bp[1] + o[1], bp[2] + o[2]),
                BabylonQuaternion.Identity(),
            );
        }
    };

    // Warmup at frame 0 so the chain settles into its hanging rest pose
    // before recording — otherwise the first second of the clip shows
    // the cape still falling into place from its bind pose.
    driveTo(0);
    for (let w = 0; w < 40; w++) scene.render();

    for (let frame = 0; frame < dto.frame_count; frame++) {
        driveTo(frame);
        scene.render();

        for (const hc of hchains) {
            // Read the raw simulated body positions. Stiffness / damping
            // are already baked into the motion by the joint motors +
            // body damping above — no post-process blend (that was what
            // made the result collapse back toward the rigid pose and
            // look identical to the simple solver).
            const particlePos: Vec3[] = new Array(hc.boneIdxs.length);
            particlePos[0] = [...worldPos[hc.boneIdxs[0]]] as Vec3;
            for (let i = 1; i < hc.boneIdxs.length; i++) {
                const np = hc.dynNodes[i].position;
                particlePos[i] = [np.x, np.y, np.z];
            }

            // Convert simulated world positions into local TRS against
            // each bone's SKL parent — identical math to the simple
            // solver so playback handles both the same way.
            for (let i = 1; i < hc.boneIdxs.length; i++) {
                const myIdx = hc.boneIdxs[i];
                const myPos = particlePos[i];
                const myJoint = joints[myIdx];
                const parentId = myJoint.parent_id;
                let parentRot: Quat = IDENTITY_QUAT_LOCAL;
                let parentPos: Vec3 = ZERO_VEC_LOCAL;
                if (parentId >= 0 && parentId < joints.length) {
                    parentRot = worldRot[parentId];
                    parentPos = worldPos[parentId];
                }
                const dx = myPos[0] - parentPos[0];
                const dy = myPos[1] - parentPos[1];
                const dz = myPos[2] - parentPos[2];
                const parentRotInv: Quat = [-parentRot[0], -parentRot[1], -parentRot[2], parentRot[3]];
                const localTrans = quatRotateVec3(parentRotInv, [dx, dy, dz]);

                let localRot: Quat = [
                    myJoint.local_rotation[0],
                    myJoint.local_rotation[1],
                    myJoint.local_rotation[2],
                    myJoint.local_rotation[3],
                ];
                if (i + 1 < hc.boneIdxs.length) {
                    const nextPos = particlePos[i + 1];
                    const dirWorld: Vec3 = [nextPos[0] - myPos[0], nextPos[1] - myPos[1], nextPos[2] - myPos[2]];
                    const len = Math.hypot(dirWorld[0], dirWorld[1], dirWorld[2]);
                    if (len > 1e-6) {
                        const dirUnit: Vec3 = [dirWorld[0] / len, dirWorld[1] / len, dirWorld[2] / len];
                        const bindAxisLocal = hc.bindLocalDir[i + 1];
                        const targetInParent = quatRotateVec3(parentRotInv, dirUnit);
                        localRot = quatFromTo(bindAxisLocal, targetInParent);
                    }
                }

                const track = trackByHash.get(myJoint.name_hash);
                if (track) {
                    track.frames[frame] = { translation: localTrans, rotation: localRot, scale: [1, 1, 1] };
                }
                worldPos[myIdx] = myPos;
                worldRot[myIdx] = quatMul(parentRot, localRot);
            }
        }
    }

    // Temporal smoothing of the baked keyframes for the simulated bones.
    // Havok's velocity solver leaves high-frequency wobble in the
    // per-frame positions; the look-at rotation amplifies that into
    // visible mesh shake ("losing its shit"). A light centered low-pass
    // over translation + rotation removes the chatter while keeping the
    // overall swing. This is an offline bake, so a non-causal (centered,
    // zero-lag) filter is fine.
    const SMOOTH_RADIUS = 2; // 5-tap triangular window
    if (dto.frame_count > 2 * SMOOTH_RADIUS + 1) {
        for (const hc of hchains) {
            for (let i = 1; i < hc.boneIdxs.length; i++) {
                const track = trackByHash.get(joints[hc.boneIdxs[i]].name_hash);
                if (!track) continue;
                const src = track.frames.map(f => ({ t: f.translation as Vec3, r: f.rotation as Quat }));
                for (let f = 0; f < track.frames.length; f++) {
                    let tx = 0, ty = 0, tz = 0, wsum = 0;
                    let qx = 0, qy = 0, qz = 0, qw = 0;
                    const ref = src[f].r;
                    for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++) {
                        const j = f + k;
                        if (j < 0 || j >= src.length) continue;
                        const w = SMOOTH_RADIUS + 1 - Math.abs(k); // triangular weights
                        wsum += w;
                        tx += src[j].t[0] * w; ty += src[j].t[1] * w; tz += src[j].t[2] * w;
                        // Align each quat to the centre frame's hemisphere
                        // before averaging (q and -q are the same rotation).
                        const q = src[j].r;
                        const dot = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3];
                        const s = dot < 0 ? -w : w;
                        qx += q[0] * s; qy += q[1] * s; qz += q[2] * s; qw += q[3] * s;
                    }
                    const qlen = Math.hypot(qx, qy, qz, qw) || 1;
                    track.frames[f] = {
                        translation: [tx / wsum, ty / wsum, tz / wsum],
                        rotation: [qx / qlen, qy / qlen, qz / qlen, qw / qlen],
                        scale: [1, 1, 1],
                    };
                }
            }
        }
    }

    // Loop-blend each chain so cyclic clips wrap seamlessly.
    for (const hc of hchains) applyChainLoopBlend(dto, hc.chain);

    plugin.dispose();
    engine.dispose();
    EngineStore._LastCreatedScene = prevLastScene;
}

/** Closest points between two segments [p1,q1] and [p2,q2]. Writes the
 *  closest point on segment 1 into `c1` and on segment 2 into `c2`.
 *  Standard clamped solver (Ericson, Real-Time Collision Detection);
 *  degenerates gracefully when either segment has zero length (so a
 *  sphere collider = a capsule with p2==q2 falls out of the same path).
 *  Takes pre-allocated out arrays to stay allocation-free in the inner
 *  physics loop. */
function closestSegSeg(
    p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3, c1: Vec3, c2: Vec3,
): void {
    const d1x = q1[0] - p1[0], d1y = q1[1] - p1[1], d1z = q1[2] - p1[2];
    const d2x = q2[0] - p2[0], d2y = q2[1] - p2[1], d2z = q2[2] - p2[2];
    const rx = p1[0] - p2[0], ry = p1[1] - p2[1], rz = p1[2] - p2[2];
    const a = d1x * d1x + d1y * d1y + d1z * d1z; // |seg1|²
    const e = d2x * d2x + d2y * d2y + d2z * d2z; // |seg2|²
    const f = d2x * rx + d2y * ry + d2z * rz;
    const EPS = 1e-9;
    let s: number, t: number;
    if (a <= EPS && e <= EPS) {
        s = 0; t = 0;
    } else if (a <= EPS) {
        s = 0; t = f / e;
    } else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e <= EPS) {
            t = 0; s = -c / a;
        } else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z;
            const denom = a * e - b * b;
            s = denom > EPS ? (b * f - c * e) / denom : 0;
            s = s < 0 ? 0 : s > 1 ? 1 : s;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = -c / a; }
            else if (t > 1) { t = 1; s = (b - c) / a; }
        }
    }
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    c1[0] = p1[0] + d1x * s; c1[1] = p1[1] + d1y * s; c1[2] = p1[2] + d1z * s;
    c2[0] = p2[0] + d2x * t; c2[1] = p2[1] + d2y * t; c2[2] = p2[2] + d2z * t;
}

/** Quaternion that rotates unit vector `from` onto unit vector `to`.
 *  Used by the physics bake to orient each bone along the simulated
 *  chain direction. Handles the antiparallel edge case by picking
 *  an arbitrary perpendicular axis. */
function quatFromTo(from: Vec3, to: Vec3): Quat {
    const fx = from[0], fy = from[1], fz = from[2];
    const tx = to[0], ty = to[1], tz = to[2];
    const fLen = Math.hypot(fx, fy, fz);
    const tLen = Math.hypot(tx, ty, tz);
    if (fLen < 1e-8 || tLen < 1e-8) return [0, 0, 0, 1];
    const fxn = fx / fLen, fyn = fy / fLen, fzn = fz / fLen;
    const txn = tx / tLen, tyn = ty / tLen, tzn = tz / tLen;
    const dot = fxn * txn + fyn * tyn + fzn * tzn;
    if (dot > 0.999999) return [0, 0, 0, 1];
    if (dot < -0.999999) {
        // Antiparallel: rotate 180° around any axis perpendicular
        // to `from`. Pick the world axis least aligned with `from`.
        const ax = Math.abs(fxn), ay = Math.abs(fyn), az = Math.abs(fzn);
        let perp: Vec3;
        if (ax <= ay && ax <= az) perp = [1, 0, 0];
        else if (ay <= az) perp = [0, 1, 0];
        else perp = [0, 0, 1];
        // Cross fxn × perp gives a vector perpendicular to fxn.
        const cx = fyn * perp[2] - fzn * perp[1];
        const cy = fzn * perp[0] - fxn * perp[2];
        const cz = fxn * perp[1] - fyn * perp[0];
        const cLen = Math.hypot(cx, cy, cz) || 1;
        return [cx / cLen, cy / cLen, cz / cLen, 0];
    }
    // General case: axis = from × to, angle = acos(dot).
    const cx = fyn * tzn - fzn * tyn;
    const cy = fzn * txn - fxn * tzn;
    const cz = fxn * tyn - fyn * txn;
    const s = Math.sqrt((1 + dot) * 2);
    const invs = 1 / s;
    return [cx * invs, cy * invs, cz * invs, s * 0.5];
}

function quatMul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

/** Conjugate (== inverse for a unit quaternion). */
function quatConj(q: Quat): Quat {
    return [-q[0], -q[1], -q[2], q[3]];
}

/** Spherical-linear interpolation between two unit quaternions. Falls
 *  back to normalised lerp when they're nearly parallel (numerically
 *  safer + cheaper). Used by the loop-blend pass. */
function quatSlerp(a: Quat, b: Quat, t: number): Quat {
    let [ax, ay, az, aw] = a;
    let [bx, by, bz, bw] = b;
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
    if (dot > 0.9995) {
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, w = aw + (bw - aw) * t;
        const l = Math.hypot(x, y, z, w) || 1;
        return [x / l, y / l, z / l, w / l];
    }
    const theta0 = Math.acos(dot);
    const theta = theta0 * t;
    const sin0 = Math.sin(theta0);
    const s0 = Math.sin(theta0 - theta) / sin0;
    const s1 = Math.sin(theta) / sin0;
    return [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1];
}

/** Loop-blend post-process for a physics chain. For a cyclic clip the
 *  baked chain rarely ends where it started, so the loop seam jumps.
 *  This eases the last `chain.loopBlend` frames toward frame 0's pose
 *  by distributing the start↔end gap across the window (smoothstep
 *  weighted, 0 at window start → 1 at the last frame). Frame 0 is never
 *  touched, so the wrap from the new last frame back to frame 0 is
 *  seamless. Solver-agnostic — operates purely on the baked DTO tracks
 *  for the chain's simulated bones. */
function applyChainLoopBlend(
    dto: BakedAnimationDTO,
    chain: import('../animation/retarget').PhysicsChain,
): void {
    const W = Math.floor(chain.loopBlend ?? 0);
    const N = dto.frame_count;
    if (W < 1 || N < W + 2) return;

    const trackByHash = new Map<number, BakedAnimationDTO['tracks'][number]>();
    for (const t of dto.tracks) trackByHash.set(t.joint_hash, t);

    for (let bi = 1; bi < chain.boneHashes.length; bi++) {
        const track = trackByHash.get(chain.boneHashes[bi]);
        if (!track || track.frames.length !== N) continue;
        const first = track.frames[0];
        const last = track.frames[N - 1];
        const gt: Vec3 = [
            first.translation[0] - last.translation[0],
            first.translation[1] - last.translation[1],
            first.translation[2] - last.translation[2],
        ];
        // Rotation gap qGap such that qGap · last.rot == first.rot.
        const qGap = quatMul(first.rotation as Quat, quatConj(last.rotation as Quat));
        for (let k = 0; k < W; k++) {
            const f = N - W + k;
            const lin = W > 1 ? k / (W - 1) : 1; // 0 at window start → 1 at last frame
            const w = lin * lin * (3 - 2 * lin);  // smoothstep ease
            const fr = track.frames[f];
            fr.translation = [
                fr.translation[0] + gt[0] * w,
                fr.translation[1] + gt[1] * w,
                fr.translation[2] + gt[2] * w,
            ];
            const partial = quatSlerp([0, 0, 0, 1], qGap, w);
            fr.rotation = quatMul(partial, fr.rotation as Quat);
        }
    }
}

/** Convert XYZ Tait-Bryan Euler angles in DEGREES to a unit
 *  quaternion. Composition order: qX · qY · qZ — pitch around
 *  local X, then yaw around local Y, then roll around local Z.
 *  Used by guide rotation offsets so the user dials angles in
 *  intuitive degrees rather than raw quaternion components. */
function eulerDegreesToQuat(xDeg: number, yDeg: number, zDeg: number): Quat {
    const rx = xDeg * Math.PI / 180;
    const ry = yDeg * Math.PI / 180;
    const rz = zDeg * Math.PI / 180;
    const cx = Math.cos(rx * 0.5), sx = Math.sin(rx * 0.5);
    const cy = Math.cos(ry * 0.5), sy = Math.sin(ry * 0.5);
    const cz = Math.cos(rz * 0.5), sz = Math.sin(rz * 0.5);
    // q = qX · qY · qZ expanded — standard XYZ Tait-Bryan formula.
    return [
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    ];
}

function quatRotateVec3(q: Quat, v: Vec3): Vec3 {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ];
}

/** Rotate a 3-vector by a unit quaternion, returning [x, y, z].
 *  Used by the gizmo commit math to invert the follow bone's
 *  rotation so we can convert a world-space proxy position back
 *  into the bone's local offset. */
function rotateVec3ByQuat(q: BabylonQuaternion, vx: number, vy: number, vz: number): [number, number, number] {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ];
}

/** Convert a quaternion to XYZ Tait-Bryan Euler angles in
 *  DEGREES. Inverse of `eulerDegreesToQuat` (which composes
 *  `q = qX · qY · qZ`). Derived from the rotation matrix
 *  `R = Rx · Ry · Rz`:
 *
 *      β (Y) = asin(R13)            → asin(2(xz + yw))
 *      α (X) = atan2(-R23, R33)     → atan2(2(xw - yz), 1 - 2(x² + y²))
 *      γ (Z) = atan2(-R12, R11)     → atan2(2(zw - xy), 1 - 2(y² + z²))
 *
 *  Handles the gimbal-lock edge case (β = ±π/2 → cos(β) ≈ 0)
 *  by pinning α to 0 and folding the remaining rotation into γ
 *  — stable for the gizmo commit; the user can re-dial if the
 *  ambiguity matters. */
function quaternionToEulerDegrees(x: number, y: number, z: number, w: number): [number, number, number] {
    const sinBeta = 2 * (x * z + y * w);
    let alpha: number;
    let beta: number;
    let gamma: number;
    if (Math.abs(sinBeta) >= 0.99999) {
        // Gimbal lock: pitch around Y is ±90°.
        beta = Math.sign(sinBeta) * Math.PI / 2;
        alpha = 0;
        gamma = Math.atan2(2 * (x * y + z * w), 1 - 2 * (x * x + z * z));
    } else {
        beta = Math.asin(sinBeta);
        alpha = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
        gamma = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
    }
    const RAD = 180 / Math.PI;
    return [alpha * RAD, beta * RAD, gamma * RAD];
}

/** Shallow array equality. Used to avoid re-applying the vertical
 *  offset when the React panel re-renders with a fresh-but-
 *  identical exclusion array. */
function arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** A single mini-viewport hosting one model. Both sides share this
 *  shape so the parent doesn't care which one it's poking. */
interface ViewportState {
    engine: Engine;
    scene: Scene;
    camera: ArcRotateCamera;
    object: StudioObject | null;
    /** Path on disk the SKN was loaded from. Surfaced to the React
     *  UI so the header chip can show the filename. */
    path: string | null;
    /** The animation player driving this side, if a clip is loaded.
     *  Paused — its `time` is overwritten by the shared clock every
     *  frame so the two sides stay in lockstep. */
    player: AnimationPlayer | null;
    /** Per-frame observer that copies `clock.time` into the player
     *  and applies the resulting pose. Disposed when the side's clip
     *  is cleared or the side's object is swapped out. */
    observer: Observer<Scene> | null;
    /** Camera view-matrix observer used by the camera-link feature
     *  to mirror this side's TRS to the other side. Removed in
     *  `disposeViewport`. */
    cameraObs: Observer<Camera> | null;
}

/** Shared timeline state — owned by the scene, read by both sides
 *  every frame, mutated by the React scrubber. Phase 7 extends
 *  with an A/B target-offset so the user can compare specific
 *  frame pairs (e.g. "does source's hand-up at frame 30 match
 *  target's hand-up at frame 32?"). */
interface ClockState {
    /** Current time in seconds. Loops modulo `duration`. */
    time: number;
    /** True while `Pause` is showing; false while `Play` is. */
    playing: boolean;
    /** Playback speed multiplier. Phase 2 ships 1×; the scrubber UI
     *  can later expose 0.5× / 2× etc without scene changes. */
    speed: number;
    /** Loop on reaching the end vs clamp at the last frame. */
    loop: boolean;
    /** Cached duration of the source clip, in seconds. 0 when no
     *  clip is loaded. */
    duration: number;
    /** Cached fps of the source clip. Used by the scrubber to show
     *  frame-accurate readouts. */
    fps: number;
    /** Total frame count of the source clip. */
    frameCount: number;
    /** A/B mode: target plays at `time + targetOffset`, wrapped
     *  into [0, duration). Zero = synchronised (default). Negative
     *  = target leads, positive = target lags. */
    targetOffset: number;
}

export interface AnimStudioScene {
    /** Render-loop owners — exposed for the rare panel that needs
     *  to schedule a one-off render outside the loop (resize, etc). */
    sourceEngine: Engine;
    targetEngine: Engine;
    sourceScene: Scene;
    targetScene: Scene;
    /** Bind one of the two viewports to a freshly-mounted canvas.
     *  Called by the React layer after the canvas element is in the
     *  DOM. Idempotent — re-binding the same canvas is a no-op; a
     *  different canvas swaps the engine over. */
    attachCanvas: (side: AnimStudioSide, canvas: HTMLCanvasElement) => void;
    /** Load a SKN from disk into the given side. Replaces whatever
     *  was there. Frames the camera on the new model. */
    loadSkn: (side: AnimStudioSide, path: string) => Promise<void>;
    /** Swap source ↔ target. Models stay loaded; only their roles
     *  flip. Cameras keep their respective framings. */
    swap: () => void;
    /** Drop the model on the given side. Camera resets to default. */
    clear: (side: AnimStudioSide) => void;
    /** Re-frame the camera on whichever model is loaded for that side.
     *  No-op when the side is empty. */
    frameCamera: (side: AnimStudioSide) => void;
    /** Object + path query for the React UI (header chips, status). */
    getSide: (side: AnimStudioSide) => { object: StudioObject | null; path: string | null };

    // ── Camera link (source ↔ target viewport mirror) ─────────────
    /** Enable / disable camera mirroring between the two viewports.
     *  When enabled, dragging the camera on either side moves the
     *  other in lock-step (matched alpha / beta / radius / target).
     *  When toggled on, the target side immediately snaps to the
     *  source side so they start aligned. */
    setCameraLink: (linked: boolean) => void;
    getCameraLink: () => boolean;

    // ── Phase 3: live retarget option toggles ─────────────────────

    /** Patch the active retarget options. Both fields are optional —
     *  unmentioned ones keep their current value. Triggers an
     *  immediate target-side player rebuild against a freshly-
     *  computed retargeted DTO. */
    setRetargetOptions: (patch: Partial<RetargetOptions>) => void;
    getRetargetOptions: () => RetargetOptions;

    // ── Phase 4: bone mapping + manual overrides ──────────────────

    /** Snapshot the per-bone mapping table for the panel UI. One
     *  row per source joint, with status (exact / fuzzy / override /
     *  ignored / unmapped) and the target it currently maps to.
     *  Returns an empty array when either rig is missing. */
    getBoneMappingRows: () => MappingRow[];
    /** Every target-rig joint as `{ hash, name }` pairs, sorted by
     *  name — the option list the panel's per-row dropdown shows so
     *  the user can pick a target bone even when no source bone
     *  currently maps to it. */
    getTargetJoints: () => Array<{ hash: number; name: string }>;
    /** Mesh names on the target object in load order. Used by the
     *  vertical-offset exclusion UI to pick which submeshes lift. */
    getTargetMeshNames: () => string[];
    /** Source rig joint names, sorted alphabetically. Populates the
     *  `rootNodeName` / `groundReferenceNodeName` dropdowns in
     *  the Options panel. */
    getSourceJointNames: () => string[];
    /** Force a specific source → target mapping. The override
     *  survives auto-remap passes. Passing `IGNORED` marks the bone
     *  as "do not drive anything"; pass `null` to drop the override
     *  and fall back to the auto entry (or unmapped, if auto didn't
     *  find anything). */
    setBoneOverride: (sourceHash: number, entry: MappingEntry | null) => void;
    /** Wipe every manual override, leaving only the auto-computed
     *  mapping. The undo escape hatch for "I made a mess". */
    clearBoneOverrides: () => void;
    /** Re-run the auto pass (e.g. after the user added/removed bones
     *  via a non-load action — currently not a real path, but
     *  reserved for future bone-edit flows). Overrides survive. */
    recomputeAutoMapping: () => void;

    // ── Guides (per-bone rigid + XYZ offset) ──────────────────────

    /** Snapshot of all active guides, ordered by target bone name
     *  for stable UI rendering. */
    getGuides: () => BoneGuide[];
    /** Add or update a guide for `targetBoneHash`. Replaces any
     *  existing guide on the same target. Pass `null` for
     *  `targetBoneHash` to make this a no-op (defensive). */
    setGuide: (guide: BoneGuide) => void;
    /** Remove a guide by target bone hash. No-op when not present. */
    removeGuide: (targetBoneHash: number) => void;
    /** Enter / exit interactive edit mode for a guide. When `hash`
     *  is non-null, the target viewport shows a Babylon gizmo
     *  (position or rotation per `mode`) attached to a proxy
     *  transform at the guided bone's animated world location.
     *  Drag the gizmo to dial in the offset / rotation visually;
     *  values commit back to the guide on drag-end. */
    setEditingGuide: (hash: number | null, mode: 'position' | 'rotation' | null) => void;
    /** Hash of the guide currently being gizmo-edited (or null).
     *  Read by the panel to drive button highlight state. */
    getEditingGuideHash: () => number | null;
    /** Active gizmo mode (or null). */
    getEditingGuideMode: () => 'position' | 'rotation' | null;

    // ── Physics chains (cape / tail / hair spring-chain bake) ─────

    /** Snapshot of all physics chains, in insertion order. */
    getPhysicsChains: () => PhysicsChain[];
    /** Add or update a chain. Keyed by `id` — passing an id already
     *  in the list replaces that entry; a new id appends. */
    setPhysicsChain: (chain: PhysicsChain) => void;
    /** Remove a chain by id. No-op when not present. */
    removePhysicsChain: (id: string) => void;
    /** Snapshot of all sphere colliders. */
    getPhysicsColliders: () => PhysicsCollider[];
    /** Add or update a collider. Keyed by `id`. */
    setPhysicsCollider: (collider: PhysicsCollider) => void;
    /** Remove a collider by id. */
    removePhysicsCollider: (id: string) => void;
    /** Auto-fit body colliders (capsules per bone) from the physics rig's
     *  skinned mesh — Unreal-Physics-Asset style. Returns how many were
     *  added (dedupes against existing, skips physics-chain bones). */
    generateCollidersFromMesh: () => number;
    /** Maya-style mesh-collision config (collide chains against the skinned
     *  mesh with a thickness shell). */
    getMeshCollision: () => MeshCollisionConfig;
    setMeshCollision: (patch: Partial<MeshCollisionConfig>) => void;
    /** Submesh names on the physics rig (for the mesh-collision exclusion
     *  list — exclude the hair/cape mesh so it doesn't self-collide). */
    getPhysicsMeshNames: () => string[];
    /** Whether the translucent collider-preview spheres are drawn in the
     *  physics-rig viewport. */
    getShowColliders: () => boolean;
    /** Toggle the collider-preview spheres. They ride the animated bones
     *  so you can size-check them against the mesh during playback. */
    setShowColliders: (show: boolean) => void;

    // ── Editing mode (retarget vs standalone physics) ─────────────

    /** Current editing mode. */
    getMode: () => AnimStudioMode;
    /** Switch editing mode. Recomputes the relevant DTO(s), reattaches
     *  the players and emits. In Physics mode only the source viewport
     *  is meaningful (single rig + clip). */
    setMode: (mode: AnimStudioMode) => void;
    /** The rig that physics chains attach to for the active mode:
     *  the target rig in Retarget mode, the single source rig in
     *  Physics mode. */
    getPhysicsRigSide: () => AnimStudioSide;
    /** Sorted (hash, name) joints of the physics rig — the list the
     *  physics panel populates its bone pickers from. Empty when the
     *  relevant rig isn't loaded. */
    getPhysicsJoints: () => Array<{ hash: number; name: string }>;
    /** Batch helper for Physics mode: load a clip from disk, bake the
     *  current physics chains onto the single (source) rig and return
     *  the DTO — without disturbing the live preview. */
    bakePhysicsClipForExport: (anmPath: string) => Promise<BakedAnimationDTO | null>;

    // ── Phase 6: bake-and-write ───────────────────────────────────

    /** Snapshot the currently-active retargeted DTO. Returns the same
     *  data the target player is rendering, so what-you-see-is-what-
     *  you-bake. Null when no clip is loaded or no target rig is
     *  attached (nothing meaningful to write). */
    getRetargetedClip: () => BakedAnimationDTO | null;
    /** Batch helper: load a source `.anm` from disk, retarget it with
     *  the current rigs / mapping / options / guides (and optionally
     *  physics), and return the baked DTO — WITHOUT disturbing the
     *  live-preview clip. Used by the Export panel's Batch mode to
     *  process a whole champion's animation set against one set-up. */
    retargetClipForExport: (anmPath: string, opts?: { physics?: boolean }) => Promise<BakedAnimationDTO | null>;
    /** Suggested default output path: the target SKN's sibling
     *  `animations/<source-clip-basename>` folder. Falls back to
     *  the source clip's own filename next to the source SKN when
     *  no target SKN is loaded. Returns null when neither rig is
     *  loaded or no clip is set. */
    getDefaultBakePath: () => string | null;

    // ── Scene save / load ─────────────────────────────────────────

    /** Capture the full retargeting setup (source/target paths,
     *  clip path, retarget options, bone overrides, target offset,
     *  last bake path) as a JSON-safe object. Drives the
     *  `.animstudio.json` file format. */
    serialize: () => AnimStudioSceneData;
    /** Re-hydrate from a serialised scene. Async because models +
     *  the clip are re-read from disk. Order: source SKN → target
     *  SKN → clip → apply overrides → apply options + offset. */
    loadFromData: (data: AnimStudioSceneData) => Promise<void>;

    // ── Undo / redo (snapshot-based, mirrors Photo Studio) ─────────
    /** Record an undo step AFTER a mutation. An optional `key` coalesces
     *  rapid same-key commits (slider drags) into one step. Internal —
     *  panels call this only for gestures the scene can't self-detect. */
    commitUndoStep: (key?: string) => void;
    /** Step back / forward through the snapshot history. Async because a
     *  step that crosses a rig/clip path change falls back to a disk
     *  reload; same-path steps restore in-memory and resolve instantly. */
    undo: () => Promise<void>;
    redo: () => Promise<void>;
    canUndo: () => boolean;
    canRedo: () => boolean;
    /** Wipe history + re-baseline. Call after opening an `.animstudio.json`. */
    resetUndoHistory: () => void;
    /** True when there are changes since the last `markSaved()`. */
    isDirty: () => boolean;
    /** Stamp the current state as saved (leaves undo history intact). */
    markSaved: () => void;

    // ── Phase 2: clip playback + shared scrubber ──────────────────

    /** Load a baked ANM (from disk) as the source clip. Builds an
     *  `AnimationPlayer` for whichever side(s) have a loaded SKN —
     *  the source side resolves against the source rig (= the clip's
     *  native skeleton), the target side resolves the SAME DTO
     *  against the target rig (naive retarget: matching bones drive,
     *  non-matching stay at rest). Clears any previously-loaded clip.
     *
     *  Returns metadata for the UI so the scrubber can render. */
    loadSourceClip: (anmPath: string) => Promise<{
        duration: number;
        fps: number;
        frameCount: number;
        sourceMatched: number;
        targetMatched: number;
    }>;
    /** Drop the current clip from both sides and rest-pose the rigs. */
    clearClip: () => void;
    /** True while a clip is loaded on either side. */
    hasClip: () => boolean;
    /** Path of the currently-loaded source ANM, or null. */
    getClipPath: () => string | null;
    /** Returns the on-disk path the clip was loaded from. */
    getClipMetadata: () => {
        duration: number;
        fps: number;
        frameCount: number;
    };

    /** Shared-timeline controls. The scene owns the clock and writes
     *  its time into both players every frame, so play / pause /
     *  scrub all operate on a single source of truth. */
    play: () => void;
    pause: () => void;
    isPlaying: () => boolean;
    /** Seek to an absolute time (seconds). Out-of-range values clamp
     *  to `[0, duration]`. Calls into both players to apply the pose
     *  immediately — useful from the scrubber while paused. */
    seek: (timeSeconds: number) => void;
    /** Current time (seconds) of the shared clock. */
    getTime: () => number;
    /** Set playback speed multiplier (1 = real-time). Bound below to
     *  reasonable values to keep scrubbing stable. */
    setSpeed: (speed: number) => void;
    getSpeed: () => number;
    /** Toggle loop-on-end vs clamp-at-end. */
    setLoop: (loop: boolean) => void;
    getLoop: () => boolean;
    /** A/B mode: offset the target's playback time by N seconds
     *  while keeping the source on the clock's canonical time. Zero
     *  = synchronised (default). Out-of-range values are accepted
     *  and wrapped at apply time. */
    setTargetOffset: (offset: number) => void;
    getTargetOffset: () => number;

    /** Subscribe to scene changes (load / clear / swap / clip load /
     *  play state). The scrubber UI re-renders on every emit so this
     *  fires from many places — keep listener bodies cheap. */
    onChange: (cb: () => void) => () => void;
    dispose: () => void;
}

/**
 * Creates a paired-scene host. The two engines are constructed
 * lazily (no canvas yet) and bound via {@link AnimStudioScene.attachCanvas}
 * once the React component mounts. This split lets the scene exist
 * before the DOM does — matches how Photo Studio's tab is registered
 * on `ShellContext` ahead of mount.
 *
 * NOTE: Babylon requires a real, visible canvas at `Engine`
 * construction time — we can't defer this past `createEngine`. So the
 * design here is: the engine is created the moment the canvas mounts,
 * not at `createAnimStudioScene()` time. The constructor returns a
 * scene host where `sourceEngine` / `targetEngine` are placeholders
 * until `attachCanvas` fires.
 */
export function createAnimStudioScene(): AnimStudioScene {
    const sides: Record<AnimStudioSide, ViewportState | null> = {
        source: null,
        target: null,
    };
    const listeners = new Set<() => void>();
    const emit = () => {
        for (const cb of listeners) {
            try { cb(); } catch { /* ignore */ }
        }
    };

    // ── Undo / dirty tracking ──
    // Snapshot-based, mirroring Photo Studio's `StudioScene`: each
    // committed mutation pushes the PRE-mutation `AnimStudioSceneData`
    // onto `undoStack`. Restore reuses the scene's own load path — but
    // unlike Photo Studio, a full `loadFromData` here disposes + re-reads
    // both rigs from disk and re-bakes the clip, which is far too heavy
    // for the guide / option / physics tweaks that dominate Anim Studio.
    // So `applyUndoSnapshot` takes a SOFT path when the rig + clip paths
    // are unchanged (the common case): it re-applies only the in-memory
    // state and rebakes, with zero disk I/O. It falls back to the full
    // async `loadFromData` only when a path actually differs.
    //
    // `suspendUndo` guards the re-entrant loads that the restore paths
    // trigger; it's saved/restored (not just toggled) so nested calls —
    // undo() → loadFromData() — don't clear it prematurely. Slider drags
    // coalesce: a commit with the same `key` inside `COALESCE_MS` of the
    // last one advances the baseline without pushing a fresh step, so one
    // drag = one undo, not 60.
    const MAX_UNDO = 64;
    const COALESCE_MS = 350;
    const undoStack: AnimStudioSceneData[] = [];
    const redoStack: AnimStudioSceneData[] = [];
    let lastSnapshot: AnimStudioSceneData | null = null;
    let suspendUndo = false;
    let dirtyCounter = 0;
    let savedCounter = 0;
    let lastCommitAt = 0;
    let lastCommitKey: string | null = null;

    /** Build one viewport against a freshly-mounted canvas. Mirrors
     *  Photo Studio's grid + hemi setup, minus the shadow / glow
     *  machinery — Animation Studio doesn't need them for retargeting
     *  preview, and skipping them keeps the GPU budget down with two
     *  engines live. */
    const buildViewport = (canvas: HTMLCanvasElement): ViewportState => {
        const engine = createEngine(canvas);
        // GPU savings. With two viewports running side-by-side the
        // pixel work is the dominant cost, so we trim several knobs
        // that aren't visually load-bearing for a retargeting
        // preview:
        //   1. Cap the render resolution at the device's CSS pixel
        //      ratio with a 1.5x ceiling. On a 200% (Retina / 4K
        //      laptop) display Babylon would otherwise render at 4×
        //      the pixel count, and we just don't need that for two
        //      ~600 px-wide viewports. Math: hardware-scaling-level
        //      is the inverse of the pixel multiplier, so a value of
        //      `dpr / 1.5` clamps the effective DPR to 1.5×.
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        if (dpr > 1.5) {
            engine.setHardwareScalingLevel(dpr / 1.5);
        }
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0, 0, 0, 0);
        // 2. Skip per-pointer-move picking. Babylon defaults to
        //    raycasting every move event so things like hover
        //    highlights work; we don't need that. The gizmo's own
        //    drag behaviour explicitly enables picking when it
        //    attaches, so we don't break gizmo editing.
        scene.skipPointerMovePicking = true;
        // NOTE: we deliberately do NOT set `scene.blockMaterialDirtyMechanism`.
        // It was here as a micro-opt on the assumption that materials never
        // change after load, but the mesh panel (texture overrides) and the
        // SKN's own auto-applied textures DO edit materials — and with the
        // dirty mechanism blocked, assigning a texture never recompiles the
        // material shader, leaving the mesh white. The per-frame bookkeeping
        // it saved is negligible for a 1-2 model scene.

        const camera = new ArcRotateCamera(
            'anim-cam',
            Math.PI / 2 + Math.PI / 8,
            Math.PI / 2 - Math.PI / 8,
            8,
            Vector3.Zero(),
            scene,
        );
        camera.attachControl(canvas, true);
        camera.lowerRadiusLimit = 0.5;
        camera.upperRadiusLimit = 1000;
        camera.wheelDeltaPercentage = 0.05;
        camera.panningSensibility = 100;
        camera.lowerBetaLimit = 0.01;
        camera.upperBetaLimit = Math.PI - 0.01;

        const hemi = new HemisphericLight('anim-hemi', new Vector3(0, 1, 0), scene);
        hemi.intensity = 1.0;
        hemi.groundColor = new Color3(0.35, 0.35, 0.4);

        const ground = CreateGround(
            'anim-ground',
            { width: 200, height: 200, subdivisions: 1 },
            scene,
        ) as Mesh;
        const gridMat = new GridMaterial('anim-grid', scene);
        gridMat.gridRatio = 5;
        gridMat.majorUnitFrequency = 10;
        gridMat.minorUnitVisibility = 0.35;
        gridMat.lineColor = new Color3(0.4, 0.45, 0.55);
        gridMat.mainColor = new Color3(0.06, 0.07, 0.09);
        gridMat.opacity = 0.9;
        ground.material = gridMat;

        engine.runRenderLoop(() => {
            // Skip the entire render pipeline when the app window is
            // hidden (minimised / OS-backgrounded). Babylon would
            // otherwise keep pushing draws at vsync into a webview
            // the user can't see — pure wasted GPU.
            if (!isAppVisible()) return;
            scene.render();
        });
        // ResizeObserver on the canvas, NOT window — the canvas
        // changes size when the dock splits / panels collapse / a
        // viewport gets resized without the window itself moving.
        // A window-resize listener would miss every one of those
        // and the engine would keep rendering at its initial
        // drawing-buffer size, stretching it over the now-larger
        // canvas (= the pixelation users saw at Phase 1 launch).
        const ro = new ResizeObserver(() => engine.resize());
        ro.observe(canvas);
        (engine as Engine & { __animResizeOff?: () => void }).__animResizeOff = () => {
            ro.disconnect();
        };

        return { engine, scene, camera, object: null, path: null, player: null, observer: null, cameraObs: null };
    };

    // ── Shared clock + clip state ─────────────────────────────────
    // Lives outside the per-side viewport state because both viewports
    // read from the same fields. The per-frame observer on each side
    // copies `clock.time` into its player and ticks(0) — drift-free
    // sync by construction.
    const clock: ClockState = {
        time: 0,
        playing: false,
        speed: 1,
        loop: true,
        duration: 0,
        fps: 30,
        frameCount: 0,
        targetOffset: 0,
    };
    let sourceClipPath: string | null = null;
    let sourceClipDto: BakedAnimationDTO | null = null;
    /** Memoised retargeted DTO for the target player. Rebuilt when:
     *   - The source clip changes (`loadSourceClip`)
     *   - The target SKN changes (`loadSkn` for 'target', or `swap`)
     *   - The user toggles retarget options (`setRetargetOptions`)
     *
     *  Cached because `retargetAnimation` walks every frame of every
     *  track — a 60-frame, 100-bone clip is 6000 frame writes per
     *  rebuild. Doing that on scrub or play would melt the main
     *  thread. We only rebuild on the three trigger events. */
    let targetClipDto: BakedAnimationDTO | null = null;
    /** In Physics mode, the source clip with physics chains baked onto
     *  the single (source) rig. The source player renders THIS in
     *  Physics mode instead of the raw clip. Null in Retarget mode. */
    let physicsClipDto: BakedAnimationDTO | null = null;
    /** Active editing mode. See {@link AnimStudioMode}. */
    let mode: AnimStudioMode = 'retarget';
    let retargetOptions: RetargetOptions = { ...DEFAULT_RETARGET_OPTIONS };

    // ── Bone mapping ──────────────────────────────────────────────
    // Two-tier storage: `boneMappingAuto` is rebuilt every time the
    // source or target SKL changes (cheap-ish: O(s·t) in fuzzy pass).
    // `boneMappingOverrides` is user-curated and survives SKN swaps
    // — only cleared via `clearBoneOverrides` or implicit re-keying
    // when neither rig has that source bone any more.
    //
    // The "effective" mapping the retarget reads is overrides
    // layered onto auto, recomputed in `recomputeTargetDto`.
    let boneMappingAuto: BoneMapping = new Map();
    const boneMappingOverrides: BoneMapping = new Map();
    /** User-curated per-bone guides keyed by target hash. Each
     *  guide pins the target bone to its parent at a tweakable
     *  XYZ offset — used for the weapon-in-hand case where the
     *  retargeted track produces flailing and a rigid grip with
     *  a manual offset reads better. */
    const guidesByTargetHash = new Map<number, BoneGuide>();
    /** Physics chains by id. Insertion-ordered. */
    const physicsChains = new Map<string, PhysicsChain>();
    /** Sphere / capsule colliders by id. */
    const physicsColliders = new Map<string, PhysicsCollider>();
    /** Maya-style mesh collision config. When enabled, chains collide against
     *  the physics rig's skinned mesh (minus excluded submeshes) with a
     *  thickness shell, in addition to the sphere/capsule colliders. */
    let meshCollision: MeshCollisionConfig = { enabled: false, thickness: 1, excludedMeshes: [] };
    /** Cache the (expensive-to-read) collider bind data so a slider drag
     *  doesn't re-read every vertex buffer — keyed by the rig object + the
     *  excluded-submesh set; thickness is patched in cheaply. */
    let meshColBindCache: { obj: StudioObject; key: string; bind: MeshColliderBind } | null = null;

    // ── Gizmo edit state ─────────────────────────────────────────
    // Per-tab single-edit: at most one guide is being gizmo-edited
    // at a time. State lives here so the scrubber can dock / float
    // the panel without losing the active gizmo, and switching
    // guides cleanly tears down + rebuilds the gizmo.
    let editingGuideHash: number | null = null;
    let editingGuideMode: 'position' | 'rotation' | null = null;
    let gizmoProxyTN: TransformNode | null = null;
    let gizmoManager: GizmoManager | null = null;
    let gizmoUtilityLayer: UtilityLayerRenderer | null = null;
    let gizmoFrameObs: Observer<Scene> | null = null;
    let gizmoIsDragging = false;

    /** Rebuild the auto-mapping from the currently-loaded rigs.
     *  Cheap on small rigs; ~5-20ms on the typical 100-200-bone
     *  League rig, dominated by the Levenshtein scan. */
    const recomputeAutoMapping = () => {
        const sourceObj = sides.source?.object ?? null;
        const targetObj = sides.target?.object ?? null;
        if (!sourceObj?.skn || !targetObj?.skn) {
            boneMappingAuto = new Map();
            return;
        }
        const sourceSkl = {
            name: '', asset_name: '', flags: 0,
            joints: sourceObj.skn.joints,
            influences: [],
        };
        const targetSkl = {
            name: '', asset_name: '', flags: 0,
            joints: targetObj.skn.joints,
            influences: [],
        };
        boneMappingAuto = autoMapBones(sourceSkl, targetSkl);
    };

    /** Recompute the target's retargeted DTO from the current source
     *  clip + current target SKL + current options. Hands the heavy
     *  retarget math off to Babylon's `AnimatorAvatar.retargetAnimationGroup`
     *  (see [../animation/babylonRetarget.ts]); applies our manual
     *  guides on top of Babylon's output. Returns `null` when any
     *  input is missing. */
    const recomputeTargetDto = (
        havokInstance?: HavokInstance | null,
        sourceOverride?: BakedAnimationDTO | null,
        skipPhysics?: boolean,
    ): BakedAnimationDTO | null => {
        // `sourceOverride` lets the batch exporter retarget an arbitrary
        // clip without disturbing the live-preview `sourceClipDto`. When
        // omitted we use the loaded clip as before. `skipPhysics` lets a
        // batch row opt out of the (sometimes slow) physics bake.
        const srcDto = sourceOverride ?? sourceClipDto;
        if (!srcDto) return null;
        const sourceObj = sides.source?.object ?? null;
        const targetObj = sides.target?.object ?? null;
        if (!sourceObj?.skn || !targetObj?.skn) return null;
        const targetScene = sides.target?.scene ?? null;
        if (!targetScene) return null;

        // Build the source→target name map from the auto-mapping +
        // user overrides. Babylon's retargeter does its own name
        // matching but we feed our overrides so manual mappings
        // (e.g. user redirects L_Hand → R_Wrist) take effect.
        const effectiveMapping = applyOverrides(boneMappingAuto, boneMappingOverrides);
        const targetNameByHash = new Map<number, string>();
        for (const j of targetObj.skn.joints) targetNameByHash.set(j.name_hash, j.name);
        const sourceNameByHash = new Map<number, string>();
        for (const j of sourceObj.skn.joints) sourceNameByHash.set(j.name_hash, j.name);
        const mapNodeNames = new Map<string, string>();
        // Build the set of target bone names for the mirror swap
        // lookup — we want to confirm an L/R counterpart actually
        // exists before redirecting.
        const targetNames = new Set(targetObj.skn.joints.map(j => j.name));
        const mirrorPartnerName = (name: string): string | null => {
            const lower = name.toLowerCase();
            if (lower.startsWith('l_')) {
                const partner = 'R' + name.slice(1); // preserve original case past the prefix
                return targetNames.has(partner) ? partner : null;
            }
            if (lower.startsWith('r_')) {
                const partner = 'L' + name.slice(1);
                return targetNames.has(partner) ? partner : null;
            }
            return null;
        };
        for (const [srcHash, entry] of effectiveMapping) {
            const srcName = sourceNameByHash.get(srcHash);
            if (!srcName) continue;
            if (entry === 'ignore') continue; // ignored bones get no map entry → Babylon won't drive them
            if (typeof entry !== 'number') continue;
            let tgtName = targetNameByHash.get(entry);
            if (!tgtName) continue;
            // Mirror: redirect source L_* tracks to target R_*
            // counterparts (and vice versa) when one exists.
            if (retargetOptions.mirror) {
                const mirrored = mirrorPartnerName(tgtName);
                if (mirrored) tgtName = mirrored;
            }
            if (srcName === tgtName) continue; // identity mapping is implicit
            mapNodeNames.set(srcName, tgtName);
        }

        let dto = retargetViaBabylon(
            srcDto,
            sourceObj.skn.joints,
            targetObj,
            targetScene,
            {
                rebaseRotations: retargetOptions.rebaseRotations,
                fixRootPosition: retargetOptions.rescaleTranslations,
                fixGroundReference: retargetOptions.fixGroundReference
                    && retargetOptions.groundReferenceNodeName !== '',
                fixGroundReferenceDynamic: retargetOptions.fixGroundReferenceDynamicRefNode,
                fixAnimations: retargetOptions.fixAnimations,
                // Babylon's `checkHierarchy` drops bones whose parent
                // names differ between source and target — direct
                // replacement for our old `dropMismatchedParents`.
                checkHierarchy: retargetOptions.dropMismatchedParents,
                rootNodeName: retargetOptions.rootNodeName,
                groundReferenceNodeName: retargetOptions.groundReferenceNodeName,
                groundReferenceVerticalAxis: retargetOptions.groundReferenceVerticalAxis,
                mapNodeNames,
            },
        );
        if (!dto) return null;

        // Strip root motion: zero out root translation track if the
        // user asked for it. Done post-retarget so it works on
        // whichever rig topology Babylon produced.
        if (retargetOptions.stripRootMotion) {
            for (const t of dto.tracks) {
                const name = targetNameByHash.get(t.joint_hash);
                if (name && name.toLowerCase() === 'root') {
                    const bind = targetObj.skn.joints.find(j => j.name_hash === t.joint_hash);
                    if (bind) {
                        for (const f of t.frames) {
                            f.translation = [...bind.local_translation] as [number, number, number];
                        }
                    }
                }
            }
        }

        // Lock bone lengths: force every non-root bone's translation +
        // scale back to the TARGET rig's bind values, keeping only the
        // retargeted rotation. Babylon passes the source clip's
        // translation/scale through, so a skin-to-skin retarget otherwise
        // drags each bone to the SOURCE skin's proportions and the mesh
        // shears (the "squished / stretched shoulders" report). Locking to
        // target bind keeps every bone at its own rig's proportions. Root
        // is skipped so locomotion survives. Runs before guides / physics
        // so those still take precedence on the bones they touch.
        if (retargetOptions.lockBoneLengths) {
            const rootName = (retargetOptions.rootNodeName || 'Root').toLowerCase();
            const bindByHash = new Map<number, import('./skeletonBuilder').SklJointDTO>();
            for (const j of targetObj.skn.joints) bindByHash.set(j.name_hash, j);
            for (const t of dto.tracks) {
                const name = targetNameByHash.get(t.joint_hash);
                if (name && name.toLowerCase() === rootName) continue; // keep root locomotion
                const bind = bindByHash.get(t.joint_hash);
                if (!bind) continue;
                const bt = bind.local_translation as [number, number, number];
                const bs = bind.local_scale as [number, number, number];
                for (const f of t.frames) {
                    f.translation = [bt[0], bt[1], bt[2]];
                    f.scale = [bs[0], bs[1], bs[2]];
                }
            }
        }

        // Apply user-set per-bone guides on top of Babylon's
        // retargeted output. Each guide strips its target bone's
        // animation and pins it to a "follow" bone with an XYZ
        // offset in that follow bone's frame. The follow bone is
        // either the bone's SKL parent (default) or any user-
        // specified target bone (e.g. weapon → L_Hand).
        //
        // The math walks the retargeted skeleton hierarchically
        // per frame:
        //   1. Compose every bone's animated world TRS from the
        //      retargeted local TRS chained through its parent.
        //   2. For each guided bone, compute the desired world TRS:
        //        worldRot   = followBone.worldRot · bind.localRot
        //        worldTrans = followBone.worldPos
        //                   + followBone.worldRot · (bind.localTrans + offset)
        //   3. Convert back to local against the guided bone's
        //      actual SKL parent so the runtime player can apply
        //      it in the normal way:
        //        local = parent.worldRot⁻¹ · world
        //
        // When `followBoneHash` equals the SKL parent (the
        // default case), follow and parent are the same, the math
        // collapses to "bind rotation + (bind translation + offset)
        // in the parent's frame" — same as the original guide
        // semantics. When the user picks a different follow bone,
        // the guided bone tracks that bone's animated motion
        // instead.
        if (guidesByTargetHash.size > 0) {
            applyGuidesWorldSpace(
                dto,
                targetObj.skn.joints,
                Array.from(guidesByTargetHash.values()),
            );
        }

        // Bake physics chains last. They consume the (guide-adjusted)
        // anchor bone motion, so guides on the chain root work
        // correctly — e.g. pin Cape_Root to the spine via a guide,
        // then let the rest of the cape swing.
        //
        // Chains are split by solver. The simple spring solver always
        // runs synchronously. Havok chains run only when a fresh WASM
        // instance is supplied (the async overlay in `rebakeTarget`);
        // otherwise they fall through to the simple solver as a live
        // placeholder until the Havok bake lands.
        if (physicsChains.size > 0 && !skipPhysics) {
            const allColliders = Array.from(physicsColliders.values());
            const all = Array.from(physicsChains.values());
            const havokChains = all.filter(c => c.solver === 'havok');
            const simpleChains = havokInstance
                ? all.filter(c => c.solver !== 'havok')
                : all; // no instance yet → bake everything simple
            if (simpleChains.length > 0) {
                applyPhysicsChains(dto, targetObj.skn.joints, simpleChains, allColliders, buildMeshCollider());
            }
            if (havokInstance && havokChains.length > 0) {
                applyPhysicsChainsHavok(dto, targetObj.skn.joints, havokChains, allColliders, havokInstance);
            }
        }

        return dto;
    };

    /** Physics-mode recompute: bake the current physics chains directly
     *  onto the single (source) rig, with NO retargeting. Clones the
     *  source clip so the raw DTO is never mutated. `sourceOverride`
     *  lets the batch exporter bake an arbitrary disk clip without
     *  disturbing the live preview. Mirrors the physics tail of
     *  `recomputeTargetDto`, just against the source rig. */
    const recomputePhysicsDto = (
        havokInstance?: HavokInstance | null,
        sourceOverride?: BakedAnimationDTO | null,
        skipPhysics?: boolean,
    ): BakedAnimationDTO | null => {
        const srcDto = sourceOverride ?? sourceClipDto;
        if (!srcDto) return null;
        const rigObj = sides.source?.object ?? null;
        if (!rigObj?.skn) return null;
        // Deep clone — applyPhysicsChains mutates track frames in place
        // and appends stub tracks; the source clip must stay pristine so
        // the raw-vs-physics comparison and re-bakes stay correct.
        const dto = structuredClone(srcDto) as BakedAnimationDTO;
        if (physicsChains.size > 0 && !skipPhysics) {
            const allColliders = Array.from(physicsColliders.values());
            const all = Array.from(physicsChains.values());
            const havokChains = all.filter(c => c.solver === 'havok');
            const simpleChains = havokInstance
                ? all.filter(c => c.solver !== 'havok')
                : all; // no instance yet → bake everything simple
            if (simpleChains.length > 0) {
                applyPhysicsChains(dto, rigObj.skn.joints, simpleChains, allColliders, buildMeshCollider());
            }
            if (havokInstance && havokChains.length > 0) {
                applyPhysicsChainsHavok(dto, rigObj.skn.joints, havokChains, allColliders, havokInstance);
            }
        }
        return dto;
    };
    /** Real-time wall clock at the previous tick. The shared advance
     *  uses `performance.now()` rather than each engine's delta so
     *  both sides see the exact same clock — engines drift slightly
     *  in their own `getDeltaTime` between frames. */
    let lastWallTimeMs: number | null = null;

    const attachCanvas = (side: AnimStudioSide, canvas: HTMLCanvasElement) => {
        const existing = sides[side];
        if (existing && existing.engine.getRenderingCanvas() === canvas) return;
        if (existing) {
            disposeViewport(existing);
            sides[side] = null;
        }
        const vp = buildViewport(canvas);
        sides[side] = vp;
        // Wire camera mirroring. Each side's camera, on view-matrix
        // change, copies its TRS to the other side. `suspendCameraSync`
        // breaks the feedback loop while we're applying the mirrored
        // state (otherwise A → B would re-fire B's observable → A → …).
        const other: AnimStudioSide = side === 'source' ? 'target' : 'source';
        vp.cameraObs = vp.camera.onViewMatrixChangedObservable.add(() => {
            if (!cameraLink || suspendCameraSync) return;
            const dstVp = sides[other];
            if (!dstVp) return;
            const srcCam = vp.camera;
            const dstCam = dstVp.camera;
            suspendCameraSync = true;
            try {
                dstCam.setTarget(srcCam.target.clone());
                dstCam.alpha = srcCam.alpha;
                dstCam.beta = srcCam.beta;
                dstCam.radius = srcCam.radius;
            } finally {
                // Defer re-enable so any cascading observable fires
                // from the dstCam writes don't re-trigger us.
                queueMicrotask(() => { suspendCameraSync = false; });
            }
        });
        emit();
    };

    // ── Camera link state ──────────────────────────────────────────
    // Default-on per user request. Persisted to localStorage so the
    // user's preference survives across sessions / tabs.
    let cameraLink = true;
    let suspendCameraSync = false;
    try {
        const raw = window.localStorage.getItem('anim-studio-camera-link');
        if (raw !== null) cameraLink = raw === '1';
    } catch { /* ignore */ }

    const setCameraLink = (linked: boolean) => {
        if (cameraLink === linked) return;
        cameraLink = linked;
        try { window.localStorage.setItem('anim-studio-camera-link', linked ? '1' : '0'); } catch { /* ignore */ }
        // Snap the target side to the source on enable so the two
        // viewports start aligned instead of jumping on first move.
        if (linked) {
            const src = sides.source;
            const tgt = sides.target;
            if (src && tgt) {
                suspendCameraSync = true;
                try {
                    tgt.camera.setTarget(src.camera.target.clone());
                    tgt.camera.alpha = src.camera.alpha;
                    tgt.camera.beta = src.camera.beta;
                    tgt.camera.radius = src.camera.radius;
                } finally {
                    queueMicrotask(() => { suspendCameraSync = false; });
                }
            }
        }
        emit();
    };
    const getCameraLink = () => cameraLink;

    const disposeViewport = (vp: ViewportState) => {
        if (vp.cameraObs) {
            try { vp.camera.onViewMatrixChangedObservable.remove(vp.cameraObs); } catch { /* ignore */ }
            vp.cameraObs = null;
        }
        try { vp.object?.dispose(); } catch { /* ignore */ }
        const off = (vp.engine as Engine & { __animResizeOff?: () => void }).__animResizeOff;
        off?.();
        try { vp.scene.dispose(); } catch { /* ignore */ }
        try { vp.engine.dispose(); } catch { /* ignore */ }
    };

    /** Walk the loaded object's meshes, take the local-space bounds,
     *  shift them so the floor sits at Y=0, and frame the camera on
     *  the centre with Photo Studio's exact heuristics:
     *    - Y-weighted radius (`max(height·1.4, width, depth)`) so
     *      tall+winged silhouettes don't get squashed by a flat max.
     *    - Standard alpha/beta so every freshly-loaded model lands
     *      at the same 3/4 angle Photo Studio uses (was previously
     *      preserving whatever camera angle was lying around from
     *      a prior model, which often pointed at the floor).
     *    - lowerRadiusLimit / upperRadiusLimit scaled so zoom feels
     *      right regardless of rig size. */
    const frameCameraOn = (vp: ViewportState) => {
        const obj = vp.object;
        if (!obj) {
            vp.camera.setTarget(Vector3.Zero());
            vp.camera.alpha = Math.PI / 2 + Math.PI / 8;
            vp.camera.beta = Math.PI / 2 - Math.PI / 8;
            vp.camera.radius = 8;
            return;
        }
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const m of obj.meshes) {
            m.computeWorldMatrix(true);
            m.refreshBoundingInfo({});
            const bb = m.getBoundingInfo().boundingBox;
            const lo = bb.minimum;
            const hi = bb.maximum;
            if (lo.x < minX) minX = lo.x;
            if (lo.y < minY) minY = lo.y;
            if (lo.z < minZ) minZ = lo.z;
            if (hi.x > maxX) maxX = hi.x;
            if (hi.y > maxY) maxY = hi.y;
            if (hi.z > maxZ) maxZ = hi.z;
        }
        const finite = (n: number) => Number.isFinite(n) ? n : 0;
        minX = finite(minX); minY = finite(minY); minZ = finite(minZ);
        maxX = finite(maxX); maxY = finite(maxY); maxZ = finite(maxZ);

        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;

        // Lift below-floor meshes so the model stands on Y=0 instead
        // of hovering / sinking — same trick Photo Studio uses.
        const yShift = minY < 0 ? -minY : 0;
        if (yShift !== 0) {
            for (const m of obj.meshes) m.position.y = yShift;
        }

        const target = new Vector3(
            (minX + maxX) / 2,
            (minY + maxY) / 2 + yShift,
            (minZ + maxZ) / 2,
        );
        const radius = Math.max(sizeY * 1.4, sizeX, sizeZ) || 5;

        vp.camera.setTarget(target);
        vp.camera.alpha = Math.PI / 2 + Math.PI / 8;
        vp.camera.beta = Math.PI / 2 - Math.PI / 8;
        vp.camera.radius = radius;
        vp.camera.lowerRadiusLimit = radius * 0.1;
        vp.camera.upperRadiusLimit = radius * 8;
    };

    /** Tear down a side's `AnimationPlayer` + the per-frame observer
     *  that was driving it. Used when clearing a side, swapping the
     *  SKN out from under a live clip, or unloading the clip. */
    const detachPlayer = (vp: ViewportState) => {
        if (vp.observer) {
            vp.scene.onBeforeRenderObservable.remove(vp.observer);
            vp.observer = null;
        }
        vp.player = null;
    };

    /** Build an `AnimationPlayer` for one side against the current
     *  source clip DTO and wire its per-frame observer. No-op when
     *  the side has no SKN or no clip is loaded. The player runs in
     *  paused mode — its `time` is driven by `clock.time`, not its
     *  own clock — so calling `tick(0)` each frame just applies the
     *  pose for the shared time.
     *
     *  Per-side DTO selection:
     *   - 'source' → the raw clip DTO (plays on the rig it was
     *     authored against, no transform).
     *   - 'target' → the retargeted DTO (rescale + rebase as
     *     configured). Falls back to the raw DTO when no target SKN
     *     is loaded (shouldn't happen — caller gates on `vp.object`
     *     existing — but defensive). */
    const attachPlayer = (vp: ViewportState, side: AnimStudioSide) => {
        detachPlayer(vp);
        if (!sourceClipDto || !vp.object || !vp.object.skn) return;
        // Physics mode: the single (source) viewport renders the
        // physics-baked clip. Retarget mode: source plays the raw clip,
        // target plays the retargeted DTO.
        const dto = mode === 'physics'
            ? (physicsClipDto ?? sourceClipDto)
            : side === 'target'
                ? (targetClipDto ?? sourceClipDto)
                : sourceClipDto;
        const player = new AnimationPlayer(
            dto,
            vp.object.skn.boneIndexByHash,
            vp.object.skn.bones,
            vp.object.skn.joints,
        );
        player.paused = true; // shared clock drives time, not the player
        vp.player = player;
        vp.observer = vp.scene.onBeforeRenderObservable.add(() => {
            // Copy the shared clock's time into the player and tick
            // by zero so the player re-applies the pose at the new
            // time without advancing on its own.
            //
            // The target side adds the A/B offset and wraps into
            // [0, duration). Source side ignores the offset — it
            // always shows the canonical clock time so the user
            // has an anchor.
            let t = clock.time;
            if (side === 'target' && clock.targetOffset !== 0 && clock.duration > 0) {
                t += clock.targetOffset;
                t = t % clock.duration;
                if (t < 0) t += clock.duration;
            }
            player.time = t;
            player.tick(0);
        });
    };

    /** Advance the shared clock. Driven by a single requestAnimation
     *  Frame loop (set up below in `dispose`'s siblings) — NOT by the
     *  scenes' per-render observers, because each scene fires at its
     *  own cadence and we want one canonical clock. */
    const tickClock = () => {
        // While the app is hidden, freeze the clock entirely. Null
        // the wall-time anchor so the first tick after returning
        // doesn't try to apply the accumulated real-world dt as
        // animation time — without this, the clip would jump
        // forward by however long the user was away.
        if (!isAppVisible()) {
            lastWallTimeMs = null;
            return;
        }
        const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const prev = lastWallTimeMs;
        lastWallTimeMs = nowMs;
        if (!clock.playing || clock.duration <= 0 || prev === null) return;
        // Clamp dt the same way AnimationPlayer does — backgrounded
        // tabs / GC pauses send huge dt values that would skip frames.
        const rawDt = (nowMs - prev) / 1000;
        const dt = Math.min(Math.max(rawDt, 0), 0.05) * clock.speed;
        let t = clock.time + dt;
        if (clock.loop) {
            // Modulo onto [0, duration). `t = t % d` handles the
            // common positive case; the `< 0` guard catches reverse
            // playback if `speed` ever goes negative in the future.
            t = t % clock.duration;
            if (t < 0) t += clock.duration;
        } else {
            if (t >= clock.duration) {
                t = clock.duration;
                clock.playing = false;
                emit();
            }
            if (t < 0) t = 0;
        }
        clock.time = t;
    };

    // Drive the clock from a single rAF loop. Browser-level, not
    // engine-level, so the source/target render observers don't fight
    // over who "owns" the timeline.
    let rafId: number | null = null;
    const clockLoop = () => {
        tickClock();
        rafId = (typeof requestAnimationFrame !== 'undefined')
            ? requestAnimationFrame(clockLoop)
            : null;
    };
    if (typeof requestAnimationFrame !== 'undefined') {
        rafId = requestAnimationFrame(clockLoop);
    }

    const loadSkn = async (side: AnimStudioSide, path: string) => {
        const vp = sides[side];
        if (!vp) {
            throw new Error(`Animation Studio: ${side} viewport not yet attached to a canvas`);
        }
        // Drop the previous model + its player. The clip stays
        // loaded so swapping a SKN under a live clip doesn't force
        // the user to re-pick the ANM.
        if (vp.object) {
            detachPlayer(vp);
            // If we were gizmo-editing a guide on this target,
            // the underlying bone is about to be disposed — tear
            // the gizmo down before that happens.
            if (side === 'target' && editingGuideHash !== null) {
                disposeGizmo();
                editingGuideHash = null;
                editingGuideMode = null;
            }
            try { vp.object.dispose(); } catch { /* ignore */ }
            vp.object = null;
            vp.path = null;
            emit();
        }
        const obj = await createSknObject(vp.scene, path);
        vp.object = obj;
        vp.path = path;
        frameCameraOn(vp);
        // Re-attach a player if there's already a clip loaded — the
        // new SKN gets driven by it immediately, which is exactly
        // what users expect after a "swap" or "open as <side>".
        // Rig changed on either side → auto-mapping is stale.
        // Recompute it before the DTO refresh so the new mapping
        // feeds into the player rebuild on the same tick.
        recomputeAutoMapping();
        if (sourceClipDto) {
            // Changing either SKN invalidates the cached target DTO
            // (its retarget depended on the swapped-out joints).
            // Recompute before rebuilding the target player.
            targetClipDto = recomputeTargetDto();
            attachPlayer(vp, side);
            scheduleHavokOverlay();
        }
        // Re-apply the world-Y lift on the new target. Doing it
        // here rather than letting the option-setter trigger it
        // means a SKN swap (or a scene reload from disk) restores
        // the persisted offset without the user needing to nudge
        // the input.
        if (side === 'target') {
            const tobj = vp.object;
            if (tobj) tobj.root.position.y = retargetOptions.verticalOffset;
        }
        emit();
        // Structural change (a rig was loaded/swapped on this side).
        // No-ops under `suspendUndo` (swap / loadFromData drive it).
        commitUndoStep();
    };

    const loadSourceClip = async (anmPath: string) => {
        const baked = await loadDiskAnimation(anmPath);
        sourceClipPath = anmPath;
        sourceClipDto = baked;
        clock.duration = baked.duration;
        clock.fps = baked.fps;
        clock.frameCount = baked.frame_count;
        clock.time = 0;
        clock.playing = true; // auto-play on load — matches Photo Studio's behavior
        // New clip → recompute the DTO the active mode renders, then
        // build the players. Retarget mode: source plays the raw clip,
        // target plays the retargeted version. Physics mode: source
        // plays the physics-baked clip. (Auto-mapping is keyed off the
        // rigs, not the clip — it's already current.)
        targetClipDto = recomputeTargetDto();
        physicsClipDto = mode === 'physics' ? recomputePhysicsDto(null) : null;
        if (sides.source) attachPlayer(sides.source, 'source');
        if (sides.target) attachPlayer(sides.target, 'target');
        scheduleHavokOverlay();
        emit();
        // Loading a clip is a structural change. No-ops under
        // `suspendUndo` (loadFromData drives it during a scene restore).
        commitUndoStep();
        return {
            duration: baked.duration,
            fps: baked.fps,
            frameCount: baked.frame_count,
            sourceMatched: sides.source?.player?.matchedTrackCount ?? 0,
            targetMatched: sides.target?.player?.matchedTrackCount ?? 0,
        };
    };

    // ── Bone mapping API ──────────────────────────────────────────
    const getBoneMappingRows = (): MappingRow[] => {
        const sourceObj = sides.source?.object ?? null;
        const targetObj = sides.target?.object ?? null;
        if (!sourceObj?.skn || !targetObj?.skn) return [];
        const sourceSkl = {
            name: '', asset_name: '', flags: 0,
            joints: sourceObj.skn.joints,
            influences: [],
        };
        const targetSkl = {
            name: '', asset_name: '', flags: 0,
            joints: targetObj.skn.joints,
            influences: [],
        };
        return buildMappingRows(
            sourceSkl, targetSkl, boneMappingAuto, boneMappingOverrides,
        );
    };

    const getTargetJoints = () => {
        const targetObj = sides.target?.object ?? null;
        if (!targetObj?.skn) return [];
        return targetObj.skn.joints
            .map(j => ({ hash: j.name_hash, name: j.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    };

    /** Mesh names on the target object in load order. Used by the
     *  vertical-offset exclusion UI so the user can pick which
     *  submeshes get the lift. League SKNs typically expose 3-10
     *  submeshes (body, head, weapon, cape, etc.) so we don't
     *  need pagination. */
    const getTargetMeshNames = (): string[] => {
        const obj = sides.target?.object ?? null;
        if (!obj) return [];
        return obj.meshes.map(m => m.name);
    };

    const getSourceJointNames = (): string[] => {
        const sourceObj = sides.source?.object ?? null;
        if (!sourceObj?.skn) return [];
        return sourceObj.skn.joints.map(j => j.name).sort((a, b) => a.localeCompare(b));
    };

    const setBoneOverride = (sourceHash: number, entry: MappingEntry | null) => {
        if (entry === null) {
            if (!boneMappingOverrides.has(sourceHash)) return;
            boneMappingOverrides.delete(sourceHash);
        } else {
            const existing = boneMappingOverrides.get(sourceHash);
            if (existing === entry) return;
            boneMappingOverrides.set(sourceHash, entry);
        }
        // The mapping change only affects the target — source plays
        // the raw clip unaffected. Rebuild the target DTO + player.
        if (sourceClipDto && sides.target) {
            targetClipDto = recomputeTargetDto();
            attachPlayer(sides.target, 'target');
            scheduleHavokOverlay();
        }
        commitUndoStep();
    };

    const clearBoneOverrides = () => {
        if (boneMappingOverrides.size === 0) return;
        boneMappingOverrides.clear();
        if (sourceClipDto && sides.target) {
            targetClipDto = recomputeTargetDto();
            attachPlayer(sides.target, 'target');
            scheduleHavokOverlay();
        }
        commitUndoStep();
    };

    // ── Guides API ────────────────────────────────────────────────
    const getGuides = (): BoneGuide[] => {
        // Sort by target bone name so the panel renders deterministic
        // order even after a setGuide / removeGuide.
        const targetObj = sides.target?.object ?? null;
        const nameByHash = new Map<number, string>();
        if (targetObj?.skn) {
            for (const j of targetObj.skn.joints) {
                nameByHash.set(j.name_hash, j.name);
            }
        }
        return Array.from(guidesByTargetHash.values())
            .slice()
            .sort((a, b) => {
                const an = nameByHash.get(a.targetBoneHash) ?? '';
                const bn = nameByHash.get(b.targetBoneHash) ?? '';
                return an.localeCompare(bn);
            });
    };

    // Generation counter so a slow async Havok bake that resolves after
    // the user has changed something again is discarded instead of
    // clobbering newer state.
    let havokBakeGen = 0;

    /** If any chain uses the Havok solver, overlay a deterministic Havok
     *  bake asynchronously on a FRESH WASM instance (the spike proved a
     *  reused instance drifts). Until it lands, the sync pass shows a
     *  simple-solver placeholder. Generation-guarded so a stale bake
     *  can't clobber newer state. Call this after any sync
     *  `recomputeTargetDto(null)` that set `targetClipDto`. */
    const scheduleHavokOverlay = () => {
        const havokChains = Array.from(physicsChains.values()).filter(c => c.solver === 'havok');
        if (havokChains.length === 0) { havokBakeGen++; return; }
        const gen = ++havokBakeGen;
        loadFreshHavok().then((havok) => {
            if (gen !== havokBakeGen) return; // superseded by a newer bake
            if (!sourceClipDto) return;
            try {
                if (mode === 'physics') {
                    if (!sides.source) return;
                    physicsClipDto = recomputePhysicsDto(havok);
                    attachPlayer(sides.source, 'source');
                } else {
                    if (!sides.target) return;
                    targetClipDto = recomputeTargetDto(havok);
                    attachPlayer(sides.target, 'target');
                }
                emit();
            } catch (err) {
                console.error('[havok] bake failed — keeping simple solver result:', err);
            }
        }).catch((e) => {
            // WASM failed to load — keep the simple-solver placeholder.
            console.error('[havok] physics WASM failed to load, using simple solver:', e);
        });
    };

    const rebakeTarget = () => {
        if (sourceClipDto && sides.target) {
            // Sync pass: simple solver for everything (Havok chains show
            // a simple-solver placeholder until their bake lands).
            targetClipDto = recomputeTargetDto(null);
            attachPlayer(sides.target, 'target');
            scheduleHavokOverlay();
        }
        emit();
    };

    /** Physics-mode counterpart of `rebakeTarget`: re-bake physics onto
     *  the single (source) rig and re-render the source viewport. */
    const rebakePhysics = () => {
        if (sourceClipDto && sides.source) {
            physicsClipDto = recomputePhysicsDto(null);
            attachPlayer(sides.source, 'source');
            scheduleHavokOverlay();
        }
        emit();
    };

    /** Re-bake whichever DTO the active mode renders. Physics chain /
     *  collider edits route through here so they take effect in both
     *  modes. */
    const rebake = () => {
        if (mode === 'physics') rebakePhysics();
        else rebakeTarget();
    };

    const setGuide = (guide: BoneGuide) => {
        const existing = guidesByTargetHash.get(guide.targetBoneHash);
        if (existing
            && existing.offsetX === guide.offsetX
            && existing.offsetY === guide.offsetY
            && existing.offsetZ === guide.offsetZ
            && (existing.followBoneHash ?? null) === (guide.followBoneHash ?? null)
            && (existing.rotX ?? 0) === (guide.rotX ?? 0)
            && (existing.rotY ?? 0) === (guide.rotY ?? 0)
            && (existing.rotZ ?? 0) === (guide.rotZ ?? 0)) {
            return;
        }
        guidesByTargetHash.set(guide.targetBoneHash, { ...guide });
        rebakeTarget();
        // Coalesce per-guide so dragging an offset / rotation slider (or
        // the gizmo) collapses to a single undo step.
        commitUndoStep(`guide:${guide.targetBoneHash}`);
    };

    const removeGuide = (targetBoneHash: number) => {
        if (!guidesByTargetHash.delete(targetBoneHash)) return;
        // If we were editing this guide via gizmo, tear that down.
        if (editingGuideHash === targetBoneHash) {
            setEditingGuide(null, null);
        }
        rebakeTarget();
        commitUndoStep();
    };

    // ── Editing mode ──────────────────────────────────────────────
    const getMode = (): AnimStudioMode => mode;
    const getPhysicsRigSide = (): AnimStudioSide => (mode === 'physics' ? 'source' : 'target');
    const getPhysicsJoints = (): Array<{ hash: number; name: string }> => {
        const obj = sides[getPhysicsRigSide()]?.object ?? null;
        if (!obj?.skn) return [];
        return obj.skn.joints
            .map(j => ({ hash: j.name_hash, name: j.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    };
    const setMode = (next: AnimStudioMode) => {
        if (next === mode) return;
        mode = next;
        // Recompute + reattach the players for the new mode. Both DTOs
        // are refreshed defensively so switching back and forth never
        // leaves a stale preview.
        if (sourceClipDto) {
            targetClipDto = sides.target ? recomputeTargetDto(null) : null;
            physicsClipDto = mode === 'physics' ? recomputePhysicsDto(null) : null;
            if (sides.source) attachPlayer(sides.source, 'source');
            if (sides.target) attachPlayer(sides.target, 'target');
            scheduleHavokOverlay();
        }
        // Physics moved to the other viewport — re-point the collider
        // overlay if it's showing.
        rebindColliderVis();
        emit();
        commitUndoStep();
    };

    const bakePhysicsClipForExport = async (
        anmPath: string,
    ): Promise<BakedAnimationDTO | null> => {
        const srcDto = await loadDiskAnimation(anmPath);
        if (!srcDto) return null;
        const needsHavok = Array.from(physicsChains.values()).some(c => c.solver === 'havok');
        let havok: HavokInstance | null = null;
        if (needsHavok) {
            try { havok = await loadFreshHavok(); } catch { havok = null; }
        }
        return recomputePhysicsDto(havok, srcDto, false);
    };

    // ── Physics chains + colliders ────────────────────────────────
    const getPhysicsChains = (): PhysicsChain[] => Array.from(physicsChains.values()).map(c => ({
        ...c,
        boneHashes: [...c.boneHashes],
    }));
    const setPhysicsChain = (chain: PhysicsChain) => {
        if (!chain.id) return;
        physicsChains.set(chain.id, {
            ...chain,
            boneHashes: [...chain.boneHashes],
        });
        rebake();
        // Coalesce per-chain so dragging a stiffness / gravity slider is
        // one undo step rather than dozens.
        commitUndoStep(`chain:${chain.id}`);
    };
    const removePhysicsChain = (id: string) => {
        if (!physicsChains.delete(id)) return;
        rebake();
        commitUndoStep();
    };
    const getPhysicsColliders = (): PhysicsCollider[] => Array.from(physicsColliders.values()).map(c => ({ ...c }));
    const setPhysicsCollider = (col: PhysicsCollider) => {
        if (!col.id) return;
        physicsColliders.set(col.id, { ...col });
        rebake();
        commitUndoStep(`collider:${col.id}`);
    };
    const removePhysicsCollider = (id: string) => {
        if (!physicsColliders.delete(id)) return;
        rebake();
        commitUndoStep();
    };

    /** Auto-generate body colliders from the physics rig's mesh — the same
     *  idea as an Unreal "Physics Asset": group the skinned vertices by their
     *  dominant bone and fit a capsule (bone → child, radius = how far the
     *  skin sits off the bone axis) or a sphere (leaf bones) to each. Gives
     *  mesh-shaped body collision that rides the animation for free, without
     *  hand-placing spheres. Skips bones that are part of a physics chain (so
     *  the hair doesn't collide with itself) and dedupes against existing
     *  colliders. Returns how many were added. */
    const generateCollidersFromMesh = (): number => {
        const obj = sides[getPhysicsRigSide()]?.object ?? null;
        if (!obj?.skn) return 0;
        const joints = obj.skn.joints;
        const nj = joints.length;
        if (nj === 0) return 0;

        // Bind-pose world position of every joint (skeleton space — the same
        // space the mesh's bind vertex positions live in, and that the solver
        // composes collision in).
        const bindPos: Vec3[] = new Array(nj);
        const bindRot: Quat[] = new Array(nj);
        for (let i = 0; i < nj; i++) {
            const j = joints[i];
            const lt = j.local_translation as Vec3;
            const lr = j.local_rotation as Quat;
            if (j.parent_id < 0 || j.parent_id >= i) {
                bindPos[i] = [lt[0], lt[1], lt[2]];
                bindRot[i] = [lr[0], lr[1], lr[2], lr[3]];
            } else {
                const pr = bindRot[j.parent_id];
                const pp = bindPos[j.parent_id];
                bindRot[i] = quatMul(pr, lr);
                const r = quatRotateVec3(pr, lt);
                bindPos[i] = [pp[0] + r[0], pp[1] + r[1], pp[2] + r[2]];
            }
        }
        const childrenOf = new Map<number, number[]>();
        for (let i = 0; i < nj; i++) {
            const p = joints[i].parent_id;
            if (p >= 0 && p < nj) {
                const arr = childrenOf.get(p);
                if (arr) arr.push(i); else childrenOf.set(p, [i]);
            }
        }

        // Gather each vertex under its dominant (highest-weight) bone.
        const pointsByBone = new Map<number, number[]>();
        for (const mesh of obj.meshes) {
            const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
            const mi = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
            const mw = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
            if (!pos || !mi || !mw) continue;
            const vcount = (pos.length / 3) | 0;
            for (let v = 0; v < vcount; v++) {
                let best = 0, bestW = -1;
                for (let k = 0; k < 4; k++) {
                    const w = mw[v * 4 + k];
                    if (w > bestW) { bestW = w; best = mi[v * 4 + k] | 0; }
                }
                if (best < 0 || best >= nj) continue;
                let arr = pointsByBone.get(best);
                if (!arr) { arr = []; pointsByBone.set(best, arr); }
                arr.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
            }
        }

        // Bones already used by a physics chain — don't collide hair with itself.
        const chainBones = new Set<number>();
        for (const c of physicsChains.values()) {
            for (const h of c.boneHashes) {
                const idx = obj.skn.boneIndexByHash.get(h);
                if (idx !== undefined) chainBones.add(idx);
            }
        }
        const existing = new Set<string>();
        for (const c of physicsColliders.values()) existing.add(`${c.boneHash}:${c.boneHashB ?? ''}`);

        // Robust radius: a high percentile of the spread, so a few stray verts
        // don't inflate the capsule but it still wraps the bulk of the skin.
        const pct = (vals: number[], p: number): number => {
            if (vals.length === 0) return 0;
            vals.sort((x, y) => x - y);
            const i = Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))));
            return vals[i];
        };
        const MIN_VERTS = 24;
        let added = 0;
        for (const [boneIdx, flat] of pointsByBone) {
            if (chainBones.has(boneIdx)) continue;
            const cnt = (flat.length / 3) | 0;
            if (cnt < MIN_VERTS) continue;
            const Pa = bindPos[boneIdx];
            // Prefer to span to the longest non-chain child bone → a capsule.
            let childIdx = -1, bestLen = 0;
            for (const k of childrenOf.get(boneIdx) ?? []) {
                if (chainBones.has(k)) continue;
                const dx = bindPos[k][0] - Pa[0], dy = bindPos[k][1] - Pa[1], dz = bindPos[k][2] - Pa[2];
                const L = Math.hypot(dx, dy, dz);
                if (L > bestLen) { bestLen = L; childIdx = k; }
            }
            let radius: number;
            let boneHashB: number | undefined;
            if (childIdx >= 0 && bestLen > 1e-3) {
                const Pb = bindPos[childIdx];
                const ux = (Pb[0] - Pa[0]) / bestLen, uy = (Pb[1] - Pa[1]) / bestLen, uz = (Pb[2] - Pa[2]) / bestLen;
                const perps: number[] = new Array(cnt);
                for (let vi = 0; vi < cnt; vi++) {
                    const vx = flat[vi * 3] - Pa[0], vy = flat[vi * 3 + 1] - Pa[1], vz = flat[vi * 3 + 2] - Pa[2];
                    const t = vx * ux + vy * uy + vz * uz;
                    const px = vx - t * ux, py = vy - t * uy, pz = vz - t * uz;
                    perps[vi] = Math.hypot(px, py, pz);
                }
                radius = pct(perps, 0.8);
                boneHashB = joints[childIdx].name_hash;
            } else {
                const dists: number[] = new Array(cnt);
                for (let vi = 0; vi < cnt; vi++) {
                    const vx = flat[vi * 3] - Pa[0], vy = flat[vi * 3 + 1] - Pa[1], vz = flat[vi * 3 + 2] - Pa[2];
                    dists[vi] = Math.hypot(vx, vy, vz);
                }
                radius = pct(dists, 0.7);
            }
            if (!(radius > 1e-3)) continue;
            const boneHash = joints[boneIdx].name_hash;
            const key = `${boneHash}:${boneHashB ?? ''}`;
            if (existing.has(key)) continue;
            existing.add(key);
            const id = Math.random().toString(36).slice(2, 10);
            physicsColliders.set(id, { id, boneHash, boneHashB, radius, offsetX: 0, offsetY: 0, offsetZ: 0 });
            added++;
        }
        if (added > 0) { rebake(); commitUndoStep(); }
        return added;
    };

    // ── Mesh collision (Maya-style) ───────────────────────────────
    /** Read + concatenate the physics rig's collider submeshes into bind
     *  data for the mesh-collision solver. Cached by rig + excluded set. */
    const buildMeshColliderBind = (): MeshColliderBind | null => {
        const obj = sides[getPhysicsRigSide()]?.object ?? null;
        if (!obj?.skn) return null;
        const excluded = new Set(meshCollision.excludedMeshes);
        const meshes = obj.meshes.filter(m => !excluded.has(m.name));
        if (meshes.length === 0) return null;
        const key = [...excluded].sort().join('|');
        if (meshColBindCache && meshColBindCache.obj === obj && meshColBindCache.key === key) {
            meshColBindCache.bind.thickness = Math.max(0.01, meshCollision.thickness);
            return meshColBindCache.bind;
        }
        const positions: number[] = [];
        const bidx: number[] = [];
        const wts: number[] = [];
        const tris: number[] = [];
        let base = 0;
        for (const m of meshes) {
            const pos = m.getVerticesData(VertexBuffer.PositionKind);
            const mi = m.getVerticesData(VertexBuffer.MatricesIndicesKind);
            const mw = m.getVerticesData(VertexBuffer.MatricesWeightsKind);
            const idx = m.getIndices();
            if (!pos || !mi || !mw || !idx) continue;
            const vcount = (pos.length / 3) | 0;
            for (let v = 0; v < vcount; v++) {
                positions.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
                for (let k = 0; k < 4; k++) { bidx.push(mi[v * 4 + k] | 0); wts.push(mw[v * 4 + k]); }
            }
            for (let t = 0; t < idx.length; t++) tris.push(idx[t] + base);
            base += vcount;
        }
        if (positions.length === 0 || tris.length === 0) return null;
        const bind: MeshColliderBind = {
            vBind: new Float32Array(positions),
            boneIdx: new Int32Array(bidx),
            weight: new Float32Array(wts),
            indices: new Uint32Array(tris),
            vertexCount: (positions.length / 3) | 0,
            triCount: (tris.length / 3) | 0,
            thickness: Math.max(0.01, meshCollision.thickness),
        };
        meshColBindCache = { obj, key, bind };
        return bind;
    };
    /** A fresh SkinnedCollider for a bake, or null when mesh collision is
     *  off / unavailable. */
    const buildMeshCollider = (): SkinnedCollider | null => {
        if (!meshCollision.enabled) return null;
        const bind = buildMeshColliderBind();
        return bind ? makeSkinnedCollider(bind) : null;
    };
    const getMeshCollision = (): MeshCollisionConfig => ({
        ...meshCollision,
        excludedMeshes: [...meshCollision.excludedMeshes],
    });
    const setMeshCollision = (patch: Partial<MeshCollisionConfig>) => {
        meshCollision = {
            ...meshCollision,
            ...patch,
            excludedMeshes: patch.excludedMeshes ? [...patch.excludedMeshes] : meshCollision.excludedMeshes,
        };
        // Geometry changes invalidate the cached bind data (thickness doesn't).
        if ('excludedMeshes' in patch || 'enabled' in patch) meshColBindCache = null;
        rebake();
        commitUndoStep('meshcol');
    };
    const getPhysicsMeshNames = (): string[] => {
        const obj = sides[getPhysicsRigSide()]?.object ?? null;
        return obj ? obj.meshes.map(m => m.name) : [];
    };

    // ── Collider visualisation ───────────────────────────────────
    // Translucent spheres drawn at each collider's animated world
    // position so the user can see (and size-check) them. Parented to
    // the physics rig's root and positioned in skeleton space, so they
    // ride the animated bones exactly like the real collision spheres
    // the solver uses. Rebuilt lazily each frame from the live collider
    // list — add / remove / resize just shows up.
    let showColliders = false;
    // Per collider: its preview meshes (a sphere, or two end spheres + a
    // cylinder for a capsule) and whether it's currently a capsule so we
    // know to rebuild when the user toggles the second bone.
    const colliderGizmos = new Map<string, { meshes: Mesh[]; capsule: boolean }>();
    let colliderGizmoMat: StandardMaterial | null = null;
    let colliderObs: Observer<Scene> | null = null;
    let colliderObsScene: Scene | null = null;

    const clearColliderGizmoMeshes = () => {
        for (const rec of colliderGizmos.values()) {
            for (const m of rec.meshes) { try { m.dispose(); } catch { /* ignore */ } }
        }
        colliderGizmos.clear();
    };
    const disposeColliderVis = () => {
        clearColliderGizmoMeshes();
        if (colliderObs && colliderObsScene) {
            colliderObsScene.onBeforeRenderObservable.remove(colliderObs);
        }
        colliderObs = null;
        colliderObsScene = null;
        if (colliderGizmoMat) { try { colliderGizmoMat.dispose(); } catch { /* ignore */ } colliderGizmoMat = null; }
    };

    const updateColliderGizmos = () => {
        const vp = sides[getPhysicsRigSide()];
        const obj = vp?.object ?? null;
        if (!vp || !obj?.skn) { clearColliderGizmoMeshes(); return; }
        const scene = vp.scene;
        if (!colliderGizmoMat || colliderGizmoMat.getScene() !== scene) {
            if (colliderGizmoMat) { try { colliderGizmoMat.dispose(); } catch { /* ignore */ } }
            const m = new StandardMaterial('__collider_gizmo__', scene);
            m.disableLighting = true;
            m.emissiveColor = new Color3(0.25, 0.8, 1);
            m.alpha = 0.3;
            m.backFaceCulling = false;
            colliderGizmoMat = m;
        }
        // Bone-local point → skeleton-space (before the model root transform,
        // which the parented gizmo then re-applies to match the mesh).
        const boneWorld = (boneHash: number, ox = 0, oy = 0, oz = 0): BabylonVector3 | null => {
            const idx = obj.skn!.boneIndexByHash.get(boneHash);
            if (idx === undefined) return null;
            const bone = obj.skn!.bones[idx];
            if (!bone) return null;
            return BabylonVector3.TransformCoordinates(new BabylonVector3(ox, oy, oz), bone.getWorldMatrix());
        };

        const live = new Set<string>();
        for (const c of physicsColliders.values()) {
            if (c.radius <= 0) continue;
            const pA = boneWorld(c.boneHash, c.offsetX, c.offsetY, c.offsetZ);
            if (!pA) continue;
            const pB = c.boneHashB !== undefined ? boneWorld(c.boneHashB) : null;
            const isCapsule = !!pB;
            live.add(c.id);

            let rec = colliderGizmos.get(c.id);
            if (!rec || rec.capsule !== isCapsule || rec.meshes.some(m => m.isDisposed())) {
                if (rec) for (const m of rec.meshes) { try { m.dispose(); } catch { /* ignore */ } }
                const meshes: Mesh[] = [];
                const sA = CreateSphere(`__colgz_${c.id}_a`, { diameter: 2, segments: 10 }, scene);
                meshes.push(sA);
                if (isCapsule) {
                    meshes.push(CreateSphere(`__colgz_${c.id}_b`, { diameter: 2, segments: 10 }, scene));
                    meshes.push(CreateCylinder(`__colgz_${c.id}_c`, { height: 1, diameter: 2, tessellation: 12 }, scene));
                }
                for (const m of meshes) {
                    m.material = colliderGizmoMat;
                    m.parent = obj.root;
                    m.isPickable = false;
                    m.alwaysSelectAsActiveMesh = true;
                }
                rec = { meshes, capsule: isCapsule };
                colliderGizmos.set(c.id, rec);
            }

            const r = c.radius;
            rec.meshes[0].position.copyFrom(pA);
            rec.meshes[0].scaling.setAll(r);
            if (isCapsule && pB) {
                rec.meshes[1].position.copyFrom(pB);
                rec.meshes[1].scaling.setAll(r);
                const cyl = rec.meshes[2];
                const dir = pB.subtract(pA);
                const len = dir.length();
                cyl.position.copyFrom(pA.add(pB).scaleInPlace(0.5));
                cyl.scaling.set(r, Math.max(len, 1e-4), r);
                if (len > 1e-5) {
                    if (!cyl.rotationQuaternion) cyl.rotationQuaternion = new BabylonQuaternion();
                    // Orient the cylinder's Y axis along the bone-to-bone dir.
                    BabylonQuaternion.FromUnitVectorsToRef(BabylonVector3.Up(), dir.scaleInPlace(1 / len), cyl.rotationQuaternion);
                }
            }
        }
        for (const [id, rec] of colliderGizmos) {
            if (!live.has(id)) {
                for (const m of rec.meshes) { try { m.dispose(); } catch { /* ignore */ } }
                colliderGizmos.delete(id);
            }
        }
    };

    const attachColliderObs = () => {
        const vp = sides[getPhysicsRigSide()];
        if (!vp) return;
        colliderObsScene = vp.scene;
        colliderObs = colliderObsScene.onBeforeRenderObservable.add(() => updateColliderGizmos());
        updateColliderGizmos();
    };

    /** Re-point the collider overlay at the current physics-rig scene
     *  (after a mode switch changes which side owns physics). */
    const rebindColliderVis = () => {
        if (!showColliders) return;
        disposeColliderVis();
        attachColliderObs();
    };

    const getShowColliders = () => showColliders;
    const setShowColliders = (show: boolean) => {
        if (show === showColliders) return;
        showColliders = show;
        if (show) attachColliderObs();
        else disposeColliderVis();
        emit();
    };

    // ── Gizmo edit lifecycle ─────────────────────────────────────
    /** Read the current animated world TRS of a target bone by
     *  hash. Pulls from Babylon's bone matrix (which our
     *  AnimationPlayer keeps up to date), decomposing position +
     *  rotation. Returns null when the bone can't be resolved. */
    const readBoneAnimWorld = (boneHash: number): { pos: BabylonVector3; rot: BabylonQuaternion } | null => {
        const targetObj = sides.target?.object ?? null;
        if (!targetObj?.skn) return null;
        const idx = targetObj.skn.boneIndexByHash.get(boneHash);
        if (idx === undefined) return null;
        const bone = targetObj.skn.bones[idx];
        if (!bone) return null;
        const worldMat = bone.getWorldMatrix();
        // Worldmatrix is bone-space; multiply by mesh root world
        // matrix to get scene-space (the gizmo lives in scene
        // space, not skeleton space).
        const rootWorld = targetObj.root.getWorldMatrix();
        const combined = worldMat.multiply(rootWorld);
        const pos = new BabylonVector3();
        const rot = new BabylonQuaternion();
        const scl = new BabylonVector3();
        combined.decompose(scl, rot, pos);
        return { pos, rot };
    };

    /** Tear down the active gizmo + proxy TN + per-frame observer.
     *  Safe to call when nothing's active. */
    const disposeGizmo = () => {
        if (gizmoFrameObs) {
            const tscene = sides.target?.scene;
            if (tscene) tscene.onBeforeRenderObservable.remove(gizmoFrameObs);
            gizmoFrameObs = null;
        }
        if (gizmoManager) {
            try { gizmoManager.dispose(); } catch { /* ignore */ }
            gizmoManager = null;
        }
        if (gizmoUtilityLayer) {
            try { gizmoUtilityLayer.dispose(); } catch { /* ignore */ }
            gizmoUtilityLayer = null;
        }
        if (gizmoProxyTN) {
            try { gizmoProxyTN.dispose(); } catch { /* ignore */ }
            gizmoProxyTN = null;
        }
        gizmoIsDragging = false;
    };

    /** Apply the current proxy TN's world TRS as a guide
     *  position/rotation update. Computes the offset values such
     *  that the bone's final world TRS lands exactly at the
     *  proxy's current world TRS. */
    const commitGizmoToGuide = () => {
        if (editingGuideHash === null) return;
        const targetObj = sides.target?.object ?? null;
        if (!targetObj?.skn) return;
        const guide = guidesByTargetHash.get(editingGuideHash);
        if (!guide) return;
        const bone = targetObj.skn.joints.find(j => j.name_hash === editingGuideHash);
        if (!bone) return;
        // Determine follow bone (explicit override or SKL parent).
        const followHash = guide.followBoneHash ?? (
            bone.parent_id >= 0 && bone.parent_id < targetObj.skn.joints.length
                ? targetObj.skn.joints[bone.parent_id].name_hash
                : null
        );
        if (followHash === null) return;
        const followWorld = readBoneAnimWorld(followHash);
        if (!followWorld || !gizmoProxyTN) return;
        // Strip target root world transform from the gizmo's
        // world TRS — gizmo coords live in scene space; bone
        // coords (and our follow world above) live in scene
        // space too, so this is already consistent. We just
        // need to do the per-bone math.
        const proxyPos = gizmoProxyTN.getAbsolutePosition();
        const proxyRot = gizmoProxyTN.absoluteRotationQuaternion;

        if (editingGuideMode === 'position') {
            // posOffset = inv(followRot).rotate(proxyPos - followPos)
            //              - bone.bindLocalTrans
            const dx = proxyPos.x - followWorld.pos.x;
            const dy = proxyPos.y - followWorld.pos.y;
            const dz = proxyPos.z - followWorld.pos.z;
            const invFollowRot = followWorld.rot.clone();
            invFollowRot.x = -invFollowRot.x;
            invFollowRot.y = -invFollowRot.y;
            invFollowRot.z = -invFollowRot.z;
            const rotated = rotateVec3ByQuat(invFollowRot, dx, dy, dz);
            const newOffsetX = rotated[0] - bone.local_translation[0];
            const newOffsetY = rotated[1] - bone.local_translation[1];
            const newOffsetZ = rotated[2] - bone.local_translation[2];
            setGuide({
                ...guide,
                offsetX: newOffsetX,
                offsetY: newOffsetY,
                offsetZ: newOffsetZ,
            });
        } else if (editingGuideMode === 'rotation') {
            // desiredWorldRot = followRot · bindLocalRot · eulerOffset
            // → eulerOffset = inv(bindLocalRot) · inv(followRot) · proxyRot
            const bindRot = new BabylonQuaternion(
                bone.local_rotation[0], bone.local_rotation[1],
                bone.local_rotation[2], bone.local_rotation[3],
            );
            const invFollow = followWorld.rot.clone();
            invFollow.x = -invFollow.x; invFollow.y = -invFollow.y; invFollow.z = -invFollow.z;
            const invBind = bindRot.clone();
            invBind.x = -invBind.x; invBind.y = -invBind.y; invBind.z = -invBind.z;
            const eulerOffsetQuat = invBind.multiply(invFollow).multiply(proxyRot);
            const eul = quaternionToEulerDegrees(
                eulerOffsetQuat.x, eulerOffsetQuat.y, eulerOffsetQuat.z, eulerOffsetQuat.w,
            );
            setGuide({
                ...guide,
                rotX: eul[0],
                rotY: eul[1],
                rotZ: eul[2],
            });
        }
    };

    const setEditingGuide = (hash: number | null, mode: 'position' | 'rotation' | null) => {
        // Always tear down before rebuilding — switching mode or
        // guide while one is active was producing stranded gizmos.
        disposeGizmo();
        editingGuideHash = (hash !== null && mode !== null) ? hash : null;
        editingGuideMode = (hash !== null && mode !== null) ? mode : null;
        if (editingGuideHash === null || editingGuideMode === null) {
            emit();
            return;
        }
        // Need a guide AND a target scene to attach to.
        const targetScene = sides.target?.scene ?? null;
        const targetObj = sides.target?.object ?? null;
        if (!targetScene || !targetObj?.skn) {
            editingGuideHash = null;
            editingGuideMode = null;
            emit();
            return;
        }
        if (!guidesByTargetHash.has(editingGuideHash)) {
            editingGuideHash = null;
            editingGuideMode = null;
            emit();
            return;
        }

        // Build a fresh proxy TN at the bone's current world TRS.
        const startWorld = readBoneAnimWorld(editingGuideHash);
        gizmoProxyTN = new TransformNode(`__animstudio_gizmo_proxy_${editingGuideHash}__`, targetScene);
        if (startWorld) {
            gizmoProxyTN.position = startWorld.pos.clone();
            gizmoProxyTN.rotationQuaternion = startWorld.rot.clone();
        }

        // Utility layer + GizmoManager. Utility layer lives above
        // the regular scene so gizmos don't get culled by the
        // model's geometry.
        gizmoUtilityLayer = new UtilityLayerRenderer(targetScene);
        gizmoManager = new GizmoManager(targetScene, 1, gizmoUtilityLayer);
        gizmoManager.usePointerToAttachGizmos = false; // don't switch on click
        gizmoManager.positionGizmoEnabled = editingGuideMode === 'position';
        gizmoManager.rotationGizmoEnabled = editingGuideMode === 'rotation';
        gizmoManager.attachToNode(gizmoProxyTN);

        // Hook drag observables on each sub-gizmo axis. We commit
        // on drag END to avoid the cost of rebaking the target
        // DTO on every per-frame drag tick.
        const pg = gizmoManager.gizmos.positionGizmo;
        const rg = gizmoManager.gizmos.rotationGizmo;
        // World-aligned gizmos (Maya-style). Default Babylon
        // behaviour rotates the gizmo with the attached node's
        // orientation, which for skinned bones with weird bind
        // rotations makes the X/Y/Z arrows point in unintuitive
        // directions. Forcing world axes means "drag the green Y
        // arrow up = the bone moves up in world", regardless of
        // how the bone itself is oriented.
        if (pg) pg.updateGizmoRotationToMatchAttachedMesh = false;
        if (rg) rg.updateGizmoRotationToMatchAttachedMesh = false;
        const dragStart = () => { gizmoIsDragging = true; };
        const dragEnd = () => {
            gizmoIsDragging = false;
            commitGizmoToGuide();
        };
        if (pg) {
            pg.xGizmo.dragBehavior.onDragStartObservable.add(dragStart);
            pg.yGizmo.dragBehavior.onDragStartObservable.add(dragStart);
            pg.zGizmo.dragBehavior.onDragStartObservable.add(dragStart);
            pg.xGizmo.dragBehavior.onDragEndObservable.add(dragEnd);
            pg.yGizmo.dragBehavior.onDragEndObservable.add(dragEnd);
            pg.zGizmo.dragBehavior.onDragEndObservable.add(dragEnd);
        }
        if (rg) {
            rg.xGizmo.dragBehavior.onDragStartObservable.add(dragStart);
            rg.yGizmo.dragBehavior.onDragStartObservable.add(dragStart);
            rg.zGizmo.dragBehavior.onDragStartObservable.add(dragStart);
            rg.xGizmo.dragBehavior.onDragEndObservable.add(dragEnd);
            rg.yGizmo.dragBehavior.onDragEndObservable.add(dragEnd);
            rg.zGizmo.dragBehavior.onDragEndObservable.add(dragEnd);
        }

        // Per-frame chase: when NOT dragging, snap the proxy to
        // the bone's current animated world. Means the gizmo
        // visually follows the animation during playback, and
        // when the user pauses + drags, drag updates win. While
        // dragging we leave the proxy alone so the user's pull
        // doesn't fight the chase.
        gizmoFrameObs = targetScene.onBeforeRenderObservable.add(() => {
            if (gizmoIsDragging || !gizmoProxyTN || editingGuideHash === null) return;
            const w = readBoneAnimWorld(editingGuideHash);
            if (!w) return;
            gizmoProxyTN.position.copyFrom(w.pos);
            if (!gizmoProxyTN.rotationQuaternion) {
                gizmoProxyTN.rotationQuaternion = w.rot.clone();
            } else {
                gizmoProxyTN.rotationQuaternion.copyFrom(w.rot);
            }
        });

        emit();
    };

    const getEditingGuideHash = () => editingGuideHash;
    const getEditingGuideMode = () => editingGuideMode;

    const getRetargetedClip = (): BakedAnimationDTO | null => {
        // Physics mode: the physics-baked clip is what the single
        // viewport renders and what the user wants to write.
        if (mode === 'physics') return physicsClipDto ?? sourceClipDto;
        // Retarget mode: prefer the cached target DTO (the retargeted
        // version the target player is actually rendering). Fall back to
        // the raw clip when no target rig is loaded but a clip is — the
        // user might still want to write the raw clip back out (the
        // round-trip case).
        return targetClipDto ?? sourceClipDto;
    };

    const retargetClipForExport = async (
        anmPath: string,
        opts?: { physics?: boolean },
    ): Promise<BakedAnimationDTO | null> => {
        const srcDto = await loadDiskAnimation(anmPath);
        if (!srcDto) return null;
        const wantPhysics = opts?.physics ?? false;
        // Only spin up Havok when physics is on AND a chain actually
        // uses the Havok solver — otherwise the synchronous simple
        // solver handles it (and skipPhysics short-circuits both).
        const needsHavok = wantPhysics
            && Array.from(physicsChains.values()).some(c => c.solver === 'havok');
        let havok: HavokInstance | null = null;
        if (needsHavok) {
            try { havok = await loadFreshHavok(); } catch { havok = null; }
        }
        return recomputeTargetDto(havok, srcDto, !wantPhysics);
    };

    const getDefaultBakePath = (): string | null => {
        if (!sourceClipPath) return null;
        const clipBasename = sourceClipPath.split(/[\\/]/).pop() ?? 'output.anm';
        // Use forward slashes uniformly — Tauri's path APIs handle
        // both on Windows and it keeps the suggestion readable in
        // the dialog's text field.
        const targetPath = sides.target?.path ?? null;
        if (targetPath) {
            const parent = targetPath.replace(/[\\/][^\\/]+$/, '');
            return `${parent}/animations/${clipBasename}`.replace(/\\/g, '/');
        }
        const sourcePath = sides.source?.path ?? null;
        if (sourcePath) {
            const parent = sourcePath.replace(/[\\/][^\\/]+$/, '');
            return `${parent}/animations/${clipBasename}`.replace(/\\/g, '/');
        }
        return null;
    };

    // ── Scene save / load ────────────────────────────────────────
    const serialize = (): AnimStudioSceneData => {
        const overrides: Array<[number, number]> = [];
        for (const [src, entry] of boneMappingOverrides) {
            overrides.push([src, entry === 'ignore' ? IGNORED_SERIALISED : entry]);
        }
        return {
            version: 1,
            mode,
            sourceSknPath: sides.source?.path ?? null,
            targetSknPath: sides.target?.path ?? null,
            sourceClipPath: sourceClipPath,
            retargetOptions: { ...retargetOptions },
            boneOverrides: overrides,
            targetOffset: clock.targetOffset,
            guides: Array.from(guidesByTargetHash.values()).map(g => ({ ...g })),
            physicsChains: Array.from(physicsChains.values()).map(c => ({
                ...c,
                boneHashes: [...c.boneHashes],
            })),
            physicsColliders: Array.from(physicsColliders.values()).map(c => ({ ...c })),
            meshCollision: { ...meshCollision, excludedMeshes: [...meshCollision.excludedMeshes] },
        };
    };

    const loadFromData = async (data: AnimStudioSceneData) => {
        // Suspend undo for the whole reload — the clearClip / loadSkn /
        // loadSourceClip calls below would otherwise each record a step.
        const prevSuspend = suspendUndo;
        suspendUndo = true;
        try {
        // Reset everything first so a partial reload doesn't leave
        // stale state mixed with the new scene.
        clearClip();
        // Restore the editing mode BEFORE re-loading the clip so the
        // clip bake below uses the correct mode's DTO path.
        mode = data.mode ?? 'retarget';
        physicsClipDto = null;
        if (sides.source) {
            detachPlayer(sides.source);
            try { sides.source.object?.dispose(); } catch { /* ignore */ }
            sides.source.object = null;
            sides.source.path = null;
        }
        if (sides.target) {
            detachPlayer(sides.target);
            try { sides.target.object?.dispose(); } catch { /* ignore */ }
            sides.target.object = null;
            sides.target.path = null;
        }
        boneMappingOverrides.clear();
        guidesByTargetHash.clear();
        if (data.guides) {
            for (const g of data.guides) {
                guidesByTargetHash.set(g.targetBoneHash, { ...g });
            }
        }
        physicsChains.clear();
        if (data.physicsChains) {
            for (const c of data.physicsChains) {
                physicsChains.set(c.id, {
                    ...c,
                    boneHashes: [...c.boneHashes],
                });
            }
        }
        physicsColliders.clear();
        if (data.physicsColliders) {
            for (const c of data.physicsColliders) {
                physicsColliders.set(c.id, { ...c });
            }
        }
        meshColBindCache = null;
        meshCollision = data.meshCollision
            ? { enabled: !!data.meshCollision.enabled, thickness: data.meshCollision.thickness ?? 1, excludedMeshes: [...(data.meshCollision.excludedMeshes ?? [])] }
            : { enabled: false, thickness: 1, excludedMeshes: [] };
        retargetOptions = { ...DEFAULT_RETARGET_OPTIONS, ...data.retargetOptions };
        // Push overrides into the map BEFORE loading clips so the
        // first retarget pass on clip-load already sees them. The
        // auto-mapping fires inside loadSkn so we don't need a
        // separate hook for it.
        for (const [src, raw] of data.boneOverrides) {
            const entry: MappingEntry = raw === IGNORED_SERIALISED ? 'ignore' : raw;
            boneMappingOverrides.set(src, entry);
        }
        // Load rigs in sequence (parallel via Promise.all is fine
        // too, but the camera framing math needs `sides.source`'s
        // object world matrices to be current, and sequential is
        // simpler to debug).
        if (data.sourceSknPath) {
            try { await loadSkn('source', data.sourceSknPath); }
            catch (e) { console.warn('[AnimStudio] source rig load failed:', e); }
        }
        if (data.targetSknPath) {
            try { await loadSkn('target', data.targetSknPath); }
            catch (e) { console.warn('[AnimStudio] target rig load failed:', e); }
        }
        if (data.sourceClipPath) {
            try { await loadSourceClip(data.sourceClipPath); }
            catch (e) { console.warn('[AnimStudio] clip load failed:', e); }
        }
        clock.targetOffset = data.targetOffset ?? 0;
        emit();
        } finally {
            suspendUndo = prevSuspend;
        }
    };

    // ── Undo / redo ────────────────────────────────────────────────

    /** Re-apply a snapshot's in-memory state WITHOUT touching disk.
     *  Used by undo/redo when the rig + clip paths are unchanged from
     *  what's already loaded (the overwhelming common case — tweaking
     *  guides / options / physics / overrides). Rebakes the target so
     *  the viewport reflects the restored setup. */
    const applyStateSoft = (data: AnimStudioSceneData) => {
        boneMappingOverrides.clear();
        for (const [src, raw] of data.boneOverrides) {
            boneMappingOverrides.set(src, raw === IGNORED_SERIALISED ? 'ignore' : raw);
        }
        guidesByTargetHash.clear();
        if (data.guides) {
            for (const g of data.guides) guidesByTargetHash.set(g.targetBoneHash, { ...g });
        }
        physicsChains.clear();
        if (data.physicsChains) {
            for (const c of data.physicsChains) {
                physicsChains.set(c.id, { ...c, boneHashes: [...c.boneHashes] });
            }
        }
        physicsColliders.clear();
        if (data.physicsColliders) {
            for (const c of data.physicsColliders) physicsColliders.set(c.id, { ...c });
        }
        retargetOptions = { ...DEFAULT_RETARGET_OPTIONS, ...data.retargetOptions };
        clock.targetOffset = data.targetOffset ?? 0;
        // Rebuild target DTO + player from the restored state, then
        // re-apply the world-Y lift and refresh poses (incl. A/B offset).
        rebakeTarget();
        applyVerticalOffsetToTarget();
        if (clock.duration > 0) seek(clock.time);
    };

    /** Restore a serialized snapshot. Takes the cheap soft path when the
     *  rig + clip paths match what's loaded; otherwise falls back to the
     *  full async disk reload. Either way runs under `suspendUndo` so the
     *  restore doesn't record itself as a new step. */
    const applyUndoSnapshot = async (data: AnimStudioSceneData): Promise<void> => {
        const samePaths =
            (sides.source?.path ?? null) === data.sourceSknPath &&
            (sides.target?.path ?? null) === data.targetSknPath &&
            sourceClipPath === data.sourceClipPath;
        const prevSuspend = suspendUndo;
        suspendUndo = true;
        try {
            if (samePaths) applyStateSoft(data);
            else await loadFromData(data);
        } finally {
            suspendUndo = prevSuspend;
        }
    };

    /** Record an undo step. Call AFTER a mutation completes. Pushes the
     *  PRE-mutation snapshot and re-baselines `lastSnapshot` to the new
     *  current state. No-ops while `suspendUndo` is set (during restore /
     *  loadFromData). A `key` passed within `COALESCE_MS` of the previous
     *  same-key commit coalesces — the baseline advances but no new step
     *  is pushed, so a slider drag collapses to one undo. */
    const commitUndoStep = (key?: string) => {
        if (suspendUndo) return;
        const now = Date.now();
        const coalesce = key != null
            && key === lastCommitKey
            && (now - lastCommitAt) < COALESCE_MS;
        if (!coalesce && lastSnapshot) {
            undoStack.push(lastSnapshot);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            redoStack.length = 0;
        }
        lastSnapshot = serialize();
        dirtyCounter += 1;
        lastCommitAt = now;
        lastCommitKey = key ?? null;
        emit();
    };

    const undo = async () => {
        if (undoStack.length === 0) return;
        const prev = undoStack.pop()!;
        redoStack.push(serialize());
        await applyUndoSnapshot(prev);
        lastSnapshot = prev;
        // A fresh commit after an undo must not coalesce into the undone
        // gesture, so break the coalesce chain.
        lastCommitKey = null;
        dirtyCounter += 1;
        emit();
    };

    const redo = async () => {
        if (redoStack.length === 0) return;
        const next = redoStack.pop()!;
        undoStack.push(serialize());
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        await applyUndoSnapshot(next);
        lastSnapshot = next;
        lastCommitKey = null;
        dirtyCounter += 1;
        emit();
    };

    const canUndo = () => undoStack.length > 0;
    const canRedo = () => redoStack.length > 0;

    /** Wipe undo/redo history and re-baseline against the current scene.
     *  Call after loading an `.animstudio.json` so the user can't undo
     *  back past the freshly-opened state. */
    const resetUndoHistory = () => {
        undoStack.length = 0;
        redoStack.length = 0;
        lastSnapshot = serialize();
        lastCommitKey = null;
        emit();
    };

    const isDirty = () => dirtyCounter !== savedCounter;
    /** Stamp the current state as "saved" — call after writing the
     *  `.animstudio.json`. Leaves the undo stack intact. */
    const markSaved = () => {
        savedCounter = dirtyCounter;
        emit();
    };

    // Baseline snapshot — the empty scene. The first real mutation's
    // `commitUndoStep` pushes this so the user can undo back to empty.
    lastSnapshot = serialize();

    const recomputeAutoMappingPublic = () => {
        recomputeAutoMapping();
        if (sourceClipDto && sides.target) {
            targetClipDto = recomputeTargetDto();
            attachPlayer(sides.target, 'target');
            scheduleHavokOverlay();
        }
        emit();
    };

    /** Push the current `verticalOffset` onto each included mesh in
     *  the target model. Per-mesh rather than on the parent root
     *  TransformNode so the user can exclude individual submeshes
     *  (props, weapons) from the lift — those stay at world Y
     *  zero while the body shifts up. Each mesh's
     *  `mesh.worldMatrix` is the outermost transform in the
     *  skinned-mesh shader chain, so writing `mesh.position.y`
     *  shifts every vertex on that mesh uniformly. */
    const applyVerticalOffsetToTarget = () => {
        const obj = sides.target?.object ?? null;
        if (!obj) return;
        // The root TransformNode itself stays at 0 — we drive
        // per-mesh Y instead so the exclusion check works.
        obj.root.position.y = 0;
        const excluded = new Set(retargetOptions.verticalOffsetExcludedMeshes);
        for (const m of obj.meshes) {
            m.position.y = excluded.has(m.name) ? 0 : retargetOptions.verticalOffset;
        }
    };

    const setRetargetOptions = (patch: Partial<RetargetOptions>) => {
        const next = { ...retargetOptions, ...patch };
        // Skip the rebuild when nothing actually changed — avoids a
        // pointless per-frame stall when the same checkbox state is
        // re-applied by a parent re-render.
        if (next.rescaleTranslations === retargetOptions.rescaleTranslations
            && next.rebaseRotations === retargetOptions.rebaseRotations
            && next.stripRootMotion === retargetOptions.stripRootMotion
            && next.mirror === retargetOptions.mirror
            && next.lockBoneLengths === retargetOptions.lockBoneLengths
            && next.dropMismatchedParents === retargetOptions.dropMismatchedParents
            && next.verticalOffset === retargetOptions.verticalOffset
            && arraysShallowEqual(next.verticalOffsetExcludedMeshes, retargetOptions.verticalOffsetExcludedMeshes)
            && next.fixGroundReference === retargetOptions.fixGroundReference
            && next.fixGroundReferenceDynamicRefNode === retargetOptions.fixGroundReferenceDynamicRefNode
            && next.fixAnimations === retargetOptions.fixAnimations
            && next.rootNodeName === retargetOptions.rootNodeName
            && next.groundReferenceNodeName === retargetOptions.groundReferenceNodeName
            && next.groundReferenceVerticalAxis === retargetOptions.groundReferenceVerticalAxis) {
            return;
        }
        // Detect whether ONLY the scene-level (non-baking) fields
        // changed. These are applied directly to the mesh tree
        // without re-running the per-frame retarget — saves a
        // big O(frame × bone) walk on every slider drag.
        const sceneOnlyKeys = new Set(['verticalOffset', 'verticalOffsetExcludedMeshes']);
        const patchKeys = Object.keys(patch);
        const sceneOnly = patchKeys.length > 0 && patchKeys.every(k => sceneOnlyKeys.has(k));
        retargetOptions = next;
        // Coalesce by which option(s) changed, so dragging a numeric
        // option (e.g. verticalOffset) collapses to one undo step while
        // distinct toggles each get their own.
        const optKey = `opts:${patchKeys.slice().sort().join(',')}`;
        if (sceneOnly) {
            applyVerticalOffsetToTarget();
            commitUndoStep(optKey);
            return;
        }
        targetClipDto = recomputeTargetDto();
        if (sides.target) attachPlayer(sides.target, 'target');
        scheduleHavokOverlay();
        applyVerticalOffsetToTarget();
        commitUndoStep(optKey);
    };

    const clearClip = () => {
        const hadClip = sourceClipPath !== null || sourceClipDto !== null;
        sourceClipPath = null;
        sourceClipDto = null;
        targetClipDto = null;
        clock.duration = 0;
        clock.frameCount = 0;
        clock.time = 0;
        clock.playing = false;
        if (sides.source) detachPlayer(sides.source);
        if (sides.target) detachPlayer(sides.target);
        emit();
        // Only a real clear is undoable — loadFromData calls this as an
        // unconditional reset (under suspendUndo) and an empty clear
        // shouldn't manufacture a step.
        if (hadClip) commitUndoStep();
    };

    const swap = () => {
        // Swap the actual state objects so each side's engine /
        // canvas binding stays put — only the role label moves.
        // BUT: the SKN object owns Babylon nodes attached to the
        // viewport's *scene*. We can't just point the variables
        // across; we'd have to migrate meshes between scenes, which
        // Babylon doesn't really support without rebuilding them.
        //
        // Pragmatic approach: hold the on-disk paths, dispose both
        // objects, and reload each into the opposite side. Slow on
        // a big SKN (~hundreds of ms) but cheap to implement and
        // works for the common "I had it backwards" flow.
        const sourcePath = sides.source?.path ?? null;
        const targetPath = sides.target?.path ?? null;
        if (!sourcePath && !targetPath) return;
        // Drop both first so we don't double up on memory. Their
        // players go too — the new SKNs will get fresh players when
        // `loadSkn` re-binds them against the live clip.
        if (sides.source) {
            detachPlayer(sides.source);
            try { sides.source.object?.dispose(); } catch { /* ignore */ }
            sides.source.object = null;
            sides.source.path = null;
        }
        if (sides.target) {
            detachPlayer(sides.target);
            try { sides.target.object?.dispose(); } catch { /* ignore */ }
            sides.target.object = null;
            sides.target.path = null;
        }
        emit();
        // Reload in opposite slots. Errors don't block the other
        // side — we want a half-swapped state visible rather than a
        // silent abort. Suspend undo across BOTH reloads so the swap is
        // a single undo step (each `loadSkn` would otherwise record one),
        // then commit once when they settle.
        const prevSuspend = suspendUndo;
        suspendUndo = true;
        const reloads: Promise<unknown>[] = [];
        if (targetPath) reloads.push(loadSkn('source', targetPath).catch(e => console.error('AnimStudio swap source reload:', e)));
        if (sourcePath) reloads.push(loadSkn('target', sourcePath).catch(e => console.error('AnimStudio swap target reload:', e)));
        void Promise.all(reloads).finally(() => {
            suspendUndo = prevSuspend;
            commitUndoStep();
        });
    };

    const clear = (side: AnimStudioSide) => {
        const vp = sides[side];
        if (!vp) return;
        detachPlayer(vp);
        if (vp.object) {
            try { vp.object.dispose(); } catch { /* ignore */ }
        }
        vp.object = null;
        vp.path = null;
        frameCameraOn(vp);
        emit();
        commitUndoStep();
    };

    // ── Playback API ──────────────────────────────────────────────
    const play = () => {
        if (clock.duration <= 0) return; // nothing loaded
        // Reset the wall-clock anchor so the first dt after a long
        // pause isn't huge — without this the player would jump
        // forward by the duration the user spent paused.
        lastWallTimeMs = null;
        clock.playing = true;
        emit();
    };
    const pause = () => {
        clock.playing = false;
        emit();
    };
    const isPlaying = () => clock.playing;
    const seek = (timeSeconds: number) => {
        if (clock.duration <= 0) return;
        let t = timeSeconds;
        if (t < 0) t = 0;
        if (t > clock.duration) t = clock.duration;
        clock.time = t;
        // Apply the pose immediately even while paused — the per-
        // frame observer will pick it up on the next tick anyway,
        // but doing it eagerly here keeps the UI responsive when the
        // scrubber is being dragged.
        for (const side of ['source', 'target'] as const) {
            const vp = sides[side];
            if (!vp?.player) continue;
            let tt = clock.time;
            if (side === 'target' && clock.targetOffset !== 0 && clock.duration > 0) {
                tt += clock.targetOffset;
                tt = tt % clock.duration;
                if (tt < 0) tt += clock.duration;
            }
            vp.player.time = tt;
            vp.player.tick(0);
        }
        emit();
    };
    const setSpeed = (speed: number) => {
        // Clamp to a sane range so a runaway slider can't break the
        // clamped-dt cap (50ms) by demanding gigantic per-frame steps.
        const s = Math.max(0.01, Math.min(8, speed));
        clock.speed = s;
        emit();
    };
    const setLoop = (loop: boolean) => {
        clock.loop = loop;
        emit();
    };
    const setTargetOffset = (offset: number) => {
        if (clock.targetOffset === offset) return;
        clock.targetOffset = offset;
        // Apply immediately so the target snaps to the new offset
        // even while paused.
        const vp = sides.target;
        if (vp?.player && clock.duration > 0) {
            let tt = clock.time + clock.targetOffset;
            tt = tt % clock.duration;
            if (tt < 0) tt += clock.duration;
            vp.player.time = tt;
            vp.player.tick(0);
        }
        commitUndoStep('targetOffset');
    };

    const frameCamera = (side: AnimStudioSide) => {
        const vp = sides[side];
        if (vp) frameCameraOn(vp);
    };

    const getSide = (side: AnimStudioSide) => {
        const vp = sides[side];
        return {
            object: vp?.object ?? null,
            path: vp?.path ?? null,
        };
    };

    const onChange = (cb: () => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    };

    const dispose = () => {
        disposeGizmo();
        disposeColliderVis();
        if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        for (const side of ['source', 'target'] as const) {
            const vp = sides[side];
            if (vp) {
                detachPlayer(vp);
                disposeViewport(vp);
                sides[side] = null;
            }
        }
        sourceClipDto = null;
        sourceClipPath = null;
        listeners.clear();
    };

    // Engines / scenes start `null` until canvases mount. The getters
    // below proxy to the live viewport so consumers don't have to
    // null-check on every access.
    const sceneObj: AnimStudioScene = {
        get sourceEngine() {
            const vp = sides.source;
            if (!vp) throw new Error('Animation Studio: source viewport not yet attached');
            return vp.engine;
        },
        get targetEngine() {
            const vp = sides.target;
            if (!vp) throw new Error('Animation Studio: target viewport not yet attached');
            return vp.engine;
        },
        get sourceScene() {
            const vp = sides.source;
            if (!vp) throw new Error('Animation Studio: source viewport not yet attached');
            return vp.scene;
        },
        get targetScene() {
            const vp = sides.target;
            if (!vp) throw new Error('Animation Studio: target viewport not yet attached');
            return vp.scene;
        },
        attachCanvas,
        loadSkn,
        swap,
        clear,
        frameCamera,
        setCameraLink,
        getCameraLink,
        getSide,
        loadSourceClip,
        clearClip,
        hasClip: () => sourceClipDto !== null,
        getClipPath: () => sourceClipPath,
        getClipMetadata: () => ({
            duration: clock.duration,
            fps: clock.fps,
            frameCount: clock.frameCount,
        }),
        play,
        pause,
        isPlaying,
        seek,
        getTime: () => clock.time,
        setSpeed,
        getSpeed: () => clock.speed,
        setLoop,
        getLoop: () => clock.loop,
        setTargetOffset,
        getTargetOffset: () => clock.targetOffset,
        setRetargetOptions,
        getRetargetOptions: () => ({ ...retargetOptions }),
        getBoneMappingRows,
        getTargetJoints,
        getTargetMeshNames,
        getSourceJointNames,
        setBoneOverride,
        clearBoneOverrides,
        recomputeAutoMapping: recomputeAutoMappingPublic,
        getGuides,
        setGuide,
        removeGuide,
        setEditingGuide,
        getEditingGuideHash,
        getEditingGuideMode,
        getPhysicsChains,
        setPhysicsChain,
        removePhysicsChain,
        getPhysicsColliders,
        setPhysicsCollider,
        removePhysicsCollider,
        generateCollidersFromMesh,
        getMeshCollision,
        setMeshCollision,
        getPhysicsMeshNames,
        getShowColliders,
        setShowColliders,
        getMode,
        setMode,
        getPhysicsRigSide,
        getPhysicsJoints,
        bakePhysicsClipForExport,
        getRetargetedClip,
        retargetClipForExport,
        getDefaultBakePath,
        serialize,
        loadFromData,
        commitUndoStep,
        undo,
        redo,
        canUndo,
        canRedo,
        resetUndoHistory,
        isDirty,
        markSaved,
        onChange,
        dispose,
    };
    return sceneObj;
}
