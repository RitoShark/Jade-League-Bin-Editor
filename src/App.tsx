import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Editor, { Monaco } from "@monaco-editor/react";
import type * as MonacoType from 'monaco-editor';
import { registerRitobinLanguage, registerRitobinTheme, RITOBIN_LANGUAGE_ID, RITOBIN_THEME_ID } from "./lib/ritobinLanguage";
import { openBinFile, saveBinFile, saveBinFileAs } from "./lib/binOperations";
import { loadSavedTheme } from "./lib/themeApplicator";
import TitleBar from "./components/TitleBar";
import MenuBar from "./components/MenuBar";
import TabBar, { EditorTab, createTab, getFileName } from "./components/TabBar";
import StatusBar from "./components/StatusBar";
import WelcomeScreen from "./components/WelcomeScreen";
import AboutDialog from "./components/AboutDialog";
import ThemesDialog from "./components/ThemesDialog";
import SettingsDialog from "./components/SettingsDialog";
import PreferencesDialog from "./components/PreferencesDialog";
import GeneralEditPanel from "./components/GeneralEditPanel";
import ParticleEditorPanel from "./components/ParticleEditorPanel";
import ParticleEditorDialog from "./components/ParticleEditorDialog";
import { findAndOpenLinkedBins, LinkedBinResult } from "./lib/linkedBinParser";
import "./App.css";

// Store editor view states (scroll position, cursor position) per tab
interface EditorViewState {
  viewState: MonacoType.editor.ICodeEditorViewState | null;
}

