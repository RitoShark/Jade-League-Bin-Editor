/**
 * Babylon retargeting bridge.
 *
 * Wraps `AnimatorAvatar.retargetAnimationGroup` (Babylon 9.0+) so our
 * scene host can feed it a `BakedAnimationDTO` and get a target-rig-
 * compatible `BakedAnimationDTO` back. The Babylon retargeter does
 * all the heavy math:
 *
 *   - Change-of-basis between source and target reference poses
 *     (`retargetAnimationKeys`)
 *   - Root locomotion proportional rescale (`fixRootPosition`)
 *   - Ground reference correction with dynamic lowest-bone selection
 *     (`fixGroundReference` + `fixGroundReferenceDynamicRefNode`)
 *   - Parent-hierarchy checking — auto-drops bones whose parent
 *     names differ between rigs (`checkHierarchy`)
 *   - Explicit name remap for naming-convention differences
 *     (`mapNodeNames`)
 *
 * The bridge:
 *
 *   1. Builds a phantom `TransformNode` tree from the source's
 *      SKL joints (Babylon's retargeter requires the source
 *      animation to target TransformNodes, not bones).
 *   2. Converts our `BakedAnimationDTO` into a Babylon
 *      `AnimationGroup` whose curves target those TNs.
 *   3. Hands the group to `AnimatorAvatar.retargetAnimationGroup`,
 *      pointing the avatar at the target object's root.
 *   4. Samples the resulting group's animations at every integer
 *      frame and builds a fresh `BakedAnimationDTO` for the
 *      target rig.
 *   5. Disposes the phantom resources before returning.
 *
 * Steps 1-3 must happen with the source TN tree at REST POSE —
 * the retargeter samples the TNs' current world matrices to
 * compute reference matrices. Since we build the TNs fresh and
 * never play any animation on them before retargeting, this is
 * automatically satisfied.
 */

import { AnimatorAvatar, type IRetargetOptions } from '@babylonjs/core/Animations/animatorAvatar';
import { Animation } from '@babylonjs/core/Animations/animation';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math';
import type { Scene } from '@babylonjs/core/scene';

import type { BakedAnimationDTO } from '../babylon/animationPlayer';
import type { SklJointDTO } from '../babylon/skeletonBuilder';
import type { StudioObject } from '../babylon/studioObject';

export interface RetargetCallOptions {
    /** Forward to Babylon's `retargetAnimationKeys` — the proper
     *  change-of-basis math. Default true. */
    rebaseRotations: boolean;
    /** Forward to Babylon's `fixRootPosition` — proportional root
     *  locomotion rescale. Default true. */
    fixRootPosition: boolean;
    /** Forward to Babylon's `fixGroundReference` — keep feet on
     *  the floor by correcting vertical offset. */
    fixGroundReference: boolean;
    /** Forward to Babylon's `fixGroundReferenceDynamicRefNode` —
     *  per-frame "lowest bone wins" for the ground reference. */
    fixGroundReferenceDynamic: boolean;
    /** Forward to Babylon's `fixAnimations` — clean up
     *  orthogonal-quaternion data errors. */
    fixAnimations: boolean;
    /** Forward to Babylon's `checkHierarchy` — auto-drop tracks
     *  whose parent names mismatch (handles the Jax weapon case). */
    checkHierarchy: boolean;
    /** Name of the root bone on the source rig. Empty string =
     *  auto-detect (first source bone with no parent). League
     *  rigs canonically use `Root`. */
    rootNodeName: string;
    /** Name of the ground-reference bone on the source rig
     *  (typically a foot or toe). Required when `fixRootPosition`
     *  or `fixGroundReference` is on. Empty = disable those
     *  features (Babylon won't run those passes). */
    groundReferenceNodeName: string;
    /** Forward to Babylon's `groundReferenceVerticalAxis` — which
     *  axis is "up" in the animation space. Empty string = auto-
     *  detect from root-to-ground vector. */
    groundReferenceVerticalAxis: '' | 'X' | 'Y' | 'Z';
    /** Map of source-bone-name → target-bone-name for naming-
     *  convention overrides. Feeds Babylon's `mapNodeNames`. */
    mapNodeNames: Map<string, string>;
}

/**
 * Retarget a `BakedAnimationDTO` from source rig to target rig
 * using Babylon's `AnimatorAvatar`. Returns a new
 * `BakedAnimationDTO` keyed by target bone hashes, ready for our
 * existing `AnimationPlayer` to play on the target skeleton.
 *
 * @param sourceClip - The source animation in our internal DTO shape.
 * @param sourceSkl - Source rig's joint list (for building the
 *                    phantom TN tree).
 * @param targetObj - Target StudioObject (we wrap its root in
 *                    AnimatorAvatar so Babylon discovers target
 *                    skeleton + meshes automatically).
 * @param scene - Scene to host the phantom TNs and AnimationGroups.
 *                Usually the target side's scene.
 * @param opts - Bridge options mapped to Babylon's `IRetargetOptions`.
 *
 * Returns `null` if either input is missing data the retarget
 * needs.
 */
