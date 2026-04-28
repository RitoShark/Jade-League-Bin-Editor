import { createContext, useContext, type ReactNode } from 'react';
import type { Monaco } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import type { EditorTab } from '../components/TabBar';

export type PerfMode = 'on' | 'auto' | 'off';
export type PerfKey =
    | 'minimap' | 'bracketColors' | 'occurrencesHighlight' | 'selectionHighlight'
    | 'lineHighlight' | 'folding' | 'stopRenderingLine';
export type QuartzMode = 'paint' | 'port' | 'bineditor' | 'vfxhub';
export type ShellVariant = 'vscode' | 'word' | 'visualstudio';

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
    setGeneralEditPanelOpen: (open: boolean) => void;
    setParticlePanelOpen: (open: boolean) => void;

    // -- Recent files
    recentFiles: string[];
    openFileDisabled: boolean;
    openFileFromPath: (path: string) => void | Promise<void>;

    // -- File operations
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onSaveAs: () => void;
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
    onSelectAll: () => void;

    // -- Tools
    onGeneralEdit: () => void;
    onParticlePanel: () => void;
    onParticleEditor: () => void;
    onMaterialLibrary: () => void;
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

    // -- Edit panel callbacks
    handleGeneralEditContentChange: (newContent: string) => void;
    handleScrollToLine: (line: number) => void;
    recordJadelibInsert: (filePath: string, modRoot: string, id: string) => void;
    mdWrapSelection: (before: string, after: string) => boolean;
    mdPrefixLines: (prefix: string) => boolean;
    mdInsertAtCaret: (text: string) => boolean;

    // -- Markdown preview
    mdPreviewContent: string;

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
