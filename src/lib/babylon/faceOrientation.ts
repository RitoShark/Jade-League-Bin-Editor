/**
 * Blender-style "Face Orientation" overlay for the Studio viewports.
 *
 * Blender paints faces whose normal points OUT blue and faces pointing IN
 * (inverted / flipped winding) red. The GPU already knows which side of a
 * triangle you're looking at via `gl_FrontFacing`, so — exactly like Blender
 * — we color front-facing fragments blue and back-facing fragments red.
 *
 * Implementation is a `MaterialPluginBase` injected into each submesh's
 * EXISTING material (same approach as the toon `BandOverlayPlugin`), so it
 * reuses the material's full vertex pipeline — skinning, morphs, everything —
 * and stays correct while an Animation Studio rig is posed or playing. No
 * material swaps, no bind-pose line overlay.
 *
 * To read like Blender the mesh must render single-pass with culling OFF (so
 * inverted faces actually show up as red instead of being culled) and a fixed
 * FRONTSIDE convention so `gl_FrontFacing` reflects the true winding. We save
 * and restore each material's `backFaceCulling` + each mesh's
 * `sideOrientation` (League meshes load DOUBLESIDE) around the overlay so it's
 * fully non-destructive.
 */

import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { Material } from '@babylonjs/core/Materials/material';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';

const PLUGIN_NAME = 'JadeFaceOrient';

class FaceOrientationPlugin extends MaterialPluginBase {
    private _enabled = false;

    constructor(material: Material) {
        // Priority 300 runs after the toon band overlay (200) so, when both
        // are active, the orientation color wins the final write.
        super(material, PLUGIN_NAME, 300, { FACEORIENT: false });
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
        defines.FACEORIENT = this._enabled;
    }

    getClassName(): string {
        return 'FaceOrientationPlugin';
    }

    getCustomCode(shaderType: 'vertex' | 'fragment'): { [key: string]: string } | null {
        if (shaderType !== 'fragment') return null;
        return {
            // `finalColor` is the vec4 the PBR/standard shader is about to
            // output (same hook the band overlay writes to). Replace it
            // outright — this is a debug view, not a tint.
            CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef FACEORIENT
                if (gl_FrontFacing) {
                    finalColor = vec4(0.11, 0.42, 1.0, 1.0);
                } else {
                    finalColor = vec4(1.0, 0.13, 0.13, 1.0);
                }
#endif
            `,
        };
    }
}

// Render state we override, saved per material / mesh so the overlay restores
// cleanly. WeakMaps so disposed meshes/materials drop out automatically.
const savedCulling = new WeakMap<Material, boolean>();
const savedSide = new WeakMap<AbstractMesh, number>();

function getOrCreatePlugin(mat: Material): FaceOrientationPlugin {
    const existing = mat.pluginManager?.getPlugin(PLUGIN_NAME) as FaceOrientationPlugin | null | undefined;
    return existing ?? new FaceOrientationPlugin(mat);
}

/**
 * Enable or disable the face-orientation overlay across a set of meshes. Safe
 * to call repeatedly; disabling restores each material/mesh to how it was.
 */
export function setFaceOrientationOverlay(meshes: AbstractMesh[], enabled: boolean): void {
    for (const mesh of meshes) {
        const mat = mesh.material as Material | null;
        if (!mat) continue;
        const plugin = getOrCreatePlugin(mat);
        const M = mesh as unknown as { sideOrientation: number };
        if (enabled) {
            if (!savedCulling.has(mat)) savedCulling.set(mat, mat.backFaceCulling);
            if (!savedSide.has(mesh)) savedSide.set(mesh, M.sideOrientation);
            // Single pass, no culling, fixed FRONTSIDE → gl_FrontFacing tells
            // outward (blue) from inverted (red), and inverted faces render
            // instead of being culled away.
            mat.backFaceCulling = false;
            M.sideOrientation = 0; // FRONTSIDE
            plugin.isEnabled = true;
        } else {
            plugin.isEnabled = false;
            if (savedCulling.has(mat)) { mat.backFaceCulling = savedCulling.get(mat)!; savedCulling.delete(mat); }
            if (savedSide.has(mesh)) { M.sideOrientation = savedSide.get(mesh)!; savedSide.delete(mesh); }
        }
    }
}
