/**
 * Reusable Babylon scene host for the Photo Studio.
 *
 * The scene tracks a LIST of `StudioObject`s — League SKNs, glTF/GLB
 * models, and primitive cubes / planes / spheres. Panels operate on
 * whichever object is "active":
 *
 *   - Pose panel — plays animations against the active SKN object.
 *   - Mesh panel — shows submesh visibility + texture overrides for
 *     the active object (any kind).
 *   - Objects panel — lists every object, lets the user pick the
 *     active one, transform it, or delete it.
 *
 * Backwards-compat: the deprecated `loadModelFromDisk` helper still
 * exists as a "clear + add" alias for the early single-model flow.
 */

import '@babylonjs/core';
import '@babylonjs/materials';

import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial';
import { ShadowOnlyMaterial } from '@babylonjs/materials/shadowOnly/shadowOnlyMaterial';
import { Tools } from '@babylonjs/core/Misc/tools';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager';
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer';
import { Layer } from '@babylonjs/core/Layers/layer';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';

import { createEngine } from './engine';
import {
    createSknObject,
    createGltfObject,
    createFbxObject,
    createPrimitiveObject,
    setMeshFaceFlipped,
    type StudioObject,
    type PrimitiveKind,
    type StudioSlotOverride,
} from './studioObject';
import { loadDiskAnimation, type StudioAnimListing, type StudioAnimClip } from './studioLoad';
import { AnimationPlayer, type BakedAnimationDTO } from './animationPlayer';

/** How an image background fits the viewport.
 *  - `cover`   — fill the frame, cropping overflow (aspect kept)
 *  - `contain` — whole image visible, letterboxed (aspect kept)
 *  - `stretch` — distort to fill exactly (aspect ignored) */
export type BackgroundFit = 'cover' | 'contain' | 'stretch';

export interface BackgroundImageConfig {
    path: string;
    fit: BackgroundFit;
    /** -1..1 pan. 0 = centered. Positive X = move right, positive Y
     *  = move up. Scaled by the layer's own size so the feel is
     *  consistent regardless of fit mode. */
    offsetX: number;
    offsetY: number;
    /** User zoom multiplier on top of the fit scaling. 1 = fit. */
    zoom: number;
}

export type StudioBackground =
    | { kind: 'transparent' }
    | { kind: 'solid'; color: string }
    | { kind: 'image'; config: BackgroundImageConfig };

export type GizmoMode = 'none' | 'move' | 'rotate' | 'scale';

// ── Scene serialization ─────────────────────────────────────────────
// `.studio.json` shape. Versioned so future format changes can be
// migrated rather than silently mis-parsed.

export interface StudioSlotData {
    visible: boolean;
    flipped: boolean;
    override: StudioSlotOverride;
}

export interface StudioObjectData {
    kind: StudioObject['kind'];
    name: string;
    /** Disk path for skn / gltf / fbx; omitted for primitives. */
    sourcePath?: string;
    /** Whole-object visibility (the Objects-panel eye toggle). */
    rootVisible: boolean;
    transform: {
        position: [number, number, number];
        rotation: [number, number, number];
        scaling: [number, number, number];
    };
    slots: StudioSlotData[];
}

export interface StudioSceneData {
    version: 1;
    objects: StudioObjectData[];
    background: StudioBackground;
    gridVisible: boolean;
    camera: {
        alpha: number;
        beta: number;
        radius: number;
        target: [number, number, number];
    };
}

