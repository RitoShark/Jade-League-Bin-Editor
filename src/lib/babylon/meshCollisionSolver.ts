/**
 * Mesh collision for the physics bake — the "Maya way".
 *
 * Instead of approximating the body with spheres/capsules, this collides
 * hair/cloth particles against an actual (low-poly) collision mesh, the way
 * Maya's Nucleus collides against a passive collider with a thickness shell.
 *
 * The collision mesh is SKINNED by the same rig, so it deforms with the
 * animation. Per frame we:
 *   1. Linear-blend-skin every collider vertex to the current animated pose
 *      (`updateSkinnedCollider`).
 *   2. Bin the skinned triangles (AABBs expanded by `thickness`) into a
 *      uniform grid so a particle only tests nearby triangles.
 *   3. Push any particle within `thickness` of the surface back out to the
 *      shell (`pushOutOfMesh`), using the single closest triangle so edges
 *      don't fight.
 *
 * Everything is allocation-light and pure so the physics bake can call it in
 * its inner loop. Skinning uses the same rigid (rot+pos) per-joint transforms
 * the solver already composes — no matrices, no Babylon types.
 */

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** Immutable bind-pose data for a collision mesh, built once from the rig's
 *  submeshes. Positions are in skeleton (bind) space; bone indices are joint
 *  indices (aligned with the solver's `joints` array). */
export interface MeshColliderBind {
    vBind: Float32Array;    // 3 per vertex — bind position
    boneIdx: Int32Array;    // 4 per vertex — joint indices (-1 = unused)
    weight: Float32Array;   // 4 per vertex — skin weights
    indices: Uint32Array;   // 3 per triangle
    vertexCount: number;
    triCount: number;
    thickness: number;      // collision shell radius (world units)
}

/** Mutable per-frame state: the skinned vertex positions + the spatial grid
 *  over the current frame's triangles. */
export interface SkinnedCollider {
    bind: MeshColliderBind;
    skinned: Float32Array;  // 3 per vertex — updated each frame
    // Uniform grid.
    grid: Map<number, number[]>;
    minX: number; minY: number; minZ: number;
    invCell: number;        // 1 / cell size
    nx: number; ny: number; nz: number;
}

export function makeSkinnedCollider(bind: MeshColliderBind): SkinnedCollider {
    return {
        bind,
        skinned: new Float32Array(bind.vertexCount * 3),
        grid: new Map(),
        minX: 0, minY: 0, minZ: 0,
        invCell: 1,
        nx: 1, ny: 1, nz: 1,
    };
}

// ── quaternion helpers (kept local so this module has no Babylon deps) ──
function qMul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}
function qConj(q: Quat): Quat { return [-q[0], -q[1], -q[2], q[3]]; }
function qRot(q: Quat, vx: number, vy: number, vz: number, out: Vec3): void {
    const [x, y, z, w] = q;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    out[0] = vx + w * tx + (y * tz - z * ty);
    out[1] = vy + w * ty + (z * tx - x * tz);
    out[2] = vz + w * tz + (x * ty - y * tx);
}

/**
 * Skin the collider to the current animated pose and rebuild the grid.
 *
 * @param animRot / animPos - per-joint animated world rotation/position for
 *   this frame (the arrays the solver composes in `composeWorld`).
 * @param bindRot / bindPos - per-joint bind-pose world rotation/position
 *   (constant; computed once by the caller).
 */
