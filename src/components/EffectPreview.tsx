import { useEffect, useRef } from 'react';
import { startEffectOnCanvas, getThemeEffect } from '../lib/themeEffects';

/**
 * Live preview of a single theme effect, rendered into a small canvas over a
 * theme-colored backdrop. Reuses the exact same renderers as the live app
 * layer, so what you see here is what you get. Placeholder / none effects show
 * a caption instead of an animation.
 */
export default function EffectPreview({ effectId, bg }: { effectId: string; bg: string }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const eff = getThemeEffect(effectId);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Slightly denser than the live layer so the small box reads well.
        const handle = startEffectOnCanvas(effectId, canvas, { density: 1.8 });
        return () => handle.stop();
    }, [effectId]);

    const isPlaceholder = !!eff && !eff.implemented;
    const isNone = effectId === 'none';

    return (
        <div className="effect-preview" style={{ background: bg }}>
            <canvas ref={canvasRef} className="effect-preview-canvas" />
            {(isPlaceholder || isNone) && (
                <div className="effect-preview-empty">
                    <span className="effect-preview-empty-title">
                        {isNone ? 'No effect' : eff?.displayName}
                    </span>
                    {isPlaceholder && (
                        <span className="effect-preview-empty-sub">Placeholder — not wired up yet</span>
                    )}
                </div>
            )}
        </div>
    );
}
