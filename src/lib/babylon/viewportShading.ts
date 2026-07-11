/**
 * Blender-style viewport shading for the Studio viewports.
 *
 * Four mutually-exclusive display modes (like Blender's viewport shading
 * header) plus an independent smooth/flat normal toggle and an edges overlay:
 *
 *   - `wireframe` — triangle edges only (Material.wireframe).
 *   - `solid`     — untextured neutral "clay" with lighting. The texture is
 *                   ignored IN-SHADER (surfaceAlbedo override) so async
 *                   texture loads / slot overrides can't fight it.
 *   - `textured`  — the albedo texture, no lighting (Material.unlit).
 *   - `shaded`    — the albedo texture WITH lighting.
 *
 *   - flat vs smooth — recompute a per-fragment face normal from screen-space
 *                      derivatives (flat) or keep the interpolated vertex
 *                      normal (smooth). Only affects the lit modes.
 *   - edges overlay  — a black wireframe CLONE of each mesh, drawn over whatever
 *                      mode is active so face layout reads clearly. The clone
 *                      shares the source mesh's geometry AND skeleton, so it's
 *                      GPU-skinned by the same bones and follows the animation.
 *                      (Babylon's built-in EdgesRenderer bakes bind-pose line
 *                      positions once and its line shader isn't skinned, so its
 *                      edges freeze in bind pose during animation — no good for
 *                      an animation studio.)
 *
 * The solid-clay + flat-normal bits ride on a `MaterialPluginBase` injected
 * into the existing PBR material (same technique as the toon band overlay and
 * the face-orientation overlay), so skinning / morphs stay correct and nothing
 * about the material is destroyed.
 */

import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { Material } from '@babylonjs/core/Materials/material';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { Node } from '@babylonjs/core/node';
import type { Observer } from '@babylonjs/core/Misc/observable';

export type ShadingMode = 'wireframe' | 'solid' | 'textured' | 'shaded';

/** The full viewport-shading choice (display mode + smooth/flat + the two
 *  overlays). Persisted per studio so it survives tab switches AND app
 *  restarts. */
export interface ShadePref {
    mode: ShadingMode;
    flat: boolean;
    edges: boolean;
    faceDirs: boolean;
}

const SHADE_PREF_DEFAULT: ShadePref = { mode: 'textured', flat: false, edges: false, faceDirs: false };

/** Load the saved shading preference for a studio (`'photo'` | `'anim'`).
 *  Each studio keeps its own so they don't fight over one setting. */
export function loadShadePref(studio: string): ShadePref {
    try {
        const raw = window.localStorage.getItem(`studio-shade-${studio}`);
        if (raw) return { ...SHADE_PREF_DEFAULT, ...JSON.parse(raw) };
    } catch { /* ignore unavailable / corrupt storage */ }
    return { ...SHADE_PREF_DEFAULT };
}

/** Persist the shading preference for a studio. */
export function saveShadePref(studio: string, pref: ShadePref): void {
    try { window.localStorage.setItem(`studio-shade-${studio}`, JSON.stringify(pref)); } catch { /* ignore */ }
}

const PLUGIN_NAME = 'JadeViewportShade';

class ViewportShadePlugin extends MaterialPluginBase {
    private _enabled = false;
    private _solid = false;
    private _flat = false;

    constructor(material: Material) {
        // Priority 250: after the toon band overlay (200), before the
        // face-orientation overlay (300) which fully replaces the color.
        super(material, PLUGIN_NAME, 250, { VP_SOLID: false, VP_FLAT: false });
    }

    get isEnabled(): boolean { return this._enabled; }
    set isEnabled(value: boolean) {
        if (this._enabled === value) return;
        this._enabled = value;
        this.markAllDefinesAsDirty();
        this._enable(this._enabled);
    }

    get solid(): boolean { return this._solid; }
    get flat(): boolean { return this._flat; }
    setModes(solid: boolean, flat: boolean): void {
        if (this._solid === solid && this._flat === flat) return;
        this._solid = solid;
        this._flat = flat;
        this.markAllDefinesAsDirty();
    }

    prepareDefines(defines: { [key: string]: boolean | number }): void {
        defines.VP_SOLID = this._enabled && this._solid;
        defines.VP_FLAT = this._enabled && this._flat;
    }

    getClassName(): string { return 'ViewportShadePlugin'; }