export function updateSkinnedCollider(
    sc: SkinnedCollider,
    animRot: Quat[], animPos: Vec3[],
    bindRot: Quat[], bindPos: Vec3[],
): void {
    const { bind, skinned } = sc;
    const nj = animRot.length;
    // Per-joint skinning transform M = animWorld · bindWorld⁻¹ (rigid).
    const mRot: Quat[] = new Array(nj);
    const mPos: Vec3[] = new Array(nj);
    const tmp: Vec3 = [0, 0, 0];
    for (let b = 0; b < nj; b++) {
        const r = qMul(animRot[b], qConj(bindRot[b]));
        mRot[b] = r;
        qRot(r, bindPos[b][0], bindPos[b][1], bindPos[b][2], tmp);
        mPos[b] = [animPos[b][0] - tmp[0], animPos[b][1] - tmp[1], animPos[b][2] - tmp[2]];
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < bind.vertexCount; v++) {
        const bx = bind.vBind[v * 3], by = bind.vBind[v * 3 + 1], bz = bind.vBind[v * 3 + 2];
        let sx = 0, sy = 0, sz = 0, wsum = 0;
        for (let k = 0; k < 4; k++) {
            const b = bind.boneIdx[v * 4 + k];
            const w = bind.weight[v * 4 + k];
            if (b < 0 || b >= nj || w <= 0) continue;
            qRot(mRot[b], bx, by, bz, tmp);
            sx += w * (tmp[0] + mPos[b][0]);
            sy += w * (tmp[1] + mPos[b][1]);
            sz += w * (tmp[2] + mPos[b][2]);
            wsum += w;
        }
        if (wsum > 1e-6 && wsum < 0.999) { const inv = 1 / wsum; sx *= inv; sy *= inv; sz *= inv; }
        skinned[v * 3] = sx; skinned[v * 3 + 1] = sy; skinned[v * 3 + 2] = sz;
        if (sx < minX) minX = sx; if (sy < minY) minY = sy; if (sz < minZ) minZ = sz;
        if (sx > maxX) maxX = sx; if (sy > maxY) maxY = sy; if (sz > maxZ) maxZ = sz;
    }

    // Grid sized to ~ the cube root of the triangle count per axis so cells
    // hold a handful of triangles each. Cell size never smaller than the
    // thickness so a particle's own cell already covers the query radius.
    const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
    const dim = Math.min(48, Math.max(4, Math.round(Math.cbrt(bind.triCount))));
    const cell = Math.max(ext / dim, bind.thickness * 2, 1e-4);
    sc.minX = minX; sc.minY = minY; sc.minZ = minZ;
    sc.invCell = 1 / cell;
    sc.nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    sc.ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    sc.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);

    const grid = sc.grid;
    grid.clear();
    const th = bind.thickness;
    for (let t = 0; t < bind.triCount; t++) {
        const i0 = bind.indices[t * 3], i1 = bind.indices[t * 3 + 1], i2 = bind.indices[t * 3 + 2];
        const ax = skinned[i0 * 3], ay = skinned[i0 * 3 + 1], az = skinned[i0 * 3 + 2];
        const bx2 = skinned[i1 * 3], by2 = skinned[i1 * 3 + 1], bz2 = skinned[i1 * 3 + 2];
        const cx = skinned[i2 * 3], cy = skinned[i2 * 3 + 1], cz = skinned[i2 * 3 + 2];
        // Triangle AABB expanded by the thickness shell.
        const loX = Math.min(ax, bx2, cx) - th, hiX = Math.max(ax, bx2, cx) + th;
        const loY = Math.min(ay, by2, cy) - th, hiY = Math.max(ay, by2, cy) + th;
        const loZ = Math.min(az, bz2, cz) - th, hiZ = Math.max(az, bz2, cz) + th;
        const cx0 = cellCoord(loX, minX, sc.invCell, sc.nx), cx1 = cellCoord(hiX, minX, sc.invCell, sc.nx);
        const cy0 = cellCoord(loY, minY, sc.invCell, sc.ny), cy1 = cellCoord(hiY, minY, sc.invCell, sc.ny);
        const cz0 = cellCoord(loZ, minZ, sc.invCell, sc.nz), cz1 = cellCoord(hiZ, minZ, sc.invCell, sc.nz);
        for (let iz = cz0; iz <= cz1; iz++) {
            for (let iy = cy0; iy <= cy1; iy++) {
                for (let ix = cx0; ix <= cx1; ix++) {
                    const key = ix + iy * sc.nx + iz * sc.nx * sc.ny;
                    const arr = grid.get(key);
                    if (arr) arr.push(t); else grid.set(key, [t]);
                }
            }
        }
    }
}

function cellCoord(v: number, min: number, invCell: number, n: number): number {
    let c = Math.floor((v - min) * invCell);
    if (c < 0) c = 0; else if (c >= n) c = n - 1;
    return c;
}

/** Push a particle out of the mesh if it sits within the thickness shell.
 *  Uses the single closest triangle so surface edges don't push in opposing
 *  directions. Mutates `p` in place. */
export function pushOutOfMesh(sc: SkinnedCollider, p: Vec3): void {
    const ix = cellCoord(p[0], sc.minX, sc.invCell, sc.nx);
    const iy = cellCoord(p[1], sc.minY, sc.invCell, sc.ny);
    const iz = cellCoord(p[2], sc.minZ, sc.invCell, sc.nz);
    const bucket = sc.grid.get(ix + iy * sc.nx + iz * sc.nx * sc.ny);
    if (!bucket) return;
    const skinned = sc.skinned;
    const { indices, thickness } = sc.bind;
    const th2 = thickness * thickness;
    let bestD2 = th2;
    let bestX = 0, bestY = 0, bestZ = 0;
    let hit = false;
    const cp: Vec3 = [0, 0, 0];
    for (let bi = 0; bi < bucket.length; bi++) {
        const t = bucket[bi];
        const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
        closestPtTriangle(
            p[0], p[1], p[2],
            skinned[i0 * 3], skinned[i0 * 3 + 1], skinned[i0 * 3 + 2],
            skinned[i1 * 3], skinned[i1 * 3 + 1], skinned[i1 * 3 + 2],
            skinned[i2 * 3], skinned[i2 * 3 + 1], skinned[i2 * 3 + 2],
            cp,
        );
        const dx = p[0] - cp[0], dy = p[1] - cp[1], dz = p[2] - cp[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestX = cp[0]; bestY = cp[1]; bestZ = cp[2]; hit = true; }
    }
    if (!hit) return;
    let nx = p[0] - bestX, ny = p[1] - bestY, nz = p[2] - bestZ;
    let d = Math.sqrt(bestD2);
    if (d < 1e-6) { nx = 0; ny = 1; nz = 0; d = 1; } // on the surface — push straight up
    const s = thickness / d;
    p[0] = bestX + nx * s;
    p[1] = bestY + ny * s;
    p[2] = bestZ + nz * s;
}

/** Closest point on triangle ABC to point P (Ericson, Real-Time Collision
 *  Detection). Writes into `out`. */
function closestPtTriangle(
    px: number, py: number, pz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    out: Vec3,
): void {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v; return;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w; return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w; return;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    out[0] = ax + abx * v + acx * w;
    out[1] = ay + aby * v + acy * w;
    out[2] = az + abz * v + acz * w;
}
