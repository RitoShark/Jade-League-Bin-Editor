/**
 * One renderable thing inside a Photo Studio scene.
 *
 * The studio is multi-object — users compose scenes by stacking
 * League skins, GLTF props, and primitive cubes/planes/spheres.
 * Every object is wrapped in a single `TransformNode` so the user
 * can translate / rotate / scale it as one unit regardless of how
 * many submeshes it has internally.
 *
 * Texture overrides are tracked per-slot (one slot per material). The
 * mesh / textures panel reads `slots` and calls `applyUserTexture` /
 * `clearUserTexture` to drop in PNG / JPG / TEX / DDS bytes on a slot
 * that the auto pipeline couldn't resolve.
 */

import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector';
// CustomMaterial import removed — the toon path now uses
// MaterialPluginBase to inject GLSL into the existing PBR material
// rather than swapping materials wholesale. See BandOverlayPlugin.
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import '@babylonjs/loaders/glTF';
// (TGA / WebP / BMP / etc. now decode via the Rust `image` crate
// alongside DDS and TEX — see `core/mesh/texture_decode.rs::decode_auto`.
// No JS-side texture loader registration needed.)
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { Bone } from '@babylonjs/core/Bones/bone';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';

import { buildSknMeshes, type SknDTO } from './meshBuilder';
import {
    buildBabylonSkeleton,
    type SklJointDTO,
    type SklSkeletonDTO,
} from './skeletonBuilder';
import type { StudioAnimListing } from './studioLoad';

export type StudioObjectKind = 'skn' | 'gltf' | 'fbx' | 'cube' | 'plane' | 'sphere';
export type PrimitiveKind = 'cube' | 'plane' | 'sphere';

export interface StudioSlot {
    /** The mesh whose material this slot represents. The mesh panel
     *  uses this to toggle visibility per-slot AND to label the slot
     *  by mesh name. */
    mesh: AbstractMesh;
    mat: PBRMaterial;
    /** Color used for the placeholder hue / primitive default. */
    defaultColor: Color3;
    /** Last texture (+ hasAlpha flag) applied to this slot's material.
     *  Tracked so the object-level transparency toggle / cutoff slider
     *  can re-apply with the new settings without needing to re-fetch
     *  the texture bytes. `null` when the slot is still showing the
     *  hue placeholder. */
    lastApplied?: { tex: BaseTexture; hasAlpha: boolean } | null;
}

/**
 * Flip one mesh's face winding — a *real* geometry flip (reverse the two
 * trailing indices of every triangle) plus a normal recompute, not a
 * `sideOrientation` swap.
 *
 * Why geometry, not `sideOrientation`: League SKN meshes load as
 * `DOUBLESIDE` (capes / cloth need both sides), so a `sideOrientation`
 * toggle either did nothing visible or fought the double-sided render, and
 * the panel could never tell "is this flipped?" from the orientation value.
 * Reversing the winding is unambiguous, persists through export, and makes
 * the Blender-style face-orientation overlay (which reads `gl_FrontFacing`)
 * recolor the moment you flip. The current state is tracked on
 * `mesh.metadata.jadeFaceFlipped` so the panel can seed its button and — for
 * League meshes, which the importer already winds "flipped" — start selected.
 */
export function setMeshFaceFlipped(mesh: AbstractMesh, flipped: boolean): void {
    const M = mesh as Mesh;
    if (isMeshFaceFlipped(M) === flipped) return;
    reverseMeshWinding(M);
    const meta = (M.metadata ?? {}) as Record<string, unknown>;
    meta.jadeFaceFlipped = flipped;
    M.metadata = meta;
}

/**
 * Read the current flip state off a mesh. League importer marks its meshes
 * `jadeFaceFlipped: true` at build (their winding is pre-flipped), so the
 * panel's Flip button shows selected for them by default.
 */
export function isMeshFaceFlipped(mesh: AbstractMesh): boolean {
    const meta = (mesh as Mesh).metadata as { jadeFaceFlipped?: boolean } | null | undefined;
    return !!(meta && meta.jadeFaceFlipped);
}

/** Reverse every triangle's winding in place and recompute normals so lit
 *  shading + the face-orientation overlay both track the new front side. */
function reverseMeshWinding(mesh: Mesh): void {
    const indices = mesh.getIndices();
    if (!indices) return;
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const tmp = indices[i + 1];
        indices[i + 1] = indices[i + 2];
        indices[i + 2] = tmp;
    }
    mesh.setIndices(indices);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
        const normals = mesh.getVerticesData(VertexBuffer.NormalKind) ?? new Float32Array(positions.length);
        VertexData.ComputeNormals(positions, indices, normals);
        mesh.setVerticesData(VertexBuffer.NormalKind, normals);
    }
}

export interface StudioObjectSknData {
    skeleton: Skeleton;
    bones: Bone[];
    joints: SklJointDTO[];
    boneIndexByHash: Map<number, number>;
    animations: StudioAnimListing | null;
}

/** What texture a slot is currently showing — the source of truth
 *  for both the mesh panel's display state and scene serialization.
 *  `none` means "whatever the auto-resolve pipeline produced (or the
 *  hue placeholder)". */
export type StudioSlotOverride =
    | { kind: 'none' }
    | { kind: 'file'; path: string }
    | { kind: 'pattern'; pattern: ProceduralPattern };

export interface StudioObject {
    id: string;
    name: string;
    kind: StudioObjectKind;
    /** Disk path the object was loaded from (skn / gltf / fbx).
     *  `undefined` for primitives, which are reconstructed from
     *  `kind` alone. Used by scene save/load + undo snapshots. */
    sourcePath?: string;
    /** Single parent for every mesh of this object. The transform
     *  panel mutates `root.position / .rotation / .scaling`. */
    root: TransformNode;
    meshes: AbstractMesh[];
    /** One slot per material. */
    slots: StudioSlot[];
    /** Per-slot texture override state, parallel to `slots`. Updated
     *  by the apply* functions below so the object is the single
     *  source of truth — the mesh panel reads this and so does
     *  serialization. */
    slotOverrides: StudioSlotOverride[];
    /** SKN-only payload — animation playback hooks against this. */
    skn?: StudioObjectSknData;
    /** Texture override functions used by the mesh panel. The slot
     *  parameter is an index into `slots`. */
    applyUserTexture: (slotIndex: number, diskPath: string) => Promise<boolean>;
    /** Procedural texture override: generate a small image at runtime
     *  from a pattern descriptor (solid / split / checker / gradient)
     *  and apply it as the slot's diffuse. Lets users texture meshes
     *  without making temp files on disk. */
    applyProceduralTexture: (slotIndex: number, params: ProceduralPattern) => boolean;
    clearUserTexture: (slotIndex: number) => void;
    /** Object-level transparency settings. Mirror what the Viewer's
     *  Options accordion exposes — toggle masks `hasAlpha`, slider
     *  drives `alphaCutOff`. Mutating these via `setTransparency`
     *  reapplies every slot's material in place. */
    transparencyEnabled: boolean;
    alphaCutoff: number;
    setTransparency: (enabled: boolean, cutoff: number) => void;
    /** Shading flag — when `false` (default) every textured material
     *  renders flat (mat.unlit = true) so the model looks like the
     *  Extract tab / Viewer preview. Spotlight panel flips this for
     *  full PBR lit rendering. */
    shadingEnabled: boolean;
    setShading: (enabled: boolean) => void;
    /** Per-object material kind. `'flat'` is the default unlit PBR
     *  path. `'toon'` swaps to a flat + band-overlay shader where
     *  the band's direction, width, edge softness, and intensity
     *  are user-tunable. */
    materialMode: 'flat' | 'toon';
    setMaterialMode: (mode: 'flat' | 'toon') => void;
    /** Euler rotations (radians) of the band normal in view space.
     *  Z rolls the band line on screen; Y yaws the band; X pitches
     *  it. The band stays anchored to the screen as the camera
     *  orbits. */
    bandRotationX: number;
    bandRotationY: number;
    bandRotationZ: number;
    /** Band thickness, 0..1 of the dot-product range. */
    bandWidth: number;
    /** Edge softness for the band falloff, 0..1. */
    bandSoftness: number;
    /** Strength multiplier — positive brightens, negative darkens. */
    bandIntensity: number;
    setBandRotation: (rx: number, ry: number, rz: number) => void;
    setBandWidth: (width: number) => void;
    setBandSoftness: (soft: number) => void;
    setBandIntensity: (intensity: number) => void;
    /** Scene-level Glow toggle calls this on each object so the
     *  per-slot material can re-bind its emissive contribution
     *  (the GlowLayer reads emissive pixels for the bloom pass). */
    setGlow: (enabled: boolean) => void;
    dispose: () => void;
}

