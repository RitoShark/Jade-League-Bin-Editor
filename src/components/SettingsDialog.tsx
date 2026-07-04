import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { marked } from 'marked';
import {
    Hash as HashLucide,
    ArrowRightLeft as ConverterLucide,
    BrainCog as BehaviorLucide,
    Link as LinkLucide,
    Library as LibraryLucide,
    Gauge as PerformanceLucide,
    CloudDownload as UpdatesLucide,
} from 'lucide-react';
import './SettingsDialog.css';

interface SettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

interface HashStatus {
    all_present: boolean;
    missing: string[];
    format: string;
}

interface BinHashStatus {
    ready: boolean;
    count: number;
    memory_mb: number;
}

interface UpdateInfo {
    available: boolean;
    version: string;
    notes: string;
    release_url: string;
}

type UpdateCheckState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

type NavSection =
    | 'hashes'
    | 'converter'
    | 'behavior'
    | 'registration'
    | 'library'
    | 'performance'
    | 'updates';

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ReactNode }[] = [
    { id: 'hashes',       label: 'Hash Files',   icon: <HashLucide size={16} />        },
    { id: 'converter',    label: 'Converter',    icon: <ConverterLucide size={16} />   },
    { id: 'behavior',     label: 'App Behavior', icon: <BehaviorLucide size={16} />    },
    { id: 'registration', label: 'Registration', icon: <LinkLucide size={16} />        },
    { id: 'library',      label: 'Library',      icon: <LibraryLucide size={16} />     },
    { id: 'performance',  label: 'Performance',  icon: <PerformanceLucide size={16} /> },
    { id: 'updates',      label: 'Updates',      icon: <UpdatesLucide size={16} />     },
];

/* ── Performance prefs ──
   Each editor feature can be: kept on always, automatically disabled on
   "big" files (default >50k lines), or always off. The frontend evaluates
   these against the active document line count to derive Monaco options.
*/
type PerfMode = 'on' | 'auto' | 'off';

const PERF_KEYS = [
    'minimap',
    'bracketColors',
    'occurrencesHighlight',
    'selectionHighlight',
    'lineHighlight',
    'folding',
    'stopRenderingLine',
] as const;
type PerfKey = typeof PERF_KEYS[number];

const PERF_PREF_KEY: Record<PerfKey, string> = {
    minimap:              'Perf_Minimap',
    bracketColors:        'Perf_BracketColors',
    occurrencesHighlight: 'Perf_OccurrencesHighlight',
    selectionHighlight:   'Perf_SelectionHighlight',
    lineHighlight:        'Perf_LineHighlight',
    folding:              'Perf_Folding',
    stopRenderingLine:    'Perf_StopRenderingLine',
};

const PERF_LABEL: Record<PerfKey, { title: string; description: string }> = {
    minimap: {
        title: 'Minimap',
        description: 'Thumbnail of the whole file on the right edge. Has to render every line on each change — biggest cost on huge files.',
    },
    bracketColors: {
        title: 'Bracket pair colorization',
        description: 'Colors matching brackets so structure is easier to scan. Re-walks the bracket tree on every edit.',
    },
    occurrencesHighlight: {
        title: 'Occurrence highlights',
        description: 'Highlights other instances of the symbol under the cursor. Scans the document on cursor moves.',
    },
    selectionHighlight: {
        title: 'Selection highlights',
        description: 'Highlights other matches of the current selection. Same scan cost as occurrence highlighting.',
    },
    lineHighlight: {
        title: 'Active line highlight',
        description: 'Tints the row the caret is on across the full editor width. Restrict to the gutter to skip the full-width paint.',
    },
    folding: {
        title: 'Code folding',
        description: 'Lets you collapse blocks. Folding analyzes structure on every change.',
    },
    stopRenderingLine: {
        title: 'Render long lines fully',
        description: 'When off, Monaco stops rendering past column 10,000 on a line — invisible for normal lines, big help on lines with long string values.',
    },
};

const PERF_DEFAULT: Record<PerfKey, PerfMode> = {
    minimap:              'auto',
    bracketColors:        'auto',
    occurrencesHighlight: 'auto',
    selectionHighlight:   'auto',
    lineHighlight:        'auto',
    folding:              'auto',
    stopRenderingLine:    'auto',
};

// Material Library types — mirror library_commands.rs
interface DownloadedMaterialInfo {
    id: string;
    path: string;
    name: string;
    category: string;
    version: number;
    sizeBytes: number;
    hasPreview: boolean;
    previewPath: string | null;
}
interface OutdatedMaterial {
    id: string;
    path: string;
    name: string;
    cachedVersion: number;
    remoteVersion: number;
}
interface UpdateModeSettings {
    mode: string;
    intervalHours: number;
}
interface LibraryStatus {
    mode: string;
    intervalHours: number;
    lastCheckedAt: string;
    lastUpdatedRemote: string;
    downloadedCount: number;
    outdatedCount: number;
    totalSizeBytes: number;
}

