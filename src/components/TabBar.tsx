import React, { useRef, useEffect } from 'react';
import './TabBar.css';
import { PinIcon, CloseIcon } from './Icons';
import { useTabDrag } from '../shells/tabDrag';

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
    /** 'editor' (default), 'texture-preview', 'quartz-diff', 'compare', 'markdown-preview', 'studio', or 'animstudio' */
    tabType?: 'editor' | 'texture-preview' | 'quartz-diff' | 'compare' | 'markdown-preview' | 'studio' | 'animstudio';
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
    /** Split this group DOWNwards (vertical / column split). Shown next
     *  to the side-split button when provided. Gated by `splitDisabled`
     *  too. */
    onSplitDown?: () => void;
    /** Collapse all splits back into one group. Rendered only when
     *  provided (i.e. when more than one group exists). */
    onUnsplit?: () => void;
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
    /** Visual-Studio-style drag-to-reorder. When provided (single-pane
     *  bars only), grabbing a tab and moving it left/right repositions
     *  it live. `from`/`to` are indices into the rendered tab list,
     *  which for a single-pane bar are the `tabs` array indices. */
    onReorderTab?: (from: number, to: number) => void;
    /** Id of the editor group this bar belongs to. Enables VSCode-style
     *  drag-out: once a dragged tab leaves this strip, the drag is handed
     *  to the cross-group/split controller (TabDragProvider). */
    groupId?: string;
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
    onSplitDown,
    onUnsplit,
    paneFilter,
    onDropTabIntoPane,
    onRevealInExplorer,
    onReorderTab,
    groupId,
}: TabBarProps) {
    const tabDrag = useTabDrag();
    const [tabCtx, setTabCtx] = React.useState<{ x: number; y: number; tab: EditorTab } | null>(null);
    // Id of the tab currently being dragged for reorder — used to dim it.
    const [draggingId, setDraggingId] = React.useState<string | null>(null);
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

    // Visual-Studio-style drag-to-reorder for the single-pane bar.
    // Owns the whole gesture so it can decide between two outcomes:
    //   - horizontal move inside the strip → live reorder (swap the
    //     dragged tab past each neighbour's midpoint).
    //   - pulled clearly BELOW the strip → hand off to the shell's
    //     pop-out gesture (`onTabPointerDown`), if one is wired. This
    //     is why reorder must own pointerdown instead of running
    //     alongside pop-out: otherwise a horizontal drag would both
    //     reorder AND float the document.
    const startReorderGesture = (e: React.PointerEvent, draggedId: string) => {
        // Left button only; never start from the close button.
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('.tab-close-btn')) return;
        const startX = e.clientX;
        const startY = e.clientY;
        const downTarget = e.target;
        const DRAG_THRESHOLD = 6;
        // How far below the strip the pointer must travel before we
        // abandon reorder and pop the document out (single-pane VS
        // shell only — `onTabPointerDown` is undefined elsewhere).
        const POP_MARGIN = 34;
        let mode: 'idle' | 'reorder' = 'idle';
        // Index we last asked the dragged tab to move to. `pointermove`
        // can outrun React's commit, so until the live DOM shows the
        // dragged tab actually sitting at this index we skip — otherwise
        // a second move reads the pre-commit DOM and reorders again,
        // bouncing the tab back and forth.
        let expectedIndex: number | null = null;

        const cleanup = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.body.style.cursor = '';
            setDraggingId(null);
        };
        // Below-the-strip escape hatch → defer to the shell's pop-out.
        const tryPopOut = (ev: PointerEvent): boolean => {
            const rect = tabsContainerRef.current?.getBoundingClientRect();
            if (onTabPointerDown && rect && ev.clientY > rect.bottom + POP_MARGIN) {
                cleanup();
                onTabPointerDown(
                    { target: downTarget, button: 0, clientX: ev.clientX, clientY: ev.clientY } as unknown as React.PointerEvent,
                    draggedId,
                );
                return true;
            }
            return false;
        };

        const onMove = (ev: PointerEvent) => {
            if (mode === 'idle') {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
                if (tryPopOut(ev)) return;
                mode = 'reorder';
                setDraggingId(draggedId);
                document.body.style.cursor = 'grabbing';
            }
            if (tryPopOut(ev)) return;
            // Once the dragged tab leaves THIS strip, hand off to the
            // cross-group / drop-to-split controller (VSCode-style). Pure
            // within-strip movement stays a plain reorder below.
            if (tabDrag && groupId) {
                const strip = tabsContainerRef.current?.getBoundingClientRect();
                const outside = !strip
                    || ev.clientX < strip.left || ev.clientX > strip.right
                    || ev.clientY < strip.top || ev.clientY > strip.bottom;
                if (outside) {
                    cleanup();
                    const label = tabs.find(t => t.id === draggedId)?.fileName ?? '';
                    tabDrag.beginTabDrag(draggedId, label, groupId, ev.clientX, ev.clientY);
                    return;
                }
            }
            // Re-read the live DOM each move: as we reorder, the tab
            // nodes shuffle, so the dragged tab's index and every
            // neighbour's rect change. Reading fresh keeps the math
            // self-correcting frame to frame.
            const container = tabsContainerRef.current;
            if (!container) return;
            const els = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'));
            const from = els.findIndex(el => el.dataset.tabId === draggedId);
            if (from < 0) return;
            // Wait for the previous reorder to land in the DOM before
            // computing the next one.
            if (expectedIndex !== null && from !== expectedIndex) return;
            expectedIndex = null;
            let to = els.length - 1;
            for (let i = 0; i < els.length; i++) {
                if (i === from) continue;
                const r = els[i].getBoundingClientRect();
                if (ev.clientX < r.left + r.width / 2) {
                    // Account for the dragged node being spliced out
                    // first: a slot to its right shifts down by one.
                    to = i > from ? i - 1 : i;
                    break;
                }
            }
            if (to !== from) {
                expectedIndex = to;
                onReorderTab?.(from, to);
            }
        };
        const onUp = () => cleanup();
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    };

    return (
        <div
            className={`tab-bar${paneFilter ? ` tab-bar-pane-${paneFilter}` : ''}`}
            data-pane={paneFilter}
            data-group-id={groupId}
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
                        className={`tab ${activeTabId === tab.id ? 'active' : ''} ${tab.isModified ? 'modified' : ''} ${tab.isPinned ? 'pinned' : ''} ${draggingId === tab.id ? 'dragging' : ''}`}
                        onClick={() => onTabSelect(tab.id)}
                        onMouseDown={(e) => handleMouseDown(e, tab.id)}
                        onPointerDown={(e) => {
                            // Split mode keeps the existing cross-pane
                            // drag (+ pop-out) path. In single-pane
                            // mode, reorder OWNS the gesture and decides
                            // internally whether to reposition the tab
                            // or hand off to pop-out, so we must not also
                            // fire onTabPointerDown here.
                            if (paneFilter && onDropTabIntoPane) {
                                onTabPointerDownInternal(e, tab.id);
                                onTabPointerDown?.(e, tab.id);
                            } else if (onReorderTab) {
                                startReorderGesture(e, tab.id);
                            } else {
                                onTabPointerDown?.(e, tab.id);
                            }
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

            {(tabs.length > 1 || onToggleSplit || onUnsplit) && (
                <div className="tabs-actions">
                    {/* Unsplit / join — collapse every split back into one
                        group. Only shown when there's more than one group
                        (the shell passes `onUnsplit` only then). */}
                    {onUnsplit && (
                        <button
                            className="tab-split-btn"
                            onClick={onUnsplit}
                            title="Unsplit — merge all editor groups back into one"
                        >
                            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
                                <rect x="1" y="1" width="12" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
                                <path d="M5 3.5 7 6 5 8.5M9 3.5 7 6l2 2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
                            </svg>
                        </button>
                    )}
                    {/* Split DOWN (vertical / column). */}
                    {onSplitDown && !splitDisabled && (
                        <button
                            className="tab-split-btn"
                            onClick={onSplitDown}
                            title="Split editor down"
                        >
                            <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
                                <rect x="1" y="1" width="10" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
                                <rect x="1" y="8" width="10" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
                            </svg>
                        </button>
                    )}
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

let animStudioCounter = 0;
export function createAnimStudioTab(): EditorTab {
    animStudioCounter += 1;
    const n = animStudioCounter;
    return {
        id: generateTabId(),
        filePath: null,
        fileName: n === 1 ? 'Anim Studio' : `Anim Studio ${n}`,
        content: '',
        isModified: false,
        isPinned: false,
        tabType: 'animstudio',
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
