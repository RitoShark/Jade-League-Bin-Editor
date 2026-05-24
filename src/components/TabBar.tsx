import React, { useRef, useEffect } from 'react';
import './TabBar.css';
import { PinIcon, CloseIcon } from './Icons';

export interface EditorTab {
    id: string;
    filePath: string | null;
    fileName: string;
    content: string;
    isModified: boolean;
    isPinned: boolean;
    /** Which pane this tab belongs to when split-pane mode is on.
     *  Defaults to `'left'`; ignored when split is off (the single
     *  tab bar shows every tab regardless of this field). Drag-and-
     *  drop between the two tab bars flips this field. */
    pane?: 'left' | 'right';
    /** 'editor' (default), 'texture-preview', 'quartz-diff', 'compare', 'markdown-preview', or 'studio' */
    tabType?: 'editor' | 'texture-preview' | 'quartz-diff' | 'compare' | 'markdown-preview' | 'studio';
    /** For markdown-preview tabs: id of the source editor tab whose content we render. */
    sourceTabId?: string;
    /** For texture-preview tabs: decoded PNG data URL */
    textureDataUrl?: string | null;
    /** For texture-preview tabs: pixel dimensions */
    textureWidth?: number;
    textureHeight?: number;
    /** For texture-preview tabs: TEX format enum value */
    textureFormat?: number;
    /** For texture-preview tabs: error string if loading failed */
    textureError?: string | null;
    /** For quartz-diff tabs: source editor tab id */
    diffSourceTabId?: string;
    /** For quartz-diff tabs: source BIN file path */
    diffSourceFilePath?: string;
    /** For quartz-diff tabs: unique history/diff entry id */
    diffEntryId?: string;
    /** For quartz-diff tabs: Quartz mode label */
    diffMode?: 'paint' | 'port' | 'bineditor' | 'vfxhub';
    /** For quartz-diff tabs: original content before Quartz edits */
    diffOriginalContent?: string;
    /** For quartz-diff tabs: modified content after Quartz edits */
    diffModifiedContent?: string;
    /** For quartz-diff tabs: entry review status */
    diffStatus?: 'pending' | 'accepted' | 'rejected';
    /** For compare tabs: source tab id rendered on the left of the diff. */
    compareLeftTabId?: string;
    /** For compare tabs: source tab id rendered on the right of the diff. */
    compareRightTabId?: string;
}

interface TabBarProps {
    tabs: EditorTab[];
    activeTabId: string | null;
    onTabSelect: (tabId: string) => void;
    onTabClose: (tabId: string) => void;
    onTabCloseAll: () => void;
    onTabPin: (tabId: string) => void;
    /** Pointer-down on a tab — used by the VS shell to start a tab-drag
     *  gesture for popping the document out into a floating window. */
    onTabPointerDown?: (e: React.PointerEvent, tabId: string) => void;
    /** When set, renders a Split / Unsplit toggle button next to the
     *  Close All button. `splitMode` controls the button's pressed
     *  state and tooltip. The actual layout change happens in
     *  `EditorPane` — this is just the UI affordance to trigger it.
     *  Pass `splitDisabled` to grey it out (we gate on tabs.length>=2). */
    splitMode?: boolean;
    onToggleSplit?: () => void;
    splitDisabled?: boolean;
    /** Pane filter — when present, only tabs whose `pane` matches are
     *  shown. The two tab bars in split mode pass `'left'` and
     *  `'right'` respectively. Tabs missing a `pane` field are
     *  treated as left. */
    paneFilter?: 'left' | 'right';
    /** Drag-drop reassignment — fired when the user drops a tab from
     *  the OTHER tab bar onto this one. The TabBar handles the drag/
     *  drop events; this just delivers the result. */
    onDropTabIntoPane?: (tabId: string, pane: 'left' | 'right') => void;
    /** Right-click → "Reveal in Explorer" handler. Only shown for
     *  tabs that have an on-disk file path. When omitted the
     *  context menu falls back to the plain stub. */
    onRevealInExplorer?: (filePath: string) => void;
}

