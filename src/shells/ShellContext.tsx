import { createContext, useContext, type ReactNode } from 'react';
import type { Monaco } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import type { EditorTab } from '../components/TabBar';
import type { StudioScene } from '../lib/babylon/studioScene';

export type PerfMode = 'on' | 'auto' | 'off';
export type PerfKey =
    | 'minimap' | 'bracketColors' | 'occurrencesHighlight' | 'selectionHighlight'
    | 'lineHighlight' | 'folding' | 'stopRenderingLine';
export type QuartzMode = 'paint' | 'port' | 'bineditor' | 'vfxhub';
export type ShellVariant = 'vscode' | 'word' | 'visualstudio';

/** Root currently displayed in the File Explorer pane — either a
 *  folder on disk or a mounted WAD. WAD roots carry the mount id so
 *  the pane can read entries via `wad_list_entries` and the close
 *  flow can `wad_close` deterministically. */
export type FileExplorerRoot =
    | { kind: 'folder'; path: string }
    | { kind: 'wad'; mountId: number; wadPath: string; label: string };

export interface TexPopupData {
    top: number;
    left: number;
    above: boolean;
    rawPath: string;
    resolvedPath: string | null;
    imageDataUrl: string | null;
    texWidth: number;
    texHeight: number;
    formatStr: string;
    formatNum: number;
    error: string | null;
}

export interface HashSyncToastState {
    visible: boolean;
    status: 'checking' | 'downloading' | 'success' | 'error';
    message: string;
}

/**
 * Single context object every shell consumes. Holds all the workspace
 * state and handlers the chrome needs to render. Adding a new shell
 * means writing a component that consumes useShell() and renders its
 * own layout — no changes here unless the chrome needs new data.
 */
export interface ShellContextValue {
    // -- Active shell variant (so shared components like EditorPane can
    //    adapt their behavior — e.g. stripped Monaco chrome in Word mode).
    shellVariant: ShellVariant;

    // -- Window
    appIcon: string;
    isMaximized: boolean;
    isDragging: boolean;
    cigaretteMode: boolean;
    jamesMode: boolean;
    onMinimize: () => void;
    onMaximize: () => void;
    onClose: () => void;

    // -- Tabs
    tabs: EditorTab[];
    activeTabId: string | null;
    activeTab: EditorTab | null;
    isEditorTab: (tab: EditorTab | null | undefined) => boolean;
    isBinFileOpen: () => boolean;
    onTabSelect: (id: string) => void;
    onTabClose: (id: string) => void;
    onTabCloseAll: () => void;
    onTabPin: (id: string) => void;

    // -- Status / metrics
    statusText: string;
    lineCount: number;
    caretPosition: { line: number; column: number };
    appMemoryBytes: number;
    setStatusMessage: (msg: string) => void;

    // -- Panel open state + setters
    findWidgetOpen: boolean;
    replaceWidgetOpen: boolean;
    generalEditPanelOpen: boolean;
    particlePanelOpen: boolean;
    /** Material-override insert tool windows. The classic
     *  modal-flavored `MaterialOverrideDialog` still opens from the
     *  General Edit panel; these flags drive the lighter dockable
     *  panel variants used by the VS shell. */
    textureInsertOpen: boolean;
    materialInsertOpen: boolean;
    /** Bin Navigation panel — jump shortcuts to animationGraphData /
     *  ResourceResolver / materialOverride. Floating popup in the
     *  classic shell, dockable tool window in the VS shell. */
    binNavOpen: boolean;
    setGeneralEditPanelOpen: (open: boolean) => void;
    setParticlePanelOpen: (open: boolean) => void;
    setTextureInsertOpen: (open: boolean) => void;
    setMaterialInsertOpen: (open: boolean) => void;
    setBinNavOpen: (open: boolean) => void;

    // -- Recent files
    recentFiles: string[];
    openFileDisabled: boolean;
    openFileFromPath: (path: string) => void | Promise<void>;

    // -- Welcome screen override
    //    'force' = show welcome even with open tabs (Jade icon / Main page);
    //    'hide'  = stay in editor with zero tabs (Continue without file);
    //    null    = default ("show welcome iff no tabs"). Auto-resets when
    //    tab count changes so a freshly opened file always shows the editor.
    welcomeOverride: 'force' | 'hide' | null;
    setWelcomeOverride: (v: 'force' | 'hide' | null) => void;

