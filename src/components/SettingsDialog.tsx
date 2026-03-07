import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { HashIcon, SettingsIcon, ArrowUpIcon, ConverterIcon } from './Icons';
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

interface UpdateInfo {
    available: boolean;
    version: string;
    notes: string;
    release_url: string;
}

type UpdateCheckState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

interface PreloadStatus {
    loaded: boolean;
    loading: boolean;
    fnv_count: number;
    xxh_count: number;
    memory_bytes: number;
}

type NavSection = 'hashes' | 'converter' | 'behavior' | 'updates';

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ReactNode }[] = [
    { id: 'hashes',    label: 'Hash Files',    icon: <HashIcon size={15} />     },
    { id: 'converter', label: 'Converter',     icon: <ConverterIcon size={15} /> },
    { id: 'behavior',  label: 'App Behavior',  icon: <SettingsIcon size={15} /> },
    { id: 'updates',   label: 'Updates',        icon: <ArrowUpIcon size={15} /> },
];

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
    const [preloadStatus, setPreloadStatus] = useState<PreloadStatus | null>(null);
    const [isPreloading, setIsPreloading] = useState(false);

    const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
    const [autoDownloadUpdates, setAutoDownloadUpdates] = useState(false);
    const [silentUpdate, setSilentUpdate] = useState(false);
    const [updateState, setUpdateState] = useState<UpdateCheckState>('idle');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [updateError, setUpdateError] = useState('');
    const [downloadProgress, setDownloadProgress] = useState<{ downloaded: number; total: number } | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const [preloadHash, setPreloadHash] = useState(false);
    const [binaryFormat, setBinaryFormat] = useState(false);
    const [minimizeToTray, setMinimizeToTray] = useState(false);
    const [runAtStartup, setRunAtStartup] = useState(false);
    const [communicateWithQuartz, setCommunicateWithQuartz] = useState(true);
    const [isRegistered, setIsRegistered] = useState(false);
    const [converterEngine, setConverterEngine] = useState<string>('jade');
    const [engineChanged, setEngineChanged] = useState(false);
    const [materialMatchMode, setMaterialMatchMode] = useState<number>(3);

    useEffect(() => {
        if (isOpen) {
            loadPreferences();
            checkHashStatus();
            checkPreloadStatus();
        }
    }, [isOpen]);

    const checkPreloadStatus = async () => {
        try { setPreloadStatus(await invoke<PreloadStatus>('get_preload_status')); }
        catch (e) { console.error(e); }
    };

    const loadPreferences = async () => {
        try {
            setPreloadHash((await invoke<string>('get_preference', { key: 'PreloadHashes', defaultValue: 'False' })) === 'True');
            setBinaryFormat((await invoke<string>('get_preference', { key: 'UseBinaryHashFormat', defaultValue: 'False' })) === 'True');
            setMinimizeToTray((await invoke<string>('get_preference', { key: 'MinimizeToTray', defaultValue: 'False' })) === 'True');
            setRunAtStartup(await invoke<boolean>('get_autostart_status'));
            setCommunicateWithQuartz((await invoke<string>('get_preference', { key: 'CommunicateWithQuartz', defaultValue: 'True' })) === 'True');
            setIsRegistered(await invoke<boolean>('get_bin_association_status'));
            setAutoCheckUpdates((await invoke<string>('get_preference', { key: 'AutoCheckUpdates', defaultValue: 'True' })) === 'True');
            setAutoDownloadUpdates((await invoke<string>('get_preference', { key: 'AutoDownloadUpdates', defaultValue: 'False' })) === 'True');
            setSilentUpdate((await invoke<string>('get_preference', { key: 'SilentUpdate', defaultValue: 'False' })) === 'True');
            setConverterEngine(await invoke<string>('get_preference', { key: 'ConverterEngine', defaultValue: 'jade' }));
            setMaterialMatchMode(parseInt(await invoke<string>('get_preference', { key: 'MaterialMatchMode', defaultValue: '3' })) || 3);
            setEngineChanged(false);
        } catch (e) { console.error(e); }
    };

    const checkHashStatus = async () => {
        try { setHashStatus(await invoke<HashStatus>('check_hashes')); }
        catch (e) { console.error(e); }
    };

    const savePref = async (key: string, value: boolean) => {
        try { await invoke('set_preference', { key, value: value ? 'True' : 'False' }); }
        catch (e) { console.error(e); }
    };

    const handleDownloadHashes = async () => {
        setIsDownloading(true);
        setDownloadStatus('Downloading hash files from CommunityDragon…');
        try {
            await invoke('download_hashes', { useBinary: binaryFormat });
            setDownloadStatus('Hash files downloaded successfully.');
            checkHashStatus();
        } catch (e) { setDownloadStatus(`Error: ${e}`); }
        finally { setIsDownloading(false); }
    };

    const handleOpenHashesFolder = async () => {
        try { await invoke('open_hashes_folder'); }
        catch (e) { console.error(e); }
    };

    const togglePreloadHash = async () => {
        const next = !preloadHash;
        setPreloadHash(next);
        savePref('PreloadHashes', next);
        if (next) {
            setIsPreloading(true);
            try { setPreloadStatus(await invoke<PreloadStatus>('preload_hashes')); }
            catch (e) { console.error(e); }
            finally { setIsPreloading(false); }
        } else {
            try {
                await invoke('unload_hashes');
                setPreloadStatus({ loaded: false, loading: false, fnv_count: 0, xxh_count: 0, memory_bytes: 0 });
            } catch (e) { console.error(e); }
        }
    };

    const toggleBinaryFormat = async () => {
        const next = !binaryFormat;
        setBinaryFormat(next);
        savePref('UseBinaryHashFormat', next);
        if (next && hashStatus?.format === 'Text') {
            setDownloadStatus('Converting text hashes to binary format…');
            try {
                await invoke('convert_hashes_to_binary');
                setDownloadStatus('Hashes converted to binary format.');
                checkHashStatus();
            } catch (e) { setDownloadStatus(`Error: ${e}`); }
        }
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

    if (!isOpen) return null;

    /* ── Section content renderers ── */
    const renderHashes = () => (
        <>
            <h2 className="settings-section-title">Hash Files</h2>
            <p className="settings-section-subtitle">Hash files convert hex values into readable names.</p>

            <div className="settings-btn-group">
                <button className="action-button blue" onClick={handleDownloadHashes} disabled={isDownloading}>
                    {isDownloading ? 'Downloading…' : 'Download Hashes'}
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
            <ToggleRow
                label={isPreloading ? 'Preloading…' : 'Preload hashes on startup'}
                description="Load hash tables into memory at startup so the first file opens instantly. Without this, hashes load on first use."
                checked={preloadHash}
                disabled={isPreloading}
                onChange={togglePreloadHash}
            />
            {preloadHash && preloadStatus?.loaded && (
                <div className="preload-status">
                    {preloadStatus.fnv_count + preloadStatus.xxh_count} hashes in RAM
                    ({Math.round(preloadStatus.memory_bytes / 1024 / 1024)} MB)
                </div>
            )}
            <ToggleRow
                label="Binary hash format"
                description="Use a compact binary format instead of plain text. Faster to load; will auto-convert existing text files."
                checked={binaryFormat}
                onChange={toggleBinaryFormat}
            />
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

            <div className="settings-divider" />

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
            description: 'Uses the League Toolkit community crates for bin conversion. Broadly compatible but may lag behind on fixes due to external maintenance.',
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

    const renderUpdates = () => (
        <>
            <h2 className="settings-section-title">Updates</h2>
            <p className="settings-section-subtitle">Keep Jade up to date with the latest features and fixes.</p>

            <ToggleRow
                label="Auto-check on startup"
                description="Automatically check for new versions when Jade launches."
                checked={autoCheckUpdates}
                onChange={v => { setAutoCheckUpdates(v); savePref('AutoCheckUpdates', v); }}
            />
            {autoCheckUpdates && (
                <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--border-color, #333)' }}>
                    <ToggleRow
                        label="Auto-download updates"
                        description="Automatically download the update when one is found. If off, you'll just be notified."
                        checked={autoDownloadUpdates}
                        onChange={v => { setAutoDownloadUpdates(v); savePref('AutoDownloadUpdates', v); }}
                    />
                </div>
            )}
            <ToggleRow
                label="Silent install"
                description="Install updates silently and restart the app. If off, the installer wizard will open instead."
                checked={silentUpdate}
                onChange={v => { setSilentUpdate(v); savePref('SilentUpdate', v); }}
            />

            <div className="settings-divider" />

            <div className="update-check-row">
                <button
                    className="action-button blue"
                    onClick={handleCheckForUpdate}
                    disabled={['checking','downloading','installing'].includes(updateState)}
                >
                    {updateState === 'checking' ? 'Checking…' : 'Check for Updates'}
                </button>
                {updateState === 'up-to-date' && <span className="success-text">Jade is up to date</span>}
                {updateState === 'error'      && <span className="warning-text">{updateError}</span>}
            </div>

            {(['available','downloading','ready','installing'].includes(updateState)) && updateInfo && (
                <div className="update-info-box">
                    <div className="update-version-row">
                        <span className="update-version-label">New version:</span>
                        <span className="update-version-num">v{updateInfo.version}</span>
                        <button className="action-button gray update-changelog-btn"
                            onClick={() => invoke('open_url', { url: updateInfo!.release_url })}>
                            Changelog
                        </button>
                    </div>

                    {updateState === 'available' && (
                        <button className="action-button blue" onClick={handleDownloadUpdate}>
                            Download Update
                        </button>
                    )}

                    {updateState === 'downloading' && downloadProgress && (
                        <div className="update-progress-wrap">
                            <div className="update-progress-bar-track">
                                <div
                                    className="update-progress-bar-fill"
                                    style={{ width: `${downloadProgress.total > 0 ? (downloadProgress.downloaded / downloadProgress.total * 100) : 0}%` }}
                                />
                            </div>
                            <div className="update-progress-text">
                                {(downloadProgress.downloaded / 1024 / 1024).toFixed(1)} MB
                                {downloadProgress.total > 0 && ` / ${(downloadProgress.total / 1024 / 1024).toFixed(1)} MB`}
                                {downloadProgress.total > 0 && (
                                    <span className="update-progress-pct">
                                        {' '}({(downloadProgress.downloaded / downloadProgress.total * 100).toFixed(0)}%)
                                    </span>
                                )}
                            </div>
                        </div>
                    )}

                    {updateState === 'downloading' && !downloadProgress && (
                        <p className="download-status">Connecting…</p>
                    )}

                    {updateState === 'ready' && (
                        <button className="action-button green" onClick={handleInstall}>
                            Install Update — app will close and installer will open
                        </button>
                    )}

                    {updateState === 'installing' && (
                        <p className="download-status">Launching installer…</p>
                    )}
                </div>
            )}
        </>
    );

    const sectionContent: Record<NavSection, () => React.ReactElement> = {
        hashes: renderHashes,
        converter: renderConverter,
        behavior: renderBehavior,
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

