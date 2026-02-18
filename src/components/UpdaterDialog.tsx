import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './UpdaterDialog.css';

interface UpdateInfo {
    available: boolean;
    version: string;
    notes: string;
    download_url: string;
}

interface UpdaterDialogProps {
    isOpen: boolean;
    onClose: () => void;
    updateInfo?: UpdateInfo | null;
}

export default function UpdaterDialog({ isOpen, onClose, updateInfo }: UpdaterDialogProps) {
    const [installing, setInstalling] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    useEffect(() => {
        if (!isOpen) {
            setInstalling(false);
            setError(null);
            setDone(false);
        }
    }, [isOpen]);

    if (!isOpen || !updateInfo) return null;

    const handleInstall = async () => {
        setInstalling(true);
        setError(null);
        try {
            await invoke('install_update');
            setDone(true);
        } catch (e) {
            setError(String(e));
            setInstalling(false);
        }
    };

    return (
        <div className="dialog-overlay" onClick={onClose}>
            <div className="updater-dialog" onClick={e => e.stopPropagation()}>
                <div className="updater-header">
                    <span className="updater-icon">🚀</span>
                    <h2>Update Available</h2>
                    <button className="dialog-close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="updater-body">
                    {done ? (
                        <div className="updater-done">
                            <span className="done-icon">✅</span>
                            <p>Update installed! Please restart Jade to apply the update.</p>
                        </div>
                    ) : (
                        <>
                            <div className="version-info">
                                <span className="version-label">New version:</span>
                                <span className="version-number">{updateInfo.version}</span>
                            </div>

                            {updateInfo.notes && (
                                <div className="release-notes">
                                    <h3>Release Notes</h3>
                                    <pre className="notes-content">{updateInfo.notes}</pre>
                                </div>
                            )}

                            {error && (
                                <div className="updater-error">
                                    <span>⚠️ {error}</span>
                                </div>
                            )}

                            <div className="updater-actions">
                                <button
                                    className="btn-install"
                                    onClick={handleInstall}
                                    disabled={installing}
                                >
                                    {installing ? (
                                        <>
                                            <span className="spinner" />
                                            Downloading...
                                        </>
                                    ) : (
                                        'Install Update'
                                    )}
                                </button>
                                <button className="btn-later" onClick={onClose} disabled={installing}>
                                    Later
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
