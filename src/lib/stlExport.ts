/**
 * Binary STL writer for Babylon meshes.
 *
 * Binary STL layout:
 *   80 bytes  header (any text, readers ignore it)
 *    4 bytes  uint32 LE  triangle count
 *   per triangle (50 bytes):
 *    12       float32 LE normal      (nx, ny, nz)
 *    12       float32 LE vertex 1    (x, y, z)
 *    12       float32 LE vertex 2    (x, y, z)
 *    12       float32 LE vertex 3    (x, y, z)
 *     2       uint16 LE  attribute   (0)
 *
 * We pick BINARY because champion meshes are ~10–40k tris and ASCII
 * bloats that to MB of text where binary fits in ~1.5 MB.
 *
 * Pose baking:
 *   Babylon stores bind-pose positions in vertex buffers and deforms
 *   them on the GPU each frame via bone matrices. To export the model
 *   in its CURRENT pose (e.g. mid-animation), we CPU-skin each vertex
 *   by blending its 4 bone matrices by their weights against the
 *   bind position. Without this the STL is always in bind pose — the
 *   classic "model lying on its back / T-posed" symptom.
 *
 * Coordinate conversion:
 *   League / Babylon are left-handed Y-up. STL is a "Z-up" format by
 *   convention — slicers / Blender / printers treat the +Z axis as
 *   "up". A model rendered fine in our viewer ends up lying flat in
 *   downstream tools. We bake a 90° rotation about +X so the Babylon
 *   Y axis becomes the exported +Z, putting the character upright.
 */

import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Matrix } from '@babylonjs/core/Maths/math.vector';

interface Triangle {
    n: [number, number, number];
    a: [number, number, number];
    b: [number, number, number];
    c: [number, number, number];
}

export interface StlExportOptions {
    /** Apply the active skeleton pose. Default true. */
    bakePose?: boolean;
    /** Rotate Y-up → Z-up so the exported model stands upright in
     *  slicers and Blender. Default true. */
    standUpright?: boolean;
}

/**
 * Build a binary STL `Uint8Array` from a set of meshes. Only visible
 * meshes (`isEnabled() && isVisible`) contribute — the user's
 * model-parts toggles are honored.
 *
 * Returns `null` when there's nothing to export (no meshes, no
 * positions, all hidden).
 */