    // -- File operations
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    /** Save every editor tab with a file path and unsaved changes in
     *  one shot. Untitled / studio tabs are skipped (they need
     *  per-tab Save-As / save-scene dialogs). Status bar reports the
     *  count + any per-file failures. */
    onSaveAll: () => void;
    onOpenLog: () => void;

    // -- Edit operations
    onUndo: () => void;
    onRedo: () => void;
    onCut: () => void;
    onCopy: () => void;
    onPaste: () => void;
    onFind: () => void;
    onReplace: () => void;
    onCompareFiles: () => void;
    onScanBinAssets: () => void;
    /** True when the active editor tab is a scanned-assets report
     *  (frontmatter `jade-asset-list: true`). Shells use this to
     *  let the texture-insert button open the visual gallery on
     *  these reports instead of being disabled like for plain .md. */
    isAssetListTab: () => boolean;
    /** Tab ID of an open asset-gallery dialog; null when closed. */
    assetGalleryTabId: string | null;
    setAssetGalleryTabId: (tabId: string | null) => void;
    onSelectAll: () => void;

    // -- Tools
    onGeneralEdit: () => void;
    onParticlePanel: () => void;
    onParticleEditor: () => void;
    onMaterialLibrary: () => void;
    /** Toggles for the dockable material-override insert tools. */
    onTextureInsert: () => void;
    onMaterialInsert: () => void;
    /** Toggles the Bin Navigation panel. */
    onBinNav: () => void;

    // -- File Explorer (dockable folder browser — studio shell only)
    fileExplorerOpen: boolean;
    setFileExplorerOpen: (open: boolean) => void;
    /** Current root displayed in the explorer pane. Either a folder
     *  on disk or a mounted WAD, or null when none has been picked.
     *  Folder roots persist via localStorage; WAD roots don't (mounts
     *  are session-bound). */
    fileExplorerRoot: FileExplorerRoot | null;
    setFileExplorerRoot: (root: FileExplorerRoot | null) => void;
    /** Pops the OS folder-picker, sets the chosen folder as the
     *  explorer root, and opens the pane. */
    onOpenFolder: () => void;
    /** Pops the OS file-picker constrained to .wad / .wad.client,
     *  mounts it, sets the WAD as the explorer root, and opens
     *  the pane. */
    onOpenWadInExplorer: () => void;
    /** Open the "Fetch animations from game" picker for the SKN at
     *  `sknDiskPath`. App-level handler runs auto-detect first; when
     *  the result is conclusive it can run the fetch directly without
     *  ever opening the dialog. Resolved Promise carries the count of
     *  files dropped (0 when the user cancelled). */
    openFetchAnimationsDialog: (sknDiskPath: string) => Promise<number>;

    /** Reveal an on-disk file in the File Explorer pane. If the
     *  file is already inside the current folder root, just expands
     *  ancestors + selects + scrolls. Otherwise switches the root
     *  to the file's parent folder and selects the file. Opens the
     *  pane if it was closed. No-op when the path is null/inside
     *  a WAD mount (we can't reveal hash-based WAD entries that
     *  way). */
    revealInExplorer: (filePath: string) => void;
    onThemes: () => void;
    onSettings: () => void;
    onPreferences: () => void;
    onAbout: () => void;
    onSendToQuartz: (mode: QuartzMode) => void;

    // -- Editor wiring
    editorTheme: string;
    /** Active editor font family (CSS font-family value). Driven by the
     *  theme system's `jade-editor-font-changed` event. */
    editorFontFamily: string;
    perfPrefs: Record<PerfKey, PerfMode>;
    bigFileLines: number;
    handleBeforeMount: (monaco: Monaco) => void;
    handleEditorMount: (editor: MonacoType.editor.IStandaloneCodeEditor) => void;
    handleEditorChange: (value: string | undefined) => void;
    editorRef: React.MutableRefObject<MonacoType.editor.IStandaloneCodeEditor | null>;
    /** Monaco's text-model registry, keyed by tab id. Pop-out document
     *  windows mount their own Monaco editor against the same model so
     *  edits stay in sync with the main editor (Monaco allows a single
     *  model to be attached to multiple editors). */
    monacoModelsRef: React.MutableRefObject<Map<string, MonacoType.editor.ITextModel>>;
    monacoRef: React.MutableRefObject<Monaco | null>;