/** Pattern descriptor for procedural textures. `colorB` is ignored
 *  for `solid`; the rest of the patterns require both colors. */
export type ProceduralPattern =
    | { kind: 'solid'; colorA: string }
    | { kind: 'split-h'; colorA: string; colorB: string }
    | { kind: 'split-v'; colorA: string; colorB: string }
    | { kind: 'checker'; colorA: string; colorB: string }
    | { kind: 'gradient-h'; colorA: string; colorB: string }
    | { kind: 'gradient-v'; colorA: string; colorB: string }
    | { kind: 'uv-test' };

export const PROCEDURAL_KINDS: Array<ProceduralPattern['kind']> = [
    'solid', 'split-h', 'split-v', 'checker', 'gradient-h', 'gradient-v', 'uv-test',
];

export const PROCEDURAL_LABELS: Record<ProceduralPattern['kind'], string> = {
    'solid':       'Solid',
    'split-h':     'Split (horizontal)',
    'split-v':     'Split (vertical)',
    'checker':     'Checker',
    'gradient-h':  'Gradient (horizontal)',
    'gradient-v':  'Gradient (vertical)',
    'uv-test':     'UV Test (debug)',
};

export function describeProceduralPattern(p: ProceduralPattern): string {
    if (p.kind === 'solid') return `Solid ${p.colorA}`;
    if (p.kind === 'uv-test') return 'UV Test pattern';
    return `${PROCEDURAL_LABELS[p.kind]} ${p.colorA} / ${p.colorB}`;
}

const TEX_HEADER_LEN = 16;
const FLAG_HAS_ALPHA = 1 << 0;

let idCounter = 0;
function nextId(prefix: string): string {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
}

// ── SKN object ────────────────────────────────────────────────────

interface SknBindingsResponse {
    bin_path: string;
    bin_path_hash_hex: string;
    default_texture: string | null;
    default_chunk_hash_hex: string | null;
    default_texture_disk_path?: string | null;
    bindings: Array<{
        material: string;
        texture_path: string;
        chunk_hash_hex: string | null;
        texture_disk_path?: string | null;
    }>;
}

/**
 * Load a League SKN (+ sibling SKL + textures + animation listing)
 * as a studio object. Failures inside the texture / animation legs
 * are silent — a model that's missing those still renders with hue
 * placeholders.
 */
export async function createSknObject(
    scene: Scene,
    sknPath: string,
): Promise<StudioObject> {
    const skn = await invoke<SknDTO>('read_skn_mesh', { path: sknPath });
    let sklDto: SklSkeletonDTO | null = null;
    const sklPath = sknPath.replace(/\.[^./\\]+$/i, '.skl');
    try {
        sklDto = await invoke<SklSkeletonDTO>('read_skl_skeleton', { path: sklPath });
    } catch {
        sklDto = null;
    }

    let skeleton: Skeleton | null = null;
    let bones: Bone[] = [];
    let boneIndexByHash = new Map<number, number>();
    if (sklDto) {
        const built = buildBabylonSkeleton(sklDto, scene);
        skeleton = built.skeleton;
        bones = built.bones;
        boneIndexByHash = built.boneIndexByHash;
    }

    const built = buildSknMeshes(skn, scene, skeleton ?? undefined, sklDto?.influences);
    const meshes = built.meshes;

    const root = new TransformNode(nextId('skn-root'), scene);
    for (const m of meshes) {
        m.parent = root;
        // Skinned meshes deform per-frame via bone matrices, so the
        // bind-pose bounding box doesn't reflect what's actually
        // rendered. Babylon's frustum check would cull animated
        // submeshes whose verts extend outside that box — typical
        // symptom is heads / weapons "disappearing" at certain
        // camera angles. Disabling the per-frame frustum check skips
        // that test entirely (cheaper than `refreshBoundingInfo`
        // every frame).
        if (skeleton) m.alwaysSelectAsActiveMesh = true;
    }

    const slots: StudioSlot[] = [];
    const golden = 0.618033988749895;
    for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i];
        const mat = new PBRMaterial(`studio_skn_mat_${nextId('m')}`, scene);
        const hue = Color3.FromHSV(((i * golden) % 1) * 360, 0.5, 0.85);
        mat.unlit = true;
        applyHueMaterial(mat, hue);
        m.material = mat;
        slots.push({ mesh: m, mat, defaultColor: hue });
    }

    // Lift feet to y=0 so the model stands on the grid. Computed via
    // local-space bounds so we don't rely on a world matrix being
    // refreshed mid-frame.
    let minY = Infinity;
    for (const m of meshes) {
        m.computeWorldMatrix(true);
        m.refreshBoundingInfo();
        const lo = m.getBoundingInfo().boundingBox.minimum.y;
        if (Number.isFinite(lo) && lo < minY) minY = lo;
    }
    if (Number.isFinite(minY) && minY < 0) {
        root.position.y = -minY;
    }

    // Per-slot override state. Created here (before the async
    // texture pipeline kicks off) so `applyDiskSknTextures` can skip
    // slots the user / a loaded scene has explicitly overridden —
    // otherwise the background BIN walk would clobber a restored
    // override when it finishes.
    const slotOverrides: StudioSlotOverride[] = slots.map(() => ({ kind: 'none' as const }));

    // Texture pipeline — runs in the background; missing textures
    // never block the load itself.
    const loadedTextures = new Map<string, BaseTexture>();
    let disposed = false;
    const transparencySettings: TransparencySettings = { enabled: true, cutoff: 0.2, shadingEnabled: false };
    void applyDiskSknTextures(
        scene, sknPath, skn, slots, slotOverrides, loadedTextures,
        () => disposed, transparencySettings,
    );

    // Animation listing — async, populated when the BIN walk finishes.
    let animations: StudioAnimListing | null = null;
    try {
        animations = await invoke<StudioAnimListing | null>('read_skn_animations_disk_cmd', {
            sknPath,
        });
    } catch {
        animations = null;
    }

    const sknData: StudioObjectSknData | undefined = skeleton && sklDto ? {
        skeleton,
        bones,
        joints: sklDto.joints,
        boneIndexByHash,
        animations,
    } : undefined;

    const fileName = sknPath.split(/[\\/]/).pop() ?? 'model';

    const matKind = createMaterialKindAPI(scene, slots);

    const obj: StudioObject = {
        id: nextId('skn'),
        name: fileName.replace(/\.[^.]+$/i, ''),
        kind: 'skn',
        sourcePath: sknPath,
        root,
        meshes,
        slots,
        slotOverrides,
        skn: sknData,
        applyUserTexture: makeApplyUserTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        applyProceduralTexture: makeApplyProceduralTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        clearUserTexture: (i) => clearUserTexture(slots, slotOverrides, i),
        transparencyEnabled: transparencySettings.enabled,
        alphaCutoff: transparencySettings.cutoff,
        shadingEnabled: transparencySettings.shadingEnabled,
        setTransparency(enabled: boolean, cutoff: number) {
            transparencySettings.enabled = enabled;
            transparencySettings.cutoff = cutoff;
            obj.transparencyEnabled = enabled;
            obj.alphaCutoff = cutoff;
            // Re-apply every slot that has a tracked texture. Slots
            // still on the hue placeholder are untouched.
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, cutoff, enabled, transparencySettings.shadingEnabled);
            }
        },
        setShading(enabled: boolean) {
            transparencySettings.shadingEnabled = enabled;
            obj.shadingEnabled = enabled;
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, transparencySettings.cutoff, transparencySettings.enabled, enabled);
            }
        },
        materialMode: matKind.initial.mode,
        bandRotationX: matKind.initial.rotationX,
        bandRotationY: matKind.initial.rotationY,
        bandRotationZ: matKind.initial.rotationZ,
        bandWidth: matKind.initial.width,
        bandSoftness: matKind.initial.softness,
        bandIntensity: matKind.initial.intensity,
        setMaterialMode(mode) {
            obj.materialMode = mode;
            matKind.setMaterialMode(mode);
        },
        setBandRotation(rx, ry, rz) {
            obj.bandRotationX = rx;
            obj.bandRotationY = ry;
            obj.bandRotationZ = rz;
            matKind.setBandRotation(rx, ry, rz);
        },
        setBandWidth(w) {
            obj.bandWidth = w;
            matKind.setBandWidth(w);
        },
        setBandSoftness(s) {
            obj.bandSoftness = s;
            matKind.setBandSoftness(s);
        },
        setBandIntensity(i) {
            obj.bandIntensity = i;
            matKind.setBandIntensity(i);
        },
        setGlow(enabled) {
            matKind.setGlow(enabled);
        },
        dispose: () => {
            disposed = true;
            for (const m of meshes) m.dispose();
            for (const slot of slots) {
                slot.mat.dispose();
            }
            for (const tex of loadedTextures.values()) tex.dispose();
            if (skeleton) skeleton.dispose();
            root.dispose();
        },
    };
    return obj;
}

