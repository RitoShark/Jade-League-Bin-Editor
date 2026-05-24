import { useState } from 'react';
import { Map as MapIcon } from 'lucide-react';
import './MenuBar.css';
import { SearchIcon, ReplaceIcon, EditIcon, SparklesIcon, ChevronRightIcon } from './Icons';

interface MenuBarProps {
    findActive?: boolean;
    replaceActive?: boolean;
    generalEditActive?: boolean;
    particlePanelActive?: boolean;
    binNavActive?: boolean;
    /** When true, the Particle Editing button is greyed out and ignores
     *  clicks. Used to disable the feature for non-bin/.py tabs (markdown,
     *  json, etc.) where it would have nothing to operate on. */
    particleDisabled?: boolean;
    onNewFile: () => void;
    onNewStudioScene?: () => void;
    onOpenStudioScene?: () => void;
    onOpenFile: () => void;
    /** Open a folder root in the File Explorer pane. Optional — when
     *  omitted (legacy callers) the menu item is hidden. */
    onOpenFolder?: () => void;
    /** Pick a `.wad` / `.wad.client` to mount as the explorer root. */
    onOpenWadInExplorer?: () => void;
    onSaveFile: () => void;
    onSaveFileAs: () => void;
    /** Save every editor tab with unsaved changes in one shot. */
    onSaveAll: () => void;
    onOpenLog: () => void;
    onExit: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onCut: () => void;
    onCopy: () => void;
    onPaste: () => void;
    onFind: () => void;
    onReplace: () => void;
    onCompareFiles: () => void;
    onScanBinAssets: () => void;
    /** True when the active tab isn't a BIN — disables Scan BIN Assets. */
    scanBinAssetsDisabled?: boolean;
    onSelectAll: () => void;
    onGeneralEdit: () => void;
    onParticlePanel: () => void;
    onBinNav: () => void;
    onThemes: () => void;
    onSettings: () => void;
    onAbout: () => void;
    onMaterialLibrary: () => void;
    recentFiles?: string[];
    onOpenRecentFile?: (path: string) => void;
    openFileDisabled?: boolean;
    onMainPage?: () => void;
}