    // -- Split-pane mode
    //    Toggling `splitMode` opens a second full Monaco instance
    //    next to the main editor. Each pane has its OWN tab bar
    //    (filtered by `tab.pane`) and its OWN active tab id, so the
    //    user can show a different file in each pane. Tabs are a
    //    shared pool — drag-drop between the two tab bars flips a
    //    tab's `pane` field.
    //
    //    `splitRatio` is the left pane's fraction of the container
    //    width, clamped to [0.1, 0.9].
    //
    //    `focusedPane` tracks the pane the user last interacted with
    //    so shell-level keyboard shortcuts (save, find, etc.) target
    //    the right editor and new files open into the right pane.
    splitMode: boolean;
    setSplitMode: (b: boolean) => void;
    splitRatio: number;
    setSplitRatio: (n: number) => void;
    leftActiveTabId: string | null;
    rightActiveTabId: string | null;
    focusedPane: 'left' | 'right';
    setFocusedPane: (p: 'left' | 'right') => void;
    /** Move a tab into a different pane. Used by the tab bars' drag-
     *  and-drop targets. If the moved tab was the active tab in its
     *  origin pane, picks another tab in that pane (or null if empty);
     *  if the destination pane had no active tab, the moved tab
     *  becomes active there. */
    onTabSetPane: (tabId: string, pane: 'left' | 'right') => void;
    /** Idempotent model-resolver — returns the existing Monaco model
     *  for `tabId`, or creates a fresh one from the tab's content if
     *  the cached entry is missing or disposed. Both panes use this
     *  to make sure they don't try to attach to a dangling model
     *  after a shell remount (which disposes editors but leaves the
     *  registry pointing at the corpses). */
    ensureModelForTab: (tabId: string) => MonacoType.editor.ITextModel | null;
    /** Per-editor feature registration for the SECONDARY (right) pane.
     *  Wires image-path swatches, material-jump arrows + click, and
     *  the texture popup click — the same surface the primary editor
     *  gets through `handleEditorMount` but without writing to
     *  shell-level refs. Returns a cleanup function the caller must
     *  invoke on unmount so the disposables don't leak across shell
     *  remounts. */
    setupRightEditor: (editor: MonacoType.editor.IStandaloneCodeEditor) => () => void;

    // -- Photo Studio
    //    Each studio tab mounts a `StudioTab` component, which builds a
    //    `StudioScene` and registers it here keyed by tab id. The
    //    studio's dock panels (anim picker, background switcher, photo
    //    capture) read the active tab's scene off this map and mutate
    //    it directly — no prop drilling through the shell.
    onNewStudioScene: () => void;
    /** Viewer → editor handoff. The Viewer's "Open in BIN editor"
     *  button calls this with the already-converted BIN text + the
     *  display name. App.tsx implements it by creating a fresh tab. */
    onOpenSkinBinAsText: (text: string, displayName: string) => void;
    /** Viewer → Photo Studio handoff. App.tsx extracts the mesh to
     *  a temp dir, opens a new studio scene, and loads it. */
    onSendMeshToStudio: (
        mountId: number,
        sknChunkHashHex: string,
        champion: string,
        skinNum: number,
        label: string,
        shadowForm: boolean,
        chromaSkinNum: number | null,
        textureBindings: Array<{ submeshName: string; chunkHashHex: string | null }> | null,
    ) => void;
    /** Open a `.studio.json` scene file into a new studio tab. */
    onStudioOpen: () => void;
    /** StudioTab calls this on every scene change so the tab's
     *  `isModified` flag mirrors the scene's dirty state. */
    notifyStudioDirty: (tabId: string, dirty: boolean) => void;
    registerStudioScene: (tabId: string, scene: StudioScene) => void;
    unregisterStudioScene: (tabId: string) => void;
    /** Resolves the scene handle for `tabId`, or `null` if the tab
     *  isn't a studio tab or hasn't mounted its canvas yet. */
    getStudioScene: (tabId: string) => StudioScene | null;
    /** Per-panel open/closed state. Defaults to true so a fresh studio
     *  tab shows everything; user can dismiss with the panel's X. */
    studioAnimOpen: boolean;
    studioBgOpen: boolean;
    studioActionsOpen: boolean;
    studioMeshOpen: boolean;
    studioObjectsOpen: boolean;
    studioSpotlightOpen: boolean;
    setStudioAnimOpen: (open: boolean) => void;
    setStudioBgOpen: (open: boolean) => void;
    setStudioActionsOpen: (open: boolean) => void;
    setStudioMeshOpen: (open: boolean) => void;
    setStudioObjectsOpen: (open: boolean) => void;
    setStudioSpotlightOpen: (open: boolean) => void;
    /** Photo dimensions — owned here so the StudioTab can overlay a
     *  framing box on the viewport showing what the capture will
     *  include given the current W/H. The actions panel writes; the
     *  tab reads. */
    studioPhotoWidth: number;
    studioPhotoHeight: number;
    setStudioPhotoWidth: (n: number) => void;
    setStudioPhotoHeight: (n: number) => void;

