import { useEffect, useRef, useState } from 'react';
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, ChevronRightIcon } from '../components/Icons';
import { SquareArrowRightEnter } from 'lucide-react';
import { useShell } from './ShellContext';

/**
 * Visual Studio-style title bar. Single row that hosts:
 *   icon · File / Edit / Tools (inline menu triggers) · spacer · window controls
 *
 * Replaces the standard TitleBar + MenuBar pair when the VS shell is
 * active. The "Jade — BIN Editor" wordmark is dropped (VS itself only
 * shows the project name, which we don't have a slot for yet).
 */
export default function VSTitleBar() {
    const s = useShell();
    const [openMenu, setOpenMenu] = useState<'file' | 'edit' | 'tools' | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!openMenu) return;
        const onDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenMenu(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [openMenu]);

    const close = () => setOpenMenu(null);
    const click = (cb: () => void) => () => { cb(); close(); };

    const recentFilesEnabled = !s.openFileDisabled && s.recentFiles.length > 0;
    const isAnimStudioActive = s.activeTab?.tabType === 'animstudio';

    return (
        <div className="vs-title-bar" ref={wrapRef}>
            <button
                type="button"
                className="vs-title-icon-btn"
                onClick={() => s.setWelcomeOverride('force')}
                title="Back to main page"
                data-guide-id="logo"
            >
                {/* Hover swaps the Jade logo for a mirrored
                    enter-arrow — visual symmetry with the welcome
                    screen's brand-as-editor-shortcut, signalling
                    "this jumps you back to the other side". */}
                <img
                    src={s.appIcon}
                    className="vs-title-icon vs-title-icon-default"
                    alt="Jade"
                    draggable={false}
                />
                <SquareArrowRightEnter
                    size={20}
                    className="vs-title-icon vs-title-icon-hover"
                />
            </button>

            <div className="vs-menu-row">
                {/* File */}
                <div className="vs-menu-item">
                    <button
                        type="button"
                        className={`vs-menu-trigger${openMenu === 'file' ? ' active' : ''}`}
                        onClick={() => setOpenMenu(openMenu === 'file' ? null : 'file')}
                    >
                        File
                    </button>
                    {openMenu === 'file' && (
                        <div className="vs-menu-dropdown">
                            <button className="vs-menu-option" onClick={click(s.onNew)}>
                                <span>New</span><span className="vs-shortcut">Ctrl+N</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onOpen)} disabled={s.openFileDisabled}>
                                <span>Open…</span>
                            </button>
                            <div className="vs-menu-submenu-host">
                                <button className="vs-menu-option" disabled={!recentFilesEnabled}>
                                    <span>Recent Files</span>
                                    <span className="vs-submenu-arrow"><ChevronRightIcon size={11} /></span>
                                </button>
                                {recentFilesEnabled && (
                                    <div className="vs-menu-submenu">
                                        {s.recentFiles.slice(0, 10).map((p, i) => {
                                            const fileName = p.split(/[\\/]/).pop() || p;
                                            return (
                                                <button
                                                    key={i}
                                                    className="vs-menu-option"
                                                    onClick={click(() => s.openFileFromPath(p))}
                                                    title={p}
                                                >
                                                    <span className="vs-recent-name">{fileName}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onSave)}>
                                <span>Save</span><span className="vs-shortcut">Ctrl+S</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onSaveAs)}>
                                <span>Save As…</span><span className="vs-shortcut">Ctrl+Shift+S</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onSaveAll)}>
                                <span>Save All</span><span className="vs-shortcut">Ctrl+Alt+S</span>
                            </button>
                            {isAnimStudioActive && (
                                <>
                                    <div className="vs-menu-separator" />
                                    <button
                                        className="vs-menu-option"
                                        onClick={click(() => { void s.onOpenAnimStudioScene(); })}
                                    >
                                        <span>Open Animation Studio Scene…</span>
                                    </button>
                                    <button
                                        className="vs-menu-option"
                                        onClick={click(() => { void s.onSaveAnimStudioScene(); })}
                                    >
                                        <span>Save Animation Studio Scene…</span>
                                    </button>
                                </>
                            )}
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onOpenLog)}>
                                <span>Open Log File</span>
                            </button>
                            <div className="vs-menu-separator" />
                            <button
                                className="vs-menu-option"
                                onClick={click(() => s.setWelcomeOverride('force'))}
                                title="Open Welcome / Main page"
                            >
                                <span>Main page</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onClose)}>
                                <span>Exit</span>
                            </button>
                        </div>
                    )}
                </div>

                {/* Edit */}
                <div className="vs-menu-item">
                    <button
                        type="button"
                        className={`vs-menu-trigger${openMenu === 'edit' ? ' active' : ''}`}
                        onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}
                    >
                        Edit
                    </button>
                    {openMenu === 'edit' && (
                        <div className="vs-menu-dropdown">
                            <button className="vs-menu-option" onClick={click(s.onUndo)}>
                                <span>Undo</span><span className="vs-shortcut">Ctrl+Z</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onRedo)}>
                                <span>Redo</span><span className="vs-shortcut">Ctrl+Y</span>
                            </button>
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onCut)}>
                                <span>Cut</span><span className="vs-shortcut">Ctrl+X</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onCopy)}>
                                <span>Copy</span><span className="vs-shortcut">Ctrl+C</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onPaste)}>
                                <span>Paste</span><span className="vs-shortcut">Ctrl+V</span>
                            </button>
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onFind)}>
                                <span>Find…</span><span className="vs-shortcut">Ctrl+F</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onReplace)}>
                                <span>Replace…</span><span className="vs-shortcut">Ctrl+H</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onCompareFiles)}>
                                <span>Compare Files…</span><span className="vs-shortcut">Ctrl+D</span>
                            </button>
                            <button
                                className="vs-menu-option"
                                onClick={click(s.onScanBinAssets)}
                                disabled={!s.isBinFileOpen()}
                                title={!s.isBinFileOpen() ? 'Open a BIN file to scan its assets' : 'Walk this BIN and its linked BINs, list every referenced asset'}
                            >
                                <span>Scan BIN Assets…</span>
                            </button>
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onSelectAll)}>
                                <span>Select All</span><span className="vs-shortcut">Ctrl+A</span>
                            </button>
                        </div>
                    )}
                </div>

                {/* Tools */}
                <div className="vs-menu-item">
                    <button
                        type="button"
                        className={`vs-menu-trigger${openMenu === 'tools' ? ' active' : ''}`}
                        onClick={() => setOpenMenu(openMenu === 'tools' ? null : 'tools')}
                    >
                        Tools
                    </button>
                    {openMenu === 'tools' && (
                        <div className="vs-menu-dropdown">
                            <button className="vs-menu-option" onClick={click(s.onGeneralEdit)}>
                                <span>General Editing…</span><span className="vs-shortcut">Ctrl+O</span>
                            </button>
                            <button
                                className="vs-menu-option"
                                onClick={click(s.onParticlePanel)}
                                disabled={!s.isBinFileOpen()}
                                title={!s.isBinFileOpen() ? 'Particle editing only works on .bin or .py files' : undefined}
                            >
                                <span>Particle Editing…</span><span className="vs-shortcut">Ctrl+P</span>
                            </button>
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onMaterialLibrary)}>
                                <span>Material Library…</span>
                            </button>
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onThemes)}>
                                <span>Themes…</span>
                            </button>
                            <button className="vs-menu-option" onClick={click(s.onSettings)}>
                                <span>Settings…</span>
                            </button>
                            <div className="vs-menu-separator" />
                            <button className="vs-menu-option" onClick={click(s.onAbout)}>
                                <span>About Jade</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* drag region (window-drag area) sits in the empty middle */}
            <div className="vs-title-spacer" />

            <div className="vs-window-controls">
                <button className="vs-control-btn" onClick={s.onMinimize} aria-label="Minimize"><MinimizeIcon size={14} /></button>
                <button className="vs-control-btn" onClick={s.onMaximize} aria-label={s.isMaximized ? 'Restore' : 'Maximize'}>
                    {s.isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
                </button>
                <button className="vs-control-btn vs-close-btn" onClick={s.onClose} aria-label="Close"><CloseIcon size={14} /></button>
            </div>
        </div>
    );
}
