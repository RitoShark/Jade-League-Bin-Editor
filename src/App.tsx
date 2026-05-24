import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask as askDialog, save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import type { StudioSceneData } from "./lib/babylon/studioScene";
import { Monaco } from "@monaco-editor/react";
import type * as MonacoType from 'monaco-editor';
import { registerRitobinLanguage, registerRitobinTheme, RITOBIN_LANGUAGE_ID, RITOBIN_THEME_ID } from "./lib/ritobinLanguage";
import { registerColorProvider } from "./lib/colorProvider";
import {
  saveBinFile, readBinDirect, writeBinDirect,
  openAnyEditorFile, saveAnyFileAs, saveAnyFileToPath, readTextDirect,
  isBinLikePath, isPlainTextPath, getFileExtension,
} from "./lib/binOperations";
import { loadSavedTheme } from "./lib/themeApplicator";
import { checkSyntax, suggestType } from "./lib/syntaxChecker";
import { texBufferToDataURL, ddsBufferToDataURL, ddsFormatName } from "./lib/texFormat";
import { EditorTab, createQuartzDiffTab, createMarkdownPreviewTab, createStudioTab, createTab, createTexPreviewTab, createCompareTab, getFileName } from "./components/TabBar";
import type { StudioScene } from "./lib/babylon/studioScene";
import { ShellProvider, type ShellContextValue, type PerfMode, type PerfKey, type HashSyncToastState, type ShellVariant, type FileExplorerRoot } from "./shells/ShellContext";
import FetchAnimationsDialog from "./components/FetchAnimationsDialog";
import ShellHost from "./shells/ShellHost";
import { findAndOpenLinkedBins, LinkedBinResult } from "./lib/linkedBinParser";
import "./App.css";
import "./App.modernui.css";

interface UpdateInfo {
  available: boolean;
  version: string;
  notes: string;
  release_url: string;
}

// Store editor view states (scroll position, cursor position) per tab
interface EditorViewState {
  viewState: MonacoType.editor.ICodeEditorViewState | null;
}

interface InteropHandoff {
  target_app: string;
  source_app: string;
  action: string;
  mode?: string | null;
  bin_path: string;
  created_at_unix: number;
}

interface QuartzEditSession {
  filePath: string;
  mode: 'paint' | 'port' | 'bineditor' | 'vfxhub';
  snapshotContent: string;
  lastSeenMtime: number | null;
  pendingEntryId: string | null;
  forceContentCheck: boolean;
}

interface QuartzHistoryEntry {
  id: string;
  tabId: string;
  filePath: string;
  fileName: string;
  mode: 'paint' | 'port' | 'bineditor' | 'vfxhub';
  beforeContent: string;
  afterContent: string;
  detectedAt: number;
  status: 'pending' | 'accepted' | 'rejected';
}

const MAX_QUARTZ_HISTORY_PER_FILE = 10;
const QUARTZ_INTEROP_DEBUG = true;

/**
 * Pick the Monaco language id for a given file path. Bins and their
 * .py sidecars stay on the ritobin language so the existing syntax,
 * decorations and language services keep working. Other formats fall
 * back to a Monaco built-in or 'plaintext' so JSON/MD/etc. don't get
 * ritobin coloring on them.
 */
function getMonacoLanguageForPath(filePath: string | null): string {
  if (!filePath) return RITOBIN_LANGUAGE_ID;
  const ext = getFileExtension(filePath);
  if (!ext || ext === 'bin' || ext === 'py') return RITOBIN_LANGUAGE_ID;
  switch (ext) {
    case 'json':           return 'json';
    case 'xml':            return 'xml';
    case 'html':
    case 'htm':            return 'html';
    case 'css':            return 'css';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':            return 'javascript';
    case 'ts':
    case 'tsx':            return 'typescript';
    case 'md':
    case 'markdown':       return 'markdown';
    case 'yaml':
    case 'yml':            return 'yaml';
    case 'sql':            return 'sql';
    case 'sh':             return 'shell';
    case 'bat':
    case 'cmd':            return 'bat';
    case 'ps1':            return 'powershell';
    default:               return 'plaintext';
  }
}

