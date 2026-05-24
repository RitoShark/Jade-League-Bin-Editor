/**
 * Photo Studio — Lighting panel.
 *
 * Scene-level appearance controls grouped in one place:
 *   - Shading toggle + intensity + direction (azimuth / elevation)
 *   - Transparency toggle + alpha cutoff
 *   - Ground shadow toggle + strength + offset (X/Z) + length
 *
 * Shading defaults off so models handed off from the Viewer come in
 * flat-shaded — matching the Extract tab / Viewer preview look. The
 * shadow is scene-level so it persists across active-object changes.
 *
 * Component name remains StudioSpotlightPanel for plumbing stability
 * (state flag `studioSpotlightOpen`, tool id `studio-spotlight`); only
 * the user-facing label is "Lighting".
 */

import { useEffect, useRef, useState } from 'react';
import { useShell } from '../shells/ShellContext';
import PortalDropdown from './PortalDropdown';
import './StudioPanels.css';

interface StudioSpotlightPanelProps {
    studioTabId: string;
}

export default function StudioSpotlightPanel({ studioTabId }: StudioSpotlightPanelProps) {
    const s = useShell();
    const [, setRevision] = useState(0);

    // Scene-level state — mirrored locally because the StudioScene
    // doesn't expose getters (the panel is the single writer). All
    // defaults match the scene's init values so the first render
    // doesn't fight whatever the engine already has.
    const [shadowOn, setShadowOn] = useState(false);
    const [shadowStrength, setShadowStrength] = useState(0.65); // 1 - darkness
    const [shadowOffsetX, setShadowOffsetX] = useState(-0.2);
    const [shadowOffsetZ, setShadowOffsetZ] = useState(-0.2);
    const [shadowLength, setShadowLength] = useState(0.3);
    const [shadowQuality, setShadowQualityLocal] = useState<'low' | 'medium' | 'high' | 'ultra'>('high');

    // Glow is scene-level (bloom post-process).
    const [glowOn, setGlowOn] = useState(false);
    const [glowIntensity, setGlowIntensity] = useState(0.8);

    // Bump rev when the scene fires events (active object change, etc.)
    useEffect(() => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) return;
        const off = scene.onChange(() => setRevision((r) => r + 1));
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [studioTabId]);

    const scene = s.getStudioScene(studioTabId);
    const model = scene?.getActiveObject() ?? null;

    // Reapply current scene-side knobs when scene mounts (initial sync).
    const syncedRef = useRef(false);
    useEffect(() => {
        if (!scene || syncedRef.current) return;
        syncedRef.current = true;
        scene.setShadowDarkness(1 - shadowStrength);
        scene.setShadowDirection(shadowOffsetX, shadowOffsetZ);
        scene.setShadowLength(shadowLength);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scene]);

    if (!scene) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel">
                <div className="mop-content">
                    <div className="mop-field-hint">No active studio scene.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel">
            <div className="mop-content studio-mesh-content">
                {/* ── Material mode (per active object) ──────── */}
                <div className="studio-mesh-transparency">
                    <div className="studio-mesh-slider-label">
                        <span className="studio-mesh-name">Material</span>
                        <PortalDropdown
                            options={[
                                { value: 'flat', label: 'Flat (unlit)' },
                                { value: 'toon', label: 'Toon (cel-shaded)' },
                            ]}
                            value={model?.materialMode ?? 'flat'}
                            disabled={!model}
                            onChange={(v) => {
                                model?.setMaterialMode(v as 'flat' | 'toon');
                                setRevision((r) => r + 1);
                            }}
                            style={{ width: 160 }}
                        />
                    </div>
                    {model?.materialMode === 'toon' && (
                        <>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Band rotation X</span>
                                    <span className="studio-mesh-slider-value">
                                        {Math.round((model.bandRotationX * 180) / Math.PI)}°
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={-Math.PI}
                                    max={Math.PI}
                                    step={0.02}
                                    value={model.bandRotationX}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        model.setBandRotation(v, model.bandRotationY, model.bandRotationZ);
                                        setRevision((r) => r + 1);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Band rotation Y</span>
                                    <span className="studio-mesh-slider-value">
                                        {Math.round((model.bandRotationY * 180) / Math.PI)}°
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={-Math.PI}
                                    max={Math.PI}
                                    step={0.02}
                                    value={model.bandRotationY}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        model.setBandRotation(model.bandRotationX, v, model.bandRotationZ);
                                        setRevision((r) => r + 1);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Band rotation Z</span>
                                    <span className="studio-mesh-slider-value">
                                        {Math.round((model.bandRotationZ * 180) / Math.PI)}°
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={-Math.PI}
                                    max={Math.PI}
                                    step={0.02}
                                    value={model.bandRotationZ}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        model.setBandRotation(model.bandRotationX, model.bandRotationY, v);
                                        setRevision((r) => r + 1);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Spacing (width)</span>
                                    <span className="studio-mesh-slider-value">
                                        {model.bandWidth.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={1.5}
                                    step={0.01}
                                    value={model.bandWidth}
                                    onChange={(e) => {
                                        model.setBandWidth(parseFloat(e.target.value));
                                        setRevision((r) => r + 1);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Edge softness</span>
                                    <span className="studio-mesh-slider-value">
                                        {model.bandSoftness.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={model.bandSoftness}
                                    onChange={(e) => {
                                        model.setBandSoftness(parseFloat(e.target.value));
                                        setRevision((r) => r + 1);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Intensity</span>
                                    <span className="studio-mesh-slider-value">
                                        {model.bandIntensity.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={-1}
                                    max={2}
                                    step={0.05}
                                    value={model.bandIntensity}
                                    onChange={(e) => {
                                        model.setBandIntensity(parseFloat(e.target.value));
                                        setRevision((r) => r + 1);
                                    }}
                                />
                            </div>
                            <p className="mop-field-hint" style={{ marginTop: 4 }}>
                                Tip: re-toggle Material → Toon after changing textures to refresh.
                            </p>
                        </>
                    )}
                </div>

                {/* ── Glow (scene-level bloom) ───────────────── */}
                <div className="studio-mesh-transparency">
                    <label className="studio-mesh-vis">
                        <input
                            type="checkbox"
                            checked={glowOn}
                            onChange={(e) => {
                                const on = e.target.checked;
                                setGlowOn(on);
                                scene.setGlowEnabled(on);
                            }}
                        />
                        <span className="studio-mesh-name">Glow (bloom)</span>
                    </label>
                    <p className="mop-field-hint" style={{ marginTop: 4 }}>
                        Adds bloom-style emissive glow to every textured material in the scene.
                    </p>
                    {glowOn && (
                        <div className="studio-mesh-slider">
                            <div className="studio-mesh-slider-label">
                                <span>Intensity</span>
                                <span className="studio-mesh-slider-value">
                                    {glowIntensity.toFixed(2)}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={3}
                                step={0.05}
                                value={glowIntensity}
                                onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    setGlowIntensity(v);
                                    scene.setGlowIntensity(v);
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* ── Transparency ───────────────────────────── */}
                <div className="studio-mesh-transparency">
                    <label className="studio-mesh-vis">
                        <input
                            type="checkbox"
                            disabled={!model}
                            checked={!!model?.transparencyEnabled}
                            onChange={(e) => {
                                model?.setTransparency(e.target.checked, model?.alphaCutoff ?? 0.2);
                                setRevision((r) => r + 1);
                            }}
                        />
                        <span className="studio-mesh-name">Transparency</span>
                    </label>
                    {model?.transparencyEnabled && (
                        <div className="studio-mesh-slider">
                            <div className="studio-mesh-slider-label">
                                <span>Alpha cutoff</span>
                                <span className="studio-mesh-slider-value">
                                    {model.alphaCutoff.toFixed(2)}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={model.alphaCutoff}
                                onChange={(e) => {
                                    model.setTransparency(
                                        model.transparencyEnabled,
                                        parseFloat(e.target.value),
                                    );
                                    setRevision((r) => r + 1);
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* ── Ground shadow ──────────────────────────── */}
                <div className="studio-mesh-transparency">
                    <label className="studio-mesh-vis">
                        <input
                            type="checkbox"
                            checked={shadowOn}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setShadowOn(enabled);
                                scene.setShadowEnabled(enabled);
                            }}
                        />
                        <span className="studio-mesh-name">Ground shadow</span>
                    </label>
                    <p className="mop-field-hint" style={{ marginTop: 4 }}>
                        Adds a soft shadow under the model without changing its lighting.
                    </p>
                    {shadowOn && (
                        <>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Quality</span>
                                    <PortalDropdown
                                        options={[
                                            { value: 'low', label: 'Low (512)' },
                                            { value: 'medium', label: 'Medium (1k)' },
                                            { value: 'high', label: 'High (2k)' },
                                            { value: 'ultra', label: 'Ultra (4k)' },
                                        ]}
                                        value={shadowQuality}
                                        onChange={(v) => {
                                            const q = v as 'low' | 'medium' | 'high' | 'ultra';
                                            setShadowQualityLocal(q);
                                            scene.setShadowQuality(q);
                                        }}
                                        style={{ width: 120 }}
                                    />
                                </div>
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Strength</span>
                                    <span className="studio-mesh-slider-value">
                                        {shadowStrength.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={shadowStrength}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        setShadowStrength(v);
                                        scene.setShadowDarkness(1 - v);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Length</span>
                                    <span className="studio-mesh-slider-value">
                                        {shadowLength.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={shadowLength}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        setShadowLength(v);
                                        scene.setShadowLength(v);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Offset X</span>
                                    <span className="studio-mesh-slider-value">
                                        {shadowOffsetX.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={-1}
                                    max={1}
                                    step={0.02}
                                    value={shadowOffsetX}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        setShadowOffsetX(v);
                                        scene.setShadowDirection(v, shadowOffsetZ);
                                    }}
                                />
                            </div>
                            <div className="studio-mesh-slider">
                                <div className="studio-mesh-slider-label">
                                    <span>Offset Z</span>
                                    <span className="studio-mesh-slider-value">
                                        {shadowOffsetZ.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={-1}
                                    max={1}
                                    step={0.02}
                                    value={shadowOffsetZ}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        setShadowOffsetZ(v);
                                        scene.setShadowDirection(shadowOffsetX, v);
                                    }}
                                />
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