/** Simple toggle-row with a native checkbox styled as a pill switch */
function ToggleRow({
    label, description, checked, disabled, onChange,
}: { label: string; description?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="settings-row">
            <div className="settings-row-header">
                <span className="settings-row-title">{label}</span>
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={e => onChange(e.target.checked)}
                    />
                    <span className="settings-toggle-track" />
                </label>
            </div>
            {description && <p className="settings-row-desc">{description}</p>}
        </div>
    );
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
    const [activeSection, setActiveSection] = useState<NavSection>('hashes');

    const [downloadStatus, setDownloadStatus] = useState<string>('');
    const [isDownloading, setIsDownloading] = useState(false);
    const [hashStatus, setHashStatus] = useState<HashStatus | null>(null);

    const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
    const [autoDownloadUpdates, setAutoDownloadUpdates] = useState(false);
    const [silentUpdate, setSilentUpdate] = useState(false);
    const [updateState, setUpdateState] = useState<UpdateCheckState>('idle');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [updateError, setUpdateError] = useState('');
    const [downloadProgress, setDownloadProgress] = useState<{ downloaded: number; total: number } | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const [hashUpdateMode, setHashUpdateMode] = useState<'every_launch' | 'every_3_days' | 'never'>('every_launch');
    const [lastHashCheckAt, setLastHashCheckAt] = useState<number>(0);
    const [binHashStatus, setBinHashStatus] = useState<BinHashStatus | null>(null);
    const [perfPrefs, setPerfPrefs] = useState<Record<PerfKey, PerfMode>>(PERF_DEFAULT);
    const [minimizeToTray, setMinimizeToTray] = useState(false);
    const [runAtStartup, setRunAtStartup] = useState(false);
    const [communicateWithQuartz, setCommunicateWithQuartz] = useState(true);
    const [isRegistered, setIsRegistered] = useState(false);
    const [converterEngine, setConverterEngine] = useState<string>('jade');
    const [engineChanged, setEngineChanged] = useState(false);
    const [materialMatchMode, setMaterialMatchMode] = useState<number>(3);
    const [recentFilesLimit, setRecentFilesLimit] = useState<number>(10);

    // ── Material Library state ──
    const [libStatus, setLibStatus] = useState<LibraryStatus | null>(null);
    const [libDownloaded, setLibDownloaded] = useState<DownloadedMaterialInfo[]>([]);
    const [libOutdated, setLibOutdated] = useState<OutdatedMaterial[]>([]);
    const [libUpdateMode, setLibUpdateMode] = useState<UpdateModeSettings>({ mode: 'smart', intervalHours: 24 });
    const [libBusy, setLibBusy] = useState(false);
    const [libMessage, setLibMessage] = useState<string>('');

    useEffect(() => {
        if (isOpen) {
            loadPreferences();
            checkHashStatus();
            loadBinHashStatus();
            loadLibraryData();
            // Restore cached update info from broadcast if we have it
            if (!updateInfo && cachedUpdateRef.current) {
                const info = cachedUpdateRef.current;
                setUpdateInfo(info);
                setUpdateState(info.available ? 'available' : 'up-to-date');
            } else if (!updateInfo && updateState === 'idle') {
                // No cached result — fetch fresh
                handleCheckForUpdate();
            }
        }
    }, [isOpen]);

    // Listen for auto-check results broadcast from App.tsx and cache across mounts
    const cachedUpdateRef = useRef<UpdateInfo | null>(null);
    useEffect(() => {
        const handler = (e: Event) => {
            const info = (e as CustomEvent<UpdateInfo>).detail;
            cachedUpdateRef.current = info;
            setUpdateInfo(info);
            setUpdateState(info.available ? 'available' : 'up-to-date');
        };
        window.addEventListener('update-check-result', handler);
        return () => window.removeEventListener('update-check-result', handler);
    }, []);

    const loadPreferences = async () => {
        try {
            const mode = await invoke<string>('get_preference', { key: 'HashUpdateMode', defaultValue: 'every_launch' });
            // Migrate the old `every_7_days` value silently — the schedule
            // is now expressed in 3-day windows (cheap fingerprint check).
            const normalized = mode === 'every_3_days' || mode === 'every_7_days'
                ? 'every_3_days'
                : mode === 'never'
                    ? 'never'
                    : 'every_launch';
            setHashUpdateMode(normalized);
            if (mode === 'every_7_days') {
                await invoke('set_preference', { key: 'HashUpdateMode', value: 'every_3_days' }).catch(() => {});
            }
            const lastCheckedStr = await invoke<string>('get_preference', { key: 'LastHashCheckAt', defaultValue: '0' });
            setLastHashCheckAt(parseInt(lastCheckedStr, 10) || 0);
            const loadedPerf: Record<PerfKey, PerfMode> = { ...PERF_DEFAULT };
            for (const key of PERF_KEYS) {
                const raw = await invoke<string>('get_preference', { key: PERF_PREF_KEY[key], defaultValue: PERF_DEFAULT[key] });
                if (raw === 'on' || raw === 'auto' || raw === 'off') loadedPerf[key] = raw;
            }
            setPerfPrefs(loadedPerf);
            setMinimizeToTray((await invoke<string>('get_preference', { key: 'MinimizeToTray', defaultValue: 'False' })) === 'True');
            setRunAtStartup(await invoke<boolean>('get_autostart_status'));
            setCommunicateWithQuartz((await invoke<string>('get_preference', { key: 'CommunicateWithQuartz', defaultValue: 'True' })) === 'True');
            setIsRegistered(await invoke<boolean>('get_bin_association_status'));
            setAutoCheckUpdates((await invoke<string>('get_preference', { key: 'AutoCheckUpdates', defaultValue: 'True' })) === 'True');
            setAutoDownloadUpdates((await invoke<string>('get_preference', { key: 'AutoDownloadUpdates', defaultValue: 'False' })) === 'True');
            setSilentUpdate((await invoke<string>('get_preference', { key: 'SilentUpdate', defaultValue: 'False' })) === 'True');
            setConverterEngine(await invoke<string>('get_preference', { key: 'ConverterEngine', defaultValue: 'jade' }));
            setMaterialMatchMode(parseInt(await invoke<string>('get_preference', { key: 'MaterialMatchMode', defaultValue: '3' })) || 3);
            const rawLimit = parseInt(await invoke<string>('get_preference', { key: 'RecentFilesLimit', defaultValue: '10' }));
            setRecentFilesLimit(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 10);
            setEngineChanged(false);
        } catch (e) { console.error(e); }
    };

    const checkHashStatus = async () => {
        try { setHashStatus(await invoke<HashStatus>('check_hashes')); }
        catch (e) { console.error(e); }
    };

    const loadBinHashStatus = async () => {
        try { setBinHashStatus(await invoke<BinHashStatus>('get_bin_hash_status')); }
        catch (e) { console.error(e); }
    };

    // While the BIN hash table is mid-load (kicked off at app
    // startup or by `preload_bin_hashes`), poll every 500 ms so the
    // UI flips from "loading" to the populated count without the
    // user having to reopen the settings dialog.
    useEffect(() => {
        if (!isOpen) return;
        if (binHashStatus?.ready) return;
        const id = setInterval(loadBinHashStatus, 500);
        return () => clearInterval(id);
    }, [isOpen, binHashStatus?.ready]);

    const handlePreloadBinHashes = async () => {
        try {
            await invoke('preload_bin_hashes');
            await loadBinHashStatus();
        } catch (e) { console.error(e); }
    };

    const savePref = async (key: string, value: boolean) => {
        try { await invoke('set_preference', { key, value: value ? 'True' : 'False' }); }
        catch (e) { console.error(e); }
    };

    const handleDownloadLmdbHashes = async () => {
        setIsDownloading(true);
        setDownloadStatus('Downloading combined LMDB hashes from lmdb-hashes…');
        try {
            await invoke('wad_download_hashes', { force: true });
            setDownloadStatus('LMDB hashes ready.');
            checkHashStatus();
        } catch (e) { setDownloadStatus(`LMDB download failed: ${e}`); }
        finally { setIsDownloading(false); }
    };

    const handleDownloadTextHashes = async () => {
        setIsDownloading(true);
        setDownloadStatus('Downloading text hashes from CommunityDragon…');
        try {
            // `force: true` bypasses the per-file ETag / Last-Modified
            // skip — the manual button always re-downloads every file.
            // The auto-update schedule still uses the smart-skip path.
            await invoke('download_hashes', { force: true });
            setDownloadStatus('Text hashes re-downloaded.');
            checkHashStatus();
            // New text files on disk — push them into the in-RAM BIN
            // table so the next conversion picks up the new entries
            // without an app restart.
            invoke('reload_bin_hashes').catch(() => {});
        } catch (e) { setDownloadStatus(`Text download failed: ${e}`); }
        finally { setIsDownloading(false); }
    };

    const handleOpenHashesFolder = async () => {
        try { await invoke('open_hashes_folder'); }
        catch (e) { console.error(e); }
    };

    const handleHashUpdateModeChange = async (mode: 'every_launch' | 'every_3_days' | 'never') => {
        setHashUpdateMode(mode);
        try { await invoke('set_preference', { key: 'HashUpdateMode', value: mode }); }
        catch (e) { console.error(e); }
    };

    const handlePerfChange = async (key: PerfKey, mode: PerfMode) => {
        setPerfPrefs(prev => ({ ...prev, [key]: mode }));
        try { await invoke('set_preference', { key: PERF_PREF_KEY[key], value: mode }); }
        catch (e) { console.error(e); }
        // Broadcast so App.tsx applies the new option to Monaco live.
        window.dispatchEvent(new CustomEvent('perf-pref-changed', { detail: { key, mode } }));
    };

    const handleCheckForUpdate = async () => {
        setUpdateState('checking'); setUpdateInfo(null); setUpdateError(''); setDownloadProgress(null);
        try {
            const info = await invoke<UpdateInfo>('check_for_update');
            setUpdateInfo(info);
            setUpdateState(info.available ? 'available' : 'up-to-date');
        } catch (e) { setUpdateError(String(e)); setUpdateState('error'); }
    };

    const handleDownloadUpdate = async () => {
        setUpdateState('downloading'); setUpdateError(''); setDownloadProgress(null);
        const unlisten = await listen<{ downloaded: number; total: number }>(
            'update-download-progress', e => setDownloadProgress(e.payload)
        );
        unlistenRef.current = unlisten;
        try {
            await invoke('start_update_download');
            setUpdateState('ready');
        } catch (e) { setUpdateError(String(e)); setUpdateState('available'); }
        finally { unlisten(); unlistenRef.current = null; }
    };

    const handleInstall = async () => {
        setUpdateState('installing');
        try { await invoke('run_installer', { silent: silentUpdate }); }
        catch (e) { setUpdateError(String(e)); setUpdateState('ready'); }
    };

    // ── Material Library loaders & handlers ──
    const loadLibraryData = async () => {
        try {
            const [status, downloaded, outdated, mode] = await Promise.all([
                invoke<LibraryStatus>('library_get_status'),
                invoke<DownloadedMaterialInfo[]>('library_list_downloaded'),
                invoke<OutdatedMaterial[]>('library_list_outdated'),
                invoke<UpdateModeSettings>('library_get_update_mode'),
            ]);
            setLibStatus(status);
            setLibDownloaded(downloaded);
            setLibOutdated(outdated);
            setLibUpdateMode(mode);
        } catch (e) { console.error('Failed to load library data:', e); }
    };

    const handleLibCheckNow = async () => {
        setLibBusy(true);
        setLibMessage('Checking for updates…');
        try {
            await invoke('library_fetch_index');
            await loadLibraryData();
            setLibMessage('Catalog refreshed.');
        } catch (e) { setLibMessage(`Error: ${e}`); }
        finally { setLibBusy(false); }
    };

    const handleLibUpdateAllOutdated = async () => {
        setLibBusy(true);
        setLibMessage('Updating outdated materials…');
        try {
            await invoke('library_update_all_outdated');
            await loadLibraryData();
            setLibMessage('Outdated materials updated.');
        } catch (e) { setLibMessage(`Error: ${e}`); }
        finally { setLibBusy(false); }
    };

    const handleLibUpdateOne = async (path: string) => {
        setLibBusy(true);
        try {
            await invoke('library_update_material', { path });
            await loadLibraryData();
        } catch (e) { setLibMessage(`Error: ${e}`); }
        finally { setLibBusy(false); }
    };

    const handleLibDeleteOne = async (path: string) => {
        try {
            await invoke('library_delete_material', { path });
            await loadLibraryData();
        } catch (e) { setLibMessage(`Error: ${e}`); }
    };

    const handleLibClearAll = async () => {
        setLibBusy(true);
        try {
            await invoke('library_clear_all');
            await loadLibraryData();
            setLibMessage('Library cache cleared.');
        } catch (e) { setLibMessage(`Error: ${e}`); }
        finally { setLibBusy(false); }
    };

    const handleLibOpenFolder = async () => {
        try { await invoke('library_open_folder'); }
        catch (e) { console.error(e); }
    };

    const handleLibSetMode = async (mode: string, intervalHours: number) => {
        setLibUpdateMode({ mode, intervalHours });
        try {
            await invoke('library_set_update_mode', { mode, intervalHours });
            await loadLibraryData();
        } catch (e) { console.error(e); }
    };

    if (!isOpen) return null;

    /* ── Section content renderers ── */
    const renderHashes = () => (
        <>
            <h2 className="settings-section-title">Hash Files</h2>
            <p className="settings-section-subtitle">Hash files convert hex values into readable names.</p>

            <div className="settings-btn-group">
                <button
                    className="action-button blue"
                    onClick={handleDownloadLmdbHashes}
                    disabled={isDownloading}
                    title="Pulls lol-hashes-combined.zst from lmdb-hashes releases. ~50 MB, shared with Quartz."
                >
                    {isDownloading ? 'Downloading…' : 'Download LMDB hashes'}
                </button>
                <button
                    className="action-button gray"
                    onClick={handleDownloadTextHashes}
                    disabled={isDownloading}
                    title="Pulls the legacy CommunityDragon text files. Used as a fallback when LMDB isn't available."
                >
                    Download text hashes
                </button>
                <button className="action-button gray" onClick={handleOpenHashesFolder}>
                    Open Folder
                </button>
            </div>

            {downloadStatus && <p className="download-status" style={{ marginBottom: 12 }}>{downloadStatus}</p>}

            {hashStatus?.all_present ? (
                <p className="success-text" style={{ marginBottom: 12 }}>
                    All hash files present{hashStatus.format !== 'None' ? ` (${hashStatus.format})` : ''}
                    <span className="location-text" style={{ display: 'block' }}>
                        %APPDATA%\FrogTools\hashes
                    </span>
                </p>
            ) : (
                <p className="warning-text" style={{ marginBottom: 12 }}>
                    Missing {hashStatus?.missing.length ?? 0} hash file(s)
                </p>
            )}

            <div className="settings-divider" />

            <h3 className="settings-section-title" style={{ fontSize: 16 }}>Active hash sources</h3>
            <p className="settings-section-subtitle">
                Jade reads BIN hashes from the text files and WAD hashes from the local database.
            </p>

            <div className="settings-row" style={{ marginBottom: 8 }}>
                <div className="settings-row-header">
                    <span className="settings-row-title">BIN names - text in RAM</span>
                    {binHashStatus?.ready ? (
                        <span className="success-text" style={{ fontSize: 12 }}>
                            {binHashStatus.count.toLocaleString()} loaded · {binHashStatus.memory_mb.toFixed(0)} MB
                        </span>
                    ) : (
                        <span className="warning-text" style={{ fontSize: 12 }}>
                            Loading…
                        </span>
                    )}
                </div>
                <p className="settings-row-desc">
                    Text file hashes. Loaded into memory once at startup.
                </p>
                {!binHashStatus?.ready && (
                    <button
                        className="action-button gray"
                        style={{ marginTop: 6 }}
                        onClick={handlePreloadBinHashes}
                    >
                        Reload now
                    </button>
                )}
            </div>

            <div className="settings-row" style={{ marginBottom: 12 }}>
                <div className="settings-row-header">
                    <span className="settings-row-title">WAD paths - LMDB</span>
                    <span className="success-text" style={{ fontSize: 12 }}>
                        {hashStatus?.format && hashStatus.format !== 'None' ? hashStatus.format : 'not present'}
                    </span>
                </div>
                <p className="settings-row-desc">
                    Read hashes from the local database on demand, shared with Quartz.
                </p>
            </div>

            <div className="settings-divider" />

            <h3 className="settings-section-title" style={{ fontSize: 16 }}>Update Schedule</h3>
            <p className="settings-section-subtitle">When should Jade check for hash file updates? Updates always run in the background and never block opening files.</p>

            <div className="engine-switcher">
                <button
                    className={`engine-option${hashUpdateMode === 'every_launch' ? ' active' : ''}`}
                    onClick={() => handleHashUpdateModeChange('every_launch')}
                >
                    Every launch
                </button>
                <button
                    className={`engine-option${hashUpdateMode === 'every_3_days' ? ' active' : ''}`}
                    onClick={() => handleHashUpdateModeChange('every_3_days')}
                >
                    Every 3 days
                </button>
                <button
                    className={`engine-option${hashUpdateMode === 'never' ? ' active' : ''}`}
                    onClick={() => handleHashUpdateModeChange('never')}
                >
                    Never
                </button>
            </div>

            <p className="settings-match-mode-desc">
                {hashUpdateMode === 'every_launch' && 'Compare the release fingerprint each launch. Re-downloads only when a new lmdb-hashes release is published.'}
                {hashUpdateMode === 'every_3_days' && 'Same fingerprint check, throttled to once every three days. Less network traffic.'}
                {hashUpdateMode === 'never' && 'Don’t auto-update. Use the Download Hashes button above when you want fresh hashes.'}
            </p>

            {lastHashCheckAt > 0 && (
                <p className="location-text" style={{ marginTop: 8 }}>
                    Last checked: {new Date(lastHashCheckAt).toLocaleString()}
                </p>
            )}
        </>
    );

    const renderBehavior = () => (
        <>
            <h2 className="settings-section-title">App Behavior</h2>
            <p className="settings-section-subtitle">Control how Jade behaves on your system.</p>

            <ToggleRow
                label="Minimize to tray"
                description="Keep Jade running in the system tray when the window is minimized."
                checked={minimizeToTray}
                onChange={v => { setMinimizeToTray(v); savePref('MinimizeToTray', v); }}
            />
            <ToggleRow
                label="Run at startup"
                description="Launch Jade automatically when Windows starts."
                checked={runAtStartup}
                onChange={async v => {
                    setRunAtStartup(v);
                    try { await invoke('toggle_autostart', { enable: v }); }
                    catch (e) { console.error(e); setRunAtStartup(!v); }
                }}
            />
            <ToggleRow
                label="Communicate with Quartz"
                description="Allow Jade and Quartz to exchange open/reload/update messages. Disable this to fully stop interop communication."
                checked={communicateWithQuartz}
                onChange={async v => {
                    setCommunicateWithQuartz(v);
                    await savePref('CommunicateWithQuartz', v);
                    window.dispatchEvent(new CustomEvent('quartz-interop-changed', { detail: v }));
                }}
            />

            <div className="settings-row">
                <div className="settings-row-header">
                    <span className="settings-row-title">Recent files to remember</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <input
                        type="range"
                        min={1}
                        max={50}
                        step={1}
                        value={recentFilesLimit}
                        onChange={async e => {
                            const v = parseInt(e.target.value);
                            setRecentFilesLimit(v);
                            try { await invoke('set_preference', { key: 'RecentFilesLimit', value: String(v) }); }
                            catch (err) { console.error(err); }
                        }}
                        style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {recentFilesLimit}
                    </span>
                </div>
                <p className="settings-row-desc">
                    How many recently-opened files Jade keeps in the Start screen list. History on disk is preserved up to 100 entries — bumping this back up restores older items.
                </p>
            </div>

            <div className="settings-divider" />

            <h3 className="settings-section-title" style={{ fontSize: 16 }}>Material Override</h3>
            <p className="settings-section-subtitle">Controls how Auto from SKN matches materials to textures.</p>

            <div className="settings-row">
                <div className="settings-row-header">
                    <span className="settings-row-title">Match Exactness</span>
                </div>
                <div className="settings-match-mode-selector">
                    {[3, 2, 1].map(mode => (
                        <button
                            key={mode}
                            className={`settings-match-mode-btn ${materialMatchMode === mode ? 'active' : ''}`}
                            onClick={async () => {
                                setMaterialMatchMode(mode);
                                try { await invoke('set_preference', { key: 'MaterialMatchMode', value: String(mode) }); }
                                catch (e) { console.error(e); }
                            }}
                        >
                            {mode === 1 && <span className="match-mode-warning" title="May produce inaccurate matches">&#9888;</span>}
                            {mode}
                        </button>
                    ))}
                </div>
                <p className="settings-match-mode-desc">
                    {materialMatchMode === 3 && 'Exact — material name must match texture filename exactly (e.g. Body → Body.tex).'}
                    {materialMatchMode === 2 && 'Loose — strips trailing numbers and checks partial containment (e.g. Body2 → Body.tex).'}
                    {materialMatchMode === 1 && <><span className="match-mode-warning-text">&#9888; Fuzzy</span> — picks the closest texture by character overlap. May produce inaccurate matches.</>}
                </p>
            </div>
        </>
    );

    const renderRegistration = () => (
        <>
            <h2 className="settings-section-title">File Registration</h2>
            <p className="settings-section-subtitle">Manage how Windows treats Jade-supported file types.</p>

            <h3 className="settings-section-title" style={{ fontSize: 16 }}>File Association</h3>
            <p className="settings-section-subtitle">Register Jade as the default handler for .bin files.</p>

            <div className="settings-btn-group">
                <button className="action-button blue" onClick={async () => {
                    try { await invoke('register_bin_association'); setIsRegistered(true); }
                    catch (e) { console.error(e); }
                }}>
                    Register .bin
                </button>
                <button className="action-button red" onClick={async () => {
                    try { await invoke('unregister_bin_association'); setIsRegistered(false); }
                    catch (e) { console.error(e); }
                }}>
                    Unregister
                </button>
            </div>
            {isRegistered && (
                <p className="success-text">Jade is registered as the .bin file handler.</p>
            )}
        </>
    );

    const engineDescriptions: Record<string, { title: string; description: string }> = {
        jade: {
            title: 'Jade Custom',
            description: 'A native Rust port of the original C# Jade converter. Built specifically for Jade with reliable read/write support and faster issue resolution.',
        },
        ltk: {
            title: 'LTK Converter',
            description: 'Uses the League Toolkit community crates (ltk_meta 0.5 / ltk_ritobin 0.3) for bin conversion. Provided mainly for testing and comparison against Jade Custom.',
        },
    };

    const handleEngineChange = async (engine: string) => {
        if (engine === converterEngine) return;
        setConverterEngine(engine);
        setEngineChanged(true);
        try { await invoke('set_preference', { key: 'ConverterEngine', value: engine }); }
        catch (err) { console.error(err); }
    };

    const renderConverter = () => (
        <>
            <h2 className="settings-section-title">Converter Engine</h2>
            <p className="settings-section-subtitle">Select which engine is used to read and write .bin files.</p>

            <div className="engine-switcher">
                <button
                    className={`engine-option${converterEngine === 'jade' ? ' active' : ''}`}
                    onClick={() => handleEngineChange('jade')}
                >
                    Jade Custom
                </button>
                <button
                    className={`engine-option${converterEngine === 'ltk' ? ' active' : ''}`}
                    onClick={() => handleEngineChange('ltk')}
                >
                    LTK Converter
                </button>
            </div>

            <div className="engine-description">
                <span className="engine-description-title">{engineDescriptions[converterEngine].title}</span>
                <p className="engine-description-text">{engineDescriptions[converterEngine].description}</p>
            </div>

            {converterEngine === 'ltk' && (
                <div style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    marginTop: 12, padding: '12px 14px', borderRadius: 8,
                    background: 'var(--warning-bg, rgba(240, 173, 78, 0.12))',
                    border: '1px solid var(--warning-border, rgba(240, 173, 78, 0.45))',
                    color: 'var(--warning-text, var(--text-color, #e0b070))',
                }}>
                    <span style={{ fontSize: 16, lineHeight: 1.3, flexShrink: 0 }}>⚠️</span>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                        <strong>Don't use this unless you're testing something.</strong>
                        <p style={{ margin: '4px 0 0' }}>
                            It's slow, big files can take a few seconds just to save. It also flags a
                            bunch of perfectly good files as broken, and worst of all it can save bins
                            that are actually invalid so they won't load in game at all. Just use Jade
                            Custom, there's no reason to run this for normal work.
                        </p>
                    </div>
                </div>
            )}

            {engineChanged && (
                <div className="engine-restart-notice">
                    Restart the app to apply this change.
                    <button className="action-button blue" style={{ marginLeft: 'auto', padding: '6px 14px' }} onClick={() =>
                        invoke('restart_app').catch(() => window.location.reload())
                    }>
                        Restart Now
                    </button>
                </div>
            )}
        </>
    );

    const renderLibrary = () => {
        const formatBytes = (b: number) =>
            b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;
        const formatDate = (iso: string) => {
            if (!iso) return '—';
            try { return new Date(iso).toLocaleString(); } catch { return iso; }
        };
        const intervals = [
            { value: 1, label: 'Every 1 hour' },
            { value: 6, label: 'Every 6 hours' },
            { value: 12, label: 'Every 12 hours' },
            { value: 24, label: 'Every 24 hours' },
            { value: 72, label: 'Every 3 days' },
            { value: 168, label: 'Every 7 days' },
        ];

        return (
            <>
                <h2 className="settings-section-title">Material Library</h2>
                <p className="settings-section-subtitle">
                    Manage downloaded materials and how Jade keeps them up to date.
                </p>

                {/* Update mode selector */}
                <h3 className="settings-section-title" style={{ fontSize: 16 }}>Update Mode</h3>
                <p className="settings-section-subtitle">When should Jade check for new and updated materials?</p>

                <div className="settings-row">
                    <div className="settings-row-header">
                        <span className="settings-row-title">Timed interval</span>
                        <label className="settings-toggle">
                            <input
                                type="radio"
                                name="lib-update-mode"
                                checked={libUpdateMode.mode === 'timed'}
                                onChange={() => handleLibSetMode('timed', libUpdateMode.intervalHours)}
                            />
                            <span className="settings-toggle-track" />
                        </label>
                    </div>
                    <p className="settings-row-desc">Periodically check on a fixed schedule while Jade is running.</p>
                    {libUpdateMode.mode === 'timed' && (
                        <select
                            className="settings-select"
                            value={libUpdateMode.intervalHours}
                            onChange={e => handleLibSetMode('timed', parseInt(e.target.value, 10))}
                        >
                            {intervals.map(i => (
                                <option key={i.value} value={i.value}>{i.label}</option>
                            ))}
                        </select>
                    )}
                </div>

                <div className="settings-row">
                    <div className="settings-row-header">
                        <span className="settings-row-title">Smart check</span>
                        <label className="settings-toggle">
                            <input
                                type="radio"
                                name="lib-update-mode"
                                checked={libUpdateMode.mode === 'smart'}
                                onChange={() => handleLibSetMode('smart', libUpdateMode.intervalHours)}
                            />
                            <span className="settings-toggle-track" />
                        </label>
                    </div>
                    <p className="settings-row-desc">
                        On launch, fetch only the index and only refresh materials if the repo's <code>lastUpdated</code> is newer than your cache.
                    </p>
                </div>

                <div className="settings-row">
                    <div className="settings-row-header">
                        <span className="settings-row-title">On every app launch</span>
                        <label className="settings-toggle">
                            <input
                                type="radio"
                                name="lib-update-mode"
                                checked={libUpdateMode.mode === 'startup'}
                                onChange={() => handleLibSetMode('startup', libUpdateMode.intervalHours)}
                            />
                            <span className="settings-toggle-track" />
                        </label>
                    </div>
                    <p className="settings-row-desc">
                        Always refresh outdated materials in the background at startup. Most aggressive — most network traffic.
                    </p>
                </div>

                <div className="settings-divider" />

                {/* Status row */}
                <div className="settings-btn-group">
                    <button className="action-button blue" onClick={handleLibCheckNow} disabled={libBusy}>
                        {libBusy ? 'Working…' : 'Check for updates now'}
                    </button>
                    <button className="action-button gray" onClick={handleLibOpenFolder}>
                        Open Folder
                    </button>
                </div>

                {libMessage && <p className="download-status" style={{ marginTop: 8 }}>{libMessage}</p>}

                <p className="success-text" style={{ marginTop: 12, marginBottom: 4 }}>
                    Last checked: {formatDate(libStatus?.lastCheckedAt ?? '')}
                </p>
                <p className="location-text" style={{ marginTop: 0 }}>
                    Library updated: {formatDate(libStatus?.lastUpdatedRemote ?? '')}
                </p>

                <div className="settings-divider" />

                {/* Cache summary */}
                <h3 className="settings-section-title" style={{ fontSize: 16 }}>Library Cache</h3>
                <p className="settings-section-subtitle">
                    {libDownloaded.length} downloaded · {libOutdated.length} outdated · {formatBytes(libStatus?.totalSizeBytes ?? 0)}
                </p>

                {libOutdated.length > 0 && (
                    <div className="settings-btn-group" style={{ marginBottom: 12 }}>
                        <button className="action-button blue" onClick={handleLibUpdateAllOutdated} disabled={libBusy}>
                            Update all {libOutdated.length} outdated
                        </button>
                    </div>
                )}

                {libDownloaded.length === 0 ? (
                    <p className="settings-section-subtitle">No materials downloaded yet. Open the Material Library from the title bar to get started.</p>
                ) : (
                    <div className="settings-lib-list">
                        {libDownloaded.map(d => {
                            const out = libOutdated.find(o => o.id === d.id);
                            return (
                                <div key={d.id} className="settings-lib-row">
                                    <div className="settings-lib-row-info">
                                        <span className="settings-lib-row-name">{d.name}</span>
                                        <span className="settings-lib-row-meta">
                                            {d.category} · v{d.version} · {formatBytes(d.sizeBytes)}
                                            {out && <span className="settings-lib-row-warning"> · ⚠ v{out.remoteVersion} available</span>}
                                        </span>
                                    </div>
                                    <div className="settings-lib-row-actions">
                                        {out && (
                                            <button
                                                className="action-button blue"
                                                onClick={() => handleLibUpdateOne(d.path)}
                                                disabled={libBusy}
                                            >
                                                Update
                                            </button>
                                        )}
                                        <button
                                            className="action-button red"
                                            onClick={() => handleLibDeleteOne(d.path)}
                                            disabled={libBusy}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {libDownloaded.length > 0 && (
                    <>
                        <div className="settings-divider" />
                        <div className="settings-btn-group">
                            <button className="action-button red" onClick={handleLibClearAll} disabled={libBusy}>
                                Clear All Materials
                            </button>
                        </div>
                    </>
                )}
            </>
        );
    };

    const renderPerformance = () => (
        <>
            <h2 className="settings-section-title">Performance</h2>
            <p className="settings-section-subtitle">
                Editor features have a cost on huge bin dumps. Each option below can be kept on,
                automatically dropped on big files (over 125,000 lines), or always off.
            </p>

            {PERF_KEYS.map(key => (
                <div key={key} className="settings-row">
                    <div className="settings-row-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                        <span className="settings-row-title">{PERF_LABEL[key].title}</span>
                        <div className="engine-switcher" style={{ marginBottom: 0 }}>
                            <button
                                className={`engine-option${perfPrefs[key] === 'on' ? ' active' : ''}`}
                                onClick={() => handlePerfChange(key, 'on')}
                            >
                                Always on
                            </button>
                            <button
                                className={`engine-option${perfPrefs[key] === 'auto' ? ' active' : ''}`}
                                onClick={() => handlePerfChange(key, 'auto')}
                            >
                                Off on big files
                            </button>
                            <button
                                className={`engine-option${perfPrefs[key] === 'off' ? ' active' : ''}`}
                                onClick={() => handlePerfChange(key, 'off')}
                            >
                                Always off
                            </button>
                        </div>
                    </div>
                    <p className="settings-row-desc">{PERF_LABEL[key].description}</p>
                </div>
            ))}
        </>
    );

    const renderUpdates = () => {
        const pct = downloadProgress && downloadProgress.total > 0
            ? (downloadProgress.downloaded / downloadProgress.total * 100) : 0;

        return (
            <>
                <h2 className="settings-section-title">Updates</h2>
                <p className="settings-section-subtitle">Keep Jade up to date with the latest features and fixes.</p>

                <div className="update-toggles">
                    <div className="update-toggle-item">
                        <div className="update-toggle-text">
                            <span className="update-toggle-label">Auto-check on startup</span>
                            <span className="update-toggle-desc">Check for new versions when Jade launches</span>
                        </div>
                        <label className="settings-toggle">
                            <input type="checkbox" checked={autoCheckUpdates}
                                onChange={e => { setAutoCheckUpdates(e.target.checked); savePref('AutoCheckUpdates', e.target.checked); }} />
                            <span className="settings-toggle-track" />
                        </label>
                    </div>
                    {autoCheckUpdates && (
                        <div className="update-toggle-item update-toggle-nested">
                            <div className="update-toggle-text">
                                <span className="update-toggle-label">Auto-download updates</span>
                                <span className="update-toggle-desc">Download automatically when an update is found</span>
                            </div>
                            <label className="settings-toggle">
                                <input type="checkbox" checked={autoDownloadUpdates}
                                    onChange={e => { setAutoDownloadUpdates(e.target.checked); savePref('AutoDownloadUpdates', e.target.checked); }} />
                                <span className="settings-toggle-track" />
                            </label>
                        </div>
                    )}
                    <div className="update-toggle-item">
                        <div className="update-toggle-text">
                            <span className="update-toggle-label">Silent install</span>
                            <span className="update-toggle-desc">Install quietly and restart instead of showing the wizard</span>
                        </div>
                        <label className="settings-toggle">
                            <input type="checkbox" checked={silentUpdate}
                                onChange={e => { setSilentUpdate(e.target.checked); savePref('SilentUpdate', e.target.checked); }} />
                            <span className="settings-toggle-track" />
                        </label>
                    </div>
                </div>

                {/* Update card — always visible once we have info */}
                {(updateState === 'checking' || updateState === 'idle') && !updateInfo && (
                    <div className="update-check-row">
                        <span className="download-status">
                            {updateState === 'checking' ? 'Checking for updates…' : 'Loading…'}
                        </span>
                    </div>
                )}

                {updateState === 'error' && !updateInfo && (
                    <div className="update-check-row">
                        <button className="action-button blue" onClick={handleCheckForUpdate}>
                            Retry
                        </button>
                        <span className="warning-text">{updateError}</span>
                    </div>
                )}

                {updateInfo && (
                    <div className="update-card">
                        <div className="update-card-header">
                            <div className={`update-card-badge ${updateInfo.available ? '' : 'update-card-badge-current'}`}>
                                {updateInfo.available ? 'Update Available' : 'Latest Release'}
                            </div>
                            <span className="update-card-version">v{updateInfo.version}</span>
                            {!updateInfo.available && (
                                <span className="success-text" style={{ fontSize: 11 }}>You're up to date</span>
                            )}
                            <button className="action-button gray update-changelog-btn"
                                onClick={() => invoke('open_url', { url: updateInfo!.release_url })}>
                                Open on GitHub
                            </button>
                        </div>

                        {/* Release notes */}
                        {updateInfo.notes && (
                            <div className="update-release-notes"
                                dangerouslySetInnerHTML={{ __html: marked.parse(updateInfo.notes, { async: false }) as string }}
                            />
                        )}

                        {/* Action area */}
                        <div className="update-card-actions">
                            {updateInfo.available && updateState === 'available' && (
                                <button className="action-button blue" onClick={handleDownloadUpdate}>
                                    Download Update
                                </button>
                            )}

                            {!updateInfo.available && (
                                <button className="action-button gray" onClick={handleDownloadUpdate}
                                    disabled={['downloading', 'installing'].includes(updateState)}>
                                    Redownload
                                </button>
                            )}

                            {updateState === 'downloading' && (
                                <div className="update-progress-wrap">
                                    <div className="update-progress-bar-track">
                                        <div className="update-progress-bar-fill" style={{ width: `${pct}%` }} />
                                    </div>
                                    <div className="update-progress-text">
                                        {downloadProgress
                                            ? <>
                                                {(downloadProgress.downloaded / 1024 / 1024).toFixed(1)} MB
                                                {downloadProgress.total > 0 && ` / ${(downloadProgress.total / 1024 / 1024).toFixed(1)} MB`}
                                                {downloadProgress.total > 0 && (
                                                    <span className="update-progress-pct"> ({pct.toFixed(0)}%)</span>
                                                )}
                                            </>
                                            : 'Connecting…'
                                        }
                                    </div>
                                </div>
                            )}

                            {updateState === 'ready' && (
                                <button className="action-button green" onClick={handleInstall}>
                                    Install &amp; Restart
                                </button>
                            )}

                            {updateState === 'installing' && (
                                <span className="download-status">Launching installer…</span>
                            )}

                            {updateState === 'error' && <span className="warning-text">{updateError}</span>}

                            <button className="action-button gray update-changelog-btn" style={{ marginLeft: 'auto' }}
                                onClick={handleCheckForUpdate}
                                disabled={updateState === 'checking'}>
                                {updateState === 'checking' ? 'Checking…' : 'Recheck'}
                            </button>
                        </div>
                    </div>
                )}
            </>
        );
    };

    const sectionContent: Record<NavSection, () => React.ReactElement> = {
        hashes: renderHashes,
        converter: renderConverter,
        behavior: renderBehavior,
        registration: renderRegistration,
        library: renderLibrary,
        performance: renderPerformance,
        updates: renderUpdates,
    };

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div className="settings-header">
                    <div className="settings-header-left">
                        <h2>Settings</h2>
                        <p>Configure application behavior and preferences</p>
                    </div>
                    <button className="settings-close-btn" onClick={onClose}>&times;</button>
                </div>

                {/* Body */}
                <div className="settings-body">
                    {/* Sidebar */}
                    <nav className="settings-sidebar">
                        {NAV_ITEMS.map(item => (
                            <div
                                key={item.id}
                                className={`settings-nav-item${activeSection === item.id ? ' active' : ''}`}
                                onClick={() => setActiveSection(item.id)}
                            >
                                <span className="settings-nav-icon">{item.icon}</span>
                                {item.label}
                            </div>
                        ))}
                    </nav>

                    {/* Content */}
                    <div className="settings-content">
                        {sectionContent[activeSection]()}
                    </div>
                </div>

                {/* Footer */}
                <div className="settings-footer">
                    <button className="action-button green" onClick={() =>
                        invoke('restart_app').catch(() => window.location.reload())
                    }>
                        Restart App
                    </button>
                    <button className="action-button gray" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
};

export default SettingsDialog;

