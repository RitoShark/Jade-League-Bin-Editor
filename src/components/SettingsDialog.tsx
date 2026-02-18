import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
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

interface PreloadStatus {
    loaded: boolean;
    loading: boolean;
    fnv_count: number;
    xxh_count: number;
    memory_bytes: number;
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
    const [downloadStatus, setDownloadStatus] = useState<string>('');
    const [isDownloading, setIsDownloading] = useState(false);
    const [hashStatus, setHashStatus] = useState<HashStatus | null>(null);
    const [preloadStatus, setPreloadStatus] = useState<PreloadStatus | null>(null);
    const [isPreloading, setIsPreloading] = useState(false);

    // Preferences
    const [autoDownload, setAutoDownload] = useState(false);
    const [preloadHash, setPreloadHash] = useState(false);
    const [binaryFormat, setBinaryFormat] = useState(false);
    const [minimizeToTray, setMinimizeToTray] = useState(false);
    const [runAtStartup, setRunAtStartup] = useState(false);
    const [isRegistered, setIsRegistered] = useState(false); // Placeholder since we can't easily check reg

    useEffect(() => {
        if (isOpen) {
            loadPreferences();
            checkHashStatus();
            checkPreloadStatus();
        }
    }, [isOpen]);

    const checkPreloadStatus = async () => {
        try {
            const status = await invoke<PreloadStatus>('get_preload_status');
            setPreloadStatus(status);
        } catch (e) {
            console.error("Failed to check preload status", e);
        }
    };

    const loadPreferences = async () => {
        try {
            const ad = await invoke<string>('get_preference', { key: 'AutoDownloadHashes', defaultValue: 'False' });
            setAutoDownload(ad === 'True');

            const ph = await invoke<string>('get_preference', { key: 'PreloadHashes', defaultValue: 'False' });
            setPreloadHash(ph === 'True');

            const bf = await invoke<string>('get_preference', { key: 'UseBinaryHashFormat', defaultValue: 'False' });
            setBinaryFormat(bf === 'True');

            const mt = await invoke<string>('get_preference', { key: 'MinimizeToTray', defaultValue: 'False' });
            setMinimizeToTray(mt === 'True');

            // Get real autostart status from OS
            const autostartEnabled = await invoke<boolean>('get_autostart_status');
            setRunAtStartup(autostartEnabled);

            // Get real file association status from registry
            const assocRegistered = await invoke<boolean>('get_bin_association_status');
            setIsRegistered(assocRegistered);
        } catch (e) {
            console.error("Failed to load prefs", e);
        }
    };

    const checkHashStatus = async () => {
        try {
            const status = await invoke<HashStatus>('check_hashes');
            setHashStatus(status);
        } catch (e) {
            console.error("Failed to check hashes", e);
        }
    };

    const savePreference = async (key: string, value: boolean) => {
        try {
            await invoke('set_preference', { key, value: value ? 'True' : 'False' });
        } catch (e) {
            console.error(`Failed to save ${key}`, e);
        }
    };

    const handleDownloadHashes = async () => {
        setIsDownloading(true);
        setDownloadStatus("Downloading hash files from CommunityDragon...");
        try {
            await invoke('download_hashes', { useBinary: binaryFormat });
            setDownloadStatus("✓ Successfully downloaded hash files!");
            checkHashStatus();
        } catch (e) {
            setDownloadStatus(`Error: ${e}`);
        } finally {
            setIsDownloading(false);
        }
    };

    const handleOpenHashesFolder = async () => {
        try {
            await invoke('open_hashes_folder');
        } catch (e) {
            console.error("Failed to open folder", e);
        }
    };

    const toggleAutoDownload = () => {
        const newVal = !autoDownload;
        setAutoDownload(newVal);
        savePreference('AutoDownloadHashes', newVal);
    };

    const togglePreloadHash = async () => {
        const newVal = !preloadHash;
        setPreloadHash(newVal);
        savePreference('PreloadHashes', newVal);

        if (newVal) {
            // Immediately preload hashes when enabled
            setIsPreloading(true);
            try {
                const status = await invoke<PreloadStatus>('preload_hashes');
                setPreloadStatus(status);
            } catch (e) {
                console.error("Failed to preload hashes", e);
            } finally {
                setIsPreloading(false);
            }
        } else {
            // Unload hashes when disabled
            try {
                await invoke('unload_hashes');
                setPreloadStatus({ loaded: false, loading: false, fnv_count: 0, xxh_count: 0, memory_bytes: 0 });
            } catch (e) {
                console.error("Failed to unload hashes", e);
            }
        }
    };

    const toggleBinaryFormat = async () => {
        const newVal = !binaryFormat;
        setBinaryFormat(newVal);
        savePreference('UseBinaryHashFormat', newVal);

        // If enabling binary format and text files exist, convert them
        if (newVal && hashStatus?.format === 'Text') {
            setDownloadStatus('Converting text hashes to binary format...');
            try {
                await invoke('convert_hashes_to_binary');
                setDownloadStatus('✓ Hashes converted to binary format!');
                checkHashStatus(); // Refresh status
            } catch (e) {
                setDownloadStatus(`Error converting to binary: ${e}`);
            }
        }
    };

