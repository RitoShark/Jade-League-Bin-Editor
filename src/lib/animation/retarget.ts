/**
 * Pure animation-retargeting transform — world-space hierarchical walk.
 *
 * Takes a `BakedAnimationDTO` authored on a **source** skeleton and
 * produces a new DTO that plays correctly on a **target** skeleton.
 *
 * ## Why world-space
 *
 * An earlier per-bone formula (`R_t_anim = M⁻¹ · R_s_anim · R_s_bind⁻¹
 * · M · R_t_bind`) only works when source and target parent chains
 * line up structurally. For bones like Jax's `Weapon`, where the
 * source has it parented to `Root` and the target has it parented
 * to `R_Hand`, the local rotation track means a completely different
 * world-space pose on each rig and per-bone math can't reconcile
 * that.
 *
 * The world-space pipeline avoids that entirely:
 *
 *   1. **Frame walk** the SOURCE rig: compute each joint's animated
 *      world rotation + position by composing parent chains using
 *      the per-frame TRS the ANM track provides (or the bone's bind
 *      transform when no track exists).
 *   2. **Frame walk** the TARGET rig in the same loop, in
 *      topological order. For each target joint:
 *      - If a source bone maps to it, compute the *world delta* the
 *        source produced (anim world * bind world⁻¹) and apply it to
 *        the target's bind world. Convert back to the target's local
 *        frame by inverting the **animated** target parent's world
 *        rotation. This handles parent-orientation mismatches AND
 *        parent-bone identity mismatches in one step.
 *      - If no source bone drives it, the bone stays at bind in its
 *        parent's animated frame (limb-keeps-its-rest-pose default).
 *   3. **Translations** branch by topology:
 *      - Root bones: pass through source local translation
 *        (locomotion), with optional rescale.
 *      - Same-parent bones: target's bind local translation. Limbs
 *        stay attached to the right joint at the right offset; the
 *        target's bone lengths are honoured automatically.
 *      - Different-parent bones (Weapon → Root vs Weapon → R_Hand):
 *        compute source's animated WORLD position and convert into
 *        the target's animated parent local frame. The weapon ends
 *        up at the right world position relative to the world,
 *        regardless of which bone it's parented to on the target.
 *
 * ## Options
 *
 *   - `rebaseRotations` — when off, source local rotation is copied
 *     verbatim into the target's local rotation slot (no math).
 *     Useful as a debug toggle / fallback when you want to see what
 *     the raw clip looks like on the target rig.
 *   - `rescaleTranslations` — only applies to root locomotion
 *     translations; non-root limbs use target bind translations
 *     unconditionally because that's what's geometrically correct.
 *   - `stripRootMotion` — root translation forced to target bind so
 *     a walk clip plays in place.
 *   - `mirror` — reroutes target hashes: source L_* → target R_*.
 *
 * Stays pure JS — no Babylon imports — so it's testable in isolation
 * and the scene host can consume it without pulling Babylon types.
 */

import type { BakedAnimationDTO, AnmTrackDTO, AnmFrameDTO } from '../babylon/animationPlayer';
import type { SklJointDTO, SklSkeletonDTO } from '../babylon/skeletonBuilder';
import { IGNORED, type BoneMapping } from './boneMapping';

export interface RetargetOptions {
    /** Multiply ROOT bone translations by the ratio of target/source
     *  root-bone bind-translation magnitudes. Useful when the two
     *  rigs have very different scales (Annie ↔ Aurelion Sol) so
     *  locomotion clips don't move the target too far per frame.
     *  Non-root limb translations are always taken from the target
     *  bind, so this only meaningfully affects root locomotion. */
    rescaleTranslations: boolean;
    /** When ON, compute target rotations via the proper world-space
     *  walk (corrects for bind orientation differences and parent-
     *  chain orientation differences). When OFF, source local
     *  rotation is pasted directly onto the target — the naive
     *  same-rig path. */
    rebaseRotations: boolean;
    /** Force the root bone's translation to the target bind (zero
     *  locomotion). Useful for previewing a walk clip on a still
     *  target. Detects the root by the bone named exactly "root"
     *  (case-insensitive) on the source rig. */
    stripRootMotion: boolean;
    /** Reroute source `L_*` tracks to the target's `R_*` counterpart
     *  and vice versa. Useful when the source's left-arm motion
     *  should drive the target's right arm (mirror-image preview,
     *  or reusing a right-handed swing as left-handed). */
    mirror: boolean;
    /** Kept on the interface for backward compat with serialised
     *  `.animstudio.json` scenes. No longer drives behaviour —
     *  the world-space three-branch translation handles parent
     *  mismatches by converting source world position into the
     *  target's animated parent local frame, so an explicit
     *  "drop" toggle isn't necessary. */
    dropMismatchedParents: boolean;
    /** World Y offset applied to the target model's TransformNode
     *  (NOT through the retarget transform — handled by the scene
     *  host directly so the outermost mesh.worldMatrix shifts
     *  every vertex uniformly). Use this to pull a clip out of the
     *  floor. 0 = no lift. */
    verticalOffset: number;
    /** Mesh names within the target object that should NOT receive
     *  the `verticalOffset`. Lets the user keep specific
     *  submeshes (props, weapons) at their original world Y while
     *  the body lifts. Stored as names rather than indices so
     *  SKN swaps preserve user intent when the new rig has the
     *  same submesh names. */
    verticalOffsetExcludedMeshes: string[];

