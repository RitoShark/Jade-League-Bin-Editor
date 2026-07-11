/**
 * Animation Studio — Animations (clip picker) panel.
 *
 * Ports Photo Studio's animation list (StudioAnimPanel) to Animation
 * Studio: it lists every clip discovered for the loaded rig and lets
 * the user click one to load it as the source clip — no dragging from
 * File Explorer. Clicking a clip calls `scene.loadSourceClip(path)`,
 * which drives both viewports (source raw, target retargeted) or, in
 * Physics mode, the single rig with physics baked.
 *
 * Discovery reuses the same backend command Photo Studio uses
 * (`read_skn_animations_disk_cmd`), keyed off the SOURCE rig's `.skn`
 * path. When that finds nothing (a loose SKN with no asset tree), a
 * "Choose folder…" button scans any folder of `.anm` files as a
 * fallback — same escape hatch as the batch exporter.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen as FolderOpenIcon, RefreshCw as RefreshIcon, Film as FilmIcon } from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import type { AnimStudioScene } from '../lib/babylon/animStudioScene';
import './StudioPanels.css';

interface Props {
    animStudioTabId: string;
}

interface AnimClip {
    name: string;
    anm_path: string;
    anm_chunk_hash_hex: string | null;
    anm_disk_path?: string | null;
}
interface AnimListing {
    bin_path: string;
    clips: AnimClip[];
}
interface DirEntryLite { name: string; path: string; is_dir: boolean }

const normPath = (p: string | null | undefined): string =>
    (p ?? '').replace(/\\/g, '/').toLowerCase();

export default function AnimStudioClipsPanel({ animStudioTabId }: Props) {
    const s = useShell();
    const [, setTick] = useState(0);
    const scene: AnimStudioScene | null = s.getAnimStudioScene(animStudioTabId);
    useEffect(() => {
        if (!scene) {
            const t = setTimeout(() => setTick(n => n + 1), 80);
            return () => clearTimeout(t);
        }
        return scene.onChange(() => setTick(n => n + 1));
    }, [animStudioTabId, scene]);

    const sourcePath = scene?.getSide('source').path ?? null;
    const loadedPath = normPath(scene?.getClipPath());

    const [clips, setClips] = useState<AnimClip[]>([]);
    const [source, setSource] = useState<'rig' | 'folder' | ''>('');
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState('');

    // Auto-discover from the loaded source rig whenever it changes.
    const discover = useCallback(async () => {
        if (!sourcePath) { setClips([]); setSource(''); return; }
        setLoading(true);
        try {
            const listing = await invoke<AnimListing | null>('read_skn_animations_disk_cmd', { sknPath: sourcePath });
            const cs = listing?.clips ?? [];
            setClips(cs);
            setSource(cs.length ? 'rig' : '');
        } catch {
            setClips([]);
            setSource('');
        } finally {
            setLoading(false);
        }
    }, [sourcePath]);

    useEffect(() => { void discover(); }, [discover]);

    const pickFolder = async () => {
        const picked = await openDialog({ directory: true, title: 'Pick a folder of .anm clips' });
        if (typeof picked !== 'string') return;
        setLoading(true);
        try {
            const entries = await invoke<DirEntryLite[]>('list_directory', { path: picked });
            const cs: AnimClip[] = entries
                .filter(e => !e.is_dir && /\.anm$/i.test(e.name))
                .map(e => ({
                    name: e.name.replace(/\.anm$/i, ''),
                    anm_path: e.path,
                    anm_chunk_hash_hex: null,
                    anm_disk_path: e.path,
                }));
            setClips(cs);
            setSource('folder');
        } catch {
            setClips([]);
        } finally {
            setLoading(false);
        }
    };

    const onPick = (clip: AnimClip) => {
        if (!clip.anm_disk_path || !scene) return;
        scene.loadSourceClip(clip.anm_disk_path)
            .then((meta) => s.setStatusMessage(
                `Anim Studio: ${clip.name} — ${meta.frameCount} frames @ ${Math.round(meta.fps)} fps`
            ))
            .catch((e) => s.setStatusMessage(`Anim Studio: clip load failed — ${e instanceof Error ? e.message : String(e)}`));
    };

    const filtered = useMemo(() => {
        const f = filter.trim().toLowerCase();
        const list = f ? clips.filter(c => c.name.toLowerCase().includes(f)) : clips;
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }, [clips, filter]);

    if (!scene) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel">
                <div className="mop-content">
                    <div className="anim-empty">Animation Studio scene initialising…</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel">
            <div className="mop-content">
                <div className="studio-anim-search-row">
                    <input
                        type="text"
                        className="mop-input"
                        placeholder="Filter animations…"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        style={{ flex: '1 1 auto', minWidth: 0 }}
                        disabled={clips.length === 0}
                    />
                    <button
                        className="studio-icon-btn"
                        title="Re-scan the rig's animations"
                        onClick={() => void discover()}
                        disabled={loading || !sourcePath}
                    >
                        <RefreshIcon size={13} />
                    </button>
                    <button
                        className="studio-icon-btn"
                        title="Load animations from a folder of .anm files"
                        onClick={() => void pickFolder()}
                        disabled={loading}
                    >
                        <FolderOpenIcon size={13} />
                    </button>
                </div>

                <div className="anim-clips-meta">
                    {loading
                        ? 'Scanning…'
                        : clips.length > 0
                            ? `${filtered.length} of ${clips.length} clip${clips.length === 1 ? '' : 's'}${source === 'folder' ? ' (folder)' : ''}`
                            : ''}
                </div>

                {!sourcePath && clips.length === 0 ? (
                    <div className="anim-empty-block">
                        <p>Load a rig to list its animations — or use the folder button to browse any folder of <code>.anm</code> files.</p>
                    </div>
                ) : clips.length === 0 && !loading ? (
                    <div className="anim-empty-block">
                        <p>No animations found for this rig. Try the <FolderOpenIcon size={11} style={{ verticalAlign: 'middle' }} /> folder button to point at a folder of <code>.anm</code> files.</p>
                    </div>
                ) : (
                    <div className="studio-anim-list">
                        {filtered.map((c) => {
                            const unsupported = !c.anm_disk_path;
                            const isSelected = !!c.anm_disk_path && normPath(c.anm_disk_path) === loadedPath;
                            return (
                                <button
                                    key={c.name + ':' + (c.anm_disk_path ?? c.anm_chunk_hash_hex ?? '')}
                                    onClick={() => onPick(c)}
                                    disabled={unsupported}
                                    className={`studio-anim-clip${isSelected ? ' active' : ''}`}
                                    title={unsupported
                                        ? 'WAD-source clip — load a disk rig to play it'
                                        : c.anm_disk_path ?? c.anm_path}
                                >
                                    <FilmIcon size={11} style={{ flex: '0 0 auto', opacity: 0.65 }} />
                                    <span className="anim-clip-name">{c.name}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
