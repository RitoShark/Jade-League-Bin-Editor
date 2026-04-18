import { LibraryIcon } from './Icons';
import './WelcomeScreen.css';

interface WelcomeScreenProps {
    onOpenFile: () => void;
    openFileDisabled?: boolean;
    recentFiles?: string[];
    onOpenRecentFile?: (path: string) => void;
    onMaterialLibrary?: () => void;
    appIcon?: string;
}

// Folder icon — stays local since it's only used here
function FolderIcon({ size = 28 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M20 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    );
}

function FileIcon({ size = 28 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    );
}

export default function WelcomeScreen({
    onOpenFile,
    openFileDisabled = false,
    recentFiles = [],
    onOpenRecentFile,
    onMaterialLibrary,
    appIcon,
}: WelcomeScreenProps) {
    const handleOpenModFolder = () => {
        // TODO(welcome): wire up to a real mod folder workspace once that
        // feature lands. For now, fall back to opening a single bin.
        onOpenFile();
    };

    return (
        <div className="welcome-screen">
            <div className="welcome-card">
                {/* Header: logo + title */}
                <div className="welcome-card-header">
                    <img src={appIcon || "/media/jadejade.png"} alt="Jade" className="welcome-logo" />
                    <div className="welcome-title-block">
                        <h1 className="welcome-title">JADE</h1>
                        <span className="welcome-subtitle">League BIN Editor</span>
                    </div>
                </div>

                {/* Three primary actions */}
                <div className="welcome-actions">
                    <button
                        className="welcome-action"
                        onClick={handleOpenModFolder}
                        disabled={openFileDisabled}
                        title="Coming soon — opens a mod folder workspace"
                    >
                        <FolderIcon size={28} />
                        <span className="welcome-action-label">Open Mod Folder</span>
                        <span className="welcome-action-desc">Workspace view (coming soon)</span>
                    </button>

                    <button
                        className="welcome-action"
                        onClick={onOpenFile}
                        disabled={openFileDisabled}
                    >
                        <FileIcon size={28} />
                        <span className="welcome-action-label">Open Bin</span>
                        <span className="welcome-action-desc">Open a .bin file (Ctrl+O)</span>
                    </button>

                    <button
                        className="welcome-action"
                        onClick={() => onMaterialLibrary?.()}
                        disabled={!onMaterialLibrary}
                    >
                        <LibraryIcon size={28} />
                        <span className="welcome-action-label">Material Library</span>
                        <span className="welcome-action-desc">Browse and download materials</span>
                    </button>
                </div>

                {/* Recent files list */}
                {recentFiles.length > 0 && (
                    <div className="welcome-recent">
                        <div className="welcome-recent-header">
                            <span>Recent files</span>
                            {recentFiles.length > 10 && (
                                <span className="welcome-recent-count">
                                    {recentFiles.length} total
                                </span>
                            )}
                        </div>
                        <div className="welcome-recent-list">
                            {recentFiles.slice(0, 10).map((filePath, i) => {
                                const parts = filePath.replace(/\\/g, '/').split('/');
                                const fileName = parts.pop() || filePath;
                                const dir = parts.join('/');
                                return (
                                    <button
                                        key={i}
                                        className="welcome-recent-row"
                                        onClick={() => onOpenRecentFile?.(filePath)}
                                        title={filePath}
                                    >
                                        <span className="welcome-recent-name">{fileName}</span>
                                        <span className="welcome-recent-path">{dir}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
