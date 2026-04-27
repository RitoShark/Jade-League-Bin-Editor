import { useState, type ReactNode } from 'react';
import {
    SearchIcon, ReplaceIcon, EditIcon, SparklesIcon, LibraryIcon,
    PaletteIcon, SettingsIcon, HelpIcon, PencilIcon, ChevronRightIcon,
} from '../components/Icons';
import { useShell } from './ShellContext';

type RibbonTab = 'file' | 'home' | 'insert' | 'view' | 'help';

interface RibbonButtonProps {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    title?: string;
    large?: boolean;
}

function RibbonButton({ label, icon, onClick, active, disabled, title, large }: RibbonButtonProps) {
    return (
        <button
            type="button"
            className={`ribbon-btn${large ? ' ribbon-btn-lg' : ''}${active ? ' active' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={title ?? label}
        >
            {icon && <span className="ribbon-btn-icon">{icon}</span>}
            <span className="ribbon-btn-label">{label}</span>
        </button>
    );
}

function RibbonGroup({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="ribbon-group">
            <div className="ribbon-group-content">{children}</div>
            <div className="ribbon-group-title">{title}</div>
        </div>
    );
}

/**
 * MS-Word-style ribbon: category tabs across the top, large action
 * buttons grouped underneath. Each "tool" the app offers has a button
 * that opens it as its own panel/window — no menus.
 */
export default function RibbonBar() {
    const s = useShell();
    const [activeTab, setActiveTab] = useState<RibbonTab>('home');
    const [showRecent, setShowRecent] = useState(false);

    const binDisabled = !s.isBinFileOpen();

    return (
        <div className="ribbon-bar">
            <div className="ribbon-tabs">
                {(['file', 'home', 'insert', 'view', 'help'] as RibbonTab[]).map(t => (
                    <button
                        key={t}
                        type="button"
                        className={`ribbon-tab${activeTab === t ? ' active' : ''}${t === 'file' ? ' ribbon-tab-file' : ''}`}
                        onClick={() => setActiveTab(t)}
                    >
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                ))}
            </div>

            {activeTab === 'file' && (
                <div className="ribbon-body">
                    <RibbonGroup title="New / Open">
                        <RibbonButton large label="New" onClick={s.onNew} title="New file (Ctrl+N)" />
                        <RibbonButton
                            large label="Open"
                            onClick={s.onOpen}
                            disabled={s.openFileDisabled}
                            title="Open file..."
                        />
                        <div className="ribbon-recent-wrap">
                            <RibbonButton
                                label="Recent"
                                onClick={() => setShowRecent(v => !v)}
                                icon={<ChevronRightIcon size={12} />}
                                title="Recent files"
                            />
                            {showRecent && s.recentFiles.length > 0 && (
                                <div className="ribbon-recent-pop" onMouseLeave={() => setShowRecent(false)}>
                                    {s.recentFiles.slice(0, 10).map((p, i) => {
                                        const fileName = p.split(/[\\/]/).pop() || p;
                                        return (
                                            <button
                                                key={i}
                                                type="button"
                                                className="ribbon-recent-item"
                                                title={p}
                                                disabled={s.openFileDisabled}
                                                onClick={() => { setShowRecent(false); s.openFileFromPath(p); }}
                                            >
                                                {fileName}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </RibbonGroup>

                    <RibbonGroup title="Save">
                        <RibbonButton large label="Save" onClick={s.onSave} title="Save (Ctrl+S)" />
                        <RibbonButton large label="Save As" onClick={s.onSaveAs} title="Save As (Ctrl+Shift+S)" />
                    </RibbonGroup>

                    <RibbonGroup title="Logs">
                        <RibbonButton label="Open Log" onClick={s.onOpenLog} />
                    </RibbonGroup>

                    <RibbonGroup title="App">
                        <RibbonButton label="Exit" onClick={s.onClose} />
                    </RibbonGroup>
                </div>
            )}

            {activeTab === 'home' && (
                <div className="ribbon-body">
                    <RibbonGroup title="Clipboard">
                        <RibbonButton label="Cut" onClick={s.onCut} title="Cut (Ctrl+X)" />
                        <RibbonButton label="Copy" onClick={s.onCopy} title="Copy (Ctrl+C)" />
                        <RibbonButton label="Paste" onClick={s.onPaste} title="Paste (Ctrl+V)" />
                    </RibbonGroup>

                    <RibbonGroup title="History">
                        <RibbonButton label="Undo" onClick={s.onUndo} title="Undo (Ctrl+Z)" />
                        <RibbonButton label="Redo" onClick={s.onRedo} title="Redo (Ctrl+Y)" />
                    </RibbonGroup>

                    <RibbonGroup title="Find">
                        <RibbonButton
                            large
                            label="Find"
                            icon={<SearchIcon size={20} />}
                            onClick={s.onFind}
                            active={s.findWidgetOpen}
                            title="Find (Ctrl+F)"
                        />
                        <RibbonButton
                            large
                            label="Replace"
                            icon={<ReplaceIcon size={20} />}
                            onClick={s.onReplace}
                            active={s.replaceWidgetOpen}
                            title="Replace (Ctrl+H)"
                        />
                    </RibbonGroup>

                    <RibbonGroup title="Selection">
                        <RibbonButton label="Select All" onClick={s.onSelectAll} title="Select All (Ctrl+A)" />
                        <RibbonButton label="Compare Files" onClick={s.onCompareFiles} title="Compare Files (Ctrl+D)" />
                    </RibbonGroup>
                </div>
            )}

            {activeTab === 'insert' && (
                <div className="ribbon-body">
                    <RibbonGroup title="Editing Tools">
                        <RibbonButton
                            large
                            label="General Edit"
                            icon={<EditIcon size={20} />}
                            onClick={s.onGeneralEdit}
                            active={s.generalEditPanelOpen}
                            title="General Editing (Ctrl+O)"
                        />
                        <RibbonButton
                            large
                            label="Particle"
                            icon={<SparklesIcon size={20} />}
                            onClick={s.onParticlePanel}
                            active={s.particlePanelOpen}
                            disabled={binDisabled}
                            title={binDisabled ? 'Particle editing only works on .bin or .py files' : 'Particle Editing (Ctrl+P)'}
                        />
                        <RibbonButton
                            label="Particle Window"
                            icon={<SparklesIcon size={16} />}
                            onClick={s.onParticleEditor}
                            disabled={binDisabled}
                            title={binDisabled ? 'Open as a separate window — bin/py only' : 'Open particle editor as a window'}
                        />
                    </RibbonGroup>

                    <RibbonGroup title="Material">
                        <RibbonButton
                            large
                            label="Material Library"
                            icon={<LibraryIcon size={20} />}
                            onClick={s.onMaterialLibrary}
                        />
                    </RibbonGroup>

                    <RibbonGroup title="Quartz">
                        <RibbonButton label="Send: Paint" onClick={() => s.onSendToQuartz('paint')} disabled={binDisabled} />
                        <RibbonButton label="Send: Port" onClick={() => s.onSendToQuartz('port')} disabled={binDisabled} />
                        <RibbonButton label="Send: BIN Editor" onClick={() => s.onSendToQuartz('bineditor')} disabled={binDisabled} />
                        <RibbonButton label="Send: VFX Hub" onClick={() => s.onSendToQuartz('vfxhub')} disabled={binDisabled} />
                    </RibbonGroup>
                </div>
            )}

            {activeTab === 'view' && (
                <div className="ribbon-body">
                    <RibbonGroup title="Themes">
                        <RibbonButton
                            large
                            label="Themes"
                            icon={<PaletteIcon size={20} />}
                            onClick={s.onThemes}
                        />
                    </RibbonGroup>

                    <RibbonGroup title="App">
                        <RibbonButton
                            large
                            label="Settings"
                            icon={<SettingsIcon size={20} />}
                            onClick={s.onSettings}
                        />
                        <RibbonButton
                            label="Preferences"
                            icon={<PencilIcon size={16} />}
                            onClick={s.onPreferences}
                        />
                    </RibbonGroup>
                </div>
            )}

            {activeTab === 'help' && (
                <div className="ribbon-body">
                    <RibbonGroup title="About">
                        <RibbonButton
                            large
                            label="About Jade"
                            icon={<HelpIcon size={20} />}
                            onClick={s.onAbout}
                        />
                    </RibbonGroup>
                </div>
            )}
        </div>
    );
}
