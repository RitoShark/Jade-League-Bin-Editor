import { useEffect, useRef, useState } from 'react';
import {
    SearchIcon, EditIcon, SparklesIcon, LibraryIcon,
    PaletteIcon, SettingsIcon, HelpIcon, ImageIcon, PencilIcon, QuartzIcon,
} from '../components/Icons';
import { ListOrdered, Wallpaper, View, Camera, Clapperboard, Map, Spotlight as SpotlightIcon, FolderTree, FolderOpen as FolderOpenIcon, Package as PackageIcon } from 'lucide-react';
import { useShell } from './ShellContext';

interface ToolbarBtnProps {
    title: string;
    onClick: () => void;
    icon: React.ReactNode;
    active?: boolean;
    disabled?: boolean;
}

function ToolbarBtn({ title, onClick, icon, active, disabled }: ToolbarBtnProps) {
    return (
        <button
            type="button"
            className={`vs-toolbar-btn${active ? ' active' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-label={title}
        >
            {icon}
        </button>
    );
}

/**
 * Visual Studio quick-action toolbar — sits between MenuBar and the
 * editor body. Mirrors VS's small-icon toolbar with grouped actions
 * separated by vertical dividers. Hover for full label.
 */
export default function VSToolbar() {
    const s = useShell();
    const isAssetList = s.isAssetListTab();
    // Texture-insert is available on BIN tabs (regular flow) and on
    // scanned-assets markdown reports (gallery-view flow). All other
    // editor tab types stay disabled.
    const binDisabled = !s.isBinFileOpen() && !isAssetList;
    const materialBinDisabled = !s.isBinFileOpen();
    const isStudio = s.activeTab?.tabType === 'studio';

    // Send-to-Quartz dropdown — same set of actions as the Classic
    // shell's TitleBar menu, just rendered inline on the VS toolbar.
    const [quartzOpen, setQuartzOpen] = useState(false);
    const quartzRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!quartzOpen) return;
        const onDown = (e: MouseEvent) => {
            if (!quartzRef.current?.contains(e.target as Node)) setQuartzOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [quartzOpen]);

    // Studio mode replaces the BIN-editor toolbar with toggles for
    // the four studio panels (Pose / Background / Mesh / Photo). The
    // right-edge cluster (themes / preferences / settings / about)
    // stays because those are app-wide, not tab-scoped.
    if (isStudio) {
        return (
            <div className="vs-toolbar">
                <ToolbarBtn
                    title="File Explorer"
                    onClick={() => s.setFileExplorerOpen(!s.fileExplorerOpen)}
                    icon={<FolderTree size={15} />}
                    active={s.fileExplorerOpen}
                />
                <ToolbarBtn
                    title="Open Folder…"
                    onClick={s.onOpenFolder}
                    icon={<FolderOpenIcon size={15} />}
                />
                <ToolbarBtn
                    title="Open WAD in Explorer…"
                    onClick={s.onOpenWadInExplorer}
                    icon={<PackageIcon size={15} />}
                />
                <div className="vs-toolbar-sep" />
                <ToolbarBtn
                    title="Objects panel"
                    onClick={() => s.setStudioObjectsOpen(!s.studioObjectsOpen)}
                    icon={<ListOrdered size={15} />}
                    active={s.studioObjectsOpen}
                />
                <ToolbarBtn
                    title="Pose panel"
                    onClick={() => s.setStudioAnimOpen(!s.studioAnimOpen)}
                    icon={<Clapperboard size={15} />}
                    active={s.studioAnimOpen}
                />
                <ToolbarBtn
                    title="Background panel"
                    onClick={() => s.setStudioBgOpen(!s.studioBgOpen)}
                    icon={<Wallpaper size={15} />}
                    active={s.studioBgOpen}
                />
                <ToolbarBtn
                    title="Mesh + textures panel"
                    onClick={() => s.setStudioMeshOpen(!s.studioMeshOpen)}
                    icon={<View size={15} />}
                    active={s.studioMeshOpen}
                />
                <ToolbarBtn
                    title="Photo capture panel"
                    onClick={() => s.setStudioActionsOpen(!s.studioActionsOpen)}
                    icon={<Camera size={15} />}
                    active={s.studioActionsOpen}
                />
                <ToolbarBtn
                    title="Lighting panel"
                    onClick={() => s.setStudioSpotlightOpen(!s.studioSpotlightOpen)}
                    icon={<SpotlightIcon size={15} />}
                    active={s.studioSpotlightOpen}
                />

                <div className="vs-toolbar-spacer" />

                <ToolbarBtn title="Themes" onClick={s.onThemes} icon={<PaletteIcon size={15} />} />
                <ToolbarBtn title="Preferences" onClick={s.onPreferences} icon={<PencilIcon size={15} />} />
                <ToolbarBtn title="Settings" onClick={s.onSettings} icon={<SettingsIcon size={15} />} />
                <ToolbarBtn title="About" onClick={s.onAbout} icon={<HelpIcon size={15} />} />
            </div>
        );
    }

    return (
        <div className="vs-toolbar">
            <div style={{ display: 'inline-flex' }}>
                <ToolbarBtn
                    title="File Explorer"
                    onClick={() => s.setFileExplorerOpen(!s.fileExplorerOpen)}
                    icon={<FolderTree size={15} />}
                    active={s.fileExplorerOpen}
                />
                <ToolbarBtn
                    title="Open Folder…"
                    onClick={s.onOpenFolder}
                    icon={<FolderOpenIcon size={15} />}
                />
                <ToolbarBtn
                    title="Open WAD in Explorer…"
                    onClick={s.onOpenWadInExplorer}
                    icon={<PackageIcon size={15} />}
                />
            </div>
            <div className="vs-toolbar-sep" />
            <div data-guide-id="find-btn" style={{ display: 'inline-flex' }}>
                {/* Magnifier opens the combined Find+Replace panel —
                    the dedicated Replace icon was redundant and got
                    pulled. Ctrl+H still routes to `onReplace` so the
                    shortcut path remains a no-op duplicate of Find. */}
                <ToolbarBtn title="Find / Replace (Ctrl+F)" onClick={s.onFind} icon={<SearchIcon size={15} />} active={s.replaceWidgetOpen} />
            </div>

            <div className="vs-toolbar-sep" />

            <div data-guide-id="bin-tools" style={{ display: 'flex', alignItems: 'center' }}>
                <ToolbarBtn
                    title="General Editing (Ctrl+O)"
                    onClick={s.onGeneralEdit}
                    icon={<EditIcon size={15} />}
                    active={s.generalEditPanelOpen}
                />
                {/* Sub-icons next to General Editing — dockable insert tools
                    that mirror the modal flows inside General Editing's
                    Material Override section, but as draggable modules. */}
                <ToolbarBtn
                    title={binDisabled
                        ? 'Texture Insert (bin only)'
                        : (isAssetList ? 'Show asset gallery' : 'Texture Insert')}
                    onClick={s.onTextureInsert}
                    icon={<ImageIcon size={14} />}
                    active={s.textureInsertOpen}
                    disabled={binDisabled}
                />
                <ToolbarBtn
                    title={materialBinDisabled ? 'Material Insert (bin only)' : 'Material Insert'}
                    onClick={s.onMaterialInsert}
                    icon={<PencilIcon size={14} />}
                    active={s.materialInsertOpen}
                    disabled={materialBinDisabled}
                />
                <ToolbarBtn
                    title={materialBinDisabled ? 'Particle Editing (bin/py only)' : 'Particle Editing (Ctrl+P)'}
                    onClick={s.onParticlePanel}
                    icon={<SparklesIcon size={15} />}
                    active={s.particlePanelOpen}
                    disabled={materialBinDisabled}
                />
                <ToolbarBtn
                    title={materialBinDisabled ? 'Bin Navigation (bin only)' : 'Bin Navigation'}
                    onClick={s.onBinNav}
                    icon={<Map size={15} />}
                    active={s.binNavOpen}
                    disabled={materialBinDisabled}
                />
                <ToolbarBtn title="Material Library" onClick={s.onMaterialLibrary} icon={<LibraryIcon size={15} />} />

                {/* Send to Quartz — dropdown with the same 4 actions the
                    Classic shell's title-bar menu offers. */}
                <div className="vs-toolbar-menu-wrap" ref={quartzRef}>
                    <button
                        type="button"
                        className={`vs-toolbar-btn${quartzOpen ? ' active' : ''}`}
                        onClick={() => setQuartzOpen(o => !o)}
                        title="Send to Quartz"
                        aria-label="Send to Quartz"
                    >
                        <QuartzIcon size={15} />
                    </button>
                    {quartzOpen && (
                        <div className="vs-toolbar-menu-popup">
                            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('paint'); }}>Paint In Quartz</button>
                            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('port'); }}>Port In Quartz</button>
                            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('bineditor'); }}>Open In BinEditor</button>
                            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('vfxhub'); }}>Open In VFXHub</button>
                        </div>
                    )}
                </div>
            </div>

            <div className="vs-toolbar-spacer" />

            <div data-guide-id="right-buttons" style={{ display: 'flex', alignItems: 'center' }}>
                <ToolbarBtn title="Themes" onClick={s.onThemes} icon={<PaletteIcon size={15} />} />
                <ToolbarBtn title="Preferences" onClick={s.onPreferences} icon={<PencilIcon size={15} />} />
                <ToolbarBtn title="Settings" onClick={s.onSettings} icon={<SettingsIcon size={15} />} />
                <ToolbarBtn title="About" onClick={s.onAbout} icon={<HelpIcon size={15} />} />
            </div>
        </div>
    );
}
