import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    SearchIcon, EditIcon, SparklesIcon, LibraryIcon,
    PaletteIcon, SettingsIcon, HelpIcon, ImageIcon, PencilIcon, QuartzIcon,
} from '../components/Icons';
import { ListOrdered, Wallpaper, View, Camera, Clapperboard, Map, Spotlight as SpotlightIcon, FolderTree, FolderOpen as FolderOpenIcon, Package as PackageIcon, SlidersHorizontal, Network as NetworkIcon, Bone as BoneIcon, MapPin as PinIcon, Wind as WindIcon, ChevronRight as ChevronRightLucide, ChevronLeft as ChevronLeftLucide, Save as SaveIcon } from 'lucide-react';
import { useShell } from './ShellContext';
import { usePersistedBool, useSharedPersistedString } from '../lib/persistedState';

export type ToolbarOrientation = 'top' | 'left' | 'right';

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
    const isAnimStudio = s.activeTab?.tabType === 'animstudio';

    // Folder + WAD open buttons are hidden behind a chevron by default
    // — most users only need them when first attaching a workspace, so
    // they don't deserve permanent toolbar real estate. State is shared
    // across all three toolbar variants (default / studio / animstudio)
    // so flipping it in one mode carries through.
    const [folderBtnsOpen, setFolderBtnsOpen] = usePersistedBool('vstoolbar-folder-btns-open', false);
    const folderToggle = (
        <button
            type="button"
            className={`vs-toolbar-btn${folderBtnsOpen ? ' active' : ''}`}
            onClick={() => setFolderBtnsOpen(!folderBtnsOpen)}
            title={folderBtnsOpen ? 'Hide folder / WAD open buttons' : 'Show folder / WAD open buttons'}
            aria-label="Toggle folder buttons"
        >
            {folderBtnsOpen ? <ChevronLeftLucide size={13} /> : <ChevronRightLucide size={13} />}
        </button>
    );
    const folderBtns = folderBtnsOpen ? (
        <>
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
        </>
    ) : null;

    // Send-to-Quartz dropdown — same set of actions as the Classic
    // shell's TitleBar menu, just rendered inline on the VS toolbar.
    // The popup is portalled to <body> so it isn't clipped by the
    // vertical toolbar's overflow / stacking context.
    const [quartzOpen, setQuartzOpen] = useState(false);
    const [quartzPos, setQuartzPos] = useState<{ left: number; top: number } | null>(null);
    const quartzRef = useRef<HTMLDivElement | null>(null);
    const quartzPopupRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!quartzOpen) return;
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            if (quartzRef.current?.contains(t)) return;
            if (quartzPopupRef.current?.contains(t)) return;
            setQuartzOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [quartzOpen]);

    // Orientation — shared with VisualStudioShell via the broadcast
    // hook so flipping it here re-lays out the shell immediately.
    // 'top' is the legacy horizontal strip; 'left'/'right' mount the
    // toolbar as a VSCode-style activity bar on the corresponding edge.
    const [orientation, setOrientation] = useSharedPersistedString<ToolbarOrientation>('vstoolbar-orientation', 'top');
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
    const ctxMenuRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!ctxMenu) return;
        const onDown = (e: MouseEvent) => {
            if (!ctxMenuRef.current?.contains(e.target as Node)) setCtxMenu(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [ctxMenu]);
    // Clamp the menu to the viewport.
    useLayoutEffect(() => {
        if (!ctxMenu || !ctxMenuRef.current) return;
        const el = ctxMenuRef.current;
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = ctxMenu.x;
        let top = ctxMenu.y;
        if (left + r.width > vw - 6) left = Math.max(6, vw - r.width - 6);
        if (top + r.height > vh - 6) top = Math.max(6, vh - r.height - 6);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }, [ctxMenu]);
    const rootClass = `vs-toolbar${
        orientation === 'left' ? ' vs-toolbar--vertical vs-toolbar--left'
        : orientation === 'right' ? ' vs-toolbar--vertical vs-toolbar--right'
        : ''
    }`;
    const onRootContextMenu: React.MouseEventHandler = (e) => {
        // Don't override the browser's default menu on inputs / etc.
        // Toolbar root only has buttons + decorative divs, so this is
        // safe to capture wholesale.
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
    };
    // Portal to <body> so the menu always renders above the editor and
    // escapes any clipping / stacking ancestor (the vertical toolbar
    // lives inside `vs-shell-body` which has `overflow: hidden`).
    const quartzPopup = quartzOpen && quartzPos && createPortal(
        <div
            ref={quartzPopupRef}
            className="vs-toolbar-menu-popup vs-toolbar-menu-popup--portal"
            style={{ left: quartzPos.left, top: quartzPos.top, minWidth: 180 }}
        >
            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('paint'); }}>Paint In Quartz</button>
            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('port'); }}>Port In Quartz</button>
            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('bineditor'); }}>Open In BinEditor</button>
            <button className="vs-toolbar-menu-item" onClick={() => { setQuartzOpen(false); s.onSendToQuartz('vfxhub'); }}>Open In VFXHub</button>
        </div>,
        document.body,
    );
    const orientationMenu = ctxMenu && createPortal(
        <div
            ref={ctxMenuRef}
            className="vs-toolbar-ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
            <button
                className={orientation === 'top' ? 'is-active' : ''}
                onClick={() => { setOrientation('top'); setCtxMenu(null); }}
            >Horizontal (top)</button>
            <button
                className={orientation === 'left' ? 'is-active' : ''}
                onClick={() => { setOrientation('left'); setCtxMenu(null); }}
            >Vertical (left)</button>
            <button
                className={orientation === 'right' ? 'is-active' : ''}
                onClick={() => { setOrientation('right'); setCtxMenu(null); }}
            >Vertical (right)</button>
        </div>,
        document.body,
    );

    // Animation Studio replaces the toolbar with its own distinct
    // set of toggles (Options / Mapping / Rig) — kept separate from
    // Photo Studio's buttons because the mental model + the panel
    // set are different.
    if (isAnimStudio) {
        return (
            <div className={rootClass} onContextMenu={onRootContextMenu}>
                <ToolbarBtn
                    title="File Explorer"
                    onClick={() => s.setFileExplorerOpen(!s.fileExplorerOpen)}
                    icon={<FolderTree size={15} />}
                    active={s.fileExplorerOpen}
                />
                {folderToggle}
                {folderBtns}
                <div className="vs-toolbar-sep" />
                <ToolbarBtn
                    title="Options panel (rigs + retarget)"
                    onClick={() => s.setAnimStudioOptionsOpen(!s.animStudioOptionsOpen)}
                    icon={<SlidersHorizontal size={15} />}
                    active={s.animStudioOptionsOpen}
                />
                <ToolbarBtn
                    title="Bone Mapping panel"
                    onClick={() => s.setAnimStudioMappingOpen(!s.animStudioMappingOpen)}
                    icon={<NetworkIcon size={15} />}
                    active={s.animStudioMappingOpen}
                />
                <ToolbarBtn
                    title="Bone Rig picker (Phase 5)"
                    onClick={() => s.setAnimStudioRigOpen(!s.animStudioRigOpen)}
                    icon={<BoneIcon size={15} />}
                    active={s.animStudioRigOpen}
                />
                <ToolbarBtn
                    title="Guides (pin bones with offsets)"
                    onClick={() => s.setAnimStudioGuidesOpen(!s.animStudioGuidesOpen)}
                    icon={<PinIcon size={15} />}
                    active={s.animStudioGuidesOpen}
                />
                <ToolbarBtn
                    title="Physics (spring chains for cape / tail / hair)"
                    onClick={() => s.setAnimStudioPhysicsOpen(!s.animStudioPhysicsOpen)}
                    icon={<WindIcon size={15} />}
                    active={s.animStudioPhysicsOpen}
                />
                <ToolbarBtn
                    title="Meshes (show / hide submeshes, flip normals, override textures)"
                    onClick={() => s.setAnimStudioMeshOpen(!s.animStudioMeshOpen)}
                    icon={<View size={15} />}
                    active={s.animStudioMeshOpen}
                />
                <ToolbarBtn
                    title="Export (bake one clip or batch-retarget a whole set)"
                    onClick={() => s.setAnimStudioExportOpen(!s.animStudioExportOpen)}
                    icon={<SaveIcon size={15} />}
                    active={s.animStudioExportOpen}
                />

                <div className="vs-toolbar-spacer" />

                <ToolbarBtn title="Themes" onClick={s.onThemes} icon={<PaletteIcon size={15} />} />
                <ToolbarBtn title="Preferences" onClick={s.onPreferences} icon={<PencilIcon size={15} />} />
                <ToolbarBtn title="Settings" onClick={s.onSettings} icon={<SettingsIcon size={15} />} />
                <ToolbarBtn title="About" onClick={s.onAbout} icon={<HelpIcon size={15} />} />
                {orientationMenu}
                {quartzPopup}
            </div>
        );
    }

    // Studio mode replaces the BIN-editor toolbar with toggles for
    // the four studio panels (Pose / Background / Mesh / Photo). The
    // right-edge cluster (themes / preferences / settings / about)
    // stays because those are app-wide, not tab-scoped.
    if (isStudio) {
        return (
            <div className={rootClass} onContextMenu={onRootContextMenu}>
                <ToolbarBtn
                    title="File Explorer"
                    onClick={() => s.setFileExplorerOpen(!s.fileExplorerOpen)}
                    icon={<FolderTree size={15} />}
                    active={s.fileExplorerOpen}
                />
                {folderToggle}
                {folderBtns}
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
                {orientationMenu}
                {quartzPopup}
            </div>
        );
    }

    return (
        <div className={rootClass} onContextMenu={onRootContextMenu}>
            <div data-guide-id="find-btn" style={{ display: 'inline-flex' }}>
                {/* Find lives in its own leading group — most-used action
                    earns the leftmost slot. */}
                <ToolbarBtn title="Find / Replace (Ctrl+F)" onClick={s.onFind} icon={<SearchIcon size={15} />} active={s.replaceWidgetOpen} />
            </div>
            <div className="vs-toolbar-sep" />
            <div style={{ display: 'inline-flex' }}>
                <ToolbarBtn
                    title="File Explorer"
                    onClick={() => s.setFileExplorerOpen(!s.fileExplorerOpen)}
                    icon={<FolderTree size={15} />}
                    active={s.fileExplorerOpen}
                />
                {folderToggle}
                {folderBtns}
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
                        onClick={(e) => {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            const POPUP_W = 180;
                            let left: number; let top: number;
                            if (orientation === 'left') {
                                left = rect.right + 6;
                                top = rect.top;
                            } else if (orientation === 'right') {
                                left = rect.left - POPUP_W - 6;
                                top = rect.top;
                            } else {
                                left = rect.left;
                                top = rect.bottom + 4;
                            }
                            const margin = 6;
                            const maxLeft = window.innerWidth - POPUP_W - margin;
                            if (left > maxLeft) left = maxLeft;
                            if (left < margin) left = margin;
                            setQuartzPos({ left, top });
                            setQuartzOpen(o => !o);
                        }}
                        title="Send to Quartz"
                        aria-label="Send to Quartz"
                    >
                        <QuartzIcon size={15} />
                    </button>
                </div>
            </div>

            <div className="vs-toolbar-spacer" />

            <div data-guide-id="right-buttons" style={{ display: 'flex', alignItems: 'center' }}>
                <ToolbarBtn title="Themes" onClick={s.onThemes} icon={<PaletteIcon size={15} />} />
                <ToolbarBtn title="Preferences" onClick={s.onPreferences} icon={<PencilIcon size={15} />} />
                <ToolbarBtn title="Settings" onClick={s.onSettings} icon={<SettingsIcon size={15} />} />
                <ToolbarBtn title="About" onClick={s.onAbout} icon={<HelpIcon size={15} />} />
            </div>
            {orientationMenu}
            {quartzPopup}
        </div>
    );
}
