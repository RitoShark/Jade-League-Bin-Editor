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
import { save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import {
    FolderOpen as FolderOpenIcon,
    Save as SaveIcon,
    Wind as PhysicsIcon,
    RefreshCw as RefreshIcon,
    Play as RunIcon,
    RotateCcw as RestoreIcon,
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

// ── Backup preference (mode + folder), shared by regular + batch ──────
type BackupMode = 'none' | 'sibling' | 'folder';
const BACKUP_MODE_STORAGE = 'anim-studio-backup-mode';
const BACKUP_DIR_STORAGE = 'anim-studio-backup-dir';

function useBackupPrefs() {
    const [mode, setModeState] = useState<BackupMode>(() => {
        try {
            const v = window.localStorage.getItem(BACKUP_MODE_STORAGE);
            if (v === 'none' || v === 'sibling' || v === 'folder') return v;
        } catch { /* */ }
        return 'sibling';
    });
    const [dir, setDirState] = useState<string>(() => {
        try { return window.localStorage.getItem(BACKUP_DIR_STORAGE) ?? ''; } catch { return ''; }
    });
    const setMode = (m: BackupMode) => {
        setModeState(m);
        try { window.localStorage.setItem(BACKUP_MODE_STORAGE, m); } catch { /* */ }
    };
    const setDir = (d: string) => {
        setDirState(d);
        try { window.localStorage.setItem(BACKUP_DIR_STORAGE, d); } catch { /* */ }
    };
    // Args to forward to write_animation_v4 / restore_animation_backup.
    const backupArgs = { backupMode: mode, backupDir: mode === 'folder' ? (dir || null) : null };
    return { mode, setMode, dir, setDir, backupArgs };
}

/** Backup mode selector (Off / .jbck sidecar / folder) + optional folder
 *  picker + a Restore button. Shared by the regular and batch exporters. */
function BackupControls({ mode, setMode, dir, setDir, onRestore, restoreLabel }: {
    mode: BackupMode;
    setMode: (m: BackupMode) => void;
    dir: string;
    setDir: (d: string) => void;
    onRestore: () => void;
    restoreLabel: string;
}) {
    const pickDir = async () => {
        const p = await openDialog({ directory: true, title: 'Pick a backup folder' });
        if (typeof p === 'string') setDir(p);
    };
    return (
        <div className="anim-backup">
            <div className="anim-backup-row">
                <span className="anim-backup-label" title="What to do with an existing file before it's overwritten">Backup existing</span>
                <div className="anim-backup-seg">
                    {([['none', 'Off'], ['sibling', '.jbck'], ['folder', 'Folder']] as [BackupMode, string][]).map(([m, label]) => (
                        <button
                            key={m}
                            type="button"
                            className={`anim-backup-seg-btn${mode === m ? ' is-on' : ''}`}
                            onClick={() => setMode(m)}
                            title={m === 'none' ? 'Overwrite with no backup'
                                : m === 'sibling' ? 'Rename the old file to <name>.anm.jbck next to it'
                                : 'Copy the old file into a separate backup folder as <name>.anm.jbck'}
                        >{label}</button>
                    ))}
                </div>
            </div>
            {mode === 'folder' && (
                <div className="anim-options-bake-row">
                    <input
                        type="text"
                        value={dir}
                        onChange={(e) => setDir(e.target.value)}
                        placeholder="backup folder"
                        className="mop-input"
                        style={{ flex: '1 1 auto', minWidth: 0 }}
                        title={dir || 'No backup folder set'}
                    />
                    <button onClick={() => void pickDir()} title="Pick backup folder" className="studio-icon-btn">
                        <FolderOpenIcon size={14} />
                    </button>
                </div>
            )}
            <button
                type="button"
                className="mop-btn"
                style={{ alignSelf: 'flex-start' }}
                onClick={onRestore}
                title="Restore the .jbck (or legacy .bak) backup back over the output file(s)"
            >
                <RestoreIcon size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                {restoreLabel}
            </button>
        </div>
    );
}

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
    const backup = useBackupPrefs();
    const [baking, setBaking] = useState(false);
    const [lastSuggestion, setLastSuggestion] = useState('');

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
                path: bakePath, baked: dto, ...backup.backupArgs,
            });
            s.setStatusMessage(`Anim Studio: baked ${bytes} bytes → ${fileNameOf(bakePath)}`);
        } catch (e) {
            s.setStatusMessage(`Anim Studio: bake failed — ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBaking(false);
        }
    };

    const onRestore = async () => {
        if (!bakePath.trim()) {
            s.setStatusMessage('Anim Studio: set an output path to restore its backup.');
            return;
        }
        try {
            const from = await invoke<string>('restore_animation_backup', {
                path: bakePath, backupDir: backup.backupArgs.backupDir,
            });
            s.setStatusMessage(`Anim Studio: restored ${fileNameOf(bakePath)} from ${fileNameOf(from)}`);
        } catch (e) {
            s.setStatusMessage(`Anim Studio: restore failed — ${e instanceof Error ? e.message : String(e)}`);
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
            <BackupControls
                mode={backup.mode} setMode={backup.setMode}
                dir={backup.dir} setDir={backup.setDir}
                onRestore={() => void onRestore()}
                restoreLabel="Restore this file"
            />
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

/** Scan a folder for loose `.anm` files → BatchClip[]. The manual
 *  fallback when auto-discovery from the rig's asset tree finds
 *  nothing (e.g. a loose SKN dropped in from Downloads). */
async function scanFolderForAnm(folder: string): Promise<BatchClip[]> {
    try {
        const entries = await invoke<DirEntryLite[]>('list_directory', { path: folder });
        return entries
            .filter(e => !e.is_dir && /\.anm$/i.test(e.name))
            .map(e => ({ name: e.name.replace(/\.anm$/i, ''), anm_disk_path: e.path }));
    } catch {
        return [];
    }
}

function StatusChip({ status }: { status: MatchStatus }) {
    const label = status === 'bin' ? 'BIN' : status === 'name' ? 'name' : 'none';
    return <span className={`anim-batch-status anim-batch-status-${status}`}>{label}</span>;
}

function BatchExport({ scene }: { scene: AnimStudioScene }) {
    const s = useShell();
    // Batch follows the studio's mode: Retarget batches a source rig's
    // clips onto the target rig; Physics bakes physics onto every clip of
    // the single rig, writing to a chosen output folder.
    const mode = scene.getMode();
    const sourcePath = scene.getSide('source').path;
    const targetPath = scene.getSide('target').path;

    const [sourceLabel, setSourceLabel] = useState('');
    const [targets, setTargets] = useState<BatchClip[]>([]);
    const [tgtFromBin, setTgtFromBin] = useState(false);
    const [rows, setRows] = useState<BatchRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [results, setResults] = useState<{ ok: number; failed: number; skipped: number; errors: string[] } | null>(null);
    const backup = useBackupPrefs();
    // Physics-mode destination folder (each baked clip is written here
    // under its own name). Retarget mode uses per-row target files.
    const [outputFolder, setOutputFolder] = useState('');
    const targetFolderRef = useRef<string>('');

    // (Re)build the row list from a source clip set (+ targets in
    // retarget mode). Kept separate from discovery so the manual
    // folder-picker can rebuild without re-scanning the rig.
    const buildRows = useCallback((src: BatchClip[], fromBin: boolean, tgt: BatchClip[], tgtBin: boolean) => {
        if (mode === 'physics') {
            setRows(src.map((c, i) => ({
                id: `${i}:${c.name}`,
                source: c,
                targetIdx: null,
                status: 'unmatched' as MatchStatus,
                enabled: true,
                physics: true,
            })));
            return;
        }
        const matches = resolveBatchMatches(src, tgt, { sourceFromBin: fromBin, targetFromBin: tgtBin });
        setRows(matches.map((m, i) => {
            const idx = m.target ? tgt.indexOf(m.target) : -1;
            return {
                id: `${i}:${m.source.name}`,
                source: m.source,
                targetIdx: idx >= 0 ? idx : null,
                status: m.status,
                enabled: m.status !== 'unmatched', // matched rows on by default
                physics: false,
            };
        }));
    }, [mode]);

    // Auto-discover clips from the loaded rig(s).
    const rebuild = useCallback(async () => {
        setLoading(true);
        setResults(null);
        try {
            const src = await loadClips(sourcePath);
            setSourceLabel(src.clips.length ? `${src.clips.length} from rig` : '');
            let tgt = { clips: [] as BatchClip[], fromBin: false };
            if (mode === 'retarget') {
                tgt = await loadClips(targetPath);
                setTargets(tgt.clips);
                setTgtFromBin(tgt.fromBin);
                targetFolderRef.current = tgt.clips[0]?.anm_disk_path
                    ? dirOf(tgt.clips[0].anm_disk_path)
                    : (targetPath ? joinPath(dirOf(targetPath), 'animations') : '');
            } else {
                // Physics: default the output folder to where the clips
                // live (in-place bake, made safe by the backup toggle).
                const folder = src.clips[0]?.anm_disk_path
                    ? dirOf(src.clips[0].anm_disk_path)
                    : (sourcePath ? joinPath(dirOf(sourcePath), 'animations') : '');
                setOutputFolder(prev => prev || folder);
            }
            buildRows(src.clips, src.fromBin, tgt.clips, tgt.fromBin);
        } finally {
            setLoading(false);
        }
    }, [sourcePath, targetPath, mode, buildRows]);

    // Build on rig change / mode change.
    useEffect(() => {
        const ready = mode === 'physics' ? !!sourcePath : !!(sourcePath && targetPath);
        if (ready) void rebuild();
        else { setRows([]); setTargets([]); setSourceLabel(''); }
    }, [sourcePath, targetPath, mode, rebuild]);

    // Manual fallback: point at a folder of .anm files when the rig's
    // asset tree has none (loose SKN, borrowed anims, etc.).
    const pickSourceFolder = async () => {
        const picked = await openDialog({ directory: true, title: 'Pick a folder of .anm clips to process' });
        if (typeof picked !== 'string') return;
        setLoading(true);
        try {
            const clips = await scanFolderForAnm(picked);
            setSourceLabel(clips.length ? `${clips.length} from folder` : 'none in folder');
            buildRows(clips, false, targets, tgtFromBin);
            if (mode === 'physics') setOutputFolder(prev => prev || picked);
        } finally {
            setLoading(false);
        }
    };

    const pickOutputFolder = async () => {
        const picked = await openDialog({ directory: true, title: 'Pick the output folder for baked clips' });
        if (typeof picked === 'string') setOutputFolder(picked);
    };

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
        if (mode === 'physics' && !outputFolder) {
            s.setStatusMessage('Batch: pick an output folder first.');
            return;
        }
        setRunning(true);
        setProgress({ done: 0, total: todo.length });
        const errors: string[] = [];
        let ok = 0;
        for (let i = 0; i < todo.length; i++) {
            const row = todo[i];
            try {
                const srcAnm = row.source.anm_disk_path;
                if (!srcAnm) throw new Error('no source path');
                let dto: Awaited<ReturnType<AnimStudioScene['retargetClipForExport']>>;
                let dest: string;
                if (mode === 'physics') {
                    dto = await scene.bakePhysicsClipForExport(srcAnm);
                    if (!dto) throw new Error('physics bake produced nothing');
                    dest = joinPath(outputFolder, `${row.source.name}.anm`);
                } else {
                    dto = await scene.retargetClipForExport(srcAnm, { physics: row.physics });
                    if (!dto) throw new Error('retarget produced nothing');
                    // Destination: chosen target file, else source-named
                    // file in the target folder.
                    dest = row.targetIdx !== null
                        ? targets[row.targetIdx]?.anm_disk_path ?? ''
                        : joinPath(targetFolderRef.current, `${row.source.name}.anm`);
                }
                if (!dest) throw new Error('no destination');
                await invoke<number>('write_animation_v4', {
                    path: dest, baked: dto, ...backup.backupArgs,
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

    const destForRow = (row: BatchRow): string => (
        mode === 'physics'
            ? joinPath(outputFolder, `${row.source.name}.anm`)
            : row.targetIdx !== null
                ? targets[row.targetIdx]?.anm_disk_path ?? ''
                : joinPath(targetFolderRef.current, `${row.source.name}.anm`)
    );

    const onRestoreBatch = async () => {
        const todo = rows.filter(r => r.enabled);
        if (todo.length === 0) return;
        let ok = 0; let missing = 0;
        for (const row of todo) {
            const dest = destForRow(row);
            if (!dest) continue;
            try {
                await invoke<string>('restore_animation_backup', { path: dest, backupDir: backup.backupArgs.backupDir });
                ok++;
            } catch { missing++; }
        }
        s.setStatusMessage(`Batch restore: ${ok} restored${missing ? `, ${missing} had no backup` : ''}`);
    };

    // Gate: physics needs one rig, retarget needs both.
    if (mode === 'physics' ? !sourcePath : !(sourcePath && targetPath)) {
        return (
            <div className="anim-empty-block">
                {mode === 'physics'
                    ? <p>Load a <strong>rig</strong> (and set up physics chains) to batch-bake physics onto its clips.</p>
                    : <p>Load a <strong>source</strong> and <strong>target</strong> rig to batch-retarget their animations.</p>}
            </div>
        );
    }

    const isPhysics = mode === 'physics';

    return (
        <section className="anim-options-section">
            <div className="anim-options-section-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{isPhysics ? 'Batch physics' : 'Batch retarget'}</span>
                <button className="studio-icon-btn" title="Re-scan the rig's animations" onClick={() => void rebuild()} disabled={loading || running}>
                    <RefreshIcon size={13} />
                </button>
            </div>

            <p className="anim-batch-hint">
                {isPhysics
                    ? <>Bakes the current physics chains onto every enabled clip and writes them to the output folder. Click a row to toggle it. Loop each clip with the chain's <strong>Loop</strong> setting so cyclic anims don't pop.</>
                    : <>Click a row to toggle it. Enabled rows retarget and overwrite their target; with no target picked, they write under the source name. The <PhysicsIcon size={11} style={{ verticalAlign: 'middle' }} /> box also bakes physics for that clip.</>}
            </p>

            {/* Source clip set + manual folder fallback. */}
            <div className="anim-batch-source-row">
                <span className="anim-batch-source-label" title="Where the clips being processed came from">
                    Clips: {sourceLabel || (loading ? 'scanning…' : 'none found')}
                </span>
                <button className="mop-btn" onClick={() => void pickSourceFolder()} disabled={running} title="Pick a folder of .anm files to process instead of the rig's own clips">
                    <FolderOpenIcon size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                    Choose folder…
                </button>
            </div>

            {isPhysics && (
                <div className="anim-options-bake-row">
                    <input
                        type="text"
                        value={outputFolder}
                        onChange={(e) => setOutputFolder(e.target.value)}
                        placeholder="output folder for baked clips"
                        className="mop-input"
                        style={{ flex: '1 1 auto', minWidth: 0 }}
                        title={outputFolder || 'No output folder set'}
                    />
                    <button onClick={() => void pickOutputFolder()} title="Pick output folder" className="studio-icon-btn">
                        <FolderOpenIcon size={14} />
                    </button>
                </div>
            )}

            {loading ? (
                <div className="anim-empty-block"><p>Scanning animations…</p></div>
            ) : rows.length === 0 ? (
                <div className="anim-empty-block"><p>No animations found. Try <strong>Choose folder…</strong> to point at a folder of <code>.anm</code> files.</p></div>
            ) : (
                <div className="anim-batch-table">
                    <div className="anim-batch-head">
                        <span className="anim-batch-col-src">Source</span>
                        {!isPhysics && <span className="anim-batch-col-tgt">→ Target (overwrite)</span>}
                        {!isPhysics && <span className="anim-batch-col-phys" title="Bake physics for this clip"><PhysicsIcon size={12} /></span>}
                    </div>
                    {rows.map(row => (
                        <div
                            key={row.id}
                            className={`anim-batch-row${row.enabled ? ' is-enabled' : ' is-disabled'}${isPhysics ? ' anim-batch-row-solo' : ''}`}
                            onClick={() => patchRow(row.id, { enabled: !row.enabled })}
                            title={row.source.anm_disk_path ?? row.source.name}
                        >
                            <span className="anim-batch-col-src">
                                <span className="anim-batch-srcname">{row.source.name}</span>
                                {!isPhysics && <StatusChip status={row.status} />}
                            </span>
                            {!isPhysics && (
                                <span className="anim-batch-col-tgt" onClick={(e) => e.stopPropagation()}>
                                    <BoneDropdown
                                        value={row.targetIdx}
                                        options={targetOptions}
                                        onChange={(idx) => patchRow(row.id, { targetIdx: idx })}
                                        emptyLabel="(source name)"
                                        placeholder="(source name)"
                                    />
                                </span>
                            )}
                            {!isPhysics && (
                                <span className="anim-batch-col-phys" onClick={(e) => e.stopPropagation()}>
                                    <input
                                        type="checkbox"
                                        checked={row.physics}
                                        onChange={(e) => patchRow(row.id, { physics: e.target.checked })}
                                        title="Bake physics chains for this clip"
                                    />
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <BackupControls
                mode={backup.mode} setMode={backup.setMode}
                dir={backup.dir} setDir={backup.setDir}
                onRestore={() => void onRestoreBatch()}
                restoreLabel="Restore enabled rows"
            />

            <button
                className="mop-btn mop-btn-accept"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void runBatch()}
                disabled={running || loading || enabledCount === 0}
                title={isPhysics ? 'Bake physics + write every enabled clip' : 'Retarget + write every enabled row'}
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