    // ── Babylon `IRetargetOptions` direct mappings ──────────────
    // Surfaced individually so the panel can expose them as the
    // Babylon retargeting tool does. Defaults aligned with the
    // most useful values for cross-rig League retargets.

    /** Babylon's `fixGroundReference` — anchor the ground-reference
     *  bone (e.g. L_Foot) to the source's vertical world position
     *  at every frame so the character doesn't float / sink.
     *  Default true, but requires `groundReferenceNodeName` set. */
    fixGroundReference: boolean;
    /** Babylon's `fixGroundReferenceDynamicRefNode` — per-frame
     *  scan for the lowest bone, makes the ground anchor robust
     *  during kicks / crouches. Only meaningful with
     *  `fixGroundReference` on. */
    fixGroundReferenceDynamicRefNode: boolean;
    /** Babylon's `fixAnimations` — clean up orthogonal-quaternion
     *  data errors in keyframes. Cheap and safe; default on. */
    fixAnimations: boolean;
    /** Babylon's `rootNodeName` — name of the source bone treated
     *  as the root for root-position fixing and ground reference.
     *  Empty string = auto-detect (first source bone with no
     *  parent). League rigs canonically use "Root". */
    rootNodeName: string;
    /** Babylon's `groundReferenceNodeName` — name of the source
     *  bone treated as the ground contact (typically a foot or
     *  toe bone). Required for `fixGroundReference` and the
     *  proportional rescale in `fixRootPosition`. Empty string
     *  means feature off (Babylon won't run that pass). */
    groundReferenceNodeName: string;
    /** Babylon's `groundReferenceVerticalAxis` — which world axis
     *  is "up" in the source animation's space. Empty string =
     *  auto-detect from root-to-ground vector. */
    groundReferenceVerticalAxis: '' | 'X' | 'Y' | 'Z';
}

/** Per-bone override that strips the bone's animation and pins it
 *  to a "follow" target bone at a tweakable XYZ offset. By default
 *  the follow bone is the constrained bone's own SKL parent; an
 *  explicit `followBoneHash` lets the user glue it to a different
 *  bone instead (e.g. weapon → L_Hand even though the SKL says
 *  weapon's parent is R_Hand).
 *
 *  Designed for cross-rig retargets where the source's track
 *  produces nonsense on the target because of parent / rig
 *  differences. The guided bone:
 *    - Receives no per-frame source rotation (uses bind rotation)
 *    - Sits at follow-bone-relative XYZ offset
 *    - Rides the follow bone's animated motion automatically
 *      (computed per-frame from the rest of the retargeted
 *       animation's bone chain)
 *
 *  For Jax: a guide on `Weapon` with `followBoneHash = R_Hand`
 *  pins the weapon firmly in the grip, even though Babylon's
 *  retargeter would normally route the source's weapon track
 *  through some other path. */
export interface BoneGuide {
    /** Hash of the target bone being constrained. */
    targetBoneHash: number;
    /** Position offset relative to the follow bone's animated
     *  local frame. */
    offsetX: number;
    offsetY: number;
    offsetZ: number;
    /** Optional explicit follow bone (target rig). When `null`
     *  or absent, the constrained bone's SKL parent is used. */
    followBoneHash?: number | null;
    /** Rotation offset in EULER DEGREES (XYZ order), applied
     *  AFTER the bone's bind local rotation in the follow bone's
     *  frame. Use to correct orientation when gluing to a bone
     *  whose local axes differ from the bone's SKL parent — e.g.
     *  weapon (authored relative to R_Hand) glued to L_Hand:
     *  L_Hand has different bind orientation, so the weapon needs
     *  ~180° around one axis to point the right way. Optional /
     *  default 0 for back-compat with older scene files. */
    rotX?: number;
    rotY?: number;
    rotZ?: number;
}

