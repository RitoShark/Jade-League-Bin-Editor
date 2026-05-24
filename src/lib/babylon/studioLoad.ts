/**
 * Disk-source model loader for the Photo Studio.
 *
 * Parallel to the loading pipeline in `MeshPreview` but factored as a
 * library function rather than a component lifecycle. Loads:
 *
 *   - SKN geometry (the `.skn` the user picked)
 *   - Sibling `.skl` skeleton, if one exists next to the SKN
 *   - Skin-textures: walks the BIN tree, maps submesh → texture path,
 *     decodes each unique texture, applies to the matching submeshes
 *   - Animation listing (clip names + per-clip `.anm` disk paths)
 *
 * V1 is disk-only — WAD-sourced models inside the studio would need
 * the mount id threaded through and the studio currently has no UI
 * for picking a WAD source. Easy to add later (the underlying Tauri
 * commands already exist; mirror the `applyTextures` / `loadAnimations`
 * WAD branches in MeshPreview).
 */

import { invoke } from '@tauri-apps/api/core';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Color3 } from '@babylonjs/core/Maths/math';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import type { Bone } from '@babylonjs/core/Bones/bone';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';

import { buildSknMeshes, type SknDTO } from './meshBuilder';
import { buildBabylonSkeleton, type SklJointDTO, type SklSkeletonDTO } from './skeletonBuilder';

export interface StudioAnimClip {
    name: string;
    anm_path: string;
    anm_chunk_hash_hex: string | null;
    anm_disk_path?: string | null;
}

export interface StudioAnimListing {
    bin_path: string;
    bin_path_hash_hex: string;
    clips: StudioAnimClip[];
}

interface TextureBinding {
    material: string;
    texture_path: string;
    chunk_hash_hex: string | null;
    texture_disk_path?: string | null;
}

interface SknTextureBindings {
    bin_path: string;
    bin_path_hash_hex: string;
    default_texture: string | null;
    default_chunk_hash_hex: string | null;
    default_texture_disk_path?: string | null;
    bindings: TextureBinding[];
}

export interface LoadedStudioModel {
    /** The SKN's per-submesh Babylon meshes. */
    meshes: Mesh[];
    /** Per-submesh material slots. The mesh panel mutates `mat` to
     *  re-link textures when the BIN auto-resolution failed. */
    slots: { mat: PBRMaterial; hue: Color3 }[];
    /** Babylon skeleton if a sibling SKL was found, otherwise null. */
    skeleton: Skeleton | null;
    /** Bones in influence order, parallel to the SKL's joints array. */
    bones: Bone[];
    /** SKL joint DTOs in influence order. */
    joints: SklJointDTO[];
    /** joint_hash → influence index, used by AnimationPlayer to resolve
     *  track targets. */
    boneIndexByHash: Map<number, number>;
    /** Clips discovered from the sibling skin BIN's animationGraph. */
    animations: StudioAnimListing | null;
    /** Vertical offset applied so feet sit on the ground grid. Needed
     *  when callers want to align overlays to the shifted mesh. */
    yShift: number;
    /** Manually link a texture file from disk to one submesh. Used by
     *  the mesh panel when Jade's BIN-driven auto-resolution can't
     *  find a texture for a slot — the user picks a .tex / .dds / .png
     *  and we apply it like any other texture. */
    applyUserTexture: (submeshIndex: number, diskPath: string) => Promise<boolean>;
    /** Drop the user-applied texture for one submesh and fall back to
     *  the hue placeholder. Used when the user wants to undo a manual
     *  link they no longer want. */
    clearUserTexture: (submeshIndex: number) => void;
    /** Disposes the meshes, materials, and loaded textures. The owning
     *  scene is NOT disposed here — the studio's scene outlives every
     *  model the user might load into it. */
    dispose: () => void;
}

const TEX_HEADER_LEN = 16;
const FLAG_HAS_ALPHA = 1 << 0;