// ── GLTF object ────────────────────────────────────────────────────

/**
 * Load a glTF / GLB into the scene as one studio object. Babylon's
 * SceneLoader does the heavy lifting; we just collect the imported
 * meshes under a single TransformNode and wrap their materials in
 * the studio's slot interface.
 */
export async function createGltfObject(
    scene: Scene,
    diskPath: string,
): Promise<StudioObject> {
    // Babylon's loader takes a (rootUrl, fileName) pair. Split the
    // disk path into dir + filename and route both through Tauri's
    // file:// converter so the loader can fetch them via the webview.
    const slash = diskPath.replace(/\\/g, '/').lastIndexOf('/');
    const dir = slash >= 0 ? diskPath.slice(0, slash + 1) : './';
    const file = slash >= 0 ? diskPath.slice(slash + 1) : diskPath;
    const rootUrl = convertFileSrc(dir);

    const result = await SceneLoader.ImportMeshAsync('', rootUrl, file, scene);
    const imported = result.meshes;

    const root = new TransformNode(nextId('gltf-root'), scene);
    for (const m of imported) {
        // Only re-parent top-level meshes; child meshes already follow
        // their parent. Babylon's GLTF loader inserts a `__root__`
        // empty as the parent of everything, so this catches it once.
        if (!m.parent) m.parent = root;
    }

    // One slot per imported mesh so slots[i] aligns with meshes[i] —
    // the mesh panel relies on that mapping. Meshes that arrived
    // without a material (Babylon's __root__ empty among them) get a
    // placeholder PBR so the slot is never `undefined.mat`.
    const slots: StudioSlot[] = [];
    for (const m of imported) {
        const am = m as AbstractMesh;
        const existing = am.material;
        let pbr: PBRMaterial;
        if (existing instanceof PBRMaterial) {
            pbr = existing;
        } else if (existing) {
            // Non-PBR material — replace with a PBR clone so the rest
            // of the studio's material code paths (override / clear)
            // work uniformly.
            pbr = new PBRMaterial(`studio_gltf_mat_${nextId('m')}`, scene);
            pbr.metallic = 0;
            pbr.roughness = 1;
            am.material = pbr;
        } else {
            // No material at all (often Babylon's `__root__` empty).
            // Skip rather than allocate a stub the panel would render
            // as an empty card.
            continue;
        }
        slots.push({ mesh: am, mat: pbr, defaultColor: Color3.White() });
    }

    const loadedTextures = new Map<string, BaseTexture>();
    let disposed = false;

    const fileName = diskPath.split(/[\\/]/).pop() ?? 'model';
    const slotOverrides: StudioSlotOverride[] = slots.map(() => ({ kind: 'none' }));

    const transparencySettings: TransparencySettings = { enabled: true, cutoff: 0.2, shadingEnabled: false };
    const matKind = createMaterialKindAPI(scene, slots);
    const obj: StudioObject = {
        id: nextId('gltf'),
        name: fileName.replace(/\.[^.]+$/i, ''),
        kind: 'gltf',
        sourcePath: diskPath,
        root,
        meshes: imported,
        slots,
        slotOverrides,
        applyUserTexture: makeApplyUserTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        applyProceduralTexture: makeApplyProceduralTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        clearUserTexture: (i) => clearUserTexture(slots, slotOverrides, i),
        transparencyEnabled: transparencySettings.enabled,
        alphaCutoff: transparencySettings.cutoff,
        shadingEnabled: transparencySettings.shadingEnabled,
        setTransparency(enabled: boolean, cutoff: number) {
            transparencySettings.enabled = enabled;
            transparencySettings.cutoff = cutoff;
            obj.transparencyEnabled = enabled;
            obj.alphaCutoff = cutoff;
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, cutoff, enabled, transparencySettings.shadingEnabled);
            }
        },
        setShading(enabled: boolean) {
            transparencySettings.shadingEnabled = enabled;
            obj.shadingEnabled = enabled;
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, transparencySettings.cutoff, transparencySettings.enabled, enabled);
            }
        },
        materialMode: matKind.initial.mode,
        bandRotationX: matKind.initial.rotationX,
        bandRotationY: matKind.initial.rotationY,
        bandRotationZ: matKind.initial.rotationZ,
        bandWidth: matKind.initial.width,
        bandSoftness: matKind.initial.softness,
        bandIntensity: matKind.initial.intensity,
        setMaterialMode(mode) {
            obj.materialMode = mode;
            matKind.setMaterialMode(mode);
        },
        setBandRotation(rx, ry, rz) {
            obj.bandRotationX = rx;
            obj.bandRotationY = ry;
            obj.bandRotationZ = rz;
            matKind.setBandRotation(rx, ry, rz);
        },
        setBandWidth(w) {
            obj.bandWidth = w;
            matKind.setBandWidth(w);
        },
        setBandSoftness(s) {
            obj.bandSoftness = s;
            matKind.setBandSoftness(s);
        },
        setBandIntensity(i) {
            obj.bandIntensity = i;
            matKind.setBandIntensity(i);
        },
        setGlow(enabled) {
            matKind.setGlow(enabled);
        },
        dispose: () => {
            disposed = true;
            for (const m of imported) m.dispose();
            for (const slot of slots) slot.mat.dispose();
            for (const tex of loadedTextures.values()) tex.dispose();
            root.dispose();
        },
    };
    return obj;
}

// ── FBX object (static — geometry + materials + textures only) ───

interface FbxSubmeshDTO {
    name: string;
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
    material_index: number | null;
}

interface FbxMaterialDTO {
    name: string;
    diffuse_color: [number, number, number];
    diffuse_texture_path: string | null;
    debug_textures_seen: string[];
}