export default function TabBar({
    tabs,
    activeTabId,
    onTabSelect,
    onTabClose,
    onTabCloseAll,
    onTabPin,
    onTabPointerDown,
    splitMode,
    onToggleSplit,
    splitDisabled,
    paneFilter,
    onDropTabIntoPane,
    onRevealInExplorer,
}: TabBarProps) {
    const [tabCtx, setTabCtx] = React.useState<{ x: number; y: number; tab: EditorTab } | null>(null);
    React.useEffect(() => {
        if (!tabCtx) return;
        const onDown = (ev: MouseEvent) => {
            const t = ev.target as HTMLElement;
            if (!t.closest('.tab-ctx-menu')) setTabCtx(null);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [tabCtx]);
    // Apply the pane filter — tabs with no `pane` field count as
    // left, mirroring how the App side treats them. Without this
    // filter (single-pane mode) every tab is shown regardless.
    const visibleTabs = paneFilter
        ? tabs.filter(t => (t.pane ?? 'left') === paneFilter)
        : tabs;
    const tabsContainerRef = useRef<HTMLDivElement>(null);

    // Scroll active tab into view when it changes
    useEffect(() => {
        if (activeTabId && tabsContainerRef.current) {
            const activeTab = tabsContainerRef.current.querySelector(`[data-tab-id="${activeTabId}"]`);
            if (activeTab) {
                activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            }
        }
    }, [activeTabId]);

    const handleMouseDown = (e: React.MouseEvent, tabId: string) => {
        // Middle click to close
        if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            onTabClose(tabId);
        }
    };

    const handleContextMenu = (e: React.MouseEvent, tab: EditorTab) => {
        e.preventDefault();
        // Only show the menu when at least one action would be
        // available — currently that's "Reveal in Explorer" gated
        // on the tab having a filePath.
        if (!tab.filePath || !onRevealInExplorer) return;
        setTabCtx({ x: e.clientX, y: e.clientY, tab });
    };

    const handleCloseClick = (e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        onTabClose(tabId);
    };

    const handleCloseMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDoubleClick = (_e: React.MouseEvent, tabId: string) => {
        // Double click to pin/unpin
        onTabPin(tabId);
    };

    // Handle horizontal scroll with mouse wheel
    const handleWheel = (e: React.WheelEvent) => {
        if (tabsContainerRef.current) {
            tabsContainerRef.current.scrollLeft += e.deltaY;
        }
    };

    // Don't render when there are zero tabs (single-pane mode) OR
    // when the pane filter excludes all tabs AND there's no drop
    // target (otherwise we still want a visible empty drop zone).
    if (tabs.length === 0) {
        return null;
    }
    // Note: in split mode we ALWAYS render even when this pane is
    // empty — the empty bar is the visual cue + drop target the
    // user needs to populate the other side.

    // Pointer-event-driven cross-pane drag. We can't use HTML5
    // dataTransfer because:
    //   - Tauri's webview2 has flaky support for custom MIME types
    //     in dataTransfer, so the drop target can't reliably read
    //     the payload back.
    //   - The Visual Studio shell already uses pointer events on
    //     tabs for the pop-out gesture; mixing HTML5 dragstart and
    //     pointerdown on the same element produces "drag does
    //     nothing or just pops out" — exactly what the user saw.
    // The flow:
    //   1. pointerdown on a tab inside a pane-filtered bar →
    //      stash the tab id + origin pane in a ref.
    //   2. pointermove past a small threshold → set body cursor.
    //   3. pointerup → use `document.elementFromPoint(...)` to find
    //      which tab bar is under the cursor (we tag each bar with
    //      `data-pane`) and fire `onDropTabIntoPane` if it's the
    //      OTHER pane.
    // This bypasses HTML5 drag entirely and works in any webview.
    const onTabPointerDownInternal = (e: React.PointerEvent, tabId: string) => {
        // Only the LEFT mouse button — right-click + middle-click are
        // already wired to context-menu and close, respectively.
        if (e.button !== 0) return;
        if (!paneFilter || !onDropTabIntoPane) return;

        const startX = e.clientX;
        const startY = e.clientY;
        let dragging = false;
        const DRAG_THRESHOLD = 6;

        const onMove = (ev: PointerEvent) => {
            if (!dragging) {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
                dragging = true;
                document.body.style.cursor = 'grabbing';
            }
        };
        const onUp = (ev: PointerEvent) => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.body.style.cursor = '';
            if (!dragging) return;
            // Find the tab bar element under the cursor on release.
            // Each pane-filtered bar carries `data-pane="left|right"`
            // (set on the wrapper div below), so we walk up from the
            // hit element looking for that attribute.
            const hit = document.elementFromPoint(ev.clientX, ev.clientY);
            let node: Element | null = hit;
            while (node && node !== document.body) {
                const dp = (node as HTMLElement).dataset?.pane;
                if (dp === 'left' || dp === 'right') {
                    if (dp !== paneFilter) {
                        onDropTabIntoPane(tabId, dp);
                    }
                    return;
                }
                node = node.parentElement;
            }
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    };

    return (
        <div
            className={`tab-bar${paneFilter ? ` tab-bar-pane-${paneFilter}` : ''}`}
            data-pane={paneFilter}
        >
            <div
                className="tabs-container"
                ref={tabsContainerRef}
                onWheel={handleWheel}
            >
                {/* Empty-pane hint — visible in split mode when a
                    pane has no tabs assigned to it. Doubles as a
                    drop target via the parent `.tab-bar` (which
                    already has the `data-pane` + pointerup hit
                    detection wired). */}
                {paneFilter && visibleTabs.length === 0 && (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            paddingLeft: 12,
                            fontSize: 11,
                            fontStyle: 'italic',
                            color: 'var(--text-secondary, #9DA5B4)',
                            opacity: 0.7,
                            pointerEvents: 'none',
                        }}
                    >
                        Drag a tab here
                    </div>
                )}
                {visibleTabs.map((tab) => (
                    <div
                        key={tab.id}
                        data-tab-id={tab.id}
                        className={`tab ${activeTabId === tab.id ? 'active' : ''} ${tab.isModified ? 'modified' : ''} ${tab.isPinned ? 'pinned' : ''}`}
                        onClick={() => onTabSelect(tab.id)}
                        onMouseDown={(e) => handleMouseDown(e, tab.id)}
                        onPointerDown={(e) => {
                            // In split mode the cross-pane drag
                            // handler takes priority; the existing
                            // VS-shell pop-out drag still runs
                            // afterwards because the threshold/up
                            // listeners are document-scoped and the
                            // shell's drag tracker is unaffected.
                            if (paneFilter && onDropTabIntoPane) {
                                onTabPointerDownInternal(e, tab.id);
                            }
                            onTabPointerDown?.(e, tab.id);
                        }}
                        onContextMenu={(e) => handleContextMenu(e, tab)}
                        onDoubleClick={(e) => handleDoubleClick(e, tab.id)}
                        title={tab.filePath || tab.fileName}
                    >
                        {tab.isPinned && <span className="tab-pin-icon"><PinIcon size={12} /></span>}
                        <span className="tab-label">
                            {tab.isModified && <span className="tab-modified-dot">●</span>}
                            {tab.fileName}
                        </span>
                        {!tab.isPinned && (
                            <button
                                className="tab-close-btn"
                                onMouseDown={handleCloseMouseDown}
                                onClick={(e) => handleCloseClick(e, tab.id)}
                                title="Close (Middle Click)"
                            >
                                <CloseIcon size={16} strokeWidth={2.5} />
                            </button>
                        )}
                    </div>
                ))}
            </div>

            {(tabs.length > 1 || onToggleSplit) && (
                <div className="tabs-actions">
                    {/* The split button is only useful when at least
                        two tabs exist — splitting with a single tab
                        leaves the right pane empty until the user
                        opens another file, which the user explicitly
                        called out as confusing. We hide it entirely
                        rather than greying out, so the actions row
                        stays clean for single-tab sessions. */}
                    {onToggleSplit && !splitDisabled && (
                        <button
                            className={`tab-split-btn${splitMode ? ' active' : ''}`}
                            onClick={onToggleSplit}
                            title={splitMode ? 'Unsplit editor' : 'Split editor right'}
                        >
                            {/* Two-rectangle glyph — left rect outlined,
                                right rect filled when active. Pure
                                inline SVG so we don't drag in another
                                icon dependency. */}
                            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
                                <rect
                                    x="1"
                                    y="1"
                                    width="5"
                                    height="10"
                                    rx="1"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                />
                                <rect
                                    x="8"
                                    y="1"
                                    width="5"
                                    height="10"
                                    rx="1"
                                    fill={splitMode ? 'currentColor' : 'none'}
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                />
                            </svg>
                        </button>
                    )}
                    {tabs.length > 1 && (
                        <button
                            className="close-all-btn"
                            onClick={onTabCloseAll}
                            title="Close All Tabs"
                        >
                            <CloseIcon size={12} /> All
                        </button>
                    )}
                </div>
            )}
            {tabCtx && tabCtx.tab.filePath && onRevealInExplorer && (
                <div
                    className="tab-ctx-menu"
                    style={{ position: 'fixed', left: tabCtx.x, top: tabCtx.y }}
                >
                    <button onClick={() => {
                        onRevealInExplorer(tabCtx.tab.filePath!);
                        setTabCtx(null);
                    }}>Reveal in Explorer</button>
                </div>
            )}
        </div>
    );
}