    // -- Edit panel callbacks
    handleGeneralEditContentChange: (newContent: string) => void;
    handleScrollToLine: (line: number) => void;
    recordJadelibInsert: (filePath: string, modRoot: string, id: string) => void;
    mdWrapSelection: (before: string, after: string) => boolean;
    mdPrefixLines: (prefix: string) => boolean;
    mdInsertAtCaret: (text: string) => boolean;

    // -- Markdown preview
    mdPreviewContent: string;

    // -- Compare tab
    swapCompareTabSides: (tabId: string) => void;
    comparePicker: { leftId: string; rightId: string } | null;
    setComparePicker: (next: { leftId: string; rightId: string } | null) => void;
    openCompareTab: (leftId: string, rightId: string) => void;

    // -- Quartz diff
    activeDiffRevisionIndex: number;
    activeDiffEntriesLength: number;
    switchQuartzDiffRevision: (tabId: string, direction: 'prev' | 'next') => void;
    handleAcceptQuartzHistory: (entryId: string) => void;
    handleRejectQuartzHistory: (entryId: string) => void;

    // -- Texture preview
    reloadingTexTabId: string | null;
    handleTexEditImage: (resolvedPath: string | null | undefined) => void;
    handleTexShowInExplorer: (resolvedPath: string | null | undefined) => void;
    handleTexReload: () => void;

    // -- Texture hover popup
    texPopup: TexPopupData | null;
    closeTexPopup: () => void;
    handleTexOpenFull: () => void;
    isOverTexPopupRef: React.MutableRefObject<boolean>;

    // -- Editor context menu
    ctxMenu: { x: number; y: number } | null;
    setCtxMenu: (m: { x: number; y: number } | null) => void;
    foldAllEmitters: () => void;
    unfoldAllEmitters: () => void;
    hasEmitters: () => boolean;

    // -- Dialogs
    showGuideOverlay: boolean;
    setShowGuideOverlay: (open: boolean) => void;
    showAboutDialog: boolean;
    setShowAboutDialog: (open: boolean) => void;
    showThemesDialog: boolean;
    setShowThemesDialog: (open: boolean) => void;
    showMaterialLibrary: boolean;
    setShowMaterialLibrary: (open: boolean) => void;
    showSettingsDialog: boolean;
    setShowSettingsDialog: (open: boolean) => void;
    showPreferencesDialog: boolean;
    setShowPreferencesDialog: (open: boolean) => void;
    showQuartzInstallModal: boolean;
    setShowQuartzInstallModal: (open: boolean) => void;
    showNewFileDialog: boolean;
    setShowNewFileDialog: (open: boolean) => void;
    particleDialogOpen: boolean;
    setParticleDialogOpen: (open: boolean) => void;
    handleThemeApplied: () => void;
    handleCreateNewFile: (fileName: string) => void;

    // -- Toasts
    updateToastVersion: string | null;
    setUpdateToastVersion: (v: string | null) => void;
    fileLoading: { name: string; detail?: string } | null;
    hashSyncToast: HashSyncToastState | null;
    hashToastHideTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    hashToastDismissedRef: React.MutableRefObject<boolean>;
    setHashSyncToast: (s: HashSyncToastState | null) => void;

    // -- Preferences side-effects (PreferencesDialog wiring)
    emitterHintsEnabled: React.MutableRefObject<boolean>;
    syntaxCheckingEnabled: React.MutableRefObject<boolean>;
    updateEmitterNameDecorations: (editor: MonacoType.editor.IStandaloneCodeEditor) => void;
    updateSyntaxMarkers: (editor: MonacoType.editor.IStandaloneCodeEditor) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function ShellProvider({ value, children }: { value: ShellContextValue; children: ReactNode }) {
    return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
    const ctx = useContext(ShellContext);
    if (!ctx) {
        throw new Error('useShell() called outside ShellProvider — wrap your shell component in <ShellProvider>.');
    }
    return ctx;
}