interface FbxSceneDTO {
    submeshes: FbxSubmeshDTO[];
    materials: FbxMaterialDTO[];
}

/**
 * Load a static FBX (no skinning / animation) as one studio object.
 * Skinning support is intentionally absent — see `core/mesh/fbx.rs`
 * for the scope notes. Each FBX material-part becomes a Babylon mesh
 * with its own PBR material.
 */
export async function createFbxObject(
    scene: Scene,
    diskPath: string,
): Promise<StudioObject> {
    const dto = await invoke<FbxSceneDTO>('read_fbx_static_meshes', { path: diskPath });

    const root = new TransformNode(nextId('fbx-root'), scene);
    // FBX from Blender / Maya / Max ships with the model authored
    // facing +Z (the export's "forward"), but Babylon's default
    // camera (alpha = π/2 + π/8) sits on the same +Z side looking
    // INTO the model, so the user sees the back of the head. Rotate
    // 180° around Y at load so the model faces the camera by
    // default. League SKN doesn't need this because its meshes are
    // authored facing -Z to begin with.
    root.rotation.y = Math.PI;
    const meshes: Mesh[] = [];
    const slots: StudioSlot[] = [];
    const loadedTextures = new Map<string, BaseTexture>();
    let disposed = false;

    // Materials first so submeshes can reference them by index.
    const materials: PBRMaterial[] = dto.materials.map((m, i) => {
        const mat = new PBRMaterial(`studio_fbx_mat_${nextId('m')}_${i}`, scene);
        const color = new Color3(m.diffuse_color[0], m.diffuse_color[1], m.diffuse_color[2]);
        applyHueMaterial(mat, color);
        return mat;
    });

    // Kick off the diffuse-texture loads in parallel — geometry
    // builds synchronously, textures swap in when ready. Logs each
    // outcome to the console so debugging "no texture appeared" is
    // possible without instrumenting the studio core.
    //
    // We force `hasAlpha = false` for FBX diffuse textures. League
    // SKN PNGs use the alpha channel for genuine cutouts (hair,
    // capes), but FBX models from PBR packs frequently ship PNG
    // diffuse maps whose alpha channel holds packed data (specular
    // mask, height, AO) that isn't meant as transparency. Letting
    // the material drop into ALPHATEST mode against that data
    // discards pixels at random and gives the "banded / striped"
    // breakdown the user saw. Default opaque keeps the texture
    // visible; users can flip alpha-test on per-slot later if a
    // model actually needs it.
    void Promise.allSettled(
        dto.materials.map(async (m, i) => {
            if (!m.diffuse_texture_path) {
                console.warn(
                    `[Studio FBX] material "${m.name}": no diffuse texture path resolved by Rust side.\n` +
                    'Candidates the parser saw:\n' +
                    (m.debug_textures_seen.length > 0
                        ? m.debug_textures_seen.map((s) => '  - ' + s).join('\n')
                        : '  (none — material had no texture bindings and no disk files matched the material name)'),
                );
                return;
            }
            console.log(`[Studio FBX] material "${m.name}": loading diffuse "${m.diffuse_texture_path}"`);
            const decoded = await decodeAnyTexture(scene, m.diffuse_texture_path);
            if (!decoded || disposed) {
                console.warn(`[Studio FBX] material "${m.name}": decode failed for "${m.diffuse_texture_path}"`);
                return;
            }
            loadedTextures.set(`fbx:${i}:${m.diffuse_texture_path}`, decoded.tex);
            applyTexturedMaterial(materials[i], decoded.tex, /* hasAlpha */ false, 0.2, true, false);
            console.log(`[Studio FBX] material "${m.name}": applied diffuse`);
        }),
    );

    // Geometry: one Babylon Mesh per FBX submesh-part. positions /
    // normals / uvs / indices are pre-tessellated by the Rust side.
    for (let i = 0; i < dto.submeshes.length; i++) {
        const sm = dto.submeshes[i];
        const mesh = new Mesh(sm.name || `fbx_submesh_${i}`, scene);
        const vd = new VertexData();
        vd.positions = sm.positions;
        vd.indices = sm.indices;
        if (sm.normals.length === sm.positions.length) vd.normals = sm.normals;
        if (sm.uvs.length * 3 === sm.positions.length * 2) vd.uvs = sm.uvs;
        vd.applyToMesh(mesh);
        mesh.parent = root;

        // Material assignment + slot wiring. Fallback to a neutral
        // hue when the submesh has no material reference.
        const mi = sm.material_index;
        let slotMat: PBRMaterial;
        let defaultColor: Color3;
        if (mi != null && materials[mi]) {
            slotMat = materials[mi];
            defaultColor = new Color3(
                dto.materials[mi].diffuse_color[0],
                dto.materials[mi].diffuse_color[1],
                dto.materials[mi].diffuse_color[2],
            );
        } else {
            slotMat = new PBRMaterial(`studio_fbx_orphan_${nextId('m')}`, scene);
            defaultColor = new Color3(0.7, 0.7, 0.75);
            applyHueMaterial(slotMat, defaultColor);
        }
        mesh.material = slotMat;
        meshes.push(mesh);
        slots.push({ mesh, mat: slotMat, defaultColor });
    }

    const fileName = diskPath.split(/[\\/]/).pop() ?? 'model';
    const slotOverrides: StudioSlotOverride[] = slots.map(() => ({ kind: 'none' }));

    const transparencySettings: TransparencySettings = { enabled: true, cutoff: 0.2, shadingEnabled: false };
    const matKind = createMaterialKindAPI(scene, slots);
    const obj: StudioObject = {
        id: nextId('fbx'),
        name: fileName.replace(/\.[^.]+$/i, ''),
        kind: 'fbx',
        sourcePath: diskPath,
        root,
        meshes,
        slots,
        slotOverrides,
        applyUserTexture: makeApplyUserTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        applyProceduralTexture: makeApplyProceduralTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        clearUserTexture: (i) => clearUserTexture(slots, slotOverrides, i),
        transparencyEnabled: transparencySettings.enabled,
        alphaCutoff: transparencySettings.cutoff,
        shadingEnabled: transparencySettings.shadingEnabled,
        setTransparency(enabled: boolean, cutoff: number) {
            transparencySettings.enabled = enabled;
            transparencySettings.cutoff = cutoff;
            obj.transparencyEnabled = enabled;
            obj.alphaCutoff = cutoff;
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, cutoff, enabled, transparencySettings.shadingEnabled);
            }
        },
        setShading(enabled: boolean) {
            transparencySettings.shadingEnabled = enabled;
            obj.shadingEnabled = enabled;
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, transparencySettings.cutoff, transparencySettings.enabled, enabled);
            }
        },
        materialMode: matKind.initial.mode,
        bandRotationX: matKind.initial.rotationX,
        bandRotationY: matKind.initial.rotationY,
        bandRotationZ: matKind.initial.rotationZ,
        bandWidth: matKind.initial.width,
        bandSoftness: matKind.initial.softness,
        bandIntensity: matKind.initial.intensity,
        setMaterialMode(mode) {
            obj.materialMode = mode;
            matKind.setMaterialMode(mode);
        },
        setBandRotation(rx, ry, rz) {
            obj.bandRotationX = rx;
            obj.bandRotationY = ry;
            obj.bandRotationZ = rz;
            matKind.setBandRotation(rx, ry, rz);
        },
        setBandWidth(w) {
            obj.bandWidth = w;
            matKind.setBandWidth(w);
        },
        setBandSoftness(s) {
            obj.bandSoftness = s;
            matKind.setBandSoftness(s);
        },
        setBandIntensity(i) {
            obj.bandIntensity = i;
            matKind.setBandIntensity(i);
        },
        setGlow(enabled) {
            matKind.setGlow(enabled);
        },
        dispose: () => {
            disposed = true;
            for (const m of meshes) m.dispose();
            for (const mat of materials) mat.dispose();
            for (const slot of slots) {
                if (!materials.includes(slot.mat)) slot.mat.dispose();
            }
            for (const tex of loadedTextures.values()) tex.dispose();
            root.dispose();
        },
    };
    return obj;
}