export function buildBinaryStl(
    meshes: AbstractMesh[],
    headerText = 'Jade STL export',
    options: StlExportOptions = {},
): Uint8Array | null {
    const { bakePose = true, standUpright = true } = options;
    const triangles: Triangle[] = [];

    // Re-used scratch vectors. Avoids per-vertex GC pressure on big
    // 30k+ tri models.
    const local = new Vector3();
    const skinned = new Vector3();
    const worldPos = new Vector3();
    const oriented = new Vector3();

    for (const mesh of meshes) {
        if (!mesh.isEnabled() || !mesh.isVisible) continue;

        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        const indices = mesh.getIndices();
        if (!positions || !indices) continue;

        const world = mesh.computeWorldMatrix(true);

        // Pose-bake path: pull the current bone matrices off the skeleton
        // + the per-vertex skinning data, then blend.
        const skel = mesh.skeleton;
        const matricesIndices = bakePose
            ? mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)
            : null;
        const matricesWeights = bakePose
            ? mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)
            : null;
        const boneMatrices =
            bakePose && skel && matricesIndices && matricesWeights
                ? skel.getTransformMatrices(mesh)
                : null;

        // Pre-compute a 16-float "world * (Y-up → Z-up) * (LH → RH)"
        // matrix when `standUpright` is on. The LH→RH conversion is
        // an X-axis mirror — without it the exported model appears
        // flipped sideways in slicers/Blender (which both default to
        // a right-handed coordinate system). We compensate the mirror
        // by swapping triangle winding below, otherwise every face
        // would point the wrong way after the flip.
        const finalWorld = standUpright
            ? Matrix.Scaling(-1, 1, 1)
                  .multiply(Matrix.RotationX(Math.PI / 2))
                  .multiply(world)
            : world;

        const xform = (i: number): [number, number, number] => {
            // Bind-pose local position.
            local.set(
                positions[i * 3],
                positions[i * 3 + 1],
                positions[i * 3 + 2],
            );

            // CPU skin: blend 4 bone matrices by weight.
            if (boneMatrices && matricesIndices && matricesWeights) {
                skinned.set(0, 0, 0);
                let weightSum = 0;
                for (let k = 0; k < 4; k++) {
                    const w = matricesWeights[i * 4 + k];
                    if (w <= 0) continue;
                    const boneIdx = matricesIndices[i * 4 + k];
                    const matStart = boneIdx * 16;
                    // Inline Vector3.TransformCoordinates against the
                    // bone matrix to avoid building a temporary Matrix
                    // object 30k times.
                    const x =
                        local.x * boneMatrices[matStart + 0] +
                        local.y * boneMatrices[matStart + 4] +
                        local.z * boneMatrices[matStart + 8] +
                        boneMatrices[matStart + 12];
                    const y =
                        local.x * boneMatrices[matStart + 1] +
                        local.y * boneMatrices[matStart + 5] +
                        local.z * boneMatrices[matStart + 9] +
                        boneMatrices[matStart + 13];
                    const z =
                        local.x * boneMatrices[matStart + 2] +
                        local.y * boneMatrices[matStart + 6] +
                        local.z * boneMatrices[matStart + 10] +
                        boneMatrices[matStart + 14];
                    skinned.x += x * w;
                    skinned.y += y * w;
                    skinned.z += z * w;
                    weightSum += w;
                }
                // Normalize when weights don't sum to 1 (rare but
                // possible — Riot ships some meshes with sloppy
                // weights). Fall back to bind pose if weights are zero.
                if (weightSum > 0 && Math.abs(weightSum - 1) > 1e-4) {
                    skinned.scaleInPlace(1 / weightSum);
                }
                if (weightSum === 0) skinned.copyFrom(local);
                worldPos.copyFrom(skinned);
            } else {
                worldPos.copyFrom(local);
            }

            // World transform + (optional) standing rotation.
            Vector3.TransformCoordinatesToRef(worldPos, finalWorld, oriented);
            return [oriented.x, oriented.y, oriented.z];
        };

        // The LH→RH mirror inverts triangle winding, so without
        // swapping verts the normals point inward and slicers see the
        // model as inside-out. Swap b/c when standUpright is on so
        // exported triangles are CCW under the right-handed convention.
        const swap = standUpright;
        for (let t = 0; t < indices.length; t += 3) {
            const a = xform(indices[t]);
            const b = xform(indices[t + 1]);
            const c = xform(indices[t + 2]);
            if (swap) {
                const n = faceNormal(a, c, b);
                triangles.push({ n, a, b: c, c: b });
            } else {
                const n = faceNormal(a, b, c);
                triangles.push({ n, a, b, c });
            }
        }
    }

    if (triangles.length === 0) return null;

    const buffer = new ArrayBuffer(84 + triangles.length * 50);
    const view = new DataView(buffer);

    const hdr = new Uint8Array(buffer, 0, 80);
    const enc = new TextEncoder().encode(headerText.slice(0, 80));
    hdr.set(enc);

    view.setUint32(80, triangles.length, true);

    let offset = 84;
    for (const t of triangles) {
        view.setFloat32(offset, t.n[0], true);
        view.setFloat32(offset + 4, t.n[1], true);
        view.setFloat32(offset + 8, t.n[2], true);
        view.setFloat32(offset + 12, t.a[0], true);
        view.setFloat32(offset + 16, t.a[1], true);
        view.setFloat32(offset + 20, t.a[2], true);
        view.setFloat32(offset + 24, t.b[0], true);
        view.setFloat32(offset + 28, t.b[1], true);
        view.setFloat32(offset + 32, t.b[2], true);
        view.setFloat32(offset + 36, t.c[0], true);
        view.setFloat32(offset + 40, t.c[1], true);
        view.setFloat32(offset + 44, t.c[2], true);
        view.setUint16(offset + 48, 0, true);
        offset += 50;
    }

    return new Uint8Array(buffer);
}

/** Right-hand-rule normal from three CCW vertices. */
function faceNormal(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
): [number, number, number] {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len === 0) return [0, 0, 0];
    return [nx / len, ny / len, nz / len];
}