export function retargetViaBabylon(
    sourceClip: BakedAnimationDTO,
    sourceSkl: SklJointDTO[],
    targetObj: StudioObject,
    scene: Scene,
    opts: RetargetCallOptions,
): BakedAnimationDTO | null {
    if (!targetObj.skn) return null;
    if (sourceSkl.length === 0 || sourceClip.tracks.length === 0) return null;

    // ── 1. Phantom source TN tree ────────────────────────────────
    // One TN per source joint, parented mirroring the SKL
    // hierarchy. Each TN named after its joint so Babylon's name-
    // based matching works against the target skeleton's bones.
    //
    // CRITICAL: source-root joints (parent_id < 0) get a NULL
    // parent — NOT a phantom common root. Babylon's
    // `checkHierarchy` walks up the parent chain comparing names;
    // adding a phantom "__animstudio_phantom_root__" parent would
    // make every bone fail the hierarchy check at the top (target
    // bones have no further parent, source TNs would have one
    // more level) and ALL animations would get dropped.
    const tnByJointId = new Array<TransformNode>(sourceSkl.length);
    for (let i = 0; i < sourceSkl.length; i++) {
        const j = sourceSkl[i];
        const tn = new TransformNode(j.name, scene);
        tn.position.set(j.local_translation[0], j.local_translation[1], j.local_translation[2]);
        tn.rotationQuaternion = new Quaternion(
            j.local_rotation[0], j.local_rotation[1], j.local_rotation[2], j.local_rotation[3],
        );
        tn.scaling.set(j.local_scale[0], j.local_scale[1], j.local_scale[2]);
        tnByJointId[i] = tn;
    }
    for (let i = 0; i < sourceSkl.length; i++) {
        const j = sourceSkl[i];
        const tn = tnByJointId[i];
        if (j.parent_id < 0 || j.parent_id >= sourceSkl.length) {
            // Top-level joints stay parentless so their hierarchy
            // walk terminates the same way target top-level bones'
            // does (no parent on either side).
            tn.parent = null;
        } else {
            tn.parent = tnByJointId[j.parent_id];
        }
    }
    // Force world-matrix update so the retargeter sees current
    // (= bind-pose) transforms when it samples reference matrices.
    for (const tn of tnByJointId) tn.computeWorldMatrix(true);

    // Hash → TN for the keyframe-emit pass below.
    const tnByJointHash = new Map<number, TransformNode>();
    for (let i = 0; i < sourceSkl.length; i++) {
        tnByJointHash.set(sourceSkl[i].name_hash, tnByJointId[i]);
    }

    // ── 2. BakedAnimationDTO → Babylon AnimationGroup ────────────
    const sourceGroup = bakedToAnimationGroup(sourceClip, tnByJointHash, scene, '__animstudio_source__');

    // ── 3. Wrap target object's root in AnimatorAvatar ───────────
    // - rootNode = target StudioObject root (Babylon scans its
    //   descendants for meshes / skeletons / morph targets).
    // - disposeResources = false (we own these resources).
    // - setAvatarName = false (don't rename our root TN).
    const avatar = new AnimatorAvatar('__animstudio_target__', targetObj.root, false, false);
    avatar.showWarnings = false; // we trust the user has loaded matching-ish rigs

    // ── 4. Retarget ──────────────────────────────────────────────
    const babylonOpts: IRetargetOptions = {
        animationGroupName: '__animstudio_target_group__',
        retargetAnimationKeys: opts.rebaseRotations,
        fixRootPosition: opts.fixRootPosition,
        fixGroundReference: opts.fixGroundReference,
        fixGroundReferenceDynamicRefNode: opts.fixGroundReferenceDynamic,
        fixAnimations: opts.fixAnimations,
        checkHierarchy: opts.checkHierarchy,
        rootNodeName: opts.rootNodeName || undefined,
        groundReferenceNodeName: opts.groundReferenceNodeName || undefined,
        groundReferenceVerticalAxis: opts.groundReferenceVerticalAxis || undefined,
        mapNodeNames: opts.mapNodeNames.size > 0 ? opts.mapNodeNames : undefined,
    };
    const retargetedGroup = avatar.retargetAnimationGroup(sourceGroup, babylonOpts);

    // ── 5. Sample retargetedGroup → BakedAnimationDTO ────────────
    const resultDto = sampleGroupToBakedDto(
        retargetedGroup,
        sourceClip.frame_count,
        sourceClip.fps,
        sourceClip.duration,
        targetObj,
    );

    // ── 6. Dispose phantom resources ─────────────────────────────
    retargetedGroup.dispose();
    sourceGroup.dispose();
    for (const tn of tnByJointId) tn.dispose();
    // The avatar with disposeResources=false leaves the target's
    // real meshes/skeletons alone but does dispose its internal
    // maps. Safe to call.
    avatar.dispose();

    return resultDto;
}