// Helper to generate unique tab IDs
let tabIdCounter = 0;
export function generateTabId(): string {
    return `tab-${++tabIdCounter}-${Date.now()}`;
}

// Helper to get file name from path
export function getFileName(filePath: string | null): string {
    if (!filePath) return 'Untitled';
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || 'Untitled';
}

// Create a new editor tab object
export function createTab(filePath: string | null, content: string): EditorTab {
    return {
        id: generateTabId(),
        filePath,
        fileName: getFileName(filePath),
        content,
        isModified: false,
        isPinned: false,
        tabType: 'editor',
    };
}

// Create a texture preview tab
export function createTexPreviewTab(filePath: string): EditorTab {
    const fileName = getFileName(filePath);
    return {
        id: generateTabId(),
        filePath,
        fileName,
        content: '',
        isModified: false,
        isPinned: false,
        tabType: 'texture-preview',
        textureDataUrl: null,
        textureWidth: 0,
        textureHeight: 0,
        textureFormat: 0,
        textureError: null,
    };
}

interface QuartzDiffTabParams {
    entryId: string;
    sourceTabId: string;
    sourceFilePath: string;
    fileName: string;
    mode: 'paint' | 'port' | 'bineditor' | 'vfxhub';
    originalContent: string;
    modifiedContent: string;
    status?: 'pending' | 'accepted' | 'rejected';
}

