import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    LibraryIcon, PaletteIcon, SettingsIcon, ChevronRightIcon, SearchIcon,
    MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon,
} from './Icons';
import { FileTypeIcon, extractExtension } from './FormatIcons';
import { texBufferToDataURL, ddsBufferToDataURL, ddsFormatName, formatName as texFormatName } from '../lib/texFormat';
import ExtractionSettingsDialog, { ExtractMode } from './ExtractionSettingsDialog';
import SkinModPicker, { SkinModSkin, SkinModSelectionItem } from './SkinModPicker';
import { fetchChampions, fetchChampionDetails, CDragonChampionDetails } from '../lib/cdragon';
import { MeshPreview } from './MeshPreview';
import ViewerTab from './ViewerTab';
import ManageTab from './ManageTab';
import Editor from '@monaco-editor/react';
import {
    RITOBIN_LANGUAGE_ID, RITOBIN_THEME_ID,
    registerRitobinLanguage, registerRitobinTheme,
} from '../lib/ritobinLanguage';
import { loadSavedTheme } from '../lib/themeApplicator';
import {
    Folder as LucideFolder,
    FolderOpen as LucideFolderOpen,
    Copy as CopyIcon,
    Files as FilesIcon,
    Mic as MicIcon,
    ToolCase as ToolCaseIcon,
    RefreshCw as RefreshCwIcon,
    ArrowUp as ArrowUpLucide,
    ScanSearch as ScanSearchLucide,
    Save as SaveIcon,
    SaveAll as SaveAllIcon,
    FolderDown as FolderDownIcon,
    Package as LucidePackage,
    PackageOpen as LucidePackageOpen,
    File as LucideFile,
    SquareArrowRightEnter,
    Aperture,
    FilePlus,
    House,
    FolderSearch,
    Camera,
    Clapperboard,
    CircleHelp as HelpIcon,
} from 'lucide-react';
import { startEffectOnCanvas, setEffectsWelcomeOpen } from '../lib/themeEffects';
import './WelcomeScreen.css';

/**
 * A dedicated effect canvas for the welcome screen's main area. It mirrors
 * whatever effect the app's live layer has active — read from the
 * `data-theme-effect` attribute the live layer sets (present only in Modern UI
 * with an effect on) — so the welcome screen gets the same animated background
 * in its main column WITHOUT going transparent and revealing the editor behind.
 *
 * Only runs while the welcome screen is actually visible (`active`) AND the app
 * window is focused/visible — otherwise it stops, so it never animates
 * off-screen or while you're in another app.
 */
function WelcomeEffectLayer({ active }: { active: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [effectId, setEffectId] = useState(
        () => document.documentElement.getAttribute('data-theme-effect') || 'none'
    );
    const [windowActive, setWindowActive] = useState(
        () => !document.hidden && document.hasFocus()
    );

    useEffect(() => {
        const read = () => setEffectId(document.documentElement.getAttribute('data-theme-effect') || 'none');
        const obs = new MutationObserver(read);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-effect'] });
        read();
        return () => obs.disconnect();
    }, []);

    useEffect(() => {
        const update = () => setWindowActive(!document.hidden && document.hasFocus());
        document.addEventListener('visibilitychange', update);
        window.addEventListener('blur', update);
        window.addEventListener('focus', update);
        update();
        return () => {
            document.removeEventListener('visibilitychange', update);
            window.removeEventListener('blur', update);
            window.removeEventListener('focus', update);
        };
    }, []);

    const running = active && windowActive && effectId !== 'none';

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !running) return;
        const handle = startEffectOnCanvas(effectId, canvas, { density: 1 });
        return () => handle.stop();
    }, [running, effectId]);

    if (!running) return null;
    return <canvas ref={canvasRef} className="welcome-effect-canvas" />;
}

// Tracks whether the dynamic Monaco theme (`jade-dynamic`) has been defined
// this session. It's normally created by the main editor's `beforeMount`, but
// on a fresh boot straight into the extractor the main editor may never have
// mounted — so the BIN preview must define it itself before switching to it.
let dynamicThemeReady = false;

interface WelcomeScreenProps {
    onOpenFile: () => void;
    /** Create a fresh empty file — same action as the File ▸ New menu. */
    onNewFile: () => void;
    /** Dismisses the welcome overlay and reveals the empty editor without
     *  picking a file. Wired to the home tab's "Continue without file"
     *  button — lets the user land in the editor and decide what to open
     *  later. When omitted, the button is not rendered. */
    onContinueWithoutFile?: () => void;
    openFileDisabled?: boolean;
    recentFiles?: string[];
    onOpenRecentFile?: (path: string) => void;
    onMaterialLibrary?: () => void;
    onThemes?: () => void;
    onSettings?: () => void;
    onAbout?: () => void;
    onNewStudioScene?: () => void;
    onNewAnimStudioScene?: () => void;
    /** Pops the OS folder-picker and opens the chosen folder in the
     *  Explorer pane (studio shell only). When omitted, the tile is
     *  hidden. */
    onOpenFolder?: () => void;
    /** Viewer → editor handoff. When the user clicks "Open in BIN editor"
     *  in the model-viewer's Export accordion, we pass the text-form BIN
     *  + a display name up so the host can create a new editor tab. */
    onOpenSkinBinAsText?: (text: string, displayName: string) => void;
    /** Viewer → Photo Studio handoff. Host extracts the skin's folder
     *  to a temp dir, opens a new studio scene, and loads it. */
    onSendMeshToStudio?: (
        mountId: number,
        sknChunkHashHex: string,
        champion: string,
        skinNum: number,
        label: string,
        shadowForm: boolean,
        chromaSkinNum: number | null,
        textureBindings: Array<{ submeshName: string; chunkHashHex: string | null }> | null,
    ) => void;
    appIcon?: string;
    /** Custom window-chrome handlers — when supplied, the welcome screen
     *  draws its own title bar with min/max/close controls. Falls back
     *  gracefully when missing (no title bar shown). */
    onMinimize?: () => void;
    onMaximize?: () => void;
    onClose?: () => void;
    isMaximized?: boolean;
    /** True while the parent has decided to unmount the welcome screen
     *  but is keeping it in the DOM long enough for the slide-away
     *  transition to play. The wrapper component owns this — leaf
     *  callers normally use `WelcomeScreenWithExit` instead of touching
     *  it directly. */
    isClosing?: boolean;
    /** True for the single frame after mount while CSS holds the
     *  welcome at its closed transform; clearing it on the next frame
     *  triggers the slide-in transition. Mirror of `isClosing`. */
    isOpening?: boolean;
    /** When true the welcome screen is parked off-screen (`display:none`)
     *  but kept mounted so views like Extract Files retain their state —
     *  the user can browse a WAD, hop to a BIN editor, and come back to
     *  the exact same WAD/folder/preview. The wrapper owns this flag. */
    hidden?: boolean;
}

interface DirEntry {
    name: string;
    path: string;
    is_dir: boolean;
    size: number;
    modified: number;
    extension: string;
}

interface WadOpenResult {
    id: number;
    name: string;
    path: string;
    version: string;
    chunk_count: number;
}

interface WadEntry {
    path: string;
    path_hash_hex: string;
    size: number;
    compressed_size: number;
    compression: string;
    is_duplicated: boolean;
    unknown: boolean;
}

interface WadHashStatus {
    present: boolean;
    layout: 'split' | 'combined' | 'missing' | string;
    hash_dir: string;
}

interface WadExtractProgressEvent {
    action_id: string;
    phase: 'preparing' | 'extracting' | 'complete' | 'cancelled' | 'error';
    current: number;
    total: number;
    written: number;
    errors: number;
    message: string;
}

interface WadHashDownloadProgressEvent {
    phase: 'checking' | 'downloading' | 'decompressing' | 'complete' | 'error';
    message: string;
    downloaded: number;
    total: number;
}

interface WadExtractResult {
    action_id: string;
    written: number;
    skipped: number;
    errors: number;
    elapsed_ms: number;
    output_dir: string;
    cancelled: boolean;
}

interface WadHashScanProgressEvent {
    action_id: string;
    phase: 'preparing' | 'scanning' | 'merging' | 'complete' | 'error';
    current: number;
    total: number;
    message: string;
}

interface WadHashScanResult {
    action_id: string;
    wad_paths_added: number;
    bin_names_added: number;
    wad_paths_scanned: number;
    bin_names_scanned: number;
    total_chunks: number;
    elapsed_ms: number;
}

type WelcomeView = 'home' | 'extract' | 'viewer' | 'manage';

/** Cross-tab navigation request — Viewer asks Extract Files to mount
 *  a WAD (if not already) and reveal a specific path inside it.
 *  `mode: 'folder'` opens the folder; `mode: 'file'` opens the parent
 *  folder + highlights the file. */
interface ExtractorNavTarget {
    wadPath: string;
    subPath: string;
    mode: 'file' | 'folder';
}

function isWadFileName(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.wad') || lower.endsWith('.wad.client') || lower.endsWith('.wad.mobile');
}

function timeOfDayGreeting(): string {
    const h = new Date().getHours();
    if (h < 5) return 'Good night';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 22) return 'Good evening';
    return 'Good night';
}

