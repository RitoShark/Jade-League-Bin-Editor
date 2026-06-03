/**
 * Animation Studio — Export panel.
 *
 * Two modes via mini-tabs:
 *   - Regular: bake the currently-loaded retargeted clip to one .anm
 *     (moved here from the Options panel).
 *   - Batch: retarget a whole champion's animation set in one go.
 *     Builds a match table (source clip → target file) auto-resolved
 *     via clip-name then filename matching, with per-row enable +
 *     physics toggles and a manual target dropdown.
 *
 * The batch reuses the loaded scene's rigs / mapping / options /
 * guides / physics — set those up once, then process every clip with
 * identical settings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import {
    FolderOpen as FolderOpenIcon,
    Save as SaveIcon,
    Wind as PhysicsIcon,
    RefreshCw as RefreshIcon,
    Play as RunIcon,
} from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import type { AnimStudioScene } from '../lib/babylon/animStudioScene';
import {
    resolveBatchMatches,
    type BatchClip,
    type MatchStatus,
} from '../lib/animation/batchMatch';
import BoneDropdown from './BoneDropdown';
import './StudioPanels.css';

const BACKUP_STORAGE = 'anim-studio-bake-backup';

interface Props {
    animStudioTabId: string;
}

interface AnimListingClip {
    name: string;
    anm_path: string;
    anm_chunk_hash_hex: string | null;
    anm_disk_path?: string | null;
}
interface AnimListing {
    bin_path: string;
    clips: AnimListingClip[];
}
interface DirEntryLite { name: string; path: string; is_dir: boolean }

function fileNameOf(p: string | null): string {
    if (!p) return '';
    return p.replace(/\\/g, '/').split('/').pop() ?? p;
}
function dirOf(p: string): string {
    const norm = p.replace(/\\/g, '/');
    const i = norm.lastIndexOf('/');
    return i >= 0 ? norm.slice(0, i) : norm;
}
function joinPath(dir: string, name: string): string {
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export default function AnimStudioExportPanel({ animStudioTabId }: Props) {
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

    const [mode, setMode] = useState<'regular' | 'batch'>('regular');

    if (!scene) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-padded">
                <div className="mop-content">
                    <div className="anim-empty">Animation Studio scene initialising…</div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-padded anim-panel-scroll">
            <div className="mop-content">
                <div className="anim-export-tabs">
                    <button
                        className={`anim-export-tab${mode === 'regular' ? ' is-on' : ''}`}
                        onClick={() => setMode('regular')}
                    >Regular</button>
                    <button
                        className={`anim-export-tab${mode === 'batch' ? ' is-on' : ''}`}
                        onClick={() => setMode('batch')}
                    >Batch</button>
                </div>
                {mode === 'regular'
                    ? <RegularExport scene={scene} />
                    : <BatchExport scene={scene} />}
            </div>
        </div>
    );
}

// ── Regular (single-clip bake) ────────────────────────────────────────

function RegularExport({ scene }: { scene: AnimStudioScene }) {
    const s = useShell();
    const sourcePath = scene.getSide('source').path;
    const targetPath = scene.getSide('target').path;

    const [bakePath, setBakePath] = useState('');
    const [backupExisting, setBackupExisting] = useState<boolean>(() => {
        try { return window.localStorage.getItem(BACKUP_STORAGE) !== '0'; } catch { return true; }
    });
    const [baking, setBaking] = useState(false);
    const [lastSuggestion, setLastSuggestion] = useState('');

    useEffect(() => {
        try { window.localStorage.setItem(BACKUP_STORAGE, backupExisting ? '1' : '0'); } catch { /* */ }
    }, [backupExisting]);

    useEffect(() => {
        const suggestion = scene.getDefaultBakePath() ?? '';
        if (!suggestion) return;
        if (bakePath === '' || bakePath === lastSuggestion) setBakePath(suggestion);
        setLastSuggestion(suggestion);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scene, sourcePath, targetPath, scene.getClipPath()]);

    const onPickBakePath = async () => {
        const picked = await saveDialog({
            title: 'Bake animation as v4 ANM',
            defaultPath: bakePath || undefined,
            filters: [{ name: 'League animation', extensions: ['anm'] }],
        });
        if (typeof picked === 'string') setBakePath(picked);
    };

    const onBake = async () => {
        const dto = scene.getRetargetedClip();
        if (!dto || !bakePath) {
            s.setStatusMessage('Anim Studio: nothing to bake — load a clip first.');
            return;
        }
        setBaking(true);
        try {
            const bytes = await invoke<number>('write_animation_v4', {
                path: bakePath, baked: dto, backupExisting,
            });
            s.setStatusMessage(`Anim Studio: baked ${bytes} bytes → ${fileNameOf(bakePath)}`);
        } catch (e) {
            s.setStatusMessage(`Anim Studio: bake failed — ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBaking(false);
        }
    };

    const canBake = scene.hasClip() && bakePath.trim().length > 0 && !baking;

    return (
        <section className="anim-options-section">
            <div className="anim-options-section-head">Bake → .anm</div>
            <div className="anim-options-bake-row">
                <input
                    type="text"
                    value={bakePath}
                    onChange={(e) => setBakePath(e.target.value)}
                    placeholder="output path (e.g. .../animations/recall.anm)"
                    className="mop-input"
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                    title={bakePath || 'No output path set'}
                    disabled={!scene.hasClip()}
                />
                <button onClick={onPickBakePath} title="Pick output path" className="studio-icon-btn" disabled={!scene.hasClip()}>
                    <FolderOpenIcon size={14} />
                </button>
            </div>
            <label className="anim-check-row" title="Rename the existing file to <name>.anm.bak before writing. Off = silently overwrite.">
                <input type="checkbox" checked={backupExisting} onChange={(e) => setBackupExisting(e.target.checked)} />
                <span>Backup existing as <code style={{ fontSize: 10, opacity: 0.7 }}>.anm.bak</code></span>
            </label>
            <button
                onClick={onBake}
                disabled={!canBake}
                className="mop-btn mop-btn-accept"
                style={{ alignSelf: 'flex-start' }}
                title="Write the current retargeted clip to disk as a v4 ANM file"
            >
                <SaveIcon size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                {baking ? 'Baking…' : 'Bake to .anm'}
            </button>
            {!scene.hasClip() && (
                <div className="anim-empty-block" style={{ padding: '4px 0' }}>
                    <p>Load a clip to bake.</p>
                </div>
            )}
        </section>
    );
}

// ── Batch ─────────────────────────────────────────────────────────────

interface BatchRow {
    id: string;
    source: BatchClip;
    /** Index into `targets`, or null = write under the source's own
     *  name into the target folder. */
    targetIdx: number | null;
    status: MatchStatus;
    enabled: boolean;
    physics: boolean;
}

/** Load a champion's clips, preferring its animation-graph BIN; falls
 *  back to scanning the SKN's folder for loose `.anm` files. Returns
 *  the clips + whether they came from a BIN (affects match confidence).*/
async function loadClips(sknPath: string | null): Promise<{ clips: BatchClip[]; fromBin: boolean }> {
    if (!sknPath) return { clips: [], fromBin: false };
    try {
        const listing = await invoke<AnimListing | null>('read_skn_animations_disk_cmd', { sknPath });
        if (listing && listing.clips.length > 0 && listing.clips.some(c => c.anm_disk_path)) {
            return {
                clips: listing.clips
                    .filter(c => c.anm_disk_path)
                    .map(c => ({ name: c.name, anm_disk_path: c.anm_disk_path })),
                fromBin: !!listing.bin_path,
            };
        }
    } catch { /* fall through to folder scan */ }
    // Folder scan fallback.
    try {
        const folder = dirOf(sknPath);
        const entries = await invoke<DirEntryLite[]>('list_directory', { path: folder });
        const clips = entries
            .filter(e => !e.is_dir && /\.anm$/i.test(e.name))
            .map(e => ({ name: e.name.replace(/\.anm$/i, ''), anm_disk_path: e.path }));
        return { clips, fromBin: false };
    } catch {
        return { clips: [], fromBin: false };
    }
}

function StatusChip({ status }: { status: MatchStatus }) {
    const label = status === 'bin' ? 'BIN' : status === 'name' ? 'name' : 'none';
    return <span className={`anim-batch-status anim-batch-status-${status}`}>{label}</span>;
}

function BatchExport({ scene }: { scene: AnimStudioScene }) {
    const s = useShell();
    const sourcePath = scene.getSide('source').path;
    const targetPath = scene.getSide('target').path;

    const [targets, setTargets] = useState<BatchClip[]>([]);
    const [rows, setRows] = useState<BatchRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [results, setResults] = useState<{ ok: number; failed: number; skipped: number; errors: string[] } | null>(null);
    const [backupExisting, setBackupExisting] = useState<boolean>(() => {
        try { return window.localStorage.getItem(BACKUP_STORAGE) !== '0'; } catch { return true; }
    });
    const targetFolderRef = useRef<string>('');

    const rebuild = useCallback(async () => {
        setLoading(true);
        setResults(null);
        try {
            const [src, tgt] = await Promise.all([loadClips(sourcePath), loadClips(targetPath)]);
            setTargets(tgt.clips);
            targetFolderRef.current = tgt.clips[0]?.anm_disk_path
                ? dirOf(tgt.clips[0].anm_disk_path)
                : (targetPath ? joinPath(dirOf(targetPath), 'animations') : '');
            const matches = resolveBatchMatches(src.clips, tgt.clips, {
                sourceFromBin: src.fromBin,
                targetFromBin: tgt.fromBin,
            });
            setRows(matches.map((m, i) => {
                const idx = m.target ? tgt.clips.indexOf(m.target) : -1;
                return {
                    id: `${i}:${m.source.name}`,
                    source: m.source,
                    targetIdx: idx >= 0 ? idx : null,
                    status: m.status,
                    enabled: m.status !== 'unmatched', // matched rows on by default
                    physics: false,
                };
            }));
        } finally {
            setLoading(false);
        }
    }, [sourcePath, targetPath]);

    // Build once when both rigs are present (and on rig change).
    useEffect(() => {
        if (sourcePath && targetPath) void rebuild();
        else { setRows([]); setTargets([]); }
    }, [sourcePath, targetPath, rebuild]);

    const targetOptions = useMemo(
        () => targets.map((t, i) => ({ hash: i, name: t.name })),
        [targets],
    );

    const patchRow = (id: string, patch: Partial<BatchRow>) =>
        setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));

    const enabledCount = rows.filter(r => r.enabled).length;

    const runBatch = async () => {
        const todo = rows.filter(r => r.enabled);
        if (todo.length === 0) return;
        setRunning(true);
        setProgress({ done: 0, total: todo.length });
        const errors: string[] = [];
        let ok = 0;
        for (let i = 0; i < todo.length; i++) {
            const row = todo[i];
            try {
                const srcAnm = row.source.anm_disk_path;
                if (!srcAnm) throw new Error('no source path');
                const dto = await scene.retargetClipForExport(srcAnm, { physics: row.physics });
                if (!dto) throw new Error('retarget produced nothing');
                // Destination: chosen target file, else source-named file
                // in the target folder.
                const dest = row.targetIdx !== null
                    ? targets[row.targetIdx]?.anm_disk_path ?? ''
                    : joinPath(targetFolderRef.current, `${row.source.name}.anm`);
                if (!dest) throw new Error('no destination');
                await invoke<number>('write_animation_v4', {
                    path: dest, baked: dto, backupExisting,
                });
                ok++;
            } catch (e) {
                errors.push(`${row.source.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
            setProgress({ done: i + 1, total: todo.length });
        }
        setRunning(false);
        setResults({ ok, failed: errors.length, skipped: rows.length - todo.length, errors });
        s.setStatusMessage(`Batch: ${ok} written, ${errors.length} failed, ${rows.length - todo.length} skipped`);
    };

    if (!sourcePath || !targetPath) {
        return (
            <div className="anim-empty-block">
                <p>Load a <strong>source</strong> and <strong>target</strong> rig to batch-retarget their animations.</p>
            </div>
        );
    }

    return (
        <section className="anim-options-section">
            <div className="anim-options-section-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Batch retarget</span>
                <button className="studio-icon-btn" title="Re-scan source / target animations" onClick={() => void rebuild()} disabled={loading || running}>
                    <RefreshIcon size={13} />
                </button>
            </div>

            <p className="anim-batch-hint">
                Click a row to toggle it. Enabled rows export and overwrite their
                target; with no target picked, they write under the source name.
                Disabled rows are skipped. The <PhysicsIcon size={11} style={{ verticalAlign: 'middle' }} /> box bakes physics for that clip.
            </p>

            {loading ? (
                <div className="anim-empty-block"><p>Scanning animations…</p></div>
            ) : rows.length === 0 ? (
                <div className="anim-empty-block"><p>No source animations found.</p></div>
            ) : (
                <div className="anim-batch-table">
                    <div className="anim-batch-head">
                        <span className="anim-batch-col-src">Source</span>
                        <span className="anim-batch-col-tgt">→ Target (overwrite)</span>
                        <span className="anim-batch-col-phys" title="Bake physics for this clip"><PhysicsIcon size={12} /></span>
                    </div>
                    {rows.map(row => (
                        <div
                            key={row.id}
                            className={`anim-batch-row${row.enabled ? ' is-enabled' : ' is-disabled'}`}
                            onClick={() => patchRow(row.id, { enabled: !row.enabled })}
                            title={row.source.anm_disk_path ?? row.source.name}
                        >
                            <span className="anim-batch-col-src">
                                <span className="anim-batch-srcname">{row.source.name}</span>
                                <StatusChip status={row.status} />
                            </span>
                            <span className="anim-batch-col-tgt" onClick={(e) => e.stopPropagation()}>
                                <BoneDropdown
                                    value={row.targetIdx}
                                    options={targetOptions}
                                    onChange={(idx) => patchRow(row.id, { targetIdx: idx })}
                                    emptyLabel="(source name)"
                                    placeholder="(source name)"
                                />
                            </span>
                            <span className="anim-batch-col-phys" onClick={(e) => e.stopPropagation()}>
                                <input
                                    type="checkbox"
                                    checked={row.physics}
                                    onChange={(e) => patchRow(row.id, { physics: e.target.checked })}
                                    title="Bake physics chains for this clip"
                                />
                            </span>
                        </div>
                    ))}
                </div>
            )}

            <label className="anim-check-row" title="Rename each existing target to <name>.anm.bak before writing.">
                <input type="checkbox" checked={backupExisting} onChange={(e) => setBackupExisting(e.target.checked)} />
                <span>Backup existing as <code style={{ fontSize: 10, opacity: 0.7 }}>.anm.bak</code></span>
            </label>

            <button
                className="mop-btn mop-btn-accept"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void runBatch()}
                disabled={running || loading || enabledCount === 0}
                title="Retarget + write every enabled row"
            >
                <RunIcon size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                {running
                    ? `Baking ${progress?.done ?? 0}/${progress?.total ?? 0}…`
                    : `Bake ${enabledCount} clip${enabledCount === 1 ? '' : 's'}`}
            </button>

            {results && (
                <div className="anim-batch-results">
                    <div><strong>{results.ok}</strong> written · <strong>{results.failed}</strong> failed · {results.skipped} skipped</div>
                    {results.errors.length > 0 && (
                        <ul className="anim-batch-errors">
                            {results.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
                            {results.errors.length > 8 && <li>…and {results.errors.length - 8} more</li>}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
}