/**
 * Spring-chain physics rig for a sequence of connected bones (cape,
 * tail, hair, scarf). The chain "lags behind" its first bone's
 * animated motion under gravity + damping, swings naturally, and gets
 * baked into the target DTO at retarget time. Cheap O(frames × chain)
 * pass — no Babylon physics plugin involved.
 *
 * The chain root (`boneHashes[0]`) is treated as the anchor: it stays
 * driven by the retargeted animation. Every subsequent bone is
 * simulated relative to its predecessor's animated world position,
 * with the length constraint pulling it back to its bind distance.
 */
export interface PhysicsChain {
    /** Stable id so the React panel can key rows. Generated client-side
     *  with `Math.random().toString(36)`. */
    id: string;
    /** Display name. Optional; falls back to "Chain <root-bone>". */
    name?: string;
    /** Target-bone hashes from root to tip. Index 0 anchors to the
     *  animated rig; indices 1..N are simulated. */
    boneHashes: number[];
    /** Spring stiffness — how hard each bone is pulled toward its
     *  rigid-attachment target. 1 = stiff (almost rigid), 0 = floppy.
     *  Per-frame factor, so values are stable across fps. */
    stiffness: number;
    /** Velocity damping per second (0..1). 1 = no damping, 0 = full
     *  damping (no inertia). Typical: 0.85. */
    damping: number;
    /** Gravity acceleration (world units / s²). Applied along world
     *  -Y. Set to 0 for hair/scarf that floats. */
    gravity: number;
    /** Optional inertia: a fraction of the anchor bone's per-frame
     *  velocity is injected into each chain bone, so a sudden swing
     *  drags the tail along. 0 = no propagation, 1 = full. */
    inertia: number;
    /** When true, distances between successive bones are clamped to
     *  the rest length each frame so the chain can't stretch. */
    lockLength: boolean;
    /** Which integrator bakes this chain. `'simple'` (default) uses the
     *  built-in spring-damper-PBD solver; `'havok'` runs a deterministic
     *  headless Havok rigid-body sim for more accurate cloth/hair swing.
     *  Both write the same baked keyframes, so playback + .anm export
     *  are identical either way. */
    solver?: 'simple' | 'havok';
    /** Optional per-bone weight multiplier, aligned to `boneHashes`
     *  (index 0 = anchor, unused). 1 = default mass. Heavier bones exert
     *  more gravitational pull on the chain, so weighting the tip drags
     *  the whole cape/tail down instead of it gliding like paper. Havok
     *  solver only (the simple solver has no mass concept). Missing /
     *  undefined entries are treated as 1. */
    boneWeights?: number[];
    /** Loop-blend window, in trailing frames (0 = off). For cyclic
     *  clips (run / idle), the baked chain rarely ends where it began,
     *  so the loop seam pops. This eases the last N frames toward the
     *  first frame's pose — distributing the start↔end gap across the
     *  window so frame N-1 lands on frame 0 (frame 0 itself untouched),
     *  giving a seamless loop. Applies to both solvers. */
    loopBlend?: number;
}

/**
 * Spherical collider preventing simulated chain bones from clipping
 * into a body bone (e.g. legs, spine). The sphere rides the bone's
 * animated world position and pushes any chain particle that ends up
 * inside it back to the surface.
 */
export interface PhysicsCollider {
    /** Stable id for the React panel. */
    id: string;
    /** Bone the sphere is attached to (target rig). */
    boneHash: number;
    /** Sphere radius in world units. */
    radius: number;
    /** Optional offset from the bone's world position in the bone's
     *  local frame. Most colliders sit centred on the joint, but a
     *  leg sphere often wants to ride a bit along the bone axis. */
    offsetX: number;
    offsetY: number;
    offsetZ: number;
}