function formatRelative(timestamp: number): string {
    if (!timestamp) return '';
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBytes(bytes: number): string {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Welcome / start screen — MS Word-inspired layout. A left rail of nav
 * tabs (Home / Open BIN / Extract Files / Themes / Settings), a main
 * content area whose contents change per tab. Open BIN is a sidebar
 * action button rather than a real tab — it just calls `onOpenFile`
 * straight away, dismissing the welcome screen via the parent shell's
 * usual "no tabs → welcome / has tabs → editor" toggle.
 *
 * The screen positions itself as a full-viewport overlay above every
 * shell chrome element (title bar text, tabs, status bar, ribbon, dock
 * panes). Only the OS window controls (min / max / close) stay clickable
 * thanks to the body.welcome-active class boosting their z-index.
 */
export default function WelcomeScreen({
    onOpenFile,
    onNewFile,
    onContinueWithoutFile,
    openFileDisabled = false,
    recentFiles = [],
    onOpenRecentFile,
    onMaterialLibrary,
    onThemes,
    onSettings,
    onAbout,
    onNewStudioScene,
    onNewAnimStudioScene,
    onOpenFolder,
    onOpenSkinBinAsText,
    onSendMeshToStudio,
    appIcon,
    onMinimize,
    onMaximize,
    onClose,
    isMaximized = false,
    isClosing = false,
    isOpening = false,
    hidden = false,
}: WelcomeScreenProps) {
    const [view, setView] = useState<WelcomeView>('home');
    const [search, setSearch] = useState('');
    // Once the user opens the Extract Files view we keep `ExtractView`
    // mounted for the rest of the session (just hidden when off-view),
    // so a browsed WAD / folder / preview survives hopping to a BIN
    // editor and back. Mounted lazily so first launch stays cheap.
    const [extractMounted, setExtractMounted] = useState(false);
    useEffect(() => {
        if (view === 'extract') setExtractMounted(true);
    }, [view]);
    // Same lazy-mount + keep-alive treatment for the Viewer tab so the
    // CDragon icon cache and any future mount survives tab hops.
    const [viewerMounted, setViewerMounted] = useState(false);
    useEffect(() => {
        if (view === 'viewer') setViewerMounted(true);
    }, [view]);
    // Manage keeps its loaded mod + scan results alive across tab hops.
    const [manageMounted, setManageMounted] = useState(false);
    useEffect(() => {
        if (view === 'manage') setManageMounted(true);
    }, [view]);

    // Viewer → Extract Files cross-tab navigation request. The Viewer's
    // Export accordion sets this to "go open this BIN / skin folder in
    // Extract". ExtractView reads it via prop + clears it via
    // `onConsumed` after navigating, so re-requests fire even if the
    // user lands on the same target.
    const [extractNav, setExtractNav] = useState<ExtractorNavTarget | null>(null);
    const handleJumpToExtractor = (target: ExtractorNavTarget) => {
        setExtractMounted(true);
        setExtractNav(target);
        setView('extract');
    };

    const greeting = useMemo(timeOfDayGreeting, []);

    // Extraction progress is owned by the welcome screen root so the
    // status bar can sit at the bottom of the layout (in its own grid
    // slot). The bar itself is only rendered when the user is on the
    // Extract view.
    const [progress, setProgress] = useState(0);
    // Single status string displayed *on top* of the progress bar — the
    // sources column used to host this and got pushed around when the
    // text appeared. Cleared together with the progress fade so both
    // disappear in one go.
    const [extractStatusText, setExtractStatusText] = useState<string | null>(null);
    const progressResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // While a multi-WAD batch is running, the per-WAD progress events
    // are noisy (each WAD blasts 0→100, plus its own status messages).
    // The batch loop in ExtractView drives the bar/status/taskbar
    // directly, so this listener short-circuits while the ref is set.
    const multiWadActiveRef = useRef(false);

    // Real extraction progress comes from the backend `wad-extract-progress`
    // event. We translate `current/total` into a percentage and clear the
    // bar a beat after completion so the user sees it land at 100%. The
    // same events also drive the Windows taskbar's per-window progress
    // overlay (the green fill behind the app icon).
    useEffect(() => {
        const setTaskbar = (
            state: 'no_progress' | 'indeterminate' | 'normal' | 'paused' | 'error',
            completed: number,
            total: number,
        ) => {
            invoke('set_taskbar_progress', { state, completed, total }).catch(() => {});
        };
        const unlisten = listen<WadExtractProgressEvent>('wad-extract-progress', (e) => {
            if (multiWadActiveRef.current) return;
            const { phase, current, total } = e.payload;
            if (progressResetTimer.current) {
                clearTimeout(progressResetTimer.current);
                progressResetTimer.current = null;
            }
            if (phase === 'preparing') {
                setProgress(0);
                setTaskbar('indeterminate', 0, 0);
                return;
            }
            if (phase === 'extracting') {
                setProgress(total > 0 ? Math.min(100, (current / total) * 100) : 0);
                setTaskbar('normal', current, Math.max(total, 1));
                return;
            }
            // complete / cancelled / error → land at 100% (or hold),
            // then fade the bar AND the status text away together.
            if (phase === 'complete') {
                setProgress(100);
                setTaskbar('normal', total || 1, total || 1);
            } else if (phase === 'error') {
                setTaskbar('error', current, Math.max(total, 1));
            } else {
                setTaskbar('no_progress', 0, 0);
            }
            progressResetTimer.current = setTimeout(() => {
                setProgress(0);
                setExtractStatusText(null);
                setTaskbar('no_progress', 0, 0);
            }, 2000);
        });
        return () => {
            unlisten.then((u) => u()).catch(() => {});
            if (progressResetTimer.current) clearTimeout(progressResetTimer.current);
        };
    }, []);

    // Tag the body while the welcome overlay is mounted — used by CSS
    // to hide the shell's own title-bar contents (the welcome screen
    // brings its own bar) and quiet any chrome behind us.
    useEffect(() => {
        if (hidden) return;
        document.body.classList.add('welcome-active');
        return () => document.body.classList.remove('welcome-active');
    }, [hidden]);

    // Pause the editor's effect layer while the welcome screen is open (it has
    // its own effect canvas, so the occluded editor one is wasted GPU). Closing
    // it — or unmounting the welcome screen entirely — brings it back.
    useEffect(() => {
        setEffectsWelcomeOpen(!hidden);
    }, [hidden]);
    useEffect(() => () => setEffectsWelcomeOpen(false), []);

    return (
        <div
            className={`welcome-screen-v2${isClosing ? ' welcome-screen-v2-closing' : ''}${isOpening ? ' welcome-screen-v2-opening' : ''}`}
            style={hidden ? { display: 'none' } : undefined}
        >
            {(onMinimize || onMaximize || onClose) && (
                <div className="welcome-titlebar" data-tauri-drag-region>
                    {/* Top-left brand doubles as a shortcut to the
                        editor — 600-DPI users had to scroll the rail
                        to reach the Editor button at the bottom, so
                        this gives them a stable top-of-screen entry
                        point. On hover the icon + label morph into
                        the editor entry-arrow icon, signalling what
                        clicking will do without an extra tooltip. */}
                    <button
                        type="button"
                        className="welcome-titlebar-brand welcome-titlebar-brand-btn"
                        onClick={onContinueWithoutFile}
                        disabled={!onContinueWithoutFile}
                        title="Open the editor"
                        data-guide-id="editor-brand"
                    >
                        <span className="welcome-titlebar-icon-stack">
                            <img
                                src={appIcon || '/media/jadejade.png'}
                                alt=""
                                className="welcome-titlebar-icon welcome-titlebar-icon-default"
                                draggable={false}
                            />
                            <SquareArrowRightEnter
                                size={20}
                                className="welcome-titlebar-icon welcome-titlebar-icon-hover"
                            />
                        </span>
                        <span className="welcome-titlebar-name-stack">
                            <span className="welcome-titlebar-name welcome-titlebar-name-default">Jade</span>
                            <span className="welcome-titlebar-name welcome-titlebar-name-hover">Editor</span>
                        </span>
                    </button>
                    <div className="welcome-titlebar-spacer" data-tauri-drag-region />
                    <div className="welcome-titlebar-controls">
                        {onMinimize && (
                            <button
                                type="button"
                                className="welcome-titlebar-btn welcome-titlebar-btn-min"
                                onClick={onMinimize}
                                title="Minimize"
                            >
                                <MinimizeIcon size={14} />
                            </button>
                        )}
                        {onMaximize && (
                            <button
                                type="button"
                                className="welcome-titlebar-btn welcome-titlebar-btn-max"
                                onClick={onMaximize}
                                title={isMaximized ? 'Restore' : 'Maximize'}
                            >
                                {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
                            </button>
                        )}
                        {onClose && (
                            <button
                                type="button"
                                className="welcome-titlebar-btn welcome-titlebar-btn-close"
                                onClick={onClose}
                                title="Close"
                            >
                                <CloseIcon size={14} strokeWidth={2.2} />
                            </button>
                        )}
                    </div>
                </div>
            )}
            <aside className="welcome-rail" data-guide-id="rail">
                <button
                    type="button"
                    className={`welcome-rail-item${view === 'home' ? ' active' : ''}`}
                    onClick={() => setView('home')}
                >
                    <House size={20} />
                    <span>Home</span>
                </button>

                <button
                    type="button"
                    className="welcome-rail-item welcome-rail-item-action"
                    onClick={onOpenFile}
                    disabled={openFileDisabled}
                    title="Open a file (Ctrl+O)"
                >
                    <LucideFile size={20} />
                    <span>Open file</span>
                </button>

                <button
                    type="button"
                    className={`welcome-rail-item${view === 'extract' ? ' active' : ''}`}
                    onClick={() => setView('extract')}
                >
                    <FolderSearch size={20} />
                    <span>Extract Files</span>
                </button>

                <button
                    type="button"
                    className={`welcome-rail-item${view === 'viewer' ? ' active' : ''}`}
                    onClick={() => setView('viewer')}
                    title="Browse champions, skins, and 3D models"
                >
                    <Aperture size={20} />
                    <span>Viewer</span>
                </button>

                <button
                    type="button"
                    className={`welcome-rail-item${view === 'manage' ? ' active' : ''}`}
                    onClick={() => setView('manage')}
                    title="Check a fantome/WAD mod against the live game and fix what's outdated"
                >
                    <LucidePackageOpen size={20} />
                    <span>Manage</span>
                </button>

                <div className="welcome-rail-spacer" />

                {/* Bottom rail slot used to host the Editor shortcut.
                    That entry point moved to the top-left brand
                    button (better Fitts target, mirrors the editor
                    side's "logo returns to welcome"). The slot now
                    holds About — the same Help-menu surface that
                    lives on the right side of the editor's toolbar. */}
                {onAbout && (
                    <button
                        type="button"
                        className="welcome-rail-item"
                        onClick={onAbout}
                        title="About Jade"
                        data-guide-id="about-btn"
                    >
                        <HelpIcon size={20} />
                        <span>About</span>
                    </button>
                )}
            </aside>

            <main className="welcome-main">
                <WelcomeEffectLayer active={!hidden} />
                {view === 'home' && (
                    <HomeView
                        greeting={greeting}
                        search={search}
                        onSearch={setSearch}
                        recentFiles={recentFiles}
                        onOpenFile={onOpenFile}
                        onNewFile={onNewFile}
                        onOpenRecentFile={onOpenRecentFile}
                        onMaterialLibrary={onMaterialLibrary}
                        onThemes={onThemes}
                        onSettings={onSettings}
                        onNewStudioScene={onNewStudioScene}
                        onNewAnimStudioScene={onNewAnimStudioScene}
                        onOpenFolder={onOpenFolder}
                        openFileDisabled={openFileDisabled}
                    />
                )}
                {extractMounted && (
                    <div style={{ display: view === 'extract' ? 'contents' : 'none' }}>
                        <ExtractView
                            active={!hidden && view === 'extract'}
                            onOpenSkinBinAsText={onOpenSkinBinAsText}
                            onOpenRecentFile={onOpenRecentFile}
                            onExtractStatus={setExtractStatusText}
                            onProgress={setProgress}
                            multiWadActiveRef={multiWadActiveRef}
                            navRequest={extractNav}
                            onNavConsumed={() => setExtractNav(null)}
                        />
                    </div>
                )}
                {viewerMounted && (
                    <div style={{ display: view === 'viewer' ? 'contents' : 'none' }}>
                        <ViewerTab
                            active={!hidden && view === 'viewer'}
                            onOpenSkinBinAsText={onOpenSkinBinAsText}
                            onSendMeshToStudio={onSendMeshToStudio}
                            onExtractStatus={setExtractStatusText}
                            onJumpToExtractor={handleJumpToExtractor}
                        />
                    </div>
                )}
                {manageMounted && (
                    <div style={{ display: view === 'manage' ? 'contents' : 'none' }}>
                        <ManageTab
                            active={!hidden && view === 'manage'}
                            onStatus={setExtractStatusText}
                        />
                    </div>
                )}
            </main>

            {/* Status bar — shown for both Extract and Viewer (both
                drive `wad-extract-progress` events when extracting).
                Sits in its own grid slot below `main`, leaving the rail
                untouched on the left. The fill animates left-to-right;
                the status text overlays it. */}
            {(view === 'extract' || view === 'viewer' || view === 'manage') && (
                <div className="welcome-status">
                    <div
                        className="welcome-status-fill"
                        style={{ width: `${progress}%` }}
                    />
                    {extractStatusText && (
                        <div className="welcome-status-text">{extractStatusText}</div>
                    )}
                </div>
            )}
        </div>
    );
}

/** Animation wrapper — keeps the welcome screen mounted long enough to
 *  play its slide-away exit when `visible` flips to false, then drops
 *  it from the tree. Snappy: a quick lateral slide + fade, no
 *  cushioning easing.
 *
 *  Duration matches the CSS transition on `.welcome-screen-v2`
 *  (`WelcomeScreen.css` — keep them in sync, otherwise the unmount
 *  catches the animation mid-frame).
 */
const WELCOME_EXIT_MS = 200;

export function WelcomeScreenWithExit({
    visible,
    ...props
}: WelcomeScreenProps & { visible: boolean }) {
    const [shouldRender, setShouldRender] = useState(visible);
    const [phase, setPhase] = useState<'idle' | 'opening' | 'open' | 'closing'>(
        visible ? 'open' : 'idle'
    );

    useEffect(() => {
        if (visible) {
            // Mount in the "opening" state (closed transform applied),
            // flip to "open" on the next frame so CSS transitions the
            // welcome in. Symmetrical with the closing animation —
            // same transition curve, just running in reverse.
            setShouldRender(true);
            setPhase('opening');
            const raf = requestAnimationFrame(() => setPhase('open'));
            return () => cancelAnimationFrame(raf);
        }
        if (!shouldRender) return;
        // Defer the closing class to the next frame so React's commit
        // never paints "open + closing" simultaneously — without the
        // RAF the transition occasionally skips and snaps to the end.
        const raf = requestAnimationFrame(() => setPhase('closing'));
        const t = setTimeout(() => {
            setShouldRender(false);
            setPhase('idle');
        }, WELCOME_EXIT_MS);
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(t);
        };
    }, [visible, shouldRender]);

    // Never fully unmount once it has rendered — when `shouldRender` is
    // false we keep WelcomeScreen in the tree but parked (`hidden`), so
    // the Extract Files view holds onto its browsed WAD / preview state
    // across trips to a BIN editor. `hidden` also short-circuits the
    // body class + drag-drop listeners so a parked screen is inert.
    const [everRendered, setEverRendered] = useState(visible);
    useEffect(() => { if (shouldRender) setEverRendered(true); }, [shouldRender]);
    if (!shouldRender && !everRendered) return null;
    return (
        <WelcomeScreen
            {...props}
            isClosing={phase === 'closing'}
            isOpening={phase === 'opening'}
            hidden={!shouldRender}
        />
    );
}

/* ────────────────── Home view ────────────────── */
function HomeView({
    greeting,
    search,
    onSearch,
    recentFiles,
    onOpenFile,
    onNewFile,
    onOpenRecentFile,
    onMaterialLibrary,
    onThemes,
    onSettings,
    onNewStudioScene,
    onNewAnimStudioScene,
    onOpenFolder,
    openFileDisabled,
}: {
    greeting: string;
    search: string;
    onSearch: (s: string) => void;
    recentFiles: string[];
    onOpenFile: () => void;
    onNewFile: () => void;
    onOpenRecentFile?: (path: string) => void;
    onMaterialLibrary?: () => void;
    onThemes?: () => void;
    onSettings?: () => void;
    onNewStudioScene?: () => void;
    onNewAnimStudioScene?: () => void;
    onOpenFolder?: () => void;
    openFileDisabled?: boolean;
}) {
    const filteredRecent = useMemo(() => {
        // The backend already clamps to the user's configured limit
        // (see `recent_files_limit` in app_commands.rs). Don't cap
        // again here — the list scrolls inside `.welcome-recent-table`.
        if (!search.trim()) return recentFiles;
        const q = search.toLowerCase();
        return recentFiles.filter(p => p.toLowerCase().includes(q));
    }, [recentFiles, search]);

    // Fetch the on-disk mtime for each visible recent file so the
    // "Last edited" column reflects the actual file system timestamp,
    // not the time we added it to the recent-files list. Files that
    // were moved or deleted resolve to undefined and render as a dash.
    const [mtimes, setMtimes] = useState<Record<string, number>>({});
    useEffect(() => {
        if (filteredRecent.length === 0) return;
        let cancelled = false;
        (async () => {
            const next: Record<string, number> = {};
            await Promise.all(filteredRecent.map(async (path) => {
                try {
                    const millis = await invoke<number>('get_file_mtime', { path });
                    next[path] = Math.floor(millis / 1000);
                } catch { /* missing/inaccessible file — skip */ }
            }));
            if (!cancelled) setMtimes(prev => ({ ...prev, ...next }));
        })();
        return () => { cancelled = true; };
    }, [filteredRecent]);

    return (
        <div className="welcome-home">
            <div className="welcome-home-head">
                <h1 className="welcome-greeting">{greeting}</h1>
            </div>

            <section className="welcome-section" data-guide-id="quick-actions">
                <div className="welcome-section-head">
                    <h2 className="welcome-section-title">Quick actions</h2>
                </div>
                <div className="welcome-tiles">
                    <ActionTile
                        label="New file"
                        sub="Start a fresh empty file"
                        icon={<FilePlus size={28} />}
                        onClick={onNewFile}
                    />
                    <ActionTile
                        label="Open file"
                        sub="Browse for a file to open"
                        icon={<DocIcon size={28} />}
                        onClick={onOpenFile}
                        disabled={openFileDisabled}
                    />
                    {onOpenFolder && (
                        <ActionTile
                            label="Open folder"
                            sub="Browse a folder in the Explorer pane"
                            icon={<LucideFolderOpen size={28} />}
                            onClick={onOpenFolder}
                        />
                    )}
                    {onNewStudioScene && (
                        <ActionTile
                            label="Photo Studio"
                            sub="Stage a model and export thumbnails"
                            icon={<Camera size={28} />}
                            onClick={onNewStudioScene}
                        />
                    )}
                    {onNewAnimStudioScene && (
                        <ActionTile
                            label="Animation Studio"
                            sub="Retarget animations between champions"
                            icon={<Clapperboard size={28} />}
                            onClick={onNewAnimStudioScene}
                        />
                    )}
                    {onMaterialLibrary && (
                        <ActionTile
                            label="Material Library"
                            sub="Browse downloaded materials"
                            icon={<LibraryIcon size={28} />}
                            onClick={onMaterialLibrary}
                        />
                    )}
                    {onThemes && (
                        <ActionTile
                            label="Themes"
                            sub="Change look + accent"
                            icon={<PaletteIcon size={28} />}
                            onClick={onThemes}
                        />
                    )}
                    {onSettings && (
                        <ActionTile
                            label="Settings"
                            sub="Preferences and tools"
                            icon={<SettingsIcon size={28} />}
                            onClick={onSettings}
                        />
                    )}
                </div>
            </section>

            <section className="welcome-section">
                <div className="welcome-search-wrap">
                    <input
                        type="text"
                        className="welcome-search"
                        placeholder="Search recent files…"
                        value={search}
                        onChange={e => onSearch(e.target.value)}
                    />
                </div>

                <div className="welcome-section-head welcome-section-head-tabs">
                    <span className="welcome-tab active">Recent</span>
                </div>

                <div className="welcome-recent-table">
                    <div className="welcome-recent-row welcome-recent-row-header">
                        <span className="col-icon" />
                        <span className="col-name">Name</span>
                        <span className="col-modified">Last edited</span>
                    </div>
                    {filteredRecent.length === 0 && (
                        <div className="welcome-recent-empty">
                            {search.trim() ? 'No matches.' : 'No recent files yet — open a BIN to get started.'}
                        </div>
                    )}
                    {filteredRecent.map((filePath, i) => {
                        const parts = filePath.replace(/\\/g, '/').split('/');
                        const fileName = parts.pop() || filePath;
                        const dir = parts.join('/');
                        const ext = extractExtension(filePath);
                        return (
                            <button
                                key={i}
                                type="button"
                                className="welcome-recent-row"
                                onClick={() => onOpenRecentFile?.(filePath)}
                                title={filePath}
                            >
                                <span className="col-icon">
                                    {recentFileIcon(filePath, ext)}
                                </span>
                                <span className="col-name">
                                    <span className="welcome-recent-name">{fileName}</span>
                                    <span className="welcome-recent-path">{dir}</span>
                                </span>
                                <span className="col-modified">
                                    {mtimes[filePath] ? formatRelative(mtimes[filePath]) : '—'}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}

function ActionTile({
    label,
    sub,
    icon,
    onClick,
    disabled,
}: {
    label: string;
    sub: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
}) {
    return (
        <button type="button" className="welcome-tile" onClick={onClick} disabled={disabled}>
            <span className="welcome-tile-icon">{icon}</span>
            <span className="welcome-tile-label">{label}</span>
            <span className="welcome-tile-sub">{sub}</span>
        </button>
    );
}

/* ────────────────── Extract view ────────────────── */
function ExtractView({
    active,
    onOpenSkinBinAsText,
    onOpenRecentFile,
    onExtractStatus,
    onProgress,
    multiWadActiveRef,
    navRequest,
    onNavConsumed,
}: {
    /** False while the welcome screen is parked behind a BIN editor or
     *  the user is on another welcome tab. ExtractView stays mounted so
     *  its state survives, but the global drag-drop listener only
     *  registers while it's the foreground view. */
    active: boolean;
    /** Open one or more `.bin`/`.py` chunks as text in the editor. Same
     *  callback the Viewer uses for "Open in BIN editor"; ExtractView
     *  wires it to a right-click "Send to editor" entry. */
    onOpenSkinBinAsText?: (text: string, displayName: string) => void;
    /** Open a real on-disk file in the editor (used for the "Send to
     *  editor" entry when the right-clicked row is a disk file — no
     *  need to round-trip through bytes-to-text since the file already
     *  lives on disk). Same handler the recent-files list uses. */
    onOpenRecentFile?: (path: string) => void;
    onExtractStatus: (s: string | null) => void;
    onProgress: (pct: number) => void;
    multiWadActiveRef: React.MutableRefObject<boolean>;
    /** Externally-requested navigation (Viewer's "Show BIN" / "Show files"
     *  buttons). When set, ExtractView mounts the WAD if needed and
     *  navigates to the requested sub-path, then calls `onNavConsumed`
     *  so the parent can clear it. */
    navRequest: ExtractorNavTarget | null;
    onNavConsumed: () => void;
}) {
    const [leagueInstall, setLeagueInstall] = useState<string | null>(null);
    const [leaguePbeInstall, setLeaguePbeInstall] = useState<string | null>(null);
    const [home, setHome] = useState<string | null>(null);
    /** Recently opened WAD paths — persisted via the preference store
     *  so they survive restarts. Most-recent first, capped at 8. */
    const [recentWads, setRecentWads] = useState<string[]>([]);
    /** True while a `.wad.client` is being dragged over the window —
     *  shows the drop overlay below. */
    const [dropActive, setDropActive] = useState(false);
    const [currentPath, setCurrentPath] = useState<string>('');
    const [entries, setEntries] = useState<DirEntry[]>([]);
    const [selected, setSelected] = useState<DirEntry | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');

    // ── WAD mount state ──
    const [mountInfo, setMountInfo] = useState<WadOpenResult | null>(null);
    const [wadEntries, setWadEntries] = useState<WadEntry[]>([]);
    const [wadCurrentDir, setWadCurrentDir] = useState<string>('');
    // Search scope toggle. Default: limit matches to the current sub-
    // folder and its children (so a search inside `data/` won't pull
    // in unrelated hits from `assets/`). Toggle on to broaden back to
    // the whole WAD. State is per-session, not persisted — the user
    // generally wants the same scope across mounts.
    const [searchWholeWad, setSearchWholeWad] = useState(false);
    // Brief toast / status hint when the user copies a path. Timed
    // out after 1.4s so the message doesn't linger.
    const [copyHint, setCopyHint] = useState<string | null>(null);
    // Right-click context menu state. `null` = closed; otherwise the
    // viewport coords + the row the user clicked. Action options are
    // derived from `row.kind` at render time.
    const [contextMenu, setContextMenu] = useState<
        { x: number; y: number; row: BrowseRow } | null
    >(null);
    const [wadSelected, setWadSelected] = useState<WadEntry | null>(null);
    const [openingWad, setOpeningWad] = useState(false);
    // VO ↔ main WAD switcher state. When the user opens
    // `Aatrox.wad.client` and an `Aatrox.VO.wad.client` (or vice
    // versa) sits next to it on disk, we offer a one-click jump
    // between the two. `null` = no counterpart detected (button is
    // disabled). Probed each time `mountInfo.path` changes.
    const [wadCounterpartPath, setWadCounterpartPath] = useState<string | null>(null);
    // Per-WAD memory of in-WAD nav + selection state, keyed by the
    // WAD's disk path. Saved when switching to the counterpart;
    // restored when switching back so VO ↔ main feels seamless.
    const wadStateMemoryRef = useRef<
        Map<string, { dir: string; selectedHash: string | null }>
    >(new Map());
    // After a counterpart switch fires `openWad`, this ref carries the
    // hash to re-select once entries land. Cleared by the consuming
    // effect below so it only fires once.
    const pendingWadSelectionRef = useRef<string | null>(null);
    const [extracting, setExtracting] = useState(false);
    /** Bridge to the welcome-screen-level status overlay. Passing the
     *  setter through a prop instead of duplicating state keeps the
     *  status text in one place — overlaid on the progress bar so it
     *  doesn't shove the action buttons around when it appears. */
    const setExtractMessage = onExtractStatus;
    const extractActionRef = useRef<string | null>(null);
    /** JS-side cancel flag for the multi-WAD loop. Backend cancels are
     *  per-action via `wad_cancel_extract`; this flag stops the *loop*
     *  itself from kicking off the next WAD after the current one is
     *  cancelled. */
    const cancelRef = useRef(false);

    // Multi-select set for the WAD list — Explorer-style checkboxes.
    // Stores file `path_hash_hex` values; folder rows toggle every file
    // under their prefix in/out of the set in one action.
    const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());

    // Disk-mode counterpart: full paths of `.wad.client` rows the user
    // ticked. Lets the same Extract Selected button kick off a batch
    // extraction of multiple WADs without ever opening any of them. Reset
    // when the current disk folder changes — selections from a previous
    // dir wouldn't be visible/cancellable from the new view.
    const [selectedDiskWads, setSelectedDiskWads] = useState<Set<string>>(new Set());
    useEffect(() => { setSelectedDiskWads(new Set()); }, [currentPath]);

    // ── Extraction settings (persisted preferences) ──
    // The "Extraction settings" button in the sources column opens a
    // modal mirroring the main Settings dialog's layout. State for each
    // toggle lives here so it survives the dialog mount/unmount cycle
    // and threads cleanly into the extraction commands.
    const [extractionSettingsOpen, setExtractionSettingsOpen] = useState(false);
    const [useRenamePattern, setUseRenamePattern] = useState(true);
    // BIN preview controls — font size + a ref to the Monaco instance
    // so the toolbar buttons (Find / A+ / A-) can act on it without
    // bouncing through state on every keystroke.
    const BIN_FONT_MIN = 8;
    const BIN_FONT_MAX = 22;
    const BIN_FONT_DEFAULT = 11;
    const [binFontSize, setBinFontSize] = useState(BIN_FONT_DEFAULT);
    // Monaco's editor instance — typed loosely as `any` because the
    // `editor.IStandaloneCodeEditor` type isn't worth pulling in just
    // for the two methods we call. Set in `onMount`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binEditorRef = useRef<any>(null);
    // Theme for the BIN preview. Mirrors the main editor: start on the static
    // ritobin theme (guaranteed to exist) and flip to `jade-dynamic` only once
    // it's actually defined, so the preview never resolves an undefined theme
    // and falls back to Monaco's default (wrong) syntax colors.
    const [previewTheme, setPreviewTheme] = useState(
        dynamicThemeReady ? 'jade-dynamic' : RITOBIN_THEME_ID,
    );
    const triggerBinFind = () => {
        const ed = binEditorRef.current;
        if (!ed) return;
        ed.focus();
        // Built-in Monaco action — same Ctrl+F dialog the editor tab
        // uses. The widget hides its Replace tab automatically when
        // the editor is in `readOnly` mode, so users can't accidentally
        // try to edit a preview.
        ed.getAction('actions.find')?.run();
    };
    const bumpBinFont = (delta: number) => {
        setBinFontSize(prev => Math.max(BIN_FONT_MIN, Math.min(BIN_FONT_MAX, prev + delta)));
    };
    // Image preview zoom — driven by the wheel handler on the image
    // container. Reset whenever the previewed file changes so a zoomed
    // texture doesn't carry over to the next click.
    const IMAGE_ZOOM_MIN = 0.25;
    const IMAGE_ZOOM_MAX = 6;
    const [imageZoom, setImageZoom] = useState(1);
    // Pan offset for left-click-drag. Cleared whenever zoom resets to
    // 1× so the texture re-centers, and on every previewed-file
    // change. Refs track in-flight drags without forcing a render
    // for each mousemove.
    const [imagePan, setImagePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const panDragRef = useRef<{
        startX: number;
        startY: number;
        baseX: number;
        baseY: number;
    } | null>(null);
    const [panning, setPanning] = useState(false);

    const onImageWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setImageZoom(prev => Math.max(IMAGE_ZOOM_MIN, Math.min(IMAGE_ZOOM_MAX, prev * factor)));
    };

    const onImageMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        // Only the left mouse button starts a pan — right-click is
        // left alone for context menus, middle for scroll wheels.
        if (e.button !== 0) return;
        e.preventDefault();
        panDragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: imagePan.x,
            baseY: imagePan.y,
        };
        setPanning(true);
    };
    const onImageMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const drag = panDragRef.current;
        if (!drag) return;
        setImagePan({
            x: drag.baseX + (e.clientX - drag.startX),
            y: drag.baseY + (e.clientY - drag.startY),
        });
    };
    const onImageMouseUp = () => {
        if (!panDragRef.current) return;
        panDragRef.current = null;
        setPanning(false);
    };

    // Reset zoom + pan whenever the previewed file changes — a 4×
    // zoom and a panned offset on the previous texture shouldn't
    // carry over to the next click.
    useEffect(() => {
        setImageZoom(1);
        setImagePan({ x: 0, y: 0 });
    }, [wadSelected?.path_hash_hex, selected?.path]);
    // Double-click resets pan + zoom — handy "snap back" for when the
    // user has zoomed in tight and lost the image.
    const onImageDoubleClick = () => {
        setImageZoom(1);
        setImagePan({ x: 0, y: 0 });
    };
    // When true, clicking a row in a WAD also toggles its checkbox.
    // When false, only the checkbox itself toggles selection — clicking
    // the row only changes the preview. Some users prefer the strict
    // mode so a stray click doesn't add things to the extract queue.
    const [autoCheckOnClick, setAutoCheckOnClick] = useState(true);
    // Output layout: 'structure' recreates the WAD's folder tree (default),
    // 'flat' dumps every extracted file straight into the target dir.
    const [extractMode, setExtractMode] = useState<ExtractMode>('structure');
    // When preserving structure, whether to nest everything under a folder
    // named after the WAD (`aatrox/assets/...`) or extract its top-level
    // folders straight into the target. Ignored in flat mode.
    const [makeWadFolder, setMakeWadFolder] = useState(true);
    // Default extraction location — when enabled, extracts skip the
    // "pick a folder" dialog entirely and write straight to this path.
    // The path itself defaults to `Documents/Jade Exports` (resolved on
    // first run when the stored preference is empty).
    const [useDefaultLocation, setUseDefaultLocation] = useState(false);
    const [defaultExtractLocation, setDefaultExtractLocation] = useState('');
    // Prefix inserted under `assets/` / `data/` when the Viewer's
    // "Re-path" checkbox is on. Default mirrors Quartz's convention.
    const [repathPrefix, setRepathPrefix] = useState<string>('jade');
    useEffect(() => {
        invoke<string>('get_preference', {
            key: 'WadUseRenamePattern',
            defaultValue: 'True',
        })
            .then(v => setUseRenamePattern(v === 'True'))
            .catch(() => { /* offline / no APPDATA — keep default */ });
        invoke<string>('get_preference', {
            key: 'WadAutoCheckOnClick',
            defaultValue: 'True',
        })
            .then(v => setAutoCheckOnClick(v === 'True'))
            .catch(() => {});
        invoke<string>('get_preference', {
            key: 'WadExtractMode',
            defaultValue: 'structure',
        })
            .then(v => setExtractMode(v === 'flat' ? 'flat' : 'structure'))
            .catch(() => {});
        invoke<string>('get_preference', {
            key: 'WadMakeWadFolder',
            defaultValue: 'True',
        })
            .then(v => setMakeWadFolder(v === 'True'))
            .catch(() => {});
        invoke<string>('get_preference', {
            key: 'WadUseDefaultLocation',
            defaultValue: 'False',
        })
            .then(v => setUseDefaultLocation(v === 'True'))
            .catch(() => {});
        // Resolve the stored default location, falling back to
        // `Documents/Jade Exports` the first time (and persisting it so
        // the path the user sees in settings is always concrete).
        invoke<string>('get_preference', {
            key: 'WadRepathPrefix',
            defaultValue: 'jade',
        })
            .then(v => setRepathPrefix(v || 'jade'))
            .catch(() => {});
        invoke<string>('get_preference', {
            key: 'WadDefaultLocation',
            defaultValue: '',
        })
            .then(async (v) => {
                if (v) { setDefaultExtractLocation(v); return; }
                try {
                    const { documentDir, join } = await import('@tauri-apps/api/path');
                    const fallback = await join(await documentDir(), 'Jade Exports');
                    setDefaultExtractLocation(fallback);
                    invoke('set_preference', { key: 'WadDefaultLocation', value: fallback })
                        .catch(() => {});
                } catch { /* no path API — leave empty, dialog still works */ }
            })
            .catch(() => {});
    }, []);
    const toggleRenamePattern = (next: boolean) => {
        setUseRenamePattern(next);
        invoke('set_preference', {
            key: 'WadUseRenamePattern',
            value: next ? 'True' : 'False',
        }).catch(() => {});
    };
    const changeRepathPrefix = (next: string) => {
        // Trim whitespace; leave slash handling to the Rust side
        // (it strips leading/trailing slashes anyway).
        setRepathPrefix(next);
        invoke('set_preference', {
            key: 'WadRepathPrefix',
            value: next.trim(),
        }).catch(() => {});
    };
    const toggleAutoCheckOnClick = (next: boolean) => {
        setAutoCheckOnClick(next);
        invoke('set_preference', {
            key: 'WadAutoCheckOnClick',
            value: next ? 'True' : 'False',
        }).catch(() => {});
    };
    const changeExtractMode = (next: ExtractMode) => {
        setExtractMode(next);
        invoke('set_preference', {
            key: 'WadExtractMode',
            value: next,
        }).catch(() => {});
    };
    const toggleMakeWadFolder = (next: boolean) => {
        setMakeWadFolder(next);
        invoke('set_preference', {
            key: 'WadMakeWadFolder',
            value: next ? 'True' : 'False',
        }).catch(() => {});
    };
    const toggleUseDefaultLocation = (next: boolean) => {
        setUseDefaultLocation(next);
        invoke('set_preference', {
            key: 'WadUseDefaultLocation',
            value: next ? 'True' : 'False',
        }).catch(() => {});
    };
    const pickDefaultLocation = async () => {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false });
        if (typeof picked !== 'string') return;
        setDefaultExtractLocation(picked);
        invoke('set_preference', { key: 'WadDefaultLocation', value: picked })
            .catch(() => {});
    };

    /** Resolve where an extraction should write. When the default-location
     *  setting is on and a path is set, use it without a dialog; otherwise
     *  prompt the user. Returns `null` when the user cancels the dialog. */
    const resolveExtractTarget = async (): Promise<string | null> => {
        if (useDefaultLocation && defaultExtractLocation) {
            return defaultExtractLocation;
        }
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false });
        return typeof picked === 'string' ? picked : null;
    };

    // ── Preview state for WAD chunks (DDS / TEX / browser image). Disk-
    // side files only show metadata in the preview pane today. ──
    const [previewState, setPreviewState] = useState<{
        loading: boolean;
        dataUrl: string | null;
        error: string | null;
        format: string | null;
        width: number | null;
        height: number | null;
        /** Ritobin text for BIN previews (PROP / PTCH chunks). When set,
         *  the preview pane renders a scrollable monospace block instead
         *  of an image. Mirrors Flint's WadPreviewPanel: bytes flow
         *  through `convert_bin_bytes_to_text` without ever hitting
         *  disk so previewing is non-destructive. */
        binText: string | null;
    }>({
        loading: false, dataUrl: null, error: null, format: null,
        width: null, height: null, binText: null,
    });

    // ── Hash status / download ──
    const [hashStatus, setHashStatus] = useState<WadHashStatus | null>(null);
    const [hashDownloading, setHashDownloading] = useState(false);
    const [hashDownloadProgress, setHashDownloadProgress] = useState<WadHashDownloadProgressEvent | null>(null);

    // Probe hash status on first mount. The LMDB envs themselves open
    // lazily on the first lookup, so there's no eager warmup to schedule.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const status = await invoke<WadHashStatus>('wad_hash_status');
                if (cancelled) return;
                setHashStatus(status);
            } catch { /* offline / no APPDATA — leave status null */ }
        })();
        return () => { cancelled = true; };
    }, []);

    // Pipe hash-download progress into UI state. Runs once for the lifetime
    // of the view — multiple concurrent downloads aren't possible from the UI.
    useEffect(() => {
        const unlisten = listen<WadHashDownloadProgressEvent>('wad-hash-download-progress', (e) => {
            setHashDownloadProgress(e.payload);
            if (e.payload.phase === 'complete' || e.payload.phase === 'error') {
                setHashDownloading(false);
                // Re-check status so the banner disappears on success.
                invoke<WadHashStatus>('wad_hash_status').then(setHashStatus).catch(() => {});
            }
        });
        return () => { unlisten.then((u) => u()).catch(() => {}); };
    }, []);

    // Mirror extract-progress to local "extracting" state too so we can
    // show inline status text inside the WAD view (separate from the
    // global progress bar at the bottom). Suppressed during multi-WAD
    // batches — the loop drives status itself with a per-WAD aggregate
    // message rather than the noisy per-file event stream.
    useEffect(() => {
        const unlisten = listen<WadExtractProgressEvent>('wad-extract-progress', (e) => {
            if (multiWadActiveRef.current) return;
            const { phase, current, total, written, errors, action_id } = e.payload;
            if (extractActionRef.current && action_id !== extractActionRef.current) return;
            if (phase === 'preparing') {
                setExtractMessage('Preparing…');
            } else if (phase === 'extracting') {
                setExtractMessage(`Extracting ${current}/${total}…`);
            } else if (phase === 'complete') {
                setExtractMessage(`Extracted ${written} files${errors > 0 ? ` (${errors} errors)` : ''}`);
                setExtracting(false);
                extractActionRef.current = null;
            } else if (phase === 'cancelled') {
                setExtractMessage(`Cancelled at ${written} files`);
                setExtracting(false);
                extractActionRef.current = null;
            } else if (phase === 'error') {
                setExtractMessage('Extraction failed');
                setExtracting(false);
                extractActionRef.current = null;
            }
        });
        return () => { unlisten.then((u) => u()).catch(() => {}); };
    }, [multiWadActiveRef, setExtractMessage]);

    const downloadHashes = async () => {
        setHashDownloading(true);
        setHashDownloadProgress({ phase: 'checking', message: 'Connecting…', downloaded: 0, total: 0 });
        try {
            await invoke<string>('wad_download_hashes', { force: false });
        } catch (e) {
            setHashDownloading(false);
            setHashDownloadProgress({
                phase: 'error',
                message: typeof e === 'string' ? e : 'Download failed',
                downloaded: 0, total: 0,
            });
        }
    };

    const closeWad = async () => {
        if (mountInfo) {
            // Wipe every in-WAD browse entry for this mount before
            // tearing it down. Leaving them around would cause a
            // fresh open of the same WAD (different mount id) to
            // miss them anyway, but stale keys waste memory and
            // could surprise debugging.
            const stalePrefix = `wad:${mountInfo.id}:`;
            for (const k of Array.from(browseMemoryRef.current.keys())) {
                if (k.startsWith(stalePrefix)) browseMemoryRef.current.delete(k);
            }
            try { await invoke('wad_close', { id: mountInfo.id }); } catch { /* ignore */ }
        }
        setMountInfo(null);
        setWadEntries([]);
        setWadCurrentDir('');
        setWadSelected(null);
        setSelectedHashes(new Set());
    };

    /** Navigate to a different in-WAD folder. Saves the scroll +
     *  search state of the folder we're leaving so the restore
     *  effect can put us back where we were if we come back. */
    const navigateWadDir = (nextDir: string) => {
        if (mountInfo && nextDir !== wadCurrentDir) {
            const liveTop = listRef.current?.scrollTop ?? listScrollTop;
            browseMemoryRef.current.set(
                `wad:${mountInfo.id}:${wadCurrentDir}`,
                { scrollTop: liveTop, search },
            );
        }
        setWadCurrentDir(nextDir);
    };

    // Guards against the nav effect firing `openWad` twice for the
    // same WAD before mountInfo has updated — without this, a
    // duplicate call's late `setWadCurrentDir('')` overwrites the
    // navigation we performed in between, sending the user back to
    // the WAD root. Cleared in openWad's finally.
    const openWadInFlightRef = useRef<string | null>(null);

    // Browse-position memory keyed by a string id:
    //   - `disk:<currentPath>` for disk folder navigation
    //   - `wad:<mountId>:<wadCurrentDir>` for in-WAD folder navigation
    // Saved on every navigation transition; restored when returning
    // to a key that matches the current search. WAD-side entries are
    // cleared the moment we unmount that WAD so a fresh open of the
    // same WAD starts at the top.
    const browseMemoryRef = useRef<
        Map<string, { scrollTop: number; search: string }>
    >(new Map());

    /** Build the memory key for the current browse location. Disk
     *  paths and in-WAD folders share the same map but use distinct
     *  prefixes so they never collide. */
    const buildBrowseKey = (
        mount: { id: number } | null,
        diskPath: string,
        wadDir: string,
    ): string =>
        mount ? `wad:${mount.id}:${wadDir}` : `disk:${diskPath}`;

    const openWad = async (path: string, initialSubDir = '') => {
        if (openWadInFlightRef.current === path) return;
        openWadInFlightRef.current = path;
        // Capture the disk-side browse state (scroll + search) before
        // we navigate away, keyed by the path the user is currently
        // browsing. Restored by the scroll-reset effect when they return.
        if (currentPath) {
            browseMemoryRef.current.set(`disk:${currentPath}`, {
                scrollTop: listScrollTop,
                search,
            });
        }
        setOpeningWad(true);
        setError(null);
        // Browsing into a WAD shouldn't keep the disk-side preview row
        // selected, otherwise the preview pane shows stale info.
        setSelected(null);
        // The disk-side breadcrumb (`currentPath`) shouldn't follow a
        // dragged-in WAD — the WAD usually isn't a child of whatever
        // disk folder the user was looking at, so clear it to avoid a
        // misleading "League/aatrox.wad.client" trail.
        setCurrentPath('');
        try {
            const info = await invoke<WadOpenResult>('wad_open', { path });
            // Render the initial list immediately so the user sees the
            // WAD open instantly. The magic-byte sniff for unhashed
            // entries kicks off in parallel; when it finishes we
            // refetch to pick up the `<hex>.<ext>` rewrites.
            const items = await invoke<WadEntry[]>('wad_list_entries', { id: info.id });
            setMountInfo(info);
            setWadEntries(items);
            // Land at the caller's requested subdir when they passed
            // one — used by the Viewer's "Show files / Show BIN" jump
            // so the user opens the WAD pre-scoped to the right folder
            // instead of root.
            setWadCurrentDir(initialSubDir);
            setWadSelected(null);
            // Switching WADs starts with a clean queue — leftover
            // checkboxes from the previous WAD would silently leak
            // into the next extract action.
            setSelectedHashes(new Set());
            rememberRecentWad(path);

            // Fire-and-forget sniff. Heavy enough to take a few
            // seconds on a 30k-chunk WAD, but the first list is
            // already on screen — the refetch just upgrades the
            // unknown rows to typed ones.
            void (async () => {
                try {
                    const updated = await invoke<number>('wad_sniff_unknown', { id: info.id });
                    if (updated > 0) {
                        const refreshed = await invoke<WadEntry[]>('wad_list_entries', { id: info.id });
                        setWadEntries(refreshed);
                    }
                } catch { /* ignore — list is still usable without sniffed types */ }
            })();
        } catch (e) {
            setError(typeof e === 'string' ? e : 'Failed to open WAD');
        } finally {
            setOpeningWad(false);
            // Clear the in-flight latch regardless of outcome so a
            // failed open can be retried without being silently skipped.
            if (openWadInFlightRef.current === path) {
                openWadInFlightRef.current = null;
            }
        }
    };

    // Switch to a disk source — close any active WAD first so we don't
    // leave a stale mount around when the user navigates elsewhere.
    const goToSource = async (path: string) => {
        if (mountInfo) await closeWad();
        setCurrentPath(path);
    };

    /** League ships per-locale VO WADs alongside the main champion
     *  WAD using the pattern `<base>.<locale>.wad.client`, where the
     *  locale is a Riot region code like `en_US`, `fr_FR`, `ja_JP`,
     *  `ko_KR`, `es_MX`, `zh_CN`, etc.
     *
     *  - From a locale VO WAD → return the main WAD path (strip the
     *    `.<locale>` segment).
     *  - From a main WAD → return `null` (caller scans the dir to
     *    find which locale variants actually exist; we don't know
     *    which one the user wants without looking).
     */
    const stripLocaleSegment = (path: string): { main: string; isVo: boolean } => {
        // Match the basename's tail: optional `.<locale>` before
        // `.wad.client` / `.wad.mobile` / `.wad`. Two-letter language
        // + underscore + two-letter region.
        const m = path.match(/^(.*?)(\.[a-z]{2}_[A-Z]{2})(\.wad(?:\.(?:client|mobile))?)$/);
        if (m) return { main: m[1] + m[3], isVo: true };
        return { main: path, isVo: false };
    };

    /** Find a sibling locale VO WAD for the given main-WAD path.
     *  Lists the parent directory and returns the first file whose
     *  name matches `<basename-of-main>.<locale>.<ext>`. Returns
     *  null when nothing matches (champion has no VO shipped). */
    const findAnyLocaleSibling = async (mainPath: string): Promise<string | null> => {
        const norm = mainPath.replace(/\\/g, '/');
        const slash = norm.lastIndexOf('/');
        const dir = slash === -1 ? '' : mainPath.slice(0, slash);
        const baseName = slash === -1 ? mainPath : mainPath.slice(slash + 1);
        // Build the expected filename prefix + tail. Use `\\` to be
        // safe — the rust list_directory returns absolute paths in OS-
        // native form, so the matcher works on either separator.
        const tailMatch = baseName.match(/(\.wad(?:\.(?:client|mobile))?)$/i);
        if (!tailMatch) return null;
        const stem = baseName.slice(0, baseName.length - tailMatch[1].length);
        const tail = tailMatch[1];
        const prefix = `${stem}.`;
        try {
            const entries = await invoke<{ name: string; is_dir: boolean; path: string }[]>(
                'list_directory',
                { path: dir },
            );
            for (const e of entries) {
                if (e.is_dir) continue;
                if (!e.name.startsWith(prefix)) continue;
                // The bit between prefix and tail must look like a locale.
                const inner = e.name.slice(prefix.length, e.name.length - tail.length);
                if (/^[a-z]{2}_[A-Z]{2}$/.test(inner)) return e.path;
            }
        } catch {
            /* directory unreadable → no counterpart */
        }
        return null;
    };

    // Probe the counterpart whenever the mount path changes. For a
    // locale VO WAD we straight-up compute the main path. For the
    // main WAD we have to ASK the filesystem which locale variants
    // exist, since the user might have any locale installed.
    useEffect(() => {
        if (!mountInfo) {
            setWadCounterpartPath(null);
            return;
        }
        let cancelled = false;
        const { main, isVo } = stripLocaleSegment(mountInfo.path);
        (async () => {
            if (isVo) {
                // Locale VO → main. Verify the main exists before we
                // promise the user they can switch to it.
                try {
                    const exists = await invoke<boolean>('file_exists', { path: main });
                    if (!cancelled) setWadCounterpartPath(exists ? main : null);
                } catch {
                    if (!cancelled) setWadCounterpartPath(null);
                }
            } else {
                // Main → locale VO. Scan the dir for any sibling that
                // matches `<base>.<locale>.<ext>`.
                const found = await findAnyLocaleSibling(mountInfo.path);
                if (!cancelled) setWadCounterpartPath(found);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [mountInfo?.path]);

    /** Switch from the current WAD to its VO/main counterpart.
     *  Saves the current in-WAD path + selection under the source
     *  WAD's key, then restores any saved state for the destination.
     *  Called from the search-bar VO/main toggle button. */
    const switchToWadCounterpart = async () => {
        if (!mountInfo || !wadCounterpartPath) return;
        // Save current WAD's state before tearing it down.
        wadStateMemoryRef.current.set(mountInfo.path, {
            dir: wadCurrentDir,
            selectedHash: wadSelected?.path_hash_hex ?? null,
        });
        const target = wadCounterpartPath;
        const savedDest = wadStateMemoryRef.current.get(target);
        // Queue the selection-restore hash before openWad commits, so
        // the effect that watches `wadEntries` (below) can pick it up
        // as soon as the new WAD's chunk list lands.
        pendingWadSelectionRef.current = savedDest?.selectedHash ?? null;
        await closeWad();
        await openWad(target, savedDest?.dir ?? '');
    };

    // Apply any queued selection once the WAD's entries land (e.g.
    // after a VO/main switch). Single-shot — the ref is cleared after
    // the match so subsequent entry changes don't re-fire.
    useEffect(() => {
        const target = pendingWadSelectionRef.current;
        if (!target || wadEntries.length === 0) return;
        const match = wadEntries.find((e) => e.path_hash_hex === target);
        if (match) setWadSelected(match);
        pendingWadSelectionRef.current = null;
    }, [wadEntries]);

    // Clamp the context menu so it never spills off-screen near a
    // viewport edge. Measured + repositioned in a layout effect so the
    // menu paints once at the corrected spot — no flicker.
    const ctxMenuRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (!contextMenu || !ctxMenuRef.current) return;
        const el = ctxMenuRef.current;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 6;
        let left = contextMenu.x;
        let top = contextMenu.y;
        if (left + rect.width > vw - margin) left = Math.max(margin, contextMenu.x - rect.width);
        if (left + rect.width > vw - margin) left = vw - rect.width - margin;
        if (top + rect.height > vh - margin) top = Math.max(margin, contextMenu.y - rect.height);
        if (top + rect.height > vh - margin) top = vh - rect.height - margin;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }, [contextMenu]);

    // Close the context menu on any outside click / Esc / another
    // right-click. Mirrors how most native menus dismiss themselves.
    useEffect(() => {
        if (!contextMenu) return;
        const close = () => setContextMenu(null);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        window.addEventListener('click', close);
        window.addEventListener('contextmenu', close);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('contextmenu', close);
            window.removeEventListener('keydown', onKey);
        };
    }, [contextMenu]);

    // Right-click handler — opens the menu at the cursor. We
    // `preventDefault` to suppress the browser's native context menu,
    // and `stopPropagation` so the close-on-click listener installed
    // above doesn't immediately fire and dismiss us.
    const openContextMenu = (e: React.MouseEvent, row: BrowseRow) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, row });
    };

    // Copy the row's path (in-WAD for wad rows, OS path for disk rows).
    const handleCopyRowPath = (row: BrowseRow) => {
        setContextMenu(null);
        let p = '';
        if (row.kind === 'wad-file') p = row.entry.path;
        else if (row.kind === 'wad-folder') p = row.subPath;
        else p = row.entry.path;
        if (!p) return;
        navigator.clipboard.writeText(p).catch(() => {});
        onExtractStatus(`Copied ${p}`);
        setTimeout(() => onExtractStatus(null), 1400);
    };

    // Copy just the row's basename (the part after the last `/`).
    // Distinct from "Copy path" because users often want only the
    // filename without the full WAD-relative or disk path leading up
    // to it. Disabled when multiple rows are selected — picking which
    // name to copy in that case isn't meaningful.
    const handleCopyRowName = (row: BrowseRow) => {
        setContextMenu(null);
        let p = '';
        if (row.kind === 'wad-file') p = row.entry.path;
        else if (row.kind === 'wad-folder') p = row.subPath;
        else p = row.entry.path;
        if (!p) return;
        // Strip any trailing slash, then take the part after the last
        // separator (covers both / and \\ for disk paths on Windows).
        const trimmed = p.replace(/[\\/]+$/, '');
        const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
        const name = i === -1 ? trimmed : trimmed.slice(i + 1);
        navigator.clipboard.writeText(name).catch(() => {});
        onExtractStatus(`Copied ${name}`);
        setTimeout(() => onExtractStatus(null), 1400);
    };

    // Save a single WAD chunk to disk via "Save As" dialog. Bypasses
    // the folder-structure preference entirely — the file lands at
    // whatever path the user picks, with whatever name they choose.
    const handleSaveSingleWadFile = async (entry: WadEntry) => {
        setContextMenu(null);
        if (!mountInfo) return;
        const lastSlash = entry.path.lastIndexOf('/');
        const fname = lastSlash === -1 ? entry.path : entry.path.slice(lastSlash + 1);
        const { save } = await import('@tauri-apps/plugin-dialog');
        const picked = await save({ title: 'Save file as', defaultPath: fname });
        if (!picked || typeof picked !== 'string') return;
        try {
            const b64 = await invoke<string>('wad_read_chunk_b64', {
                id: mountInfo.id,
                pathHashHex: entry.path_hash_hex,
            });
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await invoke('write_bytes_file', { path: picked, bytes: Array.from(bytes) });
            onExtractStatus(`Saved ${fname}`);
        } catch (err) {
            onExtractStatus(`Save failed: ${err}`);
        }
    };

    // ── Send BIN chunk(s) to the editor ────────────────────────
    // Mirrors the Viewer's "Open in BIN editor" flow: pull each chunk's
    // bytes via `wad_read_chunk_b64`, convert through
    // `convert_bin_bytes_to_text`, and hand the result up via the
    // `onOpenSkinBinAsText` prop (App.tsx opens an editor tab with the
    // synthetic name). Accepts a list of entries so multi-select works
    // — each one becomes its own tab.
    const sendEntriesToEditor = async (entries: WadEntry[]) => {
        if (!onOpenSkinBinAsText || !mountInfo || entries.length === 0) return;
        let opened = 0;
        let failed = 0;
        for (const entry of entries) {
            try {
                const b64 = await invoke<string>('wad_read_chunk_b64', {
                    id: mountInfo.id,
                    pathHashHex: entry.path_hash_hex,
                });
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const text = await invoke<string>('convert_bin_bytes_to_text', {
                    binData: Array.from(bytes),
                });
                const lastSlash = entry.path.lastIndexOf('/');
                const fname = lastSlash === -1 ? entry.path : entry.path.slice(lastSlash + 1);
                onOpenSkinBinAsText(text, fname);
                opened++;
            } catch (err) {
                console.warn('[extract] send to editor failed:', entry.path, err);
                failed++;
            }
        }
        if (opened > 0) {
            onExtractStatus(
                failed > 0
                    ? `Sent ${opened} to editor (${failed} failed)`
                    : `Sent ${opened} ${opened === 1 ? 'file' : 'files'} to editor`,
            );
        } else if (failed > 0) {
            onExtractStatus(`Send to editor failed`);
        }
    };

    /** Returns the list of `.bin`/`.py` WadEntries the user means by
     *  right-clicking — if they have multi-select active and the
     *  right-clicked row is part of it, every selected `.bin`/`.py`;
     *  otherwise just the right-clicked row (if it is one). */
    const collectBinEntriesForRow = (row: BrowseRow): WadEntry[] => {
        if (row.kind !== 'wad-file') return [];
        const isBinPath = (p: string) => {
            const lower = p.toLowerCase();
            return lower.endsWith('.bin') || lower.endsWith('.py');
        };
        // Multi-select takes precedence iff the right-clicked row is in it.
        if (selectedHashes.size > 1 && selectedHashes.has(row.entry.path_hash_hex)) {
            return wadEntries.filter(
                (e) => selectedHashes.has(e.path_hash_hex) && isBinPath(e.path),
            );
        }
        return isBinPath(row.entry.path) ? [row.entry] : [];
    };

    const handleSendBinToEditor = async (row: BrowseRow) => {
        setContextMenu(null);
        const entries = collectBinEntriesForRow(row);
        if (entries.length === 0) return;
        await sendEntriesToEditor(entries);
    };

    /** Returns the absolute disk path if the row is a disk-side
     *  `.bin`/`.py` file, otherwise null. No multi-select on the disk
     *  side — single file at a time. */
    const collectDiskBinPathForRow = (row: BrowseRow): string | null => {
        if (row.kind !== 'disk-file') return null;
        const lower = row.entry.name.toLowerCase();
        if (!lower.endsWith('.bin') && !lower.endsWith('.py')) return null;
        return row.entry.path;
    };

    const handleSendDiskBinToEditor = (row: BrowseRow) => {
        setContextMenu(null);
        const path = collectDiskBinPathForRow(row);
        if (!path || !onOpenRecentFile) return;
        onOpenRecentFile(path);
        onExtractStatus(`Sent to editor`);
        setTimeout(() => onExtractStatus(null), 1400);
    };

    // Save a set of chunks flat to a folder. Used for "Save selected"
    // and "Save folder" — both pre-build the hash list and reuse
    // wad_extract with `flatten: true`, which writes every file's
    // basename directly into the target dir without recreating any
    // of the WAD's subfolder structure.
    const saveChunksFlat = async (hashes: string[], dialogTitle: string) => {
        if (!mountInfo || hashes.length === 0) return;
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false, title: dialogTitle });
        if (!picked || typeof picked !== 'string') return;
        try {
            const actionId = `extract-flat-${Date.now()}`;
            await invoke('wad_extract', {
                id: mountInfo.id,
                outputDir: picked,
                actionId,
                selectedHashes: hashes,
                useRename: true,
                flatten: true,
            });
        } catch (err) {
            onExtractStatus(`Save failed: ${err}`);
        }
    };

    const handleSaveSelectedFlat = () => {
        setContextMenu(null);
        const hashes = Array.from(selectedHashes);
        void saveChunksFlat(
            hashes,
            `Save ${hashes.length} file${hashes.length === 1 ? '' : 's'} (flat)`,
        );
    };

    const handleSaveFolderFlat = (subPath: string) => {
        setContextMenu(null);
        const prefix = subPath.toLowerCase() + '/';
        const hashes = wadEntries
            .filter((e) => {
                const lower = e.path.toLowerCase();
                return lower === subPath.toLowerCase() || lower.startsWith(prefix);
            })
            .map((e) => e.path_hash_hex);
        void saveChunksFlat(hashes, `Save folder (flat)`);
    };

    // External navigation request — Viewer's "Show BIN" / "Show files"
    // buttons land here. Mount the requested WAD if it isn't already,
    // then jump to the sub-path. Re-fires when the request changes
    // OR when mount/entries become available after a fresh openWad.
    useEffect(() => {
        if (!navRequest) return;
        const lowerSub = navRequest.subPath.toLowerCase().replace(/\/+$/, '');
        // For 'file' mode the target folder is the file's parent dir;
        // for 'folder' mode it's the folder itself. Computing this up
        // front lets us hand the folder to openWad so a fresh mount
        // lands directly at the right place instead of root.
        const targetFolder =
            navRequest.mode === 'folder'
                ? lowerSub
                : lowerSub.includes('/')
                    ? lowerSub.slice(0, lowerSub.lastIndexOf('/'))
                    : '';
        // Need the requested WAD mounted before we can navigate inside it.
        if (!mountInfo || mountInfo.path !== navRequest.wadPath) {
            void openWad(navRequest.wadPath, targetFolder);
            return; // re-runs when mountInfo flips
        }
        if (wadEntries.length === 0) return; // wait for entries
        if (navRequest.mode === 'folder') {
            setWadCurrentDir(targetFolder);
            setWadSelected(null);
        } else {
            setWadCurrentDir(targetFolder);
            const entry = wadEntries.find((e) => e.path.toLowerCase() === lowerSub);
            if (entry) setWadSelected(entry);
        }
        onNavConsumed();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navRequest, mountInfo?.path, wadEntries.length]);

    const startExtraction = async (overrideHashes?: string[]) => {
        if (!mountInfo) return;
        cancelRef.current = false;
        // Default: use the effective selection (checkboxes + click-pin).
        // Caller can pass an override — `[]` explicitly means "extract
        // everything" (Extract WAD button); a non-empty array means
        // "extract these specific hashes".
        const sel = overrideHashes !== undefined
            ? overrideHashes
            : effectiveSelection;
        const picked = await resolveExtractTarget();
        if (picked === null) return;

        // Nest the WAD's contents under a folder named after the WAD
        // itself (`test/aatrox/assets/...`) when preserving structure
        // *and* the "create WAD-name folder" setting is on. Flat mode or
        // a disabled toggle extracts straight into the picked directory.
        const flatten = extractMode === 'flat';
        const wadStem = mountInfo.name
            .replace(/\.wad\.client$/i, '')
            .replace(/\.wad\.mobile$/i, '')
            .replace(/\.wad$/i, '');
        const sep = picked.includes('\\') ? '\\' : '/';
        const nestUnderWad = !flatten && makeWadFolder;
        const targetDir = !nestUnderWad
            ? picked
            : picked.endsWith(sep)
                ? `${picked}${wadStem}`
                : `${picked}${sep}${wadStem}`;

        const actionId = `extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        extractActionRef.current = actionId;
        setExtracting(true);
        setExtractMessage('Starting…');
        try {
            const result = await invoke<WadExtractResult>('wad_extract', {
                id: mountInfo.id,
                outputDir: targetDir,
                actionId,
                selectedHashes: sel.length > 0 ? sel : null,
                useRename: useRenamePattern,
                flatten,
            });
            // Final summary already covered by the progress event; keep
            // this for cases where the event might lag the result.
            if (!extracting) {
                setExtractMessage(
                    `Wrote ${result.written}${result.errors ? ` (${result.errors} errors)` : ''} in ${(result.elapsed_ms / 1000).toFixed(1)}s`
                );
            }
        } catch (e) {
            setExtracting(false);
            extractActionRef.current = null;
            setExtractMessage(typeof e === 'string' ? e : 'Extraction failed');
        }
    };

    /** Drag-and-drop wiring. While the Extract view is mounted, dropping
     *  a `.wad.client` file anywhere on the window opens it directly —
     *  saves the user from drilling through Open / locations to find a
     *  WAD that's already on their desktop. Multiple WADs at once are
     *  supported: the first one is opened for browsing, the rest land
     *  in the recent-WADs list for quick access.
     *
     *  Tauri 2 surfaces drag-drop via the `tauri://drag-drop` event with
     *  a tagged payload; we listen on the global event API so this works
     *  regardless of which webview window the file was dropped on. */
    useEffect(() => {
        // Only the foreground Extract view claims dropped WADs — when
        // parked behind a BIN editor the app's global drag-drop handler
        // should win instead.
        if (!active) return;
        let unlistenDrop: (() => void) | undefined;
        let unlistenHover: (() => void) | undefined;
        let unlistenCancel: (() => void) | undefined;

        listen<{ paths?: string[]; type?: string }>('tauri://drag-enter', () => {
            setDropActive(true);
        }).then(u => { unlistenHover = u; }).catch(() => {});

        listen<{ paths?: string[]; type?: string }>('tauri://drag-leave', () => {
            setDropActive(false);
        }).then(u => { unlistenCancel = u; }).catch(() => {});

        listen<{ paths?: string[]; type?: string }>('tauri://drag-drop', (e) => {
            setDropActive(false);
            const paths = Array.isArray(e.payload?.paths) ? e.payload!.paths! : [];
            const wads = paths.filter(p => isWadFileName(p.replace(/\\/g, '/').split('/').pop() || ''));
            if (wads.length === 0) return;
            // First WAD: open it. Anything extra: just remember as
            // recents so the user can pick from there.
            const [first, ...rest] = wads;
            void openWad(first);
            for (const r of rest) rememberRecentWad(r);
        }).then(u => { unlistenDrop = u; }).catch(() => {});

        return () => {
            unlistenDrop?.();
            unlistenHover?.();
            unlistenCancel?.();
        };
    // openWad is stable enough across renders for our purposes; we don't
    // want to tear-down/re-register the global listener every time the
    // user clicks a file — only when the view's foreground state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const cancelExtraction = async () => {
        // Stop the multi-WAD loop from picking the next WAD.
        cancelRef.current = true;
        // And cancel whatever WAD is currently being processed (single
        // or multi — both cases fall through here).
        if (extractActionRef.current) {
            try {
                await invoke('wad_cancel_extract', { actionId: extractActionRef.current });
            } catch { /* ignore */ }
        }
    };

    // ── Hash scanning (overlay extraction) ──
    // Separate from WAD extraction: walks every chunk, scans PROP/PTCH for
    // embedded asset paths and SKN for submesh names, merges discoveries
    // into the FrogTools hash overlay so unknown hashes get real names on
    // subsequent reads. Progress flows through the same bottom status bar
    // that drives the extraction UI — no separate inline status row.
    const [scanning, setScanning] = useState(false);
    const scanActionRef = useRef<string | null>(null);

    useEffect(() => {
        const unlisten = listen<WadHashScanProgressEvent>('wad-hash-scan-progress', (e) => {
            const { action_id, phase, current, total } = e.payload;
            if (scanActionRef.current && action_id !== scanActionRef.current) return;
            if (phase === 'preparing') {
                onProgress(0);
                onExtractStatus('Mapping WAD…');
            } else if (phase === 'scanning') {
                onProgress(total > 0 ? Math.min(100, (current / total) * 100) : 0);
                onExtractStatus(`Scanning chunks ${current.toLocaleString()}/${total.toLocaleString()}…`);
            } else if (phase === 'merging') {
                onProgress(100);
                onExtractStatus('Merging hashes…');
            }
        });
        return () => { unlisten.then((u) => u()).catch(() => {}); };
    }, [onProgress, onExtractStatus]);

    const startHashScan = async () => {
        if (!mountInfo || scanning) return;
        const actionId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        scanActionRef.current = actionId;
        setScanning(true);
        onProgress(0);
        onExtractStatus('Starting hash scan…');
        try {
            const result = await invoke<WadHashScanResult>('wad_extract_hashes', {
                id: mountInfo.id,
                actionId,
            });
            const added = result.wad_paths_added + result.bin_names_added;
            const summary = added === 0
                ? `Scan complete — no new hashes found (${(result.wad_paths_scanned + result.bin_names_scanned).toLocaleString()} candidates) · ${(result.elapsed_ms / 1000).toFixed(1)}s`
                : `Found ${result.wad_paths_added.toLocaleString()} new path${result.wad_paths_added === 1 ? '' : 's'}` +
                  (result.bin_names_added > 0
                      ? `, ${result.bin_names_added.toLocaleString()} BIN name${result.bin_names_added === 1 ? '' : 's'}`
                      : '') +
                  ` · ${(result.elapsed_ms / 1000).toFixed(1)}s`;
            onProgress(100);
            onExtractStatus(summary);
            // Refresh the entry list — backend already re-resolved the
            // mount's hash table against the new overlay; the new
            // `wad_list_entries` call picks that up and the file list
            // re-renders with real names where the scan got hits.
            try {
                const items = await invoke<WadEntry[]>('wad_list_entries', { id: mountInfo.id });
                setWadEntries(items);
            } catch { /* ignore — user can re-open manually */ }
            // Clear bar + status after the same ~2s window the extraction
            // listener uses, so the two operations behave consistently.
            setTimeout(() => { onProgress(0); onExtractStatus(null); }, 2500);
        } catch (e) {
            onExtractStatus(typeof e === 'string' ? e : 'Hash scan failed');
            setTimeout(() => { onProgress(0); onExtractStatus(null); }, 4000);
        } finally {
            setScanning(false);
            scanActionRef.current = null;
        }
    };

    /** Sequentially extract a list of disk-side `.wad.client` files,
     *  each into its own `<output>/<wadStem>/` folder.
     *
     *  Drives the global progress bar by aggregated **file count** so
     *  the bar fills smoothly across the whole batch — but the status
     *  text only mentions WAD count so the user sees a clean "X of Y
     *  WADs" instead of the noisy per-file numbers. */
    const startDiskWadsExtraction = async (wadPaths: string[]) => {
        if (wadPaths.length === 0) return;
        const picked = await resolveExtractTarget();
        if (picked === null) return;

        cancelRef.current = false;
        multiWadActiveRef.current = true;
        setExtracting(true);
        onProgress(0);
        onExtractStatus(`Reading ${wadPaths.length} WAD header${wadPaths.length === 1 ? '' : 's'}…`);
        invoke('set_taskbar_progress', { state: 'indeterminate', completed: 0, total: 0 })
            .catch(() => {});

        // Step 1 — pre-mount every WAD up front so we know the total
        // file count before extraction starts. WAD `mount` is cheap
        // (TOC parse + bulk hash resolve, ~10-50 ms each), and having
        // an accurate `totalFiles` lets the bar fill smoothly across
        // the whole batch instead of resetting per WAD.
        type MountedRef = { path: string; info: WadOpenResult };
        const mounts: MountedRef[] = [];
        let totalFiles = 0;
        try {
            for (const path of wadPaths) {
                if (cancelRef.current) break;
                const info = await invoke<WadOpenResult>('wad_open', { path });
                mounts.push({ path, info });
                totalFiles += info.chunk_count;
            }
        } catch (e) {
            for (const m of mounts) {
                try { await invoke('wad_close', { id: m.info.id }); } catch { /* ignore */ }
            }
            multiWadActiveRef.current = false;
            setExtracting(false);
            extractActionRef.current = null;
            onExtractStatus(`Failed to read WADs: ${typeof e === 'string' ? e : (e instanceof Error ? e.message : 'unknown')}`);
            invoke('set_taskbar_progress', { state: 'error', completed: 0, total: 1 })
                .catch(() => {});
            setTimeout(() => {
                onProgress(0);
                onExtractStatus(null);
                invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 })
                    .catch(() => {});
            }, 2500);
            return;
        }

        if (cancelRef.current || mounts.length === 0) {
            for (const m of mounts) {
                try { await invoke('wad_close', { id: m.info.id }); } catch { /* ignore */ }
            }
            multiWadActiveRef.current = false;
            setExtracting(false);
            extractActionRef.current = null;
            onExtractStatus(null);
            onProgress(0);
            invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 })
                .catch(() => {});
            return;
        }

        const sep = picked.includes('\\') ? '\\' : '/';
        const totalWads = mounts.length;

        // Step 2 — listen to the live extracting events so the bar
        // updates *per file* but reflects the cumulative count across
        // every WAD already done.
        let baseFiles = 0;
        let activeAction: string | null = null;
        const unlistenPromise = listen<WadExtractProgressEvent>('wad-extract-progress', (e) => {
            if (e.payload.action_id !== activeAction) return;
            if (e.payload.phase !== 'extracting') return;
            const aggregated = baseFiles + e.payload.current;
            const denom = Math.max(totalFiles, 1);
            onProgress(Math.min(100, (aggregated / denom) * 100));
            invoke('set_taskbar_progress', {
                state: 'normal',
                completed: aggregated,
                total: denom,
            }).catch(() => {});
        });
        const unlisten = await unlistenPromise;

        let totalWritten = 0;
        let totalErrors = 0;
        let i = 0;
        try {
            for (; i < totalWads; i++) {
                if (cancelRef.current) break;
                const { path, info } = mounts[i];
                const baseName = path.replace(/\\/g, '/').split('/').pop() || path;
                const wadStem = baseName
                    .replace(/\.wad\.client$/i, '')
                    .replace(/\.wad\.mobile$/i, '')
                    .replace(/\.wad$/i, '');
                // In flat mode every WAD's files merge into the picked dir.
                // With the WAD-folder toggle off, structure is extracted
                // straight into the picked dir (WADs can overwrite each
                // other) — that's the user's explicit choice.
                const nestUnderWad = extractMode !== 'flat' && makeWadFolder;
                const targetDir = !nestUnderWad
                    ? picked
                    : picked.endsWith(sep)
                        ? `${picked}${wadStem}`
                        : `${picked}${sep}${wadStem}`;

                onExtractStatus(`Processing ${i + 1} of ${totalWads} WAD${totalWads === 1 ? '' : 's'}`);

                const actionId = `disk-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                activeAction = actionId;
                extractActionRef.current = actionId;
                try {
                    const result = await invoke<WadExtractResult>('wad_extract', {
                        id: info.id,
                        outputDir: targetDir,
                        actionId,
                        selectedHashes: null,
                        useRename: useRenamePattern,
                        flatten: extractMode === 'flat',
                    });
                    totalWritten += result.written;
                    totalErrors += result.errors;
                    if (result.cancelled) cancelRef.current = true;
                } catch (e) {
                    console.error(`[disk-extract] ${baseName} failed:`, e);
                    totalErrors += 1;
                }
                baseFiles += info.chunk_count;
                try { await invoke('wad_close', { id: info.id }); } catch { /* ignore */ }
            }
        } finally {
            unlisten();
        }

        // Close any mounts we never got to (cancelled mid-loop).
        for (let j = i; j < mounts.length; j++) {
            try { await invoke('wad_close', { id: mounts[j].info.id }); } catch { /* ignore */ }
        }

        const cancelled = cancelRef.current;
        const processedWads = i;
        multiWadActiveRef.current = false;
        setExtracting(false);
        extractActionRef.current = null;

        if (cancelled) {
            onProgress(100);
            onExtractStatus(`Cancelled — ${processedWads} of ${totalWads} WAD${totalWads === 1 ? '' : 's'} · ${totalWritten} files`);
            invoke('set_taskbar_progress', { state: 'error', completed: processedWads, total: totalWads })
                .catch(() => {});
        } else {
            onProgress(100);
            onExtractStatus(`Done — ${totalWads} WAD${totalWads === 1 ? '' : 's'} · ${totalWritten} files${totalErrors ? ` · ${totalErrors} errors` : ''}`);
            invoke('set_taskbar_progress', { state: 'normal', completed: totalFiles, total: Math.max(totalFiles, 1) })
                .catch(() => {});
        }

        setTimeout(() => {
            onProgress(0);
            onExtractStatus(null);
            invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 })
                .catch(() => {});
        }, 2000);
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [league, pbe, h, recents] = await Promise.all([
                    invoke<string | null>('detect_league_install'),
                    invoke<string | null>('detect_league_pbe_install'),
                    invoke<string | null>('get_home_directory'),
                    invoke<string>('get_preference', { key: 'RecentWads', defaultValue: '[]' }).catch(() => '[]'),
                ]);
                if (cancelled) return;
                setLeagueInstall(league);
                setLeaguePbeInstall(pbe);
                setHome(h);
                try {
                    const list = JSON.parse(recents);
                    if (Array.isArray(list)) setRecentWads(list.filter((p): p is string => typeof p === 'string'));
                } catch { /* corrupt JSON — leave empty */ }
                // Default browse path: Live install → PBE install → home.
                const initial = league || pbe || h || '';
                if (initial) setCurrentPath(initial);
            } catch { /* nothing — leave user to manually pick */ }
        })();
        return () => { cancelled = true; };
    }, []);

    /** Push a WAD path onto the recents list, dedup and cap at 8. */
    const rememberRecentWad = (path: string) => {
        setRecentWads(prev => {
            const filtered = prev.filter(p => p !== path);
            // Cap at 6 — fits in the sources column without forcing
            // a vertical scrollbar to appear next to the rest of the
            // location entries.
            const next = [path, ...filtered].slice(0, 6);
            invoke('set_preference', { key: 'RecentWads', value: JSON.stringify(next) }).catch(() => {});
            return next;
        });
    };

    // Reset the search box whenever the current location changes —
    // picking a new directory or stepping inside a WAD should start
    // fresh. Exception: returning to a disk path we previously left
    // (to open a WAD) restores the saved query so the user keeps
    // their filter through a Zac → WAD → back-to-Zac round trip.
    useEffect(() => {
        const key = buildBrowseKey(mountInfo, currentPath, wadCurrentDir);
        const saved = browseMemoryRef.current.get(key);
        setSearch(saved?.search ?? '');
    }, [currentPath, mountInfo?.id, wadCurrentDir]);

    // Disk listing — only refetch on disk side. When mounted into a WAD
    // we render `wadEntries` instead of hitting the filesystem again.
    useEffect(() => {
        if (!currentPath || mountInfo) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        invoke<DirEntry[]>('list_directory', { path: currentPath })
            .then(es => {
                if (cancelled) return;
                setEntries(es);
                setSelected(null);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(typeof e === 'string' ? e : 'Failed to read directory');
                setEntries([]);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [currentPath, mountInfo]);

    // Up button: in a WAD subdir → walk to parent subdir; at WAD root →
    // unmount and stay at the disk dir that contained the WAD; on disk →
    // go to the parent directory as before.
    const goUp = async () => {
        if (mountInfo) {
            if (wadCurrentDir) {
                const idx = wadCurrentDir.lastIndexOf('/');
                navigateWadDir(idx === -1 ? '' : wadCurrentDir.slice(0, idx));
            } else {
                // Closing from WAD root — drop the user back into the
                // disk folder the WAD lived in, otherwise the file list
                // is empty + the breadcrumb says "Pick a source" while
                // stale entries from before the WAD was opened still
                // render. Compute parent BEFORE closeWad runs so we
                // still have mountInfo.path available.
                const wadPath = mountInfo.path;
                let parent = '';
                try {
                    parent = await invoke<string>('parent_directory', { path: wadPath });
                } catch { /* fall through to empty — UI will show empty state */ }
                await closeWad();
                if (parent && parent !== wadPath) setCurrentPath(parent);
            }
            return;
        }
        if (!currentPath) return;
        const parent = await invoke<string>('parent_directory', { path: currentPath });
        if (parent && parent !== currentPath) setCurrentPath(parent);
    };

    const browseFolder = async () => {
        // Lazily pull plugin-dialog so the welcome screen doesn't drag it
        // in unless the user actually clicks Browse.
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false });
        if (typeof picked === 'string') {
            if (mountInfo) await closeWad();
            setCurrentPath(picked);
        }
    };

    // Unified row model — one list whether we're browsing the disk or
    // the inside of a mounted WAD. The row's `kind` discriminates click
    // behaviour and which icon / metadata columns we show.
    type BrowseRow =
        | { kind: 'disk-folder'; entry: DirEntry }
        | { kind: 'disk-file'; entry: DirEntry }
        | { kind: 'wad-folder'; name: string; size: number; count: number; subPath: string }
        | { kind: 'wad-file'; entry: WadEntry };

    // Pre-build a path tree once on mount. Without this, every folder
    // navigation re-iterated the full `wadEntries` array (O(N)) just to
    // group entries by their direct-child folder name — felt fine on
    // 5k-entry WADs but turned into a multi-second freeze when stepping
    // into a 30k+ entry WAD's root.
    //
    // With the tree we walk straight to the target node and read its
    // already-grouped `children` map and `files` array. O(folder
    // children) per navigation regardless of total WAD size.
    type WadTreeNode = {
        name: string;
        fullPath: string;
        children: Map<string, WadTreeNode>;
        files: WadEntry[];
        descendantFileCount: number;
        descendantTotalSize: number;
        /** Every chunk hash under this folder — bubbled up at tree-build
         *  time so checkbox state queries don't re-scan `wadEntries` on
         *  every render. Populated for folder nodes only; leaf files
         *  are tracked through their parent's `files` array. */
        descendantHashes: string[];
    };
    const wadTree: WadTreeNode | null = useMemo(() => {
        if (!mountInfo) return null;
        const newNode = (name: string, fullPath: string): WadTreeNode => ({
            name, fullPath,
            children: new Map(), files: [],
            descendantFileCount: 0, descendantTotalSize: 0,
            descendantHashes: [],
        });
        const root = newNode('', '');
        for (const entry of wadEntries) {
            const parts = entry.path.split('/');
            if (parts.length === 0) continue;
            // Strip the file name — what's left is the directory chain.
            parts.pop();
            let node = root;
            let acc = '';
            for (const part of parts) {
                if (!part) continue;
                acc = acc ? `${acc}/${part}` : part;
                let child = node.children.get(part);
                if (!child) {
                    child = newNode(part, acc);
                    node.children.set(part, child);
                }
                child.descendantFileCount += 1;
                child.descendantTotalSize += entry.size;
                child.descendantHashes.push(entry.path_hash_hex);
                node = child;
            }
            node.files.push(entry);
        }
        return root;
    }, [mountInfo, wadEntries]);

    // Walk the tree to a sub-path. O(depth) — used by the folder
    // checkbox state lookups so they don't re-scan `wadEntries`.
    const getWadNode = (subPath: string): WadTreeNode | null => {
        if (!wadTree) return null;
        if (!subPath) return wadTree;
        let node: WadTreeNode = wadTree;
        for (const part of subPath.split('/')) {
            if (!part) continue;
            const child = node.children.get(part);
            if (!child) return null;
            node = child;
        }
        return node;
    };

    // Searching builds a flat list — pre-lowercase every path once so
    // each keystroke doesn't pay `path.toLowerCase()` × N. Cheap memo,
    // ~10 ms for 20k entries.
    const wadSearchIndex = useMemo<{ entry: WadEntry; lower: string }[] | null>(() => {
        if (!mountInfo) return null;
        return wadEntries.map(entry => ({ entry, lower: entry.path.toLowerCase() }));
    }, [mountInfo, wadEntries]);

    const visibleRows: BrowseRow[] = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (mountInfo && wadTree) {
            // WAD mode — search bypasses the tree and returns the first
            // 1000 substring matches across the whole WAD; otherwise we
            // walk the tree to the current sub-path and project its
            // children into rows.
            if (q && wadSearchIndex) {
                // Scope: by default we restrict matches to the current
                // sub-folder + its descendants — the toggle next to the
                // search input flips this back to "search the whole
                // WAD" when the user wants to.
                const scopePrefix = searchWholeWad
                    ? ''
                    : wadCurrentDir
                        ? `${wadCurrentDir.toLowerCase()}/`
                        : '';
                const out: BrowseRow[] = [];
                for (const { entry, lower } of wadSearchIndex) {
                    if (scopePrefix && !lower.startsWith(scopePrefix)) continue;
                    if (lower.includes(q)) {
                        out.push({ kind: 'wad-file', entry });
                        if (out.length >= 1000) break;
                    }
                }
                return out;
            }
            let node = wadTree;
            if (wadCurrentDir) {
                for (const part of wadCurrentDir.split('/')) {
                    if (!part) continue;
                    const child = node.children.get(part);
                    if (!child) return [];
                    node = child;
                }
            }
            const dirRows: BrowseRow[] = [];
            for (const child of node.children.values()) {
                dirRows.push({
                    kind: 'wad-folder',
                    name: child.name,
                    size: child.descendantTotalSize,
                    count: child.descendantFileCount,
                    subPath: child.fullPath,
                });
            }
            dirRows.sort((a, b) => {
                const an = (a as Extract<BrowseRow, { kind: 'wad-folder' }>).name;
                const bn = (b as Extract<BrowseRow, { kind: 'wad-folder' }>).name;
                return an.localeCompare(bn);
            });
            const fileRows: BrowseRow[] = node.files
                .slice()
                .sort((a, b) => a.path.localeCompare(b.path))
                .map(entry => ({ kind: 'wad-file' as const, entry }));
            return dirRows.concat(fileRows);
        }
        // Disk mode — substring filter on file names.
        const list = q ? entries.filter(e => e.name.toLowerCase().includes(q)) : entries;
        return list.map(entry => ({
            kind: entry.is_dir ? 'disk-folder' as const : 'disk-file' as const,
            entry,
        }));
    }, [mountInfo, wadTree, wadSearchIndex, wadCurrentDir, entries, search, searchWholeWad]);

    // Breadcrumb walks disk → WAD file → in-WAD path. Each segment is
    // clickable; clicking a disk segment while inside a WAD unmounts it
    // first so we don't end up with a stale mount.
    type Crumb = { label: string; onClick: () => void };
    const breadcrumb: Crumb[] = useMemo(() => {
        const out: Crumb[] = [];
        if (currentPath) {
            const norm = currentPath.replace(/\\/g, '/');
            const parts = norm.split('/').filter(Boolean);
            let acc = norm.startsWith('/') ? '/' : '';
            for (const p of parts) {
                if (acc && !acc.endsWith('/') && !acc.endsWith('\\')) acc += '/';
                acc += p;
                const seg = acc.replace(/\//g, '\\');
                out.push({
                    label: p,
                    onClick: () => {
                        if (mountInfo) {
                            void closeWad().then(() => setCurrentPath(seg));
                        } else {
                            setCurrentPath(seg);
                        }
                    },
                });
            }
        }
        if (mountInfo) {
            // WAD itself sits as a "folder" segment between disk and in-WAD
            // path. Clicking it returns to the WAD's root.
            out.push({ label: mountInfo.name, onClick: () => navigateWadDir('') });
            const subParts = wadCurrentDir.split('/').filter(Boolean);
            let acc = '';
            for (const p of subParts) {
                acc = acc ? `${acc}/${p}` : p;
                const path = acc;
                out.push({ label: p, onClick: () => navigateWadDir(path) });
            }
        }
        return out;
    }, [currentPath, mountInfo, wadCurrentDir]);

    // Preview pipeline — runs for whichever side is currently selected
    // (WAD chunk or disk file). Both paths flow through the same TEX /
    // DDS / browser-image decoder; only the byte source differs:
    //   • WAD chunk → `wad_read_chunk_b64`
    //   • Disk file → `read_file_base64`
    // Disk-mode .dds and .tex previews exist so already-extracted assets
    // stay viewable from the file list.
    useEffect(() => {
        const reset = () => setPreviewState({
            loading: false, dataUrl: null, error: null, format: null,
            width: null, height: null, binText: null,
        });

        type Source = { path: string; fetchB64: () => Promise<string> };
        let source: Source | null = null;
        if (wadSelected && mountInfo) {
            const id = mountInfo.id;
            const hex = wadSelected.path_hash_hex;
            source = {
                path: wadSelected.path,
                fetchB64: () => invoke<string>('wad_read_chunk_b64', { id, pathHashHex: hex }),
            };
        } else if (selected && !selected.is_dir) {
            const path = selected.path;
            source = {
                path,
                fetchB64: () => invoke<string>('read_file_base64', { path }),
            };
        }
        if (!source) { reset(); return; }

        const lower = source.path.toLowerCase();
        const dot = lower.lastIndexOf('.');
        const ext = dot === -1 ? '' : lower.slice(dot);
        const isDDS = ext === '.dds';
        const isTEX = ext === '.tex';
        const isBrowserImg = ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.bmp';
        // BIN preview works the same for WAD chunks and disk files —
        // the only difference is the byte source (`source.fetchB64`
        // already covers both).
        const isBIN = ext === '.bin' || ext === '.py';
        if (!isDDS && !isTEX && !isBrowserImg && !isBIN) { reset(); return; }

        let cancelled = false;
        setPreviewState({
            loading: true, dataUrl: null, error: null, format: null,
            width: null, height: null, binText: null,
        });
        (async () => {
            try {
                const b64 = await source!.fetchB64();
                if (cancelled) return;
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

                if (isDDS) {
                    try {
                        const { dataURL, width, height, ddsFormat } = ddsBufferToDataURL(bytes.buffer, 512);
                        if (!cancelled) setPreviewState({
                            loading: false, dataUrl: dataURL, error: null,
                            format: ddsFormatName(ddsFormat), width, height, binText: null,
                        });
                    } catch (jsErr) {
                        // The TS DDS decoder only handles DXT1/DXT5/BGRA8 +
                        // RGBA8 right now. Anything else (BC5/BC7/etc.) gets
                        // routed through the Rust decoder which covers them.
                        const fallback = await invoke<{
                            data_url: string; width: number; height: number;
                            format: string; has_alpha: boolean;
                        }>('decode_texture_bytes_to_png', { bytesB64: b64 });
                        if (!cancelled) setPreviewState({
                            loading: false, dataUrl: fallback.data_url, error: null,
                            format: fallback.format, width: fallback.width,
                            height: fallback.height, binText: null,
                        });
                        // Log so the in-browser-decode-failed path is visible
                        // in devtools but not surfaced to the user.
                        console.debug('[preview] DDS via Rust fallback:', jsErr);
                    }
                } else if (isTEX) {
                    try {
                        const { dataURL, width, height, format } = texBufferToDataURL(bytes.buffer, 512);
                        if (!cancelled) setPreviewState({
                            loading: false, dataUrl: dataURL, error: null,
                            format: texFormatName(format), width, height, binText: null,
                        });
                    } catch (jsErr) {
                        // Same fallback as DDS: TS decoder is DXT1/DXT5/BGRA8
                        // only. BC5 / BC7 / anything newer goes through Rust.
                        const fallback = await invoke<{
                            data_url: string; width: number; height: number;
                            format: string; has_alpha: boolean;
                        }>('decode_texture_bytes_to_png', { bytesB64: b64 });
                        if (!cancelled) setPreviewState({
                            loading: false, dataUrl: fallback.data_url, error: null,
                            format: fallback.format, width: fallback.width,
                            height: fallback.height, binText: null,
                        });
                        console.debug('[preview] TEX via Rust fallback:', jsErr);
                    }
                } else if (isBIN) {
                    // Magic-byte gate so we don't waste a converter call
                    // on `.bin` chunks that aren't actually League BINs.
                    const magic = String.fromCharCode(...bytes.slice(0, 4));
                    if (magic !== 'PROP' && magic !== 'PTCH') {
                        throw new Error(`Not a League BIN file (magic: ${magic.replace(/[^\x20-\x7e]/g, '?')})`);
                    }
                    // `convert_bin_bytes_to_text` expects a JS array of
                    // bytes — same shape Flint uses. Heavy on big files;
                    // command runs on the Tauri async runtime so the UI
                    // stays responsive while we wait.
                    const text = await invoke<string>('convert_bin_bytes_to_text', {
                        binData: Array.from(bytes),
                    });
                    if (!cancelled) setPreviewState({
                        loading: false, dataUrl: null, error: null,
                        format: magic, width: null, height: null, binText: text,
                    });
                } else {
                    const mime = ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
                    const dataURL = `data:${mime};base64,${b64}`;
                    const img = new Image();
                    await new Promise<void>((res, rej) => {
                        img.onload = () => res();
                        img.onerror = () => rej(new Error('Image decode failed'));
                        img.src = dataURL;
                    });
                    if (!cancelled) setPreviewState({
                        loading: false, dataUrl: dataURL, error: null,
                        format: ext.slice(1).toUpperCase(), width: img.width, height: img.height,
                        binText: null,
                    });
                }
            } catch (e) {
                if (!cancelled) setPreviewState({
                    loading: false, dataUrl: null,
                    error: typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Preview failed'),
                    format: null, width: null, height: null, binText: null,
                });
            }
        })();
        return () => { cancelled = true; };
    }, [wadSelected, selected, mountInfo]);

    const previewItem: { name: string; ext: string; size: number; type: string; path: string } | null = useMemo(() => {
        if (wadSelected) {
            const dot = wadSelected.path.lastIndexOf('.');
            const ext = dot === -1 ? '' : wadSelected.path.slice(dot);
            const name = wadSelected.path.includes('/')
                ? wadSelected.path.slice(wadSelected.path.lastIndexOf('/') + 1)
                : wadSelected.path;
            return {
                name,
                ext,
                size: wadSelected.size,
                type: wadSelected.unknown ? 'Unknown' : (ext || 'File'),
                path: wadSelected.path,
            };
        }
        if (selected) {
            return {
                name: selected.name,
                ext: selected.extension ? `.${selected.extension}` : '',
                size: selected.size,
                type: selected.is_dir
                    ? 'Folder'
                    : (selected.extension ? `.${selected.extension}` : 'File'),
                path: selected.path,
            };
        }
        return null;
    }, [wadSelected, selected]);

    // Pin the breadcrumb's horizontal scroll to its right edge whenever
    // the path changes, so an overflowing path always shows the latest
    // segments — matching Windows Explorer's address bar truncation.
    const breadcrumbRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = breadcrumbRef.current;
        if (!el) return;
        el.scrollLeft = el.scrollWidth;
    }, [breadcrumb]);

    // ── Virtualised list rendering ──
    // Row height is fixed at 52px (CSS) so we can compute a window of
    // rows directly from `scrollTop` instead of measuring each row.
    // Critical for WADs with 5–20k+ chunks where rendering every row
    // froze the UI for seconds.
    //
    // Layout: a single content div with `height = N*52` holds every row
    // absolutely-positioned at `top = i*52`. Switching from a
    // top/bottom-spacer-div approach to absolute positioning means the
    // content div's own height never changes during scroll — only the
    // small set of rendered rows have their inline `top` style mutated,
    // which React applies as a tiny DOM diff. The previous spacer
    // approach forced the parent flex container to relayout on every
    // scroll tick, which was visible as blank rows on big WADs.
    const ROW_HEIGHT = 52;
    const ROW_OVERSCAN = 24;
    const listRef = useRef<HTMLDivElement>(null);
    const [listScrollTop, setListScrollTop] = useState(0);
    const [listViewH, setListViewH] = useState(600);
    const scrollRafRef = useRef<number | null>(null);
    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const update = () => setListViewH(el.clientHeight);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
        };
    }, []);
    // Reset scroll when the row set changes — except when we're
    // returning to a key (disk path OR in-WAD folder) we previously
    // visited AND the active search matches the saved one, in which
    // case restore the saved scroll position. The same map handles
    // both: disk transitions get `disk:<path>`, in-WAD transitions
    // get `wad:<mountId>:<folder>` (saved by `navigateWadDir`).
    useEffect(() => {
        const key = buildBrowseKey(mountInfo, currentPath, wadCurrentDir);
        const saved = browseMemoryRef.current.get(key);
        const matchesSavedQuery = saved !== undefined && saved.search === search;
        if (matchesSavedQuery) {
            // Two RAF wait so the row list has committed before we set
            // scrollTop — without it the assignment runs against an
            // empty container and silently no-ops.
            const top = saved.scrollTop;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setListScrollTop(top);
                    if (listRef.current) listRef.current.scrollTop = top;
                });
            });
            return;
        }
        setListScrollTop(0);
        if (listRef.current) listRef.current.scrollTop = 0;
    }, [currentPath, mountInfo?.id, wadCurrentDir, search]);
    // rAF-coalesce scrollTop updates so we don't re-render at the
    // browser's full scroll-event rate (which can exceed 120Hz on
    // some setups). One render per frame is plenty.
    const handleListScroll = () => {
        if (scrollRafRef.current !== null) return;
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            const el = listRef.current;
            if (el) setListScrollTop(el.scrollTop);
        });
    };
    const totalRows = visibleRows.length;
    const visibleStart = Math.max(0, Math.floor(listScrollTop / ROW_HEIGHT) - ROW_OVERSCAN);
    const visibleEnd = Math.min(totalRows, Math.ceil((listScrollTop + listViewH) / ROW_HEIGHT) + ROW_OVERSCAN);
    const renderedRows = visibleRows.slice(visibleStart, visibleEnd);

    const handleRowClick = (row: BrowseRow) => {
        if (row.kind === 'disk-folder') {
            setCurrentPath(row.entry.path);
            return;
        }
        if (row.kind === 'disk-file') {
            if (isWadFileName(row.entry.name)) {
                openWad(row.entry.path);
            } else {
                setSelected(row.entry);
                setWadSelected(null);
            }
            return;
        }
        if (row.kind === 'wad-folder') {
            navigateWadDir(row.subPath);
            setWadSelected(null);
            return;
        }
        // wad-file click semantics:
        //   - With auto-check ON (default): row click is a toggle. An
        //     unchecked row becomes checked + previewed; a checked row
        //     becomes unchecked (regardless of whether it's the current
        //     preview), so the user never has to "close preview first"
        //     to remove an item from the queue.
        //   - With auto-check OFF: row click only changes the preview.
        //     Selection is driven exclusively by checkbox clicks — for
        //     users who don't want stray clicks queuing files.
        const hash = row.entry.path_hash_hex;
        const isCurrentPreview = wadSelected?.path_hash_hex === hash;
        if (!autoCheckOnClick) {
            // Strict-mode: just move the preview. Re-clicking the same
            // row toggles the preview off so the user can dismiss it
            // without having to scroll away.
            if (isCurrentPreview) {
                setWadSelected(null);
            } else {
                setWadSelected(row.entry);
                setSelected(null);
            }
            return;
        }
        const isChecked = selectedHashes.has(hash);
        if (isChecked) {
            setSelectedHashes(prev => {
                const next = new Set(prev);
                next.delete(hash);
                return next;
            });
            // Clear the preview only if it was pinned to the row we
            // just unchecked. Otherwise leave the preview alone so the
            // user keeps reading whatever they were looking at.
            if (isCurrentPreview) setWadSelected(null);
        } else {
            setSelectedHashes(prev => {
                const next = new Set(prev);
                next.add(hash);
                return next;
            });
            setWadSelected(row.entry);
            setSelected(null);
        }
    };

    // Hashes under a WAD sub-path. Reads them straight off the tree
    // node (populated at mount time) — used to be `wadEntries.filter`
    // which was O(total-WAD) per call and turned folder rendering into
    // a multi-second freeze on big WADs because every visible folder
    // row re-scanned the whole entry list twice.
    const hashesUnderPath = (subPath: string): string[] => {
        const node = getWadNode(subPath);
        return node ? node.descendantHashes : [];
    };

    const toggleFileHash = (hash: string) => {
        setSelectedHashes(prev => {
            const next = new Set(prev);
            if (next.has(hash)) next.delete(hash);
            else next.add(hash);
            return next;
        });
    };

    const toggleFolderHashes = (subPath: string) => {
        const folderHashes = hashesUnderPath(subPath);
        setSelectedHashes(prev => {
            const allChecked = folderHashes.length > 0
                && folderHashes.every(h => prev.has(h));
            const next = new Set(prev);
            if (allChecked) for (const h of folderHashes) next.delete(h);
            else for (const h of folderHashes) next.add(h);
            return next;
        });
    };

    // Folder selection state — short-circuits aggressively because the
    // common case is "no checkboxes ticked anywhere", in which every
    // folder is trivially "none". Only when `selectedHashes` is non-
    // empty do we actually scan the folder's descendant hashes.
    const folderSelectionState = (
        subPath: string,
    ): 'none' | 'partial' | 'full' => {
        if (selectedHashes.size === 0) return 'none';
        const hashes = hashesUnderPath(subPath);
        if (hashes.length === 0) return 'none';
        let any = false;
        let allSelected = true;
        for (const h of hashes) {
            if (selectedHashes.has(h)) any = true;
            else allSelected = false;
            // Once we've seen both, we know it's partial — bail early.
            if (any && !allSelected) return 'partial';
        }
        if (allSelected) return 'full';
        return 'none';
    };
    const isFolderFullySelected = (subPath: string): boolean =>
        folderSelectionState(subPath) === 'full';
    const isFolderPartiallySelected = (subPath: string): boolean =>
        folderSelectionState(subPath) === 'partial';

    // Click on a wad-file already adds it to `selectedHashes`, so the
    // "Extract Selected" set is just the checkbox state — no separate
    // click-pin layer to merge.
    const effectiveSelection = useMemo(() => Array.from(selectedHashes), [selectedHashes]);

    // Build the list of SKNs the user could plausibly extract as a
    // skin mod. A SKN qualifies only if its sibling skin BIN exists
    // in the same WAD — that's our cross-check so we don't offer
    // entries the BIN-walk wouldn't be able to root on. Path pattern:
    //   assets/<…>/characters/<champ>/skins/<skinFolder>/<champ>.skn
    //   data/<…>/characters/<champ>/skins/skin<N>.bin (or skin<NN>)
    // `base` ↔ skin0; `skinN` ↔ skinN; `skinNN` is accepted as a
    // variant that maps to the same N.
    interface SknCandidate {
        hash: string;
        path: string;
        champion: string;
        skinId: number;
        label: string;
    }
    const skinModCandidates = useMemo<SknCandidate[]>(() => {
        if (!mountInfo || wadEntries.length === 0) return [];
        const binPaths = new Set<string>();
        for (const e of wadEntries) {
            const lower = e.path.toLowerCase();
            if (lower.endsWith('.bin')) binPaths.add(lower);
        }
        const out: SknCandidate[] = [];
        for (const e of wadEntries) {
            const lower = e.path.toLowerCase();
            if (!lower.endsWith('.skn')) continue;
            const m = lower.match(/\/characters\/([^/]+)\/skins\/([^/]+)\/[^/]+\.skn$/);
            if (!m) continue;
            const [, champ, skinFolder] = m;
            let skinId: number | null = null;
            if (skinFolder === 'base') skinId = 0;
            else {
                const sm = skinFolder.match(/^skin(\d+)$/);
                if (sm) skinId = parseInt(sm[1], 10);
            }
            if (skinId === null) continue;
            // BIN naming: `skin<N>.bin` (most common). `skin<NN>.bin`
            // (zero-padded for single digits) also accepted — Riot
            // has shipped both historically.
            const padded = `skin${String(skinId).padStart(2, '0')}.bin`;
            const unpadded = `skin${skinId}.bin`;
            const expected = [
                `data/characters/${champ}/skins/${unpadded}`,
                `data/characters/${champ}/skins/${padded}`,
            ];
            const hasBin = expected.some(p => binPaths.has(p));
            if (!hasBin) continue;
            const champTitle = champ.charAt(0).toUpperCase() + champ.slice(1);
            out.push({
                hash: e.path_hash_hex,
                path: e.path,
                champion: champ,
                skinId,
                label: skinId === 0
                    ? `${champTitle} — Base`
                    : `${champTitle} — Skin ${skinId}`,
            });
        }
        out.sort((a, b) => a.champion.localeCompare(b.champion) || a.skinId - b.skinId);
        return out;
    }, [mountInfo, wadEntries]);

    // Multi-select set of extraction targets inside the modal. Each item is
    // a (parent SKN hash, chroma slot) pair — `chromaSlot` null = the base
    // skin, otherwise the chroma's `skin{N}` slot. The user can tick several
    // skins / chromas and the extractor pulls files for all of them.
    const [skinModSelection, setSkinModSelection] = useState<SkinModSelectionItem[]>([]);
    const toggleSkinModSel = (hash: string, chromaSlot: number | null) => {
        setSkinModSelection(prev => {
            const i = prev.findIndex(s => s.hash === hash && s.chromaSlot === chromaSlot);
            if (i >= 0) {
                const next = [...prev];
                next.splice(i, 1);
                return next;
            }
            return [...prev, { hash, chromaSlot }];
        });
    };
    // Default the selection when the modal's candidate set changes: prefer a
    // SKN ticked in the file list, else the first candidate. Existing valid
    // picks are kept; stale ones (skin no longer present) are dropped.
    useEffect(() => {
        if (skinModCandidates.length === 0) {
            setSkinModSelection([]);
            return;
        }
        setSkinModSelection(prev => {
            const valid = prev.filter(s => skinModCandidates.some(c => c.hash === s.hash));
            if (valid.length > 0) return valid;
            const ticked = skinModCandidates.find(c => selectedHashes.has(c.hash));
            return [{ hash: (ticked ?? skinModCandidates[0]).hash, chromaSlot: null }];
        });
    }, [skinModCandidates, selectedHashes]);

    // CDragon champion payloads (skin names + chroma lists), keyed by the
    // lowercase champion alias we parse out of WAD paths. Fetched lazily
    // when the dialog opens; names/chromas just don't show if offline.
    const [cdByChamp, setCdByChamp] = useState<Record<string, CDragonChampionDetails>>({});

    // Enrich the bare SKN candidates with CDragon names + the chromas that
    // actually have a `skin{N}.bin` present in this WAD. This is what the
    // picker renders (parent rows + expandable chroma children).
    const skinModSkins = useMemo<SkinModSkin[]>(() => {
        const binPaths = new Set<string>();
        for (const e of wadEntries) {
            const lower = e.path.toLowerCase();
            if (lower.endsWith('.bin')) binPaths.add(lower);
        }
        const hasBin = (champ: string, slot: number) =>
            binPaths.has(`data/characters/${champ}/skins/skin${slot}.bin`) ||
            binPaths.has(`data/characters/${champ}/skins/skin${String(slot).padStart(2, '0')}.bin`);
        return skinModCandidates.map(c => {
            const champTitle = c.champion.charAt(0).toUpperCase() + c.champion.slice(1);
            const cdSkin = cdByChamp[c.champion]?.skins.find(s => s.num === c.skinId);
            const name = cdSkin?.name;
            // Format: "<skin name> — Skin N" (base: "<champ> — Base"). The
            // CDragon base-skin name is just the champion name; fall back to
            // the WAD-derived champ title when offline / unnamed.
            const label = c.skinId === 0
                ? `${name ?? champTitle} — Base`
                : `${name ?? champTitle} — Skin ${c.skinId}`;
            // Dedupe chroma slots (CDragon occasionally repeats) and keep
            // only those whose bin is in the WAD; never list the parent.
            const seen = new Set<number>();
            const chromas = (cdSkin?.chromas ?? [])
                .map(ch => ({ slot: ch.id % 1000, name: ch.name }))
                .filter(ch => {
                    if (ch.slot === c.skinId || seen.has(ch.slot)) return false;
                    if (!hasBin(c.champion, ch.slot)) return false;
                    seen.add(ch.slot);
                    return true;
                })
                .sort((a, b) => a.slot - b.slot);
            return { hash: c.hash, skinId: c.skinId, path: c.path, champion: c.champion, label, chromas };
        });
    }, [skinModCandidates, cdByChamp, wadEntries]);

    // Persistent state for the per-extract options modal — closed by
    // default. Defaults mirror the Viewer's: repath off, merge off,
    // HUD off, skip SFX on, export VO off.
    const [skinModOpen, setSkinModOpen] = useState(false);
    const [skinModFlags, setSkinModFlags] = useState({
        repath: false,
        mergeLinked: false,
        preserveHud: false,
        skipSfx: true,
        exportVo: false,
    });
    const [skinModBusy, setSkinModBusy] = useState(false);

    // Fetch CDragon names/chromas lazily once the dialog is open (keyed off
    // the champions present in the WAD). Declared here because it reads
    // `skinModOpen`; results feed the `skinModSkins` memo above.
    useEffect(() => {
        if (!skinModOpen || skinModCandidates.length === 0) return;
        const champs = Array.from(new Set(skinModCandidates.map(c => c.champion)));
        const missing = champs.filter(c => !cdByChamp[c]);
        if (missing.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const list = await fetchChampions('latest');
                const byAlias = new Map(list.map(c => [c.alias.toLowerCase(), c]));
                const fetched = await Promise.all(missing.map(async champ => {
                    const meta = byAlias.get(champ.toLowerCase());
                    if (!meta) return null;
                    try {
                        return [champ, await fetchChampionDetails(meta.id, 'latest')] as const;
                    } catch { return null; }
                }));
                if (cancelled) return;
                setCdByChamp(prev => {
                    const next = { ...prev };
                    for (const r of fetched) if (r) next[r[0]] = r[1];
                    return next;
                });
            } catch { /* network down — fall back to bare numbers */ }
        })();
        return () => { cancelled = true; };
    }, [skinModOpen, skinModCandidates, cdByChamp]);

    /** Kick off the BIN-walk extraction. Mirrors `exportSkinFiles` in
     *  ModelViewerStage.tsx — same Rust command, same VO locale-WAD
     *  discovery + mount/unmount dance, same status flow. */
    const runSkinModExtract = async () => {
        if (!mountInfo || skinModSelection.length === 0) return;
        const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
        const picked = await openDialog({ directory: true, multiple: false, title: 'Choose output folder' });
        if (!picked || typeof picked !== 'string') return;
        setSkinModBusy(true);
        let voMountId: number | null = null;
        let progressUnlisten: (() => void) | null = null;
        try {
            // Pull persisted prefs same way the Viewer does.
            let prefix = 'jade';
            let makeWadFolder = true;
            try {
                const [vPrefix, vWad] = await Promise.all([
                    invoke<string>('get_preference', { key: 'WadRepathPrefix', defaultValue: 'jade' }),
                    invoke<string>('get_preference', { key: 'WadMakeWadFolder', defaultValue: 'True' }),
                ]);
                prefix = (vPrefix || 'jade').trim();
                makeWadFolder = vWad === 'True';
            } catch { /* keep defaults */ }
            const wadFolderName = makeWadFolder
                ? (mountInfo.name.replace(/\.wad(?:\.client|\.mobile)?$/i, '') || 'mod').toLowerCase()
                : null;

            // VO locale-WAD discovery — same `<base>.<locale>.<ext>`
            // sibling lookup used by the Viewer's Export VO and by the
            // WelcomeScreen VO switcher.
            if (skinModFlags.exportVo) {
                try {
                    const mainPath = mountInfo.path;
                    const norm = mainPath.replace(/\\/g, '/');
                    const slash = norm.lastIndexOf('/');
                    const dir = slash === -1 ? '' : mainPath.slice(0, slash);
                    const baseName = slash === -1 ? mainPath : mainPath.slice(slash + 1);
                    const tailMatch = baseName.match(/(\.wad(?:\.(?:client|mobile))?)$/i);
                    if (tailMatch) {
                        const stem = baseName.slice(0, baseName.length - tailMatch[1].length);
                        const tail = tailMatch[1];
                        const prefix2 = `${stem}.`;
                        const entries = await invoke<{ name: string; is_dir: boolean; path: string }[]>(
                            'list_directory', { path: dir },
                        ).catch(() => []);
                        let localePath: string | null = null;
                        for (const e of entries) {
                            if (e.is_dir || !e.name.startsWith(prefix2) || !e.name.endsWith(tail)) continue;
                            const inner = e.name.slice(prefix2.length, e.name.length - tail.length);
                            if (/^[a-z]{2}_[a-z]{2}$/i.test(inner)) { localePath = e.path; break; }
                        }
                        if (localePath) {
                            const opened = await invoke<{ id: number }>('wad_open', { path: localePath });
                            voMountId = opened.id;
                        }
                    }
                } catch (e) {
                    console.warn('[extract] export VO locale WAD lookup failed:', e);
                }
            }

            // Extract every ticked target into the SAME output folder. Each
            // call writes its own skin bin + assets; multiple calls merge in
            // the folder. VO mount + prefs are shared across the batch.
            const targets = skinModSelection;
            let totalWritten = 0;
            let totalErrors = 0;
            const allErrorMessages: string[] = [];
            let totalRenames = 0;

            // Drive ONE continuous progress bar across the whole batch
            // instead of letting each skin reset it 0→100. Same approach as
            // the multi-WAD loop: suppress the passive listeners and emit an
            // aggregated percentage ourselves. Each skin owns a `1/N` slice
            // of the bar; its own `current/total` fills that slice. We can't
            // know a skin's chunk count up front, so we aggregate by segment
            // fraction rather than absolute file counts.
            multiWadActiveRef.current = true;
            onProgress(0);
            let completedSegs = 0;
            let activeAction: string | null = null;
            progressUnlisten = await listen<WadExtractProgressEvent>('wad-extract-progress', (e) => {
                if (e.payload.action_id !== activeAction) return;
                const { phase, current, total } = e.payload;
                const frac = phase === 'complete'
                    ? 1
                    : phase === 'extracting' && total > 0
                        ? current / total
                        : 0;
                const pct = Math.min(100, ((completedSegs + frac) / targets.length) * 100);
                onProgress(pct);
                invoke('set_taskbar_progress', {
                    state: 'normal',
                    completed: Math.round(pct),
                    total: 100,
                }).catch(() => {});
            });

            for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                const chromaTail = t.chromaSlot != null ? ` chroma (skin${t.chromaSlot})` : '';
                const batchTail = targets.length > 1 ? ` (${i + 1}/${targets.length})` : '';
                onExtractStatus(`Extracting skin mod${chromaTail}${batchTail}${skinModFlags.repath ? ' (repath)' : ''}…`);
                const actionId = `extract-skin-${Date.now()}-${i}`;
                activeAction = actionId;
                const result = await invoke<{
                    written: number;
                    errors: number;
                    error_messages: string[];
                    renames: { original: string; renamed: string }[];
                }>('wad_extract_skin_assets', {
                    id: mountInfo.id,
                    outputDir: picked,
                    actionId,
                    sknChunkHashHex: t.hash,
                    repath: skinModFlags.repath,
                    repathPrefix: prefix,
                    wadFolderName,
                    mergeLinked: skinModFlags.mergeLinked,
                    preserveHudIcons: skinModFlags.preserveHud,
                    skipSfxRepath: skinModFlags.skipSfx,
                    exportVo: skinModFlags.exportVo,
                    voMountId,
                    // Chroma-aware extraction — when a chroma row is ticked we
                    // pass its slot so Rust roots the walk on the chroma BIN
                    // (same path the Viewer's "Export skin files" uses).
                    chromaSkinNum: t.chromaSlot,
                });
                totalWritten += result.written;
                totalErrors += result.errors;
                totalRenames += result.renames?.length ?? 0;
                if (result.error_messages?.length) allErrorMessages.push(...result.error_messages);
                if (result.renames?.length) {
                    console.group(`[extract] skin mod target ${i + 1} — ${result.renames.length} long-path renames`);
                    for (const { original, renamed } of result.renames) console.info(`${original}  →  ${renamed}`);
                    console.groupEnd();
                }
                completedSegs++;
            }
            // Land the bar at 100% and fade it (plus the status text + taskbar)
            // a beat later — the passive listeners are suppressed, so we own
            // the reset here just like the multi-WAD loop does.
            onProgress(100);
            invoke('set_taskbar_progress', { state: 'normal', completed: 100, total: 100 }).catch(() => {});
            const errTail = totalErrors > 0 ? ` (${totalErrors} errors)` : '';
            const fromTail = targets.length > 1 ? ` from ${targets.length} skins` : '';
            const renameTail = totalRenames > 0 ? ` · ${totalRenames} long-path renames` : '';
            onExtractStatus(`Extracted ${totalWritten} file${totalWritten === 1 ? '' : 's'}${fromTail}${errTail}${renameTail}`);
            if (allErrorMessages.length) {
                console.group(`[extract] skin mod — ${allErrorMessages.length} errors`);
                for (const m of allErrorMessages) console.warn(m);
                console.groupEnd();
            }
            setSkinModOpen(false);
            setTimeout(() => {
                onProgress(0);
                onExtractStatus(null);
                invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 }).catch(() => {});
            }, 2000);
        } catch (e) {
            onExtractStatus(`Extract failed: ${e}`);
            console.warn('[extract] skin mod failed:', e);
            onProgress(0);
            invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 }).catch(() => {});
            setTimeout(() => onExtractStatus(null), 6000);
        } finally {
            // Stop driving the bar + re-enable the passive listeners.
            if (progressUnlisten) progressUnlisten();
            multiWadActiveRef.current = false;
            if (voMountId !== null) {
                invoke('wad_close', { id: voMountId }).catch(() => {});
            }
            setSkinModBusy(false);
        }
    };
    // Total queued items, mode-aware: WAD-mode counts files in the
    // mount, disk-mode counts ticked `.wad.client` paths.
    const totalSelectedFiles = mountInfo
        ? effectiveSelection.length
        : selectedDiskWads.size;

    const toggleDiskWad = (path: string) => {
        setSelectedDiskWads(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    // Range-select anchor: the index of the most recent checkbox click.
    // Reset whenever the visible row set changes — referencing an old
    // index after navigation would select garbage rows.
    const lastCheckboxIndexRef = useRef<number | null>(null);
    useEffect(() => {
        lastCheckboxIndexRef.current = null;
    }, [wadCurrentDir, mountInfo?.id, search]);

    const handleCheckboxClick = (rowIndex: number, e: React.MouseEvent) => {
        e.stopPropagation();
        const row = visibleRows[rowIndex];
        if (!row) return;
        // Only WAD entries (in-WAD) and disk-mode `.wad.client` rows are
        // meaningful targets — disk folders / non-WAD files have no
        // checkbox to toggle.
        const isCheckable = row.kind === 'wad-file'
            || row.kind === 'wad-folder'
            || (row.kind === 'disk-file' && isWadFileName(row.entry.name));
        if (!isCheckable) return;

        const collectHashes = (r: BrowseRow): string[] => {
            if (r.kind === 'wad-file') return [r.entry.path_hash_hex];
            if (r.kind === 'wad-folder') return hashesUnderPath(r.subPath);
            return [];
        };
        const collectDiskWads = (r: BrowseRow): string[] => {
            if (r.kind === 'disk-file' && isWadFileName(r.entry.name)) {
                return [r.entry.path];
            }
            return [];
        };
        const isRowChecked = (r: BrowseRow): boolean => {
            if (r.kind === 'wad-file') return selectedHashes.has(r.entry.path_hash_hex);
            if (r.kind === 'wad-folder') return isFolderFullySelected(r.subPath);
            if (r.kind === 'disk-file' && isWadFileName(r.entry.name)) {
                return selectedDiskWads.has(r.entry.path);
            }
            return false;
        };

        if (e.shiftKey && lastCheckboxIndexRef.current !== null) {
            const start = Math.min(lastCheckboxIndexRef.current, rowIndex);
            const end = Math.max(lastCheckboxIndexRef.current, rowIndex);
            // Target state = whatever the just-clicked row is about to
            // become, applied uniformly to the whole range. Mirrors
            // Explorer's shift-range select.
            const target = !isRowChecked(row);
            if (mountInfo) {
                setSelectedHashes(prev => {
                    const next = new Set(prev);
                    for (let i = start; i <= end; i++) {
                        for (const h of collectHashes(visibleRows[i])) {
                            if (target) next.add(h);
                            else next.delete(h);
                        }
                    }
                    return next;
                });
            } else {
                setSelectedDiskWads(prev => {
                    const next = new Set(prev);
                    for (let i = start; i <= end; i++) {
                        for (const p of collectDiskWads(visibleRows[i])) {
                            if (target) next.add(p);
                            else next.delete(p);
                        }
                    }
                    return next;
                });
            }
        } else if (row.kind === 'wad-file') {
            toggleFileHash(row.entry.path_hash_hex);
        } else if (row.kind === 'wad-folder') {
            toggleFolderHashes(row.subPath);
        } else if (row.kind === 'disk-file') {
            toggleDiskWad(row.entry.path);
        }
        lastCheckboxIndexRef.current = rowIndex;
    };

    return (
        <div className="welcome-extract">
            {/* 3-column Word-Open layout: sources column on the left,
                file list in the middle, preview on the right. WADs slot
                into this same layout — they act like folders inside the
                file list, with the breadcrumb walking through the WAD
                path and the preview pane decoding DDS / TEX entries. */}
            <h1 className="welcome-extract-title">Extract</h1>

            {hashStatus && !hashStatus.present && (
                <div className="welcome-hash-banner">
                    <div className="welcome-hash-banner-text">
                        <strong>WAD hashes not downloaded.</strong>
                        <span>
                            File names will appear as 16-char hex until the LMDB hashtable is fetched (~50 MB, shared with Quartz).
                        </span>
                    </div>
                    <button
                        type="button"
                        className="welcome-hash-banner-btn"
                        disabled={hashDownloading}
                        onClick={downloadHashes}
                    >
                        {hashDownloading
                            ? hashDownloadProgress
                                ? `${hashDownloadProgress.phase}…`
                                : 'Downloading…'
                            : 'Download hashes'}
                    </button>
                </div>
            )}

            <div className="welcome-extract-cols">
                {/* ── Sources column ── */}
                <div className="welcome-extract-sources-col">
                    <div className="welcome-source-section-title">Locations</div>
                    {leagueInstall ? (
                        <button
                            type="button"
                            className={`welcome-source-row${(!mountInfo && currentPath === leagueInstall) ? ' active' : ''}`}
                            onClick={() => goToSource(leagueInstall)}
                        >
                            <FolderIcon size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">League of Legends</span>
                                <span className="welcome-source-row-path" title={leagueInstall}>
                                    {leagueInstall}
                                </span>
                            </span>
                        </button>
                    ) : (
                        <div className="welcome-source-row welcome-source-disabled">
                            <FolderIcon size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">League of Legends</span>
                                <span className="welcome-source-row-path">Not detected</span>
                            </span>
                        </div>
                    )}
                    {leaguePbeInstall ? (
                        <button
                            type="button"
                            className={`welcome-source-row${(!mountInfo && currentPath === leaguePbeInstall) ? ' active' : ''}`}
                            onClick={() => goToSource(leaguePbeInstall)}
                        >
                            <FolderIcon size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">League of Legends PBE</span>
                                <span className="welcome-source-row-path" title={leaguePbeInstall}>
                                    {leaguePbeInstall}
                                </span>
                            </span>
                        </button>
                    ) : null}
                    {home && (
                        <button
                            type="button"
                            className={`welcome-source-row${(!mountInfo && currentPath === home) ? ' active' : ''}`}
                            onClick={() => goToSource(home)}
                        >
                            <House size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">User folder</span>
                                <span className="welcome-source-row-path" title={home}>{home}</span>
                            </span>
                        </button>
                    )}

                    {recentWads.length > 0 && (
                        <>
                            <div className="welcome-source-section-title welcome-source-section-spaced">
                                Recent WADs
                            </div>
                            {recentWads.slice(0, 6).map(path => {
                                const baseName = path.replace(/\\/g, '/').split('/').pop() || path;
                                const parent = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || path;
                                return (
                                    <button
                                        key={path}
                                        type="button"
                                        className={`welcome-source-row${mountInfo?.path === path ? ' active' : ''}`}
                                        onClick={() => openWad(path)}
                                        title={path}
                                    >
                                        <WadIcon size={20} isOpen={mountInfo?.path === path} />
                                        <span className="welcome-source-row-text">
                                            <span className="welcome-source-row-label">{baseName}</span>
                                            <span className="welcome-source-row-path" title={parent}>{parent}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </>
                    )}

                    <div className="welcome-source-section-title welcome-source-section-spaced">
                        Other locations
                    </div>
                    <button type="button" className="welcome-source-row" onClick={browseFolder}>
                        <FolderIcon size={20} />
                        <span className="welcome-source-row-text">
                            <span className="welcome-source-row-label">Browse…</span>
                            <span className="welcome-source-row-path">Pick any folder</span>
                        </span>
                    </button>

                    {/* Extraction-specific settings — pinned to the bottom
                        of the sources column via `margin-top: auto`. The
                        button opens a tabbed dialog (mirrors the global
                        Settings layout) so the settings panel can grow
                        alongside future extraction-only options. */}
                    <div className="welcome-source-extract-settings">
                        <button
                            type="button"
                            className="welcome-source-settings-toggle"
                            onClick={() => setExtractionSettingsOpen(true)}
                        >
                            <span>Extraction settings</span>
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    </div>
                </div>

                <ExtractionSettingsDialog
                    isOpen={extractionSettingsOpen}
                    onClose={() => setExtractionSettingsOpen(false)}
                    useRenamePattern={useRenamePattern}
                    onUseRenamePatternChange={toggleRenamePattern}
                    autoCheckOnClick={autoCheckOnClick}
                    onAutoCheckOnClickChange={toggleAutoCheckOnClick}
                    extractMode={extractMode}
                    onExtractModeChange={changeExtractMode}
                    makeWadFolder={makeWadFolder}
                    onMakeWadFolderChange={toggleMakeWadFolder}
                    useDefaultLocation={useDefaultLocation}
                    onUseDefaultLocationChange={toggleUseDefaultLocation}
                    defaultLocation={defaultExtractLocation}
                    onPickDefaultLocation={pickDefaultLocation}
                    repathPrefix={repathPrefix}
                    onRepathPrefixChange={changeRepathPrefix}
                />

                {/* "Extract as skin mod" popup — same toggles the Viewer
                    exposes in its Advanced section, scoped to this one
                    extract action. Per-extract; defaults are reset on open. */}
                {skinModOpen && (
                    <div className="welcome-skinmod-overlay" onClick={() => !skinModBusy && setSkinModOpen(false)}>
                        <div className="welcome-skinmod-modal" onClick={(e) => e.stopPropagation()}>
                            <div className="welcome-skinmod-head">
                                <span className="welcome-skinmod-title">Extract as skin mod</span>
                                <button
                                    type="button"
                                    className="welcome-skinmod-close"
                                    onClick={() => !skinModBusy && setSkinModOpen(false)}
                                    aria-label="Close"
                                >×</button>
                            </div>

                            {/* Skin picker — every SKN whose sibling BIN was
                                found in the WAD, named via CDragon, with each
                                skin's WAD-present chromas as expandable rows. */}
                            <div className="welcome-skinmod-section-label">Skin</div>
                            <SkinModPicker
                                skins={skinModSkins}
                                selected={skinModSelection}
                                onToggle={toggleSkinModSel}
                                placeholder={skinModCandidates.length === 0 ? 'No valid skins in this WAD' : 'Pick skins…'}
                                disabled={skinModBusy}
                                className="welcome-skinmod-dropdown"
                            />
                            {skinModSelection.length > 0 && (
                                <div className="welcome-skinmod-skn-path">
                                    {skinModSelection.length === 1
                                        ? 'Extracting 1 target'
                                        : `Extracting ${skinModSelection.length} targets`}
                                </div>
                            )}

                            <div className="welcome-skinmod-section-label welcome-skinmod-section-label-mt">Options</div>
                            <div className="welcome-skinmod-options">
                                {([
                                    {
                                        key: 'repath',
                                        title: 'Repath',
                                        sub: 'Insert prefix under assets/ and rewrite BIN refs.',
                                        icon: <FolderDownIcon size={16} />,
                                    },
                                    {
                                        key: 'mergeLinked',
                                        title: 'Merge linked BINs',
                                        sub: 'Fold every linked dep into the primary skin BIN.',
                                        icon: <SaveAllIcon size={16} />,
                                    },
                                    {
                                        key: 'preserveHud',
                                        title: 'Preserve HUD icons',
                                        sub: 'Include /hud/icons2d/ and keep their BIN refs canonical.',
                                        icon: <Aperture size={16} />,
                                    },
                                    {
                                        key: 'skipSfx',
                                        title: 'Skip SFX',
                                        sub: 'Don’t extract /sounds/. Game uses Riot’s installed audio.',
                                        icon: <ToolCaseIcon size={16} />,
                                    },
                                    {
                                        key: 'exportVo',
                                        title: 'Export VO',
                                        sub: 'Pull this skin’s voiceover from the locale WAD.',
                                        icon: <MicIcon size={16} />,
                                    },
                                ] as const).map(opt => {
                                    const on = skinModFlags[opt.key];
                                    return (
                                        <button
                                            type="button"
                                            key={opt.key}
                                            className={`welcome-skinmod-opt${on ? ' on' : ''}`}
                                            onClick={() => setSkinModFlags(f => ({ ...f, [opt.key]: !f[opt.key] }))}
                                        >
                                            <span className="welcome-skinmod-opt-icon">{opt.icon}</span>
                                            <span className="welcome-skinmod-opt-text">
                                                <span className="welcome-skinmod-opt-title">{opt.title}</span>
                                                <span className="welcome-skinmod-opt-sub">{opt.sub}</span>
                                            </span>
                                            <span className={`welcome-skinmod-opt-pill${on ? ' on' : ''}`}>
                                                {on ? 'On' : 'Off'}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="welcome-skinmod-actions">
                                <button
                                    type="button"
                                    className="welcome-skinmod-cancel"
                                    onClick={() => !skinModBusy && setSkinModOpen(false)}
                                    disabled={skinModBusy}
                                >Cancel</button>
                                <button
                                    type="button"
                                    className="welcome-skinmod-go"
                                    onClick={runSkinModExtract}
                                    disabled={skinModBusy || skinModSelection.length === 0}
                                >{skinModBusy
                                    ? 'Extracting…'
                                    : skinModSelection.length > 1
                                        ? `Extract ${skinModSelection.length}`
                                        : 'Extract'}</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Drop overlay — dimmed sheet across the whole Extract
                    view while a `.wad.client` is being dragged in. */}
                {dropActive && (
                    <div className="welcome-extract-dropzone" aria-hidden>
                        <div className="welcome-extract-dropzone-inner">
                            <WadIcon size={48} />
                            <span>Drop a .wad.client to mount</span>
                        </div>
                    </div>
                )}

                {/* ── File list column ── */}
                <div className="welcome-extract-files-col">
                    <div className="welcome-extract-toolbar">
                        <button
                            type="button"
                            className="welcome-tool-btn"
                            onClick={goUp}
                            disabled={!currentPath && !mountInfo}
                            title={mountInfo
                                ? (wadCurrentDir ? 'Up one folder (inside WAD)' : 'Close WAD')
                                : 'Up one folder'}
                        >
                            <ArrowUpLucide size={16} />
                        </button>
                        <button
                            type="button"
                            className="welcome-tool-btn"
                            onClick={() => {
                                if (!currentPath) return;
                                invoke('open_folder_in_explorer', { path: currentPath })
                                    .catch(() => {});
                            }}
                            disabled={!currentPath || !!mountInfo}
                            title="Reveal current folder in Explorer"
                        >
                            <LucideFolderOpen size={16} />
                        </button>
                        <div className="welcome-breadcrumb" ref={breadcrumbRef}>
                            {breadcrumb.length === 0 && (
                                <span className="welcome-breadcrumb-empty">
                                    Pick a source on the left
                                </span>
                            )}
                            {breadcrumb.map((b, i) => (
                                <span key={i} className="welcome-breadcrumb-segment">
                                    <button
                                        type="button"
                                        className="welcome-breadcrumb-btn"
                                        onClick={b.onClick}
                                    >
                                        {b.label}
                                    </button>
                                    {i < breadcrumb.length - 1 && <ChevronRightIcon size={12} />}
                                </span>
                            ))}
                        </div>
                        {/* Copy-path button — copies the address of the
                            currently-browsed location to the clipboard.
                            Disk mode copies the OS path; WAD mode copies
                            the in-WAD sub-path so the value is shareable
                            with other modders / mods. */}
                        {(currentPath || mountInfo) && (
                            <button
                                type="button"
                                className="welcome-tool-btn"
                                onClick={() => {
                                    const path = mountInfo
                                        ? (wadCurrentDir || mountInfo.path)
                                        : currentPath;
                                    if (!path) return;
                                    navigator.clipboard.writeText(path).then(
                                        () => {
                                            setCopyHint('Copied');
                                            setTimeout(() => setCopyHint(null), 1400);
                                        },
                                        () => {
                                            setCopyHint('Copy failed');
                                            setTimeout(() => setCopyHint(null), 1400);
                                        },
                                    );
                                }}
                                title="Copy current path to clipboard"
                                aria-label="Copy current path"
                            >
                                {copyHint ? (
                                    <span className="welcome-tool-btn-text">{copyHint}</span>
                                ) : (
                                    <CopyIcon size={16} />
                                )}
                            </button>
                        )}
                        {/* Hash-scan button — only visible when a WAD is
                            mounted. Walks every chunk for embedded asset
                            paths + submesh names, merges discoveries into
                            the FrogTools hash overlay so unknown hashes
                            get real names without re-opening. Progress and
                            results flow through the bottom status bar. */}
                        {mountInfo && (
                            <button
                                type="button"
                                className="welcome-tool-btn"
                                onClick={startHashScan}
                                disabled={scanning}
                                title={scanning
                                    ? 'Scanning this WAD for hashes…'
                                    : 'Scan this WAD for embedded asset paths to recover unknown hashes'}
                                aria-label="Scan hashes"
                            >
                                <ScanSearchLucide size={16} />
                            </button>
                        )}
                    </div>

                    {/* Search filters by substring. Disk mode walks the
                        current dir's listing; WAD mode walks the WAD's
                        chunk index with a scope filter — see the toggle
                        button to the right of the input. */}
                    <div className="welcome-extract-search">
                        <span className="welcome-extract-search-icon">
                            <SearchIcon size={14} />
                        </span>
                        <input
                            type="text"
                            className="welcome-extract-search-input"
                            placeholder={mountInfo
                                ? (searchWholeWad
                                    ? 'Search this WAD…'
                                    : wadCurrentDir
                                        ? `Search ${wadCurrentDir} and below…`
                                        : 'Search this WAD…')
                                : (currentPath ? 'Search this folder…' : 'Pick a location first')}
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            disabled={!currentPath && !mountInfo}
                        />
                        {mountInfo && (
                            <button
                                type="button"
                                className={`welcome-search-scope-btn${searchWholeWad ? ' on' : ''}`}
                                onClick={() => setSearchWholeWad(s => !s)}
                                title={searchWholeWad
                                    ? 'Searching the whole WAD — click to limit to current folder + children'
                                    : 'Searching current folder + children — click to broaden to the whole WAD'}
                                aria-label="Toggle search scope"
                            >
                                <RefreshCwIcon size={14} />
                            </button>
                        )}
                        {mountInfo && (() => {
                            // Detect locale-style VO WAD by re-running
                            // the same matcher we use to compute the
                            // counterpart — keeps the truth single-
                            // sourced.
                            const isVo = /\.[a-z]{2}_[A-Z]{2}\.wad(?:\.(?:client|mobile))?$/.test(mountInfo.path);
                            const enabled = !!wadCounterpartPath;
                            const dest = isVo ? 'main' : 'VO';
                            const title = enabled
                                ? (isVo
                                    ? 'Switch to the main WAD'
                                    : 'Switch to a VO (locale) WAD')
                                : (isVo
                                    ? 'No main WAD found next to this VO'
                                    : 'No locale VO WAD found for this champion');
                            return (
                                <button
                                    type="button"
                                    className="welcome-search-scope-btn"
                                    onClick={() => { void switchToWadCounterpart(); }}
                                    disabled={!enabled}
                                    title={title}
                                    aria-label={`Switch to ${dest} WAD`}
                                >
                                    {isVo
                                        ? <ToolCaseIcon size={14} />
                                        : <MicIcon size={14} />}
                                </button>
                            );
                        })()}
                    </div>

                    <div className={`welcome-extract-table${mountInfo ? ' wad-mode' : ' disk-mode'}`}>
                        <div className="welcome-extract-row welcome-extract-row-header">
                            {(() => {
                                // Same header checkbox cell in both modes — the
                                // toggle scope changes (wad files vs disk wads),
                                // but the UI shape stays consistent so columns
                                // line up between in- and out-of-WAD views.
                                const checkableRows = visibleRows.filter(r => {
                                    if (mountInfo) return r.kind === 'wad-file' || r.kind === 'wad-folder';
                                    return r.kind === 'disk-file' && isWadFileName(r.entry.name);
                                });
                                const allChecked = checkableRows.length > 0 && checkableRows.every(r => {
                                    if (r.kind === 'wad-file') return selectedHashes.has(r.entry.path_hash_hex);
                                    if (r.kind === 'wad-folder') return isFolderFullySelected(r.subPath);
                                    if (r.kind === 'disk-file') return selectedDiskWads.has(r.entry.path);
                                    return false;
                                });
                                const handleHeaderToggle = () => {
                                    if (checkableRows.length === 0) return;
                                    const target = !allChecked;
                                    if (mountInfo) {
                                        setSelectedHashes(prev => {
                                            const next = new Set(prev);
                                            for (const r of checkableRows) {
                                                if (r.kind === 'wad-file') {
                                                    if (target) next.add(r.entry.path_hash_hex);
                                                    else next.delete(r.entry.path_hash_hex);
                                                } else if (r.kind === 'wad-folder') {
                                                    for (const h of hashesUnderPath(r.subPath)) {
                                                        if (target) next.add(h);
                                                        else next.delete(h);
                                                    }
                                                }
                                            }
                                            return next;
                                        });
                                    } else {
                                        setSelectedDiskWads(prev => {
                                            const next = new Set(prev);
                                            for (const r of checkableRows) {
                                                if (r.kind === 'disk-file') {
                                                    if (target) next.add(r.entry.path);
                                                    else next.delete(r.entry.path);
                                                }
                                            }
                                            return next;
                                        });
                                    }
                                };
                                return (
                                    <span
                                        className={`welcome-extract-row-checkbox${checkableRows.length === 0 ? ' welcome-extract-row-checkbox-empty' : ''}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleHeaderToggle();
                                        }}
                                        title={checkableRows.length === 0
                                            ? 'Nothing selectable in this folder'
                                            : mountInfo
                                                ? 'Select all visible'
                                                : 'Select all visible WADs'}
                                    >
                                        {checkableRows.length > 0 && (
                                            <input
                                                type="checkbox"
                                                checked={allChecked}
                                                onChange={() => { /* span handles it */ }}
                                                tabIndex={-1}
                                            />
                                        )}
                                    </span>
                                );
                            })()}
                            <span className="welcome-extract-row-icon" />
                            <span className="welcome-extract-row-name">Name</span>
                            <span className="welcome-extract-row-meta">Type</span>
                            <span className="welcome-extract-row-meta welcome-extract-row-size">Size</span>
                            {!mountInfo && <span className="welcome-extract-row-meta">Modified</span>}
                        </div>
                        <div
                            className="welcome-extract-list"
                            ref={listRef}
                            onScroll={handleListScroll}
                        >
                        {!mountInfo && loading && <div className="welcome-extract-empty">Loading…</div>}
                        {!mountInfo && !loading && error && (
                            <div className="welcome-extract-empty welcome-extract-error">{error}</div>
                        )}
                        {openingWad && (
                            <div className="welcome-extract-empty">Mounting WAD…</div>
                        )}
                        {!mountInfo && !loading && !error && !currentPath && (
                            <div className="welcome-extract-empty">Pick a location to start browsing</div>
                        )}
                        {!openingWad && visibleRows.length === 0 && (currentPath || mountInfo) && (
                            <div className="welcome-extract-empty">
                                {search.trim()
                                    ? 'No matches'
                                    : (mountInfo ? 'Empty folder' : 'Empty folder')}
                            </div>
                        )}
                        {!openingWad && totalRows > 0 && visibleStart > 0 && (
                            <div style={{ height: visibleStart * ROW_HEIGHT, flexShrink: 0 }} aria-hidden />
                        )}
                        {!openingWad && renderedRows.map((row, sliceIdx) => {
                            const rowIndex = visibleStart + sliceIdx;
                            if (row.kind === 'disk-folder' || row.kind === 'disk-file') {
                                const e = row.entry;
                                const isWad = row.kind === 'disk-file' && isWadFileName(e.name);
                                const isSelected = !mountInfo && selected?.path === e.path;
                                const isWadChecked = isWad && selectedDiskWads.has(e.path);
                                return (
                                    <button
                                        key={`disk:${e.path}`}
                                        type="button"
                                        className={`welcome-extract-row${isSelected ? ' selected' : ''}${isWad ? ' wad-file' : ''}${isWadChecked ? ' has-selection' : ''}`}
                                        onClick={() => handleRowClick(row)}
                                        onContextMenu={(ev) => openContextMenu(ev, row)}
                                        onDoubleClick={() => row.kind === 'disk-folder' && setCurrentPath(e.path)}
                                        title={e.path}
                                    >
                                        {/* Checkbox cell stays present on every disk row so the
                                            divider line aligns vertically with the WAD-mode list.
                                            Folders + non-WAD files render the cell empty. */}
                                        <span
                                            className={`welcome-extract-row-checkbox${!isWad ? ' welcome-extract-row-checkbox-empty' : ''}`}
                                            onClick={(ev) => {
                                                if (!isWad) { ev.stopPropagation(); return; }
                                                handleCheckboxClick(rowIndex, ev);
                                            }}
                                        >
                                            {isWad && (
                                                <input
                                                    type="checkbox"
                                                    checked={isWadChecked}
                                                    onChange={() => { /* span handles it */ }}
                                                    tabIndex={-1}
                                                    aria-label={`Select WAD ${e.name}`}
                                                />
                                            )}
                                        </span>
                                        <span className="welcome-extract-row-icon">
                                            {e.is_dir
                                                ? <FolderIcon size={16} />
                                                : isWad
                                                    ? <WadIcon size={16} isOpen={mountInfo?.path === e.path} />
                                                    : iconForExtension(e.extension, e.name)}
                                        </span>
                                        <span className="welcome-extract-row-name">{e.name}</span>
                                        <span className="welcome-extract-row-meta">
                                            {e.is_dir ? 'Folder' : (e.extension ? `.${e.extension}` : 'File')}
                                        </span>
                                        <span className="welcome-extract-row-meta welcome-extract-row-size">
                                            {e.is_dir ? '' : formatBytes(e.size)}
                                        </span>
                                        <span className="welcome-extract-row-meta">
                                            {formatRelative(e.modified)}
                                        </span>
                                    </button>
                                );
                            }
                            if (row.kind === 'wad-folder') {
                                const fullySelected = isFolderFullySelected(row.subPath);
                                const partiallySelected = isFolderPartiallySelected(row.subPath);
                                return (
                                    <button
                                        key={`wad-dir:${row.subPath}`}
                                        type="button"
                                        className={`welcome-extract-row${partiallySelected || fullySelected ? ' has-selection' : ''}`}
                                        onClick={() => handleRowClick(row)}
                                        onContextMenu={(ev) => openContextMenu(ev, row)}
                                        title={row.subPath}
                                    >
                                        <span
                                            className="welcome-extract-row-checkbox"
                                            onClick={(e) => handleCheckboxClick(rowIndex, e)}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={fullySelected}
                                                onChange={() => { /* span handles it */ }}
                                                ref={el => { if (el) el.indeterminate = partiallySelected; }}
                                                tabIndex={-1}
                                                aria-label={`Select folder ${row.name}`}
                                            />
                                        </span>
                                        <span className="welcome-extract-row-icon"><FolderIcon size={16} /></span>
                                        <span className="welcome-extract-row-name">{row.name}</span>
                                        <span className="welcome-extract-row-meta">Folder</span>
                                        <span className="welcome-extract-row-meta welcome-extract-row-size">{formatBytes(row.size)}</span>
                                    </button>
                                );
                            }
                            // wad-file
                            const f = row.entry;
                            const fname = f.path.includes('/')
                                ? f.path.slice(f.path.lastIndexOf('/') + 1)
                                : f.path;
                            const fdot = fname.lastIndexOf('.');
                            const fext = fdot === -1 ? '' : fname.slice(fdot);
                            const isPinned = wadSelected?.path_hash_hex === f.path_hash_hex;
                            const isChecked = selectedHashes.has(f.path_hash_hex);
                            return (
                                <button
                                    key={`wad-file:${f.path_hash_hex}`}
                                    type="button"
                                    className={`welcome-extract-row${isPinned ? ' selected' : ''}${isChecked ? ' has-selection' : ''}${f.unknown ? ' wad-unknown' : ''}`}
                                    onClick={() => handleRowClick(row)}
                                    onContextMenu={(ev) => openContextMenu(ev, row)}
                                    title={f.path}
                                >
                                    <span
                                        className="welcome-extract-row-checkbox"
                                        onClick={(e) => handleCheckboxClick(rowIndex, e)}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={() => { /* span handles it */ }}
                                            tabIndex={-1}
                                            aria-label={`Select file ${fname}`}
                                        />
                                    </span>
                                    <span className="welcome-extract-row-icon">
                                        {iconForExtension(fext.replace(/^\./, ''), fname)}
                                    </span>
                                    <span className="welcome-extract-row-name">
                                        {(() => {
                                            // While searching: a folder-scoped
                                            // search (the default) shows paths
                                            // relative to the current sub-dir so
                                            // the visible string isn't drowning
                                            // in the parent prefix the user
                                            // already navigated through. The
                                            // "search whole WAD" toggle goes
                                            // back to full paths because there's
                                            // no shared context to strip.
                                            if (!search.trim()) return fname;
                                            if (!searchWholeWad && wadCurrentDir) {
                                                const prefix = wadCurrentDir.toLowerCase() + '/';
                                                if (f.path.toLowerCase().startsWith(prefix)) {
                                                    return f.path.slice(wadCurrentDir.length + 1);
                                                }
                                            }
                                            return f.path;
                                        })()}
                                    </span>
                                    <span className="welcome-extract-row-meta">
                                        {fext || (f.unknown ? 'Unknown' : 'File')}
                                    </span>
                                    <span className="welcome-extract-row-meta welcome-extract-row-size">
                                        {formatBytes(f.size)}
                                    </span>
                                </button>
                            );
                        })}
                        {!openingWad && totalRows > 0 && visibleEnd < totalRows && (
                            <div style={{ height: (totalRows - visibleEnd) * ROW_HEIGHT, flexShrink: 0 }} aria-hidden />
                        )}
                        </div>
                    </div>
                </div>

                {/* ── Preview column ── */}
                <aside className="welcome-extract-preview">
                    {/* Body — empty state, mount summary, or file detail.
                        Wrapped in its own flex container so the preview
                        image fills the column above the action strip. */}
                    <div className="welcome-preview-body">
                    {!previewItem && !mountInfo && (
                        <div className="welcome-preview-empty">
                            <DocIcon size={40} />
                            <span>Select a file to preview</span>
                            <span className="welcome-preview-empty-sub">
                                Click a <code>.wad.client</code> file to step inside and browse its contents.
                            </span>
                        </div>
                    )}
                    {!previewItem && mountInfo && (
                        <div className="welcome-preview-detail">
                            <div className="welcome-preview-name" title={mountInfo.path}>
                                {mountInfo.name}
                            </div>
                            <div className="welcome-preview-row">
                                <span className="welcome-preview-key">WAD version</span>
                                <span className="welcome-preview-val">v{mountInfo.version}</span>
                            </div>
                            <div className="welcome-preview-row">
                                <span className="welcome-preview-key">Files</span>
                                <span className="welcome-preview-val">
                                    {mountInfo.chunk_count.toLocaleString()}
                                </span>
                            </div>
                        </div>
                    )}
                    {previewItem && ['.skn', '.scb', '.sco', '.skl'].includes(previewItem.ext.toLowerCase()) && (
                        <div className="welcome-preview-detail welcome-preview-detail-mesh">
                            <div className="welcome-preview-mesh">
                                <MeshPreview
                                    source={
                                        wadSelected && mountInfo
                                            ? { kind: 'wad', mountId: mountInfo.id, pathHashHex: wadSelected.path_hash_hex }
                                            : { kind: 'disk', path: previewItem.path }
                                    }
                                    label={previewItem.name}
                                />
                            </div>
                            <div className="welcome-preview-name" title={previewItem.path}>
                                {previewItem.name}
                            </div>
                            <div className="welcome-preview-meta-line">
                                {previewItem.type}
                                {' · '}
                                {formatBytes(previewItem.size)}
                            </div>
                        </div>
                    )}
                    {previewItem && !['.skn', '.scb', '.sco', '.skl'].includes(previewItem.ext.toLowerCase()) && (
                        <div className="welcome-preview-detail">
                            {previewState.dataUrl && (
                                <div
                                    className="welcome-preview-image"
                                    onWheel={onImageWheel}
                                    onMouseDown={onImageMouseDown}
                                    onMouseMove={onImageMouseMove}
                                    onMouseUp={onImageMouseUp}
                                    onMouseLeave={onImageMouseUp}
                                    onDoubleClick={onImageDoubleClick}
                                    title="Scroll to zoom · drag to pan · double-click to reset"
                                    style={{
                                        cursor: panning ? 'grabbing' : 'grab',
                                        // Block native browser image-drag/select
                                        // so a stray mousedown can't kidnap our
                                        // drag with a ghost preview.
                                        userSelect: 'none',
                                    }}
                                >
                                    <img
                                        src={previewState.dataUrl}
                                        alt={previewItem.name}
                                        style={{
                                            transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${imageZoom})`,
                                            // Fast-path nearest-neighbour for
                                            // textures so pixels stay sharp on
                                            // zoom-in instead of going blurry.
                                            imageRendering: imageZoom >= 1.5 ? 'pixelated' : 'auto',
                                            transformOrigin: 'center center',
                                            // Don't animate while the user is
                                            // dragging — the lerp lag makes the
                                            // image trail behind the cursor.
                                            transition: panning ? 'none' : 'transform 0.05s linear',
                                            pointerEvents: 'none',
                                        }}
                                        draggable={false}
                                    />
                                </div>
                            )}
                            {/* BIN preview — full Monaco editor in read-
                                only mode with the ritobin language +
                                theme registered, so the preview syntax-
                                highlights identically to a freshly-opened
                                tab. Same dimensions as the image slot so
                                the column doesn't reflow between picking
                                a texture and a BIN. */}
                            {previewState.binText !== null && (
                                <>
                                    <div className="welcome-preview-bintext">
                                        <Editor
                                            height="100%"
                                            defaultLanguage={RITOBIN_LANGUAGE_ID}
                                            // Use the app's dynamic theme so the preview
                                            // matches the editor and doesn't clobber the
                                            // global Monaco theme. We pass `ritobin-dark`
                                            // (static) until `jade-dynamic` is proven to
                                            // exist, then flip — see `previewTheme`. Passing
                                            // a hardcoded `ritobin-dark` here permanently
                                            // would also clobber the background editor's
                                            // theme (Monaco's `setTheme` is GLOBAL) without
                                            // ever restoring `jade-dynamic`.
                                            theme={previewTheme}
                                            value={previewState.binText}
                                            beforeMount={(monaco) => {
                                                registerRitobinLanguage(monaco);
                                                // Static theme is always registered as the
                                                // safe default / first-frame theme.
                                                registerRitobinTheme(monaco);
                                                // Guarantee `jade-dynamic` exists. It's
                                                // usually defined by the main editor's mount,
                                                // but on a fresh boot straight into the
                                                // extractor the main editor may never have
                                                // mounted — so define it here, then flip the
                                                // preview to it. Without this the preview
                                                // resolves an undefined theme and Monaco
                                                // falls back to its default (wrong) colors.
                                                if (dynamicThemeReady) {
                                                    setPreviewTheme('jade-dynamic');
                                                } else {
                                                    loadSavedTheme(invoke, monaco)
                                                        .then(() => {
                                                            dynamicThemeReady = true;
                                                            setPreviewTheme('jade-dynamic');
                                                        })
                                                        .catch(() => { /* keep static fallback */ });
                                                }
                                            }}
                                            onMount={(editor) => {
                                                binEditorRef.current = editor;
                                            }}
                                            options={{
                                                readOnly: true,
                                                domReadOnly: true,
                                                minimap: { enabled: false },
                                                lineNumbers: 'on',
                                                lineNumbersMinChars: 4,
                                                glyphMargin: false,
                                                folding: true,
                                                automaticLayout: true,
                                                scrollBeyondLastLine: false,
                                                renderLineHighlight: 'none',
                                                overviewRulerLanes: 0,
                                                overviewRulerBorder: false,
                                                contextmenu: false,
                                                stickyScroll: { enabled: false },
                                                fontSize: binFontSize,
                                                lineHeight: Math.round(binFontSize * 1.4),
                                                padding: { top: 6, bottom: 6 },
                                            }}
                                        />
                                    </div>
                                    {/* BIN preview toolbar — Find triggers
                                        Monaco's built-in find widget (Replace
                                        is automatically hidden because the
                                        editor is read-only). A− / A+ adjust
                                        font size live, clamped at the bounds
                                        defined above the component. */}
                                    <div className="welcome-preview-bin-toolbar">
                                        <button
                                            type="button"
                                            className="welcome-preview-bin-btn"
                                            onClick={triggerBinFind}
                                            title="Find in preview (Ctrl+F)"
                                        >
                                            Find
                                        </button>
                                        <div className="welcome-preview-bin-spacer" />
                                        <button
                                            type="button"
                                            className="welcome-preview-bin-btn welcome-preview-bin-btn-icon"
                                            onClick={() => bumpBinFont(-1)}
                                            disabled={binFontSize <= BIN_FONT_MIN}
                                            title="Decrease font size"
                                            aria-label="Decrease font size"
                                        >
                                            A−
                                        </button>
                                        <span className="welcome-preview-bin-font-readout">
                                            {binFontSize}px
                                        </span>
                                        <button
                                            type="button"
                                            className="welcome-preview-bin-btn welcome-preview-bin-btn-icon"
                                            onClick={() => bumpBinFont(1)}
                                            disabled={binFontSize >= BIN_FONT_MAX}
                                            title="Increase font size"
                                            aria-label="Increase font size"
                                        >
                                            A+
                                        </button>
                                    </div>
                                </>
                            )}
                            {previewState.loading && (
                                <div className="welcome-preview-image welcome-preview-image-loading">
                                    Decoding preview…
                                </div>
                            )}
                            {previewState.error && (
                                <div className="welcome-preview-image welcome-preview-image-error">
                                    {previewState.error}
                                </div>
                            )}
                            <div className="welcome-preview-name" title={previewItem.path}>
                                {previewItem.name}
                            </div>
                            <div className="welcome-preview-meta-line">
                                {previewItem.type}
                                {' · '}
                                {formatBytes(previewItem.size)}
                                {previewState.format && (
                                    <>{' · '}{previewState.format}</>
                                )}
                                {previewState.width && previewState.height && (
                                    <>{' · '}{previewState.width}×{previewState.height}</>
                                )}
                            </div>
                            {/* Disk-only "Open WAD" shortcut — for everything else, the
                                Extract button on the left column is the canonical action. */}
                            {!mountInfo && selected && isWadFileName(selected.name) && (
                                <div className="welcome-preview-actions">
                                    <button
                                        type="button"
                                        className="welcome-preview-action"
                                        onClick={() => openWad(selected.path)}
                                        disabled={openingWad}
                                    >
                                        {openingWad ? 'Opening…' : 'Open WAD'}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    </div>

                    {/* Actions strip — pinned to the bottom of the preview
                        pane. Always rendered; buttons grey out when there's
                        nothing to act on. */}
                    <div className="welcome-preview-actions">
                        <button
                            type="button"
                            className="welcome-source-action-btn"
                            onClick={() => {
                                if (mountInfo) {
                                    startExtraction(effectiveSelection);
                                } else {
                                    startDiskWadsExtraction(Array.from(selectedDiskWads));
                                }
                            }}
                            disabled={extracting || totalSelectedFiles === 0}
                            title={totalSelectedFiles === 0
                                ? mountInfo
                                    ? 'Tick checkboxes or click a file to mark items for extraction'
                                    : 'Tick a .wad.client file to queue it for extraction'
                                : `${totalSelectedFiles.toLocaleString()} ${mountInfo ? 'file' : 'WAD'}(s) queued`}
                        >
                            {extracting && totalSelectedFiles > 0
                                ? 'Extracting…'
                                : totalSelectedFiles > 0
                                    ? mountInfo
                                        ? `Extract selected (${totalSelectedFiles.toLocaleString()})`
                                        : `Extract ${totalSelectedFiles.toLocaleString()} WAD${totalSelectedFiles === 1 ? '' : 's'}`
                                    : 'Extract selected'}
                        </button>
                        <button
                            type="button"
                            className="welcome-source-action-btn"
                            onClick={() => setSkinModOpen(true)}
                            disabled={!mountInfo || skinModCandidates.length === 0 || extracting}
                            title={
                                !mountInfo
                                    ? 'Open a WAD first'
                                    : skinModCandidates.length === 0
                                        ? 'No skins with a matching BIN found in this WAD'
                                        : `Pick from ${skinModCandidates.length} skin${skinModCandidates.length === 1 ? '' : 's'} found in this WAD\nBIN-walk extraction with repath / merge / HUD / SFX-VO / VO export options.`
                            }
                        >
                            Extract as skin mod
                        </button>
                        <button
                            type="button"
                            className="welcome-source-action-btn primary"
                            onClick={() => startExtraction([])}
                            disabled={!mountInfo || extracting}
                            title={mountInfo
                                ? `Extracts every file in ${mountInfo.name}`
                                : 'Open a .wad.client file first'}
                        >
                            {extracting && mountInfo && totalSelectedFiles === 0
                                ? 'Extracting…'
                                : mountInfo
                                    ? `Extract WAD (${mountInfo.chunk_count.toLocaleString()})`
                                    : 'Extract WAD'}
                        </button>
                        <button
                            type="button"
                            className="welcome-source-action-cancel"
                            onClick={cancelExtraction}
                            disabled={!extracting}
                            title={extracting ? 'Cancel extraction' : 'Nothing to cancel'}
                            aria-label="Cancel extraction"
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <line x1="6" y1="6" x2="18" y2="18" />
                                <line x1="18" y1="6" x2="6" y2="18" />
                            </svg>
                        </button>
                    </div>
                </aside>
            </div>

            {contextMenu && (
                <div
                    ref={ctxMenuRef}
                    className="welcome-extract-ctxmenu"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                    role="menu"
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    {/* Copy name — disabled when the user has multiple
                        rows selected, since picking which row's name to
                        copy is ambiguous. Lives above "Copy path". */}
                    <button
                        type="button"
                        className="welcome-extract-ctxitem"
                        onClick={() => handleCopyRowName(contextMenu.row)}
                        disabled={selectedHashes.size > 1}
                    >
                        <FilesIcon size={14} className="welcome-extract-ctxicon" />
                        <span className="welcome-extract-ctxlabel">Copy name</span>
                    </button>
                    <button
                        type="button"
                        className="welcome-extract-ctxitem"
                        onClick={() => handleCopyRowPath(contextMenu.row)}
                    >
                        <CopyIcon size={14} className="welcome-extract-ctxicon" />
                        <span className="welcome-extract-ctxlabel">Copy path</span>
                    </button>
                    {(contextMenu.row.kind === 'wad-file'
                        || contextMenu.row.kind === 'wad-folder'
                        || (mountInfo && selectedHashes.size > 0)) && (
                        <div className="welcome-extract-ctxsep" />
                    )}
                    {/* Send BIN(s) to editor — three flavors:
                        - WAD-side single `.bin`/`.py` → byte-convert path
                        - WAD-side multi-select with bins in it → batch convert
                        - Disk-side single `.bin`/`.py` → open the file directly
                          since it's already on disk (no bytes round-trip). */}
                    {(() => {
                        // Disk file path takes precedence — if the user
                        // right-clicked a disk row, never offer the WAD flow.
                        const diskPath = collectDiskBinPathForRow(contextMenu.row);
                        if (diskPath) {
                            if (!onOpenRecentFile) return null;
                            return (
                                <button
                                    type="button"
                                    className="welcome-extract-ctxitem"
                                    onClick={() => handleSendDiskBinToEditor(contextMenu.row)}
                                >
                                    <SquareArrowRightEnter size={14} className="welcome-extract-ctxicon" />
                                    <span className="welcome-extract-ctxlabel">Send to editor</span>
                                </button>
                            );
                        }
                        if (!onOpenSkinBinAsText) return null;
                        const binEntries = collectBinEntriesForRow(contextMenu.row);
                        if (binEntries.length === 0) return null;
                        const label = binEntries.length === 1
                            ? 'Send to editor'
                            : `Send ${binEntries.length} bins to editor`;
                        return (
                            <button
                                type="button"
                                className="welcome-extract-ctxitem"
                                onClick={() => handleSendBinToEditor(contextMenu.row)}
                            >
                                <SquareArrowRightEnter size={14} className="welcome-extract-ctxicon" />
                                <span className="welcome-extract-ctxlabel">{label}</span>
                            </button>
                        );
                    })()}
                    {contextMenu.row.kind === 'wad-file' && (
                        <button
                            type="button"
                            className="welcome-extract-ctxitem"
                            onClick={() => handleSaveSingleWadFile(contextMenu.row.kind === 'wad-file' ? contextMenu.row.entry : (null as never))}
                        >
                            <SaveIcon size={14} className="welcome-extract-ctxicon" />
                            <span className="welcome-extract-ctxlabel">Save file as…</span>
                        </button>
                    )}
                    {contextMenu.row.kind === 'wad-folder' && (
                        <button
                            type="button"
                            className="welcome-extract-ctxitem"
                            onClick={() => handleSaveFolderFlat(contextMenu.row.kind === 'wad-folder' ? contextMenu.row.subPath : '')}
                        >
                            <FolderDownIcon size={14} className="welcome-extract-ctxicon" />
                            <span className="welcome-extract-ctxlabel">Save folder (flat)…</span>
                        </button>
                    )}
                    {mountInfo && selectedHashes.size > 0 && (
                        <button
                            type="button"
                            className="welcome-extract-ctxitem"
                            onClick={handleSaveSelectedFlat}
                        >
                            <SaveAllIcon size={14} className="welcome-extract-ctxicon" />
                            <span className="welcome-extract-ctxlabel">
                                {`Save ${selectedHashes.size} selected (flat)…`}
                            </span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/* Local outlined glyphs — kept here so the welcome screen has its own
   simple line-icon set that matches PaletteIcon / LibraryIcon /
   SettingsIcon (the other icons we use). The ribbon's filled Fluent
   DocIcon / FolderIcon would clash visually, so we don't reuse
   those here. All draw in currentColor only — no accent fills. */
function DocIcon({ size = 20 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    );
}

/** Folder glyph that swaps from a closed Lucide `folder` to Lucide's
 *  `folder-open` when its hovering ancestor row gets pointed at. Both
 *  components are emitted into the DOM and swapped via CSS — see
 *  `.welcome-folder-icon` in WelcomeScreen.css for the trigger
 *  selectors (rows, source items, breadcrumb buttons, etc.). */
function FolderIcon({ size = 20 }: { size?: number }) {
    return (
        <span className="welcome-folder-icon" aria-hidden="true">
            <LucideFolder size={size} strokeWidth={1.8} className="welcome-folder-icon-closed" />
            <LucideFolderOpen size={size} strokeWidth={1.8} className="welcome-folder-icon-open" />
        </span>
    );
}

/** WAD-package glyph using Lucide `package` / `package-open`. Swaps
 *  to the open variant when (a) the row containing it is being
 *  hovered, or (b) the `isOpen` prop is true (currently-mounted WAD
 *  in the recent list / file list). Same CSS-driven swap pattern as
 *  [`FolderIcon`] above. */
function WadIcon({ size = 20, isOpen = false }: { size?: number; isOpen?: boolean }) {
    return (
        <span
            className={`welcome-wad-icon${isOpen ? ' welcome-wad-icon-active' : ''}`}
            aria-hidden="true"
        >
            <LucidePackage size={size} strokeWidth={1.8} className="welcome-wad-icon-closed" />
            <LucidePackageOpen size={size} strokeWidth={1.8} className="welcome-wad-icon-open" />
        </span>
    );
}

/** Recent-files row icon. Delegates to the shared `FileTypeIcon` so the
 *  Welcome screen, Extract tab, and File Explorer all draw the same
 *  glyph for a given file (including the studio-scene tab icons). */
function recentFileIcon(filePath: string, ext: string): React.ReactElement {
    const name = filePath.replace(/\\/g, '/').split('/').pop() || '';
    return <FileTypeIcon extension={ext} fileName={name} size={32} />;
}

/** Extract-tab row icon. Thin wrapper over the shared `FileTypeIcon`. */
function iconForExtension(ext: string, fileName?: string, size = 16): React.ReactElement {
    return <FileTypeIcon extension={ext} fileName={fileName} size={size} />;
}

