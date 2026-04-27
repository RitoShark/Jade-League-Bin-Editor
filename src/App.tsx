import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Editor, { Monaco } from "@monaco-editor/react";
import type * as MonacoType from 'monaco-editor';
import { registerRitobinLanguage, registerRitobinTheme, RITOBIN_LANGUAGE_ID, RITOBIN_THEME_ID } from "./lib/ritobinLanguage";
import { registerColorProvider } from "./lib/colorProvider";
import { openBinFile, saveBinFile, saveBinFileAs, readBinDirect, writeBinDirect } from "./lib/binOperations";
import { loadSavedTheme } from "./lib/themeApplicator";
import { checkSyntax, suggestType } from "./lib/syntaxChecker";
import { texBufferToDataURL, ddsBufferToDataURL, ddsFormatName } from "./lib/texFormat";
import TitleBar from "./components/TitleBar";
import MenuBar from "./components/MenuBar";
import TabBar, { EditorTab, createQuartzDiffTab, createTab, createTexPreviewTab, getFileName } from "./components/TabBar";
import StatusBar from "./components/StatusBar";
import WelcomeScreen from "./components/WelcomeScreen";
import AboutDialog from "./components/AboutDialog";
import ThemesDialog from "./components/ThemesDialog";
import MaterialLibraryBrowser from "./components/MaterialLibraryBrowser";
import SettingsDialog from "./components/SettingsDialog";
import PreferencesDialog from "./components/PreferencesDialog";
import GeneralEditPanel from "./components/GeneralEditPanel";
import ParticleEditorPanel from "./components/ParticleEditorPanel";
import ParticleEditorDialog from "./components/ParticleEditorDialog";
import UpdateToast from "./components/UpdateToast";
import HashSyncToast from "./components/HashSyncToast";
import QuartzInstallModal from "./components/QuartzInstallModal";
import TexHoverPopup from "./components/TexHoverPopup";
import EditorContextMenu from "./components/EditorContextMenu";
import TexturePreviewTab from "./components/TexturePreviewTab";
import QuartzDiffTab from "./components/QuartzDiffTab";
import SmokeOverlay from "./components/SmokeOverlay";
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

type HashSyncToastState = {
  visible: boolean;
  status: 'checking' | 'downloading' | 'success' | 'error';
  message: string;
};

