/**
 * Photo Studio — actions panel.
 *
 * Just the Photo capture trigger in V1: width / height / transparency /
 * format → render at offscreen resolution → Tauri save dialog → bytes
 * land on disk. No camera presets, lighting controls, or post-fx yet.
 *
 * Uses Babylon's `Tools.CreateScreenshotUsingRenderTarget` (wired into
 * `studioScene.screenshot`) so the export resolution is independent of
 * the canvas's CSS size.
 */

import { useEffect, useState } from 'react';
// W/H lives in shell context so the viewport's framing overlay can
// react to the same numbers the user types here.
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useShell } from '../shells/ShellContext';
import PortalDropdown from './PortalDropdown';
import './StudioPanels.css';

// Resolution presets — paper sizes at 150 DPI for sane print output,
// plus the common power-of-two texture sizes most game pipelines use.
// `null` means the user is editing freely; the dropdown snaps back to
// "Custom" the moment they type a value that doesn't match any preset.
const DIM_MIN = 64;
const DIM_MAX = 8192;

interface DimPreset {
    label: string;
    width: number;
    height: number;
}

const DIM_PRESETS: DimPreset[] = [
    // Square texture sizes
    { label: '512 × 512',   width: 512,  height: 512  },
    { label: '1024 × 1024 (1K)', width: 1024, height: 1024 },
    { label: '2048 × 2048 (2K)', width: 2048, height: 2048 },
    { label: '4096 × 4096 (4K)', width: 4096, height: 4096 },
    { label: '8192 × 8192 (8K)', width: 8192, height: 8192 },
    // Common video / screen sizes
    { label: 'HD 1280 × 720',    width: 1280, height: 720  },
    { label: 'Full HD 1920 × 1080', width: 1920, height: 1080 },
    { label: 'QHD 2560 × 1440',  width: 2560, height: 1440 },
    { label: '4K UHD 3840 × 2160', width: 3840, height: 2160 },
    // Paper sizes (150 DPI). Portrait orientation.
    { label: 'A4 portrait (150 DPI)',   width: 1240, height: 1754 },
    { label: 'A4 landscape (150 DPI)',  width: 1754, height: 1240 },
    { label: 'A5 portrait (150 DPI)',   width: 874,  height: 1240 },
    { label: 'A5 landscape (150 DPI)',  width: 1240, height: 874  },
    { label: 'US Letter portrait (150 DPI)',  width: 1275, height: 1650 },
    { label: 'US Letter landscape (150 DPI)', width: 1650, height: 1275 },
];

function presetMatching(w: number, h: number): DimPreset | null {
    return DIM_PRESETS.find((p) => p.width === w && p.height === h) ?? null;
}

interface StudioActionsPanelProps {
    studioTabId: string;
}