export interface StudioScene {
    engine: Engine;
    scene: Scene;
    camera: ArcRotateCamera;
    setBackground: (bg: StudioBackground) => void;
    /** Tweak the active image background's fit / zoom / offset
     *  without reloading the texture. No-op when the background
     *  isn't an image. */
    setBackgroundTransform: (patch: Partial<Omit<BackgroundImageConfig, 'path'>>) => void;
    setGridVisible: (visible: boolean) => void;
    /** Toggle the ground shadow. Light is diffuse=black so the model
     *  itself isn't lit — only the shadow plane reads the depth map.
     *  Off by default; the Lighting panel drives this. */
    setShadowEnabled: (enabled: boolean) => void;
    /** Swap the shadow map size. Disposes and rebuilds the generator
     *  (Babylon doesn't let you resize a generator's map in place),
     *  preserving the current caster list + darkness setting. */
    setShadowQuality: (quality: 'low' | 'medium' | 'high' | 'ultra') => void;
    /** Tune the shadow's darkness (0 = pitch black, 1 = invisible). */
    setShadowDarkness: (value: number) => void;
    /** Slide the shadow's projection along the ground. `x` / `z` are
     *  world-space distances (positive Z = away from the camera at
     *  the default angle). The shadow light's azimuth derives from
     *  this so the shadow visually shifts in the requested direction. */
    setShadowDirection: (x: number, z: number) => void;
    /** Stretch the shadow. `1` = directly overhead (compact), values
     *  near 0 = grazing angle (long stretched shadow). */
    setShadowLength: (value: number) => void;
    /** Direction-only intensity dial for the shading mode (lit). */
    setShadingIntensity: (value: number) => void;
    /** Rotate the hemispheric light's "sky" direction so users can
     *  pick where the soft light comes from. `azimuth` in radians. */
    setShadingDirection: (azimuth: number, elevation: number) => void;
    /** Toggle bloom-glow rendering on the scene. Reads `emissiveColor`
     *  / `emissiveTexture` from all materials; pixels with non-zero
     *  emissive contribution bleed into the bloom post-process. */
    setGlowEnabled: (enabled: boolean) => void;
    /** Adjust the bloom intensity multiplier. 0 = no bloom, 1 ~= default. */
    setGlowIntensity: (value: number) => void;
    screenshot: (opts: ScreenshotOpts) => Promise<string>;
    /** Add a model from disk. Auto-detects SKN vs glTF / GLB by file
     *  extension. The new object becomes the active object. Camera
     *  re-frames to fit the scene's combined AABB. */
    addModelFromDisk: (path: string) => Promise<StudioObject>;
    /** Re-fetch the animation listing for the active SKN object — used
     *  by the Pose panel's "Fetch animations from game" button after
     *  it drops vanilla ANMs into a borrowed-anim folder. Skips silently
     *  when the active object isn't an SKN. `extraDir` is merged into
     *  the listing (the borrowed-anim folder, when present). */
    reloadActiveObjectAnimations: (extraDir?: string | null) => Promise<void>;
    /** Backwards-compat: replace the current scene contents with one
     *  SKN. Equivalent to clearObjects() + addModelFromDisk(path). */
    loadModelFromDisk: (path: string) => Promise<StudioObject>;
    /** Insert a primitive at the origin. */
    addPrimitive: (kind: PrimitiveKind) => StudioObject;
    /** Re-frame the orbit camera on the active object (or the whole
     *  scene when nothing is selected) — recenters the target, resets
     *  the orbit angle, and rescales zoom / pan / keyboard speed to
     *  that object's size. The "lost the model / controls feel janky"
     *  escape hatch (Maya's F, Blender's numpad-dot). */
    frameCamera: () => void;
    /** Drop an object and any resources it owns. */
    removeObject: (id: string) => void;
    clearObjects: () => void;
    /** Object list + active-id query for panel rendering. */
    getObjects: () => StudioObject[];
    getActiveObject: () => StudioObject | null;
    setActiveObject: (id: string | null) => void;
    /** Animation hooks — operate on the active SKN object. No-ops
     *  when the active object isn't a SKN. */
    playClip: (clip: StudioAnimClip) => Promise<AnimationPlayer | null>;
    stopClip: () => void;
    getPlayer: () => AnimationPlayer | null;
    /** Subscribe to scene changes (object added / removed / active
     *  changed / player started / stopped / gizmo mode changed). */
    onChange: (cb: () => void) => () => void;
    /** Transform gizmo state. `'none'` hides the gizmo entirely;
     *  the other modes show one of Babylon's built-in widgets
     *  (translate arrows / rotate rings / scale boxes) attached to
     *  the active object's root TransformNode. */
    getGizmoMode: () => GizmoMode;
    setGizmoMode: (mode: GizmoMode) => void;
    /** Capture the full scene (objects + transforms + texture
     *  overrides + background + grid + camera) as a plain JSON-safe
     *  object. Drives both `.studio.json` save and undo snapshots. */
    serialize: () => StudioSceneData;
    /** Rebuild the scene from serialized data — clears everything,
     *  re-loads each object from disk, and restores transforms /
     *  overrides / background / camera. Async because models are
     *  re-read from disk. */
    loadFromData: (data: StudioSceneData) => Promise<void>;
    /** Record an undo step. Panels call this AFTER a mutation the
     *  scene itself doesn't already hook (transform inputs, mesh
     *  visibility / flip, texture overrides). Also the dirty signal. */
    commitUndoStep: () => void;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
    canUndo: () => boolean;
    canRedo: () => boolean;
    /** Clear undo/redo history and re-baseline (call after opening a
     *  scene file so undo can't reach back past the load). */
    resetUndoHistory: () => void;
    /** True when there are changes since the last `markSaved()`. */
    isDirty: () => boolean;
    /** Stamp the current state as saved (call after writing to disk). */
    markSaved: () => void;
    dispose: () => void;
}

export interface ScreenshotOpts {
    width: number;
    height: number;
    hideGrid?: boolean;
    transparent?: boolean;
    mimeType?: 'image/png' | 'image/jpeg';
}

