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

  // Get the active tab
  const activeTab = tabs.find(t => t.id === activeTabId) || null;
  
  // Ref to track active tab for keyboard shortcuts
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

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

    // Keyboard shortcut for General Edit panel (Ctrl+O), Particle panel (Ctrl+Shift+P) and Escape to close
    const handleKeyDown = (e: KeyboardEvent) => {
      // Helper to check if current file is a bin file (using ref for up-to-date value)
      const isBinFile = (): boolean => {
        const tab = activeTabRef.current;
        if (!tab) return false;
        return tab.fileName.toLowerCase().endsWith('.bin');
      };
      
      if (e.ctrlKey && e.key === 'o') {
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
      setStatusMessage('Auto-downloading latest hash files...');
      try {
        await invoke('download_hashes', { useBinary: useBinaryFormat });
        setStatusMessage('Latest hash files downloaded');
      } catch (error) {
        console.error('[App] Failed to auto-download hashes:', error);
        setStatusMessage('Ready');
      }
    } catch (error) {
      console.error('[App] Failed to auto-download hashes:', error);
    }
  };

  // Preload hashes in background if setting is enabled
  const preloadHashesIfEnabled = async () => {
    try {
      const preloadEnabled = await invoke<string>('get_preference', { 
        key: 'PreloadHashes', 
        defaultValue: 'False' 
      });
      
      if (preloadEnabled === 'True') {
        setStatusMessage('Preloading hashes...');
        
        // Run preload in background - don't await
        invoke<{ loaded: boolean; fnv_count: number; xxh_count: number; memory_bytes: number }>('preload_hashes')
          .then((status) => {
            if (status.loaded) {
              const totalHashes = status.fnv_count + status.xxh_count;
              const memoryMB = Math.round(status.memory_bytes / 1024 / 1024);
              setStatusMessage(`Ready (${totalHashes} hashes preloaded)`);
            }
          })
          .catch((error) => {
            console.error('[App] Failed to preload hashes:', error);
            setStatusMessage('Ready');
          });
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
      setStatusMessage(`Opening ${getFileName(filePath)}...`);
      
      const existingTab = tabs.find(t => t.path && t.path.toLowerCase() === filePath.toLowerCase());
      if (existingTab) {
        setActiveTabId(existingTab.id);
        setStatusMessage(`Switched to ${getFileName(filePath)}`);
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
      
      await openLinkedBinFiles(filePath, content);
    } catch (error) {
      console.error("Failed to open file:", error);
      setStatusMessage(`Failed to open file: ${error}`);
    }
  };


  // Save current editor view state before switching tabs
  const saveCurrentViewState = useCallback(() => {
    if (editorRef.current && activeTabId) {
      const viewState = editorRef.current.saveViewState();
      viewStatesRef.current.set(activeTabId, { viewState });
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

    // Remove view state
    viewStatesRef.current.delete(tabId);

    setTabs(prevTabs => {
      const newTabs = prevTabs.filter(t => t.id !== tabId);
      
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

  // Update tab content
  const updateTabContent = useCallback((tabId: string, content: string, isModified: boolean = true) => {
    setTabs(prevTabs =>
      prevTabs.map(t =>
        t.id === tabId ? { ...t, content, isModified } : t
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
    editorRef.current = editor;

    // Update caret position on cursor change
    editor.onDidChangeCursorPosition((e) => {
      setCaretPosition({ line: e.position.lineNumber, column: e.position.column });
    });

    // Update line count when model changes
    const model = editor.getModel();
    if (model) {
      setLineCount(model.getLineCount());
    }

    // Restore view state for active tab
    if (activeTabId) {
      setTimeout(() => restoreViewState(activeTabId), 0);
    }

    // Watch for find widget visibility
    setTimeout(() => {
      const editorElement = editor.getDomNode();
      if (editorElement) {
        const observer = new MutationObserver(() => {
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

        observer.observe(editorElement, {
          attributes: true,
          childList: true,
          subtree: true,
          attributeFilter: ['class', 'style', 'aria-hidden']
        });
      }
    }, 500);
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && activeTabId) {
      updateTabContent(activeTabId, value, true);
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
      const result = await openBinFile();
      if (result) {
        addTab(result.path, result.content);
        setStatusMessage(`Opened ${result.path}`);
        
        if (result.path) {
          await addToRecentFiles(result.path);
        }
        
        // Open linked bin files if preference enabled
        await openLinkedBinFiles(result.path, result.content);
      }
    } catch (error) {
      console.error('Failed to open file:', error);
      setStatusMessage(`Error: ${error}`);
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
      
      setStatusMessage('Loading linked files...');
      
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
      }
    } catch (error) {
      console.error('Error opening linked bin files:', error);
    }
  };

  const handleSave = async () => {
    if (!activeTab) return;
    
    try {
      if (activeTab.filePath) {
        await saveBinFile(activeTab.filePath, activeTab.content);
        setTabs(prevTabs =>
          prevTabs.map(t =>
            t.id === activeTabId ? { ...t, isModified: false } : t
          )
        );
        setStatusMessage(`Saved ${activeTab.filePath}`);
      } else {
        handleSaveAs();
      }
    } catch (error) {
      console.error('Failed to save file:', error);
      setStatusMessage(`Error: ${error}`);
      alert(`Failed to save file: ${error}`);
    }
  };

  const handleSaveAs = async () => {
    if (!activeTab) return;
    
    try {
      const newPath = await saveBinFileAs(activeTab.content);
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
      }
    } catch (error) {
      console.error('Failed to save file:', error);
      setStatusMessage(`Error: ${error}`);
      alert(`Failed to save file: ${error}`);
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
        
        // Push a stack element to create a new undo stop (prevents merging with previous edits)
        model.pushStackElement();
        
        // Use pushEditOperations for proper undo stack with cursor restoration
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
        
        // Push another stack element to close this undo group
        model.pushStackElement();
        
        // Update tab content state
        updateTabContent(activeTabId, newContent, true);
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
                }}
              />
              <GeneralEditPanel
                isOpen={generalEditPanelOpen}
                onClose={() => setGeneralEditPanelOpen(false)}
                editorContent={activeTab.content}
                onContentChange={handleGeneralEditContentChange}
              />
              <ParticleEditorPanel
                isOpen={particlePanelOpen}
                onClose={() => setParticlePanelOpen(false)}
                editorContent={activeTab.content}
                onContentChange={handleGeneralEditContentChange}
                onScrollToLine={handleScrollToLine}
              />
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

      {activeTab && (
        <ParticleEditorDialog
          isOpen={particleDialogOpen}
          onClose={() => setParticleDialogOpen(false)}
          editorContent={activeTab.content}
          onContentChange={handleGeneralEditContentChange}
          onScrollToLine={handleScrollToLine}
        />
      )}
    </div>
  );
}

export default App;