function App() {
  // Tab management - start with NO tabs (empty)
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  // Per-pane active-tab ids. The exposed `activeTabId` below is a
  // DERIVED value: whichever pane is focused, that pane's active tab
  // is the "current" tab from the shell's perspective. This keeps
  // every existing `activeTabId` consumer working without changes —
  // they just follow focus automatically.
  //
  // The `setActiveTabId` wrapper routes writes to the corresponding
  // per-pane state based on which pane the target tab lives in (its
  // `pane` field). New tabs created via the focused pane therefore
  // become active in THAT pane, and clicks in either tab bar follow
  // naturally.
  const [leftActiveTabId, setLeftActiveTabId] = useState<string | null>(null);
  const [rightActiveTabIdState, setRightActiveTabIdState] = useState<string | null>(null);
  const viewStatesRef = useRef<Map<string, EditorViewState>>(new Map());

  // UI state
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [appMemoryBytes, setAppMemoryBytes] = useState<number>(0);

  // Performance preferences: each editor feature can be 'on' (always),
  // 'auto' (off on big files >50k lines) or 'off' (always). Mirrors the
  // schema written by the Performance tab in SettingsDialog.
  const PERF_PREF_KEYS: Record<PerfKey, string> = {
    minimap:              'Perf_Minimap',
    bracketColors:        'Perf_BracketColors',
    occurrencesHighlight: 'Perf_OccurrencesHighlight',
    selectionHighlight:   'Perf_SelectionHighlight',
    lineHighlight:        'Perf_LineHighlight',
    folding:              'Perf_Folding',
    stopRenderingLine:    'Perf_StopRenderingLine',
  };
  const PERF_DEFAULTS: Record<PerfKey, PerfMode> = {
    minimap: 'auto', bracketColors: 'auto', occurrencesHighlight: 'auto',
    selectionHighlight: 'auto', lineHighlight: 'auto', folding: 'auto',
    stopRenderingLine: 'auto',
  };
  const BIG_FILE_LINES = 125_000;
  const [perfPrefs, setPerfPrefs] = useState<Record<PerfKey, PerfMode>>(PERF_DEFAULTS);
  const [showGuideOverlay, setShowGuideOverlay] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [showThemesDialog, setShowThemesDialog] = useState(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState(false);
  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [showQuartzInstallModal, setShowQuartzInstallModal] = useState(false);
  const [comparePicker, setComparePicker] = useState<{ leftId: string; rightId: string } | null>(null);
  const [assetGalleryTabId, setAssetGalleryTabId] = useState<string | null>(null);
  const [updateToastVersion, setUpdateToastVersion] = useState<string | null>(null);
  const [hashSyncToast, setHashSyncToast] = useState<HashSyncToastState | null>(null);
  // When the startup fingerprint check finds an update *and* hashes are
  // already present, we hold the actual download until after the user's
  // file has finished opening — otherwise the LMDB swap can land mid-
  // BIN-conversion and the file ends up rendered with hex names. The
  // pending-download payload is set here and consumed by an effect that
  // watches for `tabs.length > 0 && !fileLoading`.
  const pendingFileOpenRef = useRef(false);
  const [pendingHashDownload, setPendingHashDownload] = useState<{ latestTag: string } | null>(null);
  const [fileLoading, setFileLoading] = useState<{ name: string; detail?: string } | null>(null);
  const [, setHashSyncBusy] = useState(true);
  const [appIcon, setAppIcon] = useState<string>("/media/jade.ico");
  const [findWidgetOpen, setFindWidgetOpen] = useState(false);
  const [replaceWidgetOpen, setReplaceWidgetOpen] = useState(false);
  const [generalEditPanelOpen, setGeneralEditPanelOpen] = useState(false);
  const [particlePanelOpen, setParticlePanelOpen] = useState(false);
  const [textureInsertOpen, setTextureInsertOpen] = useState(false);
  const [materialInsertOpen, setMaterialInsertOpen] = useState(false);
  const [binNavOpen, setBinNavOpen] = useState(false);
  const [mdPreviewContent, setMdPreviewContent] = useState<string>('');
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [particleDialogOpen, setParticleDialogOpen] = useState(false);
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);
  const [editorTheme, setEditorTheme] = useState(RITOBIN_THEME_ID);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const [caretPosition, setCaretPosition] = useState({ line: 1, column: 1 });
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [cigaretteMode, setCigaretteMode] = useState(false);
  const [jamesMode, setJamesMode] = useState(false);
  const [shellVariant, setShellVariant] = useState<ShellVariant>('vscode');
  // Mirror in a ref so long-lived listeners (Monaco mutation observer)
  // see the current variant without re-binding when it changes.
  const shellVariantRef = useRef<ShellVariant>('vscode');
  shellVariantRef.current = shellVariant;
  // Lets the Jade icon / "Main page" / "Continue without file" buttons
  // override the default "no tabs → welcome / has tabs → editor" toggle.
  // 'force' shows welcome over the editor; 'hide' keeps editor visible
  // even with zero tabs. Auto-resets whenever tab count changes so a
  // newly-opened file naturally lands on the editor.
  const [welcomeOverride, setWelcomeOverride] = useState<'force' | 'hide' | null>(null);
  // Split-pane mode opens a second full Monaco instance next to the
  // main one. Tabs are split between two pane-filtered tab bars via
  // each tab's `pane` field; each pane tracks its own active tab id.
  // `splitRatio` is the left pane's fraction of the container width;
  // clamped to [0.1, 0.9] by the divider's drag handler. `focusedPane`
  // tracks the pane the user last interacted with so shell-level
  // shortcuts (save, find, etc.) and new file opens go to that pane.
  const [splitMode, setSplitModeState] = useState(false);
  const [splitRatio, setSplitRatioState] = useState(0.5);
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left');

  // The exposed `activeTabId` is whichever pane is focused, so every
  // existing consumer (and the existing 17 `setActiveTabId` call
  // sites) keeps working without change. `setActiveTabId` writes are
  // ROUTED below to the per-pane state matching the target tab's
  // `pane` field.
  const activeTabId = (splitMode && focusedPane === 'right')
    ? rightActiveTabIdState
    : leftActiveTabId;
  // Expose under the existing name. Real consumers downstream read
  // `rightActiveTabId` from this same value.
  const rightActiveTabId = rightActiveTabIdState;

  const setSplitMode = useCallback((b: boolean) => {
    setSplitModeState(b);
    if (b) {
      // Turning split ON: immediately move the currently-active tab
      // to the RIGHT pane so the user doesn't have to manually drag
      // anything to get a useful side-by-side view. The left pane
      // falls back to whichever other tab is available.
      //
      // We read `tabs` / active id from the latest closure values
      // and use functional setters to avoid stale reads when this
      // gets called inside an async toggle.
      const currentActive = activeTabId;
      if (currentActive && tabs.length >= 2) {
        setTabs(prev => prev.map(t =>
          t.id === currentActive ? { ...t, pane: 'right' } : t
        ));
        setRightActiveTabIdState(currentActive);
        // Pick any other tab to keep the left pane non-empty.
        const fallback = tabs.find(t => t.id !== currentActive);
        setLeftActiveTabId(fallback?.id ?? null);
        setFocusedPane('right');
      }
    } else {
      // Turning split OFF: collapse all tabs back into the left
      // pane (so the single-pane tab bar shows everything), preserve
      // whichever tab was active, and clear right-pane state.
      setTabs(prev => prev.map(t => t.pane === 'right' ? { ...t, pane: 'left' } : t));
      setRightActiveTabIdState(null);
      setFocusedPane('left');
    }
  }, [activeTabId, tabs]);

  // Auto-collapse split when fewer than two files remain — splitting
  // with one tab open is useless and (per the user's report) makes
  // the layout feel stuck. Toggling off here runs the same collapse
  // path as the manual toggle, so the lone tab returns to the left.
  useEffect(() => {
    if (splitMode && tabs.length < 2) {
      setSplitModeState(false);
      setTabs(prev => prev.map(t => t.pane === 'right' ? { ...t, pane: 'left' } : t));
      setRightActiveTabIdState(null);
      setFocusedPane('left');
    }
  }, [splitMode, tabs.length]);
  const setSplitRatio = useCallback((n: number) => {
    setSplitRatioState(Math.max(0.1, Math.min(0.9, n)));
  }, []);

  // Wrap the per-pane active-tab setters into the legacy
  // `setActiveTabId(id)` shape so existing code doesn't need to
  // change. Routes the write based on which pane the target tab
  // belongs to, and pulls focus to that pane.
  const setActiveTabId = useCallback((id: string | null) => {
    if (id === null) {
      setLeftActiveTabId(null);
      setRightActiveTabIdState(null);
      return;
    }
    // Look up the tab's pane (default left). When split is OFF
    // every tab is effectively on the left pane.
    const tab = tabs.find(t => t.id === id);
    const pane = (splitMode && tab?.pane === 'right') ? 'right' : 'left';
    if (pane === 'right') {
      setRightActiveTabIdState(id);
      setFocusedPane('right');
    } else {
      setLeftActiveTabId(id);
      if (splitMode) setFocusedPane('left');
    }
  }, [tabs, splitMode]);

  // Tab close cleanup: if either pane's active tab no longer exists,
  // clear or fall back to another tab in the same pane.
  useEffect(() => {
    const ids = new Set(tabs.map(t => t.id));
    if (leftActiveTabId && !ids.has(leftActiveTabId)) {
      const fallback = tabs.find(t => (t.pane ?? 'left') === 'left');
      setLeftActiveTabId(fallback?.id ?? null);
    }
    if (rightActiveTabIdState && !ids.has(rightActiveTabIdState)) {
      const fallback = tabs.find(t => t.pane === 'right');
      setRightActiveTabIdState(fallback?.id ?? null);
    }
  }, [tabs, leftActiveTabId, rightActiveTabIdState]);

  // Drag-drop tab between panes. Reassigns the tab's `pane` field
  // and reshuffles active-tab pointers so the moved tab becomes
  // active in its new pane (matches VSCode's behavior) while the
  // origin pane falls back to a sibling.
  const onTabSetPane = useCallback((tabId: string, pane: 'left' | 'right') => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (!tab) return prev;
      const currentPane = tab.pane ?? 'left';
      if (currentPane === pane) return prev;
      return prev.map(t => t.id === tabId ? { ...t, pane } : t);
    });
    // Pull active state after reshuffle. Read latest via functional
    // update on each setter to avoid stale closures.
    setLeftActiveTabId(prev => {
      if (pane === 'right' && prev === tabId) {
        // Moved away from left — pick another left tab as fallback
        const fallback = tabs.find(t => t.id !== tabId && (t.pane ?? 'left') === 'left');
        return fallback?.id ?? null;
      }
      if (pane === 'left' && prev !== tabId) {
        return tabId; // make it active in left
      }
      return prev;
    });
    setRightActiveTabIdState(prev => {
      if (pane === 'left' && prev === tabId) {
        const fallback = tabs.find(t => t.id !== tabId && t.pane === 'right');
        return fallback?.id ?? null;
      }
      if (pane === 'right' && prev !== tabId) {
        return tabId;
      }
      return prev;
    });
    setFocusedPane(pane);
  }, [tabs]);

  // Model creation helper that's safe to call from anywhere — both
  // App's tab-switch effect AND the right pane's mount can hit this
  // and get back the SAME Monaco model for a given tab id. Fixes
  // the "right pane goes blank after a shell switch" cascade where
  // the cached model gets disposed but the registry still holds a
  // dangling reference.
  const ensureModelForTab = useCallback(
    (tabId: string): MonacoType.editor.ITextModel | null => {
      const monaco = monacoRef.current;
      if (!monaco) return null;
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return null;
      const cached = monacoModelsRef.current.get(tabId);
      if (cached && !cached.isDisposed()) return cached;
      const uri = tab.filePath
        ? monaco.Uri.file(tab.filePath)
        : monaco.Uri.parse(`inmemory://tab/${tabId}`);
      const existing = monaco.editor.getModel(uri);
      if (existing && !existing.isDisposed()) {
        monacoModelsRef.current.set(tabId, existing);
        return existing;
      }
      const fresh = monaco.editor.createModel(
        tab.content,
        getMonacoLanguageForPath(tab.filePath ?? tab.fileName),
        uri,
      );
      monacoModelsRef.current.set(tabId, fresh);
      return fresh;
    },
    [tabs],
  );

  useEffect(() => {
    setWelcomeOverride(null);
  }, [tabs.length]);
  const [quartzInteropEnabled, setQuartzInteropEnabled] = useState(true);
  const [quartzHistoryEntries, setQuartzHistoryEntries] = useState<QuartzHistoryEntry[]>([]);
  const quartzSessionsRef = useRef<Map<string, QuartzEditSession>>(new Map());

  // Texture click-to-preview popup state
  interface TexPopupState {
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
  const [texPopup, setTexPopup] = useState<TexPopupState | null>(null);
  const texPopupRef = useRef<TexPopupState | null>(null);
  texPopupRef.current = texPopup;
  const isOverTexPopupRef = useRef(false);

  // Track normal window dimensions (when not maximized/fullscreen)
  const normalWindowSize = useRef<{ width: number; height: number; x: number; y: number }>({
    width: 1200,
    height: 800,
    x: 100,
    y: 100
  });

  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  // Empty default lets Monaco fall back to its own font (matches the
  // pre-PR look). The theme system only sets a real value when the user
  // picks a font in Themes > Fonts.
  const [editorFontFamily, setEditorFontFamily] = useState("");
  const editorDisposablesRef = useRef<MonacoType.IDisposable[]>([]);

  // When font state changes, tell Monaco to re-measure so cursor/selection align correctly.
  useEffect(() => {
    if (!monacoRef.current || !editorRef.current) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      monacoRef.current?.editor.remeasureFonts();
    }));
  }, [editorFontFamily]);

  // PR #4 introduced an `editorOptions` memo for plumbing the font into
  // Monaco from this file. Since the shells refactor moved Monaco into
  // EditorPane, the memo would be unused here. We forward the font
  // family through ShellContext instead — EditorPane reads it (TODO:
  // wire fontFamily into shellCtx + EditorPane to actually swap fonts).

  const emitterDecorationIds = useRef<string[]>([]);
  const emitterDecorDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emitterHintsEnabled = useRef(true);
  const syntaxCheckingEnabled = useRef(true);
  const syntaxCheckDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syntaxDecorationIds = useRef<string[]>([]);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const mutationSetupTimeoutRef = useRef<number | null>(null);
  const undoCheckIntervalRef = useRef<number | null>(null);
  // Map of tabId -> Monaco ITextModel (model-based tab switching to prevent RAM leaks)
  const monacoModelsRef = useRef<Map<string, MonacoType.editor.ITextModel>>(new Map());
  // LRU order for model eviction: most-recently-used tab IDs (front = oldest)
  const modelLruRef = useRef<string[]>([]);
  const MODEL_CACHE_LIMIT = 10;
  const monacoRef = useRef<Monaco | null>(null);

  // Stable refs so Tauri/DOM event listeners (registered once) always call the
  // latest version of these callbacks rather than stale closure captures.
  const openFileFromPathRef = useRef<((path: string) => Promise<void>) | null>(null);
  // Set late (studioOpenSceneFromPath is defined far below) so the
  // early path-open + drag-drop code can route `.studio.json` to the
  // studio loader instead of the text editor.
  const studioOpenSceneFromPathRef = useRef<((path: string) => Promise<void>) | null>(null);
  const isStudioScenePath = (p: string) => /\.studio\.json$/i.test(p);
  const openingFilesRef = useRef<Set<string>>(new Set()); // prevents duplicate concurrent opens
  const handleTabCloseRef = useRef<((tabId: string) => void) | null>(null);
  const handleNewRef = useRef<(() => void) | null>(null);
  const handleOpenRef = useRef<(() => void) | null>(null);
  const handleSaveRef = useRef<(() => void) | null>(null);
  const handleSaveAsRef = useRef<(() => void) | null>(null);
  const handleSaveAllRef = useRef<(() => void) | null>(null);
  const handleFindRef = useRef<(() => void) | null>(null);
  const handleReplaceRef = useRef<(() => void) | null>(null);
  const handleCompareRef = useRef<(() => void) | null>(null);
  const lastRejectedTabCloseRef = useRef<{ tabId: string; at: number } | null>(null);

  // Tracks library material texture inserts performed during this editing
  // session, keyed by bin filePath. Used to offer cleanup when the user
  // closes without saving, and cleared when the user saves the bin.
  const jadelibInsertsRef = useRef<Map<string, Array<{ modRoot: string; id: string }>>>(new Map());
  const recordJadelibInsert = useCallback((filePath: string, modRoot: string, id: string) => {
    const list = jadelibInsertsRef.current.get(filePath) ?? [];
    // Deduplicate — one entry per (modRoot, id) pair
    if (!list.some(e => e.modRoot === modRoot && e.id === id)) {
      list.push({ modRoot, id });
    }
    jadelibInsertsRef.current.set(filePath, list);
  }, []);

  // Get the active tab
  const activeTab = tabs.find(t => t.id === activeTabId) || null;
  const isEditorTab = (tab: EditorTab | null | undefined): boolean =>
    (tab?.tabType ?? 'editor') === 'editor';

  // Ref to track active tab for keyboard shortcuts
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Ref to track active tab ID for keyboard shortcuts
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Close editor-only floating widgets when the user switches to a tab
  // that doesn't host them. The Find / Replace / General-edit / Bin-nav
  // /Particle panels live above the editor pane — when the active tab
  // is a Studio scene or a texture preview those panels have nothing
  // to attach to, so leaving them open strands the user (no editor in
  // sight to receive the Esc / close action).
  useEffect(() => {
    if (!isEditorTab(activeTab)) {
      if (findWidgetOpen) setFindWidgetOpen(false);
      if (replaceWidgetOpen) setReplaceWidgetOpen(false);
      if (generalEditPanelOpen) setGeneralEditPanelOpen(false);
      if (particlePanelOpen) setParticlePanelOpen(false);
      if (binNavOpen) setBinNavOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.tabType]);

  // Ref to track if we should allow hash preload status updates
  // This prevents hash preload status from overriding important messages like "Opened file"
  const statusMessageRef = useRef<string>("Ready");
  const allowHashStatusUpdateRef = useRef<boolean>(true);
  const hashToastHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latches when the user dismisses the hash sync toast so subsequent
  // progress events from the backend don't keep reopening it. Reset at
  // the start of each new check session.
  const hashToastDismissedRef = useRef<boolean>(false);
  const showHashToast = useCallback((state: HashSyncToastState) => {
    if (hashToastDismissedRef.current) return;
    setHashSyncToast(state);
  }, []);

  // Auto-clear status messages after 5s — keeps the status bar tidy
  // by reverting whatever transient message ("Opened …", "Saved", etc.)
  // back to the idle "Ready" state.
  useEffect(() => {
    if (statusMessage === 'Ready' || !statusMessage) return;
    const t = setTimeout(() => {
      setStatusMessage('Ready');
      statusMessageRef.current = 'Ready';
    }, 5000);
    return () => clearTimeout(t);
  }, [statusMessage]);

  // Poll the app's RAM usage for the status bar indicator. Backend walks
  // the whole process tree (Rust + WebView2 helpers) and returns Private
  // Bytes — same metric Task Manager shows. Refresh slowly so the query
  // and the JS re-render don't add measurable overhead.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      invoke<number>('get_app_memory_usage')
        .then(bytes => { if (!cancelled) setAppMemoryBytes(Number(bytes) || 0); })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Load performance preferences once and listen for live changes from
  // the Performance tab in Settings so changes apply without restart.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<PerfKey, PerfMode> = { ...PERF_DEFAULTS };
      for (const key of Object.keys(PERF_PREF_KEYS) as PerfKey[]) {
        try {
          const raw = await invoke<string>('get_preference', {
            key: PERF_PREF_KEYS[key],
            defaultValue: PERF_DEFAULTS[key],
          });
          if (raw === 'on' || raw === 'auto' || raw === 'off') next[key] = raw as PerfMode;
        } catch { /* fall through to default */ }
      }
      if (!cancelled) setPerfPrefs(next);
    })();

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ key: PerfKey; mode: PerfMode }>).detail;
      if (!detail) return;
      setPerfPrefs(prev => ({ ...prev, [detail.key]: detail.mode }));
    };
    window.addEventListener('perf-pref-changed', handler);
    return () => { cancelled = true; window.removeEventListener('perf-pref-changed', handler); };
  }, []);

  // When the active tab is a markdown preview, mirror its source tab's
  // content into mdPreviewContent. We subscribe to the source model's
  // content change so the rendered preview stays current if the user
  // switches back to the source, edits, and returns. Falls back to the
  // last cached `content` field on the source tab if Monaco hasn't
  // materialized a model for it yet (uncommon).
  useEffect(() => {
    if (activeTab?.tabType !== 'markdown-preview') {
      return;
    }
    const sourceId = activeTab.sourceTabId;
    if (!sourceId) {
      setMdPreviewContent('');
      return;
    }
    const sourceModel = monacoModelsRef.current.get(sourceId);
    if (!sourceModel || sourceModel.isDisposed()) {
      const sourceTab = tabsRef.current.find(t => t.id === sourceId);
      setMdPreviewContent(sourceTab?.content ?? '');
      return;
    }
    setMdPreviewContent(sourceModel.getValue());
    const sub = sourceModel.onDidChangeContent(() => {
      setMdPreviewContent(sourceModel.getValue());
    });
    return () => { sub.dispose(); };
  }, [activeTabId, activeTab?.tabType, activeTab?.sourceTabId]);

  // Load custom icon and window state on mount
  useEffect(() => {
    loadCustomIcon();
    restoreWindowState();
    // Auto-sync hashes in the background. Preload-into-RAM was removed
    // — LMDB lookups are cheap enough on demand that the spike at startup
    // wasn't earning its cost. Tiny grace window (450 ms) lets a
    // file-association `open-file` event from Tauri's single-instance
    // handler arrive *before* we kick the fingerprint check, so the flow
    // can defer a real download until after the BIN finishes converting.
    const hashStartupTimer = setTimeout(() => { autoDownloadHashesOnStartup(); }, 450);
    loadRecentFiles(); // Just load the list, don't open files
    if (!monacoInstance) {
      loadSavedTheme(invoke);
    }

    invoke<string>('get_preference', { key: 'CigaretteMode', defaultValue: 'false' })
      .then(val => setCigaretteMode(val === 'true'))
      .catch(() => {});
    invoke<string>('get_preference', { key: 'JamesMode', defaultValue: 'false' })
      .then(val => setJamesMode(val === 'true'))
      .catch(() => {});
    invoke<string>('get_preference', { key: 'CommunicateWithQuartz', defaultValue: 'True' })
      .then(val => setQuartzInteropEnabled(val === 'True'))
      .catch(() => setQuartzInteropEnabled(true));
    invoke<string>('get_preference', { key: 'EmitterNameHints', defaultValue: 'True' })
      .then(val => { emitterHintsEnabled.current = val !== 'False'; })
      .catch(() => {});
    invoke<string>('get_preference', { key: 'SyntaxChecking', defaultValue: 'True' })
      .then(val => { syntaxCheckingEnabled.current = val !== 'False'; })
      .catch(() => {});
    // First-launch guide — show if the user has never completed it.
    invoke<string>('get_preference', { key: 'GuideCompleted', defaultValue: 'False' })
      .then(val => { if (val !== 'True') setShowGuideOverlay(true); })
      .catch(() => {});

    // Studio-shell migration. Bumped from `StudioMigrated` to
    // `StudioMigratedV2` for this release because the previous round
    // missed users who'd already stamped V1 while still on vscode /
    // word — we want everyone re-flipped to visualstudio (the only
    // shell that currently has the full Studio feature set). Anyone
    // already on visualstudio is a no-op write; users can still
    // change shells in Settings after the flip.
    (async () => {
      try {
        const migrated = await invoke<string>('get_preference', { key: 'StudioMigratedV2', defaultValue: 'False' });
        if (migrated !== 'True') {
          await invoke('set_preference', { key: 'UiShell', value: 'visualstudio' });
          await invoke('set_preference', { key: 'StudioMigratedV2', value: 'True' });
          setShellVariant('visualstudio');
          window.dispatchEvent(new CustomEvent('shell-changed', { detail: 'visualstudio' }));
          return;
        }
        const val = await invoke<string>('get_preference', { key: 'UiShell', defaultValue: 'vscode' });
        if (val === 'word' || val === 'visualstudio' || val === 'vscode') setShellVariant(val);
      } catch (e) {
        console.warn('[App] shell load / migration failed:', e);
      }
    })();

    const handleCigaretteModeChanged = (e: Event) => {
      setCigaretteMode((e as CustomEvent<boolean>).detail);
    };
    const handleJamesModeChanged = (e: Event) => {
      setJamesMode((e as CustomEvent<boolean>).detail);
    };
    const handleQuartzInteropChanged = (e: Event) => {
      setQuartzInteropEnabled((e as CustomEvent<boolean>).detail !== false);
    };
    const handleShellChanged = (e: Event) => {
      const v = (e as CustomEvent<ShellVariant>).detail;
      if (v === 'vscode' || v === 'word' || v === 'visualstudio') setShellVariant(v);
    };
    const handleEditorFontChanged = (e: Event) => {
      const fontFamily = (e as CustomEvent<string>).detail;
      setEditorFontFamily(fontFamily);
    };
    window.addEventListener('cigarette-mode-changed', handleCigaretteModeChanged);
    window.addEventListener('james-mode-changed', handleJamesModeChanged);
    window.addEventListener('quartz-interop-changed', handleQuartzInteropChanged);
    window.addEventListener('shell-changed', handleShellChanged);
    window.addEventListener('jade-editor-font-changed', handleEditorFontChanged);

    // Listen for open-file events from backend (file association double-click or single-instance)
    const openFileUnlisten = listen<string>('open-file', async (event) => {
      const filePath = event.payload;
      if (filePath && filePath.trim()) {
        console.log('[App] Received open-file event:', filePath);
        // Flag the startup hash flow so it knows to defer any update
        // download until after this file has loaded — otherwise the
        // LMDB swap collides with BIN conversion mid-flight.
        pendingFileOpenRef.current = true;
        // Bring window to front when a file is opened externally
        const win = getCurrentWindow();
        try {
          await win.unminimize();
          await win.show();
          await win.setFocus();
        } catch (_) { /* best-effort */ }
        openFileFromPathRef.current?.(filePath);
      }
    });

    const hashProgressUnlisten = listen<{
      phase?: string;
      current?: number;
      total?: number;
      downloaded?: number;
      skipped?: number;
      file?: string;
      message?: string;
    }>('hash-sync-progress', (event) => {
      const payload = event.payload || {};
      const phase = String(payload.phase || '');
      const total = Number(payload.total || 0);
      const current = Number(payload.current || 0);
      const downloaded = Number(payload.downloaded || 0);

      const skipped = Number(payload.skipped || 0);
      if (phase === 'checking') {
        showHashToast({
          visible: true,
          status: 'checking',
          message: payload.message || 'Checking hash updates...'
        });
      } else if (phase === 'downloading') {
        showHashToast({
          visible: true,
          status: 'downloading',
          message: `Checked ${current}/${total} - Updated ${downloaded}${payload.file ? ` - ${payload.file}` : ''}`
        });
      } else if (phase === 'success') {
        showHashToast({
          visible: true,
          status: 'success',
          message: payload.message || `Done - Updated ${downloaded}, Skipped ${skipped}`
        });
      } else if (phase === 'error') {
        showHashToast({
          visible: true,
          status: 'error',
          message: payload.message || 'Hash update failed'
        });
      }
    });

    // Auto-check for updates on startup
    invoke<string>('get_preference', { key: 'AutoCheckUpdates', defaultValue: 'True' })
      .then(async pref => {
        if (pref !== 'True') return;
        try {
          const info = await invoke<UpdateInfo>('check_for_update');
          // Broadcast to SettingsDialog so it can show the result without re-fetching
          window.dispatchEvent(new CustomEvent('update-check-result', { detail: info }));
          if (!info.available) return;
          const autoDownload = await invoke<string>('get_preference', { key: 'AutoDownloadUpdates', defaultValue: 'False' });
          if (autoDownload !== 'True') {
            // Just notify the user, don't download
            setUpdateToastVersion(info.version);
            return;
          }
          const silent = await invoke<string>('get_preference', { key: 'SilentUpdate', defaultValue: 'False' });
          if (silent === 'True') {
            // Download and install with no UI
            await invoke('start_update_download');
            await invoke('run_installer', { silent: true });
          } else {
            // Download but let user click install
            await invoke('start_update_download');
            setUpdateToastVersion(info.version);
          }
        } catch (e) {
          console.warn('[Updater] Auto-check failed:', e);
        }
      })
      .catch(() => { });

    const handleIconChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      setAppIcon(customEvent.detail || '/media/jade.ico');
    };

    window.addEventListener('icon-changed', handleIconChange);

    // Event listeners for keyboard shortcuts
    const handleAppNew = () => handleNewRef.current?.();
    const handleAppOpen = () => handleOpenRef.current?.();
    const handleAppSave = () => handleSaveRef.current?.();
    const handleAppSaveAs = () => handleSaveAsRef.current?.();
    const handleAppSaveAll = () => handleSaveAllRef.current?.();
    const handleAppFind = () => handleFindRef.current?.();
    const handleAppReplace = () => handleReplaceRef.current?.();
    const handleAppCompare = () => handleCompareRef.current?.();
    const handleAppCloseTab = () => {
      if (activeTabIdRef.current) {
        handleTabCloseRef.current?.(activeTabIdRef.current);
      }
    };
    const handleAppToggleMdPreview = () => {
      // Open (or focus) a Markdown preview tab tied to the current
      // markdown editor tab. If the active tab IS already a preview, jump
      // back to its source. If the active tab isn't markdown, do nothing.
      const current = activeTabRef.current;
      if (!current) return;
      const all = tabsRef.current;

      if (current.tabType === 'markdown-preview') {
        if (current.sourceTabId) setActiveTabId(current.sourceTabId);
        return;
      }
      // Fall back to fileName so unsaved tabs (e.g. File → New → README.md
      // with filePath still null) are still recognised as markdown.
      const ext = getFileExtension(current.filePath ?? current.fileName);
      if (ext !== 'md' && ext !== 'markdown') return;

      const existingPreview = all.find(t => t.tabType === 'markdown-preview' && t.sourceTabId === current.id);
      if (existingPreview) {
        setActiveTabId(existingPreview.id);
        return;
      }
      const previewTab = createMarkdownPreviewTab(current.id, current.fileName);
      setTabs(prev => [...prev, previewTab]);
      setActiveTabId(previewTab.id);
    };

    window.addEventListener('app-new', handleAppNew);
    window.addEventListener('app-toggle-md-preview', handleAppToggleMdPreview);
    window.addEventListener('app-open', handleAppOpen);
    window.addEventListener('app-save', handleAppSave);
    window.addEventListener('app-save-as', handleAppSaveAs);
    window.addEventListener('app-save-all', handleAppSaveAll);
    window.addEventListener('app-find', handleAppFind);
    window.addEventListener('app-replace', handleAppReplace);
    window.addEventListener('app-compare', handleAppCompare);
    window.addEventListener('app-close-tab', handleAppCloseTab);

    // Keyboard shortcut for General Edit panel (Ctrl+O), Particle panel (Ctrl+Shift+P), Tab switching (Ctrl+Tab/Ctrl+Shift+Tab) and Escape to close
    const handleKeyDown = (e: KeyboardEvent) => {
      // Helper to check if current file is bin or .py sidecar (ritobin
      // content). Used to gate particle/material/skin shortcuts so they
      // don't fire on markdown / json / plain-text tabs.
      const isBinFile = (): boolean => {
        const tab = activeTabRef.current;
        if (!tab) return false;
        if (!isEditorTab(tab)) return false;
        const name = (tab.filePath ?? tab.fileName).toLowerCase();
        return name.endsWith('.bin') || name.endsWith('.py');
      };

      // Ctrl+N - New file (untitled tab)
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N') && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-new'));
        return;
      }

      // Ctrl+S - Save file. Guard on `!e.altKey` so Ctrl+Alt+S
      // (Save All, handler below) doesn't match this branch first
      // and quietly do a single-file save instead.
      if (e.ctrlKey && e.key === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        // Trigger save - handleSave is defined elsewhere, use a custom event
        window.dispatchEvent(new CustomEvent('app-save'));
        return;
      }

      // Ctrl+Shift+S - Save As
      if (e.ctrlKey && e.shiftKey && e.key === 'S' && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-save-as'));
        return;
      }

      // Ctrl+Alt+S - Save All (every modified editor tab in one shot)
      if (e.ctrlKey && e.altKey && (e.key === 's' || e.key === 'S') && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-save-all'));
        return;
      }

      // Ctrl+Shift+V - Toggle markdown preview (matches VS Code)
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-toggle-md-preview'));
        return;
      }

      // Ctrl+Z - Undo
      if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
        // Don't prevent default - let Monaco handle it, but ensure editor is focused
        return;
      }

      // Ctrl+Y - Redo
      if (e.ctrlKey && e.key === 'y' && !e.shiftKey) {
        // Don't prevent default - let Monaco handle it
        return;
      }

      // Ctrl+F - Find
      if (e.ctrlKey && e.key === 'f' && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-find'));
        return;
      }

      // Ctrl+H - Replace
      if (e.ctrlKey && e.key === 'h' && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-replace'));
        return;
      }

      // Ctrl+A - Select All (let Monaco handle it)
      if (e.ctrlKey && e.key === 'a' && !e.shiftKey) {
        // Don't prevent default - let Monaco handle it
        return;
      }

      // Ctrl+X - Cut (let Monaco handle it)
      if (e.ctrlKey && e.key === 'x' && !e.shiftKey) {
        // Don't prevent default - let Monaco handle it
        return;
      }

      // Ctrl+C - Copy (let Monaco handle it)
      if (e.ctrlKey && e.key === 'c' && !e.shiftKey) {
        // Don't prevent default - let Monaco handle it
        return;
      }

      // Ctrl+V - Paste (let Monaco handle it)
      if (e.ctrlKey && e.key === 'v' && !e.shiftKey) {
        // Don't prevent default - let Monaco handle it
        return;
      }

      // Ctrl+W - Close current tab
      if (e.ctrlKey && e.key === 'w' && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-close-tab'));
        return;
      }

      // Tab switching shortcuts
      if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        // Save current view state before switching (model handles content)
        if (editorRef.current && activeTabIdRef.current) {
          const viewState = editorRef.current.saveViewState();
          viewStatesRef.current.set(activeTabIdRef.current, { viewState });
        }
        // Switch to next tab
        setTabs(currentTabs => {
          if (currentTabs.length <= 1) return currentTabs; // No need to switch if 0 or 1 tab

          const currentIndex = currentTabs.findIndex(t => t.id === activeTabIdRef.current);
          const nextIndex = currentIndex < currentTabs.length - 1 ? currentIndex + 1 : 0;
          setActiveTabId(currentTabs[nextIndex].id);
          return currentTabs;
        });
      } else if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        // Save current view state before switching (model handles content)
        if (editorRef.current && activeTabIdRef.current) {
          const viewState = editorRef.current.saveViewState();
          viewStatesRef.current.set(activeTabIdRef.current, { viewState });
        }
        // Switch to previous tab
        setTabs(currentTabs => {
          if (currentTabs.length <= 1) return currentTabs; // No need to switch if 0 or 1 tab

          const currentIndex = currentTabs.findIndex(t => t.id === activeTabIdRef.current);
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : currentTabs.length - 1;
          setActiveTabId(currentTabs[prevIndex].id);
          return currentTabs;
        });
      } else if (e.ctrlKey && e.key === 'o' && !e.shiftKey) {
        e.preventDefault();
        // Context-aware: Open file if no tabs, toggle General Edit if tabs exist
        const currentTabs = tabs;
        if (currentTabs.length === 0) {
          // No tabs open - trigger file open
          window.dispatchEvent(new CustomEvent('app-open'));
        } else {
          // Tabs exist - toggle General Edit panel
          setGeneralEditPanelOpen(prev => !prev);
        }
      } else if (e.ctrlKey && e.key === 'd' && !e.shiftKey) {
        e.preventDefault();
        // Compare files - dispatch event
        window.dispatchEvent(new CustomEvent('app-compare'));
      } else if (e.ctrlKey && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        // Only open particle dialog if bin file is loaded
        if (isBinFile()) {
          setParticlePanelOpen(false);
          setParticleDialogOpen(prev => !prev);
        }
      } else if (e.ctrlKey && e.key === 'p' && !e.shiftKey) {
        e.preventDefault();
        // Only open particle panel if bin file is loaded
        if (isBinFile()) {
          setFindWidgetOpen(false);
          setReplaceWidgetOpen(false);
          setGeneralEditPanelOpen(false);
          setParticlePanelOpen(prev => !prev);
        }
      } else if (e.key === 'Escape') {
        setGeneralEditPanelOpen(false);
        setParticlePanelOpen(false);
        setParticleDialogOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    let saveTimeout: ReturnType<typeof setTimeout> | null = null;
    const debouncedSave = () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        saveCurrentWindowState();
      }, 500);
    };

    const setupWindowListeners = async () => {
      const window = getCurrentWindow();
      const unlistenResize = await window.onResized(debouncedSave);
      const unlistenMove = await window.onMoved(debouncedSave);

      let lastMaximized = await window.isMaximized();
      let lastFullscreen = await window.isFullscreen();

      const checkMaximized = setInterval(async () => {
        const maximized = await window.isMaximized();
        const fullscreen = await window.isFullscreen();
        setIsMaximized(maximized || fullscreen);

        // Save state when maximized or fullscreen changes
        if (maximized !== lastMaximized || fullscreen !== lastFullscreen) {
          lastMaximized = maximized;
          lastFullscreen = fullscreen;
          debouncedSave();
        }
      }, 100);

      return () => {
        unlistenResize();
        unlistenMove();
        clearInterval(checkMaximized);
        if (saveTimeout) clearTimeout(saveTimeout);
      };
    };

    // Listen for file drop events from Tauri
    const setupFileDropListener = async () => {
      const unlisten = await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
        console.log('File drop event:', event.payload);
        setIsDragging(false);

        for (const filePath of event.payload.paths) {
          console.log('Dropped file:', filePath);
          // `.studio.json` opens as a Photo Studio scene. Checked
          // before the plain-text branch since `.json` would
          // otherwise route to the text editor.
          if (isStudioScenePath(filePath)) {
            await studioOpenSceneFromPathRef.current?.(filePath);
            continue;
          }
          // Accept any file Jade knows how to open: bin/.py go through
          // the bin pipeline, .troybin / .inibin go to the dedicated
          // troybin tab, and the curated plain-text list opens as raw
          // text. Unknown extensions are ignored so dropping (say) a
          // .exe doesn't try to render binary garbage.
          const lower = filePath.toLowerCase();
          const isTroybin = lower.endsWith('.troybin') || lower.endsWith('.inibin');
          if (isTroybin || isBinLikePath(filePath) || isPlainTextPath(filePath)) {
            await openFileFromPathRef.current?.(filePath);
          }
        }
      });

      const unlistenDragOver = await listen('tauri://drag', () => {
        setIsDragging(true);
      });

      return () => {
        unlisten();
        unlistenDragOver();
      };
    };

    let cleanup: (() => void) | undefined;
    let fileDropCleanup: (() => void) | undefined;

    setupWindowListeners().then(fn => { cleanup = fn; });
    setupFileDropListener().then(fn => { fileDropCleanup = fn; });

    return () => {
      if (hashToastHideTimeoutRef.current) {
        clearTimeout(hashToastHideTimeoutRef.current);
        hashToastHideTimeoutRef.current = null;
      }
      window.removeEventListener('icon-changed', handleIconChange);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('cigarette-mode-changed', handleCigaretteModeChanged);
      window.removeEventListener('james-mode-changed', handleJamesModeChanged);
      window.removeEventListener('quartz-interop-changed', handleQuartzInteropChanged);
      window.removeEventListener('shell-changed', handleShellChanged);
      window.removeEventListener('jade-editor-font-changed', handleEditorFontChanged);
      window.removeEventListener('app-new', handleAppNew);
      window.removeEventListener('app-toggle-md-preview', handleAppToggleMdPreview);
      window.removeEventListener('app-open', handleAppOpen);
      window.removeEventListener('app-save', handleAppSave);
      window.removeEventListener('app-save-as', handleAppSaveAs);
      window.removeEventListener('app-save-all', handleAppSaveAll);
      window.removeEventListener('app-find', handleAppFind);
      window.removeEventListener('app-replace', handleAppReplace);
      window.removeEventListener('app-compare', handleAppCompare);
      window.removeEventListener('app-close-tab', handleAppCloseTab);
      cleanup?.();
      fileDropCleanup?.();
      saveCurrentWindowState();
      // Unlisten from Tauri open-file/hash-sync events
      openFileUnlisten.then(fn => fn());
      hashProgressUnlisten.then(fn => fn());
      clearTimeout(hashStartupTimer);
    };
  }, [monacoInstance]);

  const saveCurrentWindowState = async () => {
    try {
      const window = getCurrentWindow();
      const maximized = await window.isMaximized();
      const fullscreen = await window.isFullscreen();

      // Minimum window size constants (matching backend)
      const MIN_WIDTH = 800;
      const MIN_HEIGHT = 600;

      // Update tracked normal dimensions only when not maximized/fullscreen
      if (!maximized && !fullscreen) {
        const size = await window.innerSize();
        const position = await window.outerPosition();

        // Enforce minimum size constraints
        const width = Math.max(size.width, MIN_WIDTH);
        const height = Math.max(size.height, MIN_HEIGHT);

        normalWindowSize.current = {
          width,
          height,
          x: position.x,
          y: position.y
        };
      }

      // Save the normal dimensions along with maximized/fullscreen state
      await invoke('save_window_state', {
        state: {
          width: normalWindowSize.current.width,
          height: normalWindowSize.current.height,
          x: normalWindowSize.current.x,
          y: normalWindowSize.current.y,
          maximized,
          fullscreen
        }
      });

      console.log('Saved window state:', {
        ...normalWindowSize.current,
        maximized,
        fullscreen
      });
    } catch (error) {
      console.error('Failed to save window state:', error);
    }
  };

  const restoreWindowState = async () => {
    try {
      const state = await invoke<{ width: number, height: number, x: number, y: number, maximized: boolean, fullscreen: boolean } | null>('get_window_state');

      console.log('Loading window state for tracking:', state);

      // Minimum window size constants (matching backend)
      const MIN_WIDTH = 800;
      const MIN_HEIGHT = 600;

      if (state) {
        // Store the normal dimensions for tracking (Rust already restored the window)
        // Enforce minimum size constraints
        normalWindowSize.current = {
          width: Math.max(state.width, MIN_WIDTH),
          height: Math.max(state.height, MIN_HEIGHT),
          x: state.x,
          y: state.y
        };

        const window = getCurrentWindow();
        const maximized = await window.isMaximized();
        const fullscreen = await window.isFullscreen();
        setIsMaximized(maximized || fullscreen);
      } else {
        // No saved state - capture current window dimensions
        const window = getCurrentWindow();
        const size = await window.innerSize();
        const position = await window.outerPosition();
        normalWindowSize.current = {
          width: Math.max(size.width, MIN_WIDTH),
          height: Math.max(size.height, MIN_HEIGHT),
          x: position.x,
          y: position.y
        };
      }
    } catch (error) {
      console.error('Failed to restore window state:', error);
    }
  };

  const loadCustomIcon = async () => {
    try {
      const iconData = await invoke<string | null>('get_custom_icon_data');
      if (iconData) {
        setAppIcon(iconData);
      }
    } catch (error) {
      console.error('Failed to load custom icon:', error);
    }
  };

  // Auto-download/update hashes on startup, gated by the user's chosen
  // schedule (every launch / every 3 days / never). The whole flow is
  // background work — file opening is never blocked by this.
  //
  // The "fingerprint" check is one HTTPS round-trip to the lmdb-hashes
  // releases API — it returns the latest tag and we compare to whatever
  // we stored in `hashes-meta.json`. Only an actual mismatch triggers a
  // real download.
  const autoDownloadHashesOnStartup = async () => {
    // Reset the toast dismissed latch for this new session.
    hashToastDismissedRef.current = false;
    try {
      const rawMode = await invoke<string>('get_preference', {
        key: 'HashUpdateMode',
        defaultValue: 'every_3_days'
      }).catch(() => 'every_3_days');
      // Migrate the legacy `every_7_days` value silently — the
      // schedule is now expressed in 3-day windows. `every_launch`
      // is a valid user choice (was previously force-migrated here,
      // which made it impossible to actually enable from Settings —
      // every restart would flip it right back to every_3_days).
      const mode = rawMode === 'every_7_days' ? 'every_3_days' : rawMode;
      if (mode !== rawMode) {
        await invoke('set_preference', { key: 'HashUpdateMode', value: 'every_3_days' }).catch(() => {});
      }

      // "never" — skip the network entirely.
      if (mode === 'never') {
        setHashSyncBusy(false);
        return;
      }

      // "every_3_days" — skip the fingerprint check itself if we've
      // already pinged the API within the past 3 days. Saves a network
      // round-trip on busy users who relaunch Jade often.
      if (mode === 'every_3_days') {
        const lastCheckedStr = await invoke<string>('get_preference', {
          key: 'LastHashCheckAt',
          defaultValue: '0'
        }).catch(() => '0');
        const lastChecked = parseInt(lastCheckedStr, 10) || 0;
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        if ((Date.now() - lastChecked) < threeDaysMs) {
          setHashSyncBusy(false);
          return;
        }
      }

      setHashSyncBusy(true);

      showHashToast({
        visible: true,
        status: 'checking',
        message: 'Checking hash fingerprint...'
      });

      allowHashStatusUpdateRef.current = false; // Block hash preload updates during download
      setStatusMessage('Comparing hash fingerprint...');
      statusMessageRef.current = 'Comparing hash fingerprint...';
      try {
        // Fingerprint round-trip: ask the backend for the latest GitHub
        // release tag and compare it to what we have stored locally.
        // Falls back gracefully when the LMDB layout isn't on disk yet —
        // in that case `up_to_date` is false and we trigger the full
        // combined.zst download below.
        const fp = await invoke<{
          up_to_date: boolean;
          current_tag: string;
          latest_tag: string;
          layout_present: boolean;
        }>('wad_check_for_hash_update').catch(() => null);

        if (fp && fp.up_to_date) {
          // LMDB unchanged — but text hashes update independently
          // (CDragon mirror, no shared release tag), so check those
          // too. `download_hashes` does its own per-file ETag /
          // Last-Modified probes; cheap when nothing changed (~5
          // parallel HEADs), only fetches files that actually moved.
          const textChanged = await runTextHashRefresh();
          showHashToast({
            visible: true,
            status: 'success',
            message: textChanged
              ? `Text hashes refreshed (LMDB at ${fp.current_tag}).`
              : `Hashes are up to date (${fp.current_tag}).`
          });
          if (hashToastHideTimeoutRef.current) clearTimeout(hashToastHideTimeoutRef.current);
          hashToastHideTimeoutRef.current = setTimeout(() => {
            setHashSyncToast((prev) => prev ? { ...prev, visible: false } : prev);
          }, 4200);
          setStatusMessage('Hashes ready');
          statusMessageRef.current = 'Hashes ready';
          setHashSyncBusy(false);
          await invoke('set_preference', { key: 'LastHashCheckAt', value: String(Date.now()) }).catch(() => {});
          setTimeout(() => { allowHashStatusUpdateRef.current = true; }, 500);
          return;
        }

        // Update available. Defer the download whenever a file-open is
        // in flight — even when no LMDB layout is on disk yet. The
        // user might be offline or unable to reach GitHub; in that
        // case forcing a download here would block the file from
        // opening at all, and they'd rather have a partly-hashed file
        // they can read than a hung launch. The deferred download
        // still kicks once the BIN has loaded, so when the network
        // *is* available the second open will be fully resolved.
        const mustDownloadNow = !pendingFileOpenRef.current;
        if (mustDownloadNow) {
          await runHashDownload(fp?.layout_present ? fp.latest_tag : '');
        } else {
          // Defer — let the file open complete first.
          const latestTag = fp?.latest_tag ?? '';
          showHashToast({
            visible: true,
            status: 'success',
            message: latestTag
              ? `Update ${latestTag} queued — will download after the file finishes loading.`
              : 'Hash download queued — will run after the file finishes loading.'
          });
          if (hashToastHideTimeoutRef.current) clearTimeout(hashToastHideTimeoutRef.current);
          hashToastHideTimeoutRef.current = setTimeout(() => {
            setHashSyncToast((prev) => prev ? { ...prev, visible: false } : prev);
          }, 4200);
          setPendingHashDownload({ latestTag });
          setStatusMessage('Hashes ready');
          statusMessageRef.current = 'Hashes ready';
          setHashSyncBusy(false);
          // Don't stamp LastHashCheckAt — we want the deferred download
          // to actually run, and re-firing the fingerprint check on the
          // *next* launch is harmless if it doesn't.
          setTimeout(() => { allowHashStatusUpdateRef.current = true; }, 500);
        }
      } catch (error) {
        console.error('[App] Failed to auto-download hashes:', error);
        showHashToast({
          visible: true,
          status: 'error',
          message: `Hash update failed: ${String(error)}`
        });
        setHashSyncBusy(false);
        setStatusMessage('Ready');
        statusMessageRef.current = 'Ready';
        allowHashStatusUpdateRef.current = true;
      }
    } catch (error) {
      console.error('[App] Failed to auto-download hashes:', error);
      showHashToast({
        visible: true,
        status: 'error',
        message: `Hash update failed: ${String(error)}`
      });
      setHashSyncBusy(false);
      allowHashStatusUpdateRef.current = true;
    }
  };

  // Smart-skip text-hash refresh. Runs the per-file ETag /
  // Last-Modified probe pipeline; only files that actually moved
  // get re-fetched. Returns `true` if anything was downloaded
  // (caller can stamp the message accordingly + reload BIN hashes).
  const runTextHashRefresh = async (): Promise<boolean> => {
    try {
      const downloaded = await invoke<string[]>('download_hashes');
      if (Array.isArray(downloaded) && downloaded.length > 0) {
        // New text files on disk — refresh the in-RAM BIN table so
        // the next conversion sees the new entries without an app
        // restart. Background; conversions are still gated on
        // `are_bin_hashes_ready` so a half-loaded table won't be
        // used while the swap is in flight.
        invoke('reload_bin_hashes').catch(() => {});
        return true;
      }
    } catch (e) {
      console.warn('[App] Text hash refresh failed (non-fatal):', e);
    }
    return false;
  };

  // Actually run the LMDB download + post-update bookkeeping. Split out
  // of `autoDownloadHashesOnStartup` so the deferred path (after a
  // file-open completes) can call it without re-running the fingerprint
  // check.
  const runHashDownload = async (latestTag: string) => {
    allowHashStatusUpdateRef.current = false;
    setHashSyncBusy(true);
    showHashToast({
      visible: true,
      status: 'downloading',
      message: latestTag ? `New release ${latestTag} — downloading...` : 'Downloading combined LMDB hashes...'
    });
    try {
      // Run both hash downloads in parallel:
      //   - LMDB (combined.zst) for WAD path resolution
      //   - text files (CDragon mirror) for BIN field/class names
      // Each command is independently smart-skip-friendly except
      // we force LMDB (the fingerprint check already told us it's
      // stale) and let text use its own per-file ETag/Last-Modified
      // probes (cheap when nothing changed).
      await Promise.all([
        invoke('wad_download_hashes', { force: true }),
        invoke('download_hashes').catch((e) =>
          console.warn('[App] Text hash refresh failed (non-fatal):', e),
        ),
      ]);
      showHashToast({
        visible: true,
        status: 'success',
        message: 'Hashes updated.'
      });
      if (hashToastHideTimeoutRef.current) clearTimeout(hashToastHideTimeoutRef.current);
      hashToastHideTimeoutRef.current = setTimeout(() => {
        setHashSyncToast((prev) => prev ? { ...prev, visible: false } : prev);
      }, 4200);
      setStatusMessage('Hashes ready');
      statusMessageRef.current = 'Hashes ready';
      // Reload BIN hashes from disk so the in-RAM table picks up
      // anything that just changed. Background — no need to block.
      invoke('reload_bin_hashes').catch(() => {});
      await invoke('set_preference', { key: 'LastHashCheckAt', value: String(Date.now()) }).catch(() => {});
    } catch (error) {
      console.error('[App] Hash download failed:', error);
      showHashToast({
        visible: true,
        status: 'error',
        message: `Hash update failed: ${String(error)}`
      });
    } finally {
      setHashSyncBusy(false);
      setTimeout(() => { allowHashStatusUpdateRef.current = true; }, 500);
    }
  };

  // Run any deferred hash download once the BIN that triggered the
  // pending state has fully landed. We require both `!fileLoading`
  // (parser done) and at least one tab (something rendered) so the
  // converter has already produced output before the LMDB swap fires.
  // Without this gate the LMDB rename can land mid-conversion and the
  // file ends up with hex names.
  useEffect(() => {
    if (!pendingHashDownload) return;
    if (fileLoading) return;
    if (tabs.length === 0) return;
    // Decouple slightly so React commits the post-load state first —
    // makes the toast transition cleaner and avoids re-entrancy if the
    // download triggers further state churn.
    const t = setTimeout(() => {
      runHashDownload(pendingHashDownload.latestTag);
      setPendingHashDownload(null);
      pendingFileOpenRef.current = false;
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHashDownload, fileLoading, tabs.length]);

  // Hash preload is gone — LMDB lookups are fast enough that draining
  // the table into RAM at startup gave a memory spike with no perceived
  // speedup. The legacy text engine still loads on first BIN open
  // (~1–3 s); the LMDB engine pays microseconds per lookup.

  // Recent files management
  const loadRecentFiles = async () => {
    try {
      const recent = await invoke<string[]>('get_recent_files');
      setRecentFiles(recent);
    } catch (e) {
      console.error("Failed to load recent files:", e);
      setRecentFiles([]);
    }
  };

  const addToRecentFiles = async (filePath: string) => {
    try {
      const updated = await invoke<string[]>('add_recent_file', { path: filePath });
      setRecentFiles(updated);
    } catch (e) {
      console.error("Failed to add to recent files:", e);
    }
  };

  const normalizeQuartzMode = (mode: string | null | undefined): 'paint' | 'port' | 'bineditor' | 'vfxhub' => {
    const normalized = String(mode || 'paint').toLowerCase();
    if (normalized === 'port') return 'port';
    if (normalized === 'bineditor') return 'bineditor';
    if (normalized === 'vfxhub') return 'vfxhub';
    return 'paint';
  };

  const ensureTrackedBinSession = useCallback((filePath: string, snapshotContent: string, mode: 'paint' | 'port' | 'bineditor' | 'vfxhub' = 'paint') => {
    try {
      if (!filePath || !filePath.toLowerCase().endsWith('.bin')) return;
      const key = filePath.toLowerCase();
      const existing = quartzSessionsRef.current.get(key);
      if (existing) {
        const effectiveMode = (mode === 'paint' && existing.mode && existing.mode !== 'paint')
          ? existing.mode
          : mode;
        quartzSessionsRef.current.set(key, {
          ...existing,
          mode: effectiveMode,
          snapshotContent,
          pendingEntryId: null,
          forceContentCheck: false,
        });
        invoke<number>('get_file_mtime', { path: filePath })
          .then((mtime) => {
            const latest = quartzSessionsRef.current.get(key);
            if (!latest) return;
            quartzSessionsRef.current.set(key, {
              ...latest,
              lastSeenMtime: mtime ?? latest.lastSeenMtime,
            });
            if (QUARTZ_INTEROP_DEBUG) {
              console.log('[QuartzInterop][Jade] Refreshed existing session', { filePath, mode: effectiveMode, mtime });
            }
          })
          .catch(() => { });
        return;
      }

      invoke<number>('get_file_mtime', { path: filePath })
        .then((mtime) => {
          quartzSessionsRef.current.set(key, {
            filePath,
            mode,
            snapshotContent,
            lastSeenMtime: mtime ?? null,
            pendingEntryId: null,
            forceContentCheck: false,
          });
          if (QUARTZ_INTEROP_DEBUG) {
            console.log('[QuartzInterop][Jade] Created session', { filePath, mode, mtime });
          }
        })
        .catch(() => {
          quartzSessionsRef.current.set(key, {
            filePath,
            mode,
            snapshotContent,
            lastSeenMtime: null,
            pendingEntryId: null,
            forceContentCheck: false,
          });
          if (QUARTZ_INTEROP_DEBUG) {
            console.log('[QuartzInterop][Jade] Created session without mtime', { filePath, mode });
          }
        });
    } catch {
      // keep editor flow resilient; watcher registration is best-effort.
    }
  }, []);

  const getUseQuartzPyWorkflowPreference = useCallback(async (): Promise<boolean> => {
    try {
      const value = await invoke<string>('get_preference', {
        key: 'UseQuartzPyWorkflow',
        defaultValue: 'False'
      });
      return value === 'True';
    } catch {
      return false;
    }
  }, []);

  const getPySidecarPath = useCallback((binPath: string): string => {
    if (binPath.toLowerCase().endsWith('.bin')) {
      return `${binPath.slice(0, -4)}.py`;
    }
    return `${binPath}.py`;
  }, []);

  const readBinForEditor = useCallback(async (binPath: string, fallbackContent?: string): Promise<string> => {
    const usePyWorkflow = await getUseQuartzPyWorkflowPreference();
    if (!usePyWorkflow) {
      return fallbackContent ?? readBinDirect(binPath);
    }

    const pySidecarPath = getPySidecarPath(binPath);
    const pyExists = await invoke<boolean>('file_exists', { path: pySidecarPath }).catch(() => false);
    if (pyExists) {
      return invoke<string>('read_text_file', { path: pySidecarPath });
    }

    const content = fallbackContent ?? await readBinDirect(binPath);
    await invoke('write_text_file', { path: pySidecarPath, content }).catch(() => { });
    return content;
  }, [getPySidecarPath, getUseQuartzPyWorkflowPreference]);

  // Quartz interop must be robust even if user preferences differ:
  // resolve content from the freshest source between .bin and .py sidecar.
  const readBinForQuartzInterop = useCallback(async (binPath: string, fallbackContent?: string): Promise<string> => {
    const pySidecarPath = getPySidecarPath(binPath);
    const pyExists = await invoke<boolean>('file_exists', { path: pySidecarPath }).catch(() => false);
    if (!pyExists) {
      const content = fallbackContent ?? await readBinDirect(binPath);
      await invoke('write_text_file', { path: pySidecarPath, content }).catch(() => { });
      return content;
    }

    const [binMtime, pyMtime] = await Promise.all([
      invoke<number>('get_file_mtime', { path: binPath }).catch(() => 0),
      invoke<number>('get_file_mtime', { path: pySidecarPath }).catch(() => 0),
    ]);

    // If bin is newer (or equal) treat bin as source of truth and refresh sidecar.
    if ((binMtime ?? 0) >= (pyMtime ?? 0)) {
      const content = fallbackContent ?? await readBinDirect(binPath);
      await invoke('write_text_file', { path: pySidecarPath, content }).catch(() => { });
      return content;
    }

    // Sidecar newer than bin: use sidecar.
    return invoke<string>('read_text_file', { path: pySidecarPath });
  }, [getPySidecarPath]);

  const persistPySidecarForQuartzInterop = useCallback(async (binPath: string, content: string): Promise<void> => {
    const pySidecarPath = getPySidecarPath(binPath);
    await invoke('write_text_file', { path: pySidecarPath, content }).catch(() => { });
  }, [getPySidecarPath]);

  const persistPySidecarIfNeeded = useCallback(async (binPath: string, content: string): Promise<void> => {
    const usePyWorkflow = await getUseQuartzPyWorkflowPreference();
    if (!usePyWorkflow) return;

    const pySidecarPath = getPySidecarPath(binPath);
    await invoke('write_text_file', { path: pySidecarPath, content });
  }, [getPySidecarPath, getUseQuartzPyWorkflowPreference]);

  const updateTabContentFromExternal = useCallback((tabId: string, nextContent: string) => {
    const isActiveTab = activeTabIdRef.current === tabId;
    const editor = editorRef.current;
    const savedViewState = (isActiveTab && editor) ? editor.saveViewState() : null;

    const model = monacoModelsRef.current.get(tabId);
    if (model && !model.isDisposed()) {
      model.setValue(nextContent);
    } else if (activeTabIdRef.current === tabId && editorRef.current) {
      const activeModel = editorRef.current.getModel();
      if (activeModel) {
        activeModel.setValue(nextContent);
      }
    }

    // Preserve scroll/cursor when external updates rewrite active tab content.
    if (isActiveTab && editor && savedViewState) {
      try {
        editor.restoreViewState(savedViewState);
      } catch {
        // best effort only
      }
    }

    setTabs(prevTabs => prevTabs.map(t =>
      t.id === tabId ? { ...t, content: nextContent, isModified: false } : t
    ));

    if (activeTabIdRef.current === tabId && editorRef.current?.getModel()) {
      setLineCount(editorRef.current.getModel()!.getLineCount());
    }
  }, []);

  const openFileFromPath = async (filePath: string) => {
    // `.studio.json` scene files go to the Photo Studio loader, not
    // the text editor — route them out before the normal pipeline.
    if (isStudioScenePath(filePath)) {
      await studioOpenSceneFromPathRef.current?.(filePath);
      return;
    }
    // Legacy `.troybin` / `.inibin` files get converted to a
    // modern BIN on the fly — drag-drop / File→Open / argv all funnel
    // here, the Rust pipeline writes a `<stem>.bin` sibling, and we
    // recurse with the produced BIN path so the user lands on the
    // editable BIN immediately. No intermediate tab or prompt.
    const lowerExt = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
    if (lowerExt === '.troybin' || lowerExt === '.inibin') {
      const normalised = filePath.toLowerCase();
      console.log('[troybin] open requested:', filePath);
      // OS / Tauri sometimes fires the drag-drop event twice for a
      // single drop — without this guard we'd convert the same file
      // back-to-back.
      if (openingFilesRef.current.has(normalised)) {
        console.log('[troybin] already opening, skipping duplicate');
        return;
      }
      openingFilesRef.current.add(normalised);
      try {
        setStatusMessage(`Converting ${getFileName(filePath)}…`);
        const r = await invoke<{ output_path: string }>('troybin_convert_to_bin', { path: filePath });
        console.log('[troybin] converted to:', r.output_path);
        openingFilesRef.current.delete(normalised);
        // Hand the produced BIN back through the normal open path —
        // routes through the BIN editor, marks the file recent, etc.
        await openFileFromPath(r.output_path);
      } catch (err) {
        openingFilesRef.current.delete(normalised);
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[troybin] convert failed:', err);
        setStatusMessage(`Convert troybin failed: ${msg}`);
      }
      return;
    }
    // Image / texture files → dedicated texture-preview tab so the
    // user gets the in-app viewer (and the Edit-in-image-editor +
    // Reveal-in-Explorer buttons that go with it). Without this, an
    // explorer double-click on a .tex would try to load it as text
    // and dump binary garbage into Monaco.
    const ext = lowerExt.replace(/^\./, '');
    if (ext === 'tex' || ext === 'dds' || ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'bmp' || ext === 'webp' || ext === 'gif') {
      const existingTex = tabs.find(t => t.filePath === filePath && t.tabType === 'texture-preview');
      if (existingTex) {
        setActiveTabId(existingTex.id);
        setWelcomeOverride('hide');
        return;
      }
      saveCurrentViewState();
      const texTab = createTexPreviewTab(filePath);
      setTabs(prev => [...prev, texTab]);
      setActiveTabId(texTab.id);
      setWelcomeOverride('hide');
      loadTextureIntoTab(texTab.id, filePath);
      addToRecentFiles(filePath).catch(() => {});
      return;
    }
    // 3D-asset family → a fresh Photo Studio tab with the disk path
    // queued for `addModelFromDisk`. Mirrors the Viewer's
    // send-to-Studio handoff, minus the WAD extraction step.
    if (ext === 'skn' || ext === 'skl' || ext === 'sco' || ext === 'scb' || ext === 'anm') {
      saveCurrentViewState();
      ensureStudioShell();
      const newTab = createStudioTab();
      pendingStudioModelLoadsRef.current.set(newTab.id, filePath);
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
      setStudioAnimOpen(true);
      setStudioBgOpen(true);
      setStudioActionsOpen(true);
      setStudioMeshOpen(true);
      setStudioObjectsOpen(true);
      setWelcomeOverride('hide');
      setStatusMessage(`Loading ${getFileName(filePath)} in Photo Studio…`);
      addToRecentFiles(filePath).catch(() => {});
      return;
    }
    // Prevent duplicate concurrent opens (e.g. Tauri drag-drop firing twice,
    // or rapid re-drops of the same file before the first open completes).
    const normalizedPath = filePath.toLowerCase();
    if (openingFilesRef.current.has(normalizedPath)) return;
    openingFilesRef.current.add(normalizedPath);
    // Drop any active welcome override before touching loading state —
    // otherwise reopening an already-open tab from the welcome screen
    // (Main page → Recent → same file) leaves `welcomeOverride='force'`
    // intact, and the brief fileLoading flicker triggers a close/open
    // animation glitch instead of cleanly handing back to the editor.
    setWelcomeOverride(null);
    const fileName = getFileName(filePath);
    setFileLoading({ name: fileName });
    try {
      // Block hash status updates while opening file
      allowHashStatusUpdateRef.current = false;
      setStatusMessage(`Opening ${fileName}...`);
      statusMessageRef.current = `Opening ${fileName}...`;

      const existingTab = tabs.find(t => t.filePath && t.filePath.toLowerCase() === filePath.toLowerCase());
      if (existingTab) {
        ensureTrackedBinSession(filePath, existingTab.content, 'paint');
        setActiveTabId(existingTab.id);
        setStatusMessage(`Switched to ${fileName}`);
        statusMessageRef.current = `Switched to ${fileName}`;
        // Re-enable hash status updates after a delay
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 2000);
        return;
      }

      const isBin = isBinLikePath(filePath);
      const content = isBin
        ? await readBinForEditor(filePath)
        : await readTextDirect(filePath);
      setFileLoading({ name: fileName, detail: 'Rendering editor…' });
      const newTab = createTab(filePath, content);
      // Store initial mtime so the auto-reload poller doesn't fire immediately
      invoke<number>('get_file_mtime', { path: filePath })
        .then(mtime => editorMtimeRef.current.set(newTab.id, mtime))
        .catch(() => {});
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);

      await addToRecentFiles(filePath);
      setStatusMessage(`Opened ${fileName}`);
      statusMessageRef.current = `Opened ${fileName}`;

      await openLinkedBinFiles(filePath, content);

      // Re-enable hash status updates after file is opened (with delay to show the message)
      setTimeout(() => {
        allowHashStatusUpdateRef.current = true;
      }, 2000);
    } catch (error) {
      console.error("Failed to open file:", error);
      setStatusMessage(`Failed to open file: ${error}`);
      statusMessageRef.current = `Failed to open file: ${error}`;
      // Re-enable hash status updates after error
      setTimeout(() => {
        allowHashStatusUpdateRef.current = true;
      }, 2000);
    } finally {
      openingFilesRef.current.delete(normalizedPath);
      // Give Monaco a tick to commit the new model paint before clearing
      // the overlay, so big files don't show a flash of empty editor.
      requestAnimationFrame(() => setFileLoading(null));
    }
  };
  // Keep the ref up-to-date every render so event listeners always call the
  // latest version (which has fresh `tabs` in its closure).
  openFileFromPathRef.current = openFileFromPath;


  // Save current editor view state before switching tabs
  // Note: content sync is no longer needed since Monaco models handle content
  const saveCurrentViewState = useCallback(() => {
    if (editorRef.current && activeTabId) {
      const viewState = editorRef.current.saveViewState();
      viewStatesRef.current.set(activeTabId, { viewState });
    }
  }, [activeTabId]);

  // Tab operations. `setActiveTabId` itself routes to the correct
  // pane via the tab's `pane` field, so this handler is now just
  // about view-state preservation.
  // Switch the shell to Visual Studio if it isn't already. Photo
  // Studio panels are only wired into the VS shell for now, so a
  // studio tab opened under Classic / Word would render a bare
  // viewport with no controls. Auto-switching keeps the feature
  // usable until the other shells get their own panel host.
  const ensureStudioShell = useCallback(() => {
    if (shellVariantRef.current === 'visualstudio') return;
    setShellVariant('visualstudio');
    shellVariantRef.current = 'visualstudio';
    window.dispatchEvent(new CustomEvent('shell-changed', { detail: 'visualstudio' }));
    invoke('set_preference', { key: 'UiShell', value: 'visualstudio' }).catch(() => {});
  }, []);

  const handleTabSelect = useCallback((tabId: string) => {
    if (tabId === activeTabId) return;
    saveCurrentViewState();
    // Selecting a studio tab forces the VS shell — its panels are
    // the only place the studio controls live for now.
    const selected = tabsRef.current.find(t => t.id === tabId);
    if (selected?.tabType === 'studio') ensureStudioShell();
    setActiveTabId(tabId);
  }, [activeTabId, saveCurrentViewState, setActiveTabId, ensureStudioShell]);

  const handleTabClose = useCallback(async (tabId: string) => {
    const recentlyRejected = lastRejectedTabCloseRef.current;
    if (
      recentlyRejected &&
      recentlyRejected.tabId === tabId &&
      Date.now() - recentlyRejected.at < 350
    ) {
      return;
    }

    const tabToClose = tabs.find(t => t.id === tabId);
    if (!tabToClose) return;

    // Studio tabs get a save-offering prompt rather than the plain
    // "close anyway?" — composing a scene is real work and there's
    // a real file format to save it to.
    if (tabToClose.tabType === 'studio' && tabToClose.isModified) {
      const save = await askDialog(
        `Save changes to "${tabToClose.fileName}" before closing?`,
        { title: 'Unsaved studio scene', kind: 'warning' },
      );
      if (save) {
        // Make the tab active so studioSaveActiveTab targets it,
        // then save. If the user backs out of the Save As dialog
        // (save returns false), abort the close so work isn't lost.
        if (activeTabIdRef.current !== tabId) {
          setActiveTabId(tabId);
          await new Promise((r) => setTimeout(r, 0));
        }
        const saved = await studioSaveActiveTab(false);
        if (!saved) {
          lastRejectedTabCloseRef.current = { tabId, at: Date.now() };
          return;
        }
      }
      // `save === false` → discard and close. Fall through.
    } else if (tabToClose.isModified) {
      // Prompt BEFORE removing the tab. The previous code used the
      // browser's `window.confirm()`, which Tauri's webview treats as
      // non-blocking — the close proceeded and the popup appeared as a
      // useless artifact. Tauri's `ask` is a real native modal.
      const proceed = await askDialog(
        `"${tabToClose.fileName}" has unsaved changes. Close anyway?`,
        { title: 'Unsaved changes', kind: 'warning' },
      );
      if (!proceed) {
        lastRejectedTabCloseRef.current = { tabId, at: Date.now() };
        return;
      }

      // If this bin had library texture inserts during the session, the
      // user is now discarding those references. Offer to also delete
      // the texture folders we dropped into the mod so they don't
      // linger as orphan files.
      if (tabToClose.filePath) {
        const inserts = jadelibInsertsRef.current.get(tabToClose.filePath);
        if (inserts && inserts.length > 0) {
          const summary = inserts.map(e => `assets/jadelib/${e.id}/`).join('\n  ');
          const shouldDelete = await askDialog(
            `You inserted library material textures in this session:\n\n  ${summary}\n\nRemove these folders from your mod too?`,
            { title: 'Discard library inserts?', kind: 'warning' },
          );
          if (shouldDelete) {
            for (const e of inserts) {
              invoke('library_remove_inserted_textures', {
                modRoot: e.modRoot,
                id: e.id,
              }).catch((err) => {
                console.warn(`Failed to remove jadelib/${e.id}:`, err);
              });
            }
          }
          jadelibInsertsRef.current.delete(tabToClose.filePath);
        }
      }
    }

    // Remove view state and LRU entry
    viewStatesRef.current.delete(tabId);
    modelLruRef.current = modelLruRef.current.filter(id => id !== tabId);
    // Real close — now it's safe to drop the studio scene's
    // pending-load entry (kept alive across StrictMode remounts).
    if (tabToClose.tabType === 'studio') {
      pendingStudioLoadsRef.current.delete(tabId);
      pendingStudioModelLoadsRef.current.delete(tabId);
      // Wipe the borrowed-animations temp folder we created for
      // this scene (if any). Best-effort — failures are logged but
      // don't block the close.
      const borrow = borrowedAnimDirsRef.current.get(tabId);
      if (borrow) {
        borrowedAnimDirsRef.current.delete(tabId);
        invoke('cleanup_anim_borrow_dir', { borrowDir: borrow })
          .catch(e => console.warn('[anim-borrow] cleanup failed:', e));
      }
    }
    if (tabToClose.tabType === 'quartz-diff' && tabToClose.diffSourceFilePath) {
      const sourceKey = tabToClose.diffSourceFilePath.toLowerCase();
      setQuartzHistoryEntries(prev => prev.filter(entry => entry.filePath.toLowerCase() !== sourceKey));
    }
    if (tabToClose.filePath) {
      const closingFileKey = tabToClose.filePath.toLowerCase();
      quartzSessionsRef.current.delete(closingFileKey);
      setQuartzHistoryEntries(prev => prev.filter(entry => entry.filePath.toLowerCase() !== closingFileKey));
    }

    const modelToDispose = monacoModelsRef.current.get(tabId);
    let shouldDisposeModel = true;
    monacoModelsRef.current.delete(tabId);

    // Compute the next active tab now, before state updates
    const closedFileKey = tabToClose.filePath?.toLowerCase() || null;
    let newTabs = tabs.filter(t => t.id !== tabId);
    if (closedFileKey && tabToClose.tabType !== 'quartz-diff') {
      newTabs = newTabs.filter(t => !(t.tabType === 'quartz-diff' && t.diffSourceFilePath?.toLowerCase() === closedFileKey));
    }
    // Closing a markdown editor tab also closes any preview tabs that
    // were rendering its content — the source is gone, the preview has
    // nothing to show.
    if (tabToClose.tabType !== 'markdown-preview') {
      newTabs = newTabs.filter(t => !(t.tabType === 'markdown-preview' && t.sourceTabId === tabId));
    }
    // Same rule for compare tabs: if either side's source closes the
    // diff has nothing to render, so we drop the compare tab too.
    if (tabToClose.tabType !== 'compare') {
      newTabs = newTabs.filter(t => !(
        t.tabType === 'compare' &&
        (t.compareLeftTabId === tabId || t.compareRightTabId === tabId)
      ));
    }
    let nextActiveId: string | null = null;
    if (tabId === activeTabId) {
      if (newTabs.length > 0) {
        const closedIndex = tabs.findIndex(t => t.id === tabId);
        nextActiveId = newTabs[Math.min(closedIndex, newTabs.length - 1)].id;
      }
    } else {
      nextActiveId = activeTabId;
    }

    // If closing the active tab, switch the editor to the NEXT model before
    // disposing the old one. Calling setModel(null) tears down Monaco's
    // InstantiationService which crashes the editor on the next setModel call.
    if (tabId === activeTabId && editorRef.current && nextActiveId) {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (monaco) {
        let nextModel = monacoModelsRef.current.get(nextActiveId);
        const nextTab = newTabs.find(t => t.id === nextActiveId);
        if ((!nextModel || nextModel.isDisposed()) && nextTab) {
          const uri = nextTab.filePath
            ? monaco.Uri.file(nextTab.filePath)
            : monaco.Uri.parse(`inmemory://tab/${nextActiveId}`);
          const existing = monaco.editor.getModel(uri);
          nextModel = (existing && !existing.isDisposed())
            ? existing
            : monaco.editor.createModel(nextTab.content, getMonacoLanguageForPath(nextTab.filePath ?? nextTab.fileName), uri);
          monacoModelsRef.current.set(nextActiveId, nextModel!);
        }
        if (nextModel) {
          try { editor.setModel(nextModel); } catch (_) { }
        }
      }
    }

    // If the model being closed is still attached to the editor while a non-editor
    // tab is active, move the editor to another editor tab model if possible.
    if (modelToDispose && editorRef.current?.getModel() === modelToDispose) {
      const monaco = monacoRef.current;
      const fallbackEditorTab = newTabs.find(isEditorTab);
      if (monaco && fallbackEditorTab) {
        let fallbackModel = monacoModelsRef.current.get(fallbackEditorTab.id);
        if (!fallbackModel || fallbackModel.isDisposed()) {
          const uri = fallbackEditorTab.filePath
            ? monaco.Uri.file(fallbackEditorTab.filePath)
            : monaco.Uri.parse(`inmemory://tab/${fallbackEditorTab.id}`);
          const existing = monaco.editor.getModel(uri);
          fallbackModel = (existing && !existing.isDisposed())
            ? existing
            : monaco.editor.createModel(fallbackEditorTab.content, getMonacoLanguageForPath(fallbackEditorTab.filePath ?? fallbackEditorTab.fileName), uri);
        }
        if (fallbackModel) {
          monacoModelsRef.current.set(fallbackEditorTab.id, fallbackModel);
          try { editorRef.current.setModel(fallbackModel); } catch (_) { }
        } else {
          shouldDisposeModel = false;
        }
      } else {
        shouldDisposeModel = false;
      }
    }

    // Dispose the old model after a delay so Monaco's RAF-based render pipeline
    // can finish all queued frames before the model is torn down.
    if (shouldDisposeModel && modelToDispose && !modelToDispose.isDisposed()) {
      setTimeout(() => {
        try { modelToDispose.dispose(); } catch (_) { }
      }, 500);
    }

    setTabs(newTabs);
    if (tabId === activeTabId) {
      setActiveTabId(nextActiveId);
    }
  }, [tabs, activeTabId]);
  handleTabCloseRef.current = handleTabClose;

  const handleTabCloseAll = useCallback(async () => {
    const hasModified = tabs.some(t => t.isModified);
    if (hasModified) {
      const proceed = await askDialog(
        'Some tabs have unsaved changes. Close all anyway?',
        { title: 'Unsaved changes', kind: 'warning' },
      );
      if (!proceed) return;
    }

    viewStatesRef.current.clear();
    modelLruRef.current = [];
    quartzSessionsRef.current.clear();
    setQuartzHistoryEntries([]);

    // Collect models for delayed disposal, then clear the map immediately so
    // no further renders reference them.  The 500ms delay lets Monaco's
    // RAF-based render pipeline drain before we tear down the models.
    const modelsToDispose = Array.from(monacoModelsRef.current.values());
    monacoModelsRef.current.clear();
    setTimeout(() => {
      modelsToDispose.forEach((model) => {
        if (!model.isDisposed()) {
          try { model.dispose(); } catch (_) { }
        }
      });
    }, 500);

    setTabs([]);
    setActiveTabId(null);
  }, [tabs]);

  const handleTabPin = useCallback((tabId: string) => {
    setTabs(prevTabs =>
      prevTabs.map(t =>
        t.id === tabId ? { ...t, isPinned: !t.isPinned } : t
      )
    );
  }, []);


  // Add a new tab
  const addTab = useCallback((filePath: string | null, content: string): EditorTab => {
    // Check if file is already open
    if (filePath) {
      const existingTab = tabs.find(t => t.filePath === filePath);
      if (existingTab) {
        ensureTrackedBinSession(filePath, existingTab.content || content, 'paint');
        setActiveTabId(existingTab.id);
        return existingTab;
      }
    }

    const newTab = createTab(filePath, content);
    saveCurrentViewState();
    setTabs(prevTabs => [...prevTabs, newTab]);
    setActiveTabId(newTab.id);
    if (filePath) {
      ensureTrackedBinSession(filePath, content, 'paint');
    }
    return newTab;
  }, [tabs, saveCurrentViewState, ensureTrackedBinSession]);

  /** Batch-add multiple files as tabs in a single React commit
   *  WITHOUT activating any of them. Used by the linked-BIN auto-open
   *  flow so loading a parent BIN with 30 dependencies doesn't fire
   *  30 separate `setActiveTabId` calls (each one swaps the Monaco
   *  model — that's the real source of the multi-open lag). The user
   *  stays on whatever tab they explicitly opened. De-duplicates
   *  against already-open files by path. */
  const addTabsBatch = useCallback((files: { filePath: string; content: string }[]): EditorTab[] => {
    if (files.length === 0) return [];
    // Filter out paths that are already open. Compare current `tabs`
    // PLUS the running new-tab list so two passes of the same path
    // in `files` don't create duplicates either.
    const openPaths = new Set(tabs.map(t => t.filePath).filter((p): p is string => !!p));
    const fresh: EditorTab[] = [];
    for (const f of files) {
      if (openPaths.has(f.filePath)) continue;
      openPaths.add(f.filePath);
      fresh.push(createTab(f.filePath, f.content));
    }
    if (fresh.length === 0) return [];
    setTabs(prevTabs => [...prevTabs, ...fresh]);
    for (const t of fresh) {
      if (t.filePath) ensureTrackedBinSession(t.filePath, t.content, 'paint');
    }
    return fresh;
  }, [tabs, ensureTrackedBinSession]);

  // Monaco handlers
  function handleBeforeMount(monaco: Monaco) {
    registerRitobinLanguage(monaco);
    registerRitobinTheme(monaco);
    monacoRef.current = monaco;
    setMonacoInstance(monaco);
    loadSavedTheme(invoke, monaco).then(() => setEditorTheme('jade-dynamic'));

    // Register color swatches + picker for vec4 inside Color/birthColor blocks
    registerColorProvider(monaco);

    // Register quick-fix provider for syntax errors (e.g. "lin" → "link")
    monaco.languages.registerCodeActionProvider(RITOBIN_LANGUAGE_ID, {
      provideCodeActions(model: MonacoType.editor.ITextModel, _range: MonacoType.Range, context: MonacoType.languages.CodeActionContext) {
        const actions: MonacoType.languages.CodeAction[] = [];
        for (const marker of context.markers) {
          // Match "Unknown type" errors from our syntax checker
          const unknownMatch = marker.message.match(/^Unknown (?:(?:key |value )?type )"(.+?)"/);
          if (!unknownMatch) continue;
          const badType = unknownMatch[1];
          const suggestion = suggestType(badType);
          if (!suggestion) continue;

          actions.push({
            title: `Change to "${suggestion}"`,
            kind: 'quickfix',
            diagnostics: [marker],
            isPreferred: true,
            edit: {
              edits: [{
                resource: model.uri,
                textEdit: {
                  range: {
                    startLineNumber: marker.startLineNumber,
                    startColumn: marker.startColumn,
                    endLineNumber: marker.endLineNumber,
                    endColumn: marker.endColumn,
                  },
                  text: suggestion,
                },
                versionId: model.getVersionId(),
              }],
            },
          });
        }
        return { actions, dispose() {} };
      },
    });
  }

  // Model-based tab switching: swap the LEFT editor's Monaco model
  // when the LEFT pane's active tab changes. Per-pane: this effect
  // targets `editorRef.current` which always points at the LEFT
  // editor; the RIGHT editor (when split is on) has its own model-
  // swap effect inside its component, keyed on `rightActiveTabId`.
  // Using `leftActiveTabId` rather than the derived `activeTabId`
  // avoids the left editor flipping its model whenever the user
  // simply focuses the right pane.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    // Local alias so the rest of the (long) effect body stays as
    // close to the pre-split form as possible — the substitution is
    // a no-op when split is off, since leftActiveTabId === activeTabId.
    const activeTabId = leftActiveTabId;
    if (!editor || !monaco || !activeTabId) return;

    // Guard: bail out if the editor's DOM container is gone (disposed / unmounted)
    if (!editor.getContainerDomNode()) return;

    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab) return;

    // Texture-preview tabs don't have a Monaco model â€” skip model switching
    if (!isEditorTab(activeTab)) return;

    // Save view state of current model before switching
    const currentModel = editor.getModel();
    if (currentModel) {
      // Find which tab owns the current model
      monacoModelsRef.current.forEach((model, tabId) => {
        if (model === currentModel && tabId !== activeTabId) {
          const vs = editor.saveViewState();
          viewStatesRef.current.set(tabId, { viewState: vs });
        }
      });
    }

    // Get or create the Monaco model for this tab
    let model = monacoModelsRef.current.get(activeTabId);
    if (!model || model.isDisposed()) {
      // Create a new model with a unique URI
      const uri = activeTab.filePath
        ? monaco.Uri.file(activeTab.filePath)
        : monaco.Uri.parse(`inmemory://tab/${activeTabId}`);

      // Dispose any orphaned model with this URI (e.g. from a previously closed
      // tab whose delayed 500ms disposal hasn't fired yet). Without this, reopening
      // the same file would pick up the stale model with old edits instead of fresh
      // content from disk.
      const existing = monaco.editor.getModel(uri);
      if (existing && !existing.isDisposed()) {
        let isTracked = false;
        monacoModelsRef.current.forEach((m) => { if (m === existing) isTracked = true; });
        if (!isTracked) {
          try { existing.dispose(); } catch (_) { }
        }
      }

      model = monaco.editor.createModel(activeTab.content, getMonacoLanguageForPath(activeTab.filePath ?? activeTab.fileName), uri);
      monacoModelsRef.current.set(activeTabId, model!);
    }

    // LRU eviction: mark this tab as most-recently used, evict oldest if over limit
    modelLruRef.current = modelLruRef.current.filter(id => id !== activeTabId);
    modelLruRef.current.push(activeTabId);
    while (modelLruRef.current.length > MODEL_CACHE_LIMIT) {
      const evictId = modelLruRef.current.shift()!;
      const evictModel = monacoModelsRef.current.get(evictId);
      if (evictModel && !evictModel.isDisposed()) {
        // Save the current text back to the tab so it reloads correctly
        const evictTab = tabs.find(t => t.id === evictId);
        if (evictTab) {
          evictTab.content = evictModel.getValue();
        }
        // Delay disposal so Monaco's RAF-based render pipeline can finish all
        // queued frames.  100ms was too short on busy systems; 500ms gives plenty
        // of headroom.  Also guard against the model being re-mapped before the
        // timeout fires (e.g. rapid tab switching back to an evicted tab).
        const modelRef = evictModel;
        setTimeout(() => {
          let isStillMapped = false;
          monacoModelsRef.current.forEach((m) => { if (m === modelRef) isStillMapped = true; });
          if (!isStillMapped && !modelRef.isDisposed()) {
            try { modelRef.dispose(); } catch (_) { }
          }
        }, 500);
      }
      monacoModelsRef.current.delete(evictId);
      viewStatesRef.current.delete(evictId);
    }

    // Set the model on the editor (this is the key operation - no remount!)
    try {
      editor.setModel(model ?? null);
    } catch (e) {
      console.warn('[tab-switch] setModel failed, editor may be mid-dispose:', e);
      return;
    }

    // Restore view state for this tab
    const savedState = viewStatesRef.current.get(activeTabId);
    if (savedState?.viewState) {
      try { editor.restoreViewState(savedState.viewState); } catch (_) { }
    } else {
      // New tab - scroll to top
      try { editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 }); } catch (_) { }
    }

    try { editor.focus(); } catch (_) { }

    // Update line count
    try { setLineCount(model!.getLineCount()); } catch (_) { }

    // Update emitter name decorations for this model
    updateEmitterNameDecorations(editor);
    // Run syntax checker for this model
    updateSyntaxMarkers(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftActiveTabId]); // Left editor only re-mounts on left-pane tab changes

  const handleThemeApplied = () => {
    if (monacoInstance) {
      loadSavedTheme(invoke, monacoInstance).then(() => setEditorTheme('jade-dynamic'));
    }
  };

  // â”€â”€ Texture hover helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Given a line of text and a column (1-based), extract a .tex path if the
   * cursor is inside a quoted string that ends with ".tex".
   */
  const IMAGE_EXTENSIONS = ['.tex', '.dds', '.png', '.jpg', '.jpeg', '.tga', '.bmp'];

  /** Find an image path on this line at the given column. Hitbox is the full quoted region (inclusive of quotes). */
  function extractImagePathAtColumn(line: string, column: number): { path: string; startCol: number } | null {
    let i = 0;
    while (i < line.length) {
      const qStart = line.indexOf('"', i);
      if (qStart === -1) break;
      const qEnd = line.indexOf('"', qStart + 1);
      if (qEnd === -1) break;

      const candidate = line.slice(qStart + 1, qEnd);
      const lower = candidate.toLowerCase();
      if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
        // Hitbox: opening " to closing " inclusive (1-based columns)
        const hitStart = qStart + 1;
        const hitEnd = qEnd + 2; // 1-based column AFTER closing "
        if (column >= hitStart && column < hitEnd) {
          return { path: candidate, startCol: qStart + 1 };
        }
      }

      i = qEnd + 1;
    }
    return null;
  }

  /**
   * Find material links and StaticMaterialDef entries, and decorate each
   * with a clickable arrow that jumps between them.
   *
   *   material: link = "name"        → ↗ jumps down to the StaticMaterialDef
   *   "name" = StaticMaterialDef {   → ↖ jumps up to the first override
   *
   * The target line is encoded in a CSS class suffix (`jade-jump-to-<line>`)
   * so the click handler doesn't need to re-scan the document.
   */
  function findMaterialJumpDecorations(model: MonacoType.editor.ITextModel): MonacoType.editor.IModelDeltaDecoration[] {
    const decorations: MonacoType.editor.IModelDeltaDecoration[] = [];
    const lineCount = model.getLineCount();

    // Both forms can appear when a bin gets re-saved and the toolchain
    // doesn't have the original string in its hash table:
    //   "Some/Material/Path" = StaticMaterialDef { ... }     (named)
    //   0x029ad92c            = StaticMaterialDef { ... }    (hashed)
    //   Material: link = "Some/Material/Path"
    //   Material: link = 0x029ad92c
    // Bin hashing is deterministic, so a hashed link points at a def with
    // the same hex within the same file. Index both kinds under one
    // keyspace ("s:<name>" or "h:<lowercase-hex>") so either side can be
    // hashed or named without losing the match.
    const defByKey = new Map<string, number>();
    const linksByKey = new Map<string, number[]>();
    const defLineRe = /^\s*(?:"([^"]+)"|(0x[0-9a-fA-F]+))\s*=\s*StaticMaterialDef\s*\{/i;
    const linkLineRe = /material\s*:\s*link\s*=\s*(?:"([^"]+)"|(0x[0-9a-fA-F]+))/i;

    const keyOf = (named: string | undefined, hex: string | undefined): string | null => {
      if (named) return 's:' + named;
      if (hex) return 'h:' + hex.toLowerCase();
      return null;
    };

    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);
      const dm = defLineRe.exec(line);
      if (dm) {
        const key = keyOf(dm[1], dm[2]);
        if (key) defByKey.set(key, ln);
        continue;
      }
      const lm = linkLineRe.exec(line);
      if (lm) {
        const key = keyOf(lm[1], lm[2]);
        if (key) {
          const arr = linksByKey.get(key) ?? [];
          arr.push(ln);
          linksByKey.set(key, arr);
        }
      }
    }

    // Second pass: emit decorations for every link that has a matching def,
    // and every def that has at least one link.
    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);

      const lm = linkLineRe.exec(line);
      if (lm) {
        const key = keyOf(lm[1], lm[2]);
        const targetLine = key ? defByKey.get(key) : undefined;
        if (targetLine !== undefined) {
          const col = line.length + 1;
          decorations.push({
            range: { startLineNumber: ln, startColumn: Math.max(1, col - 1), endLineNumber: ln, endColumn: col },
            options: {
              after: {
                content: '\u00A0',
                inlineClassName: `jade-jump-arrow jade-jump-down jade-jump-to-${targetLine}`,
                inlineClassNameAffectsLetterSpacing: true,
              },
            },
          });
        }
      }

      const dm = defLineRe.exec(line);
      if (dm) {
        const key = keyOf(dm[1], dm[2]);
        const targets = key ? linksByKey.get(key) : undefined;
        if (targets && targets.length > 0) {
          const col = line.length + 1;
          decorations.push({
            range: { startLineNumber: ln, startColumn: Math.max(1, col - 1), endLineNumber: ln, endColumn: col },
            options: {
              after: {
                content: '\u00A0',
                inlineClassName: `jade-jump-arrow jade-jump-up jade-jump-to-${targets[0]}`,
                inlineClassNameAffectsLetterSpacing: true,
              },
            },
          });
        }
      }
    }

    return decorations;
  }

  /** Find all image paths in the model, for decorations (pointer cursor + inline swatch box) */
  function findAllImagePaths(model: MonacoType.editor.ITextModel): MonacoType.editor.IModelDeltaDecoration[] {
    const decorations: MonacoType.editor.IModelDeltaDecoration[] = [];
    const lineCount = model.getLineCount();
    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);
      let i = 0;
      while (i < line.length) {
        const qStart = line.indexOf('"', i);
        if (qStart === -1) break;
        const qEnd = line.indexOf('"', qStart + 1);
        if (qEnd === -1) break;
        const candidate = line.slice(qStart + 1, qEnd);
        const lower = candidate.toLowerCase();
        if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
          decorations.push({
            range: {
              startLineNumber: ln, startColumn: qStart + 1,
              endLineNumber: ln, endColumn: qEnd + 2,
            },
            options: {
              before: {
                content: '\u00A0',
                inlineClassName: 'image-path-swatch',
                inlineClassNameAffectsLetterSpacing: true,
              },
            },
          });
        }
        i = qEnd + 1;
      }
    }
    return decorations;
  }

  /**
   * Decode a .tex file at the given resolved path and load it into a texture tab.
   * Updates the tab state in-place once loading is complete.
   */
  // Track which texture-preview tab is currently reloading (for the spinner)
  const [reloadingTexTabId, setReloadingTexTabId] = useState<string | null>(null);
  // Per-tab last-seen mtime (seconds since epoch); used by the auto-reload poller
  const texMtimeRef = useRef<Map<string, number>>(new Map());
  // Interval handle for the file-watch poll loop
  const texPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTextureIntoTab = useCallback(async (tabId: string, resolvedPath: string, silent = false) => {
    if (!silent) setReloadingTexTabId(tabId);
    try {
      const b64: string = await invoke('read_file_base64', { path: resolvedPath });
      const binaryStr = atob(b64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      const ext = resolvedPath.toLowerCase().slice(resolvedPath.lastIndexOf('.'));
      let dataURL: string, width: number, height: number, format: number;

      if (ext === '.dds') {
        const result = ddsBufferToDataURL(bytes.buffer);
        dataURL = result.dataURL; width = result.width; height = result.height; format = result.format;
      } else {
        const result = texBufferToDataURL(bytes.buffer);
        dataURL = result.dataURL; width = result.width; height = result.height; format = result.format;
      }

      setTabs(prev => prev.map(t =>
        t.id === tabId
          ? { ...t, textureDataUrl: dataURL, textureWidth: width, textureHeight: height, textureFormat: format, textureError: null }
          : t
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, textureError: msg } : t
      ));
    } finally {
      if (!silent) setReloadingTexTabId(null);
    }
  }, []);

  /** Manual reload triggered by the Reload button */
  const handleTexReload = useCallback(() => {
    const tab = tabs.find(t => t.id === activeTabId && t.tabType === 'texture-preview');
    if (!tab?.filePath) return;
    // Reset the stored mtime so the poller doesn't double-fire
    texMtimeRef.current.delete(tab.id);
    loadTextureIntoTab(tab.id, tab.filePath);
  }, [tabs, activeTabId, loadTextureIntoTab]);

  // Auto-reload: poll the active texture tab's file mtime every 1.5 s
  useEffect(() => {
    // Clear any existing poll
    if (texPollIntervalRef.current) {
      clearInterval(texPollIntervalRef.current);
      texPollIntervalRef.current = null;
    }

    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.tabType !== 'texture-preview' || !tab.filePath) return;

    const filePath = tab.filePath;
    const tabId = tab.id;

    texPollIntervalRef.current = setInterval(async () => {
      try {
        const mtime = await invoke<number>('get_file_mtime', { path: filePath });
        const last = texMtimeRef.current.get(tabId);
        if (last === undefined) {
          // First reading â€” just store it, don't reload
          texMtimeRef.current.set(tabId, mtime);
        } else if (mtime !== last) {
          texMtimeRef.current.set(tabId, mtime);
          // File changed on disk â€” silently reload
          await loadTextureIntoTab(tabId, filePath, true);
        }
      } catch {
        // File temporarily locked while being written â€” ignore and retry next tick
      }
    }, 1500);

    return () => {
      if (texPollIntervalRef.current) {
        clearInterval(texPollIntervalRef.current);
        texPollIntervalRef.current = null;
      }
    };
  }, [activeTabId, tabs, loadTextureIntoTab]);

  // Auto-reload: poll open editor tabs for external file changes every 2s
  const editorMtimeRef = useRef<Map<string, number>>(new Map());
  const editorPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (editorPollIntervalRef.current) {
      clearInterval(editorPollIntervalRef.current);
      editorPollIntervalRef.current = null;
    }

    // Only poll tabs that are regular editor tabs with a file path
    const editorTabs = tabs.filter(t => (!t.tabType || t.tabType === 'editor') && t.filePath);
    if (editorTabs.length === 0) return;

    editorPollIntervalRef.current = setInterval(async () => {
      for (const tab of editorTabs) {
        if (!tab.filePath) continue;
        try {
          const mtime = await invoke<number>('get_file_mtime', { path: tab.filePath });
          const last = editorMtimeRef.current.get(tab.id);
          if (last === undefined) {
            // First reading — just store it
            editorMtimeRef.current.set(tab.id, mtime);
          } else if (mtime !== last) {
            editorMtimeRef.current.set(tab.id, mtime);
            // Skip auto-reload when Quartz session is active — let Quartz diff handle it
            const quartzSession = quartzSessionsRef.current.get(tab.filePath.toLowerCase());
            if (quartzSession) {
              console.log('[AutoReload] Skipping reload (Quartz session active):', tab.filePath);
              continue;
            }
            // File changed on disk — reload the bin content
            console.log('[AutoReload] File changed externally:', tab.filePath);
            try {
              const newContent = await readBinDirect(tab.filePath);
              setTabs(prev => prev.map(t =>
                t.id === tab.id ? { ...t, content: newContent, isModified: false } : t
              ));
              if (tab.id === activeTabId && editorRef.current) {
                const model = editorRef.current.getModel();
                if (model) {
                  model.setValue(newContent);
                }
              }
              setStatusMessage(`Reloaded ${tab.fileName} (changed externally)`);
              statusMessageRef.current = `Reloaded ${tab.fileName} (changed externally)`;
            } catch {
              // File might be locked during write — will retry next poll
            }
          }
        } catch {
          // File temporarily inaccessible — ignore
        }
      }
    }, 2000);

    return () => {
      if (editorPollIntervalRef.current) {
        clearInterval(editorPollIntervalRef.current);
        editorPollIntervalRef.current = null;
      }
    };
  }, [tabs, activeTabId]);

  // Clean up mtime tracking when tabs are closed
  useEffect(() => {
    const openTabIds = new Set(tabs.map(t => t.id));
    for (const id of editorMtimeRef.current.keys()) {
      if (!openTabIds.has(id)) editorMtimeRef.current.delete(id);
    }
  }, [tabs]);

  /**
   * Resolve a .tex asset path and decode it for the hover popup.
   * Results are cached so re-hovering the same path is instant.
   */
  const BROWSER_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp'];
  const TEX_EXT = '.tex';
  const POPUP_PREVIEW_MAX_DIM = 512; // downscale large textures for the small popup

  /** Decode base64 string to Uint8Array efficiently */
  function b64ToBytes(b64: string): Uint8Array {
    const binaryStr = atob(b64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes;
  }

  // Pick the right base file for `resolve_asset_path`. Normally this
  // is the active editor tab's own filePath (the BIN we're hovering
  // swatches in). For in-memory asset-list reports the tab has no
  // filePath, so we fall back to a sentinel inside the mod root the
  // report embeds in its header (`Mod root: \`<abs path>\``). That
  // lets the hover popup resolve assets against the mod root we
  // already know — same trick the gallery dialog uses.
  const popupBaseForActiveTab = (): string | null => {
    const tab = activeTabRef.current;
    if (!tab) return null;
    if (tab.filePath) return tab.filePath;
    if (!isEditorTab(tab)) return null;
    const text = (activeTabIdRef.current === tab.id && editorRef.current?.getValue())
      || tab.content
      || '';
    const m = /^Mod root:\s+`([^`]+)`/m.exec(text);
    if (!m) return null;
    // `resolve_asset_path` accepts a directory or a file path; passing
    // a non-existent sentinel under the directory matches how the
    // gallery dialog does it.
    return `${m[1].replace(/\\/g, '/').replace(/\/+$/, '')}/.jade-popup-base`;
  };

  const loadTextureForPopup = useCallback(async (rawPath: string, baseFile: string | null) => {
    try {
      const resolved: string | null = baseFile
        ? await invoke('resolve_asset_path', { baseFile, assetPath: rawPath })
        : null;

      if (!resolved) {
        setTexPopup(prev => prev?.rawPath === rawPath
          ? { ...prev, error: `File not found: ${rawPath}`, resolvedPath: null }
          : prev);
        return;
      }

      const ext = rawPath.toLowerCase().slice(rawPath.lastIndexOf('.'));

      if (ext === TEX_EXT) {
        const bytes = b64ToBytes(await invoke('read_file_base64', { path: resolved }));
        const { dataURL, width, height, format } = texBufferToDataURL(bytes.buffer, POPUP_PREVIEW_MAX_DIM);
        const { formatName } = await import('./lib/texFormat');
        setTexPopup(prev => prev?.rawPath === rawPath
          ? { ...prev, resolvedPath: resolved, imageDataUrl: dataURL, texWidth: width, texHeight: height, formatStr: formatName(format), formatNum: format, error: null }
          : prev);
      } else if (ext === '.dds') {
        const bytes = b64ToBytes(await invoke('read_file_base64', { path: resolved }));
        const { dataURL, width, height, ddsFormat } = ddsBufferToDataURL(bytes.buffer, POPUP_PREVIEW_MAX_DIM);
        setTexPopup(prev => prev?.rawPath === rawPath
          ? { ...prev, resolvedPath: resolved, imageDataUrl: dataURL, texWidth: width, texHeight: height, formatStr: ddsFormatName(ddsFormat), formatNum: 0, error: null }
          : prev);
      } else if (BROWSER_IMAGE_EXTS.includes(ext)) {
        const b64: string = await invoke('read_file_base64', { path: resolved });
        const mime = ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
        const dataURL = `data:${mime};base64,${b64}`;
        const img = new Image();
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = dataURL; });
        setTexPopup(prev => prev?.rawPath === rawPath
          ? { ...prev, resolvedPath: resolved, imageDataUrl: dataURL, texWidth: img.width, texHeight: img.height, formatStr: ext.slice(1).toUpperCase(), formatNum: 0, error: null }
          : prev);
      } else {
        setTexPopup(prev => prev?.rawPath === rawPath
          ? { ...prev, resolvedPath: resolved, error: `Preview not supported for ${ext} files`, imageDataUrl: null }
          : prev);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTexPopup(prev => prev?.rawPath === rawPath
        ? { ...prev, error: msg, resolvedPath: null }
        : prev);
    }
  }, []);

  /** Close the texture popup */
  const closeTexPopup = useCallback(() => {
    setTexPopup(null);
  }, []);

  /** Open a full-size texture preview tab for the currently shown popup */
  const handleTexOpenFull = useCallback(() => {
    const popup = texPopupRef.current;
    if (!popup?.resolvedPath) return;
    setTexPopup(null);

    // Save the current code tab's scroll/cursor position so it's
    // restored when the user switches back.
    saveCurrentViewState();

    // Check if already open
    const existing = tabs.find(t => t.filePath === popup.resolvedPath && t.tabType === 'texture-preview');
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const newTab = createTexPreviewTab(popup.resolvedPath);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Load texture data into the new tab
    loadTextureIntoTab(newTab.id, popup.resolvedPath);
  }, [tabs, loadTextureIntoTab, saveCurrentViewState]);

  /** Open the file in the configured image editor (or OS default) */
  const handleTexEditImage = useCallback(async (resolvedPath: string | null | undefined) => {
    const path = resolvedPath ?? texPopupRef.current?.resolvedPath;
    if (!path) return;
    try {
      await invoke('open_tex_for_edit', { filePath: path });
    } catch (err) {
      setStatusMessage(`Edit Image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /** Show the file in Windows Explorer, highlighted */
  const handleTexShowInExplorer = useCallback(async (resolvedPath: string | null | undefined) => {
    const path = resolvedPath ?? texPopupRef.current?.resolvedPath;
    if (!path) return;
    try {
      await invoke('show_in_explorer', { filePath: path });
    } catch (err) {
      setStatusMessage(`Show in Explorer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Add inline decorations showing emitterName on VfxEmitterDefinitionData lines
  const updateEmitterNameDecorations = useCallback((editor: MonacoType.editor.IStandaloneCodeEditor) => {
    const model = editor.getModel();
    if (!model || model.isDisposed()) return;

    if (!emitterHintsEnabled.current) {
      // Clear existing decorations and CSS
      emitterDecorationIds.current = model.deltaDecorations(emitterDecorationIds.current, []);
      const styleEl = document.getElementById('emitter-hint-styles');
      if (styleEl) styleEl.textContent = '';
      return;
    }

    const text = model.getValue();
    const lines = text.split('\n');
    const decorations: MonacoType.editor.IModelDeltaDecoration[] = [];
    const cssRules: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (/VfxEmitterDefinitionData\s*\{/.test(lines[i])) {
        let braceDepth = 0;
        let emitterName = '';
        for (let j = i; j < Math.min(i + 80, lines.length); j++) {
          for (const c of lines[j]) {
            if (c === '{') braceDepth++;
            else if (c === '}') braceDepth--;
          }
          const nameMatch = lines[j].match(/emitterName:\s*string\s*=\s*"([^"]+)"/);
          if (nameMatch) {
            emitterName = nameMatch[1];
            break;
          }
          if (braceDepth <= 0 && j > i) break;
        }
        if (emitterName) {
          const lineNum = i + 1;
          const className = `emitter-hint-${lineNum}`;
          const escapedName = emitterName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          cssRules.push(`.${className}::after { content: "  // ${escapedName}"; color: var(--syntax-comment-color, #6a9955); font-style: italic; opacity: 0.8; }`);
          decorations.push({
            range: { startLineNumber: lineNum, startColumn: 1, endLineNumber: lineNum, endColumn: 1 },
            options: {
              afterContentClassName: className,
              isWholeLine: true,
            },
          });
        }
      }
    }

    // Inject dynamic CSS for emitter name hints
    let styleEl = document.getElementById('emitter-hint-styles');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'emitter-hint-styles';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssRules.join('\n');

    emitterDecorationIds.current = model.deltaDecorations(emitterDecorationIds.current, decorations);
  }, []);

  // Run the custom bracket syntax checker and set Monaco markers + line decorations
  const updateSyntaxMarkers = useCallback((editor: MonacoType.editor.IStandaloneCodeEditor) => {
    const monaco = monacoRef.current;
    const model = editor.getModel();
    if (!monaco || !model || model.isDisposed()) return;

    // The syntax checker is bin/ritobin-specific. Skip it for plain-text
    // tabs (json, md, txt, etc.) so we don't paint nonsense errors on
    // unrelated formats. Gate on the model's *language id* rather than
    // its URI path — new/untitled buffers get an `inmemory://tab/<id>`
    // URI with no extension, but their language is still set correctly
    // from the tab's filename at creation (see getMonacoLanguageForPath),
    // so a fresh `.md` file reads as 'markdown' and is left alone.
    const isRitobinTab = model.getLanguageId() === RITOBIN_LANGUAGE_ID;

    if (!syntaxCheckingEnabled.current || !isRitobinTab) {
      monaco.editor.setModelMarkers(model, 'syntax-checker', []);
      syntaxDecorationIds.current = model.deltaDecorations(syntaxDecorationIds.current, []);
      return;
    }

    const text = model.getValue();
    const errors = checkSyntax(text);

    // Markers give the squiggly underline + problems list.
    // Errors (red) are for broken syntax, warnings (yellow) are for things
    // that will convert but won't work as intended in-game.
    const markers: MonacoType.editor.IMarkerData[] = errors.map(err => ({
      severity: err.severity === 'warning'
        ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Error,
      message: err.message,
      startLineNumber: err.line,
      startColumn: err.column,
      endLineNumber: err.line,
      endColumn: err.column + (err.length || 1),
    }));
    monaco.editor.setModelMarkers(model, 'syntax-checker', markers);

    // Decorations give the line highlight + glyph dot + minimap indicator.
    // Errors win over warnings — if a line has both, show red.
    const lineSeverity = new Map<number, 'error' | 'warning'>();
    for (const err of errors) {
      const prev = lineSeverity.get(err.line);
      const sev = err.severity === 'warning' ? 'warning' : 'error';
      if (prev === 'error') continue;
      lineSeverity.set(err.line, sev);
    }

    const decorations: MonacoType.editor.IModelDeltaDecoration[] = [];
    for (const [lineNum, sev] of lineSeverity.entries()) {
      const isWarn = sev === 'warning';
      decorations.push({
        range: new monaco.Range(lineNum, 1, lineNum, 1),
        options: {
          isWholeLine: true,
          className: isWarn ? 'syntax-warning-line' : 'syntax-error-line',
          glyphMarginClassName: isWarn ? 'syntax-warning-glyph' : 'syntax-error-glyph',
          minimap: {
            color: isWarn ? '#e6b800' : '#ff3333',
            position: monaco.editor.MinimapPosition.Inline,
          },
          overviewRuler: {
            color: isWarn ? '#e6b800' : '#ff3333',
            position: monaco.editor.OverviewRulerLane.Full,
          },
        },
      });
    }
    syntaxDecorationIds.current = model.deltaDecorations(syntaxDecorationIds.current, decorations);
  }, []);

  /**
   * Register the "per-editor" features on a SECONDARY Monaco editor
   * instance — the right pane of split mode. The left/primary editor
   * gets all this (and more) through `handleEditorMount`, but that
   * function is hard-wired to write to shell-level refs and disposes
   * the previous editor's handlers on mount, so we can't just reuse
   * it for the second pane.
   *
   * Features wired here:
   *   - Inline image-path swatches (the `.tex` path decorations)
   *   - Material-jump arrows + click-to-jump for `material: link` ↔
   *     `StaticMaterialDef` pairs
   *   - Texture popup on swatch click (the hover/click preview the
   *     main editor surfaces too)
   *
   * Returns a cleanup function the caller MUST invoke on unmount so
   * the disposables / debounce timers don't leak.
   */
  const setupRightEditor = useCallback((editor: MonacoType.editor.IStandaloneCodeEditor) => {
    const disposables: { dispose: () => void }[] = [];

    // -- Image path decorations (the inline `.tex` swatch boxes) --
    let imgPathDecorations: string[] = [];
    let imgDecDebounce: ReturnType<typeof setTimeout> | null = null;
    const refreshImg = () => {
      const m = editor.getModel();
      if (!m) return;
      imgPathDecorations = editor.deltaDecorations(imgPathDecorations, findAllImagePaths(m));
    };
    const debouncedRefreshImg = () => {
      if (imgDecDebounce) clearTimeout(imgDecDebounce);
      imgDecDebounce = setTimeout(refreshImg, 300);
    };
    refreshImg();
    disposables.push(editor.onDidChangeModelContent(() => debouncedRefreshImg()));
    // Defer model-swap refreshes to a microtask so we don't call
    // `deltaDecorations` while Monaco is already mid-`deltaDecorations`
    // on a chained event delivery — that's what Monaco's "Invoking
    // deltaDecorations recursively" warning catches.
    disposables.push(editor.onDidChangeModel(() => queueMicrotask(refreshImg)));
    disposables.push({
      dispose: () => {
        if (imgDecDebounce) clearTimeout(imgDecDebounce);
        editor.deltaDecorations(imgPathDecorations, []);
      },
    });

    // -- Material jump arrows --
    let matJumpDecorations: string[] = [];
    let matJumpDebounce: ReturnType<typeof setTimeout> | null = null;
    // `editor.deltaDecorations` synchronously fires Monaco's
    // model-decoration change event, and at least one of our other
    // listeners ends up re-entering this refresher under the
    // resulting fire chain. The recursive call trips Monaco's
    // "Invoking deltaDecorations recursively could lead to leaking
    // decorations" warning. This flag silently bails on re-entry.
    let matJumpRefreshing = false;
    const refreshMatJump = () => {
      if (matJumpRefreshing) return;
      const m = editor.getModel();
      if (!m) return;
      matJumpRefreshing = true;
      try {
        matJumpDecorations = editor.deltaDecorations(matJumpDecorations, findMaterialJumpDecorations(m));
      } finally {
        matJumpRefreshing = false;
      }
    };
    const debouncedRefreshMatJump = () => {
      if (matJumpDebounce) clearTimeout(matJumpDebounce);
      matJumpDebounce = setTimeout(refreshMatJump, 300);
    };
    refreshMatJump();
    disposables.push(editor.onDidChangeModelContent(() => debouncedRefreshMatJump()));
    // Microtask-defer: see refreshImg above for rationale.
    disposables.push(editor.onDidChangeModel(() => queueMicrotask(refreshMatJump)));
    disposables.push({
      dispose: () => {
        if (matJumpDebounce) clearTimeout(matJumpDebounce);
        editor.deltaDecorations(matJumpDecorations, []);
      },
    });
    disposables.push(editor.onMouseDown((e) => {
      const target = e.event.browserEvent.target as HTMLElement | null;
      if (!target || !target.classList.contains('jade-jump-arrow')) return;
      const match = Array.from(target.classList).find((c) => c.startsWith('jade-jump-to-'));
      if (!match) return;
      const targetLine = parseInt(match.slice('jade-jump-to-'.length), 10);
      if (!Number.isFinite(targetLine)) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      editor.revealLineInCenter(targetLine, 0);
      editor.setPosition({ lineNumber: targetLine, column: 1 });
      editor.focus();
    }));

    // -- Texture popup: shared helper for both click and hover --
    //
    // Mirrors the primary editor's flow (compute anchor from
    // bounding rect, extract the path off the swatch's host line,
    // delegate to `loadTextureForPopup`) but inlined so we don't
    // have to surface every helper through context. The popup
    // state itself is shared App-level state, so opening from
    // either pane is fine.
    const openPopupFromSwatch = (swatchEl: HTMLElement) => {
      const model = editor.getModel();
      if (!model) return;
      const rect = swatchEl.getBoundingClientRect();
      // Probe just to the right of the swatch to land on the path text.
      const probeX = rect.right + 4;
      const probeY = rect.top + rect.height / 2;
      const pos = editor.getTargetAtClientPoint(probeX, probeY);
      if (!pos?.position) return;
      const line = model.getLineContent(pos.position.lineNumber);
      const imgMatch = extractImagePathAtColumn(line, pos.position.column);
      if (!imgMatch) return;
      // Toggle off if already open for the same path.
      if (texPopupRef.current?.rawPath === imgMatch.path) {
        setTexPopup(null);
        return;
      }
      // Anchor math MUST match the left pane's `computeAnchorFromSwatch`
      // exactly — the `TexHoverPopup` component does its own offset
      // math (adds GAP, uses `bottom: window.innerHeight - top + GAP`
      // when `above`). So `top` is just the swatch edge; subtracting
      // POPUP_H here is what was throwing the popup off-screen.
      const POPUP_H = 320;
      const above = rect.top > POPUP_H + 8;
      setTexPopup({
        top: above ? rect.top : rect.bottom,
        left: rect.left,
        above,
        rawPath: imgMatch.path,
        resolvedPath: null,
        imageDataUrl: null,
        texWidth: 0,
        texHeight: 0,
        formatStr: '',
        formatNum: 0,
        error: null,
      });
      loadTextureForPopup(imgMatch.path, popupBaseForActiveTab());
    };

    // Click → toggle popup.
    disposables.push(editor.onMouseDown((e) => {
      const target = e.event.browserEvent.target as HTMLElement | null;
      if (!target?.classList.contains('image-path-swatch')) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      openPopupFromSwatch(target);
    }));

    // Hover → open after a short dwell, dismiss when the cursor
    // leaves the swatch (unless it lands on the popup itself, which
    // sets `isOverTexPopupRef.current = true` and cancels dismiss).
    let swatchHoverTimeout: ReturnType<typeof setTimeout> | null = null;
    let swatchDismissTimeout: ReturnType<typeof setTimeout> | null = null;
    let hoveredSwatchEl: HTMLElement | null = null;
    const clearSwatchHover = () => {
      if (swatchHoverTimeout) { clearTimeout(swatchHoverTimeout); swatchHoverTimeout = null; }
      hoveredSwatchEl = null;
    };
    const clearSwatchDismiss = () => {
      if (swatchDismissTimeout) { clearTimeout(swatchDismissTimeout); swatchDismissTimeout = null; }
    };
    const scheduleSwatchDismiss = () => {
      clearSwatchDismiss();
      swatchDismissTimeout = setTimeout(() => {
        if (!isOverTexPopupRef.current) setTexPopup(null);
      }, 350);
    };
    disposables.push(editor.onMouseMove((e) => {
      const target = e.event.browserEvent.target as HTMLElement | null;
      if (!target?.classList.contains('image-path-swatch')) {
        if (hoveredSwatchEl) {
          clearSwatchHover();
          if (texPopupRef.current) scheduleSwatchDismiss();
        }
        return;
      }
      clearSwatchDismiss();
      if (target === hoveredSwatchEl) return;
      clearSwatchHover();
      hoveredSwatchEl = target;
      swatchHoverTimeout = setTimeout(() => {
        swatchHoverTimeout = null;
        // No `!texPopupRef.current` gate here — if a popup is already
        // open for a different swatch, `openPopupFromSwatch` will
        // overwrite it with the new path (it only toggles off when
        // the incoming path matches the current one). The earlier gate
        // left stale popups visible when the mouse hopped between
        // swatches without ever leaving the swatch region.
        if (hoveredSwatchEl === target) {
          openPopupFromSwatch(target);
        }
      }, 400);
    }));
    disposables.push(editor.onMouseLeave(() => {
      if (hoveredSwatchEl) clearSwatchHover();
      if (texPopupRef.current) scheduleSwatchDismiss();
    }));
    disposables.push({ dispose: () => { clearSwatchHover(); clearSwatchDismiss(); } });
    // Dismiss on scroll so the popup doesn't float detached from
    // the text when the user moves the viewport.
    disposables.push(editor.onDidScrollChange(() => {
      if (texPopupRef.current) setTexPopup(null);
    }));

    return () => {
      for (const d of disposables) {
        try { d.dispose(); } catch {}
      }
    };
  }, [loadTextureForPopup]);

  const handleEditorMount = (editor: MonacoType.editor.IStandaloneCodeEditor) => {
    // Clean up any previous subscriptions before creating new ones
    editorDisposablesRef.current.forEach(disposable => {
      try {
        disposable.dispose();
      } catch (error) {
        console.warn('Error disposing previous subscription:', error);
      }
    });
    editorDisposablesRef.current = [];

    // Disconnect previous MutationObserver if it exists
    if (mutationObserverRef.current) {
      mutationObserverRef.current.disconnect();
      mutationObserverRef.current = null;
    }

    // Clear any pending mutation setup timeout
    if (mutationSetupTimeoutRef.current) {
      clearTimeout(mutationSetupTimeoutRef.current);
      mutationSetupTimeoutRef.current = null;
    }

    // Clear any existing undo check interval
    if (undoCheckIntervalRef.current) {
      clearInterval(undoCheckIntervalRef.current);
      undoCheckIntervalRef.current = null;
    }

    editorRef.current = editor;

    // Configure model to limit undo stack memory
    const model = editor.getModel();
    if (model) {
      setLineCount(model.getLineCount());
      // Set model options to help reduce memory usage
      model.updateOptions({
        tabSize: 2,
        insertSpaces: true,
      });
    }



    // Update caret position on cursor change - DEBOUNCED to prevent re-render spam
    const caretUpdateTimeoutRef = { current: null as ReturnType<typeof setTimeout> | null };
    const cursorDisposable = editor.onDidChangeCursorPosition((e) => {
      // Debounce cursor updates to 100ms to avoid re-rendering on every keystroke
      if (caretUpdateTimeoutRef.current) {
        clearTimeout(caretUpdateTimeoutRef.current);
      }
      caretUpdateTimeoutRef.current = setTimeout(() => {
        setCaretPosition({ line: e.position.lineNumber, column: e.position.column });
        caretUpdateTimeoutRef.current = null;
      }, 100);
    });
    editorDisposablesRef.current.push(cursorDisposable);
    editorDisposablesRef.current.push({
      dispose: () => {
        if (caretUpdateTimeoutRef.current) clearTimeout(caretUpdateTimeoutRef.current);
      }
    });

    // Custom right-click context menu
    const contextMenuDisposable = editor.onContextMenu((e) => {
      e.event.preventDefault();
      e.event.stopPropagation();
      setCtxMenu({ x: e.event.posx, y: e.event.posy });
    });
    editorDisposablesRef.current.push(contextMenuDisposable);

    // â”€â”€ Texture path click-to-preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    /** Compute fixed popup position anchored below (or above) the editor line */
    /** Compute popup anchor from the swatch element — above by default, below if no space */
    const computeAnchorFromSwatch = (swatchEl: HTMLElement) => {
      const rect = swatchEl.getBoundingClientRect();
      const POPUP_H = 320;
      const swatchTop = rect.top;
      const swatchBottom = rect.bottom;
      const left = rect.left;
      const above = swatchTop > POPUP_H + 8;
      const top = above ? swatchTop : swatchBottom;
      return { top, left, above };
    };

    /** Given a swatch DOM element, find the image path on its line */
    const findImagePathFromSwatch = (swatchEl: HTMLElement) => {
      const model = editor.getModel();
      if (!model) return null;
      const rect = swatchEl.getBoundingClientRect();
      // Offset past the swatch itself to hit actual text content
      const probeX = rect.right + 4;
      const probeY = rect.top + rect.height / 2;
      const pos = editor.getTargetAtClientPoint(probeX, probeY);
      if (!pos?.position) return null;
      const line = model.getLineContent(pos.position.lineNumber);
      const imgMatch = extractImagePathAtColumn(line, pos.position.column);
      if (!imgMatch) return null;
      return { ...imgMatch, lineNumber: pos.position.lineNumber };
    };

    /** Open the texture popup for a given swatch */
    const openPopupFromSwatch = (swatchEl: HTMLElement) => {
      const match = findImagePathFromSwatch(swatchEl);
      if (!match) return;

      // Toggle off if same path
      if (texPopupRef.current?.rawPath === match.path) {
        setTexPopup(null);
        return;
      }

      const anchor = computeAnchorFromSwatch(swatchEl);

      setTexPopup({
        top: anchor.top,
        left: anchor.left,
        above: anchor.above,
        rawPath: match.path,
        resolvedPath: null,
        imageDataUrl: null,
        texWidth: 0,
        texHeight: 0,
        formatStr: '',
        formatNum: 0,
        error: null,
      });
      loadTextureForPopup(match.path, popupBaseForActiveTab());
    };

    // Click on swatch to open popup
    const mouseDownDisposable = editor.onMouseDown((e) => {
      const browserTarget = e.event.browserEvent.target as HTMLElement | null;
      if (!browserTarget?.classList.contains('image-path-swatch')) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      openPopupFromSwatch(browserTarget);
    });
    editorDisposablesRef.current.push(mouseDownDisposable);

    // Hover on swatch: open popup after dwell, dismiss when leaving swatch area
    let swatchHoverTimeout: ReturnType<typeof setTimeout> | null = null;
    let swatchDismissTimeout: ReturnType<typeof setTimeout> | null = null;
    let hoveredSwatchEl: HTMLElement | null = null;
    const clearSwatchHover = () => {
      if (swatchHoverTimeout) { clearTimeout(swatchHoverTimeout); swatchHoverTimeout = null; }
      hoveredSwatchEl = null;
    };
    const clearSwatchDismiss = () => {
      if (swatchDismissTimeout) { clearTimeout(swatchDismissTimeout); swatchDismissTimeout = null; }
    };
    const scheduleSwatchDismiss = () => {
      clearSwatchDismiss();
      swatchDismissTimeout = setTimeout(() => {
        if (!isOverTexPopupRef.current) setTexPopup(null);
      }, 350);
    };
    const mouseMoveDisposable = editor.onMouseMove((e) => {
      const browserTarget = e.event.browserEvent.target as HTMLElement | null;
      if (!browserTarget?.classList.contains('image-path-swatch')) {
        if (hoveredSwatchEl) {
          clearSwatchHover();
          // Mouse left the swatch — schedule dismiss (popup's own mouseenter will cancel via its own logic)
          if (texPopupRef.current) scheduleSwatchDismiss();
        }
        return;
      }
      // Mouse is over a swatch — cancel any pending dismiss
      clearSwatchDismiss();
      if (browserTarget === hoveredSwatchEl) return;
      clearSwatchHover();
      hoveredSwatchEl = browserTarget;
      swatchHoverTimeout = setTimeout(() => {
        swatchHoverTimeout = null;
        // See the left-pane handler — no `!texPopupRef.current` gate
        // so hovering from one swatch to another swaps the popup
        // instead of leaving the stale one onscreen.
        if (hoveredSwatchEl === browserTarget) {
          openPopupFromSwatch(browserTarget);
        }
      }, 400);
    });
    editorDisposablesRef.current.push(mouseMoveDisposable);

    const mouseLeaveDisposable = editor.onMouseLeave(() => {
      if (hoveredSwatchEl) clearSwatchHover();
      if (texPopupRef.current) scheduleSwatchDismiss();
    });
    editorDisposablesRef.current.push(mouseLeaveDisposable);
    editorDisposablesRef.current.push({ dispose: () => { clearSwatchHover(); clearSwatchDismiss(); } });

    // Dismiss on scroll so it doesn't float detached from the text
    const scrollDisposable = editor.onDidScrollChange(() => {
      if (texPopupRef.current) {
        setTexPopup(null);
      }
    });
    editorDisposablesRef.current.push(scrollDisposable);
    // â”€â”€ End texture path click-to-preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // â”€â”€ Image path pointer-cursor decorations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let imgPathDecorations: string[] = [];
    let imgDecDebounce: ReturnType<typeof setTimeout> | null = null;
    const refreshImagePathDecorations = () => {
      const model = editor.getModel();
      if (!model) return;
      imgPathDecorations = editor.deltaDecorations(imgPathDecorations, findAllImagePaths(model));
    };
    const debouncedRefreshImagePathDecorations = () => {
      if (imgDecDebounce) clearTimeout(imgDecDebounce);
      imgDecDebounce = setTimeout(refreshImagePathDecorations, 300);
    };
    // Apply on mount and debounce on content changes
    refreshImagePathDecorations();
    const imgDecContentDisposable = editor.onDidChangeModelContent(() => { debouncedRefreshImagePathDecorations(); });
    // Microtask-defer the model-swap refresh so we don't enter
    // `deltaDecorations` while Monaco is mid-`deltaDecorations` on
    // a chained event delivery (the "Invoking deltaDecorations
    // recursively" warning).
    const imgDecModelDisposable = editor.onDidChangeModel(() => { queueMicrotask(refreshImagePathDecorations); });
    editorDisposablesRef.current.push(imgDecContentDisposable, imgDecModelDisposable);
    editorDisposablesRef.current.push({ dispose: () => { if (imgDecDebounce) clearTimeout(imgDecDebounce); editor.deltaDecorations(imgPathDecorations, []); } });
    // â”€â”€ End image path decorations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Material jump arrows (link <-> StaticMaterialDef)
    let matJumpDecorations: string[] = [];
    let matJumpDebounce: ReturnType<typeof setTimeout> | null = null;
    // See `setupRightEditor` for the re-entrancy rationale —
    // Monaco's deltaDecorations fires events synchronously and
    // a listener somewhere in our chain calls back into this
    // refresher before the first call has returned. Guard it.
    let matJumpRefreshing = false;
    const refreshMatJumpDecorations = () => {
      if (matJumpRefreshing) return;
      const model = editor.getModel();
      if (!model) return;
      matJumpRefreshing = true;
      try {
        matJumpDecorations = editor.deltaDecorations(matJumpDecorations, findMaterialJumpDecorations(model));
      } finally {
        matJumpRefreshing = false;
      }
    };
    const debouncedRefreshMatJumpDecorations = () => {
      if (matJumpDebounce) clearTimeout(matJumpDebounce);
      matJumpDebounce = setTimeout(refreshMatJumpDecorations, 300);
    };
    refreshMatJumpDecorations();
    const matJumpContentDisposable = editor.onDidChangeModelContent(() => { debouncedRefreshMatJumpDecorations(); });
    // Microtask-defer: see refreshImagePathDecorations above for rationale.
    const matJumpModelDisposable = editor.onDidChangeModel(() => { queueMicrotask(refreshMatJumpDecorations); });
    editorDisposablesRef.current.push(matJumpContentDisposable, matJumpModelDisposable);
    editorDisposablesRef.current.push({ dispose: () => { if (matJumpDebounce) clearTimeout(matJumpDebounce); editor.deltaDecorations(matJumpDecorations, []); } });

    // Click handler for the jump arrows — parse the target line from the
    // class name suffix and reveal it centered.
    const matJumpClickDisposable = editor.onMouseDown((e) => {
      const target = e.event.browserEvent.target as HTMLElement | null;
      if (!target || !target.classList.contains('jade-jump-arrow')) return;
      const match = Array.from(target.classList).find((c) => c.startsWith('jade-jump-to-'));
      if (!match) return;
      const targetLine = parseInt(match.slice('jade-jump-to-'.length), 10);
      if (!Number.isFinite(targetLine)) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      editor.revealLineInCenter(targetLine, 0);
      editor.setPosition({ lineNumber: targetLine, column: 1 });
      editor.focus();
    });
    editorDisposablesRef.current.push(matJumpClickDisposable);

    // â”€â”€ Refocus editor on window focus (so hover works after alt-tab) â”€â”€â”€
    const onWindowFocus = () => { editor.focus(); };
    window.addEventListener('focus', onWindowFocus);
    editorDisposablesRef.current.push({ dispose: () => { window.removeEventListener('focus', onWindowFocus); } });

    // Restore view state for active tab (model-switching effect will handle this on tab changes)
    // On initial mount, trigger model setup for the LEFT pane's tab —
    // pin to `leftActiveTabId`, NOT the derived `activeTabId`.
    // Otherwise, when shells remount with the right pane focused
    // (activeTabId === rightActiveTabId), this block would attach the
    // right pane's model to the new LEFT editor, swapping panes
    // visually. Pinning to leftActiveTabId keeps each editor lined
    // up with its own pane across shell switches.
    const leftBootTabId = leftActiveTabId;
    if (leftBootTabId) {
      // Trigger the model-switching effect by forcing a re-evaluation
      setTimeout(() => {
        const monaco = monacoRef.current;
        const activeTabData = tabs.find(t => t.id === leftBootTabId);
        if (monaco && activeTabData && editor) {
          const uri = activeTabData.filePath
            ? monaco.Uri.file(activeTabData.filePath)
            : monaco.Uri.parse(`inmemory://tab/${leftBootTabId}`);
          const existing = monaco.editor.getModel(uri);
          let model: MonacoType.editor.ITextModel;
          if (existing && !existing.isDisposed()) {
            model = existing;
          } else {
            model = monaco.editor.createModel(activeTabData.content, getMonacoLanguageForPath(activeTabData.filePath ?? activeTabData.fileName), uri);
          }
          monacoModelsRef.current.set(leftBootTabId, model);
          editor.setModel(model);
          const savedState = viewStatesRef.current.get(leftBootTabId);
          if (savedState?.viewState) {
            editor.restoreViewState(savedState.viewState);
          }
          setLineCount(model.getLineCount());
          updateEmitterNameDecorations(editor);
          updateSyntaxMarkers(editor);
        }
      }, 0);
    }

    // Periodic undo stack trimming to prevent memory bloat
    // Monaco doesn't expose direct undo stack access, but we can segment it periodically
    undoCheckIntervalRef.current = setInterval(() => {
      const currentModel = editorRef.current?.getModel();
      if (currentModel) {
        // Push a stack element periodically to segment the undo stack
        // This prevents undo operations from spanning too much content
        currentModel.pushStackElement();
      }
    }, 30000) as unknown as number; // Every 30 seconds

    // Watch for find widget visibility - STORE THE OBSERVER
    mutationSetupTimeoutRef.current = setTimeout(() => {
      const editorElement = editor.getDomNode();
      if (editorElement) {
        mutationObserverRef.current = new MutationObserver(() => {
          // Only the VSCode shell uses Monaco's native find widget. In
          // Word/VS shells the widget is suppressed, so its absence is
          // expected — letting the observer fire would close our custom
          // find pane the moment the user opens it.
          if (shellVariantRef.current !== 'vscode') return;
          const findWidget = editorElement.querySelector('.find-widget');
          if (findWidget) {
            const isHidden = findWidget.classList.contains('hidden') ||
              findWidget.getAttribute('aria-hidden') === 'true' ||
              (findWidget as HTMLElement).style.display === 'none';

            const isVisible = !isHidden;
            const isReplace = findWidget.classList.contains('replaceToggled');

            if (isVisible) {
              setFindWidgetOpen(!isReplace);
              setReplaceWidgetOpen(isReplace);
            } else {
              setFindWidgetOpen(false);
              setReplaceWidgetOpen(false);
            }
          } else {
            setFindWidgetOpen(false);
            setReplaceWidgetOpen(false);
          }
        });

        mutationObserverRef.current.observe(editorElement, {
          attributes: true,
          childList: true,
          subtree: true,
          attributeFilter: ['class', 'style', 'aria-hidden']
        });
      }
      mutationSetupTimeoutRef.current = null;
    }, 500) as unknown as number;
  };

  // ── Session restore ──
  // VSCode-style "your unsaved work survives a crash" feature. We
  // persist a JSON snapshot of open editor tabs (incl. unsaved content)
  // to the preferences file on a debounced timer, and on next launch
  // offer to restore it if there's anything worth recovering.
  const SESSION_PREF_KEY = 'LastSession';
  interface SessionSnapshotTab {
    fileName: string;
    filePath: string | null;
    content?: string;
    isModified: boolean;
  }
  interface SessionSnapshot {
    savedAt: number;
    activeFilePath: string | null;
    activeFileName: string | null;
    tabs: SessionSnapshotTab[];
  }
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRestoredRef = useRef(false);

  const writeSessionNow = useCallback(() => {
    const live = tabsRef.current.filter(t => isEditorTab(t));
    if (live.length === 0) {
      // No editor tabs open — clear any stale snapshot so the next
      // launch doesn't prompt for nothing.
      invoke('set_preference', { key: SESSION_PREF_KEY, value: '' }).catch(() => { });
      return;
    }
    const activeTab = live.find(t => t.id === activeTabIdRef.current) ?? null;
    const snapshot: SessionSnapshot = {
      savedAt: Date.now(),
      activeFilePath: activeTab?.filePath ?? null,
      activeFileName: activeTab?.fileName ?? null,
      tabs: live.map(t => {
        const model = monacoModelsRef.current.get(t.id);
        const content = (model && !model.isDisposed()) ? model.getValue() : (t.content ?? '');
        const includeContent = !!t.isModified || !t.filePath;
        return {
          fileName: t.fileName,
          filePath: t.filePath ?? null,
          isModified: !!t.isModified,
          ...(includeContent ? { content } : {}),
        };
      }),
    };
    invoke('set_preference', {
      key: SESSION_PREF_KEY,
      value: JSON.stringify(snapshot),
    }).catch(() => { });
  }, [isEditorTab]);

  const scheduleSessionSave = useCallback(() => {
    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(writeSessionNow, 1500);
  }, [writeSessionNow]);

  // Save snapshot whenever tabs / active tab change. Content changes
  // also trigger this via a call inside `handleEditorChange`.
  useEffect(() => {
    scheduleSessionSave();
  }, [tabs, activeTabId, scheduleSessionSave]);

  // On startup: if the previous session had unsaved work, prompt the
  // user to restore. Runs exactly once. Only restores tabs that had
  // dirty/untitled content — clean tabs would just reopen with stale
  // content from the snapshot, which is worse than the user reopening
  // them through the Recent Files menu.
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;

    (async () => {
      let raw: string;
      try {
        raw = await invoke<string>('get_preference', {
          key: SESSION_PREF_KEY,
          defaultValue: '',
        });
      } catch {
        return;
      }
      if (!raw) return;

      let snapshot: SessionSnapshot;
      try { snapshot = JSON.parse(raw); } catch { return; }
      if (!snapshot || !Array.isArray(snapshot.tabs)) return;

      // Only the tabs that actually carried unsaved work — saved/clean
      // tabs aren't worth a prompt.
      const restorable = snapshot.tabs.filter(t => typeof t.content === 'string');
      if (restorable.length === 0) return;

      const proceed = await askDialog(
        `Restore your previous session? Jade will reopen ${restorable.length} unsaved file${restorable.length === 1 ? '' : 's'} from your last run.`,
        { title: 'Restore previous session', kind: 'info' },
      );
      if (!proceed) {
        // User declined — clear the snapshot so we don't ask again.
        invoke('set_preference', { key: SESSION_PREF_KEY, value: '' }).catch(() => { });
        return;
      }

      const restored: EditorTab[] = restorable.map(t => {
        const content = t.content ?? '';
        const tab = createTab(t.filePath ?? null, content);
        if (t.fileName) tab.fileName = t.fileName;
        // Restored work is unsaved by definition — even if filePath
        // exists, the snapshot may diverge from disk.
        tab.isModified = true;
        return tab;
      });

      setTabs(prev => [...prev, ...restored]);

      // Pick whichever restored tab matches the snapshot's last-active
      // selection; fall back to the first restored tab.
      const matchActive =
        (snapshot.activeFilePath
          ? restored.find(t => t.filePath === snapshot.activeFilePath)
          : restored.find(t => t.fileName === snapshot.activeFileName))
        ?? restored[0];
      if (matchActive) setActiveTabId(matchActive.id);
    })();
  }, []);

  // ── VS-shell tool open-state persistence ──
  // The VS shell is the only shell that treats find / general edit /
  // particle / texture / material panels as dockable tool windows.
  // Persisting their open state per-shell means a VS user gets back
  // the panes they had docked after a restart, without those flags
  // bleeding into Word / VSCode where they'd render as full-screen
  // overlays and stack weirdly.
  const VS_OPEN_TOOLS_KEY = 'vs-shell-open-tools';
  const vsToolsRestoredRef = useRef(false);

  // Save snapshot whenever an open flag changes — but only while the
  // VS shell is active. Switching shells (which closes everything via
  // the next effect) won't clobber the snapshot because shellVariant
  // has already changed by the time those state updates flush.
  useEffect(() => {
    if (shellVariant !== 'visualstudio') return;
    if (!vsToolsRestoredRef.current) return;     // skip the first render before restore runs
    const snapshot = {
      find:     findWidgetOpen,
      replace:  replaceWidgetOpen,
      general:  generalEditPanelOpen,
      particle: particlePanelOpen,
      texture:  textureInsertOpen,
      material: materialInsertOpen,
      binnav:   binNavOpen,
    };
    try {
      window.localStorage.setItem(VS_OPEN_TOOLS_KEY, JSON.stringify(snapshot));
    } catch { /* quota / private mode */ }
  }, [
    shellVariant,
    findWidgetOpen, replaceWidgetOpen,
    generalEditPanelOpen, particlePanelOpen,
    textureInsertOpen, materialInsertOpen,
    binNavOpen,
  ]);

  // Restore tool open state when the VS shell becomes active (app
  // start or when user switches into VS). Runs each time `shellVariant`
  // resolves to 'visualstudio' — but the read is cheap and the writes
  // are no-ops if values match.
  useEffect(() => {
    if (shellVariant !== 'visualstudio') {
      vsToolsRestoredRef.current = false;
      return;
    }
    try {
      const raw = window.localStorage.getItem(VS_OPEN_TOOLS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<{
          find: boolean; replace: boolean; general: boolean;
          particle: boolean; texture: boolean; material: boolean;
          binnav: boolean;
        }>;
        if (parsed.find)     setFindWidgetOpen(true);
        if (parsed.replace)  setReplaceWidgetOpen(true);
        if (parsed.general)  setGeneralEditPanelOpen(true);
        if (parsed.particle) setParticlePanelOpen(true);
        if (parsed.texture)  setTextureInsertOpen(true);
        if (parsed.material) setMaterialInsertOpen(true);
        if (parsed.binnav)   setBinNavOpen(true);
      }
    } catch { /* parse failure — ignore */ }
    vsToolsRestoredRef.current = true;
  }, [shellVariant]);

  // Switching AWAY from VS closes every dockable tool flag. Word and
  // VSCode shells don't render these as docked panes — leaving them
  // open would either stack as floating overlays (Word) or do nothing
  // useful (VSCode). The persistence effect above sees `shellVariant !==
  // 'visualstudio'` and skips, so the snapshot survives the switch.
  useEffect(() => {
    if (shellVariant === 'visualstudio') return;
    setFindWidgetOpen(false);
    setReplaceWidgetOpen(false);
    setGeneralEditPanelOpen(false);
    setParticlePanelOpen(false);
    setTextureInsertOpen(false);
    setMaterialInsertOpen(false);
    setBinNavOpen(false);
  }, [shellVariant]);

  // Cleanup subscriptions only on component unmount (editor no longer remounts on tab change)
  useEffect(() => {
    return () => {
      // Clean up all editor subscriptions
      editorDisposablesRef.current.forEach(disposable => {
        try {
          disposable.dispose();
        } catch (error) {
          console.warn('Error disposing subscription on cleanup:', error);
        }
      });
      editorDisposablesRef.current = [];

      // Disconnect MutationObserver
      if (mutationObserverRef.current) {
        mutationObserverRef.current.disconnect();
        mutationObserverRef.current = null;
      }

      // Clear mutation setup timeout
      if (mutationSetupTimeoutRef.current) {
        clearTimeout(mutationSetupTimeoutRef.current);
        mutationSetupTimeoutRef.current = null;
      }

      // Clear undo check interval
      if (undoCheckIntervalRef.current) {
        clearInterval(undoCheckIntervalRef.current);
        undoCheckIntervalRef.current = null;
      }

      // Dispose all Monaco models on unmount
      monacoModelsRef.current.forEach((model) => {
        if (!model.isDisposed()) {
          try { model.dispose(); } catch (_) { }
        }
      });
      monacoModelsRef.current.clear();
    };
  }, []); // Only run cleanup on unmount

  // Ref to track if tab was already modified (to skip unnecessary state updates)
  const wasModifiedRef = useRef(false);

  // Reset wasModified ref when active tab changes
  useEffect(() => {
    wasModifiedRef.current = activeTab?.isModified || false;
  }, [activeTabId, activeTab?.isModified]);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && activeTabId && isEditorTab(activeTab)) {
      // Only update state if tab wasn't already marked modified (prevents re-render spam)
      if (!wasModifiedRef.current) {
        wasModifiedRef.current = true;
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTabId ? { ...t, isModified: true } : t
          )
        );
      }
      // Update line count (lightweight, no re-render if unchanged)
      const model = editorRef.current?.getModel();
      if (model) {
        setLineCount(model.getLineCount());
      }
      // Debounced emitter name decoration update
      if (emitterDecorDebounce.current) clearTimeout(emitterDecorDebounce.current);
      emitterDecorDebounce.current = setTimeout(() => {
        if (editorRef.current) updateEmitterNameDecorations(editorRef.current);
      }, 500);
      // Debounced syntax checking
      if (syntaxCheckDebounce.current) clearTimeout(syntaxCheckDebounce.current);
      syntaxCheckDebounce.current = setTimeout(() => {
        if (editorRef.current) updateSyntaxMarkers(editorRef.current);
      }, 500);
      // Snapshot the session so unsaved changes survive a crash.
      scheduleSessionSave();
    }
  };

  // Window Controls
  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().close();

  // File Operations
  const handleNew = () => {
    setShowNewFileDialog(true);
  };

  // Markdown panel helpers — used by MarkdownEditPanel buttons. Each
  // returns true if it applied a change so the panel can show a status
  // when the user clicked something but had nothing selected.
  const mdWrapSelection = useCallback((before: string, after: string): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (!sel || !model || sel.isEmpty()) return false;
    const text = model.getValueInRange(sel);
    editor.executeEdits('md-wrap', [{ range: sel, text: before + text + after }]);
    editor.focus();
    return true;
  }, []);

  const mdPrefixLines = useCallback((prefix: string): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (!sel || !model) return false;
    const monaco = monacoRef.current;
    if (!monaco) return false;
    const startLine = sel.startLineNumber;
    const endLine = sel.endLineNumber;
    const edits: MonacoType.editor.IIdentifiedSingleEditOperation[] = [];
    for (let ln = startLine; ln <= endLine; ln++) {
      edits.push({
        range: new monaco.Range(ln, 1, ln, 1),
        text: prefix,
      });
    }
    editor.executeEdits('md-prefix', edits);
    editor.focus();
    return true;
  }, []);

  const mdInsertAtCaret = useCallback((text: string): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    const sel = editor.getSelection();
    if (!sel) return false;
    editor.executeEdits('md-insert', [{ range: sel, text }]);
    editor.focus();
    return true;
  }, []);

  // -- Photo Studio panel open/closed state. Defaults to true so the
  //    user sees the controls the moment they open a studio scene.
  //    Dismissing a panel hides it for the current session; switching
  //    away from the studio tab also hides them (handled in the shell
  //    via the active-tab check).
  const [studioAnimOpen, setStudioAnimOpen] = useState(true);
  const [studioBgOpen, setStudioBgOpen] = useState(true);
  const [studioActionsOpen, setStudioActionsOpen] = useState(true);
  const [studioMeshOpen, setStudioMeshOpen] = useState(true);
  const [studioObjectsOpen, setStudioObjectsOpen] = useState(true);
  const [studioSpotlightOpen, setStudioSpotlightOpen] = useState(true);

  // -- File Explorer pane state.
  //    Lives at the shell level so the pane survives tab switches
  //    and persists its last folder root across app restarts via
  //    localStorage. Studio shell is the only one that renders the
  //    pane (other shells lack a dock system).
  const [fileExplorerOpen, setFileExplorerOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem('file-explorer-open') === '1'; } catch { return false; }
  });
  const [fileExplorerRoot, setFileExplorerRoot] = useState<FileExplorerRoot | null>(() => {
    try {
      // Only folder roots are persisted across sessions — WAD mounts
      // are session-bound (Rust unmounts everything on shutdown). On
      // load, hydrate the saved folder path into a structured root.
      const raw = window.localStorage.getItem('file-explorer-root');
      if (!raw) return null;
      return { kind: 'folder', path: raw };
    } catch { return null; }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('file-explorer-open', fileExplorerOpen ? '1' : '0');
    } catch { /* ignore */ }
  }, [fileExplorerOpen]);
  useEffect(() => {
    try {
      if (fileExplorerRoot && fileExplorerRoot.kind === 'folder') {
        window.localStorage.setItem('file-explorer-root', fileExplorerRoot.path);
      } else {
        window.localStorage.removeItem('file-explorer-root');
      }
    } catch { /* ignore */ }
  }, [fileExplorerRoot]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === 'string') {
        // Close any previously-mounted WAD root before switching.
        setFileExplorerRoot(prev => {
          if (prev?.kind === 'wad') {
            invoke('wad_close', { id: prev.mountId }).catch(() => {});
          }
          return { kind: 'folder', path: picked };
        });
        setFileExplorerOpen(true);
        setWelcomeOverride('hide');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`Open folder failed: ${msg}`);
    }
  }, []);

  // ── Fetch-Vanilla-Animations dialog state ────────────────────
  // The picker is mounted at the App level so it overlays everything
  // (studio canvas / dock panes / floating windows). The promise
  // resolver pattern lets `openFetchAnimationsDialog` await the
  // user's confirm/cancel from the call site (Pose panel button)
  // without React-pushing the resolver through props.
  const [fetchAnimDialog, setFetchAnimDialog] = useState<{
    open: boolean;
    sknPath: string;
    champion: string | null;
    skinNum: number | null;
    reason: string;
  } | null>(null);
  const fetchAnimResolveRef = useRef<((count: number) => void) | null>(null);

  // Per-studio-tab map of borrowed-animation directories returned by
  // `fetch_vanilla_animations`. The reload call passes the borrowed
  // dir to the disk-anim Tauri command so the extra ANMs show up in
  // the Pose panel, and tab close fires `cleanup_anim_borrow_dir` so
  // the temp folder doesn't accumulate under the config dir.
  const borrowedAnimDirsRef = useRef<Map<string, string>>(new Map());

  const runFetchVanillaAnimations = useCallback(async (
    sknPath: string,
    champion: string,
    skinNum: number,
    usePbe: boolean,
  ): Promise<number> => {
    try {
      setStatusMessage(`Fetching ${champion} skin${skinNum} animations…`);
      const result = await invoke<{
        borrowed_dir: string;
        final_count: number;
        base_layer_included: boolean;
        wad_name: string;
      }>('fetch_vanilla_animations', {
        sknDiskPath: sknPath,
        champion,
        skinNum,
        usePbe,
      });
      // Track the borrowed dir against the active studio tab so the
      // reload reads it and tab-close can clean it up. If a previous
      // borrow already existed for this tab, schedule its cleanup —
      // a fresh fetch supersedes the old set.
      const tabId = activeTabIdRef.current ?? '';
      if (tabId) {
        const prior = borrowedAnimDirsRef.current.get(tabId);
        if (prior && prior !== result.borrowed_dir) {
          invoke('cleanup_anim_borrow_dir', { borrowDir: prior }).catch(() => {});
        }
        borrowedAnimDirsRef.current.set(tabId, result.borrowed_dir);
      }
      // Refresh the active SKN's animation listing so the new ANMs
      // appear in the Pose panel without a model reload. Pass the
      // borrowed dir so the Tauri command merges it into the result.
      try {
        const scene = studioScenesRef.current.get(tabId);
        await scene?.reloadActiveObjectAnimations(result.borrowed_dir);
      } catch (e) {
        console.warn('[fetch-animations] scene reload failed:', e);
      }
      const layered = result.base_layer_included
        ? ' (base + skin overrides)'
        : '';
      setStatusMessage(
        `Loaded ${result.final_count} animations from ${result.wad_name}${layered}`,
      );
      return result.final_count;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`Fetch animations failed: ${msg}`);
      return 0;
    }
  }, []);

  const handleOpenFetchAnimationsDialog = useCallback(async (sknPath: string): Promise<number> => {
    const { detectChampionAndSkin } = await import('./lib/fetchAnimDetect');
    const detected = detectChampionAndSkin(sknPath);
    // Skip the picker when both fields are known — most mod folders
    // give us enough signal. We still confirm via the status toast.
    if (detected.confident && detected.champion && detected.skinNum !== null) {
      return runFetchVanillaAnimations(sknPath, detected.champion, detected.skinNum, false);
    }
    return new Promise<number>(resolve => {
      fetchAnimResolveRef.current = resolve;
      setFetchAnimDialog({
        open: true,
        sknPath,
        champion: detected.champion,
        skinNum: detected.skinNum,
        reason: detected.reason,
      });
    });
  }, [runFetchVanillaAnimations]);

  const handleRevealInExplorer = useCallback((filePath: string) => {
    if (!filePath) return;
    const norm = filePath.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    if (idx <= 0) return;
    const parent = norm.slice(0, idx);
    // If the file is already under the current FOLDER root we keep
    // that root (so expanded state survives); otherwise switch to
    // the file's parent folder. WAD roots can't host on-disk reveal,
    // so we always swap them out for the parent folder.
    setFileExplorerRoot(prev => {
      if (prev?.kind === 'folder') {
        const prevNorm = prev.path.replace(/\\/g, '/');
        if (norm.startsWith(prevNorm + '/')) return prev;
      }
      if (prev?.kind === 'wad') {
        invoke('wad_close', { id: prev.mountId }).catch(() => {});
      }
      return { kind: 'folder', path: parent };
    });
    setFileExplorerOpen(true);
    // Tell the pane to select + scroll to the target. It already
    // listens to localStorage `file-explorer-selected` for hydration,
    // so writing here lands cleanly even when the pane is mid-mount.
    try { window.localStorage.setItem('file-explorer-selected', norm); } catch { /* ignore */ }
    // Also stash an "expand-and-reveal" pulse so the pane knows to
    // open every ancestor between root and target.
    try {
      window.localStorage.setItem('file-explorer-reveal-pulse', `${Date.now()}|${norm}`);
      window.dispatchEvent(new Event('file-explorer-reveal'));
    } catch { /* ignore */ }
  }, []);

  const handleOpenWadInExplorer = useCallback(async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: 'WAD archive', extensions: ['wad', 'client'] }],
      });
      if (typeof picked !== 'string') return;
      // `wad_open` returns the mount id + display name. Stash that in
      // the structured root so the pane knows to fetch via
      // `wad_list_entries` instead of `list_directory`.
      const info = await invoke<{ id: number; name: string; path: string }>('wad_open', { path: picked });
      setFileExplorerRoot(prev => {
        if (prev?.kind === 'wad' && prev.mountId !== info.id) {
          invoke('wad_close', { id: prev.mountId }).catch(() => {});
        }
        return { kind: 'wad', mountId: info.id, wadPath: info.path, label: info.name };
      });
      setFileExplorerOpen(true);
      setWelcomeOverride('hide');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`Open WAD failed: ${msg}`);
    }
  }, []);

  const [studioPhotoWidth, setStudioPhotoWidth] = useState(1024);
  const [studioPhotoHeight, setStudioPhotoHeight] = useState(1024);

  // -- Photo Studio scene registry.
  //    Each StudioTab mounts a Babylon scene and registers its handle
  //    here keyed by tab id. The dock panels (anim picker, background
  //    switcher, photo capture) pull the active studio's scene from
  //    this map by tabId so they can mutate without prop-drilling.
  const studioScenesRef = useRef<Map<string, StudioScene>>(new Map());
  // Scene data waiting for its StudioTab to mount + register. `Open`
  // creates the tab synchronously but the Babylon scene is built in
  // the StudioTab's mount effect — so we stash the parsed data here
  // and apply it the moment `registerStudioScene` fires for that id.
  const pendingStudioLoadsRef = useRef<Map<string, StudioSceneData>>(new Map());
  // Per-tab queue of disk paths the Viewer asked us to load into a
  // fresh studio scene. Picked up by `registerStudioScene` once the
  // scene mounts. Same lifecycle rules as `pendingStudioLoadsRef` —
  // entry stays put across StrictMode's double-mount, cleared in
  // `handleTabClose`.
  const pendingStudioModelLoadsRef = useRef<Map<string, string>>(new Map());
  const registerStudioScene = useCallback((tabId: string, scene: StudioScene) => {
    studioScenesRef.current.set(tabId, scene);
    const pending = pendingStudioLoadsRef.current.get(tabId);
    if (pending) {
      // Do NOT delete the pending entry here. React StrictMode in
      // dev double-invokes mount effects (mount → unmount → mount):
      // the first, throwaway scene would consume + delete the entry,
      // then get disposed, leaving the real second scene with
      // nothing to load. Keeping the entry lets the lasting scene
      // pick it up too. It's cleared for real in `handleTabClose`.
      scene.loadFromData(pending)
        .then(() => {
          // Fresh load: not dirty, and undo can't reach past it.
          scene.resetUndoHistory();
          scene.markSaved();
        })
        .catch((e) => console.warn('[Studio] scene load failed:', e));
    }
    const pendingModelPath = pendingStudioModelLoadsRef.current.get(tabId);
    if (pendingModelPath) {
      scene
        .addModelFromDisk(pendingModelPath)
        .then(() => scene.markSaved())
        .catch((e) => console.warn('[Studio] viewer-handoff load failed:', e));
    }
  }, []);
  const unregisterStudioScene = useCallback((tabId: string) => {
    studioScenesRef.current.delete(tabId);
    // Pending load is intentionally NOT cleared here — `unregister`
    // fires on StrictMode's throwaway unmount too. Cleared on real
    // tab close (`handleTabClose`).
  }, []);
  const getStudioScene = useCallback((tabId: string): StudioScene | null => {
    return studioScenesRef.current.get(tabId) ?? null;
  }, []);

  // StudioTab subscribes to its scene's change events and calls this
  // so the tab's `isModified` flag tracks the scene's dirty state —
  // which drives the tab-bar dot and the save-before-close prompt.
  const notifyStudioDirty = useCallback((tabId: string, dirty: boolean) => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (!tab || tab.isModified === dirty) return prev;
      return prev.map(t => (t.id === tabId ? { ...t, isModified: dirty } : t));
    });
  }, []);

  // Serialize the active studio scene to a `.studio.json` file.
  // `saveAs` (or a tab with no path yet) routes through the save
  // dialog; otherwise it writes straight to the tab's existing path.
  const studioSaveActiveTab = useCallback(async (saveAs: boolean): Promise<boolean> => {
    const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    if (!tab || tab.tabType !== 'studio') return false;
    const scene = studioScenesRef.current.get(tab.id);
    if (!scene) return false;
    let path = tab.filePath;
    if (saveAs || !path) {
      const baseName = (tab.fileName || 'studio-scene').replace(/\.studio\.json$/i, '');
      const picked = await saveDialog({
        defaultPath: `${baseName}.studio.json`,
        filters: [{ name: 'Jade Studio Scene', extensions: ['studio.json'] }],
      });
      if (!picked) return false;
      path = picked;
    }
    try {
      const data = scene.serialize();
      await invoke('write_text_file', { path, content: JSON.stringify(data, null, 2) });
      scene.markSaved();
      const fileName = path.split(/[\\/]/).pop() ?? tab.fileName;
      setTabs(prev => prev.map(t =>
        t.id === tab.id ? { ...t, filePath: path, fileName, isModified: false } : t,
      ));
      setStatusMessage(`Saved ${path}`);
      statusMessageRef.current = `Saved ${path}`;
      return true;
    } catch (e) {
      setStatusMessage(`Studio save failed: ${e}`);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open a `.studio.json` from a known path into a new studio tab.
  // The actual scene rebuild is deferred to `registerStudioScene`
  // via the pending-loads map. Shared by the menu's "Open Studio
  // Scene…", drag-drop, and the file-association open path.
  const studioOpenSceneFromPath = useCallback(async (picked: string) => {
    let data: StudioSceneData;
    try {
      const content = await invoke<string>('read_text_file', { path: picked });
      data = JSON.parse(content) as StudioSceneData;
    } catch (e) {
      setStatusMessage(`Studio: couldn't read scene — ${e}`);
      return;
    }
    if (!data || !Array.isArray(data.objects)) {
      setStatusMessage('Studio: not a valid .studio.json');
      return;
    }
    // If the scene's already open in a tab, just focus it.
    const existing = tabsRef.current.find(
      t => t.tabType === 'studio' && t.filePath?.toLowerCase() === picked.toLowerCase(),
    );
    if (existing) {
      ensureStudioShell();
      setActiveTabId(existing.id);
      return;
    }
    saveCurrentViewState();
    ensureStudioShell();
    const fileName = picked.split(/[\\/]/).pop() ?? 'Studio';
    const newTab: EditorTab = { ...createStudioTab(), filePath: picked, fileName };
    pendingStudioLoadsRef.current.set(newTab.id, data);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setStudioAnimOpen(true);
    setStudioBgOpen(true);
    setStudioActionsOpen(true);
    setStudioMeshOpen(true);
    setStudioObjectsOpen(true);
    setStatusMessage(`Opened ${picked}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureStudioShell, saveCurrentViewState]);

  // Stable ref so the early-defined `openFileFromPath` + drag-drop
  // listener can route `.studio.json` here without a forward-decl.
  studioOpenSceneFromPathRef.current = studioOpenSceneFromPath;

  // Menu / shell entry — pops the open dialog, then delegates.
  const studioOpenScene = useCallback(async () => {
    const picked = await openDialog({
      filters: [{ name: 'Jade Studio Scene', extensions: ['studio.json', 'json'] }],
    });
    if (!picked || Array.isArray(picked)) return;
    await studioOpenSceneFromPath(picked);
  }, [studioOpenSceneFromPath]);

  const onNewStudioScene = useCallback(() => {
    saveCurrentViewState();
    ensureStudioShell();
    const newTab = createStudioTab();
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    // Re-open the panels so a fresh scene always shows the full UI,
    // even if the user dismissed some panels in a previous studio tab.
    setStudioAnimOpen(true);
    setStudioBgOpen(true);
    setStudioActionsOpen(true);
    setStudioMeshOpen(true);
    setStudioObjectsOpen(true);
    setStatusMessage(`New ${newTab.fileName}`);
    statusMessageRef.current = `New ${newTab.fileName}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureStudioShell]);

  // Viewer's "Open in BIN editor" handler. Receives ritobin text +
  // the BIN's filename, creates a fresh editor tab with that content,
  // and dismisses the welcome overlay. The tab has no filePath because
  // the BIN lives inside a WAD chunk, not on disk — Save / Save As
  // will prompt for a destination if the user wants to persist edits.
  const handleOpenSkinBinAsText = useCallback(
    (text: string, displayName: string) => {
      saveCurrentViewState();
      const newTab: EditorTab = {
        ...createTab(null, text),
        fileName: displayName,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
      setWelcomeOverride('hide');
      setStatusMessage(`Opened ${displayName} from Viewer`);
      statusMessageRef.current = `Opened ${displayName} from Viewer`;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [],
  );

  // Viewer's "Send to Photo Studio" handler. Extracts the skin's
  // entire folder (SKN, SKL, BIN, textures, particles) to a temp disk
  // dir, then opens a new studio scene that picks up the model via the
  // pending-load queue. We pre-extract instead of teaching the Studio
  // to read WADs — `read_skn_textures_disk` does the rest as if the
  // user had pointed Studio at a vanilla extracted mod tree.
  const handleSendMeshToStudio = useCallback(
    async (
      mountId: number,
      sknChunkHashHex: string,
      champion: string,
      skinNum: number,
      label: string,
      shadowForm: boolean,
      chromaSkinNum: number | null,
      textureBindings: Array<{ submeshName: string; chunkHashHex: string | null }> | null,
    ) => {
      try {
        const sknDiskPath = await invoke<string>('viewer_extract_for_studio', {
          id: mountId,
          champion,
          skinNum,
          sknChunkHashHex,
          shadowForm,
          chromaSkinNum,
          // Authoritative per-submesh binding the viewer resolved
          // (and we know renders correctly). Rust writes it as a
          // sidecar JSON in the extracted folder; the studio reads
          // it on load instead of re-deriving from the disk BIN.
          textureBindings,
        });
        // Spin up a fresh studio tab + queue the disk load against it.
        saveCurrentViewState();
        ensureStudioShell();
        const newTab = createStudioTab();
        pendingStudioModelLoadsRef.current.set(newTab.id, sknDiskPath);
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        setStudioAnimOpen(true);
        setStudioBgOpen(true);
        setStudioActionsOpen(true);
        setStudioMeshOpen(true);
        setStudioObjectsOpen(true);
        setWelcomeOverride('hide');
        setStatusMessage(`Sent ${label} to Photo Studio`);
        statusMessageRef.current = `Sent ${label} to Photo Studio`;
      } catch (e) {
        console.warn('[viewer] send-to-photo-studio failed:', e);
        setStatusMessage(`Send to Photo Studio failed: ${e}`);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [ensureStudioShell],
  );

  const handleCreateNewFile = (fileName: string) => {
    // Build an unsaved tab with the chosen name. filePath stays null
    // (the file isn't on disk yet), but tab.fileName carries the
    // extension so Monaco language detection and the panel switch
    // (markdown vs bin tools) pick the right behavior.
    saveCurrentViewState();
    const newTab: EditorTab = {
      ...createTab(null, ''),
      fileName,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setShowNewFileDialog(false);
    setStatusMessage(`New file: ${fileName}`);
    statusMessageRef.current = `New file: ${fileName}`;
  };

  const handleOpen = async () => {
    try {
      // Block hash status updates while opening file
      allowHashStatusUpdateRef.current = false;
      const result = await openAnyEditorFile();
      if (result) {
        // Troybin / inibin sources skip the text-content path — route
        // through `openFileFromPath` which builds the dedicated tab.
        const lowerExt = result.path.toLowerCase().slice(result.path.lastIndexOf('.'));
        if (lowerExt === '.troybin' || lowerExt === '.inibin') {
          await openFileFromPath(result.path);
          allowHashStatusUpdateRef.current = true;
          return;
        }
        setFileLoading({ name: getFileName(result.path) });
        try {
          // Bin and .py sidecars run through the bin pipeline (which also
          // handles the Quartz py-sidecar workflow). Plain-text files
          // (json, txt, md, etc.) are read directly and skip linked-bin
          // resolution since that's a bin-only feature.
          const isBin = isBinLikePath(result.path);
          const resolvedContent = isBin
            ? await readBinForEditor(result.path, result.content)
            : result.content;
          setFileLoading({ name: getFileName(result.path), detail: 'Rendering editor…' });
          addTab(result.path, resolvedContent);
          setStatusMessage(`Opened ${result.path}`);
          statusMessageRef.current = `Opened ${result.path}`;

          if (result.path) {
            await addToRecentFiles(result.path);
          }

          if (isBin) {
            await openLinkedBinFiles(result.path, resolvedContent);
          }
        } finally {
          requestAnimationFrame(() => setFileLoading(null));
        }

        // Re-enable hash status updates after file is opened
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 2000);
      }
    } catch (error) {
      console.error('Failed to open file:', error);
      setStatusMessage(`Error: ${error}`);
      statusMessageRef.current = `Error: ${error}`;
      setFileLoading(null);
      setTimeout(() => {
        allowHashStatusUpdateRef.current = true;
      }, 2000);
    }
  };

  const openLinkedBinFiles = async (filePath: string, content: string) => {
    try {
      const importLinked = await invoke<string>('get_preference', {
        key: 'ImportLinkedBins',
        defaultValue: 'False'
      });

      if (importLinked !== 'True') return;

      const extension = filePath.toLowerCase().split('.').pop();
      if (extension !== 'bin') return;

      const recursiveEnabled = await invoke<string>('get_preference', {
        key: 'RecursiveLinkedBins',
        defaultValue: 'False'
      }) === 'True';

      // Block hash status updates while loading linked files
      allowHashStatusUpdateRef.current = false;
      setStatusMessage('Loading linked files...');
      statusMessageRef.current = 'Loading linked files...';

      // Accumulate results from the recursive walker and flush them
      // into the tab list as a single batch. The per-result callback
      // used to call `addTab` directly, which switched the active
      // tab N times in a row (each one swapping the Monaco model →
      // measurable lag on big BINs with 20-30 dependencies).
      const collected: LinkedBinResult[] = [];
      const linkedResults = await findAndOpenLinkedBins(
        filePath,
        content,
        recursiveEnabled,
        (result: LinkedBinResult) => {
          collected.push(result);
        }
      );
      if (collected.length > 0) {
        addTabsBatch(collected.map(r => ({ filePath: r.path, content: r.content })));
      }

      if (linkedResults.length > 0) {
        setStatusMessage(`Loaded ${linkedResults.length} linked file(s)`);
        statusMessageRef.current = `Loaded ${linkedResults.length} linked file(s)`;
      }

      // Re-enable hash status updates after loading linked files
      setTimeout(() => {
        allowHashStatusUpdateRef.current = true;
      }, 2000);
    } catch (error) {
      console.error('Error opening linked bin files:', error);
    }
  };

  const handleSave = async () => {
    // Studio tabs serialize their Babylon scene to `.studio.json`
    // rather than going through the text/BIN save path.
    if (activeTab?.tabType === 'studio') {
      void studioSaveActiveTab(false);
      return;
    }
    if (!activeTab || !isEditorTab(activeTab)) return;

    try {
      // Block hash status updates while saving
      allowHashStatusUpdateRef.current = false;
      if (activeTab.filePath) {
        // Read content from editor for active tab, or from state for inactive tabs
        const content = editorRef.current?.getValue() || activeTab.content;
        const isBin = isBinLikePath(activeTab.filePath);
        if (isBin) {
          await persistPySidecarIfNeeded(activeTab.filePath, content);
        }
        await saveAnyFileToPath(content, activeTab.filePath);
        try {
          if (isBin && quartzInteropEnabled) {
            const session = quartzSessionsRef.current.get(activeTab.filePath.toLowerCase());
            const mode = session?.mode || 'paint';
            await invoke('notify_quartz_bin_updated', {
              binPath: activeTab.filePath,
              mode,
            });
          }
        } catch (interopErr) {
          console.warn('[QuartzInterop][Jade] notify_quartz_bin_updated failed on save:', interopErr);
        }
        // Update mtime so auto-reload poller and Quartz poller don't trigger on our own save
        // Must await to prevent race with the 2s poll interval
        try {
          const savedMtime = await invoke<number>('get_file_mtime', { path: activeTab.filePath });
          editorMtimeRef.current.set(activeTab.id, savedMtime);
          // Also update Quartz session mtime + snapshot so its poller skips this change
          const quartzKey = activeTab.filePath.toLowerCase();
          const quartzSession = quartzSessionsRef.current.get(quartzKey);
          if (quartzSession) {
            quartzSessionsRef.current.set(quartzKey, {
              ...quartzSession,
              lastSeenMtime: savedMtime,
              snapshotContent: content,
              forceContentCheck: false,
            });
          }
        } catch { /* ignore */ }
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTabId ? { ...t, content, isModified: false } : t
          )
        );
        // Saved successfully — the jadelib texture inserts tracked for
        // this bin are now persisted references, no cleanup needed.
        jadelibInsertsRef.current.delete(activeTab.filePath);
        // Keep this path fresh at the top of the recent-files list.
        await addToRecentFiles(activeTab.filePath);
        setStatusMessage(`Saved ${activeTab.filePath}`);
        statusMessageRef.current = `Saved ${activeTab.filePath}`;
        // Re-enable hash status updates after save
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 2000);
      } else {
        handleSaveAs();
      }
    } catch (error) {
      console.error('Failed to save file:', error);
      setStatusMessage(`Error: ${error}`);
      statusMessageRef.current = `Error: ${error}`;
      alert(`Failed to save file: ${error}`);
      setTimeout(() => {
        allowHashStatusUpdateRef.current = true;
      }, 2000);
    }
  };

  const handleSaveAs = async () => {
    if (activeTab?.tabType === 'studio') {
      void studioSaveActiveTab(true);
      return;
    }
    if (!activeTab || !isEditorTab(activeTab)) return;

    try {
      // Block hash status updates while saving
      allowHashStatusUpdateRef.current = false;
      // Read content from editor for active tab, or from state for inactive tabs
      const content = editorRef.current?.getValue() || activeTab.content;
      const defaultName = activeTab.filePath
        ? getFileName(activeTab.filePath)
        : (activeTab.fileName && activeTab.fileName !== 'Untitled' ? activeTab.fileName : 'Untitled.txt');
      const newPath = await saveAnyFileAs(content, defaultName);
      if (newPath) {
        const isBin = isBinLikePath(newPath);
        if (isBin) {
          await persistPySidecarIfNeeded(newPath, content);
        }
        try {
          if (isBin && quartzInteropEnabled) {
            const oldSession = activeTab.filePath
              ? quartzSessionsRef.current.get(activeTab.filePath.toLowerCase())
              : null;
            const mode = oldSession?.mode || 'paint';
            await invoke('notify_quartz_bin_updated', {
              binPath: newPath,
              mode,
            });
          }
        } catch (interopErr) {
          console.warn('[QuartzInterop][Jade] notify_quartz_bin_updated failed on save-as:', interopErr);
        }
        // Update mtime so pollers don't trigger on our own save
        try {
          const savedMtime = await invoke<number>('get_file_mtime', { path: newPath });
          editorMtimeRef.current.set(activeTab.id, savedMtime);
          const quartzKey = newPath.toLowerCase();
          const quartzSession = quartzSessionsRef.current.get(quartzKey);
          if (quartzSession) {
            quartzSessionsRef.current.set(quartzKey, {
              ...quartzSession,
              lastSeenMtime: savedMtime,
              snapshotContent: content,
              forceContentCheck: false,
            });
          }
        } catch { /* ignore */ }
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTabId ? {
              ...t,
              filePath: newPath,
              fileName: getFileName(newPath),
              content,
              isModified: false
            } : t
          )
        );
        // Save-As is the first time a freshly-created file lands on
        // disk — register it in recents so it shows up alongside opened
        // files (and bump recency for an existing path saved elsewhere).
        await addToRecentFiles(newPath);
        setStatusMessage(`Saved ${newPath}`);
        statusMessageRef.current = `Saved ${newPath}`;
        // Re-enable hash status updates after save
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 2000);
      }
    } catch (error) {
      console.error('Failed to save file:', error);
      setStatusMessage(`Error: ${error}`);
      statusMessageRef.current = `Error: ${error}`;
      alert(`Failed to save file: ${error}`);
      setTimeout(() => {
        allowHashStatusUpdateRef.current = true;
      }, 2000);
    }
  };

  // Save every editor tab that has a file path and unsaved changes.
  // Tabs without a file path (untitled) and studio tabs are skipped —
  // those need the Save-As / save-scene dialog flow which can't be
  // batched silently. Reads each tab's latest content from its Monaco
  // model (only the active tab is bound to the visible editor; other
  // models stay live in `monacoModelsRef`) and falls back to the
  // tab's stored `content` if the model was disposed.
  const handleSaveAll = async () => {
    const targets = tabsRef.current.filter(t =>
      isEditorTab(t) && t.filePath && t.isModified,
    );
    if (targets.length === 0) {
      setStatusMessage('Nothing to save.');
      return;
    }
    allowHashStatusUpdateRef.current = false;
    let savedCount = 0;
    const failures: string[] = [];
    for (const tab of targets) {
      if (!tab.filePath) continue;
      try {
        // Active tab reads from the live editor (covers in-flight
        // edits the model has but the tab.content field hasn't
        // synced yet); inactive tabs come straight off their model.
        const fromModel = monacoModelsRef.current.get(tab.id);
        const content = tab.id === activeTabIdRef.current
          ? (editorRef.current?.getValue() ?? fromModel?.getValue() ?? tab.content)
          : (fromModel?.getValue() ?? tab.content);
        const isBin = isBinLikePath(tab.filePath);
        if (isBin) {
          await persistPySidecarIfNeeded(tab.filePath, content);
        }
        await saveAnyFileToPath(content, tab.filePath);
        try {
          if (isBin && quartzInteropEnabled) {
            const session = quartzSessionsRef.current.get(tab.filePath.toLowerCase());
            const mode = session?.mode || 'paint';
            await invoke('notify_quartz_bin_updated', {
              binPath: tab.filePath,
              mode,
            });
          }
        } catch (interopErr) {
          console.warn('[QuartzInterop][Jade] notify_quartz_bin_updated failed on save-all:', interopErr);
        }
        // Keep mtime poller from re-triggering on our own write.
        try {
          const savedMtime = await invoke<number>('get_file_mtime', { path: tab.filePath });
          editorMtimeRef.current.set(tab.id, savedMtime);
          const quartzKey = tab.filePath.toLowerCase();
          const quartzSession = quartzSessionsRef.current.get(quartzKey);
          if (quartzSession) {
            quartzSessionsRef.current.set(quartzKey, {
              ...quartzSession,
              lastSeenMtime: savedMtime,
              snapshotContent: content,
              forceContentCheck: false,
            });
          }
        } catch { /* ignore */ }
        // Snapshot the saved content + clear the dirty flag for this
        // tab. We batch all tab updates into a single setTabs call
        // below to avoid N renders.
        tab.content = content;
        jadelibInsertsRef.current.delete(tab.filePath);
        savedCount += 1;
      } catch (error) {
        console.error(`Failed to save ${tab.filePath}:`, error);
        failures.push(`${getFileName(tab.filePath)}: ${error}`);
      }
    }
    // Single state flip — mark every successfully-saved tab clean
    // (those whose content was mutated above). Failures keep their
    // dirty flag.
    const savedIds = new Set(
      targets
        .filter(t => !failures.some(f => f.startsWith(`${getFileName(t.filePath ?? '')}: `)))
        .map(t => t.id),
    );
    setTabs(prevTabs =>
      prevTabs.map(t => savedIds.has(t.id) ? { ...t, isModified: false } : t),
    );
    if (failures.length === 0) {
      setStatusMessage(`Saved ${savedCount} file${savedCount === 1 ? '' : 's'}`);
      statusMessageRef.current = `Saved ${savedCount} file${savedCount === 1 ? '' : 's'}`;
    } else {
      const detail = failures.slice(0, 2).join('; ');
      const more = failures.length > 2 ? `, +${failures.length - 2} more` : '';
      setStatusMessage(`Saved ${savedCount}, ${failures.length} failed (${detail}${more})`);
      statusMessageRef.current = `Saved ${savedCount}, ${failures.length} failed`;
    }
    setTimeout(() => {
      allowHashStatusUpdateRef.current = true;
    }, 2000);
  };

  // Edit Operations
  const handleUndo = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    editorRef.current?.trigger('keyboard', 'undo', null);
  };
  const handleRedo = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    editorRef.current?.trigger('keyboard', 'redo', null);
  };
  const handleCut = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    document.execCommand('cut');
  };
  const handleCopy = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    document.execCommand('copy');
  };
  const handlePaste = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    document.execCommand('paste');
  };

  // In the Word and Visual Studio shells, find/replace is rendered as a
  // dock pane (left side / bottom) with a custom UI that drives Monaco
  // via the model.findMatches API. We skip Monaco's native find widget
  // so the two UIs don't fight. In VS, opening find leaves general /
  // particle docks open — they live in different docks.
  // The dedicated Find panel was redundant — Replace covers the same
  // search use case plus the rewrite path. Routing the Find action
  // (toolbar magnifier, menu entry, Ctrl+F) at `handleReplace` keeps
  // the icon and shortcut familiar but always opens the combined panel.
  const handleFind = () => { handleReplace(); };

  const handleReplace = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    const useNativeWidget = shellVariant === 'vscode';
    const stackTools = shellVariant === 'visualstudio';
    if (replaceWidgetOpen) {
      if (useNativeWidget) editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
      setReplaceWidgetOpen(false);
    } else {
      if (!stackTools) {
        setGeneralEditPanelOpen(false);
        setParticlePanelOpen(false);
      }
      if (useNativeWidget) editorRef.current?.trigger('keyboard', 'editor.action.startFindReplaceAction', null);
      setReplaceWidgetOpen(true);
      setFindWidgetOpen(false);
    }
  };

  // Open a compare diff between two editor tabs. With exactly two
  // editor tabs open the picker is skipped — one click and the diff
  // is up. With three or more we show a small picker so the user can
  // pin which two to compare. Texture/studio/markdown-preview/etc.
  // tabs are excluded since the diff only makes sense over text.
  const openCompareTab = (leftId: string, rightId: string) => {
    const left = tabsRef.current.find(t => t.id === leftId);
    const right = tabsRef.current.find(t => t.id === rightId);
    if (!left || !right || left.id === right.id) return;
    const compareTab = createCompareTab(left.id, left.fileName, right.id, right.fileName);
    setTabs(prev => [...prev, compareTab]);
    setActiveTabId(compareTab.id);
  };

  const handleCompareFiles = () => {
    const editorTabs = tabsRef.current.filter(isEditorTab);
    if (editorTabs.length < 2) {
      setStatusMessage('Compare Files needs at least two open editor tabs');
      return;
    }
    if (editorTabs.length === 2) {
      openCompareTab(editorTabs[0].id, editorTabs[1].id);
      return;
    }
    // 3+: pre-seed with the active tab on the left and the most
    // recently active OTHER editor tab on the right (falls back to
    // the next-in-list if no other-active info is available).
    const active = activeTabRef.current;
    const activeId = active && isEditorTab(active) ? active.id : editorTabs[0].id;
    const otherId = editorTabs.find(t => t.id !== activeId)?.id ?? editorTabs[0].id;
    setComparePicker({ leftId: activeId, rightId: otherId });
  };

  const swapCompareTabSides = (tabId: string) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== tabId || t.tabType !== 'compare') return t;
      const leftId = t.compareLeftTabId;
      const rightId = t.compareRightTabId;
      const leftTab = prev.find(x => x.id === leftId);
      const rightTab = prev.find(x => x.id === rightId);
      const leftName = leftTab?.fileName ?? '(missing)';
      const rightName = rightTab?.fileName ?? '(missing)';
      return {
        ...t,
        compareLeftTabId: rightId,
        compareRightTabId: leftId,
        fileName: `Compare: ${rightName} ⇄ ${leftName}`,
      };
    }));
  };

  // Batch convert: pick an input folder of .troybin files, then an
  // output folder. Rust walks the input non-recursively, converts
  // each file through the full pipeline, and writes `<stem>.bin.py.txt`
  // to the output. Used for corpus-validation runs.

  // Walk the active BIN + every linked BIN it can find on disk, then
  // open a pretty markdown report listing every asset path each BIN
  // references. The frontmatter `jade-asset-list: true` keys the
  // gallery-view button on these reports vs regular .md files.
  const handleScanBinAssets = async () => {
    const tab = activeTabRef.current;
    if (!tab || !isEditorTab(tab) || !tab.filePath) {
      setStatusMessage('Scan BIN Assets requires a saved BIN file');
      return;
    }
    const lower = tab.filePath.toLowerCase();
    if (!lower.endsWith('.bin')) {
      setStatusMessage('Scan BIN Assets only works on .bin files');
      return;
    }
    setStatusMessage('Scanning BIN assets…');
    try {
      // Rust struct uses snake_case; matches the rest of the
      // codebase's convention (no `serde(rename_all = "camelCase")`
      // on `BinAssetReport`).
      type ReportBin = { label: string; assets: string[]; resolved: boolean };
      type UnusedFile = { rel_path: string; abs_path: string; size_bytes: number };
      type Report = {
        root_label: string;
        mod_root: string | null;
        bins: ReportBin[];
        unused_files: UnusedFile[];
        disk_walked: boolean;
      };
      const report = await invoke<Report>('scan_bin_assets', { path: tab.filePath });

      // Build a cross-reference: asset → list of BINs that reference
      // it. The per-BIN sections also list everything verbatim, but
      // the cross-ref makes "which BIN owns this texture" obvious.
      const xref = new Map<string, string[]>();
      for (const b of report.bins) {
        for (const a of b.assets) {
          const arr = xref.get(a) ?? [];
          arr.push(b.label);
          xref.set(a, arr);
        }
      }
      const totalAssets = xref.size;
      const totalBins = report.bins.length;
      const unresolved = report.bins.filter(b => !b.resolved).length;

      // Markdown body. Frontmatter marker first so the gallery-view
      // toggle on the texture-insert button can detect these reports
      // vs hand-written .md.
      const lines: string[] = [];
      lines.push('---');
      lines.push('jade-asset-list: true');
      lines.push('---');
      lines.push('');
      lines.push(`# BIN asset report`);
      lines.push('');
      lines.push(`Root BIN: \`${report.root_label}\``);
      if (report.mod_root) lines.push(`Mod root: \`${report.mod_root}\``);
      lines.push('');
      lines.push(`- BINs scanned: **${totalBins}**${unresolved > 0 ? ` (${unresolved} unresolved)` : ''}`);
      lines.push(`- Unique asset paths: **${totalAssets}**`);
      lines.push('');

      for (const b of report.bins) {
        lines.push(`## \`${b.label}\`${b.resolved ? '' : '  _(unresolved — file not found)_'}`);
        lines.push('');
        if (b.assets.length === 0) {
          lines.push(b.resolved ? '_No referenced asset paths._' : '_Dependency BIN not on disk — nothing scanned._');
          lines.push('');
          continue;
        }
        for (const a of b.assets) {
          lines.push(`- "${a}"`);
        }
        lines.push('');
      }

      // Unused-files section. We only emit it when the Rust side
      // actually walked the disk; otherwise the absence of unused
      // entries would be misleading (could mean "no mod root" not
      // "nothing unused").
      if (report.disk_walked) {
        const totalBytes = report.unused_files.reduce((s, f) => s + f.size_bytes, 0);
        const humanSize = (n: number) => {
          if (n < 1024) return `${n} B`;
          if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
          if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
          return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
        };
        lines.push(`## Unused files (${report.unused_files.length})${report.unused_files.length > 0 ? ` · ${humanSize(totalBytes)} on disk` : ''}`);
        lines.push('');
        if (report.unused_files.length === 0) {
          lines.push('_Every file in the mod root is referenced by at least one BIN._');
          lines.push('');
        } else {
          lines.push('Use the texture-insert button (image icon) in the toolbar to open the visual gallery — it has an "Unused only" filter and a bulk-delete button for these files.');
          lines.push('');
          for (const u of report.unused_files) {
            lines.push(`- "${u.rel_path}"  _(${humanSize(u.size_bytes)})_`);
          }
          lines.push('');
        }
      }

      const content = lines.join('\n');
      const reportTab = createTab(null, content);
      reportTab.fileName = `Assets: ${getFileName(tab.filePath)}.md`;
      setTabs(prev => [...prev, reportTab]);
      setActiveTabId(reportTab.id);
      const unusedSuffix = report.disk_walked && report.unused_files.length > 0
        ? ` · ${report.unused_files.length} unused`
        : '';
      setStatusMessage(`Scanned ${totalBins} BIN${totalBins === 1 ? '' : 's'} · ${totalAssets} unique asset${totalAssets === 1 ? '' : 's'}${unusedSuffix}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Scan BIN Assets failed: ${msg}`);
    }
  };

  handleNewRef.current = handleNew;
  handleOpenRef.current = handleOpen;
  handleSaveRef.current = () => {
    void handleSave();
  };
  handleSaveAsRef.current = () => {
    void handleSaveAs();
  };
  handleSaveAllRef.current = () => {
    void handleSaveAll();
  };
  handleFindRef.current = handleFind;
  handleReplaceRef.current = handleReplace;
  handleCompareRef.current = handleCompareFiles;
  const handleSelectAll = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    editorRef.current?.trigger('keyboard', 'editor.action.selectAll', null);
  };

  // Fold/unfold all VfxEmitterDefinitionData blocks via folding controller
  const setEmittersFolded = (collapse: boolean) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    // Collect 1-based line numbers of emitter blocks
    const text = model.getValue();
    const lines = text.split('\n');
    const emitterLineSet = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (/VfxEmitterDefinitionData\s*\{/.test(lines[i])) {
        emitterLineSet.add(i + 1);
      }
    }
    if (emitterLineSet.size === 0) return;

    // Access Monaco's internal folding controller
    const foldingCtrl = (editor as any).getContribution('editor.contrib.folding');
    if (!foldingCtrl?.getFoldingModel) return;

    foldingCtrl.getFoldingModel().then((foldingModel: any) => {
      if (!foldingModel) return;
      const regions = foldingModel.regions;
      if (!regions) return;

      for (let i = 0; i < regions.length; i++) {
        const startLine = regions.getStartLineNumber(i);
        if (emitterLineSet.has(startLine) && regions.isCollapsed(i) !== collapse) {
          regions.setCollapsed(i, collapse);
        }
      }
      // Notify the editor to re-render folded regions
      foldingModel.update(regions);
    });
  };

  const foldAllEmitters = () => setEmittersFolded(true);
  const unfoldAllEmitters = () => setEmittersFolded(false);

  // Check if current content has emitters (for context menu)
  const hasEmitters = useCallback(() => {
    const content = editorRef.current?.getValue() || '';
    return /VfxEmitterDefinitionData\s*\{/.test(content);
  }, []);

  const handleGeneralEdit = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    // VS shell can show multiple tool windows simultaneously (different
    // docks); other shells display one at a time and need the others
    // closed first.
    if (shellVariant !== 'visualstudio') {
      setFindWidgetOpen(false);
      setReplaceWidgetOpen(false);
      setParticlePanelOpen(false);
      setBinNavOpen(false);
      editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
    }
    setGeneralEditPanelOpen(!generalEditPanelOpen);
  };

  // Bin Navigation panel toggle. Like General Editing, the classic
  // shells show one tool popup at a time so opening this closes the
  // others; the VS shell stacks dock panes and keeps them all.
  const handleBinNav = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    if (shellVariant !== 'visualstudio') {
      setFindWidgetOpen(false);
      setReplaceWidgetOpen(false);
      setGeneralEditPanelOpen(false);
      setParticlePanelOpen(false);
      editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
    }
    setBinNavOpen(prev => !prev);
  };

  // The scanned-assets markdown report carries a `jade-asset-list: true`
  // frontmatter so the texture-insert button can flip behavior on it
  // (gallery view instead of insert panel). Detect on the live editor
  // content so user edits stay reflected.
  const isAssetListTab = (tab: EditorTab | null | undefined): boolean => {
    if (!tab || !isEditorTab(tab)) return false;
    const text = (activeTabId === tab.id && editorRef.current?.getValue())
      || tab.content
      || '';
    // Frontmatter must be at the very top — same shape the scanner
    // emits. Be permissive on whitespace, exact on the key.
    return /^---\s*\n\s*jade-asset-list\s*:\s*true\s*\n\s*---/i.test(text);
  };

  // VS-shell-only toggles for the lightweight material-override insert
  // tool windows. The classic in-General-Edit-panel modal still works
  // unchanged — these are the dockable panel variants.
  const handleTextureInsert = () => {
    const tab = activeTabRef.current;
    if (!tab || !isEditorTab(tab)) return;
    // Asset-list reports repurpose this button as "open visual gallery"
    // — same icon, different action. Regular MD files stay blocked.
    if (isAssetListTab(tab)) {
      setAssetGalleryTabId(tab.id);
      return;
    }
    setTextureInsertOpen(prev => !prev);
  };
  const handleMaterialInsert = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    setMaterialInsertOpen(prev => !prev);
  };

  // Handle content change from General Edit Panel (undoable, preserves cursor/scroll)
  const handleGeneralEditContentChange = (newContent: string) => {
    if (activeTabId && editorRef.current && isEditorTab(activeTabRef.current)) {
      const editor = editorRef.current;
      const model = editor.getModel();
      if (model) {
        const currentContent = model.getValue();

        // Find the actual changed lines to minimize the edit
        const oldLines = currentContent.split('\n');
        const newLines = newContent.split('\n');

        // Find first different line
        let startLine = 0;
        while (startLine < oldLines.length && startLine < newLines.length &&
          oldLines[startLine] === newLines[startLine]) {
          startLine++;
        }

        // Find last different line (from end)
        let oldEndLine = oldLines.length - 1;
        let newEndLine = newLines.length - 1;
        while (oldEndLine > startLine && newEndLine > startLine &&
          oldLines[oldEndLine] === newLines[newEndLine]) {
          oldEndLine--;
          newEndLine--;
        }

        // Calculate the range to replace (1-indexed for Monaco)
        const startLineNum = startLine + 1;
        const endLineNum = oldEndLine + 1;
        const endColumn = (oldLines[oldEndLine]?.length || 0) + 1;

        // Get the replacement text
        const replacementLines = newLines.slice(startLine, newEndLine + 1);
        const replacementText = replacementLines.join('\n');

        // Get current selections to preserve cursor position on undo
        const selections = editor.getSelections() || [];

        // Use pushEditOperations for proper undo stack with cursor restoration
        // Only push stack element AFTER the edit (not before)
        model.pushEditOperations(
          selections,
          [{
            range: {
              startLineNumber: startLineNum,
              startColumn: 1,
              endLineNumber: endLineNum,
              endColumn: endColumn
            },
            text: replacementText
          }],
          () => selections // Return same selections for undo
        );

        // Push stack element AFTER the edit (only once)
        model.pushStackElement();

        // Update tab content state (mark as modified, content will be synced on tab switch)
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTabId ? { ...t, isModified: true } : t
          )
        );
      }
    }
  };
  const handleOpenLog = () => console.log('Open Log');

  // Tool Operations
  const handleThemes = () => setShowThemesDialog(true);
  const handleMaterialLibrary = () => setShowMaterialLibrary(true);
  const handlePreferences = () => setShowPreferencesDialog(true);
  const handleSettings = () => setShowSettingsDialog(true);
  const handleAbout = () => setShowAboutDialog(true);

  // Helper to check if the active tab is a bin (or .py sidecar) file —
  // i.e. ritobin content. Used to gate particle/material/skin tools so
  // they don't show up on markdown / json / plain-text tabs.
  const isBinFileOpen = (): boolean => {
    if (!activeTab) return false;
    if (!isEditorTab(activeTab)) return false;
    const name = (activeTab.filePath ?? activeTab.fileName).toLowerCase();
    return name.endsWith('.bin') || name.endsWith('.py');
  };

  // Particle Editor handlers
  const handleParticlePanel = () => {
    // Only allow opening if a bin file is loaded
    if (!isBinFileOpen()) return;

    if (shellVariant !== 'visualstudio') {
      setFindWidgetOpen(false);
      setReplaceWidgetOpen(false);
      setGeneralEditPanelOpen(false);
      setBinNavOpen(false);
      editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
    }
    setParticlePanelOpen(prev => !prev);
  };

  const handleParticleEditor = () => {
    // Only allow opening if a bin file is loaded
    if (!isBinFileOpen()) return;

    setParticlePanelOpen(false);
    setParticleDialogOpen(true);
  };

  const handleSendToQuartz = async (mode: 'paint' | 'port' | 'bineditor' | 'vfxhub') => {
    if (!quartzInteropEnabled) {
      setStatusMessage('Quartz communication is disabled in Settings > App Behavior.');
      return;
    }
    try {
      const quartzStatus = await invoke<{ installed: boolean; executable_path?: string | null }>('get_quartz_install_status');
      if (!quartzStatus?.installed) {
        setShowQuartzInstallModal(true);
        setStatusMessage('Quartz is not installed');
        return;
      }
    } catch {
      setShowQuartzInstallModal(true);
      setStatusMessage('Could not verify Quartz installation');
      return;
    }

    if (!activeTab || !activeTab.filePath || !isBinFileOpen()) {
      setStatusMessage('Open a .bin tab before sending to Quartz');
      return;
    }

    const currentContent = editorRef.current?.getValue() || activeTab.content;

    try {
      allowHashStatusUpdateRef.current = false;
      setStatusMessage(`Sending ${activeTab.fileName} to Quartz (${mode})...`);

      if (activeTab.isModified) {
        await persistPySidecarIfNeeded(activeTab.filePath, currentContent);
        await saveBinFile(currentContent, activeTab.filePath);
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTab.id ? { ...t, content: currentContent, isModified: false } : t
          )
        );
      }

      const currentMtime = await invoke<number>('get_file_mtime', { path: activeTab.filePath }).catch(() => null);
      quartzSessionsRef.current.set(activeTab.filePath.toLowerCase(), {
        filePath: activeTab.filePath,
        mode,
        snapshotContent: currentContent,
        lastSeenMtime: currentMtime,
        pendingEntryId: null,
        forceContentCheck: false,
      });

      await invoke('send_bin_to_quartz', {
        binPath: activeTab.filePath,
        mode,
      });

      setStatusMessage(`Sent ${activeTab.fileName} to Quartz (${mode})`);
    } catch (error) {
      const errorText = String(error || '');
      if (errorText.toLowerCase().includes('could not find quartz executable')) {
        setShowQuartzInstallModal(true);
      }
      setStatusMessage(`Failed to send to Quartz: ${error}`);
    } finally {
      setTimeout(() => {
        allowHashStatusUpdateRef.current = true;
      }, 2000);
    }
  };

  const updateQuartzDiffTabStatus = useCallback((entryId: string, status: 'accepted' | 'rejected') => {
    setTabs(prevTabs => prevTabs.map(tab => (
      tab.tabType === 'quartz-diff' && tab.diffEntryId === entryId
        ? { ...tab, diffStatus: status }
        : tab
    )));
  }, []);

  const getQuartzEntriesForFile = useCallback((filePath: string) => {
    const normalized = filePath.toLowerCase();
    return quartzHistoryEntries
      .filter((item) => item.filePath.toLowerCase() === normalized)
      .sort((a, b) => a.detectedAt - b.detectedAt);
  }, [quartzHistoryEntries]);

  const queueQuartzDiffForSession = useCallback((sessionKey: string, session: QuartzEditSession, afterContent: string) => {
    if (!afterContent || afterContent === session.snapshotContent) {
      if (QUARTZ_INTEROP_DEBUG) {
        console.log('[QuartzInterop][Jade] queue diff skipped (no content delta)', { filePath: session.filePath });
      }
      return false;
    }

    const matchingTab = tabsRef.current.find(t => t.filePath?.toLowerCase() === session.filePath.toLowerCase());
    if (!matchingTab) {
      if (QUARTZ_INTEROP_DEBUG) {
        console.log('[QuartzInterop][Jade] queue diff skipped (tab not open)', { filePath: session.filePath });
      }
      quartzSessionsRef.current.set(sessionKey, {
        ...session,
        snapshotContent: afterContent,
        pendingEntryId: null,
        forceContentCheck: false,
      });
      return false;
    }

    const entryId = `quartz-${matchingTab.id}-${Date.now()}`;
    const newEntry: QuartzHistoryEntry = {
      id: entryId,
      tabId: matchingTab.id,
      filePath: session.filePath,
      fileName: getFileName(session.filePath),
      mode: session.mode,
      beforeContent: session.snapshotContent,
      afterContent,
      detectedAt: Date.now(),
      status: 'pending',
    };

    updateTabContentFromExternal(matchingTab.id, afterContent);
    setQuartzHistoryEntries(prev => {
      const combined = [newEntry, ...prev];
      const perFileCounts = new Map<string, number>();
      const pruned: QuartzHistoryEntry[] = [];
      for (const entry of combined) {
        const key = entry.filePath.toLowerCase();
        const count = perFileCounts.get(key) || 0;
        if (count >= MAX_QUARTZ_HISTORY_PER_FILE) continue;
        perFileCounts.set(key, count + 1);
        pruned.push(entry);
      }
      return pruned;
    });

    setTabs(prevTabs => {
      const existingDiffTab = prevTabs.find(tab =>
        tab.tabType === 'quartz-diff' &&
        tab.diffSourceFilePath?.toLowerCase() === session.filePath.toLowerCase()
      );

      if (existingDiffTab) {
        return prevTabs.map(tab => (
          tab.id === existingDiffTab.id
            ? {
              ...tab,
              diffEntryId: entryId,
              diffStatus: 'pending',
              diffOriginalContent: session.snapshotContent,
              diffModifiedContent: afterContent,
              diffMode: session.mode,
            }
            : tab
        ));
      }

      const diffTab = createQuartzDiffTab({
        entryId,
        sourceTabId: matchingTab.id,
        sourceFilePath: session.filePath,
        fileName: getFileName(session.filePath),
        mode: session.mode,
        originalContent: session.snapshotContent,
        modifiedContent: afterContent,
        status: 'pending',
      });
      return [...prevTabs, diffTab];
    });

    setStatusMessage(`Quartz updated ${getFileName(session.filePath)} (${session.mode}) - diff tab added`);
    if (QUARTZ_INTEROP_DEBUG) {
      console.log('[QuartzInterop][Jade] Diff entry created', {
        filePath: session.filePath,
        mode: session.mode,
        entryId,
      });
    }
    quartzSessionsRef.current.set(sessionKey, {
      ...session,
      snapshotContent: afterContent,
      pendingEntryId: entryId,
      forceContentCheck: false,
    });
    return true;
  }, [updateTabContentFromExternal]);

  const switchQuartzDiffRevision = useCallback((tabId: string, direction: 'prev' | 'next') => {
    setTabs((prevTabs) => {
      const diffTab = prevTabs.find((tab) => tab.id === tabId && tab.tabType === 'quartz-diff');
      if (!diffTab || !diffTab.diffSourceFilePath) return prevTabs;

      const entries = getQuartzEntriesForFile(diffTab.diffSourceFilePath);
      if (entries.length <= 1) return prevTabs;

      const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === diffTab.diffEntryId));
      const targetIndex =
        direction === 'prev'
          ? (currentIndex <= 0 ? entries.length - 1 : currentIndex - 1)
          : (currentIndex >= entries.length - 1 ? 0 : currentIndex + 1);
      const targetEntry = entries[targetIndex];
      if (!targetEntry) return prevTabs;

      return prevTabs.map((tab) => (
        tab.id === tabId
          ? {
            ...tab,
            diffEntryId: targetEntry.id,
            diffStatus: targetEntry.status,
            diffOriginalContent: targetEntry.beforeContent,
            diffModifiedContent: targetEntry.afterContent,
            diffMode: targetEntry.mode,
          }
          : tab
      ));
    });
  }, [getQuartzEntriesForFile]);

  const handleAcceptQuartzHistory = useCallback((entryId: string) => {
    const entry = quartzHistoryEntries.find(item => item.id === entryId);
    if (!entry) return;

    updateTabContentFromExternal(entry.tabId, entry.afterContent);
    setQuartzHistoryEntries(prev => prev.map(item =>
      item.id === entryId ? { ...item, status: 'accepted' } : item
    ));
    const sessionKey = entry.filePath.toLowerCase();
    const session = quartzSessionsRef.current.get(sessionKey);
    if (session) {
      quartzSessionsRef.current.set(sessionKey, {
        ...session,
        snapshotContent: entry.afterContent,
        pendingEntryId: session.pendingEntryId === entryId ? null : session.pendingEntryId,
        forceContentCheck: false,
      });
      invoke<number>('get_file_mtime', { path: entry.filePath })
        .then((mtime) => {
          const latest = quartzSessionsRef.current.get(sessionKey);
          if (!latest) return;
          quartzSessionsRef.current.set(sessionKey, {
            ...latest,
            lastSeenMtime: mtime,
            forceContentCheck: false,
          });
        })
        .catch(() => { });
    }
    updateQuartzDiffTabStatus(entryId, 'accepted');
    setStatusMessage(`Accepted Quartz edit for ${entry.fileName}`);
  }, [quartzHistoryEntries, updateQuartzDiffTabStatus, updateTabContentFromExternal]);

  const handleRejectQuartzHistory = useCallback(async (entryId: string) => {
    const entry = quartzHistoryEntries.find(item => item.id === entryId);
    if (!entry) return;

    try {
      await persistPySidecarIfNeeded(entry.filePath, entry.beforeContent);
      // Always sync sidecar for Quartz reject flow, independent of user preference.
      await persistPySidecarForQuartzInterop(entry.filePath, entry.beforeContent);
      await writeBinDirect(entry.beforeContent, entry.filePath);
      if (quartzInteropEnabled) {
        await invoke('notify_quartz_bin_updated', {
          binPath: entry.filePath,
          mode: entry.mode,
        }).catch(() => null);
      }
      const mtimeAfterReject = await invoke<number>('get_file_mtime', { path: entry.filePath }).catch(() => null);
      const sessionKey = entry.filePath.toLowerCase();
      const session = quartzSessionsRef.current.get(sessionKey);
      if (session) {
      quartzSessionsRef.current.set(sessionKey, {
        ...session,
        snapshotContent: entry.beforeContent,
        pendingEntryId: session.pendingEntryId === entryId ? null : session.pendingEntryId,
        lastSeenMtime: mtimeAfterReject ?? session.lastSeenMtime,
        forceContentCheck: false,
      });
      }
      updateTabContentFromExternal(entry.tabId, entry.beforeContent);
      setQuartzHistoryEntries(prev => prev.map(item =>
        item.id === entryId ? { ...item, status: 'rejected' } : item
      ));
      updateQuartzDiffTabStatus(entryId, 'rejected');
      setStatusMessage(`Rejected Quartz edit for ${entry.fileName}`);
    } catch (error) {
      setStatusMessage(`Failed to reject Quartz edit: ${error}`);
    }
  }, [persistPySidecarForQuartzInterop, persistPySidecarIfNeeded, quartzHistoryEntries, quartzInteropEnabled, updateQuartzDiffTabStatus, updateTabContentFromExternal]);

  useEffect(() => {
    if (quartzInteropEnabled) return;
    quartzSessionsRef.current.clear();
    setQuartzHistoryEntries([]);
  }, [quartzInteropEnabled]);

  useEffect(() => {
    if (!quartzInteropEnabled) {
      return;
    }
    let stopped = false;

    const consumeHandoff = async () => {
      if (stopped) return;
      try {
        const handoffs = await invoke<InteropHandoff[]>('consume_interop_handoff');
        if (!Array.isArray(handoffs) || handoffs.length === 0) return;
        if (QUARTZ_INTEROP_DEBUG) {
          console.log('[QuartzInterop][Jade] Consumed handoffs', handoffs.map(h => ({
            action: h?.action,
            mode: h?.mode,
            bin: h?.bin_path,
            created: h?.created_at_unix,
          })));
        }

        for (const handoff of handoffs) {
          if (!handoff?.bin_path) continue;

          const mode = normalizeQuartzMode(handoff.mode);
          const action = String(handoff.action || 'open-bin').toLowerCase();
          const sessionKey = handoff.bin_path.toLowerCase();
          const existingSession = quartzSessionsRef.current.get(sessionKey);

          if (action === 'reload-bin' && existingSession) {
            // Keep previous snapshot, but force a content check so rapid saves
            // in the same timestamp window are never skipped.
            quartzSessionsRef.current.set(sessionKey, {
              ...existingSession,
              mode,
              forceContentCheck: true,
            });
            await openFileFromPathRef.current?.(handoff.bin_path);
            const afterContent = await readBinForQuartzInterop(handoff.bin_path).catch(() => null);
            if (afterContent) {
              const latest = quartzSessionsRef.current.get(sessionKey) || {
                ...existingSession,
                mode,
                forceContentCheck: false,
              };
              queueQuartzDiffForSession(sessionKey, latest, afterContent);
            }
            if (QUARTZ_INTEROP_DEBUG) {
              console.log('[QuartzInterop][Jade] Queued reload for existing session', {
                binPath: handoff.bin_path,
                mode,
              });
            }
            setStatusMessage(`Queued Quartz update for ${getFileName(handoff.bin_path)} (${mode})`);
            continue;
          }

          const snapshot = await readBinForQuartzInterop(handoff.bin_path).catch(() => null);
          await openFileFromPathRef.current?.(handoff.bin_path);
          const currentMtime = await invoke<number>('get_file_mtime', { path: handoff.bin_path }).catch(() => null);
          if (snapshot !== null) {
            quartzSessionsRef.current.set(sessionKey, {
              filePath: handoff.bin_path,
              mode,
              snapshotContent: snapshot,
              lastSeenMtime: currentMtime,
              pendingEntryId: null,
              forceContentCheck: false,
            });
            if (QUARTZ_INTEROP_DEBUG) {
              console.log('[QuartzInterop][Jade] Open handoff snapshot set', {
                binPath: handoff.bin_path,
                mode,
                mtime: currentMtime,
              });
            }
          }
          setStatusMessage(`Opened ${getFileName(handoff.bin_path)} from Quartz (${mode})`);
        }
      } catch {
        // Non-fatal: handoff polling should stay quiet on transient failures.
      }
    };

    consumeHandoff();
    // Faster handoff responsiveness for Quartz -> Jade opens while keeping low overhead.
    const timer = setInterval(consumeHandoff, 300);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [quartzInteropEnabled]);

  useEffect(() => {
    if (!quartzInteropEnabled) {
      return;
    }
    let stopped = false;
    let running = false;

    const checkQuartzSessions = async () => {
      if (stopped || running) return;
      running = true;

      try {
        const sessions = Array.from(quartzSessionsRef.current.entries());
        for (const [sessionKey, session] of sessions) {
          const currentMtime = await invoke<number>('get_file_mtime', { path: session.filePath }).catch(() => null);
          if (currentMtime === null) continue;

          const shouldForceCheck = session.forceContentCheck === true;
          if (session.lastSeenMtime === null) {
            session.lastSeenMtime = currentMtime;
            quartzSessionsRef.current.set(sessionKey, session);
            if (!shouldForceCheck) {
              continue;
            }
          }

          if (!shouldForceCheck && currentMtime === session.lastSeenMtime) {
            continue;
          }

          session.lastSeenMtime = currentMtime;
          session.forceContentCheck = false;
          quartzSessionsRef.current.set(sessionKey, session);

          const afterContent = await readBinForQuartzInterop(session.filePath).catch(() => null);
          if (!afterContent || afterContent === session.snapshotContent) {
            if (QUARTZ_INTEROP_DEBUG) {
              console.log('[QuartzInterop][Jade] Change check skipped (no content delta)', {
                filePath: session.filePath,
                shouldForceCheck,
                currentMtime,
                lastSeenMtime: session.lastSeenMtime,
              });
            }
            continue;
          }
          queueQuartzDiffForSession(sessionKey, session, afterContent);
        }
      } finally {
        running = false;
      }
    };

    const timer = setInterval(checkQuartzSessions, 1800);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [queueQuartzDiffForSession, quartzInteropEnabled, readBinForQuartzInterop, tabs]);

  // Scroll to line handler for particle editor
  const handleScrollToLine = (line: number) => {
    if (editorRef.current) {
      editorRef.current.revealLineInCenter(line);
      editorRef.current.setPosition({ lineNumber: line, column: 1 });
      editorRef.current.focus();
    }
  };

  // Build status message
  const statusText = `${statusMessage}${activeTab?.isModified ? ' (Modified)' : ''}`;
  // Hash updates run in the background and never gate file opening.
  // Bins still parse without hashes — fields just display as hex IDs
  // until the hash files land on disk.
  const openFileDisabled = false;
  const activeDiffEntries = activeTab?.tabType === 'quartz-diff' && activeTab.diffSourceFilePath
    ? getQuartzEntriesForFile(activeTab.diffSourceFilePath)
    : [];
  const activeDiffRevisionIndex = activeTab?.tabType === 'quartz-diff'
    ? Math.max(0, activeDiffEntries.findIndex((entry) => entry.id === activeTab.diffEntryId))
    : 0;

  // Build the value passed down to whichever shell is active.
  // Adding new chrome data means adding a field here AND on the
  // ShellContextValue type — TS will flag any mismatch.
  const shellCtx: ShellContextValue = {
    // -- Active shell variant
    shellVariant,

    // -- Window
    appIcon, isMaximized, isDragging, cigaretteMode, jamesMode,
    onMinimize: handleMinimize, onMaximize: handleMaximize, onClose: handleClose,

    // -- Tabs
    tabs, activeTabId, activeTab, isEditorTab, isBinFileOpen,
    onTabSelect: handleTabSelect, onTabClose: handleTabClose,
    onTabCloseAll: handleTabCloseAll, onTabPin: handleTabPin,

    // -- Status / metrics
    statusText, lineCount, caretPosition, appMemoryBytes, setStatusMessage,

    // -- Panel state
    findWidgetOpen, replaceWidgetOpen,
    generalEditPanelOpen, particlePanelOpen,
    textureInsertOpen, materialInsertOpen, binNavOpen,
    setGeneralEditPanelOpen, setParticlePanelOpen,
    setTextureInsertOpen, setMaterialInsertOpen, setBinNavOpen,

    // -- Recent files
    recentFiles, openFileDisabled, openFileFromPath,

    // -- Welcome screen override
    welcomeOverride, setWelcomeOverride,

    // -- File ops
    onNew: handleNew, onOpen: handleOpen, onSave: handleSave,
    onSaveAs: handleSaveAs, onSaveAll: handleSaveAll, onOpenLog: handleOpenLog,

    // -- Edit ops
    onUndo: handleUndo, onRedo: handleRedo,
    onCut: handleCut, onCopy: handleCopy, onPaste: handlePaste,
    onFind: handleFind, onReplace: handleReplace,
    onCompareFiles: handleCompareFiles, onScanBinAssets: handleScanBinAssets,
    isAssetListTab: () => isAssetListTab(activeTab), assetGalleryTabId, setAssetGalleryTabId, onSelectAll: handleSelectAll,

    // -- Tools
    onGeneralEdit: handleGeneralEdit, onParticlePanel: handleParticlePanel,
    onTextureInsert: handleTextureInsert, onMaterialInsert: handleMaterialInsert,
    onBinNav: handleBinNav,
    onParticleEditor: handleParticleEditor, onMaterialLibrary: handleMaterialLibrary,
    onThemes: handleThemes, onSettings: handleSettings,
    onPreferences: handlePreferences, onAbout: handleAbout,
    onSendToQuartz: handleSendToQuartz,

    // -- Editor wiring
    editorTheme, editorFontFamily, perfPrefs, bigFileLines: BIG_FILE_LINES,
    handleBeforeMount, handleEditorMount, handleEditorChange,
    editorRef, monacoModelsRef, monacoRef,

    // -- Split pane
    splitMode, setSplitMode, splitRatio, setSplitRatio,
    leftActiveTabId, rightActiveTabId, focusedPane, setFocusedPane,
    onTabSetPane, ensureModelForTab, setupRightEditor,

    // -- Photo Studio
    onNewStudioScene, onStudioOpen: studioOpenScene, notifyStudioDirty,
    onOpenSkinBinAsText: handleOpenSkinBinAsText,
    onSendMeshToStudio: handleSendMeshToStudio,
    registerStudioScene, unregisterStudioScene, getStudioScene,
    studioAnimOpen, studioBgOpen, studioActionsOpen, studioMeshOpen, studioObjectsOpen, studioSpotlightOpen,
    setStudioAnimOpen, setStudioBgOpen, setStudioActionsOpen, setStudioMeshOpen, setStudioObjectsOpen, setStudioSpotlightOpen,
    studioPhotoWidth, studioPhotoHeight, setStudioPhotoWidth, setStudioPhotoHeight,

    // -- File Explorer
    fileExplorerOpen, setFileExplorerOpen,
    fileExplorerRoot, setFileExplorerRoot,
    onOpenFolder: handleOpenFolder,
    onOpenWadInExplorer: handleOpenWadInExplorer,
    revealInExplorer: handleRevealInExplorer,
    openFetchAnimationsDialog: handleOpenFetchAnimationsDialog,

    // -- Edit panel callbacks
    handleGeneralEditContentChange, handleScrollToLine,
    recordJadelibInsert, mdWrapSelection, mdPrefixLines, mdInsertAtCaret,

    // -- Markdown preview
    mdPreviewContent,

    // -- Compare tab
    swapCompareTabSides,
    comparePicker,
    setComparePicker,
    openCompareTab,

    // -- Quartz diff
    activeDiffRevisionIndex,
    activeDiffEntriesLength: activeDiffEntries.length,
    switchQuartzDiffRevision,
    handleAcceptQuartzHistory, handleRejectQuartzHistory,

    // -- Texture preview
    reloadingTexTabId,
    handleTexEditImage, handleTexShowInExplorer, handleTexReload,

    // -- Texture hover popup
    texPopup, closeTexPopup, handleTexOpenFull, isOverTexPopupRef,

    // -- Editor context menu
    ctxMenu, setCtxMenu,
    foldAllEmitters, unfoldAllEmitters, hasEmitters,

    // -- Dialogs
    showGuideOverlay, setShowGuideOverlay,
    showAboutDialog, setShowAboutDialog,
    showThemesDialog, setShowThemesDialog,
    showMaterialLibrary, setShowMaterialLibrary,
    showSettingsDialog, setShowSettingsDialog,
    showPreferencesDialog, setShowPreferencesDialog,
    showQuartzInstallModal, setShowQuartzInstallModal,
    showNewFileDialog, setShowNewFileDialog,
    particleDialogOpen, setParticleDialogOpen,
    handleThemeApplied, handleCreateNewFile,

    // -- Toasts
    updateToastVersion, setUpdateToastVersion,
    fileLoading, hashSyncToast, setHashSyncToast,
    hashToastHideTimeoutRef, hashToastDismissedRef,

    // -- Preferences side-effects
    emitterHintsEnabled, syntaxCheckingEnabled,
    updateEmitterNameDecorations, updateSyntaxMarkers,
  };

  return (
    <ShellProvider value={shellCtx}>
      <ShellHost />
      <FetchAnimationsDialog
        open={!!fetchAnimDialog?.open}
        initialChampion={fetchAnimDialog?.champion ?? null}
        initialSkinNum={fetchAnimDialog?.skinNum ?? null}
        initialReason={fetchAnimDialog?.reason ?? ''}
        onCancel={() => {
          fetchAnimResolveRef.current?.(0);
          fetchAnimResolveRef.current = null;
          setFetchAnimDialog(null);
        }}
        onConfirm={async (champion, skinNum, usePbe) => {
          const sknPath = fetchAnimDialog?.sknPath ?? '';
          setFetchAnimDialog(null);
          const count = await runFetchVanillaAnimations(sknPath, champion, skinNum, usePbe);
          fetchAnimResolveRef.current?.(count);
          fetchAnimResolveRef.current = null;
        }}
      />
    </ShellProvider>
  );
}

export default App;