export const DEFAULT_RETARGET_OPTIONS: RetargetOptions = {
    // Defaults: just the three knobs the user wanted on out-of-the-
    // box — `retargetAnimationKeys` (rebaseRotations) does the
    // change-of-basis math, `fixRootPosition` (rescaleTranslations)
    // scales root locomotion to target rig size, and `fixAnimations`
    // cleans up quaternion-orthogonality keyframe errors. Everything
    // else stays off until the user explicitly turns it on.
    rescaleTranslations: true,
    rebaseRotations: true,
    stripRootMotion: false,
    mirror: false,
    dropMismatchedParents: false,
    verticalOffset: 0,
    verticalOffsetExcludedMeshes: [],

    fixGroundReference: false,
    fixGroundReferenceDynamicRefNode: false,
    fixAnimations: true,
    // League rigs canonically have a "Root" bone. Leave it
    // hard-set so first-time users don't have to fiddle to get
    // root-position / ground-ref features working.
    rootNodeName: 'Root',
    // Empty default — the panel auto-fills with L_Foot when a
    // source SKL loads if such a bone exists. Setting a default
    // here would lie if the rig has different naming.
    groundReferenceNodeName: '',
    groundReferenceVerticalAxis: '',
};

// ── Type shorthand ─────────────────────────────────────────────────

type Quat = [number, number, number, number]; // x, y, z, w
type Vec3 = [number, number, number];
const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
const ZERO_VEC: Vec3 = [0, 0, 0];

interface WorldPose {
    rot: Quat;
    pos: Vec3;
}

/**
 * Build a retargeted `BakedAnimationDTO` from a source clip via a
 * world-space hierarchical walk.
 */