export default function StudioActionsPanel({ studioTabId }: StudioActionsPanelProps) {
    const s = useShell();
    const width = s.studioPhotoWidth;
    const height = s.studioPhotoHeight;
    const setWidth = s.setStudioPhotoWidth;
    const setHeight = s.setStudioPhotoHeight;
    const [format, setFormat] = useState<'png' | 'jpeg'>('png');
    const [transparent, setTransparent] = useState(true);
    const [hideGrid, setHideGrid] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const takePhoto = async () => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) {
            setError('Studio scene is not ready.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const dataUrl = await scene.screenshot({
                width,
                height,
                hideGrid,
                transparent: format === 'png' ? transparent : false,
                mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
            });
            const bytes = dataUrlToBytes(dataUrl);
            const target = await save({
                defaultPath: `studio.${format}`,
                filters: [{ name: format.toUpperCase(), extensions: [format] }],
            });
            if (!target) {
                setBusy(false);
                return;
            }
            await invoke('write_bytes_file', { path: target, bytes: Array.from(bytes) });
            s.setStatusMessage(`Saved ${target}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const copyPhoto = async () => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) {
            setError('Studio scene is not ready.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            // Clipboard image write only reliably accepts PNG across
            // browsers / WebView2, so the copy path always captures
            // PNG regardless of the Format dropdown. The transparent
            // toggle still applies — a transparent-bg PNG pastes with
            // alpha into tools that support it.
            const dataUrl = await scene.screenshot({
                width,
                height,
                hideGrid,
                transparent,
                mimeType: 'image/png',
            });
            const blob = dataUrlToBlob(dataUrl);
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob }),
            ]);
            s.setStatusMessage('Studio: photo copied to clipboard');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel">
            <div className="mop-content">
                <div className="studio-row">
                    <span className="studio-field-label">W</span>
                    <DimInput value={width} onCommit={setWidth} />
                    <span className="studio-field-label">H</span>
                    <DimInput value={height} onCommit={setHeight} />
                    <span className="studio-field-label">Format</span>
                    <PortalDropdown
                        options={[
                            { value: 'png', label: 'PNG' },
                            { value: 'jpeg', label: 'JPEG' },
                        ]}
                        value={format}
                        onChange={(v) => setFormat(v as 'png' | 'jpeg')}
                        style={{ width: 90 }}
                    />
                </div>
                <div className="studio-row">
                    <span className="studio-field-label">Preset</span>
                    <PortalDropdown
                        options={[
                            { value: '__custom__', label: 'Custom' },
                            ...DIM_PRESETS.map((p) => ({ value: p.label, label: p.label })),
                        ]}
                        value={presetMatching(width, height)?.label ?? '__custom__'}
                        onChange={(v) => {
                            const p = DIM_PRESETS.find((p) => p.label === v);
                            if (p) {
                                setWidth(p.width);
                                setHeight(p.height);
                            }
                        }}
                        searchable
                        style={{ flex: 1 }}
                    />
                </div>
                <div className="studio-row">
                    <label className="studio-checkbox">
                        <input
                            type="checkbox"
                            checked={transparent}
                            onChange={(e) => setTransparent(e.target.checked)}
                            disabled={format !== 'png'}
                        />
                        Transparent BG {format !== 'png' ? '(PNG only)' : ''}
                    </label>
                    <label className="studio-checkbox">
                        <input
                            type="checkbox"
                            checked={hideGrid}
                            onChange={(e) => setHideGrid(e.target.checked)}
                        />
                        Hide grid in capture
                    </label>
                    <button
                        type="button"
                        className="mop-btn mop-btn-cancel"
                        onClick={copyPhoto}
                        disabled={busy}
                        style={{ marginLeft: 'auto' }}
                        title="Capture and copy to clipboard (PNG)"
                    >
                        {busy ? '…' : 'Copy'}
                    </button>
                    <button
                        type="button"
                        className="mop-btn mop-btn-accept"
                        onClick={takePhoto}
                        disabled={busy}
                        title="Capture and save to a file"
                    >
                        {busy ? 'Capturing…' : 'Photo'}
                    </button>
                </div>
                {error && <div className="studio-status-error">{error}</div>}
            </div>
        </div>
    );
}

/**
 * Number-with-buttons input for capture dimensions.
 *
 * Two quirks worth knowing:
 *
 * 1. The 64 minimum is enforced only on COMMIT (blur / Enter / ÷2 /
 *    ×2), not during typing. The text input is `type="text"` so the
 *    field can briefly hold "" or numbers below 64 while the user is
 *    editing — without this, typing "1024" over a "64" forced you to
 *    select-all-then-type, which the user hated. On blur we parse,
 *    clamp, and snap back.
 * 2. The ÷2 and ×2 buttons round to integers and clamp to the same
 *    [64, 8192] range. Below 64 ÷2 stays put; above 8192 ×2 stays put.
 */
function DimInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
    const [draft, setDraft] = useState<string>(String(value));
    // Resync the local draft when the committed value changes from
    // outside (presets, ×2/÷2 buttons). Keeps the field showing the
    // current value when the user wasn't mid-edit.
    useEffect(() => {
        setDraft(String(value));
    }, [value]);

    const commit = () => {
        const n = parseInt(draft, 10);
        const clamped = Number.isFinite(n)
            ? Math.max(DIM_MIN, Math.min(DIM_MAX, n))
            : value;
        onCommit(clamped);
        setDraft(String(clamped));
    };

    return (
        <span className="studio-dim-group">
            <button
                type="button"
                className="studio-dim-step"
                onClick={() => onCommit(Math.max(DIM_MIN, Math.floor(value / 2)))}
                title="Halve"
                aria-label="Halve dimension"
            >
                ÷2
            </button>
            <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={draft}
                onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        commit();
                        (e.target as HTMLInputElement).blur();
                    }
                }}
                className="mop-input studio-num-input"
            />
            <button
                type="button"
                className="studio-dim-step"
                onClick={() => onCommit(Math.min(DIM_MAX, value * 2))}
                title="Double"
                aria-label="Double dimension"
            >
                ×2
            </button>
        </span>
    );
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('Invalid data URL');
    const b64 = dataUrl.slice(comma + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function dataUrlToBlob(dataUrl: string): Blob {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('Invalid data URL');
    const header = dataUrl.slice(0, comma);
    const mime = header.match(/data:([^;]+)/)?.[1] ?? 'image/png';
    const bytes = dataUrlToBytes(dataUrl);
    return new Blob([bytes], { type: mime });
}