    getCustomCode(shaderType: 'vertex' | 'fragment'): { [key: string]: string } | null {
        if (shaderType !== 'fragment') return null;
        return {
            // Runs after normalW / surfaceAlbedo are computed but before the
            // lighting loop, so overriding them here recolors + reshades the
            // lit result. WebGL2 (GLSL ES 3.0) has dFdx/dFdy built-in.
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
#ifdef VP_FLAT
                vec3 vpFlatN = normalize(cross(dFdx(vPositionW), dFdy(vPositionW)));
                if (dot(vpFlatN, normalW) < 0.0) { vpFlatN = -vpFlatN; }
                normalW = vpFlatN;
#endif
#ifdef VP_SOLID
                surfaceAlbedo = vec3(0.62, 0.62, 0.66);
#endif
            `,
        };
    }
}

/** Get-or-create the plugin, but only for PBR materials — the injected code
 *  references PBR-only fragment variables (`surfaceAlbedo`, `normalW`). */
function pluginFor(mat: Material): ViewportShadePlugin | null {
    if (typeof mat.getClassName === 'function' && mat.getClassName() !== 'PBRMaterial') return null;
    const existing = mat.pluginManager?.getPlugin(PLUGIN_NAME) as ViewportShadePlugin | null | undefined;
    return existing ?? new ViewportShadePlugin(mat);
}

interface ShadeMat extends Material { wireframe: boolean; unlit?: boolean; }

/** Apply a viewport shading mode (+ flat/smooth) to a set of meshes. */
export function applyShadingMode(meshes: AbstractMesh[], mode: ShadingMode, flat: boolean): void {
    const lit = mode === 'solid' || mode === 'shaded';
    for (const mesh of meshes) {
        const mat = mesh.material as ShadeMat | null;
        if (!mat) continue;
        mat.wireframe = mode === 'wireframe';
        if ('unlit' in mat) mat.unlit = !lit;
        const plugin = pluginFor(mat);
        if (plugin) {
            plugin.setModes(mode === 'solid', flat && lit);
            plugin.isEnabled = mode === 'solid' || (flat && lit);
        }
    }
}

/** Source mesh → its wireframe overlay clone (+ the dispose observer that
 *  cleans the clone up if the source is disposed out from under us, e.g. a
 *  rig swap). Keyed weakly so a disposed source mesh drops out. */
const edgeOverlays = new WeakMap<AbstractMesh, { overlay: Mesh; obs: Observer<Node> | null }>();

/** One shared black wireframe material per scene. StandardMaterial skins
 *  automatically from the clone's skeleton + bone vertex buffers, so the
 *  wireframe deforms with the animation. `zOffset` nudges the lines toward
 *  the camera so they sit on top of the fill instead of z-fighting it. */
const wireMatByScene = new WeakMap<Scene, StandardMaterial>();
function edgeWireMaterial(scene: Scene): StandardMaterial {
    const cached = wireMatByScene.get(scene);
    if (cached) return cached;
    const m = new StandardMaterial('__jade_edge_wire__', scene);
    m.wireframe = true;
    m.disableLighting = true;
    m.emissiveColor = new Color3(0, 0, 0);
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    m.backFaceCulling = false;
    m.zOffset = -1;
    wireMatByScene.set(scene, m);
    return m;
}

/** Turn the skinned wireframe overlay on/off across a set of meshes. */
export function setEdgesOverlay(meshes: AbstractMesh[], enabled: boolean): void {
    for (const mesh of meshes) {
        if (enabled) {
            if (edgeOverlays.has(mesh)) continue;
            const src = mesh as Mesh;
            if (typeof src.clone !== 'function') continue;
            // doNotCloneChildren=true; the clone shares geometry (cheap) and
            // gets skeleton = src.skeleton, so it's skinned by the same bones.
            const overlay = src.clone(`${src.name}__edges`, src.parent ?? null, true) as Mesh | null;
            if (!overlay) continue;
            overlay.material = edgeWireMaterial(src.getScene());
            overlay.skeleton = src.skeleton;
            overlay.isPickable = false;
            overlay.isVisible = src.isVisible;
            overlay.receiveShadows = false;
            // Skinning can push the pose outside the bind-pose bounds; keep the
            // clone active so it isn't frustum-culled mid-swing.
            overlay.alwaysSelectAsActiveMesh = true;
            const obs = src.onDisposeObservable.add(() => {
                const rec = edgeOverlays.get(mesh);
                if (rec) { rec.overlay.dispose(); edgeOverlays.delete(mesh); }
            });
            edgeOverlays.set(mesh, { overlay, obs });
        } else {
            const rec = edgeOverlays.get(mesh);
            if (rec) {
                if (rec.obs) mesh.onDisposeObservable.remove(rec.obs);
                rec.overlay.dispose();
                edgeOverlays.delete(mesh);
            }
        }
    }
}

/** Read the current shading state off the first material-bearing mesh so a
 *  freshly-mounted panel reflects reality instead of a guessed default. */
export function readShadingState(meshes: AbstractMesh[]): { mode: ShadingMode; flat: boolean; edges: boolean } {
    const mesh = meshes.find(m => m.material);
    const mat = mesh?.material as ShadeMat | null | undefined;
    let mode: ShadingMode = 'textured';
    let flat = false;
    if (mat) {
        if (mat.wireframe) {
            mode = 'wireframe';
        } else {
            const plugin = mat.pluginManager?.getPlugin(PLUGIN_NAME) as ViewportShadePlugin | null | undefined;
            if (plugin?.solid) mode = 'solid';
            else if (mat.unlit) mode = 'textured';
            else mode = 'shaded';
            flat = !!plugin?.flat;
        }
    }
    const edges = meshes.some(m => edgeOverlays.has(m));
    return { mode, flat, edges };
}