export default function MenuBar({
    findActive = false,
    replaceActive = false,
    generalEditActive = false,
    particlePanelActive = false,
    binNavActive = false,
    particleDisabled = false,
    onNewFile,
    onNewStudioScene,
    onOpenStudioScene,
    onOpenFile,
    onOpenFolder,
    onOpenWadInExplorer,
    onSaveFile,
    onSaveFileAs,
    onSaveAll,
    onOpenLog,
    onExit,
    onUndo,
    onRedo,
    onCut,
    onCopy,
    onPaste,
    onFind,
    onReplace,
    onCompareFiles,
    onScanBinAssets,
    scanBinAssetsDisabled = false,
    onSelectAll,
    onGeneralEdit,
    onParticlePanel,
    onBinNav,
    onThemes,
    onSettings,
    onAbout,
    onMaterialLibrary,
    recentFiles = [],
    onOpenRecentFile,
    openFileDisabled = false,
    onMainPage,
}: MenuBarProps) {
    const [activeMenu, setActiveMenu] = useState<string | null>(null);

    const toggleMenu = (menu: string) => {
        setActiveMenu(activeMenu === menu ? null : menu);
    };

    const closeMenu = () => {
        setActiveMenu(null);
    };

    const handleMenuClick = (callback: () => void) => {
        callback();
        closeMenu();
    };

    return (
        <div className="menu-bar">
            {/* File Menu */}
            <div className="menu-item">
                <button
                    className={`menu-trigger ${activeMenu === 'file' ? 'active' : ''}`}
                    onClick={() => toggleMenu('file')}
                >
                    File
                </button>
                {activeMenu === 'file' && (
                    <div className="menu-dropdown">
                        <button className="menu-option" onClick={() => handleMenuClick(onNewFile)}>
                            <span>New</span>
                            <span className="shortcut">Ctrl+N</span>
                        </button>
                        {onNewStudioScene && (
                            <button className="menu-option" onClick={() => handleMenuClick(onNewStudioScene)}>
                                <span>New Studio Scene</span>
                            </button>
                        )}
                        {onOpenStudioScene && (
                            <button className="menu-option" onClick={() => handleMenuClick(onOpenStudioScene)}>
                                <span>Open Studio Scene...</span>
                            </button>
                        )}
                        <button className="menu-option" onClick={() => handleMenuClick(onOpenFile)} disabled={openFileDisabled}>
                            <span>Open...</span>
                        </button>
                        {onOpenFolder && (
                            <button className="menu-option" onClick={() => handleMenuClick(onOpenFolder)}>
                                <span>Open Folder...</span>
                            </button>
                        )}
                        {onOpenWadInExplorer && (
                            <button className="menu-option" onClick={() => handleMenuClick(onOpenWadInExplorer)}>
                                <span>Open WAD in Explorer...</span>
                            </button>
                        )}

                        <div className="menu-item-with-submenu">
                            <button className="menu-option">
                                <span>Recent Files</span>
                                <span className="submenu-arrow"><ChevronRightIcon size={12} /></span>
                            </button>
                            {recentFiles.length > 0 && (
                                <div className="menu-submenu">
                                    {recentFiles.slice(0, 10).map((filePath, index) => {
                                        const fileName = filePath.split(/[\\/]/).pop() || filePath;
                                        return (
                                            <button
                                                key={index}
                                                className="menu-option recent-file-option"
                                                disabled={openFileDisabled}
                                                onClick={() => onOpenRecentFile && handleMenuClick(() => onOpenRecentFile(filePath))}
                                                title={filePath}
                                            >
                                                <span className="recent-file-name">{fileName}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onSaveFile)}>
                            <span>Save</span>
                            <span className="shortcut">Ctrl+S</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onSaveFileAs)}>
                            <span>Save As...</span>
                            <span className="shortcut">Ctrl+Shift+S</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onSaveAll)}>
                            <span>Save All</span>
                            <span className="shortcut">Ctrl+Alt+S</span>
                        </button>
                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onOpenLog)}>
                            <span>Open Log File</span>
                        </button>
                        <div className="menu-separator" />
                        {onMainPage && (
                            <button className="menu-option" onClick={() => handleMenuClick(onMainPage)}>
                                <span>Main page</span>
                            </button>
                        )}
                        <button className="menu-option" onClick={() => handleMenuClick(onExit)}>
                            <span>Exit</span>
                        </button>
                    </div>
                )}
            </div>

            {/* Edit Menu */}
            <div className="menu-item">
                <button
                    className={`menu-trigger ${activeMenu === 'edit' ? 'active' : ''}`}
                    onClick={() => toggleMenu('edit')}
                >
                    Edit
                </button>
                {activeMenu === 'edit' && (
                    <div className="menu-dropdown">
                        <button className="menu-option" onClick={() => handleMenuClick(onUndo)}>
                            <span>Undo</span>
                            <span className="shortcut">Ctrl+Z</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onRedo)}>
                            <span>Redo</span>
                            <span className="shortcut">Ctrl+Y</span>
                        </button>
                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onCut)}>
                            <span>Cut</span>
                            <span className="shortcut">Ctrl+X</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onCopy)}>
                            <span>Copy</span>
                            <span className="shortcut">Ctrl+C</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onPaste)}>
                            <span>Paste</span>
                            <span className="shortcut">Ctrl+V</span>
                        </button>
                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onFind)}>
                            <span>Find...</span>
                            <span className="shortcut">Ctrl+F</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onReplace)}>
                            <span>Replace...</span>
                            <span className="shortcut">Ctrl+H</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onCompareFiles)}>
                            <span>Compare Files...</span>
                            <span className="shortcut">Ctrl+D</span>
                        </button>
                        <button
                            className="menu-option"
                            onClick={() => handleMenuClick(onScanBinAssets)}
                            disabled={scanBinAssetsDisabled}
                            title={scanBinAssetsDisabled ? 'Open a BIN file to scan its assets' : 'Walk this BIN and its linked BINs, list every referenced asset'}
                        >
                            <span>Scan BIN Assets...</span>
                        </button>
                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onSelectAll)}>
                            <span>Select All</span>
                            <span className="shortcut">Ctrl+A</span>
                        </button>
                    </div>
                )}
            </div>

            {/* Tools Menu */}
            <div className="menu-item">
                <button
                    className={`menu-trigger ${activeMenu === 'tools' ? 'active' : ''}`}
                    onClick={() => toggleMenu('tools')}
                >
                    Tools
                </button>
                {activeMenu === 'tools' && (
                    <div className="menu-dropdown">
                        <button className="menu-option" onClick={() => handleMenuClick(onGeneralEdit)}>
                            <span>General Editing...</span>
                            <span className="shortcut">Ctrl+O</span>
                        </button>
                        <button
                            className="menu-option"
                            onClick={() => handleMenuClick(onParticlePanel)}
                            disabled={particleDisabled}
                            title={particleDisabled ? 'Particle editing only works on .bin or .py files' : undefined}
                        >
                            <span>Particle Editing...</span>
                            <span className="shortcut">Ctrl+P</span>
                        </button>
                        <button
                            className="menu-option"
                            onClick={() => handleMenuClick(onBinNav)}
                            disabled={particleDisabled}
                            title={particleDisabled ? 'Bin Navigation only works on .bin or .py files' : undefined}
                        >
                            <span>Bin Navigation...</span>
                        </button>
                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onMaterialLibrary)}>
                            <span>Material Library...</span>
                        </button>
                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onThemes)}>
                            <span>Themes...</span>
                        </button>
                        <button className="menu-option" onClick={() => handleMenuClick(onSettings)}>
                            <span>Settings...</span>
                        </button>
                        <div className="menu-separator" />
                        <button className="menu-option" onClick={() => handleMenuClick(onAbout)}>
                            <span>About Jade</span>
                        </button>
                    </div>
                )}
            </div>

            {/* Spacer to push buttons to right */}
            <div style={{ flex: 1 }} />

            {/* Quick Find/Replace/Edit Buttons */}
            <button
                className={`menu-icon-btn ${findActive ? 'active' : ''}`}
                title="Find (Ctrl+F)"
                onClick={onFind}
            >
                <SearchIcon size={16} />
            </button>
            <button
                className={`menu-icon-btn ${replaceActive ? 'active' : ''}`}
                title="Replace (Ctrl+H)"
                onClick={onReplace}
            >
                <ReplaceIcon size={16} />
            </button>
            <button
                className={`menu-icon-btn ${generalEditActive ? 'active' : ''}`}
                title="General Editing (Ctrl+O)"
                onClick={onGeneralEdit}
            >
                <EditIcon size={16} />
            </button>
            <button
                className={`menu-icon-btn ${particlePanelActive ? 'active' : ''}`}
                title={particleDisabled ? 'Particle editing only works on .bin or .py files' : 'Particle Editing (Ctrl+P)'}
                onClick={onParticlePanel}
                disabled={particleDisabled}
            >
                <SparklesIcon size={16} />
            </button>
            <button
                className={`menu-icon-btn ${binNavActive ? 'active' : ''}`}
                title={particleDisabled ? 'Bin Navigation only works on .bin or .py files' : 'Bin Navigation'}
                onClick={onBinNav}
                disabled={particleDisabled}
            >
                <MapIcon size={16} />
            </button>
        </div>
    );
}