    if (!isOpen) return null;

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
                <div className="settings-header">
                    <h2>Settings</h2>
                    <p>Configure application behavior and preferences</p>
                </div>

                <div className="settings-grid">
                    {/* Hash Files Section */}
                    <div className="settings-column">
                        <h3>Hash Files</h3>
                        <p className="description">
                            Hash files are used to convert hex values into readable names.
                        </p>

                        <button
                            className="action-button blue"
                            onClick={handleDownloadHashes}
                            disabled={isDownloading}
                        >
                            {isDownloading ? 'Downloading...' : 'Download Hashes'}
                        </button>

                        <button className="action-button gray" onClick={handleOpenHashesFolder}>
                            Open Hashes Folder
                        </button>

                        <div className="preferences-group">
                            <button
                                className={`toggle-button ${autoDownload ? 'enabled' : 'disabled'}`}
                                onClick={toggleAutoDownload}
                            >
                                Auto-download: {autoDownload ? 'Enabled' : 'Disabled'}
                            </button>

                            <button
                                className={`toggle-button ${preloadHash ? 'enabled' : 'disabled'}`}
                                onClick={togglePreloadHash}
                                disabled={isPreloading}
                            >
                                {isPreloading ? 'Preloading...' : `Preload hashes: ${preloadHash ? 'Enabled' : 'Disabled'}`}
                            </button>

                            {preloadStatus?.loaded && (
                                <div className="preload-status">
                                    ✓ {preloadStatus.fnv_count + preloadStatus.xxh_count} hashes in RAM
                                    ({Math.round(preloadStatus.memory_bytes / 1024 / 1024)}MB)
                                </div>
                            )}

                            <button
                                className={`toggle-button ${binaryFormat ? 'enabled' : 'disabled'}`}
                                onClick={toggleBinaryFormat}
                            >
                                Binary format: {binaryFormat ? 'Enabled' : 'Disabled'}
                            </button>
                        </div>

                        <div className="status-text">
                            {downloadStatus && <div className="download-status">{downloadStatus}</div>}
                            {hashStatus?.all_present ? (
                                <div className="success-text">
                                    ✓ All hash files are present {hashStatus.format !== 'None' ? `(${hashStatus.format} format)` : ''}
                                    <div className="location-text">Location: %APPDATA%\RitoShark\Jade\hashes</div>
                                </div>
                            ) : (
                                <div className="warning-text">
                                    ⚠ Missing {hashStatus?.missing.length ?? 0} hash file(s)
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Temporary Files Section - Excluded per request: "dont annd the temp folder stuff at all" */}
                    {/* <div className="settings-column">...</div> */}

                    {/* App Behavior & File Association Section */}
                    <div className="settings-column">
                        <h3>App Behavior</h3>
                        <div className="preferences-group">
                            <button
                                className={`toggle-button ${minimizeToTray ? 'enabled' : 'disabled'}`}
                                onClick={() => {
                                    const newVal = !minimizeToTray;
                                    setMinimizeToTray(newVal);
                                    savePreference('MinimizeToTray', newVal);
                                }}
                            >
                                Minimize to Tray: {minimizeToTray ? 'Enabled' : 'Disabled'}
                            </button>

                            <button
                                className={`toggle-button ${runAtStartup ? 'enabled' : 'disabled'}`}
                                onClick={async () => {
                                    const newVal = !runAtStartup;
                                    setRunAtStartup(newVal);
                                    try {
                                        await invoke('toggle_autostart', { enable: newVal });
                                    } catch (e) {
                                        console.error('Failed to toggle autostart', e);
                                        setRunAtStartup(!newVal); // revert on error
                                    }
                                }}
                            >
                                Run at Startup: {runAtStartup ? 'Enabled' : 'Disabled'}
                            </button>
                        </div>

                        <h3>File Association</h3>
                        <p className="description">Register Jade as a handler for .bin files.</p>

                        <button className="action-button blue" onClick={async () => {
                            try {
                                await invoke('register_bin_association');
                                setIsRegistered(true);
                            } catch (e) {
                                console.error('Failed to register .bin association', e);
                            }
                        }}>
                            Register .bin
                        </button>

                        <button className="action-button red" onClick={async () => {
                            try {
                                await invoke('unregister_bin_association');
                                setIsRegistered(false);
                            } catch (e) {
                                console.error('Failed to unregister .bin association', e);
                            }
                        }}>
                            Unregister
                        </button>

                        {isRegistered && (
                            <div className="success-text" style={{ marginTop: '10px' }}>
                                ✓ Jade is registered as a .bin file handler.
                            </div>
                        )}
                    </div>
                </div>

                <div className="settings-footer">
                    <button className="action-button green" onClick={() => invoke('restart_app').catch(() => window.location.reload())}>
                        Restart App
                    </button>
                    <button className="action-button gray" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsDialog;
