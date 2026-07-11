/**
 * Blender-style viewport shading toolbar for the Studio mesh panels.
 *
 * A segmented display-mode control (Wireframe / Untextured / Textured /
 * Shaded) plus independent toggles for smooth-vs-flat normals, an edge-line
 * overlay, and the blue/red face-orientation overlay. Shared by both the Photo
 * Studio and Animation Studio mesh panels so they stay in lockstep.
 */

import {
    Grid3x3 as WireIcon,
    Circle as SolidIcon,
    Image as TextureIcon,
    Sun as ShadedIcon,
    Triangle as FlatIcon,
    Spline as SmoothIcon,
    Frame as EdgesIcon,
    FlipHorizontal2 as FacesIcon,
    type LucideIcon,
} from 'lucide-react';
import type { ShadingMode } from '../lib/babylon/viewportShading';
import './StudioPanels.css';

const MODES: { id: ShadingMode; label: string; title: string; Icon: LucideIcon }[] = [
    { id: 'wireframe', label: 'Wire',    title: 'Wireframe — triangle edges only', Icon: WireIcon },
    { id: 'solid',     label: 'Solid',   title: 'Untextured — neutral clay with lighting (texture ignored)', Icon: SolidIcon },
    { id: 'textured',  label: 'Texture', title: 'Textured, flat — the albedo texture with no lighting', Icon: TextureIcon },
    { id: 'shaded',    label: 'Shaded',  title: 'Textured, shaded — the albedo texture with lighting', Icon: ShadedIcon },
];

interface Props {
    mode: ShadingMode;
    onMode: (m: ShadingMode) => void;
    flat: boolean;
    onFlat: () => void;
    edges: boolean;
    onEdges: () => void;
    faceDirs: boolean;
    onFaceDirs: () => void;
}

export default function StudioShadingToolbar({
    mode, onMode, flat, onFlat, edges, onEdges, faceDirs, onFaceDirs,
}: Props) {
    return (
        <div className="studio-shade-toolbar">
            <div className="studio-shade-group" role="tablist" aria-label="Viewport shading">
                {MODES.map(m => (
                    <button
                        key={m.id}
                        type="button"
                        role="tab"
                        aria-selected={mode === m.id}
                        className={`studio-shade-btn ${mode === m.id ? 'is-on' : ''}`}
                        onClick={() => onMode(m.id)}
                        title={m.title}
                    >
                        <m.Icon size={13} className="studio-shade-ico" />
                        <span>{m.label}</span>
                    </button>
                ))}
            </div>

            <button
                type="button"
                className={`studio-shade-btn studio-shade-standalone ${flat ? 'is-on' : ''}`}
                onClick={onFlat}
                title={flat
                    ? 'Flat shading (faceted) — click for smooth'
                    : 'Smooth shading (interpolated normals) — click for flat/faceted'}
            >
                {flat
                    ? <FlatIcon size={13} className="studio-shade-ico" />
                    : <SmoothIcon size={13} className="studio-shade-ico" />}
                <span>{flat ? 'Flat' : 'Smooth'}</span>
            </button>

            <button
                type="button"
                className={`studio-shade-btn studio-shade-standalone ${edges ? 'is-on' : ''}`}
                onClick={onEdges}
                title="Overlay every mesh edge as a line so face layout reads clearly"
            >
                <EdgesIcon size={13} className="studio-shade-ico" />
                <span>Edges</span>
            </button>

            <button
                type="button"
                className={`studio-shade-btn studio-shade-standalone ${faceDirs ? 'is-on' : ''}`}
                onClick={onFaceDirs}
                title="Blender-style face orientation: outward faces paint blue, inverted (flipped) faces red. Flip a submesh to turn its red faces blue."
            >
                <FacesIcon size={13} className="studio-shade-ico" />
                <span>Faces</span>
            </button>
        </div>
    );
}