// ── Primitive object ──────────────────────────────────────────────

/**
 * Spawn a primitive (cube / plane / sphere) at the origin with a flat
 * grey PBR material. Users texture it via the mesh panel.
 */
export function createPrimitiveObject(scene: Scene, kind: PrimitiveKind): StudioObject {
    const id = nextId(kind);
    let mesh: Mesh;
    let defaultSize: number;
    if (kind === 'cube') {
        defaultSize = 100;
        mesh = CreateBox(id, { size: defaultSize }, scene);
        mesh.position.y = defaultSize / 2;
    } else if (kind === 'plane') {
        defaultSize = 200;
        mesh = CreatePlane(id, { size: defaultSize }, scene);
        mesh.rotation.x = Math.PI / 2;
    } else {
        defaultSize = 100;
        mesh = CreateSphere(id, { diameter: defaultSize }, scene);
        mesh.position.y = defaultSize / 2;
    }

    const root = new TransformNode(`${id}-root`, scene);
    // Stash the primitive's intrinsic offset on the root so the user's
    // own transform applies relative to a "standing on the floor"
    // origin. Reset the mesh's local back to zero now that the root
    // owns the offset.
    root.position.copyFrom(mesh.position);
    root.rotation.copyFrom(mesh.rotation);
    mesh.position.setAll(0);
    mesh.rotation.setAll(0);
    mesh.parent = root;

    const mat = new PBRMaterial(`studio_prim_mat_${nextId('m')}`, scene);
    const defaultColor = new Color3(0.55, 0.55, 0.6);
    applyHueMaterial(mat, defaultColor);
    mesh.material = mat;
    const slots: StudioSlot[] = [{ mesh, mat, defaultColor }];

    const loadedTextures = new Map<string, BaseTexture>();
    let disposed = false;
    const slotOverrides: StudioSlotOverride[] = slots.map(() => ({ kind: 'none' }));
    const transparencySettings: TransparencySettings = { enabled: true, cutoff: 0.2, shadingEnabled: false };
    const matKind = createMaterialKindAPI(scene, slots);

    const obj: StudioObject = {
        id,
        name: kind === 'cube' ? 'Cube' : kind === 'plane' ? 'Plane' : 'Sphere',
        kind,
        // Primitives have no sourcePath — `kind` fully reconstructs them.
        root,
        meshes: [mesh],
        slots,
        slotOverrides,
        applyUserTexture: makeApplyUserTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        applyProceduralTexture: makeApplyProceduralTexture(scene, slots, slotOverrides, loadedTextures, () => disposed, transparencySettings),
        clearUserTexture: (i) => clearUserTexture(slots, slotOverrides, i),
        transparencyEnabled: transparencySettings.enabled,
        alphaCutoff: transparencySettings.cutoff,
        shadingEnabled: transparencySettings.shadingEnabled,
        setTransparency(enabled: boolean, cutoff: number) {
            transparencySettings.enabled = enabled;
            transparencySettings.cutoff = cutoff;
            obj.transparencyEnabled = enabled;
            obj.alphaCutoff = cutoff;
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, cutoff, enabled, transparencySettings.shadingEnabled);
            }
        },
        setShading(enabled: boolean) {
            transparencySettings.shadingEnabled = enabled;
            obj.shadingEnabled = enabled;
            for (const slot of slots) {
                const last = slot.lastApplied;
                if (!last) continue;
                applyTexturedMaterial(slot.mat, last.tex, last.hasAlpha, transparencySettings.cutoff, transparencySettings.enabled, enabled);
            }
        },
        materialMode: matKind.initial.mode,
        bandRotationX: matKind.initial.rotationX,
        bandRotationY: matKind.initial.rotationY,
        bandRotationZ: matKind.initial.rotationZ,
        bandWidth: matKind.initial.width,
        bandSoftness: matKind.initial.softness,
        bandIntensity: matKind.initial.intensity,
        setMaterialMode(mode) {
            obj.materialMode = mode;
            matKind.setMaterialMode(mode);
        },
        setBandRotation(rx, ry, rz) {
            obj.bandRotationX = rx;
            obj.bandRotationY = ry;
            obj.bandRotationZ = rz;
            matKind.setBandRotation(rx, ry, rz);
        },
        setBandWidth(w) {
            obj.bandWidth = w;
            matKind.setBandWidth(w);
        },
        setBandSoftness(s) {
            obj.bandSoftness = s;
            matKind.setBandSoftness(s);
        },
        setBandIntensity(i) {
            obj.bandIntensity = i;
            matKind.setBandIntensity(i);
        },
        setGlow(enabled) {
            matKind.setGlow(enabled);
        },
        dispose: () => {
            disposed = true;
            mesh.dispose();
            mat.dispose();
            for (const tex of loadedTextures.values()) tex.dispose();
            root.dispose();
        },
    };
    return obj;
}

// ── Texture helpers (shared) ──────────────────────────────────────

/** Mutable settings shared between createSknObject's helpers and the
 *  object's setter methods — read each time a slot is (re)textured
 *  so flips take effect immediately. Carries transparency *and* the
 *  shading flag (flat / lit). The Spotlight panel writes; the
 *  material apply helpers read. */
interface RenderSettings {
    enabled: boolean;          // transparency
    cutoff: number;            // alpha cutoff
    shadingEnabled: boolean;   // false → mat.unlit = true (flat shaded)
}
type TransparencySettings = RenderSettings;

function makeApplyUserTexture(
    scene: Scene,
    slots: StudioSlot[],
    overrides: StudioSlotOverride[],
    cache: Map<string, BaseTexture>,
    isDisposed: () => boolean,
    settings: TransparencySettings,
): (slotIndex: number, diskPath: string) => Promise<boolean> {
    return async (slotIndex, diskPath) => {
        const slot = slots[slotIndex];
        if (!slot) return false;
        const decoded = await decodeAnyTexture(scene, diskPath);
        if (!decoded || isDisposed()) return false;
        cache.set(`user:${slotIndex}:${diskPath}`, decoded.tex);
        slot.lastApplied = { tex: decoded.tex, hasAlpha: decoded.hasAlpha };
        applyTexturedMaterial(slot.mat, decoded.tex, decoded.hasAlpha, settings.cutoff, settings.enabled, settings.shadingEnabled);
        overrides[slotIndex] = { kind: 'file', path: diskPath };
        return true;
    };
}

/**
 * Generate an in-memory texture from a pattern descriptor and apply
 * it to one slot. Uses Babylon's `DynamicTexture` (a 2D canvas
 * wrapper) so we can draw splits / checkers / gradients with plain
 * canvas commands and skip the file-on-disk dance. The previous
 * texture in `cache` for this slot is replaced and disposed so
 * repeated changes don't leak GPU memory.
 */