// ── DTO → AnimationGroup ──────────────────────────────────────────

function bakedToAnimationGroup(
    baked: BakedAnimationDTO,
    tnByHash: Map<number, TransformNode>,
    scene: Scene,
    groupName: string,
): AnimationGroup {
    const group = new AnimationGroup(groupName, scene);
    const fps = baked.fps > 0 ? baked.fps : 30;

    for (const track of baked.tracks) {
        const tn = tnByHash.get(track.joint_hash);
        if (!tn) continue;
        if (track.frames.length === 0) continue;

        // One Animation per TRS channel. Frame index = integer
        // index into track.frames; FPS comes from the clip.
        const posKeys = new Array<{ frame: number; value: Vector3 }>(track.frames.length);
        const rotKeys = new Array<{ frame: number; value: Quaternion }>(track.frames.length);
        const sclKeys = new Array<{ frame: number; value: Vector3 }>(track.frames.length);
        for (let i = 0; i < track.frames.length; i++) {
            const f = track.frames[i];
            posKeys[i] = { frame: i, value: new Vector3(f.translation[0], f.translation[1], f.translation[2]) };
            rotKeys[i] = { frame: i, value: new Quaternion(f.rotation[0], f.rotation[1], f.rotation[2], f.rotation[3]) };
            sclKeys[i] = { frame: i, value: new Vector3(f.scale[0], f.scale[1], f.scale[2]) };
        }

        const posAnim = new Animation(
            `${tn.name}_position`, 'position', fps,
            Animation.ANIMATIONTYPE_VECTOR3,
            Animation.ANIMATIONLOOPMODE_CYCLE,
        );
        posAnim.setKeys(posKeys);
        group.addTargetedAnimation(posAnim, tn);

        const rotAnim = new Animation(
            `${tn.name}_rotationQuaternion`, 'rotationQuaternion', fps,
            Animation.ANIMATIONTYPE_QUATERNION,
            Animation.ANIMATIONLOOPMODE_CYCLE,
        );
        rotAnim.setKeys(rotKeys);
        group.addTargetedAnimation(rotAnim, tn);

        const sclAnim = new Animation(
            `${tn.name}_scaling`, 'scaling', fps,
            Animation.ANIMATIONTYPE_VECTOR3,
            Animation.ANIMATIONLOOPMODE_CYCLE,
        );
        sclAnim.setKeys(sclKeys);
        group.addTargetedAnimation(sclAnim, tn);
    }

    // Normalize so the group knows its frame range — the retargeter
    // uses `from` / `to` to determine how many frames to walk.
    group.normalize(0, Math.max(0, baked.frame_count - 1));
    return group;
}

// ── AnimationGroup → DTO ─────────────────────────────────────────

interface TargetBoneAccumulator {
    boneHash: number;
    translation: [number, number, number][];
    rotation: [number, number, number, number][];
    scale: [number, number, number][];
}

/**
 * Sample the retargeted AnimationGroup at every integer frame and
 * build a fresh `BakedAnimationDTO`. The group's animations target
 * bones (or their linked TransformNodes); we read the bone matrix
 * directly so we get the value Babylon computed even when the
 * curve goes through interpolation.
 *
 * The implementation evaluates each `Animation`'s keys via
 * Babylon's built-in interpolation helpers — we don't need to
 * actually play the group on a scene tick, we just sample the
 * curves at integer frames.
 */
