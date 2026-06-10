/**
 * 3D mesh preview component — renders an SKN file into a Babylon scene
 * with an orbit camera, basic lighting, and a ground grid.
 *
 * Phase 1: static-only. We render the SKN's bind-pose geometry as if
 * it were a rigid mesh — no skeleton, no animation, no textures. The
 * goal is to validate the parser + coordinate system + camera framing
 * end-to-end before layering SKL/skinning on top.
 *
 * The Babylon `Engine` is a singleton shared across all previews; this
 * component owns its own `Scene` and disposes it on unmount.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Side-effect import. Babylon registers its shader-include modules
// (helperFunctions, bonesDeclaration, lightFragment, …) lazily by
// importing them from each material's main module. With Vite + tree-
// shaken modular imports this chain sometimes loses entries, leaving
// the GLSL compiler to choke on unresolved `#include<…>` directives
// ("VERTEX SHADER ERROR: 0:46: '<' : syntax error"). Importing the
// umbrella once forces every ShadersInclude module to register, fully
// populating the ShaderStore for the whole app's lifetime. The cost
// is ~400KB of extra bundle — acceptable for a desktop Tauri app and
// far simpler than chasing the exact subset of includes we need.
import '@babylonjs/core';
import '@babylonjs/materials';

import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial';

import { createEngine, isAppVisible } from '../lib/babylon/engine';
import { buildSknMeshes, type SknDTO } from '../lib/babylon/meshBuilder';
import { buildBinaryStl } from '../lib/stlExport';
import {
    buildBabylonSkeleton,
    buildSkeletonJoints,
    buildSkeletonLines,
    buildSkeletonOctahedrons,
    type SklJointDTO,
    type SklSkeletonDTO,
} from '../lib/babylon/skeletonBuilder';
import {
    AnimationPlayer,
    resetSkeletonToRestPose,
    type BakedAnimationDTO,
} from '../lib/babylon/animationPlayer';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { Bone } from '@babylonjs/core/Bones/bone';

/** Serializable ArcRotateCamera orbit — enough to restore the exact
 *  view after MeshPreview is unmounted (Babylon torn down) and remounted. */
export interface MeshPreviewCameraState {
    alpha: number;
    beta: number;
    radius: number;
    target: [number, number, number];
}

interface MeshPreviewProps {
    /** Disk path or `wad://<mountId>/<pathHashHex>` source identifier. */
    source:
        | { kind: 'disk'; path: string }
        | { kind: 'wad'; mountId: number; pathHashHex: string };
    /** Optional caption shown in the corner. Useful while debugging. */
    label?: string;
    /** When true, MeshPreview suppresses its own overlay UI (settings
     *  + animations panels, format pill, loading text). Used by hosts
     *  like the Viewer's model stage that drive interactions via the
     *  controlled props below and render their own controls. */
    controlled?: boolean;
    /** Controlled selection of the current animation clip by name. Only
     *  honored when `controlled` is true. `null` clears playback. */
    selectedAnimationName?: string | null;
    /** Controlled visibility for each submesh, keyed by submesh name.
     *  Unknown names are ignored. Only honored when `controlled`. */
    submeshVisibility?: Record<string, boolean>;
    /** Controlled playback paused-state. Honored only when `controlled`. */
    playerPaused?: boolean;
    /** Controlled playback speed (1 = normal). Honored only when `controlled`. */
    playerSpeed?: number;
    /** Chroma id (CDragon, e.g. 266001). `null` = base skin (no
     *  overrides applied). Only honored when `controlled`. */
    chromaId?: number | null;
    /** Render the alternate "shadow / demon" diffuse instead of the
     *  default when the resolved material has one (Evelynn's shadow
     *  form). Only honored when `controlled`. */
    shadowForm?: boolean;
    /** Enable alpha-test/blend on textures that carry an alpha channel.
     *  When `false`, materials render fully opaque regardless of
     *  texture alpha (closer to in-game look for skins like Evelynn
     *  where ALPHATEST clips visible pixels). Default: true. */
    transparencyEnabled?: boolean;
    /** Alpha-test cutoff (0..1). Pixels with alpha below this are
     *  discarded. Lower = more pixels kept (better for Aurelion Sol's
     *  soft tail); higher = harsher clip. Default: 0.2. */
    alphaCutoff?: number;
    /** Fires when the resolved material declares (or doesn't declare)
     *  an alternate shadow-form texture. Host uses this to decide
     *  whether to surface the shadow-form toggle in its UI. */
    onShadowAvailable?: (available: boolean) => void;
    /** Fires whenever the per-submesh texture bindings get resolved
     *  (initial load + chroma swap). Hosts use this to pipe the
     *  viewer's authoritative mapping through to other consumers
     *  (e.g. Photo Studio's "Send to Photo Studio" handoff). */
    onTextureBindingsReady?: (
        entries: Array<{ submeshName: string; chunkHashHex: string | null }>,
    ) => void;
    /** Fires once the animation listing for this source resolves. */
    onAnimationsLoaded?: (listing: AnimationListing | null) => void;
    /** Fires once the SKN submesh names are known (in source order). */
    onSubmeshesLoaded?: (names: string[]) => void;
    /** Notified with the resolved alternate-form availability so the host
     *  can show / hide the toggle. */
    /** When provided, MeshPreview writes a callable into `.current` that
     *  builds a binary STL of all currently-visible meshes (world-space).
     *  Hosts (e.g. the Viewer's Export accordion) keep this ref alive
     *  across renders and call it when the user clicks "Export STL".
     *  The callable returns `null` when there's nothing to serialize. */
    exportStlRef?: React.MutableRefObject<(() => Uint8Array | null) | null>;
    /** Fires on every render-loop tick with the live animation player
     *  state. Hosts use this to drive a seek-bar UI. `duration` is 0
     *  when no clip is loaded; `time` resets to 0 on clip change. */
    onPlayerProgress?: (info: { time: number; duration: number; paused: boolean }) => void;
    /** When provided, MeshPreview writes a callable into `.current` that
     *  seeks the active animation player to a given time (seconds).
     *  No-op when no clip is loaded. */
    seekRef?: React.MutableRefObject<((time: number) => void) | null>;
    /** Host-owned ref for camera persistence. MeshPreview reads it when
     *  framing a freshly-loaded model — restoring a saved orbit instead
     *  of the default 3/4 view — and writes the live camera into it as
     *  the user orbits. Lets a host unmount MeshPreview to free Babylon
     *  on tab-switch and restore the exact view on remount. */
    cameraStateRef?: React.MutableRefObject<MeshPreviewCameraState | null>;
    /** Host-owned ref for animation-player persistence. MeshPreview reads
     *  it ONCE when (re)creating the player after a remount — restoring
     *  the exact frame + paused-state the user left on instead of
     *  resetting to playing@0 — and the host keeps it current via
     *  onPlayerProgress. Lets the Viewer free Babylon on tab-switch
     *  without unpausing / losing a paused shot. */
    playerRestoreRef?: React.MutableRefObject<{ time: number; paused: boolean } | null>;
}

type ShadingMode = 'flat' | 'lit';
type MissingStyle = 'material-color' | 'pattern';
/// Skeleton render style.
///   - 'joints'      Maya-style: a sphere at each joint plus thin line
///                   connectors between parent and child. Default.
///   - 'octahedrons' Blender-style: a stretched octahedron per
///                   parent→child link. No joint markers.
///   - 'lines'       Just the line connectors. Lightest variant.
type SkeletonStyle = 'joints' | 'lines' | 'octahedrons';

/// Per-submesh display state — kept in a ref (not React state) because
/// the render loop reads from it every frame and we don't want to
/// trigger a React re-render every time a texture lands.
interface SubmeshSlot {
    mat: PBRMaterial;
    /// Per-submesh hue color used for the placeholder "material color"
    /// look (and as the visible fallback while textures are still
    /// fetching).
    hue: Color3;
    /// Chunk hash hex of the texture currently slotted onto this
    /// material, or `null` if nothing's resolved yet.
    chunkHash: string | null;
}