function makeApplyProceduralTexture(
    scene: Scene,
    slots: StudioSlot[],
    overrides: StudioSlotOverride[],
    cache: Map<string, BaseTexture>,
    isDisposed: () => boolean,
    settings: TransparencySettings,
): (slotIndex: number, params: ProceduralPattern) => boolean {
    const SIZE = 256;
    return (slotIndex, params) => {
        const slot = slots[slotIndex];
        if (!slot || isDisposed()) return false;
        const key = `proc:${slotIndex}`;
        // Reuse the existing DynamicTexture when we can — repainting
        // a canvas is cheaper than allocating a new GPU texture for
        // every color tweak the user makes.
        let dyn = cache.get(key) as DynamicTexture | undefined;
        if (!dyn || dyn.getSize().width !== SIZE) {
            const old = cache.get(key);
            if (old) old.dispose();
            dyn = new DynamicTexture(`studio-proc-${slotIndex}`, { width: SIZE, height: SIZE }, scene, false);
            dyn.wrapU = Texture.CLAMP_ADDRESSMODE;
            dyn.wrapV = Texture.CLAMP_ADDRESSMODE;
            cache.set(key, dyn);
        }
        const ctx = dyn.getContext() as unknown as CanvasRenderingContext2D;
        paintPattern(ctx, SIZE, params);
        dyn.update();
        slot.lastApplied = { tex: dyn, hasAlpha: false };
        applyTexturedMaterial(slot.mat, dyn, false, settings.cutoff, settings.enabled, settings.shadingEnabled);
        overrides[slotIndex] = { kind: 'pattern', pattern: params };
        return true;
    };
}

function paintPattern(ctx: CanvasRenderingContext2D, size: number, p: ProceduralPattern): void {
    if (p.kind === 'solid') {
        ctx.fillStyle = p.colorA;
        ctx.fillRect(0, 0, size, size);
        return;
    }
    if (p.kind === 'split-h') {
        // Left half = A, right half = B.
        ctx.fillStyle = p.colorA;
        ctx.fillRect(0, 0, size / 2, size);
        ctx.fillStyle = p.colorB;
        ctx.fillRect(size / 2, 0, size / 2, size);
        return;
    }
    if (p.kind === 'split-v') {
        // Top half = A, bottom half = B.
        ctx.fillStyle = p.colorA;
        ctx.fillRect(0, 0, size, size / 2);
        ctx.fillStyle = p.colorB;
        ctx.fillRect(0, size / 2, size, size / 2);
        return;
    }
    if (p.kind === 'checker') {
        // 8×8 squares so the checker pattern reads at typical model
        // scales without becoming dense noise.
        const TILES = 8;
        const tile = size / TILES;
        for (let y = 0; y < TILES; y++) {
            for (let x = 0; x < TILES; x++) {
                ctx.fillStyle = (x + y) % 2 === 0 ? p.colorA : p.colorB;
                ctx.fillRect(x * tile, y * tile, tile, tile);
            }
        }
        return;
    }
    if (p.kind === 'gradient-h' || p.kind === 'gradient-v') {
        const horiz = p.kind === 'gradient-h';
        const grad = horiz
            ? ctx.createLinearGradient(0, 0, size, 0)
            : ctx.createLinearGradient(0, 0, 0, size);
        grad.addColorStop(0, p.colorA);
        grad.addColorStop(1, p.colorB);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        return;
    }
    if (p.kind === 'uv-test') {
        paintUvTestPattern(ctx, size);
        return;
    }
}

/**
 * UV-debug pattern. Each cell carries a distinct color + its
 * column-row coordinate, drawn so the user can read at a glance how
 * the texture lands on the mesh:
 *
 *   - If letters/numbers are mirrored → V is flipped
 *   - If letters/numbers are rotated → UV islands rotated
 *   - If one solid color stretches across the model → all verts have
 *     the same UV (or UVs are massively scaled / outside [0,1])
 *   - If the pattern wraps → UVs go outside [0,1] and the texture
 *     repeats (we use CLAMP mode, so this should not happen unless
 *     the user changed it)
 *
 * The top-left cell is bright RED with an "A1" label — provides an
 * unambiguous "this corner of the texture" marker so orientation
 * issues are obvious. The grid is 8×8 cells with rainbow-tinted
 * colors, black borders, and a thin diagonal stripe across the
 * texture from (0,0) to (1,1) that highlights any UV shearing.
 */