export function createStudioScene(canvas: HTMLCanvasElement): StudioScene {
    const engine = createEngine(canvas);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 0);

    const camera = new ArcRotateCamera(
        'studio-cam',
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

    const hemi = new HemisphericLight('studio-hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 1.0;
    // Soft fill on the underside hemisphere so faces pointing away
    // from the sky don't render pitch black when shading is on.
    // Has no effect when `mat.unlit = true` (shading off default).
    hemi.groundColor = new Color3(0.35, 0.35, 0.4);

    const ground = CreateGround(
        'studio-ground',
        { width: 200, height: 200, subdivisions: 1 },
        scene,
    ) as Mesh;
    const gridMat = new GridMaterial('studio-grid', scene);
    gridMat.gridRatio = 5;
    gridMat.majorUnitFrequency = 10;
    gridMat.minorUnitVisibility = 0.35;
    gridMat.lineColor = new Color3(0.4, 0.45, 0.55);
    gridMat.mainColor = new Color3(0.06, 0.07, 0.09);
    gridMat.opacity = 0.9;
    ground.material = gridMat;

    // ── Shadow setup ───────────────────────────────────────────────
    // DirectionalLight whose diffuse/specular are pinned to near-zero
    // — it exists purely to project shadows, not to illuminate the
    // model. Combined with a `ShadowOnlyMaterial` plane underneath,
    // we get a ground shadow that doesn't add ANY light contribution
    // to the model. Off by default; the Lighting panel flips it on.
    const shadowLight = new DirectionalLight(
        'studio-shadow-light',
        new Vector3(-0.2, -1, -0.2).normalize(),
        scene,
    );
    // Light positioned high enough that even tall meshes sit comfortably
    // below it. Combined with `autoCalcShadowZBounds = true` the
    // near/far auto-fit, so the only thing we have to manually size is
    // the orthographic X/Y extents.
    shadowLight.position = new Vector3(0, 500, 0);
    // Pure black diffuse caused some Babylon builds to short-circuit
    // the depth pass entirely; tiny epsilon avoids that without any
    // perceptible illumination contribution to the model.
    shadowLight.diffuse = new Color3(0.001, 0.001, 0.001);
    shadowLight.specular = new Color3(0, 0, 0);
    shadowLight.intensity = 1;
    // Shadow frustum: explicit wide orthographic projection. League
    // SKNs are imported at the WAD's native scale — a typical
    // champion spans ~50-150 world units, sometimes more for mounted
    // skins or bosses. With ±25 (the earlier value), the projection
    // only covered the immediate origin area, so animated limbs that
    // moved further out got UV-clipped at the shadow map boundary and
    // their shadows turned into fragmented dart shapes (Aatrox's feet,
    // visible in the user's screenshot). ±300 gives a 600×600 area
    // that comfortably wraps any League character at any animation
    // pose. Resolution per world unit at High preset (2048) is ~3.4
    // px/unit — coarse on small meshes but fine for ground shadows
    // of a large character; Ultra preset doubles it. `autoCalcShadow
    // ZBounds` still handles the near/far automatically.
    shadowLight.autoUpdateExtends = false;
    shadowLight.autoCalcShadowZBounds = true;
    shadowLight.orthoLeft = -300;
    shadowLight.orthoRight = 300;
    shadowLight.orthoTop = 300;
    shadowLight.orthoBottom = -300;

    // Receiver plane sized hilariously large (42000×42000) so the
    // shadow never gets clipped at the plane's edge, no matter how
    // grazing the shadow angle or how far off-origin the model
    // sits. Costs nothing because the plane is `ShadowOnlyMaterial`-
    // transparent — only the shadowed pixels actually rasterize.
    // Lift slightly so it draws on top of the grid without z-fight.
    const shadowReceiver = CreateGround(
        'studio-shadow-receiver',
        { width: 42000, height: 42000, subdivisions: 1 },
        scene,
    ) as Mesh;
    shadowReceiver.position.y = 0.001;
    const shadowOnlyMat = new ShadowOnlyMaterial('studio-shadow-only', scene);
    // `activeLight` is REQUIRED — without it, the material picks the
    // first light in the scene (= our HemisphericLight, which casts
    // no shadows) and renders nothing.
    shadowOnlyMat.activeLight = shadowLight;
    shadowReceiver.material = shadowOnlyMat;
    shadowReceiver.receiveShadows = true;
    shadowReceiver.isPickable = false;
    shadowReceiver.setEnabled(false); // toggled on by the Lighting panel

    // ── Shadow generator with swappable quality ────────────────────
    // Map size can't be resized live in Babylon, so the quality
    // setter disposes the current generator and rebuilds it. We keep
    // currently-tuned values in closure state so the rebuild
    // preserves user settings.
    type ShadowQuality = 'low' | 'medium' | 'high' | 'ultra';
    const QUALITY_TO_MAP: Record<ShadowQuality, number> = {
        low: 512,
        medium: 1024,
        high: 2048,
        ultra: 4096,
    };
    let currentDarkness = 0.35;
    let shadowGen: ShadowGenerator | null = null;
    let currentQuality: ShadowQuality = 'high';
    const buildShadowGen = (quality: ShadowQuality) => {
        const previousCasters = shadowGen?.getShadowMap()?.renderList?.slice() ?? [];
        shadowGen?.dispose();
        const gen = new ShadowGenerator(QUALITY_TO_MAP[quality], shadowLight);
        // Contact-hardening shadow auto-blurs based on distance from
        // the caster — sharp where the model meets the ground, soft
        // further out. Much nicer than fixed PCF on smaller meshes.
        gen.useContactHardeningShadow = true;
        gen.contactHardeningLightSizeUVRatio = 0.075;
        // `usePercentageCloserFiltering` is the fallback if contact
        // hardening isn't supported (WebGL1 / lacking extensions).
        gen.filteringQuality = ShadowGenerator.QUALITY_HIGH;
        // Bias is in normalized depth units; very small values (1e-5)
        // are the right scale for orthographic projections at our 40-
        // unit light height. Higher → less shadow acne but more peter-
        // pan; this is conservative.
        gen.bias = 0.00002;
        gen.normalBias = 0.02;
        gen.darkness = currentDarkness;
        // Re-register every caster the previous generator had.
        for (const m of previousCasters) {
            gen.addShadowCaster(m, true);
        }
        // League SKNs commonly carry flipped submeshes (cape linings,
        // double-sided cloth). Without this flag, the depth pass culls
        // their front faces → patches of the model show no shadow on
        // the ground. forceBackFacesOnly=false uses the default cull
        // mode; we let the depth shader render BOTH sides via the
        // mesh's material.backFaceCulling check — set per caster on
        // register, below.
        gen.forceBackFacesOnly = false;
        // League SKNs often have flipped-winding submeshes (cape
        // linings, double-sided cloth panels). The depth shader honors
        // the mesh's backface culling, so flipped subs render to the
        // depth map as "back faces" and get culled → missing shadow
        // patches on the ground. `transparencyShadow=true` switches the
        // depth shader to a mode that doesn't cull, fixing the issue
        // for those subs without touching their visual rendering.
        gen.transparencyShadow = true;
        return gen;
    };
    shadowGen = buildShadowGen(currentQuality);

    let shadowEnabled = false;

    /** Walks an object's meshes and registers them as shadow casters.
     *  Idempotent — `addShadowCaster` ignores meshes already in the
     *  list, so re-registering on toggle is cheap.
     *
     *  Also pins `alwaysSelectAsActiveMesh = true` on every caster
     *  mesh. League SKNs are skinned, and their bounding boxes stay
     *  at the BIND pose. When animation moves a limb away from the
     *  rest pose, Babylon's frustum culler still sees the bind-pose
     *  bbox and decides the mesh isn't in the shadow projection any
     *  more → that limb skips the depth render and its shadow
     *  vanishes (the "fragmented dart-shape" symptom). The flag
     *  bypasses culling entirely so animated geometry always casts. */
    const registerObjectAsCaster = (obj: StudioObject) => {
        if (!shadowGen) return;
        for (const m of obj.meshes) {
            m.alwaysSelectAsActiveMesh = true;
            shadowGen.addShadowCaster(m, true);
        }
    };

    const setShadowEnabled = (enabled: boolean) => {
        shadowEnabled = enabled;
        shadowReceiver.setEnabled(enabled);
        if (enabled) {
            // (Re-)register every existing object as a caster when
            // the user flips shadows on after objects already exist.
            for (const o of objects) registerObjectAsCaster(o);
        }
    };

    // ── Shading + shadow tuning hooks ──────────────────────────────
    // Live state mirrors so the setters can compose without each one
    // needing to know what the others did. The directional light's
    // direction recomputes from (azimuth, elevation) every change.
    let shadowOffsetX = -0.2;
    let shadowOffsetZ = -0.2;
    let shadowLengthFactor = 1.0;

    const recomputeShadowDirection = () => {
        // Higher `shadowLengthFactor` → light angled more steeply
        // downward → shadow tucks under the model. Lower → grazing
        // angle → shadow stretches out along the requested offset.
        const dx = shadowOffsetX;
        const dz = shadowOffsetZ;
        const dy = -shadowLengthFactor;
        const dir = new Vector3(dx, dy, dz);
        dir.normalize();
        shadowLight.direction = dir;
    };

    const setShadowDarkness = (value: number) => {
        currentDarkness = Math.min(0.99, Math.max(0, value));
        if (shadowGen) shadowGen.darkness = currentDarkness;
    };

    const setShadowQuality = (quality: ShadowQuality) => {
        currentQuality = quality;
        shadowGen = buildShadowGen(currentQuality);
    };
    const setShadowDirection = (x: number, z: number) => {
        shadowOffsetX = x;
        shadowOffsetZ = z;
        recomputeShadowDirection();
    };
    const setShadowLength = (value: number) => {
        // Map 0..1 → 0.1..3.0 so the user always gets a sensible angle.
        // Higher slider → light is more overhead → shorter shadow.
        shadowLengthFactor = 0.1 + Math.max(0, Math.min(1, value)) * 2.9;
        recomputeShadowDirection();
    };

    const setShadingIntensity = (value: number) => {
        hemi.intensity = Math.max(0, value);
    };

    // ── Glow layer (bloom post-process) ─────────────────────────
    // Off by default. Toggled on via the Lighting panel. When
    // enabled, the glow library mode in studioObject re-applies
    // emissive on every material slot so the diffuse texture bleeds
    // into the bloom; without that the glow has nothing to read.
    const glowLayer = new GlowLayer('studio-glow', scene, {
        mainTextureRatio: 0.5,
        mainTextureSamples: 1,
        blurKernelSize: 64,
    });
    glowLayer.intensity = 0.8;
    glowLayer.isEnabled = false;

    const setGlowEnabled = (enabled: boolean) => {
        glowLayer.isEnabled = enabled;
        // Re-apply each loaded object's materials so they pick up
        // the new emissive state (or strip it when disabling).
        for (const o of objects) o.setGlow?.(enabled);
    };
    const setGlowIntensity = (value: number) => {
        glowLayer.intensity = Math.max(0, value);
    };

    const setShadingDirection = (azimuth: number, elevation: number) => {
        // Spherical → cartesian. `elevation` is the angle above the
        // horizon (PI/2 = straight up, 0 = horizontal, -PI/2 = below).
        const ce = Math.cos(elevation);
        hemi.direction = new Vector3(
            Math.sin(azimuth) * ce,
            Math.sin(elevation),
            Math.cos(azimuth) * ce,
        );
    };

    engine.runRenderLoop(() => {
        if (!disposed) scene.render();
    });
    const ro = new ResizeObserver(() => {
        engine.resize();
        // Re-fit the background image whenever the canvas changes
        // size — without this the image stretches / drifts as the
        // tab or dock layout changes.
        applyBgLayerTransform();
    });
    ro.observe(canvas);
    let disposed = false;

    const objects: StudioObject[] = [];
    let activeObjectId: string | null = null;
    let activePlayer: AnimationPlayer | null = null;
    let playerObserverDispose: (() => void) | null = null;
    let gizmoMode: GizmoMode = 'none';
    const changeListeners = new Set<() => void>();

    // ── Undo / dirty tracking ──
    // Snapshot-based: each committed mutation pushes the PRE-mutation
    // scene state onto `undoStack`. `loadFromData` is reused as the
    // restore path. `suspendUndo` guards the re-entrant object loads
    // that `loadFromData` itself triggers. `dirtyCounter` bumps on
    // every commit; `savedCounter` is stamped on save — they differ
    // iff there are unsaved changes.
    const MAX_UNDO = 50;
    const undoStack: StudioSceneData[] = [];
    const redoStack: StudioSceneData[] = [];
    let lastSnapshot: StudioSceneData | null = null;
    let suspendUndo = false;
    let dirtyCounter = 0;
    let savedCounter = 0;

    // GizmoManager renders the move / rotate / scale widgets on a
    // dedicated UtilityLayer so they sit on top of the model without
    // being affected by its lighting / post-fx. We disable pointer
    // attach-on-click so picking a mesh in the viewport DOESN'T re-
    // bind the gizmo to whatever mesh you clicked — the studio
    // explicitly tracks "active object" through the Objects panel.
    const gizmoLayer = new UtilityLayerRenderer(scene);
    const gizmoManager = new GizmoManager(scene, undefined, gizmoLayer);
    gizmoManager.usePointerToAttachGizmos = false;
    gizmoManager.positionGizmoEnabled = false;
    gizmoManager.rotationGizmoEnabled = false;
    gizmoManager.scaleGizmoEnabled = false;
    // Wire the drag-end observers so a gizmo-driven nudge emits a
    // scene change — the panel's number inputs re-render to reflect
    // the new translation / rotation / scale values.
    const wireGizmoChange = () => {
        const pg = gizmoManager.gizmos.positionGizmo;
        const rg = gizmoManager.gizmos.rotationGizmo;
        const sg = gizmoManager.gizmos.scaleGizmo;
        // Record one undo step per drag gesture (on release, not per
        // frame) — that's also what re-renders the transform inputs.
        const onDragEnd = () => commitUndoStep();
        pg?.onDragEndObservable.add(onDragEnd);
        rg?.onDragEndObservable.add(onDragEnd);
        sg?.onDragEndObservable.add(onDragEnd);
    };

    const emitChange = () => {
        for (const cb of changeListeners) {
            try { cb(); } catch { /* listener errors mustn't kill the loop */ }
        }
    };

    const getActiveObject = (): StudioObject | null => {
        if (!activeObjectId) return null;
        return objects.find((o) => o.id === activeObjectId) ?? null;
    };

    const reattachGizmo = () => {
        const active = getActiveObject();
        gizmoManager.attachToNode(active?.root ?? null);
    };

    const setActiveObject = (id: string | null) => {
        if (activeObjectId === id) return;
        // Stop any playing clip when switching active object — the
        // player is bound to the previous SKN's bones and would write
        // gibberish to whatever the new selection's bones happen to be.
        stopClip();
        activeObjectId = id;
        reattachGizmo();
        emitChange();
    };

    const getGizmoMode = (): GizmoMode => gizmoMode;
    const setGizmoMode = (mode: GizmoMode) => {
        if (gizmoMode === mode) return;
        gizmoMode = mode;
        gizmoManager.positionGizmoEnabled = mode === 'move';
        gizmoManager.rotationGizmoEnabled = mode === 'rotate';
        gizmoManager.scaleGizmoEnabled   = mode === 'scale';
        // Babylon lazily constructs the per-mode gizmo on first
        // enable, so wire the drag observers AFTER the toggle.
        wireGizmoChange();
        reattachGizmo();
        emitChange();
    };

    const removeObject = (id: string) => {
        const idx = objects.findIndex((o) => o.id === id);
        if (idx < 0) return;
        const [removed] = objects.splice(idx, 1);
        if (activeObjectId === id) {
            stopClip();
            activeObjectId = objects[0]?.id ?? null;
        }
        try { removed.dispose(); } catch { /* ignore */ }
        reattachGizmo();
        commitUndoStep();
    };

    const clearObjects = () => {
        stopClip();
        const old = objects.splice(0, objects.length);
        for (const o of old) {
            try { o.dispose(); } catch { /* ignore */ }
        }
        activeObjectId = null;
        reattachGizmo();
        // `commitUndoStep` no-ops under `suspendUndo` (set by
        // loadFromData), so a standalone clear records a step while a
        // load-driven clear doesn't.
        commitUndoStep();
    };

    const addObjectInternal = (obj: StudioObject): StudioObject => {
        objects.push(obj);
        activeObjectId = obj.id;
        frameCameraAroundScene();
        reattachGizmo();
        // Register the new object's meshes as shadow casters. Costs
        // nothing when shadows are off (`shadowGen` still tracks them
        // but the receiver plane is disabled, so no shadow render).
        if (shadowEnabled) registerObjectAsCaster(obj);
        commitUndoStep();
        return obj;
    };

    const addModelFromDisk = async (path: string): Promise<StudioObject> => {
        const ext = (path.match(/\.([^./\\]+)$/i)?.[1] ?? '').toLowerCase();
        if (ext === 'gltf' || ext === 'glb') {
            const obj = await createGltfObject(scene, path);
            return addObjectInternal(obj);
        }
        if (ext === 'fbx') {
            const obj = await createFbxObject(scene, path);
            return addObjectInternal(obj);
        }
        // Default: treat as League SKN (the legacy path).
        const obj = await createSknObject(scene, path);
        return addObjectInternal(obj);
    };

    const loadModelFromDisk = async (path: string): Promise<StudioObject> => {
        clearObjects();
        return addModelFromDisk(path);
    };

    const reloadActiveObjectAnimations = async (extraDir?: string | null): Promise<void> => {
        const active = getActiveObject();
        if (!active || !active.skn || !active.sourcePath) return;
        try {
            const fresh = await import('@tauri-apps/api/core').then(({ invoke }) =>
                invoke<unknown>('read_skn_animations_disk_cmd', {
                    sknPath: active.sourcePath!,
                    extraAnimDir: extraDir ?? null,
                }),
            );
            // Mutate the existing skn-data object so all panel readers
            // (which hold a stable reference via `getActiveObject`) see
            // the new listing on the next render.
            active.skn.animations = fresh as typeof active.skn.animations;
            emitChange();
        } catch (e) {
            console.warn('[Studio] reload animations failed:', e);
        }
    };

    const addPrimitive = (kind: PrimitiveKind): StudioObject => {
        const obj = createPrimitiveObject(scene, kind);
        return addObjectInternal(obj);
    };

    /**
     * Frame the camera on the active object, or — when nothing is
     * selected — the whole scene. Adding an object makes it active,
     * so a load / primitive-insert frames just that new object.
     */
    function frameCameraAroundScene() {
        const active = getActiveObject();
        const targetObjects = active ? [active] : objects;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let any = false;
        for (const obj of targetObjects) {
            for (const m of obj.meshes) {
                m.computeWorldMatrix(true);
                m.refreshBoundingInfo({});
                const bb = m.getBoundingInfo().boundingBox;
                const lo = bb.minimumWorld;
                const hi = bb.maximumWorld;
                if (Number.isFinite(lo.x)) {
                    any = true;
                    if (lo.x < minX) minX = lo.x;
                    if (lo.y < minY) minY = lo.y;
                    if (lo.z < minZ) minZ = lo.z;
                    if (hi.x > maxX) maxX = hi.x;
                    if (hi.y > maxY) maxY = hi.y;
                    if (hi.z > maxZ) maxZ = hi.z;
                }
            }
        }
        if (!any) return;
        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;
        const target = new Vector3(
            (minX + maxX) / 2,
            (minY + maxY) / 2,
            (minZ + maxZ) / 2,
        );
        // Same Y-weighted framing the legacy single-model path used —
        // tall+winged silhouettes (Aatrox) hate a flat max().
        const radius = Math.max(sizeY * 1.4, sizeX, sizeZ) || 5;
        camera.setTarget(target);
        camera.alpha = Math.PI / 2 + Math.PI / 8;
        camera.beta = Math.PI / 2 - Math.PI / 8;
        camera.radius = radius;
        camera.lowerRadiusLimit = radius * 0.05;
        camera.upperRadiusLimit = radius * 12;
        // Scale-aware control speeds. A fixed wheel/pan sensitivity
        // feels fine at one model size but turns janky (overshooting
        // or barely moving) at extremes — a 30-unit prop and a
        // 3000-unit map need very different step sizes. Deriving them
        // from `radius` keeps the feel consistent regardless of how
        // big or small the loaded model is.
        camera.wheelPrecision = 80 / radius;          // wheel zoom step
        camera.pinchPrecision = 160 / radius;         // touch pinch
        camera.panningSensibility = 8000 / radius;    // RMB / MMB pan
        camera.speed = radius * 0.02;                 // keyboard nudge
        // Re-assert the angular limits too — wide enough to orbit
        // under the model but not so wide the camera flips.
        camera.lowerBetaLimit = 0.01;
        camera.upperBetaLimit = Math.PI - 0.01;
    }

    // Background image is rendered via a Babylon `Layer` flagged as
    // background — draws behind the 3D scene, unaffected by the
    // camera. We DON'T let it auto-stretch fullscreen; instead the
    // layer's `scale` + `offset` are computed from the image's
    // aspect ratio vs the canvas's, plus the user's fit / zoom /
    // offset config (see `applyBgLayerTransform`).
    let bgLayer: Layer | null = null;
    let bgConfig: BackgroundImageConfig | null = null;
    // Full background descriptor, tracked so `serialize()` can round-
    // trip it. `bgConfig` only covers the image case; this covers all.
    let currentBackground: StudioBackground = { kind: 'transparent' };
    const clearBgLayer = () => {
        if (bgLayer) {
            try { bgLayer.dispose(); } catch { /* ignore */ }
            bgLayer = null;
        }
        bgConfig = null;
    };

    /** Recompute the bg layer's quad transform AND its texture
     *  matrix from the config + current canvas / image sizes.
     *
     *  Babylon's `Layer` couples the quad transform to the UV
     *  mapping — scaling the quad via `Layer.scale` also scales the
     *  sampled UVs, so a half-size quad shows the texture's centre
     *  rather than the whole image. To get clean fit/zoom/pan we:
     *    1. size + position the quad in NDC (`scale` / `offset`)
     *    2. counteract the UV coupling with the texture matrix
     *       (`uScale/vScale/uOffset/vOffset`) so the FULL image
     *       always maps 1:1 onto whatever the quad covers.
     *  `cover` makes the quad bigger than the screen (image fills,
     *  edges clipped); `contain` makes it smaller (clearColor shows
     *  in the letterbox bars); `stretch` is exactly fullscreen.
     *
     *  Safe to call any time; no-ops without an image background. */
    function applyBgLayerTransform() {
        if (!bgLayer || !bgConfig) return;
        const tex = bgLayer.texture as Texture | null;
        // `getSize()` returns 0×0 until the texture finishes loading;
        // the onLoadObservable hook in `setBackground` re-invokes us.
        const ts = tex ? tex.getSize() : { width: 0, height: 0 };
        if (!tex || !ts.width || !ts.height) return;
        const imgAspect = ts.width / ts.height;
        const canvasAspect = Math.max(1e-3, engine.getRenderWidth() / engine.getRenderHeight());
        const zoom = Math.max(0.05, bgConfig.zoom || 1);

        // ── 1. Quad size in NDC half-extents ──
        let sx = 1;
        let sy = 1;
        if (bgConfig.fit === 'stretch') {
            sx = 1; sy = 1;
        } else {
            const wider = imgAspect > canvasAspect;
            // contain: shrink the limiting axis (quad fits inside).
            // cover:  grow the other axis (quad spills past screen).
            if (bgConfig.fit === 'contain') {
                if (wider) { sx = 1; sy = canvasAspect / imgAspect; }
                else       { sy = 1; sx = imgAspect / canvasAspect; }
            } else { // cover
                if (wider) { sy = 1; sx = imgAspect / canvasAspect; }
                else       { sx = 1; sy = canvasAspect / imgAspect; }
            }
        }
        sx *= zoom;
        sy *= zoom;

        // ── 2. Quad offset (pan) ──
        // Available travel is |1 - s| in each axis: positive for
        // contain (room inside the frame), positive for cover (room
        // to slide the oversized quad) — abs() covers both.
        const offX = bgConfig.offsetX * Math.abs(1 - sx);
        const offY = bgConfig.offsetY * Math.abs(1 - sy);
        bgLayer.scale.set(sx, sy);
        bgLayer.offset.set(offX, offY);

        // ── 3. Counter-texture matrix ──
        // Layer vertex shader: vUV_raw = shiftedPos * 0.5 + 0.5,
        // where shiftedPos ∈ [offset - scale, offset + scale]. We
        // want vUV_final ∈ [0, 1] across the quad's own span, so
        // solve final = raw * uScale + uOffset for the quad corners.
        const rawMinX = (offX - sx) * 0.5 + 0.5;
        const rawMinY = (offY - sy) * 0.5 + 0.5;
        tex.uScale = 1 / sx;
        tex.vScale = 1 / sy;
        tex.uOffset = -rawMinX / sx;
        tex.vOffset = -rawMinY / sy;
    }

    const setBackground = (bg: StudioBackground) => {
        currentBackground = bg.kind === 'image'
            ? { kind: 'image', config: { ...bg.config } }
            : bg;
        if (bg.kind === 'image') {
            // Keep `clearColor` transparent so anything the layer
            // doesn't cover (contain-mode letterbox bars) shows the
            // editor background rather than a hardcoded color.
            clearBgLayer();
            scene.clearColor = new Color4(0, 0, 0, 0);
            const url = convertFileSrc(bg.config.path);
            bgLayer = new Layer('studio-bg-image', url, scene, /* isBackground */ true);
            bgConfig = { ...bg.config };
            const bgTex = bgLayer.texture as Texture | null;
            if (bgTex) {
                // CLAMP so any float-precision overshoot at the quad
                // edges samples the edge texel instead of wrapping
                // to the opposite side of the image.
                bgTex.wrapU = 0; // Texture.CLAMP_ADDRESSMODE
                bgTex.wrapV = 0;
                // Re-fit once the texture's real dimensions are known.
                bgTex.onLoadObservable.addOnce(() => applyBgLayerTransform());
            }
            applyBgLayerTransform();
            commitUndoStep();
            return;
        }
        clearBgLayer();
        if (bg.kind === 'transparent') {
            scene.clearColor = new Color4(0, 0, 0, 0);
            commitUndoStep();
            return;
        }
        const c = parseHexColor(bg.color);
        scene.clearColor = new Color4(c.r, c.g, c.b, 1);
        commitUndoStep();
    };

    /** Update just the transform of the current image background
     *  (fit / zoom / offset) without reloading the texture. No-op
     *  unless an image background is active. */
    const setBackgroundTransform = (patch: Partial<Omit<BackgroundImageConfig, 'path'>>) => {
        if (!bgConfig) return;
        bgConfig = { ...bgConfig, ...patch };
        // Keep the serializable copy in sync too.
        if (currentBackground.kind === 'image') {
            currentBackground = { kind: 'image', config: { ...bgConfig } };
        }
        applyBgLayerTransform();
        // No `commitUndoStep` here — this is called continuously by
        // the panel's zoom / pan sliders. The panel commits one undo
        // step on pointer-release instead (see StudioBackgroundPanel).
    };

    const setGridVisible = (visible: boolean) => {
        ground.setEnabled(visible);
        commitUndoStep();
    };

    const screenshot = async (opts: ScreenshotOpts): Promise<string> => {
        const { width, height, hideGrid, transparent, mimeType = 'image/png' } = opts;
        const prevClear = scene.clearColor.clone();
        const prevGrid = ground.isEnabled();
        if (hideGrid) ground.setEnabled(false);
        if (transparent) scene.clearColor = new Color4(0, 0, 0, 0);
        try {
            return await new Promise<string>((resolve, reject) => {
                try {
                    Tools.CreateScreenshotUsingRenderTarget(
                        engine,
                        camera,
                        { width, height },
                        (data) => resolve(data),
                        mimeType,
                        4,
                    );
                } catch (e) {
                    reject(e);
                }
            });
        } finally {
            scene.clearColor = prevClear;
            ground.setEnabled(prevGrid);
        }
    };

    function stopClip(): void {
        if (playerObserverDispose) {
            try { playerObserverDispose(); } catch { /* ignore */ }
            playerObserverDispose = null;
        }
        activePlayer = null;
        emitChange();
    }

    const playClip = async (clip: StudioAnimClip): Promise<AnimationPlayer | null> => {
        const active = getActiveObject();
        if (!active || !active.skn) return null;
        if (!clip.anm_disk_path) return null;
        let baked: BakedAnimationDTO;
        try {
            baked = await loadDiskAnimation(clip.anm_disk_path);
        } catch {
            return null;
        }
        stopClip();
        const player = new AnimationPlayer(
            baked,
            active.skn.boneIndexByHash,
            active.skn.bones,
            active.skn.joints,
        );
        player.paused = false;
        player.speed = 1;
        const observer = scene.onBeforeRenderObservable.add(() => {
            const dt = engine.getDeltaTime() / 1000;
            player.tick(dt);
        });
        playerObserverDispose = () => {
            if (observer) scene.onBeforeRenderObservable.remove(observer);
        };
        activePlayer = player;
        emitChange();
        return player;
    };

    const getPlayer = () => activePlayer;
    const onChange = (cb: () => void) => {
        changeListeners.add(cb);
        return () => { changeListeners.delete(cb); };
    };

    // ── Serialization ──────────────────────────────────────────────

    const serialize = (): StudioSceneData => {
        const objectData: StudioObjectData[] = objects.map((obj) => {
            const r = obj.root;
            return {
                kind: obj.kind,
                name: obj.name,
                sourcePath: obj.sourcePath,
                rootVisible: r.isEnabled(),
                transform: {
                    position: [r.position.x, r.position.y, r.position.z],
                    rotation: [r.rotation.x, r.rotation.y, r.rotation.z],
                    scaling: [r.scaling.x, r.scaling.y, r.scaling.z],
                },
                slots: obj.slots.map((slot, i) => ({
                    visible: slot.mesh.isEnabled(),
                    // `sideOrientation === 1` is the BACKSIDE / flipped
                    // state — read directly to avoid importing the
                    // helper just for one comparison.
                    flipped: (slot.mesh as Mesh).sideOrientation === 1,
                    override: obj.slotOverrides[i] ?? { kind: 'none' },
                })),
            };
        });
        const target = camera.getTarget();
        return {
            version: 1,
            objects: objectData,
            background: currentBackground,
            gridVisible: ground.isEnabled(),
            camera: {
                alpha: camera.alpha,
                beta: camera.beta,
                radius: camera.radius,
                target: [target.x, target.y, target.z],
            },
        };
    };

    const loadFromData = async (data: StudioSceneData): Promise<void> => {
        clearObjects();
        for (const od of data.objects) {
            let obj: StudioObject | null = null;
            try {
                if (od.kind === 'cube' || od.kind === 'plane' || od.kind === 'sphere') {
                    obj = addPrimitive(od.kind);
                } else if (od.sourcePath) {
                    obj = await addModelFromDisk(od.sourcePath);
                }
            } catch (e) {
                console.warn('[Studio] failed to restore object', od.name, e);
                continue;
            }
            if (!obj) continue;
            obj.name = od.name;
            // Restore transform.
            obj.root.position.set(...od.transform.position);
            obj.root.rotation.set(...od.transform.rotation);
            obj.root.scaling.set(...od.transform.scaling);
            obj.root.setEnabled(od.rootVisible);
            // Restore per-slot state — visibility, flip, texture
            // override. The override is applied last; `applyDiskSknTextures`
            // already skips slots whose override isn't `none`, so the
            // background BIN walk won't clobber what we restore here.
            for (let i = 0; i < od.slots.length && i < obj.slots.length; i++) {
                const sd = od.slots[i];
                obj.slots[i].mesh.setEnabled(sd.visible);
                setMeshFaceFlipped(obj.slots[i].mesh, sd.flipped);
                if (sd.override.kind === 'file') {
                    void obj.applyUserTexture(i, sd.override.path);
                } else if (sd.override.kind === 'pattern') {
                    obj.applyProceduralTexture(i, sd.override.pattern);
                }
            }
        }
        setBackground(data.background);
        setGridVisible(data.gridVisible);
        // Restore camera last so per-object framing during the loads
        // above doesn't fight the saved viewpoint.
        camera.setTarget(new Vector3(...data.camera.target));
        camera.alpha = data.camera.alpha;
        camera.beta = data.camera.beta;
        camera.radius = data.camera.radius;
        // Re-derive scale-aware control speeds from the restored radius.
        camera.wheelPrecision = 80 / Math.max(0.001, data.camera.radius);
        camera.panningSensibility = 8000 / Math.max(0.001, data.camera.radius);
        emitChange();
    };

    // ── Undo / redo ────────────────────────────────────────────────

    /** Record an undo step. Call AFTER a mutation completes. Pushes
     *  the PRE-mutation snapshot onto the undo stack and re-snapshots
     *  current state. Also the single "scene changed" signal — bumps
     *  the dirty counter and notifies listeners. No-ops while
     *  `suspendUndo` is set (during `loadFromData` / undo / redo). */
    const commitUndoStep = () => {
        if (suspendUndo) return;
        if (lastSnapshot) {
            undoStack.push(lastSnapshot);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
        }
        redoStack.length = 0;
        lastSnapshot = serialize();
        dirtyCounter += 1;
        emitChange();
    };

    const undo = async () => {
        if (undoStack.length === 0) return;
        const prev = undoStack.pop()!;
        redoStack.push(serialize());
        suspendUndo = true;
        try {
            await loadFromData(prev);
        } finally {
            suspendUndo = false;
        }
        lastSnapshot = prev;
        dirtyCounter += 1;
        emitChange();
    };

    const redo = async () => {
        if (redoStack.length === 0) return;
        const next = redoStack.pop()!;
        undoStack.push(serialize());
        suspendUndo = true;
        try {
            await loadFromData(next);
        } finally {
            suspendUndo = false;
        }
        lastSnapshot = next;
        dirtyCounter += 1;
        emitChange();
    };

    const canUndo = () => undoStack.length > 0;
    const canRedo = () => redoStack.length > 0;
    const isDirty = () => dirtyCounter !== savedCounter;
    /** Wipe undo/redo history and re-baseline against the current
     *  scene. Called after loading a `.studio.json` so the user
     *  can't "undo" back past the freshly-opened state into the
     *  empty scene that existed before the load. */
    const resetUndoHistory = () => {
        undoStack.length = 0;
        redoStack.length = 0;
        lastSnapshot = serialize();
        emitChange();
    };
    /** Stamp the current state as "saved" — call after a successful
     *  write to `.studio.json`. */
    const markSaved = () => {
        savedCounter = dirtyCounter;
        emitChange();
    };

    // Baseline snapshot — the empty scene. The first real mutation's
    // `commitUndoStep` pushes this so the user can undo back to empty.
    lastSnapshot = serialize();

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        stopClip();
        clearObjects();
        try { gizmoManager.dispose(); } catch { /* ignore */ }
        try { gizmoLayer.dispose(); } catch { /* ignore */ }
        ro.disconnect();
        engine.stopRenderLoop();
        scene.dispose();
        engine.dispose();
    };

    return {
        engine, scene, camera,
        setBackground, setBackgroundTransform, setGridVisible,
        setShadowEnabled, setShadowQuality, setShadowDarkness, setShadowDirection, setShadowLength,
        setShadingIntensity, setShadingDirection,
        setGlowEnabled, setGlowIntensity,
        screenshot,
        addModelFromDisk, loadModelFromDisk, reloadActiveObjectAnimations, addPrimitive,
        frameCamera: frameCameraAroundScene,
        removeObject, clearObjects,
        getObjects: () => objects.slice(),
        getActiveObject, setActiveObject,
        playClip, stopClip, getPlayer,
        onChange,
        getGizmoMode, setGizmoMode,
        serialize, loadFromData,
        commitUndoStep, undo, redo, canUndo, canRedo, resetUndoHistory, isDirty, markSaved,
        dispose,
    };
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
    let h = hex.trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
    return {
        r: ((n >> 16) & 0xff) / 255,
        g: ((n >> 8) & 0xff) / 255,
        b: (n & 0xff) / 255,
    };
}

export type { StudioAnimClip, StudioAnimListing };
export type { StudioObject, PrimitiveKind } from './studioObject';

/** @deprecated kept as a type re-export for callers that still
 *  reference the single-model shape. New code should use
 *  `StudioObject` from `studioObject.ts`. */
export type LoadedStudioModel = StudioObject;