function App() {
  // Tab management - start with NO tabs (empty)
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const viewStatesRef = useRef<Map<string, EditorViewState>>(new Map());

  // UI state
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [showThemesDialog, setShowThemesDialog] = useState(false);
  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [appIcon, setAppIcon] = useState<string>("/jade.ico");
  const [findWidgetOpen, setFindWidgetOpen] = useState(false);
  const [replaceWidgetOpen, setReplaceWidgetOpen] = useState(false);
  const [generalEditPanelOpen, setGeneralEditPanelOpen] = useState(false);
  const [particlePanelOpen, setParticlePanelOpen] = useState(false);
  const [particleDialogOpen, setParticleDialogOpen] = useState(false);
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const [caretPosition, setCaretPosition] = useState({ line: 1, column: 1 });
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Track normal window dimensions (when not maximized/fullscreen)
  const normalWindowSize = useRef<{ width: number; height: number; x: number; y: number }>({
    width: 1200,
    height: 800,
    x: 100,
    y: 100
  });

  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const editorDisposablesRef = useRef<MonacoType.IDisposable[]>([]);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const mutationSetupTimeoutRef = useRef<number | null>(null);
  const undoCheckIntervalRef = useRef<number | null>(null);

  // Get the active tab
  const activeTab = tabs.find(t => t.id === activeTabId) || null;
  
  // Ref to track active tab for keyboard shortcuts
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  
  // Ref to track active tab ID for keyboard shortcuts
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // Ref to track if we should allow hash preload status updates
  // This prevents hash preload status from overriding important messages like "Opened file"
  const statusMessageRef = useRef<string>("Ready");
  const allowHashStatusUpdateRef = useRef<boolean>(true);

  // Load custom icon and window state on mount
  useEffect(() => {
    loadCustomIcon();
    restoreWindowState();
    // Auto-download hashes first (if enabled), then preload them
    autoDownloadHashesIfEnabled().then(() => {
      preloadHashesIfEnabled();
    });
    loadRecentFiles(); // Just load the list, don't open files
    if (!monacoInstance) {
      loadSavedTheme(invoke);
    }

    const handleIconChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      setAppIcon(customEvent.detail);
    };

    window.addEventListener('icon-changed', handleIconChange);

    // Keyboard shortcut for General Edit panel (Ctrl+O), Particle panel (Ctrl+Shift+P), Tab switching (Ctrl+Tab/Ctrl+Shift+Tab) and Escape to close
    const handleKeyDown = (e: KeyboardEvent) => {
      // Helper to check if current file is a bin file (using ref for up-to-date value)
      const isBinFile = (): boolean => {
        const tab = activeTabRef.current;
        if (!tab) return false;
        return tab.fileName.toLowerCase().endsWith('.bin');
      };
      
      // Tab switching shortcuts
      if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        // Save current view state before switching
        if (editorRef.current && activeTabIdRef.current) {
          const viewState = editorRef.current.saveViewState();
          const content = editorRef.current.getValue();
          viewStatesRef.current.set(activeTabIdRef.current, { viewState });
          // Sync content to state
          setTabs(prev => prev.map(t => 
            t.id === activeTabIdRef.current ? { ...t, content } : t
          ));
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
        // Save current view state before switching
        if (editorRef.current && activeTabIdRef.current) {
          const viewState = editorRef.current.saveViewState();
          const content = editorRef.current.getValue();
          viewStatesRef.current.set(activeTabIdRef.current, { viewState });
          // Sync content to state
          setTabs(prev => prev.map(t => 
            t.id === activeTabIdRef.current ? { ...t, content } : t
          ));
        }
        // Switch to previous tab
        setTabs(currentTabs => {
          if (currentTabs.length <= 1) return currentTabs; // No need to switch if 0 or 1 tab
          
          const currentIndex = currentTabs.findIndex(t => t.id === activeTabIdRef.current);
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : currentTabs.length - 1;
          setActiveTabId(currentTabs[prevIndex].id);
          return currentTabs;
        });
      } else if (e.ctrlKey && e.key === 'o') {
        e.preventDefault();
        setGeneralEditPanelOpen(prev => !prev);
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

    let saveTimeout: number | null = null;
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
            await openFileFromPath(filePath);
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
      window.removeEventListener('icon-changed', handleIconChange);
      window.removeEventListener('keydown', handleKeyDown);
      cleanup?.();
      fileDropCleanup?.();
      saveCurrentWindowState();
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

  // Auto-download hashes on startup if setting is enabled
  const autoDownloadHashesIfEnabled = async () => {
    try {
      const autoDownloadEnabled = await invoke<string>('get_preference', { 
        key: 'AutoDownloadHashes', 
        defaultValue: 'False' 
      });
      
      if (autoDownloadEnabled !== 'True') {
        return;
      }

      const useBinaryFormat = await invoke<string>('get_preference', { 
        key: 'UseBinaryHashFormat', 
        defaultValue: 'False' 
      }) === 'True';

      // Always download latest hashes when auto-download is enabled
      allowHashStatusUpdateRef.current = false; // Block hash preload updates during download
      setStatusMessage('Auto-downloading latest hash files...');
      statusMessageRef.current = 'Auto-downloading latest hash files...';
      try {
        await invoke('download_hashes', { useBinary: useBinaryFormat });
        setStatusMessage('Latest hash files downloaded');
        statusMessageRef.current = 'Latest hash files downloaded';
        // Re-enable hash status updates after a short delay
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 500);
      } catch (error) {
        console.error('[App] Failed to auto-download hashes:', error);
        setStatusMessage('Ready');
        statusMessageRef.current = 'Ready';
        allowHashStatusUpdateRef.current = true;
      }
    } catch (error) {
      console.error('[App] Failed to auto-download hashes:', error);
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

  const openFileFromPath = async (filePath: string) => {
    try {
      // Block hash status updates while opening file
      allowHashStatusUpdateRef.current = false;
      setStatusMessage(`Opening ${getFileName(filePath)}...`);
      statusMessageRef.current = `Opening ${getFileName(filePath)}...`;
      
      const existingTab = tabs.find(t => t.filePath && t.filePath.toLowerCase() === filePath.toLowerCase());
      if (existingTab) {
        setActiveTabId(existingTab.id);
        setStatusMessage(`Switched to ${getFileName(filePath)}`);
        statusMessageRef.current = `Switched to ${getFileName(filePath)}`;
        // Re-enable hash status updates after a delay
        setTimeout(() => {
          allowHashStatusUpdateRef.current = true;
        }, 2000);
        return;
      }

      // Import the readBinDirect function from binOperations
      const { readBinDirect } = await import('./lib/binOperations');
      const content = await readBinDirect(filePath);
      const newTab = createTab(filePath, content);
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
    }
  };


  // Save current editor view state before switching tabs
  const saveCurrentViewState = useCallback(() => {
    if (editorRef.current && activeTabId) {
      const viewState = editorRef.current.saveViewState();
      const content = editorRef.current.getValue(); // Get current content
      viewStatesRef.current.set(activeTabId, { viewState });
      // Sync content to state only when switching tabs (for inactive tabs)
      setTabs(prev => prev.map(t => 
        t.id === activeTabId ? { ...t, content } : t
      ));
    }
  }, [activeTabId]);

  // Restore editor view state when switching to a tab
  const restoreViewState = useCallback((tabId: string) => {
    if (editorRef.current) {
      const savedState = viewStatesRef.current.get(tabId);
      if (savedState?.viewState) {
        editorRef.current.restoreViewState(savedState.viewState);
      }
      editorRef.current.focus();
    }
  }, []);

  // Tab operations
  const handleTabSelect = useCallback((tabId: string) => {
    if (tabId === activeTabId) return;
    saveCurrentViewState();
    setActiveTabId(tabId);
    // View state will be restored in onMount or after model change
  }, [activeTabId, saveCurrentViewState]);

  const handleTabClose = useCallback((tabId: string) => {
    const tabToClose = tabs.find(t => t.id === tabId);
    if (!tabToClose) return;

    // Confirm if modified
    if (tabToClose.isModified) {
      if (!confirm(`"${tabToClose.fileName}" has unsaved changes. Close anyway?`)) {
        return;
      }
    }

    // If this was the active tab's model, clear undo stack before closing
    if (editorRef.current && tabId === activeTabId) {
      const model = editorRef.current.getModel();
      if (model) {
        // Push a stack element to clear undo groupings
        model.pushStackElement();
      }
    }

    // Remove view state
    viewStatesRef.current.delete(tabId);

    setTabs(prevTabs => {
      const newTabs = prevTabs.filter(t => t.id !== tabId);
      
      // Dispose orphaned Monaco models for closed tabs
      // Import monaco-editor to access getModels
      import('monaco-editor').then(monaco => {
        monaco.editor.getModels().forEach(model => {
          const uri = model.uri.toString();
          // Check if this model corresponds to a closed tab
          const tabStillExists = newTabs.some(t => {
            // Match by file path or tab ID
            if (t.filePath) {
              // Convert file path to URI format for comparison
              const fileUri = `file:///${t.filePath.replace(/\\/g, '/')}`;
              return uri === fileUri || uri.includes(t.filePath);
            }
            return false;
          });
          if (!tabStillExists) {
            try {
              model.dispose();
            } catch (error) {
              console.warn('Error disposing Monaco model:', error);
            }
          }
        });
      });
      
      // If closing the active tab, switch to another or clear active
      if (tabId === activeTabId) {
        if (newTabs.length > 0) {
          const closedIndex = prevTabs.findIndex(t => t.id === tabId);
          const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
          setActiveTabId(newTabs[newActiveIndex].id);
        } else {
          // No more tabs - show welcome screen
          setActiveTabId(null);
        }
      }
      
      return newTabs;
    });
  }, [tabs, activeTabId]);

  const handleTabCloseAll = useCallback(() => {
    const hasModified = tabs.some(t => t.isModified);
    if (hasModified) {
      if (!confirm('Some tabs have unsaved changes. Close all anyway?')) {
        return;
      }
    }

    viewStatesRef.current.clear();
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
        setActiveTabId(existingTab.id);
        return existingTab;
      }
    }

    const newTab = createTab(filePath, content);
    saveCurrentViewState();
    setTabs(prevTabs => [...prevTabs, newTab]);
    setActiveTabId(newTab.id);
    return newTab;
  }, [tabs, saveCurrentViewState]);

  // Monaco handlers
  function handleBeforeMount(monaco: Monaco) {
    registerRitobinLanguage(monaco);
    registerRitobinTheme(monaco);
    setMonacoInstance(monaco);
    loadSavedTheme(invoke, monaco);
  }

  const handleThemeApplied = () => {
    if (monacoInstance) {
      loadSavedTheme(invoke, monacoInstance);
    }
  };

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

    // Restore view state for active tab
    if (activeTabId) {
      setTimeout(() => restoreViewState(activeTabId), 0);
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

  // Cleanup subscriptions when tab changes or component unmounts
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
    };
  }, [activeTabId]); // Run cleanup when tab changes

  // Ref to track if tab was already modified (to skip unnecessary state updates)
  const wasModifiedRef = useRef(false);

  // Reset wasModified ref when active tab changes
  useEffect(() => {
    wasModifiedRef.current = activeTab?.isModified || false;
  }, [activeTabId, activeTab?.isModified]);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && activeTabId) {
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
        addTab(result.path, result.content);
        setStatusMessage(`Opened ${result.path}`);
        statusMessageRef.current = `Opened ${result.path}`;
        
        if (result.path) {
          await addToRecentFiles(result.path);
        }
        
        // Open linked bin files if preference enabled
        await openLinkedBinFiles(result.path, result.content);
        
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
    if (!activeTab) return;
    
    try {
      // Block hash status updates while saving
      allowHashStatusUpdateRef.current = false;
      if (activeTab.filePath) {
        // Read content from editor for active tab, or from state for inactive tabs
        const content = editorRef.current?.getValue() || activeTab.content;
        await saveBinFile(activeTab.filePath, content);
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTabId ? { ...t, isModified: false } : t
          )
        );
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
    if (!activeTab) return;
    
    try {
      // Block hash status updates while saving
      allowHashStatusUpdateRef.current = false;
      // Read content from editor for active tab, or from state for inactive tabs
      const content = editorRef.current?.getValue() || activeTab.content;
      const newPath = await saveBinFileAs(content);
      if (newPath) {
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTabId ? { 
              ...t, 
              filePath: newPath, 
              fileName: getFileName(newPath),
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
  const handleUndo = () => editorRef.current?.trigger('keyboard', 'undo', null);
  const handleRedo = () => editorRef.current?.trigger('keyboard', 'redo', null);
  const handleCut = () => document.execCommand('cut');
  const handleCopy = () => document.execCommand('copy');
  const handlePaste = () => document.execCommand('paste');

  const handleFind = () => {
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
  const handleSelectAll = () => editorRef.current?.trigger('keyboard', 'editor.action.selectAll', null);
  const handleGeneralEdit = () => {
    setFindWidgetOpen(false);
    setReplaceWidgetOpen(false);
    setParticlePanelOpen(false);
    editorRef.current?.trigger('keyboard', 'closeFindWidget', null);
    setGeneralEditPanelOpen(!generalEditPanelOpen);
  };
  
  // Handle content change from General Edit Panel (undoable, preserves cursor/scroll)
  const handleGeneralEditContentChange = (newContent: string) => {
    if (activeTabId && editorRef.current) {
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
  const handlePreferences = () => setShowPreferencesDialog(true);
  const handleSettings = () => setShowSettingsDialog(true);
  const handleAbout = () => setShowAboutDialog(true);

  // Helper to check if current file is a bin file
  const isBinFileOpen = (): boolean => {
    if (!activeTab) return false;
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
        recentFiles={recentFiles}
        onOpenRecentFile={openFileFromPath}
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

      {tabs.length === 0 ? (
        <WelcomeScreen onOpenFile={handleOpen} />
      ) : (
        <div className="editor-container">
          {activeTab && (
            <>
              <Editor
                key={activeTabId} // Force remount when tab changes for clean state
                height="100%"
                defaultLanguage={RITOBIN_LANGUAGE_ID}
                value={activeTab.content}
                theme={RITOBIN_THEME_ID}
                beforeMount={handleBeforeMount}
                onMount={handleEditorMount}
                onChange={handleEditorChange}
                options={{
                  minimap: { enabled: true },
                  fontSize: 14,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                  fixedOverflowWidgets: true, // Render tooltips outside editor container
                  find: {
                    addExtraSpaceOnTop: false,
                    autoFindInSelection: 'never',
                    seedSearchStringFromSelection: 'always',
                  },
                  // Memory optimization options
                  ...({
                    "bracketPairColorization.enabled": false, // reduces memory
                    "suggest.maxVisibleSuggestions": 5,
                  } as any),
                }}
              />
              {generalEditPanelOpen && (
                <GeneralEditPanel
                  isOpen={generalEditPanelOpen}
                  onClose={() => setGeneralEditPanelOpen(false)}
                  editorContent={editorRef.current?.getValue() || activeTab.content}
                  onContentChange={handleGeneralEditContentChange}
                />
              )}
              {particlePanelOpen && (
                <ParticleEditorPanel
                  isOpen={particlePanelOpen}
                  onClose={() => setParticlePanelOpen(false)}
                  editorContent={editorRef.current?.getValue() || activeTab.content}
                  onContentChange={handleGeneralEditContentChange}
                  onScrollToLine={handleScrollToLine}
                  onStatusUpdate={setStatusMessage}
                />
              )}
            </>
          )}
        </div>
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

      <SettingsDialog
        isOpen={showSettingsDialog}
        onClose={() => setShowSettingsDialog(false)}
      />

      <PreferencesDialog
        isOpen={showPreferencesDialog}
        onClose={() => setShowPreferencesDialog(false)}
      />

      {activeTab && particleDialogOpen && (
        <ParticleEditorDialog
          isOpen={particleDialogOpen}
          onClose={() => setParticleDialogOpen(false)}
          editorContent={editorRef.current?.getValue() || activeTab.content}
          onContentChange={handleGeneralEditContentChange}
          onScrollToLine={handleScrollToLine}
          onStatusUpdate={setStatusMessage}
        />
      )}
    </div>
  );
}

export default App;