function paintUvTestPattern(ctx: CanvasRenderingContext2D, size: number): void {
    const TILES = 8;
    const tile = size / TILES;
    // 8 hue-stepped colors per row, value-stepped per column. Gives
    // every cell a unique shade so adjacent cells never accidentally
    // blend to the same color in mip-mapped views.
    for (let row = 0; row < TILES; row++) {
        for (let col = 0; col < TILES; col++) {
            const hue = (col * 360 / TILES) | 0;
            const lightness = 70 - row * 5; // 70 down to 35
            ctx.fillStyle = `hsl(${hue} 80% ${lightness}%)`;
            ctx.fillRect(col * tile, row * tile, tile, tile);
        }
    }
    // Diagonal stripe — visible UV shear shows up as a kinked or
    // broken-up diagonal on the rendered mesh.
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, size);
    ctx.stroke();
    // Cell borders.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 1;
    for (let i = 1; i < TILES; i++) {
        ctx.beginPath();
        ctx.moveTo(i * tile, 0);
        ctx.lineTo(i * tile, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * tile);
        ctx.lineTo(size, i * tile);
        ctx.stroke();
    }
    // Cell labels — column letter A-H, row digit 1-8. Top-left =
    // "A1" so it's easy to see which corner of the texture lands on
    // which part of the model.
    ctx.font = `bold ${Math.floor(tile * 0.45)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const COLS = 'ABCDEFGH';
    for (let row = 0; row < TILES; row++) {
        for (let col = 0; col < TILES; col++) {
            const label = `${COLS[col]}${row + 1}`;
            const cx = col * tile + tile / 2;
            const cy = row * tile + tile / 2;
            // White text with a dark outline so it reads against any
            // cell color.
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.strokeText(label, cx, cy);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, cx, cy);
        }
    }
    // Bold red corner marker on the top-left cell — the eye finds
    // this instantly when orienting against the model.
    ctx.fillStyle = '#ff1f3a';
    ctx.fillRect(0, 0, tile * 0.18, tile * 0.18);
}

function clearUserTexture(
    slots: StudioSlot[],
    overrides: StudioSlotOverride[],
    slotIndex: number,
): void {
    const slot = slots[slotIndex];
    if (!slot) return;
    applyHueMaterial(slot.mat, slot.defaultColor);
    overrides[slotIndex] = { kind: 'none' };
}

/**
 * Decode any texture format the studio supports. PNG / JPG ride the
 * webview's native image loader via Tauri's file:// proxy — fastest
 * and skips a JS-side decode. TEX / DDS go through the Rust pipeline
 * (which already understands the League container formats).
 */
export async function decodeAnyTexture(
    scene: Scene,
    diskPath: string,
): Promise<{ tex: BaseTexture; hasAlpha: boolean } | null> {
    // Always route through Rust's `decode_texture_disk` so the
    // upload pipeline is uniform regardless of source format —
    // DDS / TEX / PNG / JPG / TGA / BMP / WebP all come back as
    // top-left-origin RGBA bytes. The single `invertY = true` flip
    // at `RawTexture.CreateRGBATexture` time matches meshBuilder's
    // V-flip on SKN UVs (and is a no-op for everyone else's UVs
    // since we don't flip those). Routing PNGs through the
    // webview's `new Texture(url, ...)` instead doubled the V flip
    // for SKNs with PNG diffuse maps and produced wrong-looking
    // texture sampling on mod skins.
    try {
        const buf = await invoke<ArrayBuffer>('decode_texture_disk', { path: diskPath });
        if (buf.byteLength < TEX_HEADER_LEN) return null;
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
            true,
            true,
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        // WRAP, not CLAMP. League SKN mod authors (and most DCC tools
        // by default) leave UV islands outside the `[0, 1]` box —
        // sometimes the entire unwrap sits in `v < 0` for the
        // re-textured submeshes. CLAMP would freeze every sample on
        // those triangles to a single edge pixel of the texture, which
        // is what produced the dark banded look in the deagle / sniper.
        // WRAP tiles the texture modulo 1, matching Blender / Maya /
        // Substance default sampling behaviour.
        tex.wrapU = Texture.WRAP_ADDRESSMODE;
        tex.wrapV = Texture.WRAP_ADDRESSMODE;
        tex.hasAlpha = hasAlpha;
        return { tex, hasAlpha };
    } catch (e) {
        console.warn('[Studio] texture decode failed', diskPath, e);
        return null;
    }
}

function applyHueMaterial(mat: PBRMaterial, hue: Color3): void {
    mat.albedoTexture = null;
    mat.albedoColor = hue;
    mat.useAlphaFromAlbedoTexture = false;
    mat.transparencyMode = Material.MATERIAL_OPAQUE;
    mat.needDepthPrePass = false;
    mat.backFaceCulling = true;
    mat.metallic = 0;
    mat.roughness = 1;
    mat.environmentIntensity = 0;
    mat.directIntensity = 1.2;
    mat.twoSidedLighting = true;
}

function applyTexturedMaterial(
    mat: PBRMaterial,
    tex: BaseTexture,
    hasAlpha: boolean,
    alphaCutoff: number = 0.2,
    transparencyEnabled: boolean = true,
    shadingEnabled: boolean = false,
): void {
    // Avoid touching `albedoTexture` once it's bound to the same
    // texture object — Babylon's PBRMaterial recompiles when
    // `albedoTexture` is reassigned, and we've seen the new shader
    // come up with a stale texture binding (renders pure white)
    // when the toggle happens during a frame. Only re-set when
    // it's genuinely a different texture, and let the `unlit`
    // setter handle its own light-dirty signal on transitions.
    if (mat.albedoTexture !== tex) {
        mat.albedoTexture = tex as Texture;
    }
    mat.albedoColor = new Color3(1, 1, 1);
    mat.unlit = !shadingEnabled;
    mat.backFaceCulling = true;
    if (hasAlpha && transparencyEnabled) {
        mat.useAlphaFromAlbedoTexture = true;
        // ALPHATESTANDBLEND (cutoff + per-fragment blend) keeps
        // feathered transparency at hair / cape edges; the depth
        // pre-pass below writes the cutoff'd depth first so two
        // overlapping models don't depth-sort each other into
        // black silhouettes (the original two-models-black-head
        // issue is solved by the pre-pass, not by killing blend).
        mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
        mat.alphaCutOff = alphaCutoff;
        mat.needDepthPrePass = true;
    } else {
        mat.useAlphaFromAlbedoTexture = false;
        mat.transparencyMode = Material.MATERIAL_OPAQUE;
        mat.needDepthPrePass = false;
    }
    mat.metallic = 0;
    mat.roughness = 1;
    // Keep environment irradiance off — we don't have an environment
    // texture, and non-zero environmentIntensity makes Babylon synth
    // a bright fallback that washes the albedo to white. The hemi
    // light's `groundColor` (set scene-side) handles ambient fill.
    mat.environmentIntensity = 0;
    mat.directIntensity = shadingEnabled ? 0.85 : 1.0;
    mat.twoSidedLighting = true;
}

// ─── Band overlay material plugin ────────────────────────────────
// Injects GLSL into a PBRMaterial that adds a rotatable highlight /
// shadow band on top of the existing fragment output. The band is a
// smoothstep plateau in dot(N, D) space; we control its width, edge
// softness, intensity (positive = brighter, negative = darker), and
// direction. Sits on top of the regular PBR pipeline so the texture,
// transparency, alpha cutoff, etc. all still work — we just multiply
// the final color by a band factor.
class BandOverlayPlugin extends MaterialPluginBase {
    // Euler rotations (radians) of the band normal in *view* space,
    // applied in order Z (roll on screen) → Y (yaw) → X (pitch),
    // starting from base direction (1, 0, 0). The resulting view-
    // space normal is converted to world space each bind using the
    // active camera's basis vectors so the band stays anchored to
    // the screen as the camera orbits.
    public bandRotationX = 0;
    public bandRotationY = 0;
    public bandRotationZ = 0;
    public bandWidth = 0.35;
    public bandSoftness = 0.12;
    public bandIntensity = 0.7;
    private _enabled = false;
    private _scene: Scene;
    private static readonly _viewRight = new BVector3(1, 0, 0);
    private static readonly _viewUp = new BVector3(0, 1, 0);
    private static readonly _viewForward = new BVector3(0, 0, 1);

    constructor(material: Material) {
        // priority 200 = runs late, well after PBR's own definitions.
        super(material, 'BandOverlay', 200, { BAND_OVERLAY: false });
        this._scene = material.getScene();
    }

    get isEnabled(): boolean {
        return this._enabled;
    }
    set isEnabled(value: boolean) {
        if (this._enabled === value) return;
        this._enabled = value;
        this.markAllDefinesAsDirty();
        this._enable(this._enabled);
    }

    prepareDefines(defines: { [key: string]: boolean | number }): void {
        defines.BAND_OVERLAY = this._enabled;
    }

    getClassName(): string {
        return 'BandOverlayPlugin';
    }

    getUniforms() {
        return {
            ubo: [
                { name: 'bandDirection', size: 3, type: 'vec3' },
                { name: 'bandWidth', size: 1, type: 'float' },
                { name: 'bandSoftness', size: 1, type: 'float' },
                { name: 'bandIntensity', size: 1, type: 'float' },
            ],
            fragment: `