export function retargetAnimation(
    source: BakedAnimationDTO,
    sourceSkl: SklSkeletonDTO,
    targetSkl: SklSkeletonDTO,
    options: RetargetOptions,
    mapping: BoneMapping,
    guides: BoneGuide[] = [],
): BakedAnimationDTO {
    // Index guides by target bone hash for O(1) per-bone lookup.
    const guideByTargetHash = new Map<number, BoneGuide>();
    for (const g of guides) guideByTargetHash.set(g.targetBoneHash, g);
    const sourceByHash = jointsByHash(sourceSkl);
    const targetByHash = jointsByHash(targetSkl);

    const sourceWorldBind = computeWorldBindPoses(sourceSkl);
    const targetWorldBind = computeWorldBindPoses(targetSkl);

    // Mirror swaps the TARGET hash (so source L → target R).
    const targetMirrorMap = options.mirror
        ? buildMirrorMap(targetSkl, jointsByName(targetSkl))
        : null;

    // Index source tracks by joint id for O(1) per-frame lookup.
    const sourceTrackById = new Map<number, AnmTrackDTO>();
    for (const t of source.tracks) {
        const j = sourceByHash.get(t.joint_hash);
        if (j) sourceTrackById.set(j.id, t);
    }

    // For each TARGET joint id, find the source joint that drives
    // it via the mapping (with optional mirror swap). Only target
    // bones we actually have an output to produce go in here.
    //
    // Multiple source bones could in theory map to the same target
    // (last write wins) — overrides set up that way are pathological
    // but we don't crash on them.
    const sourceJointForTargetId = new Map<number, SklJointDTO>();
    for (const [sourceHash, entry] of mapping) {
        if (entry === IGNORED) continue;
        let targetHash = entry;
        if (targetMirrorMap) {
            const swapped = targetMirrorMap.get(targetHash);
            if (swapped !== undefined) targetHash = swapped;
        }
        const tj = targetByHash.get(targetHash);
        const sj = sourceByHash.get(sourceHash);
        if (!tj || !sj || !sourceTrackById.has(sj.id)) continue;
        sourceJointForTargetId.set(tj.id, sj);
    }

    // Root-motion handling: identify the source root by name. We
    // strip / rescale only this bone's translation, all others use
    // target bind translations (limb-keeps-its-attachment behaviour).
    const sourceRootId = findRootBoneId(sourceSkl);

    const sourceFrameCount = source.frame_count;
    // Output frames keyed by target joint id. Initialised as empty
    // arrays sized for the full clip; un-driven target bones get no
    // entry at all (and so no output track).
    const outputFramesByTargetId = new Map<number, AnmFrameDTO[]>();
    const ensureFrames = (tid: number): AnmFrameDTO[] => {
        let f = outputFramesByTargetId.get(tid);
        if (!f) {
            f = new Array(sourceFrameCount);
            outputFramesByTargetId.set(tid, f);
        }
        return f;
    };

    // Per-frame scratch buffers — reused across frames to avoid
    // allocating two N-joint arrays × frame-count times.
    const sourceWorldAnim: WorldPose[] = new Array(sourceSkl.joints.length);
    const targetWorldAnim: WorldPose[] = new Array(targetSkl.joints.length);

    for (let frame = 0; frame < sourceFrameCount; frame++) {
        // ── Step 1: source's animated world TRS, per joint id ──
        for (const sj of sourceSkl.joints) {
            const track = sourceTrackById.get(sj.id);
            const pose = track
                ? (track.frames[frame] ?? track.frames[track.frames.length - 1])
                : null;
            const localRot = pose ? pose.rotation : sj.local_rotation;
            const localTrans = pose ? pose.translation : sj.local_translation;
            sourceWorldAnim[sj.id] = composeChild(
                sj.parent_id >= 0 ? sourceWorldAnim[sj.parent_id] : null,
                localRot as Quat,
                localTrans as Vec3,
            );
        }

        // ── Step 2: target's animated world TRS, per joint id ──
        // Same topological order pass, but the local rotation /
        // translation we feed into composeChild comes from the
        // retarget logic when a source bone drives this target.
        for (const tj of targetSkl.joints) {
            const tParentWorldAnim = tj.parent_id >= 0
                ? targetWorldAnim[tj.parent_id]
                : null;
            const sJoint = sourceJointForTargetId.get(tj.id);
            const guide = guideByTargetHash.get(tj.name_hash);

            let localRot: Quat;
            let localTrans: Vec3;

            if (guide) {
                // Guided bone: pin to target bind rotation, ride
                // the animated parent. Translation = bind local +
                // user-set XYZ offset (in parent-local frame).
                // The rotation track from any mapped source bone
                // is dropped entirely so this stays a clean rigid
                // attachment — e.g. weapon doesn't twist
                // independently from the hand. The animation
                // reaches it only through its parent chain.
                const tBindL = tj.local_translation as Vec3;
                localRot = [...(tj.local_rotation as Quat)] as Quat;
                localTrans = [
                    tBindL[0] + guide.offsetX,
                    tBindL[1] + guide.offsetY,
                    tBindL[2] + guide.offsetZ,
                ];
                // Emit a frame so the output animation actually
                // forces the guided pose every frame; without
                // this, the player would fall back to whatever
                // rest pose the bone happened to be at, which on
                // a re-load isn't necessarily our bind+offset.
                const frames = ensureFrames(tj.id);
                frames[frame] = {
                    translation: localTrans,
                    rotation: localRot,
                    scale: [1, 1, 1],
                };
                targetWorldAnim[tj.id] = composeChild(tParentWorldAnim, localRot, localTrans);
                continue;
            }

            if (sJoint) {
                // Driven by a source bone. Compute the rotation via
                // world-space delta when rebase is on; verbatim
                // passthrough when off.
                const sWorld = sourceWorldAnim[sJoint.id];
                const sBindWorld = sourceWorldBind[sJoint.id];
                const tBindWorld = targetWorldBind[tj.id];

                if (options.rebaseRotations) {
                    // worldDelta = sourceAnimWorld · sourceBindWorld⁻¹
                    // targetAnimWorld = worldDelta · targetBindWorld
                    // localRot = (targetParentAnimWorld)⁻¹ · targetAnimWorld
                    const worldDelta = quatMul(sWorld.rot, quatInverse(sBindWorld.rot));
                    const tWorldRot = quatMul(worldDelta, tBindWorld.rot);
                    const parentRotInv = quatInverse(
                        tParentWorldAnim ? tParentWorldAnim.rot : IDENTITY_QUAT,
                    );
                    localRot = quatMul(parentRotInv, tWorldRot);
                    quatNormalizeInPlace(localRot);
                } else {
                    // Naive copy: paste source local rotation as
                    // target local rotation. The track frame's
                    // rotation is already in the source bone's
                    // local frame (i.e. parent-relative); this works
                    // when source and target bones share both bind
                    // and parent orientations.
                    const track = sourceTrackById.get(sJoint.id);
                    const pose = track
                        ? (track.frames[frame] ?? track.frames[track.frames.length - 1])
                        : null;
                    localRot = pose
                        ? [...(pose.rotation as Quat)] as Quat
                        : [...(tj.local_rotation as Quat)] as Quat;
                }

                // Translation branches.
                //
                //   - source root → pass through source's animated
                //     local translation (locomotion / attack
                //     lunge), with optional rescale + strip
                //   - matched parent (limbs) → target bind local
                //   - mismatched parent (Weapon parented to Root
                //     on source but R_Hand on target) → convert
                //     source's animated WORLD position into the
                //     target's animated parent local frame, so
                //     the bone lands at the right world position
                //     even when its parent is a completely
                //     different bone on the target rig
                const sParent = sJoint.parent_id >= 0
                    ? sourceSkl.joints[sJoint.parent_id]
                    : null;
                const tParent = tj.parent_id >= 0
                    ? targetSkl.joints[tj.parent_id]
                    : null;
                const isRoot = sJoint.id === sourceRootId;
                const parentsMatch = !!sParent && !!tParent
                    && sParent.name.toLowerCase() === tParent.name.toLowerCase();

                if (isRoot) {
                    if (options.stripRootMotion) {
                        localTrans = [...(tj.local_translation as Vec3)] as Vec3;
                    } else {
                        const track = sourceTrackById.get(sJoint.id);
                        const pose = track
                            ? (track.frames[frame] ?? track.frames[track.frames.length - 1])
                            : null;
                        const srcLocal = (pose ? pose.translation : sJoint.local_translation) as Vec3;
                        if (options.rescaleTranslations) {
                            const r = boneTranslationRatio(sJoint, tj);
                            localTrans = [srcLocal[0] * r, srcLocal[1] * r, srcLocal[2] * r];
                        } else {
                            localTrans = [...srcLocal] as Vec3;
                        }
                    }
                    // NOTE: `options.verticalOffset` is intentionally
                    // NOT applied here. League skinned meshes have
                    // bone weights that don't always propagate a
                    // Root translation to every vertex (the body
                    // gets driven by skinning math through specific
                    // bones; not all of them cleanly inherit from
                    // Root). Instead, we lift the entire model's
                    // TransformNode in the scene — the outermost
                    // mesh.worldMatrix shifts every vertex
                    // uniformly. Applied by the scene host, not by
                    // this pure transform.
                } else if (parentsMatch) {
                    // Limb case — target bind keeps the bone at
                    // its rig's natural offset from its parent.
                    localTrans = [...(tj.local_translation as Vec3)] as Vec3;
                } else {
                    // Mismatched parent — convert source's
                    // animated WORLD position to target parent's
                    // animated local frame. For Jax: source
                    // weapon's world position (already a world-
                    // space-ish track because skin14 parents it
                    // to Root) becomes a local translation
                    // relative to target's animated R_Hand. The
                    // weapon ends up at the right world position
                    // regardless of its different parent on
                    // target.
                    const swp = sWorld.pos;
                    const parentRot = tParentWorldAnim
                        ? tParentWorldAnim.rot
                        : IDENTITY_QUAT;
                    const parentPos = tParentWorldAnim
                        ? tParentWorldAnim.pos
                        : ZERO_VEC;
                    const dx = swp[0] - parentPos[0];
                    const dy = swp[1] - parentPos[1];
                    const dz = swp[2] - parentPos[2];
                    localTrans = quatRotateVec3Inv(parentRot, [dx, dy, dz]);
                }

                // Emit this bone's output frame.
                const frames = ensureFrames(tj.id);
                frames[frame] = {
                    translation: localTrans,
                    rotation: localRot,
                    scale: [1, 1, 1],
                };
            } else {
                // Not driven — bone stays at bind in its parent's
                // animated frame.
                localRot = tj.local_rotation as Quat;
                localTrans = tj.local_translation as Vec3;
            }

            targetWorldAnim[tj.id] = composeChild(tParentWorldAnim, localRot, localTrans);
        }
    }

    const tracks: AnmTrackDTO[] = [];
    for (const [tid, frames] of outputFramesByTargetId) {
        const tj = targetSkl.joints[tid];
        if (!tj) continue;
        tracks.push({
            joint_hash: tj.name_hash,
            frames,
        });
    }

    return {
        duration: source.duration,
        fps: source.fps,
        frame_count: source.frame_count,
        tracks,
    };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Walk the parent chain to compute each joint's bind-pose world
 *  rotation + position. Assumes joints are in topological order
 *  (parent_id < own id) — League SKLs satisfy this. */
function computeWorldBindPoses(skl: SklSkeletonDTO): WorldPose[] {
    const out: WorldPose[] = new Array(skl.joints.length);
    for (let i = 0; i < skl.joints.length; i++) {
        const j = skl.joints[i];
        const parent = j.parent_id >= 0 && j.parent_id < i
            ? out[j.parent_id]
            : null;
        out[i] = composeChild(
            parent,
            j.local_rotation as Quat,
            j.local_translation as Vec3,
        );
    }
    return out;
}

/** Compose a child's world pose from its parent's world pose + the
 *  child's local TRS. Identity parent (`null`) means the child IS
 *  in world space. */
function composeChild(
    parent: WorldPose | null,
    localRot: Quat,
    localTrans: Vec3,
): WorldPose {
    if (!parent) {
        return {
            rot: [localRot[0], localRot[1], localRot[2], localRot[3]],
            pos: [localTrans[0], localTrans[1], localTrans[2]],
        };
    }
    const rotated = quatRotateVec3(parent.rot, localTrans);
    return {
        rot: quatMul(parent.rot, localRot),
        pos: [
            parent.pos[0] + rotated[0],
            parent.pos[1] + rotated[1],
            parent.pos[2] + rotated[2],
        ],
    };
}

/** Find the joint named "root" (case-insensitive). Returns its id
 *  for fast comparison in the inner translation branch. */
function findRootBoneId(skl: SklSkeletonDTO): number | null {
    for (const j of skl.joints) {
        if (j.name.toLowerCase() === 'root') return j.id;
    }
    return null;
}

function jointsByHash(skl: SklSkeletonDTO): Map<number, SklJointDTO> {
    const m = new Map<number, SklJointDTO>();
    for (const j of skl.joints) m.set(j.name_hash, j);
    return m;
}

function jointsByName(skl: SklSkeletonDTO): Map<string, SklJointDTO> {
    const m = new Map<string, SklJointDTO>();
    for (const j of skl.joints) m.set(j.name.toLowerCase(), j);
    return m;
}

/** Pair `L_*`/`R_*` bones on the same rig. Used by the mirror flag
 *  to reroute the L animation to R and vice versa. */
function buildMirrorMap(
    skl: SklSkeletonDTO,
    byName: Map<string, SklJointDTO>,
): Map<number, number> {
    const m = new Map<number, number>();
    for (const j of skl.joints) {
        const name = j.name.toLowerCase();
        let mirroredName: string | null = null;
        if (name.startsWith('l_')) mirroredName = 'r_' + name.slice(2);
        else if (name.startsWith('r_')) mirroredName = 'l_' + name.slice(2);
        if (!mirroredName) continue;
        const other = byName.get(mirroredName);
        if (other && !m.has(j.name_hash)) {
            m.set(j.name_hash, other.name_hash);
        }
    }
    return m;
}

/** Ratio of target / source bind-translation magnitudes. Used only
 *  for the root locomotion rescale; non-root translations use the
 *  target's bind directly. */
function boneTranslationRatio(s: SklJointDTO, t: SklJointDTO): number {
    const sLen = vec3Length(s.local_translation as Vec3);
    const tLen = vec3Length(t.local_translation as Vec3);
    const EPS = 1e-6;
    if (sLen < EPS || tLen < EPS) return 1;
    return tLen / sLen;
}

function vec3Length(v: Vec3): number {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function quatInverse(q: Quat): Quat {
    return [-q[0], -q[1], -q[2], q[3]];
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

/** Rotate a vector by a quaternion. Standard formula:
 *  `v' = v + 2·q.xyz × (q.xyz × v + q.w·v)`. */
function quatRotateVec3(q: Quat, v: Vec3): Vec3 {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    // t = 2 · (q.xyz × v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // v' = v + qw·t + q.xyz × t
    return [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ];
}

/** Rotate a vector by the INVERSE of a unit quaternion. Equivalent
 *  to `quatRotateVec3(quatInverse(q), v)` but avoids the quat
 *  construction. */
function quatRotateVec3Inv(q: Quat, v: Vec3): Vec3 {
    return quatRotateVec3([-q[0], -q[1], -q[2], q[3]], v);
}

function quatNormalizeInPlace(q: Quat): void {
    const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (len > 1e-8) {
        q[0] /= len;
        q[1] /= len;
        q[2] /= len;
        q[3] /= len;
    } else {
        q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1;
    }
}
