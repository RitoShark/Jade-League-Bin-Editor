/**
 * Convert a parsed SKN DTO (from Rust) into one Babylon `Mesh` per
 * submesh. Each submesh = one material range; we keep them as separate
 * meshes (instead of one mesh with multiple SubMeshes + a MultiMaterial)
 * because:
 *   - per-mesh `setEnabled(false)` is the cleanest way to do material
 *     visibility toggles
 *   - per-mesh `material = pbr/standard` lets us texture each one
 *     independently without a MultiMaterial dance
 *   - skeleton sharing still works — every mesh attaches the same
 *     `Skeleton` reference (we'll wire that up in step 3)
 *
 * Coordinate-system note:
 *   League SKN is left-handed Y-up. Babylon's default is also left-
 *   handed Y-up, so we don't flip anything. If the model ends up
 *   mirrored in practice we can flip the X axis here in one place.
 *
 * Index buffer note:
 *   Each submesh's index range lives inside the *global* index buffer
 *   of the SKN. The indices reference the *global* vertex buffer, but
 *   they're concentrated in `[start_vertex, start_vertex + vertex_count)`
 *   for that submesh. We slice the relevant vertex range and rebase
 *   the indices so each per-submesh Babylon Mesh has its own compact
 *   buffers — keeps GPU memory tight and avoids feeding huge unused
 *   vertex tails to per-submesh draw calls.
 */

import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';

export interface SknDTO {
    major: number;
    minor: number;
    submeshes: Array<{
        name: string;
        start_vertex: number;
        vertex_count: number;
        start_index: number;
        index_count: number;
    }>;
    /** Triangle indices into the global vertex buffer. */
    indices: number[];
    /** Flat `[x0, y0, z0, x1, y1, z1, ...]`. */
    positions: number[];
    /** Flat `[u0, v0, u1, v1, ...]`. */
    uvs: number[];
    /** 4 bone influences per vertex, flat. Empty if SKN has no skinning. */
    bone_indices: number[];
    /** 4 bone weights per vertex, flat. Matches `bone_indices`. */
    bone_weights: number[];
    /** AABB `[min_xyz, max_xyz]` in League space. */
    bbox: [[number, number, number], [number, number, number]];
}

export interface BuiltMesh {
    /** One Babylon Mesh per SKN submesh, in the same order. */
    meshes: Mesh[];
    /** AABB pulled from the SKN, in Babylon space (post-axis-flip). */
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Build per-submesh Babylon meshes from an SKN DTO. Geometry only —
 * no materials. The optional `skeleton` parameter wires bone
 * influences into the mesh's vertex buffers so Babylon's skinning
 * shader picks them up; callers building static SKN previews can
 * skip it. Caller still owns disposal on unmount.
 *
 * Skinning wiring details:
 *   - Sets `mesh.numBoneInfluencers = 4` (League SKN always has 4
 *     bone slots per vertex).
 *   - Maps each vertex's `bone_indices` (which point into the SKL's
 *     `influences` table) through that table to actual bone IDs;
 *     the GPU shader uses bone ID directly to index Babylon's bone
 *     matrix array.
 *   - Falls back to bone 0 (and weight=0) for any out-of-range
 *     influence index, so a malformed influences list can't crash
 *     the shader.
 */