/**
 * Load an SKN (and sibling SKL + textures + animation listing) from a
 * disk path into the given scene. Returns a handle the caller keeps
 * for animation playback and disposal. Throws on SKN parse failure;
 * missing sibling SKL / texture BIN / animations are silent (those are
 * legitimate states for a stripped-down model).
 */
export async function loadDiskModel(
    scene: Scene,
    camera: ArcRotateCamera,
    sknPath: string,
): Promise<LoadedStudioModel> {
    // SKN is mandatory — without it there's nothing to render.
    const skn = await invoke<SknDTO>('read_skn_mesh', { path: sknPath });

    // Sibling SKL — best effort. Many SKNs don't ship one (props,
    // wards) and a missing/unparseable skl shouldn't fail the load.
    let sklDto: SklSkeletonDTO | null = null;
    const sklPath = sknPath.replace(/\.[^./\\]+$/i, '.skl');
    try {
        sklDto = await invoke<SklSkeletonDTO>('read_skl_skeleton', { path: sklPath });
    } catch {
        sklDto = null;
    }

    // Babylon skeleton + bones — used by AnimationPlayer to resolve
    // track targets by joint hash.
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

    // Per-submesh PBR materials with a hue placeholder — the texture
    // pipeline below will swap in real textures where the BIN resolves
    // them. Hue keeps unresolved submeshes visually distinct instead of
    // rendering them as one big checkerboard.
    const golden = 0.618033988749895;
    const slots: { mat: PBRMaterial; hue: Color3 }[] = [];
    for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i];
        const mat = new PBRMaterial(`studio_mat_${i}`, scene);
        const hue = Color3.FromHSV(((i * golden) % 1) * 360, 0.5, 0.85);
        mat.unlit = true;
        applyHueMaterial(mat, hue);
        m.material = mat;
        slots.push({ mat, hue });
    }

    // Frame the camera around the actual Babylon-computed bounds.
    // Some League SKNs ship junk file-header AABBs so we re-derive.
    const yShift = frameCameraAroundMeshes(camera, meshes);

    // Texture pipeline + animation listing — both fire-and-forget. The
    // returned `LoadedStudioModel` resolves once the synchronous parts
    // are done; textures and the animation listing populate in the
    // background.
    const loadedTextures = new Map<string, { tex: RawTexture; hasAlpha: boolean }>();
    let disposed = false;
    void applyDiskTextures(scene, sknPath, skn, slots, loadedTextures, () => disposed);

    let animations: StudioAnimListing | null = null;
    try {
        animations = await invoke<StudioAnimListing | null>('read_skn_animations_disk_cmd', {
            sknPath,
        });
    } catch {
        animations = null;
    }

    const applyUserTexture = async (submeshIndex: number, diskPath: string): Promise<boolean> => {
        const slot = slots[submeshIndex];
        if (!slot) return false;
        const decoded = await loadTextureFromDisk(diskPath, scene);
        if (!decoded || disposed) return false;
        loadedTextures.set(`user:${submeshIndex}:${diskPath}`, decoded);
        applyTexturedMaterial(slot.mat, decoded.tex, decoded.hasAlpha);
        return true;
    };

    const clearUserTexture = (submeshIndex: number): void => {
        const slot = slots[submeshIndex];
        if (!slot) return;
        applyHueMaterial(slot.mat, slot.hue);
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const m of meshes) m.dispose();
        for (const { mat } of slots) mat.dispose();
        for (const { tex } of loadedTextures.values()) tex.dispose();
        if (skeleton) skeleton.dispose();
    };

    return {
        meshes,
        slots,
        skeleton,
        bones,
        joints: sklDto?.joints ?? [],
        boneIndexByHash,
        animations,
        yShift,
        applyUserTexture,
        clearUserTexture,
        dispose,
    };
}

/**
 * Fetch a baked animation by path and return the DTO. Caller is
 * responsible for constructing an AnimationPlayer with it. The DTO is
 * cheap to discard if the user picks a different clip mid-flight.
 */