export function MeshPreview({
    source,
    label,
    controlled = false,
    selectedAnimationName,
    submeshVisibility,
    playerPaused: controlledPaused,
    playerSpeed: controlledSpeed,
    chromaId,
    shadowForm,
    transparencyEnabled = true,
    alphaCutoff = 0.2,
    onAnimationsLoaded,
    onSubmeshesLoaded,
    onShadowAvailable,
    onTextureBindingsReady,
    exportStlRef,
    onPlayerProgress,
    seekRef,
    cameraStateRef,
    playerRestoreRef,
}: MeshPreviewProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<Scene | null>(null);
    const meshesRef = useRef<Mesh[]>([]);
    // One-shot guard: restore the saved player frame/pause only on the
    // first clip load after a (re)mount, not on later clip switches.
    const hasRestoredPlayerRef = useRef(false);

    /// Per-submesh material slots keyed by index. Materials, hue
    /// colors, and currently-applied chunk hash all live here.
    const slotsRef = useRef<SubmeshSlot[]>([]);
    /// Loaded GPU textures, keyed by chunk hash. Shared across slots
    /// when multiple submeshes use the same texture chunk.
    const loadedTexturesRef = useRef<Map<string, { tex: RawTexture; hasAlpha: boolean }>>(
        new Map(),
    );
    /// Lazy-built 2×2 magenta/black checkerboard for the missing-
    /// texture look. Constructed on first need, reused thereafter.
    const placeholderTexRef = useRef<RawTexture | null>(null);
    /// `true` when the active mesh is a static format (SCB/SCO) —
    /// they're frequently flat particle quads / single-sided
    /// geometry that needs to render from both sides regardless of
    /// winding. SKN meshes keep normal back-face culling. Updated
    /// once per fetchAndBuild and read by `refreshMaterials`.
    const doubleSidedRef = useRef(false);

    /// Skeleton overlay — populated when:
    ///   1. Source is a `.skl` (standalone skeleton preview), or
    ///   2. Source is a `.skn` and a sibling `.skl` exists in the
    ///      same WAD / folder (rendered hidden by default; user
    ///      toggles via the settings panel).
    ///
    /// We build all three render styles eagerly and just toggle their
    /// `setEnabled` flags when the user flips the style switch —
    /// building everything is cheap (joint counts top out in the low
    /// hundreds, joint markers are thin-instanced into one mesh, the
    /// octahedron mesh shares a single VertexData) and avoids any
    /// rebuild lag on toggle. The 'joints' style enables BOTH the
    /// joint-marker mesh and the lines mesh together for the Maya
    /// look (sphere at each pivot, line connectors between them).
    const skeletonLinesRef = useRef<LinesMesh | null>(null);
    const skeletonOctaRef = useRef<Mesh | null>(null);
    const skeletonJointsRef = useRef<Mesh | null>(null);
    /// Latest loaded SknDTO — kept so the chroma swap effect can re-run
    /// the same per-submesh texture binding cascade without rebuilding
    /// the mesh from scratch. Cleared on source change.
    const sknRef = useRef<SknDTO | null>(null);
    /// Babylon Skeleton built from the same SKL the visualisations
    /// above came from. Attached to the SKN meshes (mesh.skeleton =)
    /// so Babylon's skinning shader picks up bone-driven vertex
    /// transforms; the AnimationPlayer mutates each bone's local
    /// TRS components every tick to drive the pose.
    const babylonSkeletonRef = useRef<Skeleton | null>(null);
    const bonesRef = useRef<Bone[] | null>(null);
    const boneIndexByHashRef = useRef<Map<number, number> | null>(null);
    /// Snapshot of the SKL joint DTOs at build time. The animation
    /// player needs these so it can reset bones to their rest TRS
    /// when initialising — bones not driven by the active clip get
    /// their original local position/rotation/scale back instead of
    /// inheriting the previous clip's last-frame pose.
    const sklJointsRef = useRef<SklJointDTO[] | null>(null);
    /// Active animation player + the render-loop unsubscribe for it.
    /// Replaced when the user picks a different clip; cleared on
    /// unmount.
    const animPlayerRef = useRef<AnimationPlayer | null>(null);
    const animUnsubscribeRef = useRef<(() => void) | null>(null);

    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    /** Per-submesh visibility list, in the same order as `built.meshes`.
     *  Driven by the visibility panel's checkboxes; toggling sets the
     *  corresponding Babylon mesh's `setEnabled(visible)`. */
    const [submeshes, setSubmeshes] = useState<{ name: string; visible: boolean }[]>([]);
    const [panelOpen, setPanelOpen] = useState(false);
    const [shadingMode, setShadingMode] = useState<ShadingMode>('flat');
    /// `true` once a skeleton is in the scene (either standalone SKL
    /// or sibling-of-SKN). Drives whether the visibility-toggle row
    /// shows up in the settings panel.
    const [skeletonAvailable, setSkeletonAvailable] = useState(false);
    /// Skeleton visibility. SKL standalone defaults this to true (the
    /// skeleton IS the preview). SKN overlay defaults to false — the
    /// user opts in via the toggle. We initialise it lazily inside
    /// fetchAndBuild based on the format.
    const [skeletonVisible, setSkeletonVisible] = useState(false);
    /// Render style for the skeleton — toggles which of the three
    /// pre-built mesh combinations is enabled. Default is 'joints'
    /// (Maya-style spheres + line connectors) because it reads the
    /// most cleanly without any extra explanation; the other two
    /// styles are one click away in the settings panel.
    const [skeletonStyle, setSkeletonStyle] = useState<SkeletonStyle>('joints');
    /// Animation listing for the SKN's skin BIN — `null` while
    /// loading or for non-SKN previews. The dropdown only renders
    /// when this resolves to a populated listing.
    const [animations, setAnimations] = useState<AnimationListing | null>(null);
    const [animationsPanelOpen, setAnimationsPanelOpen] = useState(false);
    const [animationFilter, setAnimationFilter] = useState('');
    const [selectedAnimation, setSelectedAnimation] = useState<AnimationClip | null>(null);
    /// Playback-controls state. Mirrored into `animPlayerRef.current`
    /// via effects below so the player's mutable fields stay in sync
    /// with React, but the player remains the source of truth for the
    /// per-frame pose. `playerTime` is read from the player at rAF
    /// cadence so the progress bar tracks live playback.
    const [playerPaused, setPlayerPaused] = useState(false);
    const [playerSpeed, setPlayerSpeed] = useState(1);
    const [playerTime, setPlayerTime] = useState(0);
    const [playerDuration, setPlayerDuration] = useState(0);
    /// Set when the user is actively dragging the scrub bar — pauses
    /// the rAF→React updates so React-driven `value` doesn't fight
    /// the slider thumb mid-drag.
    const [scrubbing, setScrubbing] = useState(false);

    /// Stable JSON key so effects only re-run when the source actually
    /// *changes*, not when the parent re-renders with a new `source`
    /// object literal (which happens whenever any parent state moves,
    /// even unrelated state like a filter input). Without this, the
    /// animation-load effect tears down + rebuilds the player mid-
    /// playback on every parent re-render — exactly the "stops at
    /// halfway and restarts on next play" symptom.
    const sourceKey =
        source.kind === 'disk'
            ? `disk:${source.path}`
            : `wad:${source.mountId}:${source.pathHashHex}`;
    /// X-ray draws skeleton meshes through the SKN geometry by
    /// promoting them to renderingGroupId=1 (rendered after group 0
    /// with a fresh depth buffer). Off pushes them back to group 0
    /// so they're occluded by the mesh — useful when you want to see
    /// which bones are visible without the mesh covering them.
    /// Default on so the skeleton is always visible at first; the
    /// toggle only surfaces when there's a mesh to occlude with
    /// (i.e. SKN previews — for standalone SKL the toggle is moot).
    const [skeletonXray, setSkeletonXray] = useState(true);
    // Default to the magenta/black checkerboard for missing textures —
    // it's the universally-recognized "missing texture" indicator and
    // makes failed BIN lookups visually obvious. Users who prefer the
    // distinct per-submesh hue palette can flip the toggle.
    const [missingStyle, setMissingStyle] = useState<MissingStyle>('pattern');
    const [guessing, setGuessing] = useState(false);

    /// Apply the current settings (shading + missing-texture style)
    /// across every submesh material. Idempotent — safe to call after
    /// each texture lands, after a settings toggle, or after a guess.
    const refreshMaterials = useCallback(() => {
        const scene = sceneRef.current;
        const slots = slotsRef.current;
        const loaded = loadedTexturesRef.current;
        if (!scene) return;
        const placeholder =
            missingStyle === 'pattern'
                ? (placeholderTexRef.current ??= buildPlaceholderTexture(scene))
                : null;
        const doubleSided = doubleSidedRef.current;
        // `transparencyEnabled` masks `hasAlpha` so the host can force
        // opaque rendering on skins where Riot's alpha bleed renders
        // wrong without engine-level cleanup (Evelynn's hair pixels).
        for (const slot of slots) {
            const real = slot.chunkHash ? loaded.get(slot.chunkHash) : undefined;
            if (real) {
                applyTexturedMaterial(
                    slot.mat,
                    real.tex,
                    real.hasAlpha && transparencyEnabled,
                    alphaCutoff,
                );
            } else if (placeholder) {
                applyTexturedMaterial(slot.mat, placeholder, false, alphaCutoff);
            } else {
                applyHueMaterial(slot.mat, slot.hue);
            }
            slot.mat.unlit = shadingMode === 'flat';
            if (doubleSided) {
                slot.mat.backFaceCulling = false;
            }
        }
    }, [missingStyle, shadingMode, transparencyEnabled, alphaCutoff]);

    // Expose a "build binary STL of all currently-visible meshes" callable
    // through the host's ref. Captured fresh each render so the host
    // always sees the latest meshes / pose / visibility — invoked on
    // demand when the user hits Export STL.
    useEffect(() => {
        if (!exportStlRef) return;
        exportStlRef.current = () => {
            const meshes = meshesRef.current;
            if (!meshes || meshes.length === 0) return null;
            return buildBinaryStl(meshes, 'Jade STL — League mesh export');
        };
        return () => {
            if (exportStlRef) exportStlRef.current = null;
        };
    }, [exportStlRef]);

    // -------------------- controlled-mode wiring --------------------
    // Notify hosts that consumed the listings; honor controlled props.
    // Refs avoid feedback loops when the host sets a prop in response
    // to our notification.

    useEffect(() => {
        if (onAnimationsLoaded) onAnimationsLoaded(animations);
    }, [animations, onAnimationsLoaded]);

    useEffect(() => {
        if (!onSubmeshesLoaded) return;
        if (submeshes.length === 0) return;
        onSubmeshesLoaded(submeshes.map((s) => s.name));
        // Fire once per load — re-runs whenever the names actually
        // change. Toggling visibility doesn't change names so the
        // effect's deps array (submeshes.length + first name) avoids
        // spamming on each click.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [submeshes.length, submeshes[0]?.name]);

    // Controlled: parent picks an animation by name. We look it up in
    // the loaded listing and forward to internal state.
    useEffect(() => {
        if (!controlled) return;
        if (!animations) return;
        if (selectedAnimationName == null) {
            setSelectedAnimation(null);
            return;
        }
        const clip = animations.clips.find((c) => c.name === selectedAnimationName);
        if (clip) setSelectedAnimation(clip);
    }, [controlled, selectedAnimationName, animations]);

    // Controlled: parent dictates pause + speed for the active player.
    useEffect(() => {
        if (!controlled) return;
        if (controlledPaused === undefined) return;
        setPlayerPaused(controlledPaused);
    }, [controlled, controlledPaused]);

    useEffect(() => {
        if (!controlled) return;
        if (controlledSpeed === undefined) return;
        setPlayerSpeed(controlledSpeed);
    }, [controlled, controlledSpeed]);

    // Controlled: chroma swap. When `chromaId` changes (or clears to
    // null), re-resolve textures via the chroma command (or the base
    // command for null) and re-apply them to the already-built meshes.
    // No re-fetch of the SKN itself — only the texture bindings change.
    useEffect(() => {
        if (!controlled) return;
        if (source.kind !== 'wad') return; // disk chromas aren't a thing yet
        const skn = sknRef.current;
        const scene = sceneRef.current;
        if (!skn || !scene) return;
        const slots = slotsRef.current;
        if (slots.length === 0) return;
        let cancelled = false;
        const mountId = source.mountId;
        const sknPathHash = source.pathHashHex;

        (async () => {
            // Fetch the right binding set. chromaId === null falls back
            // to the base bindings; otherwise pull the merged chroma map.
            let map: SknTextureBindings | null = null;
            try {
                if (chromaId == null) {
                    map = await invoke<SknTextureBindings | null>('wad_read_skin_textures', {
                        id: mountId,
                        pathHashHex: sknPathHash,
                    });
                } else {
                    map = await invoke<SknTextureBindings | null>('wad_read_chroma_textures', {
                        id: mountId,
                        pathHashHex: sknPathHash,
                        chromaId,
                    });
                    // Chroma not found in BIN → silently skip (keeps
                    // whatever the model was last showing). Logged so
                    // we can see why a click did nothing.
                    if (!map) {
                        console.warn(`[MeshPreview] chroma ${chromaId} not in BIN — keeping base bindings`);
                        return;
                    }
                }
            } catch (e) {
                console.warn('[MeshPreview] chroma fetch failed:', e);
                return;
            }
            if (cancelled || !map) return;

            // Surface shadow-form availability so the host can hide the
            // toggle when there's no alternate.
            if (onShadowAvailable) {
                onShadowAvailable(!!map.shadow_chunk_hash_hex);
            }

            const bindingByName = new Map<string, TextureBinding>();
            for (const b of map.bindings) {
                bindingByName.set(b.material.toLowerCase(), b);
            }

            // Pick the effective default — shadow texture wins when the
            // host has toggled shadow form on AND the BIN supplies one.
            const effectiveDefault =
                shadowForm && map.shadow_chunk_hash_hex
                    ? map.shadow_chunk_hash_hex
                    : map.default_chunk_hash_hex;

            const indicesByHash = new Map<string, number[]>();
            for (let i = 0; i < skn.submeshes.length; i++) {
                const name = skn.submeshes[i].name.toLowerCase();
                const b = bindingByName.get(name);
                const hash = b?.chunk_hash_hex ?? effectiveDefault;
                if (!hash) continue;
                const slot = slots[i];
                if (slot) slot.chunkHash = hash;
                const list = indicesByHash.get(hash) ?? [];
                list.push(i);
                indicesByHash.set(hash, list);
            }

            // Surface the per-submesh binding to the host so it can be
            // forwarded to other consumers (Photo Studio handoff).
            if (onTextureBindingsReady) {
                onTextureBindingsReady(
                    skn.submeshes.map((sm, i) => ({
                        submeshName: sm.name,
                        chunkHashHex: slots[i]?.chunkHash ?? null,
                    })),
                );
            }

            const loaded = loadedTexturesRef.current;
            const work = Array.from(indicesByHash.keys()).map(async (hash) => {
                if (loaded.has(hash)) return; // already in cache
                const decoded = await loadTextureFromHash(mountId, hash, scene);
                if (cancelled || !decoded) return;
                loaded.set(hash, decoded);
            });
            await Promise.allSettled(work);
            if (!cancelled) refreshMaterials();
        })();

        return () => {
            cancelled = true;
        };
        // `source` is a fresh object reference on every parent render,
        // so listing it as a dep here would re-fire this effect every
        // single frame once the seek bar started ticking — re-reading
        // and re-parsing the skin BIN on the Rust side at render rate
        // (the "BIN converting on loop / 100% CPU" symptom). Depend on
        // the stable `sourceKey` instead; the closure still captures
        // the freshest `source` object via `source.mountId / .pathHashHex`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [controlled, chromaId, shadowForm, sourceKey, refreshMaterials, onShadowAvailable]);

    // Controlled: parent dictates per-submesh visibility by name.
    useEffect(() => {
        if (!controlled) return;
        if (!submeshVisibility) return;
        setSubmeshes((prev) => {
            let mutated = false;
            const next = prev.map((s, i) => {
                const want = submeshVisibility[s.name];
                if (want === undefined || want === s.visible) return s;
                mutated = true;
                const mesh = meshesRef.current[i];
                if (mesh) mesh.setEnabled(want);
                return { ...s, visible: want };
            });
            return mutated ? next : prev;
        });
    }, [controlled, submeshVisibility]);

    // Re-apply when toggles change. Texture/binding refs are unchanged
    // by the toggle itself, so we just rebuild the visual state.
    useEffect(() => {
        refreshMaterials();
    }, [refreshMaterials]);

    // Animation playback — when the user picks a clip:
    //   1. Cancel any running player + render-loop hook.
    //   2. Fetch the baked ANM data via wad_load_animation.
    //   3. Build a fresh AnimationPlayer wired to the existing
    //      Babylon Skeleton's bones, hook it into the render loop.
    //   4. Cleanup on unmount or selection change is symmetric — the
    //      effect's cleanup function tears down the previous player
    //      before the new one is built, so cycling clips can't leak
    //      observer subscriptions.
    useEffect(() => {
        if (!selectedAnimation) return;
        const scene = sceneRef.current;
        const bones = bonesRef.current;
        const boneIndexByHash = boneIndexByHashRef.current;
        const joints = sklJointsRef.current;
        if (!scene || !bones || !boneIndexByHash || !joints) return;
        // Pick the right loader per source. A clip with neither a
        // chunk hash NOR a disk path is unselectable; the picker
        // marks it visually but defensively bail here too.
        const wadHash = selectedAnimation.anm_chunk_hash_hex;
        const diskPath = selectedAnimation.anm_disk_path;
        if (!wadHash && !diskPath) return;

        let cancelled = false;

        (async () => {
            try {
                const baked = source.kind === 'wad' && wadHash
                    ? await invoke<BakedAnimationDTO>('wad_load_animation', {
                          id: source.mountId,
                          pathHashHex: wadHash,
                      })
                    : await invoke<BakedAnimationDTO>('read_animation', {
                          path: diskPath!,
                      });
                if (cancelled) return;
                // Tear down the previous player BEFORE wiring the new
                // one so we don't briefly run two players against the
                // same skeleton.
                animUnsubscribeRef.current?.();
                animUnsubscribeRef.current = null;
                animPlayerRef.current = null;

                const player = new AnimationPlayer(baked, boneIndexByHash, bones, joints);
                animPlayerRef.current = player;
                console.log(
                    `[MeshPreview] anim "${selectedAnimation.name}": ` +
                        `${baked.frame_count} frames @ ${baked.fps.toFixed(1)} fps, ` +
                        `${player.matchedTrackCount}/${baked.tracks.length} bones matched`,
                );

                // Seed the React state so the controls bar starts in
                // a consistent state (playing, 1×, at frame 0) and
                // can display the clip duration.
                player.paused = false;
                player.speed = 1;
                setPlayerPaused(false);
                setPlayerSpeed(1);
                setPlayerTime(0);
                setPlayerDuration(player.duration);

                // One-shot: if a host persisted a frame/pause (e.g. the
                // Viewer rebuilt Babylon after a tab-switch), restore the
                // exact shot instead of starting over at frame 0 playing.
                // Only on the FIRST clip load of this mount; the flag trips
                // on that first load either way, so later clip switches
                // keep the normal reset-to-start behavior.
                const isFirstLoad = !hasRestoredPlayerRef.current;
                hasRestoredPlayerRef.current = true;
                const restore = playerRestoreRef?.current;
                if (isFirstLoad && restore) {
                    const t = Math.max(0, Math.min(player.duration, restore.time));
                    player.time = t;
                    player.paused = restore.paused;
                    setPlayerPaused(restore.paused);
                    setPlayerTime(t);
                }

                // Drive the player from Babylon's beforeRender — fires
                // once per render frame regardless of monitor refresh,
                // and `getEngine().getDeltaTime()` returns ms. Also
                // emits player state each tick for the host's seek bar.
                const engine = scene.getEngine();
                const observer = scene.onBeforeRenderObservable.add(() => {
                    const dt = engine.getDeltaTime() / 1000;
                    player.tick(dt);
                    if (onPlayerProgress) {
                        onPlayerProgress({
                            time: player.time,
                            duration: player.duration,
                            paused: player.paused,
                        });
                    }
                });
                animUnsubscribeRef.current = () => {
                    if (observer) scene.onBeforeRenderObservable.remove(observer);
                };
                // Hand the host a seek callable bound to this player.
                if (seekRef) {
                    seekRef.current = (t: number) => {
                        player.time = Math.max(0, Math.min(player.duration, t));
                    };
                }
            } catch (e) {
                console.warn('[MeshPreview] animation load failed:', e);
            }
        })();

        return () => {
            cancelled = true;
            animUnsubscribeRef.current?.();
            animUnsubscribeRef.current = null;
            animPlayerRef.current = null;
            if (seekRef) seekRef.current = null;
        };
        // Depend on `sourceKey` (a stable string), not `source` (a
        // fresh object every parent render). Without this, the player
        // gets torn down + rebuilt whenever the parent re-renders for
        // unrelated reasons, freezing animations mid-play.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedAnimation, sourceKey]);

    // When the user explicitly unloads (selectedAnimation → null),
    // the load effect's cleanup tears down the player but doesn't
    // touch the bones — they keep whatever last-frame pose was
    // applied. Snap them back to bind-pose so the model returns to
    // its T-pose visually, and clear the controls' duration so the
    // bar collapses cleanly.
    useEffect(() => {
        if (selectedAnimation) return;
        const bones = bonesRef.current;
        const joints = sklJointsRef.current;
        if (bones && joints) {
            resetSkeletonToRestPose(bones, joints);
        }
        setPlayerTime(0);
        setPlayerDuration(0);
        setPlayerPaused(false);
        setPlayerSpeed(1);
    }, [selectedAnimation]);

    // Mirror the React-controlled fields back into the player. We
    // can't just pass them as constructor args because they change
    // *after* construction (user clicks pause, changes speed).
    useEffect(() => {
        const p = animPlayerRef.current;
        if (p) p.paused = playerPaused;
    }, [playerPaused]);

    useEffect(() => {
        const p = animPlayerRef.current;
        if (p) p.speed = playerSpeed;
    }, [playerSpeed]);

    // Pull the player's live `time` into React at rAF cadence so the
    // progress bar tracks playback. While the user is dragging the
    // scrub thumb we skip the sync — the slider's controlled value
    // is whatever the user set, and we don't want a stale rAF tick
    // to yank the thumb back mid-drag.
    useEffect(() => {
        if (playerDuration <= 0) return;
        let raf = 0;
        const update = () => {
            const p = animPlayerRef.current;
            if (p && !scrubbing) {
                setPlayerTime(p.time);
            }
            raf = requestAnimationFrame(update);
        };
        raf = requestAnimationFrame(update);
        return () => cancelAnimationFrame(raf);
    }, [playerDuration, scrubbing]);

    // Skeleton visibility + style + X-ray — only the active style's
    // mesh combination is enabled, and only when the visibility
    // toggle is on. All meshes are built upfront so flipping the
    // style is just a few `setEnabled` calls, no rebuild.
    //
    // 'joints' enables both the sphere markers AND the line
    // connectors so the Maya look (sphere-at-pivot + line-between)
    // reads as one combined visual; 'lines' uses just the lines;
    // 'octahedrons' uses the stretched-bone mesh on its own.
    //
    // X-ray drives `renderingGroupId`: 1 = rendered after group 0
    // with the depth buffer cleared (always visible), 0 = drawn
    // alongside the mesh and subject to normal depth testing
    // (occluded where geometry covers it).
    useEffect(() => {
        const linesActive =
            skeletonVisible && (skeletonStyle === 'lines' || skeletonStyle === 'joints');
        const groupId = skeletonXray ? 1 : 0;
        if (skeletonLinesRef.current) {
            skeletonLinesRef.current.setEnabled(linesActive);
            skeletonLinesRef.current.renderingGroupId = groupId;
        }
        if (skeletonOctaRef.current) {
            skeletonOctaRef.current.setEnabled(skeletonVisible && skeletonStyle === 'octahedrons');
            skeletonOctaRef.current.renderingGroupId = groupId;
        }
        if (skeletonJointsRef.current) {
            skeletonJointsRef.current.setEnabled(skeletonVisible && skeletonStyle === 'joints');
            skeletonJointsRef.current.renderingGroupId = groupId;
        }
    }, [skeletonVisible, skeletonStyle, skeletonXray]);

    const toggleSubmesh = useCallback((index: number) => {
        setSubmeshes((prev) => {
            const next = prev.slice();
            const cur = next[index];
            if (!cur) return prev;
            const visible = !cur.visible;
            next[index] = { ...cur, visible };
            const mesh = meshesRef.current[index];
            if (mesh) mesh.setEnabled(visible);
            return next;
        });
    }, []);

    const setAllSubmeshes = useCallback((visible: boolean) => {
        setSubmeshes((prev) => {
            const next = prev.map((s) => ({ ...s, visible }));
            for (let i = 0; i < meshesRef.current.length; i++) {
                meshesRef.current[i]?.setEnabled(visible);
            }
            return next;
        });
    }, []);

    /// "Guess" — for SKNs where the BIN didn't resolve textures (or
    /// the user wants different ones), scan the mount for `.tex`/`.dds`
    /// chunks under `/skin{N}/` and assign them by name-matching
    /// against submesh names. The Rust side picks a "main" texture as
    /// the fallback for whatever doesn't match by name. Disk-source
    /// SKNs aren't supported yet (no mount → nothing to scan).
    const onGuessTextures = useCallback(async () => {
        if (source.kind !== 'wad') return;
        const scene = sceneRef.current;
        if (!scene) return;
        if (guessing) return;
        setGuessing(true);
        try {
            const submeshNames = meshesRef.current.map((m) => m.name);
            const sknBasename = (label || '')
                .replace(/\.skn$/i, '')
                .toLowerCase() || null;
            let bindings: TextureBinding[];
            try {
                bindings = await invoke<TextureBinding[]>('wad_guess_textures', {
                    id: source.mountId,
                    sknPathHashHex: source.pathHashHex,
                    submeshNames,
                    sknBasename,
                });
            } catch (e) {
                console.warn('[MeshPreview] guess failed:', e);
                return;
            }

            // Re-point each slot at the guessed chunk hash. `null`
            // entries reset the slot back to placeholder (material-color
            // or pattern, depending on the active toggle).
            const slots = slotsRef.current;
            for (let i = 0; i < bindings.length && i < slots.length; i++) {
                slots[i].chunkHash = bindings[i].chunk_hash_hex;
            }

            // Fetch any newly-needed textures we haven't decoded yet.
            const loaded = loadedTexturesRef.current;
            const newHashes = Array.from(
                new Set(
                    bindings
                        .map((b) => b.chunk_hash_hex)
                        .filter((h): h is string => !!h && !loaded.has(h)),
                ),
            );
            await Promise.allSettled(
                newHashes.map(async (hash) => {
                    const decoded = await loadTextureFromHash(source.mountId, hash, scene);
                    if (decoded) loaded.set(hash, decoded);
                }),
            );

            refreshMaterials();
            const matched = bindings.filter((b) => b.chunk_hash_hex).length;
            console.log(
                `[MeshPreview] guess: ${matched}/${bindings.length} submeshes matched`,
            );
        } finally {
            setGuessing(false);
        }
    }, [source, label, guessing, refreshMaterials]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        let cancelled = false;
        setLoading(true);
        setError(null);

        // One engine per preview — see lib/babylon/engine.ts for why we
        // dropped the singleton-engine pattern.
        const engine = createEngine(canvas);
        const scene = new Scene(engine);
        // Transparent clear so the parent div's CSS background (themed
        // via --editor-bg) is what the user sees behind the model. No
        // hardcoded color = automatic theme tracking.
        scene.clearColor = new Color4(0, 0, 0, 0);
        sceneRef.current = scene;

        // Orbit camera. ArcRotateCamera angle convention (Babylon LH Y-up):
        //   alpha = +π/2 sits the camera on the +Z side. League meshes
        //   are authored facing +Z, so the +Z viewpoint reads as the
        //   front (confirmed empirically — the -Z viewpoint shows the
        //   character's back). Users can orbit freely from here.
        //   beta = π/2 is dead-level horizontal so the model isn't
        //   tilted in the initial frame.
        // Radius/target are placeholders; both are updated below once
        // the mesh has loaded and we know its real bounds.
        const camera = new ArcRotateCamera(
            'cam',
            Math.PI / 2,
            Math.PI / 2,
            5,
            Vector3.Zero(),
            scene
        );
        camera.attachControl(canvas, true);
        camera.lowerRadiusLimit = 0.5;
        camera.upperRadiusLimit = 1000;
        camera.wheelDeltaPercentage = 0.05;
        camera.panningSensibility = 100;
        // Babylon defaults to clamping vertical angle at 0.01 / π-0.01;
        // we widen it so the user can orbit underneath.
        camera.lowerBetaLimit = 0.01;
        camera.upperBetaLimit = Math.PI - 0.01;

        // Single hemispheric kept around for GridMaterial — character
        // meshes themselves are unlit (League look) so they ignore
        // scene lights entirely. No directional/key light, no per-
        // frame observer needed.
        const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
        hemi.intensity = 1.0;

        // Ground grid — uses Babylon's GridMaterial which draws a
        // checkerboard of fine + major lines. Keeps the model anchored
        // visually so the user can tell when it's at origin vs floating.
        const ground = CreateGround('ground', { width: 200, height: 200, subdivisions: 1 }, scene);
        const gridMat = new GridMaterial('grid', scene);
        gridMat.gridRatio = 5;
        gridMat.majorUnitFrequency = 10;
        gridMat.minorUnitVisibility = 0.35;
        gridMat.lineColor = new Color3(0.4, 0.45, 0.55);
        gridMat.mainColor = new Color3(0.06, 0.07, 0.09);
        gridMat.opacity = 0.9;
        ground.material = gridMat;

        const startRender = () => {
            engine.runRenderLoop(() => {
                if (!isAppVisible()) return;
                if (sceneRef.current) sceneRef.current.render();
            });
        };

        const fetchAndBuild = async () => {
            try {
                const format = detectFormat(source, label);

                // SKL standalone — render only the bone hierarchy. No
                // mesh, no materials, no submesh panel; the skeleton
                // is the preview. Returns early because none of the
                // SKN/SCB/SCO path applies.
                if (format === 'skl') {
                    const skl = await loadSkeletonDto(source);
                    if (cancelled) return;
                    const built = buildAllSkeletonStyles(skl, scene, {
                        color: new Color3(0.55, 0.85, 1.0),
                        nameSuffix: 'standalone',
                    });
                    if (!built) {
                        setError('Skeleton has no joints');
                        setLoading(false);
                        return;
                    }
                    skeletonLinesRef.current = built.lines;
                    skeletonOctaRef.current = built.octa;
                    skeletonJointsRef.current = built.joints;
                    setSkeletonAvailable(true);
                    setSkeletonVisible(true);

                    // Both meshes start disabled; the visibility
                    // useEffect above flips the active style on once
                    // React commits the new state. No need to call
                    // setEnabled here.
                    frameCamera(camera, built.shiftTargets, built.bbox.min, built.bbox.max);
                    setLoading(false);
                    startRender();
                    return;
                }

                const skn = await loadMeshAsSknDto(source, label);
                if (cancelled) return;
                // Static meshes (SCB/SCO) often contain flat
                // single-sided geometry — particle quads, decals,
                // hair cards. Disabling backface culling for those
                // makes both sides visible, matching how they're
                // rendered in-engine. SKNs keep normal culling.
                doubleSidedRef.current = format !== 'skn';

                // For SKN previews, eagerly fetch the sibling SKL so
                // we can wire up skinning at mesh build time.
                // Without the SKL, we can't translate per-vertex
                // bone_indices (which reference the SKL's influences
                // table) into actual bone IDs the shader expects.
                // The wait is usually short (small file in the same
                // mount) and saves a dispose+rebuild later.
                let sklDto: SklSkeletonDTO | null = null;
                let babylonSkeleton: ReturnType<typeof buildBabylonSkeleton> | null = null;
                if (format === 'skn') {
                    sklDto = await fetchSiblingSkeletonDto(source);
                    if (cancelled) return;
                    if (sklDto) {
                        babylonSkeleton = buildBabylonSkeleton(sklDto, scene);
                        babylonSkeletonRef.current = babylonSkeleton.skeleton;
                        bonesRef.current = babylonSkeleton.bones;
                        boneIndexByHashRef.current = babylonSkeleton.boneIndexByHash;
                        sklJointsRef.current = sklDto.joints;
                    }
                }

                const built = buildSknMeshes(
                    skn,
                    scene,
                    babylonSkeleton?.skeleton,
                    sklDto?.influences,
                );
                meshesRef.current = built.meshes;
                sknRef.current = skn;
                // Seed the visibility panel — mirrors `built.meshes`
                // order so toggle indices line up 1:1 with the ref.
                setSubmeshes(
                    built.meshes.map((m, i) => ({
                        name: m.name || `submesh ${i}`,
                        visible: true,
                    })),
                );

                // One PBRMaterial per submesh, each seeded with a
                // distinct hue. The hue is the placeholder shown
                // before any texture arrives, and remains the
                // fallback in "material color" missing-texture mode
                // for submeshes the BIN doesn't resolve. Settings
                // toggles flow through `refreshMaterials` later, so
                // initial setup just needs to put materials + slots
                // in place.
                const golden = 0.618033988749895;
                const slots: SubmeshSlot[] = [];
                for (let i = 0; i < built.meshes.length; i++) {
                    const m = built.meshes[i];
                    const mat = new PBRMaterial(`skn_mat_${i}`, scene);
                    const hue = Color3.FromHSV(((i * golden) % 1) * 360, 0.5, 0.85);
                    mat.unlit = true; // initial — refreshMaterials updates per the toggle
                    applyHueMaterial(mat, hue);
                    m.material = mat;
                    slots.push({ mat, hue, chunkHash: null });
                }
                slotsRef.current = slots;
                loadedTexturesRef.current = new Map();
                refreshMaterials();

                // Texture pipeline (WAD-source only — disk meshes
                // don't have an associated mount to fetch BIN/textures
                // from). Branches on format because static meshes
                // (SCB/SCO) aren't wired through skinMeshProperties:
                //   - SKN → walks materialOverride list keyed by
                //     submesh names
                //   - SCB/SCO → walks the BIN tree for any object
                //     that references the mesh's path string and
                //     pulls a sibling texture
                if (source.kind === 'wad' && format === 'skn') {
                    void applyTextures(
                        source.mountId,
                        source.pathHashHex,
                        skn,
                        slots,
                        loadedTexturesRef.current,
                        scene,
                        () => cancelled,
                        refreshMaterials,
                    );
                } else if (source.kind === 'wad') {
                    void applyStaticMeshTexture(
                        source.mountId,
                        source.pathHashHex,
                        slots,
                        loadedTexturesRef.current,
                        scene,
                        () => cancelled,
                        refreshMaterials,
                    );
                } else if (source.kind === 'disk' && format === 'skn') {
                    // Disk SKN texture pipeline — same shape as the
                    // WAD path but each binding carries a disk path
                    // and we decode through `decode_texture_disk`.
                    void applyTexturesDisk(
                        source.path,
                        skn,
                        slots,
                        loadedTexturesRef.current,
                        scene,
                        () => cancelled,
                        refreshMaterials,
                    );
                }

                // Compute the AABB from Babylon's per-mesh bounding info,
                // not the SKN file's stored AABB. Some v4 SKNs ship a
                // junk/zero AABB and trusting it leaves the camera tiny
                // and pointed at origin while the actual verts are 100s
                // of units away. We use *local-space* min/max here
                // (.minimum / .maximum) — minimumWorld depends on the
                // mesh's world matrix being current, which it isn't
                // reliably right after applyToMesh.
                let minX = Infinity, minY = Infinity, minZ = Infinity;
                let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                for (const m of built.meshes) {
                    m.computeWorldMatrix(true);
                    m.refreshBoundingInfo();
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

                // Guard against NaN/Infinity sneaking in if a vertex
                // came back malformed. Without this, Math.max would
                // poison radius and we'd fall back to the placeholder
                // 5-unit value while the model is 100s of units across.
                const finite = (n: number) => Number.isFinite(n) ? n : 0;
                minX = finite(minX); minY = finite(minY); minZ = finite(minZ);
                maxX = finite(maxX); maxY = finite(maxY); maxZ = finite(maxZ);

                const sizeX = maxX - minX;
                const sizeY = maxY - minY;
                const sizeZ = maxZ - minZ;

                // Lift the model so feet sit on the ground grid. Some
                // skins are authored with feet below y=0; the shift
                // keeps the grid visually anchored under the model.
                const yShift = minY < 0 ? -minY : 0;
                if (yShift !== 0) {
                    for (const m of built.meshes) m.position.y = yShift;
                }

                // Camera target: visual center after y-shift.
                const target = new Vector3(
                    (minX + maxX) / 2,
                    (minY + maxY) / 2 + yShift,
                    (minZ + maxZ) / 2
                );
                // Frame the model with breathing room. We weight Y a
                // little more heavily than X/Z because our camera is
                // alpha=π/2, beta=π/2 — looking horizontally — so the
                // height of the model maps to the *vertical* extent
                // of the frame, while X/Z share the horizontal. A flat
                // max() over all three can leave way too much vertical
                // padding for tall+winged characters (Aatrox is 297
                // tall but 384 wide because of the wings).
                const radius = Math.max(sizeY * 1.4, sizeX, sizeZ) || 5;

                // setTarget on ArcRotateCamera *also* calls
                // rebuildAnglesAndRadius, which recomputes alpha/beta/
                // radius from the camera's CURRENT position. At this
                // point the camera is still at the placeholder
                // (0, 0, 5), so rebuild puts it nearly straight under
                // the new target — beta near π, model viewed from
                // below. Re-assert alpha/beta/radius AFTER setTarget
                // to override the rebuilt values.
                //
                // Angle pick: 3/4 view, Blender-default-ish. Rotate
                // ~22.5° toward the model's left side (so the user
                // looks at the model's right cheek/shoulder — the
                // standard hero-portrait angle) and lift ~22.5° above
                // horizontal so the silhouette reads with depth.
                camera.setTarget(target);
                camera.alpha = Math.PI / 2 + Math.PI / 8;
                camera.beta = Math.PI / 2 - Math.PI / 8;
                camera.radius = radius;
                camera.lowerRadiusLimit = radius * 0.1;
                camera.upperRadiusLimit = radius * 8;

                // Restore a host-persisted orbit (e.g. the Viewer rebuilt
                // Babylon after a tab-switch). Clamp the saved radius to the
                // freshly-computed limits so a stale value can't shove the
                // camera inside the model or out to infinity.
                const savedCam = cameraStateRef?.current;
                if (savedCam) {
                    camera.setTarget(Vector3.FromArray(savedCam.target));
                    camera.alpha = savedCam.alpha;
                    camera.beta = savedCam.beta;
                    camera.radius = Math.min(
                        camera.upperRadiusLimit,
                        Math.max(camera.lowerRadiusLimit, savedCam.radius),
                    );
                }
                // Mirror the live camera into the host ref so the next
                // remount can restore it. Ref write only — no React churn.
                if (cameraStateRef) {
                    const writeCam = () => {
                        const t = camera.target;
                        cameraStateRef.current = {
                            alpha: camera.alpha,
                            beta: camera.beta,
                            radius: camera.radius,
                            target: [t.x, t.y, t.z],
                        };
                    };
                    camera.onViewMatrixChangedObservable.add(writeCam);
                    writeCam();
                }


                if (cancelled) {
                    for (const m of built.meshes) m.dispose();
                    return;
                }

                // Sibling-SKL discovery (SKN-only). Fire-and-forget —
                // we don't want a missing or unparseable skeleton to
                // block the mesh from rendering. Kicked off after
                // y-shift is computed so the skeleton lines align with
                // the (possibly shifted) mesh in world space. The
                // overlay starts hidden; the user toggles it from the
                // settings panel.
                if (format === 'skn') {
                    if (sklDto) {
                        applySiblingSkeletonVisuals(
                            sklDto,
                            scene,
                            skeletonLinesRef,
                            skeletonOctaRef,
                            skeletonJointsRef,
                            setSkeletonAvailable,
                            yShift,
                        );
                    }
                    // Animation discovery — fires for both WAD and disk
                    // source kinds, picking the matching command path.
                    // Fire-and-forget; a missing animation graph is
                    // silent.
                    void loadAnimations(source, () => cancelled, setAnimations);
                }

                setLoading(false);
                startRender();
            } catch (e) {
                if (cancelled) return;
                const msg = e instanceof Error ? e.message : String(e);
                setError(msg);
                setLoading(false);
            }
        };

        // Resize handling — Babylon needs an explicit resize() call when
        // the canvas's CSS box changes. ResizeObserver fires on layout
        // changes (window resize, splitter drag, panel show/hide).
        const ro = new ResizeObserver(() => engine.resize());
        ro.observe(canvas);

        fetchAndBuild();

        return () => {
            cancelled = true;
            ro.disconnect();
            sceneRef.current = null;
            meshesRef.current = [];
            slotsRef.current = [];
            // Babylon disposes textures + child meshes together with
            // their owning scene, so we just drop the references —
            // no per-texture / per-line-mesh cleanup needed.
            loadedTexturesRef.current = new Map();
            placeholderTexRef.current = null;
            skeletonLinesRef.current = null;
            skeletonOctaRef.current = null;
            skeletonJointsRef.current = null;
            babylonSkeletonRef.current = null;
            bonesRef.current = null;
            boneIndexByHashRef.current = null;
            sklJointsRef.current = null;
            // Animation player teardown — the effect that owns the
            // observer cleans itself up on `selectedAnimation` change,
            // but a hot scene-dispose can race that. Belt and braces.
            animUnsubscribeRef.current?.();
            animUnsubscribeRef.current = null;
            animPlayerRef.current = null;
            setSubmeshes([]);
            setPanelOpen(false);
            setSkeletonAvailable(false);
            setSkeletonVisible(false);
            setSkeletonStyle('joints');
            setSkeletonXray(true);
            setAnimations(null);
            setAnimationsPanelOpen(false);
            setAnimationFilter('');
            setSelectedAnimation(null);
            engine.stopRenderLoop();
            scene.dispose();
            engine.dispose();
        };
    }, [sourceKey]);

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 360 }}>
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    outline: 'none',
                    touchAction: 'none',
                }}
                tabIndex={0}
            />
            {loading && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                        color: 'var(--text-secondary, #9DA5B4)',
                        fontSize: 12,
                    }}
                >
                    Loading mesh…
                </div>
            )}
            {error && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexDirection: 'column',
                        gap: 6,
                        padding: 12,
                        textAlign: 'center',
                        color: '#E06C75',
                        fontSize: 12,
                    }}
                >
                    <div>Mesh preview failed</div>
                    <div style={{ color: 'var(--text-secondary, #9DA5B4)', maxWidth: 360 }}>
                        {error}
                    </div>
                </div>
            )}
            {/* Animation picker — top-right. Shows up after the SKN's
                skin BIN → animation BIN walk lands; clicking opens a
                scrollable, filterable list of clip names. Hidden when
                a parent host drives selection via `controlled`. */}
            {!controlled && !loading && !error && animations && animations.clips.length > 0 && (
                <AnimationPickerPanel
                    listing={animations}
                    panelOpen={animationsPanelOpen}
                    onTogglePanel={() => setAnimationsPanelOpen((p) => !p)}
                    filter={animationFilter}
                    onFilterChange={setAnimationFilter}
                    selected={selectedAnimation}
                    onSelect={setSelectedAnimation}
                />
            )}

            {/* Playback controls — only present when an animation is
                actually loaded (selectedAnimation is set AND the
                player has reported its duration). Bottom-left so it
                mirrors the submesh panel at bottom-right and doesn't
                clash with the picker at top-right. */}
            {!controlled && !loading && !error && selectedAnimation && playerDuration > 0 && (
                <AnimationControlsBar
                    name={selectedAnimation.name}
                    paused={playerPaused}
                    onTogglePaused={() => setPlayerPaused((p) => !p)}
                    time={playerTime}
                    duration={playerDuration}
                    onScrubStart={() => setScrubbing(true)}
                    onScrub={(t) => {
                        const p = animPlayerRef.current;
                        if (p) p.time = t;
                        setPlayerTime(t);
                    }}
                    onScrubEnd={() => setScrubbing(false)}
                    speed={playerSpeed}
                    onCycleSpeed={() => {
                        // Cycle order per the user's preference:
                        // 1× → 2× → 0.1× → 0.5× → 1×. First tap from
                        // default is "play faster"; subsequent taps
                        // land on the slowdowns.
                        const order = [1, 2, 0.1, 0.5];
                        const idx = order.indexOf(playerSpeed);
                        const next = order[(idx + 1) % order.length] ?? 1;
                        setPlayerSpeed(next);
                    }}
                    onUnload={() => setSelectedAnimation(null)}
                />
            )}

            {/* Submesh + settings panel — bottom-right corner. Button
                always visible after the mesh loads; expands on click
                to a checklist of submeshes the user can toggle. The
                panel is also shown for skeleton-only previews so the
                user has somewhere to find the skeleton-visibility
                control (and any future skeleton-specific settings). */}
            {!controlled && !loading && !error && (submeshes.length > 0 || skeletonAvailable) && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 8,
                        right: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-primary, #d4d4d4)',
                    }}
                >
                    {panelOpen && (
                        <div
                            style={{
                                background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 88%, transparent)',
                                border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                                borderRadius: 4,
                                padding: '8px 10px',
                                minWidth: 180,
                                maxHeight: 320,
                                overflowY: 'auto',
                                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
                            }}
                        >
                            <SettingsSection
                                shadingMode={shadingMode}
                                onShadingChange={setShadingMode}
                                missingStyle={missingStyle}
                                onMissingStyleChange={setMissingStyle}
                                onGuess={onGuessTextures}
                                guessAvailable={source.kind === 'wad'}
                                guessing={guessing}
                                skeletonAvailable={skeletonAvailable}
                                skeletonVisible={skeletonVisible}
                                onSkeletonToggle={setSkeletonVisible}
                                skeletonStyle={skeletonStyle}
                                onSkeletonStyleChange={setSkeletonStyle}
                                skeletonXray={skeletonXray}
                                onSkeletonXrayChange={setSkeletonXray}
                                meshControlsAvailable={submeshes.length > 0}
                            />
                            {submeshes.length > 0 && (
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        marginBottom: 6,
                                        paddingBottom: 4,
                                        borderBottom: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 50%, transparent)',
                                        fontSize: 10,
                                        color: 'var(--text-secondary, #9DA5B4)',
                                    }}
                                >
                                    <span>Submeshes ({submeshes.length})</span>
                                    <span style={{ display: 'flex', gap: 4 }}>
                                        <button
                                            type="button"
                                            onClick={() => setAllSubmeshes(true)}
                                            style={miniButtonStyle}
                                            title="Show all"
                                        >
                                            All
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setAllSubmeshes(false)}
                                            style={miniButtonStyle}
                                            title="Hide all"
                                        >
                                            None
                                        </button>
                                    </span>
                                </div>
                            )}
                            {submeshes.map((s, i) => (
                                <label
                                    key={`${i}-${s.name}`}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '3px 0',
                                        cursor: 'pointer',
                                        opacity: s.visible ? 1 : 0.55,
                                    }}
                                    title={s.name}
                                >
                                    <input
                                        type="checkbox"
                                        checked={s.visible}
                                        onChange={() => toggleSubmesh(i)}
                                        style={{ margin: 0, cursor: 'pointer' }}
                                    />
                                    <span
                                        style={{
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            maxWidth: 180,
                                        }}
                                    >
                                        {s.name}
                                    </span>
                                </label>
                            ))}
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={() => setPanelOpen((p) => !p)}
                        style={{
                            background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 88%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                            color: 'var(--text-primary, #d4d4d4)',
                            padding: '4px 10px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 11,
                        }}
                        title={panelOpen ? 'Hide settings panel' : 'Show settings panel'}
                    >
                        {submeshes.length > 0
                            ? `Submeshes (${submeshes.filter((s) => s.visible).length}/${submeshes.length})`
                            : 'Skeleton'}
                    </button>
                </div>
            )}
        </div>
    );
}

const miniButtonStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
    color: 'var(--text-secondary, #9DA5B4)',
    padding: '1px 6px',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 10,
};

// ── Settings UI ──────────────────────────────────────────────────────

// ── Animation picker ─────────────────────────────────────────────────
//
// Top-right popup. Button collapses/expands a tall, scrollable list of
// clips with a filter input on top. v1 is purely a picker — selection
// updates a local highlight; playback wiring will follow when the ANM
// loader + skinning path lands.

interface AnimationPickerPanelProps {
    listing: AnimationListing;
    panelOpen: boolean;
    onTogglePanel: () => void;
    filter: string;
    onFilterChange: (s: string) => void;
    selected: AnimationClip | null;
    onSelect: (clip: AnimationClip) => void;
}

function AnimationPickerPanel({
    listing,
    panelOpen,
    onTogglePanel,
    filter,
    onFilterChange,
    selected,
    onSelect,
}: AnimationPickerPanelProps) {
    const filtered = filter.trim()
        ? listing.clips.filter((c) =>
              c.name.toLowerCase().includes(filter.trim().toLowerCase()),
          )
        : listing.clips;

    return (
        <div
            style={{
                position: 'absolute',
                top: 8,
                right: 8,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 6,
                fontSize: 11,
                color: 'var(--text-primary, #d4d4d4)',
            }}
        >
            <button
                type="button"
                onClick={onTogglePanel}
                style={{
                    background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 88%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                    color: 'var(--text-primary, #d4d4d4)',
                    padding: '4px 10px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontSize: 11,
                }}
                title={panelOpen ? 'Hide animations list' : 'Show animations list'}
            >
                {selected
                    ? `Animation: ${selected.name}`
                    : `Animations (${listing.clips.length})`}
            </button>
            {panelOpen && (
                <div
                    style={{
                        background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 88%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                        borderRadius: 4,
                        padding: '8px 10px',
                        minWidth: 240,
                        maxWidth: 320,
                        maxHeight: 400,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
                    }}
                >
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => onFilterChange(e.target.value)}
                        placeholder="Filter…"
                        style={{
                            background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 70%, transparent)',
                            color: 'var(--text-primary, #d4d4d4)',
                            border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                            borderRadius: 3,
                            padding: '3px 6px',
                            fontSize: 11,
                            outline: 'none',
                        }}
                    />
                    <div
                        style={{
                            fontSize: 9,
                            color: 'var(--text-secondary, #9DA5B4)',
                            paddingBottom: 2,
                            borderBottom: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 50%, transparent)',
                        }}
                        title={listing.bin_path}
                    >
                        {filtered.length === listing.clips.length
                            ? `${listing.clips.length} clip${listing.clips.length === 1 ? '' : 's'}`
                            : `${filtered.length} of ${listing.clips.length}`}
                    </div>
                    <div style={{ overflowY: 'auto', maxHeight: 320 }}>
                        {filtered.length === 0 && (
                            <div
                                style={{
                                    padding: '6px 4px',
                                    fontSize: 10,
                                    color: 'var(--text-secondary, #9DA5B4)',
                                    fontStyle: 'italic',
                                }}
                            >
                                No matches.
                            </div>
                        )}
                        {filtered.map((clip) => {
                            const active = selected?.name === clip.name;
                            const missing = !clip.anm_chunk_hash_hex && !clip.anm_disk_path;
                            return (
                                <button
                                    key={clip.name}
                                    type="button"
                                    onClick={() => onSelect(clip)}
                                    title={
                                        missing
                                            ? `${clip.anm_path}\n(file not found)`
                                            : clip.anm_path
                                    }
                                    style={{
                                        display: 'block',
                                        width: '100%',
                                        textAlign: 'left',
                                        background: active
                                            ? 'color-mix(in srgb, var(--accent-color, #2196f3) 60%, transparent)'
                                            : 'transparent',
                                        border: 'none',
                                        color: missing
                                            ? 'var(--text-muted, #6b6b6b)'
                                            : active
                                                ? 'var(--text-primary, #d4d4d4)'
                                                : 'var(--text-primary, #d4d4d4)',
                                        padding: '3px 4px',
                                        borderRadius: 2,
                                        cursor: 'pointer',
                                        fontSize: 11,
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                    }}
                                >
                                    {clip.name}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Playback controls bar ──────────────────────────────────────────
//
// Sits at the bottom-left of the viewport whenever an animation is
// loaded. Stays out of the way (auto-width, low-contrast background)
// but exposes the four mediaplayer operations a user expects:
//
//   - Play / pause toggle
//   - Scrub slider with elapsed/total time readout
//   - Speed cycle (1× → 2× → 0.5× → 0.1× → 1×)
//   - Unload (✕) which clears the clip and snaps back to T-pose
//
// State lives in the parent (so the rAF→React sync loop can update
// `time` from the player); this is a presentation-only component.

interface AnimationControlsBarProps {
    name: string;
    paused: boolean;
    onTogglePaused: () => void;
    /** Current playback time in seconds. */
    time: number;
    /** Total clip duration in seconds. */
    duration: number;
    /** Fired once when the user starts dragging the scrub thumb so
     *  the parent can pause the rAF→React time sync — otherwise the
     *  thumb jumps as we overwrite `time` each frame. */
    onScrubStart: () => void;
    onScrub: (time: number) => void;
    onScrubEnd: () => void;
    speed: number;
    onCycleSpeed: () => void;
    onUnload: () => void;
}

function AnimationControlsBar({
    name,
    paused,
    onTogglePaused,
    time,
    duration,
    onScrubStart,
    onScrub,
    onScrubEnd,
    speed,
    onCycleSpeed,
    onUnload,
}: AnimationControlsBarProps) {
    return (
        <div
            style={{
                position: 'absolute',
                left: 8,
                bottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                // Match the picker / submesh panel styling: same
                // `--editor-bg` blend + `--border-color` outline so
                // the controls inherit Milk Bag (or any other theme)
                // without explicit overrides.
                background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 88%, transparent)',
                border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                borderRadius: 4,
                color: 'var(--text-primary, #d4d4d4)',
                fontSize: 11,
                width: 380,
                boxSizing: 'border-box',
            }}
        >
            <button
                type="button"
                onClick={onTogglePaused}
                title={paused ? 'Play' : 'Pause'}
                style={controlIconButtonStyle}
            >
                {paused ? '▶' : '⏸'}
            </button>

            <input
                type="range"
                min={0}
                max={duration}
                step={Math.max(duration / 1000, 0.001)}
                value={Math.min(time, duration)}
                onMouseDown={onScrubStart}
                onTouchStart={onScrubStart}
                onChange={(e) => onScrub(parseFloat(e.target.value))}
                onMouseUp={onScrubEnd}
                onTouchEnd={onScrubEnd}
                style={{
                    flex: 1,
                    // `accent-color` tints the track + thumb in
                    // theme-appropriate hue; fallback only kicks
                    // in when the theme doesn't expose
                    // `--accent-color`.
                    accentColor: 'var(--accent-color, #2196f3)',
                    cursor: 'pointer',
                }}
            />

            <span
                style={{
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-secondary, #9DA5B4)',
                    fontSize: 10,
                    minWidth: 70,
                    textAlign: 'right',
                }}
                title={name}
            >
                {formatClock(time)} / {formatClock(duration)}
            </span>

            <button
                type="button"
                onClick={onCycleSpeed}
                title="Cycle playback speed"
                style={{
                    ...controlIconButtonStyle,
                    width: 'auto',
                    minWidth: 36,
                    padding: '0 6px',
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {formatSpeed(speed)}
            </button>

            <button
                type="button"
                onClick={onUnload}
                title="Unload animation (back to T-pose)"
                style={controlIconButtonStyle}
            >
                ✕
            </button>
        </div>
    );
}

const controlIconButtonStyle: CSSProperties = {
    width: 24,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
    borderRadius: 3,
    color: 'var(--text-primary, #d4d4d4)',
    cursor: 'pointer',
    fontSize: 11,
    lineHeight: 1,
    padding: 0,
};

/** Format seconds as `M:SS`. Hours not modeled — animation clips
 *  are seconds-long and we'd rather avoid the visual width of `H:MM:SS`. */
function formatClock(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const totalSec = Math.floor(seconds);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format a speed multiplier compactly. `0.5` → `0.5×`, `1` → `1×`. */
function formatSpeed(speed: number): string {
    return Number.isInteger(speed) ? `${speed}×` : `${speed}×`;
}

interface SettingsSectionProps {
    shadingMode: ShadingMode;
    onShadingChange: (m: ShadingMode) => void;
    missingStyle: MissingStyle;
    onMissingStyleChange: (s: MissingStyle) => void;
    onGuess: () => void;
    /// `false` for disk-source previews — there's no mount to scan.
    guessAvailable: boolean;
    guessing: boolean;
    /// `true` when a skeleton has been loaded (either standalone SKL
    /// or sibling-of-SKN). When false, the skeleton toggle row is
    /// suppressed entirely.
    skeletonAvailable: boolean;
    skeletonVisible: boolean;
    onSkeletonToggle: (visible: boolean) => void;
    skeletonStyle: SkeletonStyle;
    onSkeletonStyleChange: (s: SkeletonStyle) => void;
    skeletonXray: boolean;
    onSkeletonXrayChange: (xray: boolean) => void;
    /// `false` for SKL-only previews — there's no mesh to apply
    /// shading/material settings to, so the mesh-side controls are
    /// hidden and the panel collapses to just the skeleton toggle.
    meshControlsAvailable: boolean;
}

function SettingsSection({
    shadingMode,
    onShadingChange,
    missingStyle,
    onMissingStyleChange,
    onGuess,
    guessAvailable,
    guessing,
    skeletonAvailable,
    skeletonVisible,
    onSkeletonToggle,
    skeletonStyle,
    onSkeletonStyleChange,
    skeletonXray,
    onSkeletonXrayChange,
    meshControlsAvailable,
}: SettingsSectionProps) {
    return (
        <div
            style={{
                marginBottom: 8,
                paddingBottom: 8,
                borderBottom: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 50%, transparent)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
            }}
        >
            {meshControlsAvailable && (
                <>
                    <SegmentedToggle<ShadingMode>
                        label="Shading"
                        value={shadingMode}
                        onChange={onShadingChange}
                        options={[
                            { value: 'flat', label: 'Flat' },
                            { value: 'lit', label: 'Lit' },
                        ]}
                    />
                    <SegmentedToggle<MissingStyle>
                        label="Missing"
                        value={missingStyle}
                        onChange={onMissingStyleChange}
                        options={[
                            { value: 'material-color', label: 'Color' },
                            { value: 'pattern', label: 'Pattern' },
                        ]}
                    />
                    {guessAvailable && (
                        <button
                            type="button"
                            onClick={onGuess}
                            disabled={guessing}
                            style={{
                                ...miniButtonStyle,
                                padding: '4px 8px',
                                fontSize: 11,
                                cursor: guessing ? 'wait' : 'pointer',
                                opacity: guessing ? 0.6 : 1,
                            }}
                            title="Scan the WAD for matching textures and apply them by name"
                        >
                            {guessing ? 'Guessing…' : 'Guess textures'}
                        </button>
                    )}
                </>
            )}
            {skeletonAvailable && (
                <>
                    <label
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: 'pointer',
                            fontSize: 11,
                        }}
                        title={
                            meshControlsAvailable
                                ? 'Overlay the skeleton from the sibling .skl file'
                                : 'Show the skeleton bone hierarchy'
                        }
                    >
                        <input
                            type="checkbox"
                            checked={skeletonVisible}
                            onChange={(e) => onSkeletonToggle(e.target.checked)}
                            style={{ margin: 0, cursor: 'pointer' }}
                        />
                        <span>Skeleton</span>
                    </label>
                    {skeletonVisible && (
                        <SegmentedToggle<SkeletonStyle>
                            label="Style"
                            value={skeletonStyle}
                            onChange={onSkeletonStyleChange}
                            options={[
                                { value: 'joints', label: 'Joints' },
                                { value: 'octahedrons', label: 'Bones' },
                                { value: 'lines', label: 'Lines' },
                            ]}
                        />
                    )}
                    {/* X-ray only meaningful when there's a mesh to be
                        occluded by — for standalone-SKL previews the
                        skeleton always renders unobstructed and the
                        toggle would be a no-op, so we hide it. */}
                    {skeletonVisible && meshControlsAvailable && (
                        <label
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                cursor: 'pointer',
                                fontSize: 11,
                                marginLeft: 18,
                            }}
                            title="Draw the skeleton on top of the mesh so it's never occluded"
                        >
                            <input
                                type="checkbox"
                                checked={skeletonXray}
                                onChange={(e) => onSkeletonXrayChange(e.target.checked)}
                                style={{ margin: 0, cursor: 'pointer' }}
                            />
                            <span>X-ray</span>
                        </label>
                    )}
                </>
            )}
        </div>
    );
}

interface SegmentedOption<T extends string> {
    value: T;
    label: string;
}

interface SegmentedToggleProps<T extends string> {
    label: string;
    value: T;
    onChange: (v: T) => void;
    options: SegmentedOption<T>[];
}

function SegmentedToggle<T extends string>({
    label,
    value,
    onChange,
    options,
}: SegmentedToggleProps<T>) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
                style={{
                    fontSize: 10,
                    color: 'var(--text-secondary, #9DA5B4)',
                    minWidth: 50,
                }}
            >
                {label}
            </span>
            <div
                style={{
                    display: 'flex',
                    border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    flex: 1,
                }}
            >
                {options.map((opt) => {
                    const active = value === opt.value;
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => onChange(opt.value)}
                            style={{
                                flex: 1,
                                padding: '2px 6px',
                                background: active
                                    ? 'color-mix(in srgb, var(--accent-color, #2196f3) 60%, transparent)'
                                    : 'transparent',
                                border: 'none',
                                color: active
                                    ? 'var(--text-primary, #d4d4d4)'
                                    : 'var(--text-secondary, #9DA5B4)',
                                fontSize: 10,
                                cursor: 'pointer',
                            }}
                        >
                            {opt.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ── Format detection + DTO conversion ───────────────────────────────
//
// SKN, SCB, and SCO all describe geometry the renderer treats the
// same way (a list of triangles with positions + UVs grouped into
// one or more submeshes). To keep the rendering / texture pipeline
// uniform, the static formats parse server-side into a `StaticMesh`
// DTO and the frontend repackages them as a synthetic single-submesh
// `SknDTO` here. Means `meshBuilder`, `applyTextures`, the visibility
// panel, and the Guess flow all work for static meshes without any
// branching downstream.

interface StaticMeshDTO {
    major: number;
    minor: number;
    material: string;
    indices: number[];
    positions: number[];
    uvs: number[];
    bbox: [[number, number, number], [number, number, number]];
}

type MeshFormat = 'skn' | 'scb' | 'sco' | 'skl';

function detectFormat(
    source: { kind: 'disk'; path: string } | { kind: 'wad'; mountId: number; pathHashHex: string },
    label?: string,
): MeshFormat {
    const name = (source.kind === 'disk' ? source.path : label || '').toLowerCase();
    if (name.endsWith('.scb')) return 'scb';
    if (name.endsWith('.sco')) return 'sco';
    if (name.endsWith('.skl')) return 'skl';
    return 'skn'; // default — covers all "no extension visible" cases too
}

/// Build all three render styles (lines, octahedrons, joint markers)
/// from one SKL DTO and return refs to each mesh. Meshes are
/// *disabled* on return — the visibility/style `useEffect` in
/// MeshPreview is responsible for enabling exactly the right
/// combination on the next React commit. Returns `null` when the
/// skeleton has no joints (or every bone is degenerate); caller
/// decides what to do with that.
function buildAllSkeletonStyles(
    skl: SklSkeletonDTO,
    scene: Scene,
    options?: { color?: Color3; nameSuffix?: string },
): {
    lines: LinesMesh;
    octa: Mesh;
    joints: Mesh;
    shiftTargets: { position: { y: number } }[];
    bbox: { min: [number, number, number]; max: [number, number, number] };
} | null {
    const suffix = options?.nameSuffix ? `-${options.nameSuffix}` : '';
    const linesBuilt = buildSkeletonLines(skl, scene, {
        color: options?.color,
        name: `skeleton-lines${suffix}`,
    });
    const octaBuilt = buildSkeletonOctahedrons(skl, scene, {
        color: options?.color,
        name: `skeleton-octa${suffix}`,
    });
    const jointsBuilt = buildSkeletonJoints(skl, scene, {
        color: options?.color,
        name: `skeleton-joints${suffix}`,
    });
    if (!linesBuilt || !octaBuilt || !jointsBuilt) {
        // Cleanup partial build before bailing — Babylon would leak
        // any half-built mesh into the scene otherwise.
        linesBuilt?.lines.dispose();
        octaBuilt?.mesh.dispose();
        jointsBuilt?.mesh.dispose();
        return null;
    }
    linesBuilt.lines.setEnabled(false);
    octaBuilt.mesh.setEnabled(false);
    jointsBuilt.mesh.setEnabled(false);
    // All three variants cover the same joint cloud, so any bbox
    // works for camera framing. Use the lines variant — it computes
    // bounds from the raw joint positions while the octa/joints
    // versions include the ring radius / sphere radius offsets,
    // which would shift the framed center slightly.
    return {
        lines: linesBuilt.lines,
        octa: octaBuilt.mesh,
        joints: jointsBuilt.mesh,
        shiftTargets: [linesBuilt.lines, octaBuilt.mesh, jointsBuilt.mesh],
        bbox: linesBuilt.bbox,
    };
}

async function loadSkeletonDto(
    source: { kind: 'disk'; path: string } | { kind: 'wad'; mountId: number; pathHashHex: string },
): Promise<SklSkeletonDTO> {
    if (source.kind === 'disk') {
        return invoke<SklSkeletonDTO>('read_skl_skeleton', { path: source.path });
    }
    return invoke<SklSkeletonDTO>('wad_read_skl_skeleton', {
        id: source.mountId,
        pathHashHex: source.pathHashHex,
    });
}

/// Try to load the SKL that lives next to the given SKN. Failure is
/// silent — many SKNs don't ship with a sibling skeleton (e.g. ward
/// meshes, decorations) and we don't want a 404 to spam the console.
///
/// Disk source: derive the path by swapping the extension. WAD source:
/// ask the backend to do the path lookup + xxh64 hash check (it's the
/// only side with the resolved-name table for the mount).
///
/// On success, attaches the LinesMesh to `skeletonRef` (hidden) and
/// flips `skeletonAvailable` so the toggle shows up in the panel.
/// Just the fetch — looks up + loads the sibling SKL DTO without
/// touching the scene. Returns `null` for any miss (no sibling, parse
/// error, etc.) so the caller can branch on whether skinning + the
/// skeleton overlays should be set up.
async function fetchSiblingSkeletonDto(
    source: { kind: 'disk'; path: string } | { kind: 'wad'; mountId: number; pathHashHex: string },
): Promise<SklSkeletonDTO | null> {
    try {
        if (source.kind === 'wad') {
            const sklHash = await invoke<string | null>('wad_find_sibling_skl', {
                id: source.mountId,
                sknPathHashHex: source.pathHashHex,
            });
            if (!sklHash) return null;
            return await invoke<SklSkeletonDTO>('wad_read_skl_skeleton', {
                id: source.mountId,
                pathHashHex: sklHash,
            });
        }
        // Disk: swap the SKN's extension for `.skl`. Best-effort —
        // we swallow the read error from missing/unparseable files
        // (most SCB/SCO source folders won't have a sibling SKL).
        const sklPath = source.path.replace(/\.[^./\\]+$/i, '.skl');
        try {
            return await invoke<SklSkeletonDTO>('read_skl_skeleton', { path: sklPath });
        } catch {
            return null;
        }
    } catch (e) {
        console.warn('[MeshPreview] sibling skeleton fetch failed:', e);
        return null;
    }
}

/// Build the visualization meshes (lines / octa / joints) from a
/// pre-fetched SKL DTO and slot them into the per-style refs. Pulled
/// out of `fetchAndBuild` so the SKN/SCB/SCO paths can call it after
/// they've decided whether they need sibling skeleton overlays.
function applySiblingSkeletonVisuals(
    dto: SklSkeletonDTO,
    scene: Scene,
    linesRef: React.MutableRefObject<LinesMesh | null>,
    octaRef: React.MutableRefObject<Mesh | null>,
    jointsRef: React.MutableRefObject<Mesh | null>,
    setAvailable: (v: boolean) => void,
    yShift: number,
): void {
    const built = buildAllSkeletonStyles(dto, scene, {
        // Warm gold for the SKN-overlay variant — visually
        // distinguishes it from the standalone-SKL preview's cool
        // cyan in case both are open in different panels.
        color: new Color3(1.0, 0.82, 0.45),
        nameSuffix: 'sibling',
    });
    if (!built) return;
    if (yShift !== 0) {
        for (const t of built.shiftTargets) t.position.y = yShift;
    }
    // All meshes left disabled — the visibility useEffect honours
    // the user-controlled toggle (default: hidden for sibling
    // overlays so the user opts in explicitly).
    linesRef.current = built.lines;
    octaRef.current = built.octa;
    jointsRef.current = built.joints;
    setAvailable(true);
}

/// Frame the orbit camera around an AABB and lift its targets so the
/// model's lowest point sits on the ground grid. Shared between the
/// SKN/SCB/SCO path (where `targets` is `built.meshes`) and the SKL
/// standalone path (where it's `[built.lines]`). Pulled out so both
/// paths get identical camera angles, radius weighting, and y-shift
/// without diverging.
function frameCamera(
    camera: ArcRotateCamera,
    target: { position: { y: number } } | { position: { y: number } }[],
    min: [number, number, number],
    max: [number, number, number],
): void {
    const finite = (n: number) => (Number.isFinite(n) ? n : 0);
    const minX = finite(min[0]), minY = finite(min[1]), minZ = finite(min[2]);
    const maxX = finite(max[0]), maxY = finite(max[1]), maxZ = finite(max[2]);
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;

    const yShift = minY < 0 ? -minY : 0;
    if (yShift !== 0) {
        const arr = Array.isArray(target) ? target : [target];
        for (const t of arr) t.position.y = yShift;
    }

    const center = new Vector3(
        (minX + maxX) / 2,
        (minY + maxY) / 2 + yShift,
        (minZ + maxZ) / 2,
    );
    // Same Y-weighted framing as the SKN inline path — see comment
    // there for why Y gets a 1.4× multiplier vs X/Z.
    const radius = Math.max(sizeY * 1.4, sizeX, sizeZ) || 5;

    camera.setTarget(center);
    camera.alpha = Math.PI / 2 + Math.PI / 8;
    camera.beta = Math.PI / 2 - Math.PI / 8;
    camera.radius = radius;
    camera.lowerRadiusLimit = radius * 0.1;
    camera.upperRadiusLimit = radius * 8;
}

async function loadMeshAsSknDto(
    source: { kind: 'disk'; path: string } | { kind: 'wad'; mountId: number; pathHashHex: string },
    label?: string,
): Promise<SknDTO> {
    const format = detectFormat(source, label);
    if (format === 'skn') {
        return source.kind === 'disk'
            ? invoke<SknDTO>('read_skn_mesh', { path: source.path })
            : invoke<SknDTO>('wad_read_skn_mesh', {
                  id: source.mountId,
                  pathHashHex: source.pathHashHex,
              });
    }
    const cmdDisk = format === 'scb' ? 'read_scb_mesh' : 'read_sco_mesh';
    const cmdWad = format === 'scb' ? 'wad_read_scb_mesh' : 'wad_read_sco_mesh';
    const sm =
        source.kind === 'disk'
            ? await invoke<StaticMeshDTO>(cmdDisk, { path: source.path })
            : await invoke<StaticMeshDTO>(cmdWad, {
                  id: source.mountId,
                  pathHashHex: source.pathHashHex,
              });
    return staticMeshToSkn(sm);
}

/// Repackage a `StaticMesh` as a `SknDTO` with one synthetic submesh
/// named after the SCB/SCO's material. The SKN-shaped consumers
/// (mesh builder, texture pipeline, visibility panel) then need no
/// special-cases for static meshes — the single submesh just looks
/// like any other named submesh on a one-piece SKN.
function staticMeshToSkn(s: StaticMeshDTO): SknDTO {
    const vCount = (s.positions.length / 3) | 0;
    const iCount = s.indices.length;
    return {
        major: s.major,
        minor: s.minor,
        submeshes: [
            {
                name: s.material || 'static',
                start_vertex: 0,
                vertex_count: vCount,
                start_index: 0,
                index_count: iCount,
            },
        ],
        indices: s.indices,
        positions: s.positions,
        uvs: s.uvs,
        bone_indices: [],
        bone_weights: [],
        bbox: s.bbox,
    };
}

/// Wire format for `wad_decode_texture` — kept in one place so the
/// initial-load path and the post-guess top-up path stay in sync.
const TEX_HEADER_LEN = 16;
const FLAG_HAS_ALPHA = 1 << 0;

async function loadTextureFromHash(
    mountId: number,
    chunkHashHex: string,
    scene: Scene,
): Promise<{ tex: RawTexture; hasAlpha: boolean } | null> {
    return loadTextureBlob(
        () =>
            invoke<ArrayBuffer>('wad_decode_texture', {
                id: mountId,
                pathHashHex: chunkHashHex,
            }),
        chunkHashHex,
        scene,
    );
}

async function loadTextureFromDisk(
    diskPath: string,
    scene: Scene,
): Promise<{ tex: RawTexture; hasAlpha: boolean } | null> {
    return loadTextureBlob(
        () => invoke<ArrayBuffer>('decode_texture_disk', { path: diskPath }),
        diskPath,
        scene,
    );
}

/// Shared decoded-blob → Babylon RawTexture path. The `fetcher`
/// closure abstracts WAD vs disk source; everything downstream
/// (header parse, RGBA upload, address mode) is identical.
async function loadTextureBlob(
    fetcher: () => Promise<ArrayBuffer>,
    label: string,
    scene: Scene,
): Promise<{ tex: RawTexture; hasAlpha: boolean } | null> {
    try {
        const buf = await fetcher();
        if (buf.byteLength < TEX_HEADER_LEN) {
            console.warn(`[MeshPreview] short payload for ${label}: ${buf.byteLength} bytes`);
            return null;
        }
        const header = new DataView(buf, 0, TEX_HEADER_LEN);
        const width = header.getUint32(0, true);
        const height = header.getUint32(4, true);
        const flags = header.getUint32(8, true);
        const hasAlpha = (flags & FLAG_HAS_ALPHA) !== 0;
        const rgba = new Uint8Array(buf, TEX_HEADER_LEN);
        const tex = RawTexture.CreateRGBATexture(
            rgba,
            width,
            height,
            scene,
            /* generateMipMaps */ true,
            /* invertY */ true,
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        // WRAP, not CLAMP. League SKN mod authors (and most DCC tools
        // by default) leave UV islands outside the `[0, 1]` box —
        // sometimes the entire unwrap sits in `v < 0` for re-textured
        // submeshes. CLAMP would freeze every sample on those tris to
        // the texture's edge pixel, which is what produced the dark
        // banded look on champs like Ahri / Karma re-skins. WRAP tiles
        // the texture modulo 1, matching Blender / Maya / Substance
        // default sampling behaviour and what Photo Studio does.
        tex.wrapU = Texture.WRAP_ADDRESSMODE;
        tex.wrapV = Texture.WRAP_ADDRESSMODE;
        tex.hasAlpha = hasAlpha;
        return { tex, hasAlpha };
    } catch (e) {
        console.warn(`[MeshPreview] texture fetch failed for ${label}:`, e);
        return null;
    }
}

// ── Material helpers ─────────────────────────────────────────────────
//
// Pulled out of the component so the per-submesh setup, texture
// updates, and toggle re-applies all share one configuration source.
// Keeps the PBR transparency / culling / depth-pre-pass settings in a
// single place — easier to evolve without hunting for stragglers.

function applyTexturedMaterial(
    mat: PBRMaterial,
    tex: RawTexture,
    hasAlpha: boolean,
    alphaCutoff: number = 0.2,
): void {
    mat.albedoTexture = tex;
    mat.albedoColor = new Color3(1, 1, 1);
    mat.backFaceCulling = true;
    if (hasAlpha) {
        mat.useAlphaFromAlbedoTexture = true;
        mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
        mat.alphaCutOff = alphaCutoff;
        mat.needDepthPrePass = true;
    } else {
        mat.useAlphaFromAlbedoTexture = false;
        mat.transparencyMode = Material.MATERIAL_OPAQUE;
        mat.needDepthPrePass = false;
    }
    configurePbr(mat);
}

function applyHueMaterial(mat: PBRMaterial, hue: Color3): void {
    mat.albedoTexture = null;
    mat.albedoColor = hue;
    mat.useAlphaFromAlbedoTexture = false;
    mat.transparencyMode = Material.MATERIAL_OPAQUE;
    mat.needDepthPrePass = false;
    mat.backFaceCulling = true;
    configurePbr(mat);
}

/// Lit-mode PBR settings shared by every material variant. Without
/// these, PBRMaterial defaults to a metal-ish, env-lit look that
/// renders nearly black when there's no environment texture in the
/// scene (indirect specular is zero, ambient is zero, direct
/// hemispheric goes through cos-falloff).
///
/// We force a fully-matte dielectric (metallic=0, roughness=1) so
/// shading is dominated by direct hemispheric + ambient. Also enable
/// `twoSidedLighting` because League's flipped index winding pairs
/// with `ComputeNormals`'s right-hand-rule output to give some faces
/// inward-pointing normals — without two-sided lighting those faces
/// render black instead of receiving the upper-hemisphere
/// contribution.
function configurePbr(mat: PBRMaterial): void {
    mat.metallic = 0;
    mat.roughness = 1;
    mat.environmentIntensity = 0;
    mat.directIntensity = 1.2;
    mat.twoSidedLighting = true;
}

/// Build the magenta/black checkerboard used for the "missing texture"
/// look. 2×2 RGBA tiled with NEAREST filtering + WRAP addressing
/// produces classic Source-style chessboard squares once UVs span
/// more than one tile-width — close to League's missing-texture
/// fallback in mod tooling.
function buildPlaceholderTexture(scene: Scene): RawTexture {
    const data = new Uint8Array([
        0xff, 0x00, 0xff, 0xff, // magenta
        0x00, 0x00, 0x00, 0xff, // black
        0x00, 0x00, 0x00, 0xff, // black
        0xff, 0x00, 0xff, 0xff, // magenta
    ]);
    const tex = RawTexture.CreateRGBATexture(
        data,
        2,
        2,
        scene,
        /* generateMipMaps */ false,
        /* invertY */ false,
        Texture.NEAREST_SAMPLINGMODE,
    );
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    // Tile the 2-pixel pattern across the UV space so users see a
    // grid of squares instead of one big magenta blob. uScale=8
    // gives 8 black + 8 magenta cells across a 0..1 UV range.
    tex.uScale = 8;
    tex.vScale = 8;
    return tex;
}

// ─────────────────────────────────────────────────────────────────────
// Texture pipeline
//
// Flow when an SKN renders from a mounted WAD:
//   1. wad_read_skin_textures resolves the sibling skin BIN, parses
//      its ritobin text, and returns a map of submesh-name →
//      texture-path (+ that texture's chunk hash, when the texture
//      lives in this same WAD).
//   2. For each submesh, look up its material binding. Group texture
//      fetches by chunk-hash so a texture shared across N materials
//      is only downloaded + decoded once.
//   3. For each unique chunk: fetch decompressed bytes via
//      wad_read_chunk_b64, decode (DDS or TEX) into a PNG data URL,
//      build a Babylon Texture and assign it to every submesh
//      material that maps to that chunk.
//
// Each submesh that has no override falls back to the BIN's BASE
// texture (also pre-resolved server-side).
// ─────────────────────────────────────────────────────────────────────

export interface AnimationClip {
    name: string;
    anm_path: string;
    anm_chunk_hash_hex: string | null;
    /** Set when the SKN was loaded from disk and the ANM file exists
     *  on disk under the same root. Either this OR `anm_chunk_hash_hex`
     *  is populated, never both. */
    anm_disk_path?: string | null;
}
export interface AnimationListing {
    bin_path: string;
    bin_path_hash_hex: string;
    clips: AnimationClip[];
}

/// Fire the appropriate animations command (WAD or disk variant) and
/// pipe the result into the component state. Failure is non-fatal —
/// "no animations available" is a valid state we just surface
/// silently.
async function loadAnimations(
    source: { kind: 'disk'; path: string } | { kind: 'wad'; mountId: number; pathHashHex: string },
    isCancelled: () => boolean,
    setAnimations: (a: AnimationListing | null) => void,
): Promise<void> {
    try {
        const listing = source.kind === 'wad'
            ? await invoke<AnimationListing | null>('wad_read_skn_animations', {
                  id: source.mountId,
                  pathHashHex: source.pathHashHex,
              })
            : await invoke<AnimationListing | null>('read_skn_animations_disk_cmd', {
                  sknPath: source.path,
              });
        if (isCancelled()) return;
        setAnimations(listing);
    } catch (e) {
        console.warn('[MeshPreview] animations lookup failed:', e);
    }
}

interface TextureBinding {
    material: string;
    texture_path: string;
    chunk_hash_hex: string | null;
    /** Disk path; populated by the disk-source variants. */
    texture_disk_path?: string | null;
}
interface SknTextureBindings {
    bin_path: string;
    bin_path_hash_hex: string;
    default_texture: string | null;
    default_chunk_hash_hex: string | null;
    default_texture_disk_path?: string | null;
    bindings: TextureBinding[];
    /** Alt diffuse (shadow / demon / transformed form). Populated when
     *  the resolved material has a ShadowTexture sampler. Frontend
     *  swaps with `default_chunk_hash_hex` when the user toggles the
     *  shadow-form option. */
    shadow_texture?: string | null;
    shadow_chunk_hash_hex?: string | null;
}

/// SCB/SCO texture pipeline. Mirrors `applyTextures` for the SKN
/// case but uses the new `wad_find_static_mesh_texture` command,
/// which walks the BIN tree for any object that references the
/// mesh's path string and returns a single best-guess diffuse
/// texture binding.
async function applyStaticMeshTexture(
    mountId: number,
    mesh_path_hash_hex: string,
    slots: SubmeshSlot[],
    loadedTextures: Map<string, { tex: RawTexture; hasAlpha: boolean }>,
    scene: Scene,
    isCancelled: () => boolean,
    refresh: () => void,
): Promise<void> {
    const tStart = performance.now();
    let binding: TextureBinding | null;
    try {
        binding = await invoke<TextureBinding | null>('wad_find_static_mesh_texture', {
            id: mountId,
            meshPathHashHex: mesh_path_hash_hex,
        });
    } catch (e) {
        console.warn('[MeshPreview] static-mesh texture lookup failed:', e);
        return;
    }
    if (isCancelled()) return;
    if (!binding) {
        console.log('[MeshPreview] static mesh: no BIN texture reference found');
        return;
    }
    const tBin = performance.now();
    console.log(
        `[MeshPreview] static mesh BIN: ${binding.material}` +
            ` | texture=${binding.texture_path}` +
            ` | hash=${binding.chunk_hash_hex ?? '(unresolved)'}`,
    );

    if (!binding.chunk_hash_hex) {
        return;
    }

    const decoded = await loadTextureFromHash(mountId, binding.chunk_hash_hex, scene);
    if (isCancelled() || !decoded) return;
    loadedTextures.set(binding.chunk_hash_hex, decoded);

    // Static meshes are single-submesh in our DTO, so all slots get
    // the same texture. (In practice there's one slot, but iterating
    // is harmless and future-proofs against multi-submesh static
    // meshes if they ever come up.)
    for (const slot of slots) {
        slot.chunkHash = binding.chunk_hash_hex;
    }
    refresh();

    const tEnd = performance.now();
    console.log(
        `[MeshPreview] static mesh ready: bin=${(tBin - tStart).toFixed(0)}ms, ` +
            `decode+upload=${(tEnd - tBin).toFixed(0)}ms`,
    );
}

async function applyTextures(
    mountId: number,
    skn_path_hash_hex: string,
    skn: SknDTO,
    slots: SubmeshSlot[],
    loadedTextures: Map<string, { tex: RawTexture; hasAlpha: boolean }>,
    scene: Scene,
    isCancelled: () => boolean,
    refresh: () => void,
): Promise<void> {
    const tStart = performance.now();

    let map: SknTextureBindings | null;
    try {
        map = await invoke<SknTextureBindings | null>('wad_read_skin_textures', {
            id: mountId,
            pathHashHex: skn_path_hash_hex,
        });
    } catch (e) {
        console.warn('[MeshPreview] texture map fetch failed:', e);
        return;
    }
    if (isCancelled() || !map) return;
    const tBin = performance.now();

    console.log(
        `[MeshPreview] BIN: ${map.bin_path} | default: ${map.default_texture ?? '(none)'} | bindings: ${map.bindings.length}`
    );

    const bindingByName = new Map<string, TextureBinding>();
    for (const b of map.bindings) {
        bindingByName.set(b.material.toLowerCase(), b);
    }

    const indicesByHash = new Map<string, number[]>();
    for (let i = 0; i < skn.submeshes.length; i++) {
        const name = skn.submeshes[i].name.toLowerCase();
        const b = bindingByName.get(name);
        const hash = b?.chunk_hash_hex ?? map.default_chunk_hash_hex;
        if (!hash) continue;
        const slot = slots[i];
        if (slot) slot.chunkHash = hash;
        const list = indicesByHash.get(hash) ?? [];
        list.push(i);
        indicesByHash.set(hash, list);
    }

    if (indicesByHash.size === 0) {
        console.warn('[MeshPreview] no resolvable textures for any submesh');
        return;
    }

    // One IPC call per texture; Rust returns RGBA bytes directly via
    // tauri::ipc::Response, no JSON / base64 round-trip. See
    // `loadTextureFromHash` for the wire format.
    const totalsRef = { decode: 0, upload: 0 };
    let appliedCount = 0;
    const work = Array.from(indicesByHash.entries()).map(async ([hash, indices]) => {
        const d0 = performance.now();
        const decoded = await loadTextureFromHash(mountId, hash, scene);
        if (isCancelled()) return;
        totalsRef.decode = Math.max(totalsRef.decode, performance.now() - d0);
        if (!decoded) return;

        // Cache and refresh — refresh re-runs the active settings
        // (flat/lit, missing-style) over every slot so we don't have
        // to duplicate the application logic here.
        const u0 = performance.now();
        loadedTextures.set(hash, decoded);
        refresh();
        totalsRef.upload += performance.now() - u0;
        appliedCount += indices.length;
    });

    await Promise.allSettled(work);

    const tEnd = performance.now();
    console.log(
        `[MeshPreview] ${appliedCount}/${indicesByHash.size} texture(s) applied: ` +
            `bin=${(tBin - tStart).toFixed(0)}ms, ` +
            `decode(slowest)=${totalsRef.decode.toFixed(0)}ms, ` +
            `upload(total)=${totalsRef.upload.toFixed(0)}ms, ` +
            `total=${(tEnd - tStart).toFixed(0)}ms`,
    );
}

/// Disk-source counterpart of `applyTextures`. Same per-submesh
/// matching cascade; the only difference is each binding carries a
/// disk path (instead of a chunk hash) and we decode through
/// `decode_texture_disk`. Uses the disk path string as the cache
/// key — disk paths are unique within a process so collisions with
/// any WAD chunk-hash entries already in the cache aren't possible.
async function applyTexturesDisk(
    sknDiskPath: string,
    skn: SknDTO,
    slots: SubmeshSlot[],
    loadedTextures: Map<string, { tex: RawTexture; hasAlpha: boolean }>,
    scene: Scene,
    isCancelled: () => boolean,
    refresh: () => void,
): Promise<void> {
    const tStart = performance.now();

    let map: SknTextureBindings | null;
    try {
        map = await invoke<SknTextureBindings | null>('read_skn_textures_disk', {
            sknPath: sknDiskPath,
            submeshNames: skn.submeshes.map(s => s.name),
        });
    } catch (e) {
        console.warn('[MeshPreview] disk texture map fetch failed:', e);
        return;
    }
    if (isCancelled() || !map) return;
    const tBin = performance.now();
    console.log(
        `[MeshPreview] disk BIN: ${map.bin_path} | default: ${map.default_texture ?? '(none)'} | bindings: ${map.bindings.length}`,
    );

    const bindingByName = new Map<string, TextureBinding>();
    for (const b of map.bindings) {
        bindingByName.set(b.material.toLowerCase(), b);
    }

    const indicesByPath = new Map<string, number[]>();
    for (let i = 0; i < skn.submeshes.length; i++) {
        const name = skn.submeshes[i].name.toLowerCase();
        const b = bindingByName.get(name);
        const path = b?.texture_disk_path ?? map.default_texture_disk_path;
        if (!path) continue;
        const slot = slots[i];
        // Reuse `chunkHash` field as a generic texture key —
        // semantically it's the cache lookup id, here populated with
        // a disk path. Avoids forking the SubmeshSlot shape.
        if (slot) slot.chunkHash = path;
        const list = indicesByPath.get(path) ?? [];
        list.push(i);
        indicesByPath.set(path, list);
    }

    if (indicesByPath.size === 0) {
        console.warn('[MeshPreview] no resolvable disk textures for any submesh');
        return;
    }

    let appliedCount = 0;
    const work = Array.from(indicesByPath.entries()).map(async ([path, indices]) => {
        const decoded = await loadTextureFromDisk(path, scene);
        if (isCancelled() || !decoded) return;
        loadedTextures.set(path, decoded);
        refresh();
        appliedCount += indices.length;
    });

    await Promise.allSettled(work);

    const tEnd = performance.now();
    console.log(
        `[MeshPreview] disk ${appliedCount}/${indicesByPath.size} texture(s) applied: ` +
            `bin=${(tBin - tStart).toFixed(0)}ms, total=${(tEnd - tStart).toFixed(0)}ms`,
    );
}