// Create a Photo Studio tab. No file backing — the scene state lives in
// memory until the user explicitly saves it via Save As (.studio.json).
let studioCounter = 0;
export function createStudioTab(): EditorTab {
    studioCounter += 1;
    const n = studioCounter;
    return {
        id: generateTabId(),
        filePath: null,
        fileName: n === 1 ? 'Studio' : `Studio ${n}`,
        content: '',
        isModified: false,
        isPinned: false,
        tabType: 'studio',
    };
}

// Create a markdown-preview tab tied to an existing markdown editor tab.
export function createMarkdownPreviewTab(sourceTabId: string, sourceFileName: string): EditorTab {
    return {
        id: generateTabId(),
        filePath: null,
        fileName: `Preview: ${sourceFileName}`,
        content: '',
        isModified: false,
        isPinned: false,
        tabType: 'markdown-preview',
        sourceTabId,
    };
}

// Build a generic "Compare Files" diff tab tied to two existing editor
// tabs. Content is read live from the source tabs at render time so
// saves/edits flow into the diff without needing to re-open it.
export function createCompareTab(
    leftTabId: string,
    leftName: string,
    rightTabId: string,
    rightName: string,
): EditorTab {
    return {
        id: generateTabId(),
        filePath: null,
        fileName: `Compare: ${leftName} ⇄ ${rightName}`,
        content: '',
        isModified: false,
        isPinned: false,
        tabType: 'compare',
        compareLeftTabId: leftTabId,
        compareRightTabId: rightTabId,
    };
}

export function createQuartzDiffTab(params: QuartzDiffTabParams): EditorTab {
    return {
        id: generateTabId(),
        filePath: null,
        fileName: `${params.fileName} (Quartz Diff)`,
        content: params.modifiedContent,
        isModified: false,
        isPinned: false,
        tabType: 'quartz-diff',
        diffSourceTabId: params.sourceTabId,
        diffSourceFilePath: params.sourceFilePath,
        diffEntryId: params.entryId,
        diffMode: params.mode,
        diffOriginalContent: params.originalContent,
        diffModifiedContent: params.modifiedContent,
        diffStatus: params.status ?? 'pending',
    };
}