export async function loadDiskAnimation(anmPath: string) {
    return invoke<import('./animationPlayer').BakedAnimationDTO>('read_animation', {
        path: anmPath,
    });
}

// ── Internals ────────────────────────────────────────────────────────

function frameCameraAroundMeshes(camera: ArcRotateCamera, meshes: Mesh[]): number {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const m of meshes) {
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
    const finite = (n: number) => Number.isFinite(n) ? n : 0;
    minX = finite(minX); minY = finite(minY); minZ = finite(minZ);
    maxX = finite(maxX); maxY = finite(maxY); maxZ = finite(maxZ);

    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;

    const yShift = minY < 0 ? -minY : 0;
    if (yShift !== 0) {
        for (const m of meshes) m.position.y = yShift;
    }

    const target = new Vector3(
        (minX + maxX) / 2,
        (minY + maxY) / 2 + yShift,
        (minZ + maxZ) / 2,
    );
    // Y-weighted framing — see MeshPreview's frameCamera for the
    // rationale. Tall+winged characters break a flat max() because
    // their height occupies the vertical extent while width shares the
    // horizontal with depth.
    const radius = Math.max(sizeY * 1.4, sizeX, sizeZ) || 5;

    camera.setTarget(target);
    camera.alpha = Math.PI / 2 + Math.PI / 8;
    camera.beta = Math.PI / 2 - Math.PI / 8;
    camera.radius = radius;
    camera.lowerRadiusLimit = radius * 0.1;
    camera.upperRadiusLimit = radius * 8;
    return yShift;
}

async function applyDiskTextures(
    scene: Scene,
    sknPath: string,
    skn: SknDTO,
    slots: { mat: PBRMaterial }[],
    cache: Map<string, { tex: RawTexture; hasAlpha: boolean }>,
    isCancelled: () => boolean,
): Promise<void> {
    let map: SknTextureBindings | null;
    try {
        map = await invoke<SknTextureBindings | null>('read_skn_textures_disk', {
            sknPath,
        });
    } catch {
        return;
    }
    if (isCancelled() || !map) return;

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
        const list = indicesByPath.get(path) ?? [];
        list.push(i);
        indicesByPath.set(path, list);
    }
    if (indicesByPath.size === 0) return;

    await Promise.allSettled(
        Array.from(indicesByPath.entries()).map(async ([path, indices]) => {
            const decoded = await loadTextureFromDisk(path, scene);
            if (isCancelled() || !decoded) return;
            cache.set(path, decoded);
            for (const idx of indices) {
                const slot = slots[idx];
                if (slot) applyTexturedMaterial(slot.mat, decoded.tex, decoded.hasAlpha);
            }
        }),
    );
}

async function loadTextureFromDisk(
    diskPath: string,
    scene: Scene,
): Promise<{ tex: RawTexture; hasAlpha: boolean } | null> {
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
            /* generateMipMaps */ true,
            /* invertY */ true,
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;
        tex.hasAlpha = hasAlpha;
        return { tex, hasAlpha };
    } catch {
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

function applyTexturedMaterial(mat: PBRMaterial, tex: RawTexture, hasAlpha: boolean): void {
    mat.albedoTexture = tex;
    mat.albedoColor = new Color3(1, 1, 1);
    mat.backFaceCulling = true;
    if (hasAlpha) {
        mat.useAlphaFromAlbedoTexture = true;
        mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
        mat.alphaCutOff = 0.2;
        mat.needDepthPrePass = true;
    } else {
        mat.useAlphaFromAlbedoTexture = false;
        mat.transparencyMode = Material.MATERIAL_OPAQUE;
        mat.needDepthPrePass = false;
    }
    mat.metallic = 0;
    mat.roughness = 1;
    mat.environmentIntensity = 0;
    mat.directIntensity = 1.2;
    mat.twoSidedLighting = true;
}
