import { useState, useRef, useEffect } from 'react';
import './WelcomeScreen.css';

interface WelcomeScreenProps {
    onOpenFile: () => void;
    openFileDisabled?: boolean;
    recentFiles?: string[];
    onOpenRecentFile?: (path: string) => void;
}

export default function WelcomeScreen({ onOpenFile, openFileDisabled = false, recentFiles = [], onOpenRecentFile }: WelcomeScreenProps) {
    const [showRecent, setShowRecent] = useState(false);
    const recentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
                setShowRecent(false);
            }
        };
        if (showRecent) document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [showRecent]);

    return (
        <div className="welcome-screen">
            <div className="welcome-container" ref={recentRef}>
                <div className="welcome-content">
                    <h1 className="welcome-title">Jade BIN Editor</h1>
                    <p className="welcome-subtitle">Open a bin file to start editing</p>

                    <button className="welcome-open-btn" onClick={onOpenFile} disabled={openFileDisabled}>
                        <span>Open File</span>
                        <span className="shortcut">Ctrl+O</span>
                    </button>

                    <div className="welcome-hints">
                        <div className="hint">
                            <span className="hint-key">Ctrl+O</span>
                            <span className="hint-desc">Open file</span>
                        </div>
                        <div className="hint">
                            <span className="hint-key">Ctrl+S</span>
                            <span className="hint-desc">Save file</span>
                        </div>
                        <div className="hint">
                            <span className="hint-key">Ctrl+F</span>
                            <span className="hint-desc">Find</span>
                        </div>
                        <div className="hint">
                            <span className="hint-key">Ctrl+H</span>
                            <span className="hint-desc">Replace</span>
                        </div>
                    </div>

                    {recentFiles.length > 0 && (
                        <div className="welcome-recent-toggle">
                            <button
                                className="welcome-recent-btn"
                                onClick={() => setShowRecent(v => !v)}
                            >
                                Recent Files
                            </button>
                        </div>
                    )}
                </div>

                {recentFiles.length > 0 && showRecent && (
                    <div className="welcome-recent-popup">
                        {recentFiles.slice(0, 10).map((filePath, i) => {
                            const parts = filePath.replace(/\\/g, '/').split('/');
                            const fileName = parts.pop() || filePath;
                            const dir = parts.join('/');
                            return (
                                <button
                                    key={i}
                                    className="welcome-recent-item"
                                    onClick={() => {
                                        onOpenRecentFile?.(filePath);
                                        setShowRecent(false);
                                    }}
                                    title={filePath}
                                >
                                    <span className="welcome-recent-name">{fileName}</span>
                                    <span className="welcome-recent-path">{dir}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