#ifdef BAND_OVERLAY
uniform vec3 bandDirection;
uniform float bandWidth;
uniform float bandSoftness;
uniform float bandIntensity;
#endif`,
        };
    }

    bindForSubMesh(
        uniformBuffer: { updateFloat3: (n: string, x: number, y: number, z: number) => void; updateFloat: (n: string, v: number) => void },
    ): void {
        if (!this._enabled) return;
        // View-space band normal: apply Rz, then Ry, then Rx to (1,0,0).
        const cz = Math.cos(this.bandRotationZ);
        const sz = Math.sin(this.bandRotationZ);
        const cy = Math.cos(this.bandRotationY);
        const sy = Math.sin(this.bandRotationY);
        const cx = Math.cos(this.bandRotationX);
        const sx = Math.sin(this.bandRotationX);
        const vx = cz * cy;
        const vy = sz * cx + cz * sy * sx;
        const vz = sz * sx - cz * sy * cx;
        // Convert view-space normal to world via camera basis.
        let dx = vx, dy = vy, dz = vz;
        const cam = this._scene.activeCamera;
        if (cam) {
            const right = cam.getDirection(BandOverlayPlugin._viewRight);
            const up = cam.getDirection(BandOverlayPlugin._viewUp);
            const fwd = cam.getDirection(BandOverlayPlugin._viewForward);
            dx = right.x * vx + up.x * vy + fwd.x * vz;
            dy = right.y * vx + up.y * vy + fwd.y * vz;
            dz = right.z * vx + up.z * vy + fwd.z * vz;
        }
        uniformBuffer.updateFloat3('bandDirection', dx, dy, dz);
        uniformBuffer.updateFloat('bandWidth', this.bandWidth);
        uniformBuffer.updateFloat('bandSoftness', this.bandSoftness);
        uniformBuffer.updateFloat('bandIntensity', this.bandIntensity);
    }

    getCustomCode(shaderType: 'vertex' | 'fragment'): { [key: string]: string } | null {
        if (shaderType === 'fragment') {
            return {
                // PBR provides vNormalW in the fragment shader when
                // normals are available (which they always are for our
                // skinned meshes). Multiply final color by the band
                // contribution just before output.
                CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef BAND_OVERLAY
                    vec3 nrm = normalize(vNormalW);
                    vec3 dir = normalize(bandDirection);
                    float nd = dot(nrm, dir);
                    float halfW = max(0.001, bandWidth * 0.5);
                    float soft = max(0.001, bandSoftness);
                    float band = smoothstep(-halfW - soft, -halfW, nd)
                               - smoothstep(halfW, halfW + soft, nd);
                    finalColor.rgb *= (1.0 + band * bandIntensity);
#endif
                `,
            };
        }
        return null;
    }
}

// ─── Material kind + glow API (shared across all object kinds) ───
// Each of the four constructors (skn/gltf/fbx/primitive) calls this
// once and spreads the returned methods into its StudioObject return
// block. Holds state (mode + band thresholds + glow flag) in closure
// vars and re-applies on every change. Lazy-creates the toon
// CellMaterial per slot the first time toon mode is entered.
//
// Known limitation: texture changes that happen while in toon mode
// only update the PBR mat (via `applyTexturedMaterial`); the toon
// mat keeps its prior texture. Toggling mode off and back on
// refreshes — workaround documented in the panel UI.
function createMaterialKindAPI(
    _scene: Scene,
    slots: StudioSlot[],
): {
    initial: {
        mode: 'flat' | 'toon';
        rotationX: number;
        rotationY: number;
        rotationZ: number;
        width: number;
        softness: number;
        intensity: number;
    };
    setMaterialMode: (mode: 'flat' | 'toon') => void;
    setBandRotation: (rx: number, ry: number, rz: number) => void;
    setBandWidth: (w: number) => void;
    setBandSoftness: (s: number) => void;
    setBandIntensity: (i: number) => void;
    setGlow: (enabled: boolean) => void;
} {
    let mode: 'flat' | 'toon' = 'flat';
    // Band defaults — angled up-right on screen, ~third-of-sphere
    // wide, soft edges, mild brightening.
    let bandRotationX = 0;
    let bandRotationY = 0;
    let bandRotationZ = Math.PI / 4;
    let bandWidth = 0.35;
    let bandSoftness = 0.12;
    let bandIntensity = 0.7;
    let glowOn = false;

    // Lazy-allocate one BandOverlayPlugin per slot, attached to the
    // slot's existing PBRMaterial. No material swap — the plugin
    // hooks GLSL into the existing fragment shader so the texture +
    // transparency + alpha cutoff pipeline that already works in
    // flat mode keeps working in toon mode unchanged. Plugin's
    // `isEnabled` flag toggles the band on/off via a #define.
    const slotPlugins: (BandOverlayPlugin | null)[] = slots.map(() => null);

    const ensurePlugin = (i: number): BandOverlayPlugin => {
        let p = slotPlugins[i];
        if (!p) {
            p = new BandOverlayPlugin(slots[i].mat);
            slotPlugins[i] = p;
        }
        return p;
    };

    const pushBandUniforms = (p: BandOverlayPlugin) => {
        p.bandRotationX = bandRotationX;
        p.bandRotationY = bandRotationY;
        p.bandRotationZ = bandRotationZ;
        p.bandWidth = bandWidth;
        p.bandSoftness = bandSoftness;
        p.bandIntensity = bandIntensity;
    };

    const applyMode = () => {
        for (let i = 0; i < slots.length; i++) {
            const p = ensurePlugin(i);
            pushBandUniforms(p);
            p.isEnabled = mode === 'toon';
        }
    };

    const refreshBand = () => {
        for (let i = 0; i < slots.length; i++) {
            const p = slotPlugins[i];
            if (!p) continue;
            pushBandUniforms(p);
        }
    };

    const applyGlow = () => {
        // GlowLayer is scene-level. The PBR material's `emissiveTexture`
        // + `emissiveColor` are what the bloom post-process reads. We
        // set them to the diffuse so the whole textured surface glows;
        // for a mask-driven look the user would author a mask texture
        // (future enhancement). Only the PBR mat carries emissive;
        // CellMaterial's emissive support is limited so glow shows
        // strongest in flat mode.
        for (const slot of slots) {
            const last = slot.lastApplied;
            if (glowOn && last) {
                slot.mat.emissiveTexture = last.tex as Texture;
                slot.mat.emissiveColor = new Color3(1, 1, 1);
            } else {
                slot.mat.emissiveTexture = null;
                slot.mat.emissiveColor = new Color3(0, 0, 0);
            }
        }
    };

    return {
        initial: {
            mode,
            rotationX: bandRotationX,
            rotationY: bandRotationY,
            rotationZ: bandRotationZ,
            width: bandWidth,
            softness: bandSoftness,
            intensity: bandIntensity,
        },
        setMaterialMode(next) {
            mode = next;
            applyMode();
        },
        setBandRotation(rx, ry, rz) {
            bandRotationX = rx;
            bandRotationY = ry;
            bandRotationZ = rz;
            refreshBand();
        },
        setBandWidth(w) {
            bandWidth = w;
            refreshBand();
        },
        setBandSoftness(s) {
            bandSoftness = s;
            refreshBand();
        },
        setBandIntensity(i) {
            bandIntensity = i;
            refreshBand();
        },
        setGlow(enabled) {
            glowOn = enabled;
            applyGlow();
        },
    };
}

interface SknTextureBinding {
    material: string;
    texture_path: string;
    chunk_hash_hex: string | null;
    texture_disk_path?: string | null;
}

async function applyDiskSknTextures(
    scene: Scene,
    sknPath: string,
    skn: SknDTO,
    slots: StudioSlot[],
    overrides: StudioSlotOverride[],
    cache: Map<string, BaseTexture>,
    isDisposed: () => boolean,
    settings: TransparencySettings,
): Promise<void> {
    let map: SknBindingsResponse | null;
    try {
        map = await invoke<SknBindingsResponse | null>('read_skn_textures_disk', {
            sknPath,
            // Pass submesh names so the binless / unmatched path can
            // match each submesh to its own sibling texture by name
            // (e.g. "Weapon" → `..._weapon_tx_cm.tex`) instead of
            // slapping the single folder-default on every submesh.
            submeshNames: skn.submeshes.map(s => s.name),
        });
    } catch {
        return;
    }
    if (isDisposed() || !map) return;

    const bindingByName = new Map<string, SknTextureBinding>();
    for (const b of map.bindings) bindingByName.set(b.material.toLowerCase(), b);

    const indicesByPath = new Map<string, number[]>();
    for (let i = 0; i < skn.submeshes.length; i++) {
        const name = skn.submeshes[i].name.toLowerCase();
        const b = bindingByName.get(name);
        const path = b?.texture_disk_path ?? map.default_texture_disk_path;
        if (!path) continue;
        const list = indicesByPath.get(path) ?? [];
        list.push(i);
        indicesByPath.set(path, list);
    }
    if (indicesByPath.size === 0) return;

    await Promise.allSettled(
        Array.from(indicesByPath.entries()).map(async ([path, indices]) => {
            const decoded = await decodeAnyTexture(scene, path);
            if (isDisposed() || !decoded) return;
            cache.set(path, decoded.tex);
            for (const idx of indices) {
                const slot = slots[idx];
                if (!slot) continue;
                // Don't clobber a slot the user (or a loaded scene)
                // has explicitly overridden. The auto BIN walk only
                // owns slots still in the `none` state.
                if (overrides[idx] && overrides[idx].kind !== 'none') continue;
                slot.lastApplied = { tex: decoded.tex, hasAlpha: decoded.hasAlpha };
                applyTexturedMaterial(slot.mat, decoded.tex, decoded.hasAlpha, settings.cutoff, settings.enabled, settings.shadingEnabled);
            }
        }),
    );
}

// Suppress unused locals from earlier exports — re-export so other
// modules can probe the shared decoder if they need to.
export { applyHueMaterial, applyTexturedMaterial };

// Unused-suppression: Color4 import kept for future scene-color bg
// plumbing (background panel sets `scene.clearColor` already).
void Color4; void Vector3;