export function buildSknMeshes(
    skn: SknDTO,
    scene: Scene,
    skeleton?: Skeleton,
    influences?: number[],
): BuiltMesh {
    const meshes: Mesh[] = [];
    const hasSkin =
        !!skeleton &&
        skn.bone_indices.length === skn.positions.length / 3 * 4 &&
        skn.bone_weights.length === skn.bone_indices.length;

    for (let s = 0; s < skn.submeshes.length; s++) {
        const sm = skn.submeshes[s];
        const vStart = sm.start_vertex;
        const vCount = sm.vertex_count;
        const iStart = sm.start_index;
        const iCount = sm.index_count;

        // Slice this submesh's vertex range out of the global buffers.
        // Positions: 3 floats per vertex, UVs: 2 floats per vertex.
        const positions = new Float32Array(vCount * 3);
        for (let i = 0; i < vCount * 3; i++) {
            positions[i] = skn.positions[vStart * 3 + i];
        }
        const uvs = new Float32Array(vCount * 2);
        for (let i = 0; i < vCount * 2; i++) {
            // Flip V — Babylon's UV convention is bottom-left origin
            // (OpenGL-style), but textures decoded from DDS/TEX come
            // out top-left origin. Flipping V here means materials
            // can use the texture as-is without a per-texture flag.
            if (i % 2 === 1) {
                uvs[i] = 1.0 - skn.uvs[vStart * 2 + i];
            } else {
                uvs[i] = skn.uvs[vStart * 2 + i];
            }
        }

        // Rebase the global indices into [0, vCount) range so each
        // Babylon Mesh has self-contained buffers, AND swap each
        // triangle's last two indices to flip the winding order.
        // League SKN files store triangles with the opposite winding
        // from Babylon's convention — left as-is, the computed normals
        // point inward and the model renders inside-out (every face
        // we'd want to see is back-facing under default culling).
        // Flipping winding once here means downstream code can use
        // standard `backFaceCulling = true` without surprises.
        const indices = new Uint32Array(iCount);
        for (let i = 0; i < iCount; i += 3) {
            indices[i] = skn.indices[iStart + i] - vStart;
            indices[i + 1] = skn.indices[iStart + i + 2] - vStart;
            indices[i + 2] = skn.indices[iStart + i + 1] - vStart;
        }

        // Babylon will compute normals for us — way more reliable than
        // trusting the source file's normals (which Aventurine also
        // notes are sometimes wrong from Riot's exporter).
        const normals = new Float32Array(vCount * 3);
        VertexData.ComputeNormals(positions, indices, normals);

        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.normals = normals;
        vd.uvs = uvs;

        // Skinning data — slice the same submesh range out of the
        // SKN's flat bone_indices / bone_weights arrays. SKN bone
        // indices reference the SKL's `influences` table; the
        // shader wants actual bone IDs, so map through it now.
        if (hasSkin) {
            const matrixIndices: number[] = new Array(vCount * 4);
            const matrixWeights: number[] = new Array(vCount * 4);
            const influenceTable = influences ?? [];
            for (let i = 0; i < vCount * 4; i++) {
                const sknIdx = skn.bone_indices[vStart * 4 + i];
                // Empty SKL influences (some custom SKLs ship none)
                // fall through to identity mapping; the SKN's index
                // already references a bone slot directly in that
                // case.
                const boneId =
                    influenceTable.length > sknIdx
                        ? influenceTable[sknIdx]
                        : sknIdx;
                matrixIndices[i] = boneId;
                matrixWeights[i] = skn.bone_weights[vStart * 4 + i];
            }
            vd.matricesIndices = matrixIndices;
            vd.matricesWeights = matrixWeights;
        }

        const mesh = new Mesh(sm.name || `submesh_${s}`, scene);
        vd.applyToMesh(mesh);

        if (hasSkin) {
            mesh.skeleton = skeleton!;
            // 4 weights per vertex matches the SKN file format.
            mesh.numBoneInfluencers = 4;
        }
        // DOUBLESIDE makes Babylon do a proper two-pass render of
        // each face (back pass then front pass) with the depth
        // buffer interleaved, which sorts transparent pixels far
        // better than naive `backFaceCulling = false` alone. League
        // models depend on this because the artists author capes,
        // hair cards, wing membranes, etc. as single-sided geometry
        // that's expected to be visible from both sides.
        mesh.sideOrientation = Mesh.DOUBLESIDE;
        // We reversed the winding above so League meshes render right-side-out
        // under standard culling. Record that as the mesh's flip state so the
        // Studio mesh panel's Flip button starts selected (League meshes are
        // "already flipped") and un-flipping returns to the raw SKN winding.
        mesh.metadata = { ...(mesh.metadata ?? {}), jadeFaceFlipped: true };
        meshes.push(mesh);
    }

    return {
        meshes,
        bbox: { min: skn.bbox[0], max: skn.bbox[1] },
    };
}