function App() {
  // Tab management - start with NO tabs (empty)
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const viewStatesRef = useRef<Map<string, EditorViewState>>(new Map());

  // UI state
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [showThemesDialog, setShowThemesDialog] = useState(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState(false);
  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [showQuartzInstallModal, setShowQuartzInstallModal] = useState(false);
  const [updateToastVersion, setUpdateToastVersion] = useState<string | null>(null);
  const [hashSyncToast, setHashSyncToast] = useState<HashSyncToastState | null>(null);
  const [, setHashSyncBusy] = useState(true);
  const [appIcon, setAppIcon] = useState<string>("/media/jade.ico");
  const [findWidgetOpen, setFindWidgetOpen] = useState(false);
  const [replaceWidgetOpen, setReplaceWidgetOpen] = useState(false);
  const [generalEditPanelOpen, setGeneralEditPanelOpen] = useState(false);
  const [particlePanelOpen, setParticlePanelOpen] = useState(false);
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
  const editorDisposablesRef = useRef<MonacoType.IDisposable[]>([]);
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
  const openingFilesRef = useRef<Set<string>>(new Set()); // prevents duplicate concurrent opens
  const handleTabCloseRef = useRef<((tabId: string) => void) | null>(null);
  const handleOpenRef = useRef<(() => void) | null>(null);
  const handleSaveRef = useRef<(() => void) | null>(null);
  const handleSaveAsRef = useRef<(() => void) | null>(null);
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

  // Load custom icon and window state on mount
  useEffect(() => {
    loadCustomIcon();
    restoreWindowState();
    // Always auto-sync hashes first, then preload them.
    autoDownloadHashesOnStartup().then(() => {
      preloadHashesIfEnabled();
    });
    loadRecentFiles(); // Just load the list, don't open files
    if (!monacoInstance) {
      loadSavedTheme(invoke);
    }

    invoke<string>('get_preference', { key: 'CigaretteMode', defaultValue: 'false' })
      .then(val => setCigaretteMode(val === 'true'))
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

    const handleCigaretteModeChanged = (e: Event) => {
      setCigaretteMode((e as CustomEvent<boolean>).detail);
    };
    const handleQuartzInteropChanged = (e: Event) => {
      setQuartzInteropEnabled((e as CustomEvent<boolean>).detail !== false);
    };
    window.addEventListener('cigarette-mode-changed', handleCigaretteModeChanged);
    window.addEventListener('quartz-interop-changed', handleQuartzInteropChanged);

    // Listen for open-file events from backend (file association double-click or single-instance)
    const openFileUnlisten = listen<string>('open-file', async (event) => {
      const filePath = event.payload;
      if (filePath && filePath.trim()) {
        console.log('[App] Received open-file event:', filePath);
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
    const handleAppOpen = () => handleOpenRef.current?.();
    const handleAppSave = () => handleSaveRef.current?.();
    const handleAppSaveAs = () => handleSaveAsRef.current?.();
    const handleAppFind = () => handleFindRef.current?.();
    const handleAppReplace = () => handleReplaceRef.current?.();
    const handleAppCompare = () => handleCompareRef.current?.();
    const handleAppCloseTab = () => {
      if (activeTabIdRef.current) {
        handleTabCloseRef.current?.(activeTabIdRef.current);
      }
    };

    window.addEventListener('app-open', handleAppOpen);
    window.addEventListener('app-save', handleAppSave);
    window.addEventListener('app-save-as', handleAppSaveAs);
    window.addEventListener('app-find', handleAppFind);
    window.addEventListener('app-replace', handleAppReplace);
    window.addEventListener('app-compare', handleAppCompare);
    window.addEventListener('app-close-tab', handleAppCloseTab);

    // Keyboard shortcut for General Edit panel (Ctrl+O), Particle panel (Ctrl+Shift+P), Tab switching (Ctrl+Tab/Ctrl+Shift+Tab) and Escape to close
    const handleKeyDown = (e: KeyboardEvent) => {
      // Helper to check if current file is a bin file (using ref for up-to-date value)
      const isBinFile = (): boolean => {
        const tab = activeTabRef.current;
        if (!tab) return false;
        if (!isEditorTab(tab)) return false;
        return tab.fileName.toLowerCase().endsWith('.bin');
      };

      // Ctrl+S - Save file
      if (e.ctrlKey && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        // Trigger save - handleSave is defined elsewhere, use a custom event
        window.dispatchEvent(new CustomEvent('app-save'));
        return;
      }

      // Ctrl+Shift+S - Save As
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-save-as'));
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
          if (filePath.toLowerCase().endsWith('.bin')) {
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
      window.removeEventListener('quartz-interop-changed', handleQuartzInteropChanged);
      window.removeEventListener('app-open', handleAppOpen);
      window.removeEventListener('app-save', handleAppSave);
      window.removeEventListener('app-save-as', handleAppSaveAs);
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
  // schedule (every launch / every 7 days / never). The whole flow is
  // background work — file opening is never blocked by this.
  const autoDownloadHashesOnStartup = async () => {
    // Reset the toast dismissed latch for this new session.
    hashToastDismissedRef.current = false;
    try {
      const preStatus = await invoke<{ all_present: boolean }>('check_hashes').catch(() => ({ all_present: false }));

      const mode = await invoke<string>('get_preference', {
        key: 'HashUpdateMode',
        defaultValue: 'every_launch'
      }).catch(() => 'every_launch');

      // "never" — skip the network entirely.
      if (mode === 'never') {
        setHashSyncBusy(false);
        return;
      }

      // "every_7_days" — skip if we've checked within the past week and
      // hashes are present on disk.
      if (mode === 'every_7_days') {
        const lastCheckedStr = await invoke<string>('get_preference', {
          key: 'LastHashCheckAt',
          defaultValue: '0'
        }).catch(() => '0');
        const lastChecked = parseInt(lastCheckedStr, 10) || 0;
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        if (preStatus?.all_present && (Date.now() - lastChecked) < sevenDaysMs) {
          setHashSyncBusy(false);
          return;
        }
      }

      setHashSyncBusy(true);
      const useBinaryFormat = await invoke<string>('get_preference', {
        key: 'UseBinaryHashFormat',
        defaultValue: 'False'
      }) === 'True';

      showHashToast({
        visible: true,
        status: 'checking',
        message: 'Checking hash updates...'
      });

      allowHashStatusUpdateRef.current = false; // Block hash preload updates during download
      setStatusMessage('Auto-downloading latest hash files...');
      statusMessageRef.current = 'Auto-downloading latest hash files...';
      try {
        showHashToast({
          visible: true,
          status: 'downloading',
          message: 'Updating hash files...'
        });

        const downloaded = await invoke<string[]>('download_hashes', { useBinary: useBinaryFormat });
        const downloadedCount = Array.isArray(downloaded) ? downloaded.length : 0;

        showHashToast({
          visible: true,
          status: 'success',
          message: downloadedCount > 0
            ? `Downloaded/updated ${downloadedCount} file(s).`
            : 'Hashes are already up to date.'
        });

        if (hashToastHideTimeoutRef.current) {
          clearTimeout(hashToastHideTimeoutRef.current);
        }
        hashToastHideTimeoutRef.current = setTimeout(() => {
          setHashSyncToast((prev) => prev ? { ...prev, visible: false } : prev);
        }, 4200);

        setStatusMessage('Latest hash files downloaded');
        statusMessageRef.current = 'Latest hash files downloaded';
        setHashSyncBusy(false);
        await invoke('set_preference', { key: 'LastHashCheckAt', value: String(Date.now()) }).catch(() => {});
        // Re-enable hash status updates after a short delay
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 500);
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

  // Helper to check if current status is safe to override with hash preload status
  const isStatusSafeToOverride = (currentStatus: string): boolean => {
    const lowerStatus = currentStatus.toLowerCase();
    // Don't override if status contains important operations
    const importantKeywords = [
      'opening', 'opened', 'switched to', 'saved', 'loading', 'loaded',
      'failed', 'error', 'updated', 'set bindweight', 'scaled'
    ];
    return !importantKeywords.some(keyword => lowerStatus.includes(keyword));
  };

  // Preload hashes in background if setting is enabled
  const preloadHashesIfEnabled = async () => {
    try {
      const preloadEnabled = await invoke<string>('get_preference', {
        key: 'PreloadHashes',
        defaultValue: 'False'
      });

      if (preloadEnabled === 'True') {
        // Check status first to see if hashes are already loaded
        const status = await invoke<{ loaded: boolean; loading: boolean; fnv_count: number; xxh_count: number; memory_bytes: number }>('get_preload_status');

        if (status.loaded) {
          // Hashes are already loaded, always update status to show correct info
          // (even if current status is "Preloading hashes..." - we need to correct it)
          const totalHashes = status.fnv_count + status.xxh_count;
          const newStatus = `Ready (${totalHashes} hashes preloaded)`;

          // Force update the status - always update when hashes are already loaded
          // This corrects any incorrect "Preloading hashes..." status
          setStatusMessage(currentStatus => {
            const lowerCurrent = currentStatus.toLowerCase();
            // Always update if current status is hash-related or generic (to correct wrong status)
            const isHashRelated = lowerCurrent.includes('preloading hashes') ||
              lowerCurrent.includes('hashes preloaded') ||
              lowerCurrent.includes('hash');
            const isGeneric = lowerCurrent === 'ready' ||
              lowerCurrent.includes('latest hash files downloaded');

            if (isHashRelated || isGeneric || isStatusSafeToOverride(currentStatus)) {
              statusMessageRef.current = newStatus;
              allowHashStatusUpdateRef.current = true;
              console.log(`[App] Updating status from "${currentStatus}" to "${newStatus}" (hashes already loaded)`);
              return newStatus;
            }
            // Only keep current status if it's an important operation
            console.log(`[App] Keeping current status "${currentStatus}" (important operation)`);
            allowHashStatusUpdateRef.current = false;
            return currentStatus;
          });
        } else if (!status.loading) {
          // Hashes are not loaded and not currently loading, start preloading
          // Only set preloading status if current status is safe to override
          setStatusMessage(currentStatus => {
            statusMessageRef.current = currentStatus;
            if (isStatusSafeToOverride(currentStatus)) {
              allowHashStatusUpdateRef.current = true;
              return 'Preloading hashes...';
            }
            allowHashStatusUpdateRef.current = false;
            return currentStatus;
          });

          // Run preload in background - don't await
          invoke<{ loaded: boolean; fnv_count: number; xxh_count: number; memory_bytes: number }>('preload_hashes')
            .then((preloadStatus) => {
              if (preloadStatus.loaded) {
                const totalHashes = preloadStatus.fnv_count + preloadStatus.xxh_count;
                const newStatus = `Ready (${totalHashes} hashes preloaded)`;
                // Always update if current status is hash-related
                setStatusMessage(currentStatus => {
                  statusMessageRef.current = currentStatus;
                  const lowerCurrent = currentStatus.toLowerCase();
                  if (lowerCurrent.includes('preloading hashes') ||
                    (allowHashStatusUpdateRef.current && isStatusSafeToOverride(currentStatus))) {
                    return newStatus;
                  }
                  return currentStatus;
                });
              }
            })
            .catch((error) => {
              console.error('[App] Failed to preload hashes:', error);
              // Only update status if it's safe to do so
              setStatusMessage(currentStatus => {
                statusMessageRef.current = currentStatus;
                const lowerCurrent = currentStatus.toLowerCase();
                if (lowerCurrent.includes('preloading hashes') ||
                  (allowHashStatusUpdateRef.current && isStatusSafeToOverride(currentStatus))) {
                  return 'Ready';
                }
                return currentStatus;
              });
            });
        }
        // If status.loading is true, hashes are currently being loaded, don't do anything
      }
    } catch (error) {
      console.error('[App] Failed to check preload preference:', error);
    }
  };

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
    // Prevent duplicate concurrent opens (e.g. Tauri drag-drop firing twice,
    // or rapid re-drops of the same file before the first open completes).
    const normalizedPath = filePath.toLowerCase();
    if (openingFilesRef.current.has(normalizedPath)) return;
    openingFilesRef.current.add(normalizedPath);
    try {
      // Block hash status updates while opening file
      allowHashStatusUpdateRef.current = false;
      setStatusMessage(`Opening ${getFileName(filePath)}...`);
      statusMessageRef.current = `Opening ${getFileName(filePath)}...`;

      const existingTab = tabs.find(t => t.filePath && t.filePath.toLowerCase() === filePath.toLowerCase());
      if (existingTab) {
        ensureTrackedBinSession(filePath, existingTab.content, 'paint');
        setActiveTabId(existingTab.id);
        setStatusMessage(`Switched to ${getFileName(filePath)}`);
        statusMessageRef.current = `Switched to ${getFileName(filePath)}`;
        // Re-enable hash status updates after a delay
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 2000);
        return;
      }

      const content = await readBinForEditor(filePath);
      const newTab = createTab(filePath, content);
      // Store initial mtime so the auto-reload poller doesn't fire immediately
      invoke<number>('get_file_mtime', { path: filePath })
        .then(mtime => editorMtimeRef.current.set(newTab.id, mtime))
        .catch(() => {});
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);

      await addToRecentFiles(filePath);
      setStatusMessage(`Opened ${getFileName(filePath)}`);
      statusMessageRef.current = `Opened ${getFileName(filePath)}`;

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

  // Tab operations
  const handleTabSelect = useCallback((tabId: string) => {
    if (tabId === activeTabId) return;
    saveCurrentViewState();
    setActiveTabId(tabId);
    // Model switching and view state restoration handled by the activeTabId useEffect
  }, [activeTabId, saveCurrentViewState]);

  const handleTabClose = useCallback((tabId: string) => {
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

    // Confirm if modified
    if (tabToClose.isModified) {
      if (!confirm(`"${tabToClose.fileName}" has unsaved changes. Close anyway?`)) {
        lastRejectedTabCloseRef.current = { tabId, at: Date.now() };
        return;
      }

      // If this bin had library texture inserts during the session, the
      // user is now discarding those references. Offer to also delete
      // the texture folders we dropped into the mod so they don't
      // linger as orphan files. Cleanup is fire-and-forget so the close
      // handler can stay synchronous.
      if (tabToClose.filePath) {
        const inserts = jadelibInsertsRef.current.get(tabToClose.filePath);
        if (inserts && inserts.length > 0) {
          const summary = inserts.map(e => `assets/jadelib/${e.id}/`).join('\n  ');
          const shouldDelete = confirm(
            `You inserted library material textures in this session:\n\n  ${summary}\n\nRemove these folders from your mod too?`
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
            : monaco.editor.createModel(nextTab.content, RITOBIN_LANGUAGE_ID, uri);
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
            : monaco.editor.createModel(fallbackEditorTab.content, RITOBIN_LANGUAGE_ID, uri);
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

  const handleTabCloseAll = useCallback(() => {
    const hasModified = tabs.some(t => t.isModified);
    if (hasModified) {
      if (!confirm('Some tabs have unsaved changes. Close all anyway?')) {
        return;
      }
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

  // Model-based tab switching: swap Monaco model when active tab changes
  // This is the core fix for the RAM leak - no more editor remounts
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
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

      model = monaco.editor.createModel(activeTab.content, RITOBIN_LANGUAGE_ID, uri);
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
  }, [activeTabId]); // Only re-run when active tab changes

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

    // First pass: index every StaticMaterialDef name → its line.
    //             And every material link → its line.
    // Case-insensitive because field names in bin files are usually
    // capitalised (Material:, SamplerValues:, TextureName:, etc.).
    const defByName = new Map<string, number>();
    const linksByName = new Map<string, number[]>();
    const defLineRe = /^\s*"([^"]+)"\s*=\s*StaticMaterialDef\s*\{/i;
    const linkLineRe = /material\s*:\s*link\s*=\s*"([^"]+)"/i;

    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);
      const dm = defLineRe.exec(line);
      if (dm) {
        defByName.set(dm[1], ln);
        continue;
      }
      const lm = linkLineRe.exec(line);
      if (lm) {
        const arr = linksByName.get(lm[1]) ?? [];
        arr.push(ln);
        linksByName.set(lm[1], arr);
      }
    }

    // Second pass: emit decorations for every link that has a matching def,
    // and every def that has at least one link.
    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);

      const lm = linkLineRe.exec(line);
      if (lm) {
        const name = lm[1];
        const targetLine = defByName.get(name);
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
        const name = dm[1];
        const targets = linksByName.get(name);
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

    if (!syntaxCheckingEnabled.current) {
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

      const baseFile = activeTabRef.current?.filePath ?? null;
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
      loadTextureForPopup(match.path, baseFile);
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
        if (hoveredSwatchEl === browserTarget && !texPopupRef.current) {
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
    const imgDecModelDisposable = editor.onDidChangeModel(() => { refreshImagePathDecorations(); });
    editorDisposablesRef.current.push(imgDecContentDisposable, imgDecModelDisposable);
    editorDisposablesRef.current.push({ dispose: () => { if (imgDecDebounce) clearTimeout(imgDecDebounce); editor.deltaDecorations(imgPathDecorations, []); } });
    // â”€â”€ End image path decorations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Material jump arrows (link <-> StaticMaterialDef)
    let matJumpDecorations: string[] = [];
    let matJumpDebounce: ReturnType<typeof setTimeout> | null = null;
    const refreshMatJumpDecorations = () => {
      const model = editor.getModel();
      if (!model) return;
      matJumpDecorations = editor.deltaDecorations(matJumpDecorations, findMaterialJumpDecorations(model));
    };
    const debouncedRefreshMatJumpDecorations = () => {
      if (matJumpDebounce) clearTimeout(matJumpDebounce);
      matJumpDebounce = setTimeout(refreshMatJumpDecorations, 300);
    };
    refreshMatJumpDecorations();
    const matJumpContentDisposable = editor.onDidChangeModelContent(() => { debouncedRefreshMatJumpDecorations(); });
    const matJumpModelDisposable = editor.onDidChangeModel(() => { refreshMatJumpDecorations(); });
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
    // On initial mount, trigger model setup for the first tab
    if (activeTabId) {
      // Trigger the model-switching effect by forcing a re-evaluation
      // The effect depends on activeTabId which is already set
      setTimeout(() => {
        const monaco = monacoRef.current;
        const activeTabData = tabs.find(t => t.id === activeTabId);
        if (monaco && activeTabData && editor) {
          const uri = activeTabData.filePath
            ? monaco.Uri.file(activeTabData.filePath)
            : monaco.Uri.parse(`inmemory://tab/${activeTabId}`);
          const existing = monaco.editor.getModel(uri);
          let model: MonacoType.editor.ITextModel;
          if (existing && !existing.isDisposed()) {
            model = existing;
          } else {
            model = monaco.editor.createModel(activeTabData.content, RITOBIN_LANGUAGE_ID, uri);
          }
          monacoModelsRef.current.set(activeTabId, model);
          editor.setModel(model);
          const savedState = viewStatesRef.current.get(activeTabId);
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
    }
  };

  // Window Controls
  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().close();

  // File Operations
  const handleOpen = async () => {
    try {
      // Block hash status updates while opening file
      allowHashStatusUpdateRef.current = false;
      const result = await openBinFile();
      if (result) {
        const resolvedContent = await readBinForEditor(result.path, result.content);
        addTab(result.path, resolvedContent);
        setStatusMessage(`Opened ${result.path}`);
        statusMessageRef.current = `Opened ${result.path}`;

        if (result.path) {
          await addToRecentFiles(result.path);
        }

        // Open linked bin files if preference enabled
        await openLinkedBinFiles(result.path, resolvedContent);

        // Re-enable hash status updates after file is opened
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 2000);
      }
    } catch (error) {
      console.error('Failed to open file:', error);
      setStatusMessage(`Error: ${error}`);
      statusMessageRef.current = `Error: ${error}`;
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

      const linkedResults = await findAndOpenLinkedBins(
        filePath,
        content,
        recursiveEnabled,
        (result: LinkedBinResult) => {
          addTab(result.path, result.content);
        }
      );

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
    if (!activeTab || !isEditorTab(activeTab)) return;

    try {
      // Block hash status updates while saving
      allowHashStatusUpdateRef.current = false;
      if (activeTab.filePath) {
        // Read content from editor for active tab, or from state for inactive tabs
        const content = editorRef.current?.getValue() || activeTab.content;
        await persistPySidecarIfNeeded(activeTab.filePath, content);
        await saveBinFile(content, activeTab.filePath);
        try {
          if (quartzInteropEnabled) {
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
    if (!activeTab || !isEditorTab(activeTab)) return;

    try {
      // Block hash status updates while saving
      allowHashStatusUpdateRef.current = false;
      // Read content from editor for active tab, or from state for inactive tabs
      const content = editorRef.current?.getValue() || activeTab.content;
      const newPath = await saveBinFileAs(content);
      if (newPath) {
        await persistPySidecarIfNeeded(newPath, content);
        try {
          if (quartzInteropEnabled) {
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

  const handleFind = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    if (findWidgetOpen) {
      editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
      setFindWidgetOpen(false);
    } else {
      setGeneralEditPanelOpen(false);
      setParticlePanelOpen(false);
      editorRef.current?.trigger('keyboard', 'actions.find', null);
      setFindWidgetOpen(true);
      setReplaceWidgetOpen(false);
    }
  };

  const handleReplace = () => {
    if (!isEditorTab(activeTabRef.current)) return;
    if (replaceWidgetOpen) {
      editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
      setReplaceWidgetOpen(false);
    } else {
      setGeneralEditPanelOpen(false);
      setParticlePanelOpen(false);
      editorRef.current?.trigger('keyboard', 'editor.action.startFindReplaceAction', null);
      setReplaceWidgetOpen(true);
      setFindWidgetOpen(false);
    }
  };

  const handleCompareFiles = () => console.log('Compare Files');

  handleOpenRef.current = handleOpen;
  handleSaveRef.current = () => {
    void handleSave();
  };
  handleSaveAsRef.current = () => {
    void handleSaveAs();
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
    setFindWidgetOpen(false);
    setReplaceWidgetOpen(false);
    setParticlePanelOpen(false);
    editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
    setGeneralEditPanelOpen(!generalEditPanelOpen);
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

  // Helper to check if current file is a bin file
  const isBinFileOpen = (): boolean => {
    if (!activeTab) return false;
    if (!isEditorTab(activeTab)) return false;
    const fileName = activeTab.fileName.toLowerCase();
    return fileName.endsWith('.bin');
  };

  // Particle Editor handlers
  const handleParticlePanel = () => {
    // Only allow opening if a bin file is loaded
    if (!isBinFileOpen()) return;

    setFindWidgetOpen(false);
    setReplaceWidgetOpen(false);
    setGeneralEditPanelOpen(false);
    editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
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

  return (
    <div className={`app-container ${isDragging ? 'dragging' : ''}`}>
      <TitleBar
        appIcon={appIcon}
        isMaximized={isMaximized}
        onThemes={handleThemes}
        onPreferences={handlePreferences}
        onSettings={handleSettings}
        onAbout={handleAbout}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onClose={handleClose}
        onParticleEditor={handleParticleEditor}
        onMaterialLibrary={handleMaterialLibrary}
        onQuartzAction={handleSendToQuartz}
      />

      <MenuBar
        findActive={findWidgetOpen}
        replaceActive={replaceWidgetOpen}
        generalEditActive={generalEditPanelOpen}
        particlePanelActive={particlePanelOpen}
        onOpenFile={handleOpen}
        onSaveFile={handleSave}
        onSaveFileAs={handleSaveAs}
        onOpenLog={handleOpenLog}
        onExit={handleClose}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onCut={handleCut}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onFind={handleFind}
        onReplace={handleReplace}
        onCompareFiles={handleCompareFiles}
        onSelectAll={handleSelectAll}
        onGeneralEdit={handleGeneralEdit}
        onParticlePanel={handleParticlePanel}
        onThemes={handleThemes}
        onSettings={handleSettings}
        onAbout={handleAbout}
        onMaterialLibrary={handleMaterialLibrary}
        recentFiles={recentFiles}
        onOpenRecentFile={openFileFromPath}
        openFileDisabled={openFileDisabled}
      />

      {tabs.length > 0 && (
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onTabSelect={handleTabSelect}
          onTabClose={handleTabClose}
          onTabCloseAll={handleTabCloseAll}
          onTabPin={handleTabPin}
        />
      )}

      {tabs.length === 0 && <WelcomeScreen onOpenFile={handleOpen} openFileDisabled={openFileDisabled} recentFiles={recentFiles} onOpenRecentFile={openFileFromPath} onMaterialLibrary={handleMaterialLibrary} appIcon={appIcon} />}

      {/* Keep the editor container (and Monaco) always mounted.
          Unmounting Monaco while a requestAnimationFrame render is in-flight
          causes "Cannot read properties of undefined (reading 'domNode')".
          We hide it with display:none when there are no tabs instead. */}
      {/* Texture-preview tab: shown instead of Monaco when active tab is a texture */}
      {activeTab?.tabType === 'texture-preview' && activeTab.filePath && (
        <TexturePreviewTab
          filePath={activeTab.filePath}
          imageDataUrl={activeTab.textureDataUrl ?? null}
          texWidth={activeTab.textureWidth ?? 0}
          texHeight={activeTab.textureHeight ?? 0}
          format={activeTab.textureFormat ?? 0}
          error={activeTab.textureError ?? null}
          isReloading={reloadingTexTabId === activeTab.id}
          onEditImage={() => handleTexEditImage(activeTab.filePath)}
          onShowInExplorer={() => handleTexShowInExplorer(activeTab.filePath)}
          onReload={handleTexReload}
        />
      )}
      {activeTab?.tabType === 'quartz-diff' && (
        <QuartzDiffTab
          fileName={activeTab.diffSourceFilePath ? getFileName(activeTab.diffSourceFilePath) : activeTab.fileName}
          mode={activeTab.diffMode ?? 'paint'}
          status={activeTab.diffStatus ?? 'pending'}
          originalContent={activeTab.diffOriginalContent ?? ''}
          modifiedContent={activeTab.diffModifiedContent ?? ''}
          revisionIndex={activeDiffRevisionIndex}
          revisionCount={Math.max(1, activeDiffEntries.length)}
          onPrevRevision={() => switchQuartzDiffRevision(activeTab.id, 'prev')}
          onNextRevision={() => switchQuartzDiffRevision(activeTab.id, 'next')}
          onAccept={() => {
            if (activeTab.diffEntryId) {
              handleAcceptQuartzHistory(activeTab.diffEntryId);
            }
          }}
          onReject={() => {
            if (activeTab.diffEntryId) {
              handleRejectQuartzHistory(activeTab.diffEntryId);
            }
          }}
        />
      )}

      <div
        className="editor-container"
        style={
          tabs.length === 0 || !isEditorTab(activeTab)
            ? { display: 'none' }
            : undefined
        }
      >
        <Editor
          height="100%"
          defaultLanguage={RITOBIN_LANGUAGE_ID}
          theme={editorTheme}
          beforeMount={handleBeforeMount}
          onMount={handleEditorMount}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: true },
            glyphMargin: true,
            fontSize: 14,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
            lineNumbersMinChars: 6,
            fixedOverflowWidgets: true,
            contextmenu: false,
            // Monaco classifies models as "large" above ~20 MB or 300k lines
            // and silently disables tokenization (no syntax colors), hover,
            // folding, etc. Bin dumps for full skins routinely cross those
            // thresholds, so opt out and keep all features on.
            largeFileOptimizations: false,
            maxTokenizationLineLength: 100_000,
            find: {
              addExtraSpaceOnTop: false,
              autoFindInSelection: 'never',
              seedSearchStringFromSelection: 'always',
            },
            ...({
              "bracketPairColorization.enabled": true,
              "suggest.maxVisibleSuggestions": 5,
              "semanticHighlighting.enabled": false,
            } as any),
          }}
        />
        {activeTab && isEditorTab(activeTab) && (
          <GeneralEditPanel
            isOpen={generalEditPanelOpen}
            onClose={() => setGeneralEditPanelOpen(false)}
            editorContent={editorRef.current?.getValue() || activeTab.content}
            onContentChange={handleGeneralEditContentChange}
            filePath={activeTab.filePath ?? undefined}
            onLibraryInsert={recordJadelibInsert}
          />
        )}
        {activeTab && isEditorTab(activeTab) && (
          <ParticleEditorPanel
            isOpen={particlePanelOpen}
            onClose={() => setParticlePanelOpen(false)}
            editorContent={editorRef.current?.getValue() || activeTab.content}
            onContentChange={handleGeneralEditContentChange}
            onScrollToLine={handleScrollToLine}
            onStatusUpdate={setStatusMessage}
          />
        )}
      </div>

      {ctxMenu && (
        <EditorContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onCut={handleCut}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onSelectAll={handleSelectAll}
          onFoldEmitters={foldAllEmitters}
          onUnfoldEmitters={unfoldAllEmitters}
          hasEmitters={hasEmitters()}
        />
      )}

      {/* Texture hover popup */}
      {texPopup && (
        <TexHoverPopup
          top={texPopup.top}
          left={texPopup.left}
          above={texPopup.above}
          rawPath={texPopup.rawPath}
          resolvedPath={texPopup.resolvedPath}
          imageDataUrl={texPopup.imageDataUrl}
          texWidth={texPopup.texWidth}
          texHeight={texPopup.texHeight}
          formatName={texPopup.formatStr}
          error={texPopup.error}
          onOpenFull={handleTexOpenFull}
          onEditImage={() => handleTexEditImage(texPopup.resolvedPath)}
          onShowInExplorer={() => handleTexShowInExplorer(texPopup.resolvedPath)}
          onClose={closeTexPopup}
          onMouseEnter={() => { isOverTexPopupRef.current = true; }}
          onMouseLeave={() => { isOverTexPopupRef.current = false; }}
        />
      )}

      <StatusBar
        status={statusText}
        lineCount={lineCount}
        caretLine={caretPosition.line}
        caretColumn={caretPosition.column}
        ramUsage="0 MB"
      />

      <AboutDialog
        isOpen={showAboutDialog}
        onClose={() => setShowAboutDialog(false)}
      />

      <ThemesDialog
        isOpen={showThemesDialog}
        onClose={() => setShowThemesDialog(false)}
        onThemeApplied={handleThemeApplied}
      />

      {showMaterialLibrary && (
        <MaterialLibraryBrowser
          onClose={() => setShowMaterialLibrary(false)}
        />
      )}

      <SettingsDialog
        isOpen={showSettingsDialog}
        onClose={() => setShowSettingsDialog(false)}
      />

      <PreferencesDialog
        isOpen={showPreferencesDialog}
        onClose={() => setShowPreferencesDialog(false)}
        onEmitterHintsChange={(enabled) => {
          emitterHintsEnabled.current = enabled;
          if (editorRef.current) updateEmitterNameDecorations(editorRef.current);
        }}
        onSyntaxCheckingChange={(enabled) => {
          syntaxCheckingEnabled.current = enabled;
          if (editorRef.current) updateSyntaxMarkers(editorRef.current);
        }}
      />

      {updateToastVersion && (
        <UpdateToast
          version={updateToastVersion}
          onOpenSettings={() => setShowSettingsDialog(true)}
          onDismiss={() => setUpdateToastVersion(null)}
        />
      )}

      {hashSyncToast?.visible && (
        <HashSyncToast
          status={hashSyncToast.status}
          message={hashSyncToast.message}
          onDismiss={() => {
            if (hashToastHideTimeoutRef.current) {
              clearTimeout(hashToastHideTimeoutRef.current);
              hashToastHideTimeoutRef.current = null;
            }
            // Latch dismissal so progress events from the backend don't
            // re-open the toast for the rest of this check session.
            hashToastDismissedRef.current = true;
            setHashSyncToast(null);
          }}
        />
      )}

      {activeTab && isEditorTab(activeTab) && particleDialogOpen && (
        <ParticleEditorDialog
          isOpen={particleDialogOpen}
          onClose={() => setParticleDialogOpen(false)}
          editorContent={editorRef.current?.getValue() || activeTab.content}
          onContentChange={handleGeneralEditContentChange}
          onScrollToLine={handleScrollToLine}
          onStatusUpdate={setStatusMessage}
        />
      )}

      <QuartzInstallModal
        isOpen={showQuartzInstallModal}
        onClose={() => setShowQuartzInstallModal(false)}
        onDownload={async () => {
          try {
            await invoke('open_url', { url: 'https://github.com/LeagueToolkit/Quartz/releases' });
          } catch {
            window.open('https://github.com/LeagueToolkit/Quartz/releases', '_blank', 'noopener,noreferrer');
          }
        }}
      />

      <SmokeOverlay active={cigaretteMode} />
    </div>
  );
}

export default App;