function sampleGroupToBakedDto(
    group: AnimationGroup,
    frameCount: number,
    fps: number,
    duration: number,
    targetObj: StudioObject,
): BakedAnimationDTO {
    // Build a hash → accumulator map keyed by target bone hash.
    // The retargeted group's animation targets are bones (or their
    // linked TNs); we look up by name against the target SKN's
    // joint list to find the canonical hash for output.
    const nameToHash = new Map<string, number>();
    if (targetObj.skn) {
        for (const j of targetObj.skn.joints) nameToHash.set(j.name, j.name_hash);
    }
    const accByHash = new Map<number, TargetBoneAccumulator>();
    const getAcc = (hash: number): TargetBoneAccumulator => {
        let acc = accByHash.get(hash);
        if (!acc) {
            acc = {
                boneHash: hash,
                translation: new Array(frameCount),
                rotation: new Array(frameCount),
                scale: new Array(frameCount),
            };
            accByHash.set(hash, acc);
        }
        return acc;
    };

    // The targeted animations contain target (bone or linked TN)
    // and the Animation curve. Property tells us which channel.
    for (const ta of group.targetedAnimations) {
        const target = ta.target;
        // Resolve the target's NAME — it might be a Bone or a
        // TransformNode (when bone has linkedTransformNode).
        const name: string | undefined = target?.name;
        if (!name) continue;
        const hash = nameToHash.get(name);
        if (hash === undefined) continue;
        const acc = getAcc(hash);
        const channel = ta.animation.targetProperty;

        for (let frame = 0; frame < frameCount; frame++) {
            const v = evaluateAnimationAtFrame(ta.animation, frame);
            if (!v) continue;
            if (channel === 'position') {
                acc.translation[frame] = [v.x, v.y, v.z];
            } else if (channel === 'rotationQuaternion') {
                acc.rotation[frame] = [v.x, v.y, v.z, v.w ?? 1];
            } else if (channel === 'scaling') {
                acc.scale[frame] = [v.x, v.y, v.z];
            }
        }
    }

    // Build output tracks. Fill any missing per-frame entries with
    // sensible defaults (bind translation isn't trivially available
    // here so we use zero-translation / identity-rotation / unit-
    // scale; tracks should normally have entries for every frame
    // since Animation.evaluate returns values continuously, but
    // defensive).
    const tracks: BakedAnimationDTO['tracks'] = [];
    for (const acc of accByHash.values()) {
        const frames: BakedAnimationDTO['tracks'][number]['frames'] = new Array(frameCount);
        for (let i = 0; i < frameCount; i++) {
            frames[i] = {
                translation: acc.translation[i] ?? [0, 0, 0],
                rotation: acc.rotation[i] ?? [0, 0, 0, 1],
                scale: acc.scale[i] ?? [1, 1, 1],
            };
        }
        tracks.push({ joint_hash: acc.boneHash, frames });
    }

    return {
        duration,
        fps,
        frame_count: frameCount,
        tracks,
    };
}

/**
 * Evaluate a Babylon `Animation` at a specific frame value via
 * linear (or slerp, for quaternions) interpolation between its
 * surrounding keyframes. Returns `null` when the animation has no
 * keys — that case shouldn't happen for retargeted output but we
 * guard defensively.
 *
 * Babylon has internal interpolation in `Animation._interpolate`,
 * but it's not part of the public API. Reimplementing the
 * straightforward lerp / slerp path here keeps the sampling
 * deterministic and avoids depending on private internals.
 */
function evaluateAnimationAtFrame(animation: Animation, frame: number): { x: number; y: number; z: number; w?: number } | null {
    const keys = animation.getKeys();
    if (keys.length === 0) return null;
    if (keys.length === 1) {
        return keys[0].value;
    }
    if (frame <= keys[0].frame) return keys[0].value;
    if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value;

    // Binary search for the surrounding keys. Linear scan is fine
    // since keys are sorted by frame and we evaluate ~frame_count
    // times per bone — for typical 60-frame clips this is cheap.
    let lo = 0, hi = keys.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (keys[mid].frame <= frame) lo = mid;
        else hi = mid;
    }
    const a = keys[lo];
    const b = keys[hi];
    const t = (frame - a.frame) / (b.frame - a.frame);

    const valueType = animation.dataType;
    // ANIMATIONTYPE_QUATERNION = 2 — slerp.
    if (valueType === Animation.ANIMATIONTYPE_QUATERNION) {
        const qa: Quaternion = a.value;
        const qb: Quaternion = b.value;
        const out = new Quaternion();
        Quaternion.SlerpToRef(qa, qb, t, out);
        return { x: out.x, y: out.y, z: out.z, w: out.w };
    }
    // ANIMATIONTYPE_VECTOR3 = 1 — lerp.
    if (valueType === Animation.ANIMATIONTYPE_VECTOR3) {
        const va: Vector3 = a.value;
        const vb: Vector3 = b.value;
        return {
            x: va.x + (vb.x - va.x) * t,
            y: va.y + (vb.y - va.y) * t,
            z: va.z + (vb.z - va.z) * t,
        };
    }
    // Other types (float, matrix, color) — not used for our TRS
    // channels but defensive: fall back to the lower key.
    return a.value;
}
