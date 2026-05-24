import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import TabBar from '../components/TabBar';
import StatusBar from '../components/StatusBar';
import { WelcomeScreenWithExit } from '../components/WelcomeScreen';
import GeneralEditPanel from '../components/GeneralEditPanel';
import ParticleEditorPanel from '../components/ParticleEditorPanel';
import MarkdownEditPanel from '../components/MarkdownEditPanel';
import BinNavPanel from '../components/BinNavPanel';
import VSToolbar from './VSToolbar';
import VSTitleBar from './VSTitleBar';
import VSDockPane from './VSDockPane';
import VSDockGroup from './VSDockGroup';
import FloatingEditorPane from './FloatingEditorPane';
import MaterialOverridePanel from './MaterialOverridePanel';
import EditorPane from './EditorPane';
import StudioAnimPanel from '../components/StudioAnimPanel';
import StudioBackgroundPanel from '../components/StudioBackgroundPanel';
import StudioActionsPanel from '../components/StudioActionsPanel';
import StudioMeshPanel from '../components/StudioMeshPanel';
import StudioObjectsPanel from '../components/StudioObjectsPanel';
import StudioSpotlightPanel from '../components/StudioSpotlightPanel';
import FileExplorerPane from '../components/FileExplorerPane';
import SharedDialogs from './SharedDialogs';
import WordFindPane from './WordFindPane';
import DockGuides, { hitTestGuides } from './DockGuides';
import FloatingToolWindow from './FloatingToolWindow';
import { useToolLayout, type DockSide, type DockGroup, type ToolId } from './useToolLayout';
import { getFileExtension } from '../lib/binOperations';
import { useShell } from './ShellContext';
import './Dock.css';
import './VisualStudioShell.css';

const TOOL_LABELS: Record<ToolId, string> = {
    general: 'General Editing',
    particle: 'Particle Editor',
    markdown: 'Markdown',
    find: 'Find Results',
    texture: 'Texture Insert',
    material: 'Material Insert',
    binnav: 'Bin Navigation',
    'studio-anim': 'Pose',
    'studio-bg': 'Background',
    'studio-actions': 'Photo',
    'studio-mesh': 'Mesh',
    'studio-objects': 'Objects',
    'studio-spotlight': 'Lighting',
    'file-explorer': 'Explorer',
};

const DOCK_DEFAULT_SIZE: Record<DockSide, number> = {
    'outer-left':   240,
    'inner-left':   280,
    'outer-right':  240,
    'inner-right':  320,
    'outer-top':    160,
    'inner-top':    160,
    'outer-bottom': 200,
    'inner-bottom': 220,
};

const DOCK_MIN_SIZE: Record<DockSide, number> = {
    'outer-left':   180,
    'inner-left':   200,
    'outer-right':  180,
    'inner-right':  220,
    'outer-top':    100,
    'inner-top':    100,
    'outer-bottom': 100,
    'inner-bottom': 100,
};

const DOCK_STORAGE_KEY: Record<DockSide, string> = {
    'outer-left':   'vs-dock-outer-left',
    'inner-left':   'vs-dock-inner-left',
    'outer-right':  'vs-dock-outer-right',
    'inner-right':  'vs-dock-inner-right',
    'outer-top':    'vs-dock-outer-top',
    'inner-top':    'vs-dock-inner-top',
    'outer-bottom': 'vs-dock-outer-bottom',
    'inner-bottom': 'vs-dock-inner-bottom',
};

const DOCK_SPLIT_STORAGE_KEY: Record<DockSide, string> = {
    'outer-left':   'vs-dock-outer-left-split',
    'inner-left':   'vs-dock-inner-left-split',
    'outer-right':  'vs-dock-outer-right-split',
    'inner-right':  'vs-dock-inner-right-split',
    'outer-top':    'vs-dock-outer-top-split',
    'inner-top':    'vs-dock-inner-top-split',
    'outer-bottom': 'vs-dock-outer-bottom-split',
    'inner-bottom': 'vs-dock-inner-bottom-split',
};

/** A `VSDockPane` only knows about the four cardinal sides — strip the
 *  lane prefix so the resize handle ends up on the correct edge. */
function dockPaneSide(side: DockSide): 'left' | 'right' | 'top' | 'bottom' {
    if (side.endsWith('left'))   return 'left';
    if (side.endsWith('right'))  return 'right';
    if (side.endsWith('top'))    return 'top';
    return 'bottom';
}

const FLOAT_DEFAULT_W = 360;
const FLOAT_DEFAULT_H = 320;

/**
 * Visual Studio-style shell. Tool windows can dock to any side
 * (left / right / bottom), tab when sharing a side, or float as their
 * own draggable overlays. During a drag, a guide widget appears at each
 * dock position; releasing on a guide docks the tool, releasing on the
 * editor area floats it.
 */
export default function VisualStudioShell() {
    const s = useShell();
    const { activeTab } = s;
    const { layout, dockTool, splitTool, floatTool, moveFloatingTool, resizeFloatingTool } = useToolLayout();

    const ext = activeTab && s.isEditorTab(activeTab)
        ? getFileExtension(activeTab.filePath ?? activeTab.fileName)
        : null;
    const isMarkdown = ext === 'md' || ext === 'markdown';

    const findOpen = s.findWidgetOpen || s.replaceWidgetOpen;
    const generalOpen = s.generalEditPanelOpen && !!activeTab && s.isEditorTab(activeTab) && !isMarkdown;
    const markdownOpen = s.generalEditPanelOpen && !!activeTab && s.isEditorTab(activeTab) && isMarkdown;
    const particleOpen = s.particlePanelOpen && !!activeTab && s.isEditorTab(activeTab);

    // Studio panels only show when the active tab is a Photo Studio
    // scene. Switching to a file tab hides them automatically; the
    // user's dock placement persists in localStorage so coming back
    // to the studio restores the customised layout.
    const isStudio = activeTab?.tabType === 'studio';

    const isOpen: Record<ToolId, boolean> = {
        general:  generalOpen,
        particle: particleOpen,
        markdown: markdownOpen,
        find:     findOpen,
        texture:  s.textureInsertOpen  && !!activeTab && s.isEditorTab(activeTab),
        material: s.materialInsertOpen && !!activeTab && s.isEditorTab(activeTab),
        binnav:   s.binNavOpen         && !!activeTab && s.isEditorTab(activeTab),
        'studio-anim':    isStudio && s.studioAnimOpen,
        'studio-bg':      isStudio && s.studioBgOpen,
        'studio-actions': isStudio && s.studioActionsOpen,
        'studio-mesh':    isStudio && s.studioMeshOpen,
        'studio-objects': isStudio && s.studioObjectsOpen,
        'studio-spotlight': isStudio && s.studioSpotlightOpen,
        // File Explorer is shell-wide (not bound to a particular tab type)
        // and persists even when no tab is active.
        'file-explorer': s.fileExplorerOpen,
    };

    const closeTool = useCallback((id: ToolId) => {
        switch (id) {
            case 'general':  s.setGeneralEditPanelOpen(false); break;
            case 'particle': s.setParticlePanelOpen(false); break;
            case 'markdown': s.setGeneralEditPanelOpen(false); break;
            case 'find':
                if (s.findWidgetOpen) s.onFind();
                else if (s.replaceWidgetOpen) s.onReplace();
                break;
            case 'texture':  s.setTextureInsertOpen(false); break;
            case 'material': s.setMaterialInsertOpen(false); break;
            case 'binnav':   s.setBinNavOpen(false); break;
            case 'studio-anim':    s.setStudioAnimOpen(false); break;
            case 'studio-bg':      s.setStudioBgOpen(false); break;
            case 'studio-actions': s.setStudioActionsOpen(false); break;
            case 'studio-mesh':    s.setStudioMeshOpen(false); break;
            case 'studio-objects': s.setStudioObjectsOpen(false); break;
            case 'studio-spotlight': s.setStudioSpotlightOpen(false); break;
            case 'file-explorer': {
                // Closing the explorer while a WAD is mounted unmounts
                // it. Confirm first so an accidental click doesn't
                // close any open files backed by that mount.
                const root = s.fileExplorerRoot;
                if (root?.kind === 'wad') {
                    const ok = window.confirm(
                        `Closing the explorer will unmount "${root.label}". Any open files backed by this WAD won't reload. Continue?`,
                    );
                    if (!ok) break;
                    // Best-effort unmount — Rust handles a missing id
                    // gracefully so a failure here isn't fatal.
                    import('@tauri-apps/api/core').then(({ invoke: inv }) => {
                        inv('wad_close', { id: root.mountId }).catch(() => {});
                    });
                    s.setFileExplorerRoot(null);
                }
                s.setFileExplorerOpen(false);
                break;
            }
        }
    }, [s]);

    // Bucket the open tools by side AND group. `docked[side]` is a tuple
    // [group0, group1] of tool-id arrays — tools in the same group tab
    // together, tools in different groups stack inside the same side via
    // `VSDockGroup`'s split divider.
    type GroupedSide = [ToolId[], ToolId[]];
    const docked: Record<DockSide, GroupedSide> = {
        'outer-left':   [[], []], 'inner-left':   [[], []],
        'outer-right':  [[], []], 'inner-right':  [[], []],
        'outer-top':    [[], []], 'inner-top':    [[], []],
        'outer-bottom': [[], []], 'inner-bottom': [[], []],
    };
    const floating: ToolId[] = [];
    (Object.keys(isOpen) as ToolId[]).forEach(id => {
        if (!isOpen[id]) return;
        const p = layout[id];
        if (p.kind === 'dock') docked[p.side][p.group].push(id);
        else floating.push(id);
    });

    // Active tab per (side, group).
    const [activeBySideGroup, setActiveBySideGroup] = useState<Record<DockSide, [ToolId | null, ToolId | null]>>({
        'outer-left':   [null, null], 'inner-left':   [null, null],
        'outer-right':  [null, null], 'inner-right':  [null, null],
        'outer-top':    [null, null], 'inner-top':    [null, null],
        'outer-bottom': [null, null], 'inner-bottom': [null, null],
    });
    const dockedKey = useMemo(() => JSON.stringify(docked), [docked]);
    useEffect(() => {
        setActiveBySideGroup(prev => {
            const next = { ...prev };
            (Object.keys(docked) as DockSide[]).forEach(side => {
                const [g0, g1] = docked[side];
                const [a0, a1] = prev[side];
                const newA0 = g0.length === 0 ? null : (a0 && g0.includes(a0)) ? a0 : g0[0];
                const newA1 = g1.length === 0 ? null : (a1 && g1.includes(a1)) ? a1 : g1[0];
                next[side] = [newA0, newA1];
            });
            return next;
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dockedKey]);

    // ── Drag state ──
    const [draggingTool, setDraggingTool] = useState<ToolId | null>(null);
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);

    // ── Editor pop-out state ──
    // The editor pane has two states: docked at center (default) or
    // floating as a draggable + resizable in-app window. Main editor
    // stays mounted underneath when floating (hidden via CSS) so the
    // model bookkeeping in App.tsx keeps working.
    type EditorDragMode = 'pop' | 'editor-move' | 'editor-resize';
    interface EditorDrag {
        mode: EditorDragMode;
        startX: number;
        startY: number;
        started: boolean;
    }
    const TAB_DRAG_THRESHOLD = 18;
    const FLOAT_EDITOR_DEFAULT = { width: 720, height: 480 };
    const [editorFloating, setEditorFloating] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [editorDrag, setEditorDrag] = useState<EditorDrag | null>(null);
    const editorDragRef = useRef<EditorDrag | null>(null);
    editorDragRef.current = editorDrag;
    const cursorRef = useRef<{ x: number; y: number } | null>(null);
    cursorRef.current = cursor;

    // The drag has two flavors:
    //  - 'relocate' starts from a docked tab/header. Drop on a guide ->
    //    move to that side. Drop elsewhere -> float at the cursor.
    //  - 'float-move' starts from a floating window header. Drop on a
    //    guide -> dock to that side. Drop elsewhere -> the float just
    //    follows the cursor (we apply a delta to its stored position).
    type DragMode = 'relocate' | 'float-move' | 'float-resize';
    const dragModeRef = useRef<DragMode>('relocate');
    const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const lastCursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const draggingToolRef = useRef<ToolId | null>(null);
    draggingToolRef.current = draggingTool;

    const startToolDrag = useCallback((e: React.PointerEvent, id: ToolId, mode: DragMode = 'relocate') => {
        if ((e.target as HTMLElement).closest('.vs-dock-close')) return;
        if (e.button !== 0) return;
        e.preventDefault();
        dragModeRef.current = mode;
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        lastCursorRef.current = { x: e.clientX, y: e.clientY };
        setDraggingTool(id);
        setCursor({ x: e.clientX, y: e.clientY });
    }, []);

    const startFloatResize = useCallback((e: React.PointerEvent, id: ToolId) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragModeRef.current = 'float-resize';
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        lastCursorRef.current = { x: e.clientX, y: e.clientY };
        setDraggingTool(id);
    }, []);

    const startEditorDrag = useCallback((e: React.PointerEvent, mode: EditorDragMode) => {
        if ((e.target as HTMLElement).closest('.tab-close-btn,.vs-dock-close')) return;
        if (e.button !== 0) return;
        setEditorDrag({ mode, startX: e.clientX, startY: e.clientY, started: false });
    }, []);

    useEffect(() => {
        if (!editorDrag) return;
        const onMove = (e: PointerEvent) => {
            const cur = editorDragRef.current;
            if (!cur) return;
            const dx = e.clientX - cur.startX;
            const dy = e.clientY - cur.startY;
            const moved = Math.hypot(dx, dy) >= TAB_DRAG_THRESHOLD;

            if (cur.mode === 'pop') {
                if (!moved && !cur.started) return;
                if (!cur.started) setEditorDrag({ ...cur, started: true });
                setCursor({ x: e.clientX, y: e.clientY });
                return;
            }
            if (cur.mode === 'editor-move') {
                setEditorFloating(prev => prev && ({ ...prev, x: prev.x + (e.clientX - cur.startX), y: prev.y + (e.clientY - cur.startY) }));
                setEditorDrag({ ...cur, startX: e.clientX, startY: e.clientY, started: true });
                setCursor({ x: e.clientX, y: e.clientY });
                return;
            }
            if (cur.mode === 'editor-resize') {
                setEditorFloating(prev => prev && ({
                    ...prev,
                    width:  Math.max(360, prev.width  + (e.clientX - cur.startX)),
                    height: Math.max(220, prev.height + (e.clientY - cur.startY)),
                }));
                setEditorDrag({ ...cur, startX: e.clientX, startY: e.clientY, started: true });
                return;
            }
        };
        const onUp = (e: PointerEvent) => {
            const cur = editorDragRef.current;
            if (!cur) return;

            if (cur.mode === 'pop' && cur.started) {
                const x = Math.max(40, e.clientX - 120);
                const y = Math.max(40, e.clientY - 20);
                setEditorFloating({ x, y, width: FLOAT_EDITOR_DEFAULT.width, height: FLOAT_EDITOR_DEFAULT.height });
            } else if (cur.mode === 'editor-move' && cur.started) {
                const editorRect = bodyRef.current?.querySelector('.vs-shell-editor')?.getBoundingClientRect();
                if (editorRect && e.clientX >= editorRect.left && e.clientX <= editorRect.right
                    && e.clientY >= editorRect.top && e.clientY <= editorRect.bottom) {
                    setEditorFloating(null);
                }
            }
            setEditorDrag(null);
            setCursor(null);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [editorDrag]);

    const reDockEditor = useCallback(() => setEditorFloating(null), []);

    const visibleTabs = s.tabs;

    useEffect(() => {
        if (!draggingTool) return;

        const onMove = (e: PointerEvent) => {
            const cx = e.clientX;
            const cy = e.clientY;
            const tool = draggingToolRef.current;
            if (!tool) return;

            if (dragModeRef.current === 'float-move') {
                const dx = cx - lastCursorRef.current.x;
                const dy = cy - lastCursorRef.current.y;
                lastCursorRef.current = { x: cx, y: cy };
                if (dx || dy) moveFloatingTool(tool, dx, dy);
                setCursor({ x: cx, y: cy });
                return;
            }

            if (dragModeRef.current === 'float-resize') {
                const placement = layout[tool];
                if (placement.kind === 'float') {
                    const dx = cx - dragStartRef.current.x;
                    const dy = cy - dragStartRef.current.y;
                    resizeFloatingTool(
                        tool,
                        placement.width + dx,
                        placement.height + dy,
                    );
                    dragStartRef.current = { x: cx, y: cy };
                }
                return;
            }

            // relocate: just track cursor for guide hit-testing.
            setCursor({ x: cx, y: cy });
        };

        const onUp = (e: PointerEvent) => {
            const tool = draggingToolRef.current;
            const mode = dragModeRef.current;
            if (!tool) return;
            const rect = bodyRef.current?.getBoundingClientRect();
            const cursorPt = { x: e.clientX, y: e.clientY };
            // A plain click (no movement past the threshold) on a tab
            // should fall through to the tab's onClick handler — switch
            // active tab, NOT pop the tool out as a float.
            const dx = e.clientX - dragStartRef.current.x;
            const dy = e.clientY - dragStartRef.current.y;
            const moved = Math.hypot(dx, dy) >= TAB_DRAG_THRESHOLD;

            if (mode === 'relocate' && rect && moved) {
                const target = hitTestGuides(cursorPt, {
                    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                });
                if (target) {
                    dockTool(tool, target.side);
                    setActiveBySideGroup(prev => {
                        const cur = prev[target.side];
                        return { ...prev, [target.side]: [tool, cur[1]] as [ToolId | null, ToolId | null] };
                    });
                } else {
                    // No guide under the cursor — pop the tool out as a float.
                    const x = Math.max(rect.left + 16, e.clientX - 60);
                    const y = Math.max(rect.top + 16, e.clientY - 12);
                    floatTool(tool, { x, y, width: FLOAT_DEFAULT_W, height: FLOAT_DEFAULT_H });
                }
            } else if (mode === 'float-move' && rect && moved) {
                const target = hitTestGuides(cursorPt, {
                    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                });
                if (target) {
                    dockTool(tool, target.side);
                    setActiveBySideGroup(prev => {
                        const cur = prev[target.side];
                        return { ...prev, [target.side]: [tool, cur[1]] as [ToolId | null, ToolId | null] };
                    });
                }
            }

            setDraggingTool(null);
            setCursor(null);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [draggingTool, dockTool, floatTool, moveFloatingTool, resizeFloatingTool, layout]);

    // ── Render helpers ──
    const renderToolBody = (id: ToolId): ReactNode => {
        // File Explorer is shell-wide: it stays mounted regardless of
        // whether a studio scene or an editor tab is active, so its
        // case lives outside the studio / editor branches.
        if (id === 'file-explorer') {
            return (
                <FileExplorerPane
                    root={s.fileExplorerRoot}
                    onPickFolder={s.onOpenFolder}
                    onPickWad={s.onOpenWadInExplorer}
                    onOpenFile={(p) => s.openFileFromPath(p)}
                    setRoot={s.setFileExplorerRoot}
                    setStatusMessage={s.setStatusMessage}
                />
            );
        }
        // Studio panels render on a studio tab, NOT an editor tab —
        // their early-out path differs from the rest of the panels.
        if (activeTab?.tabType === 'studio') {
            switch (id) {
                case 'studio-anim':    return <StudioAnimPanel studioTabId={activeTab.id} />;
                case 'studio-bg':      return <StudioBackgroundPanel studioTabId={activeTab.id} />;
                case 'studio-actions': return <StudioActionsPanel studioTabId={activeTab.id} />;
                case 'studio-mesh':    return <StudioMeshPanel studioTabId={activeTab.id} />;
                case 'studio-objects': return <StudioObjectsPanel studioTabId={activeTab.id} />;
                case 'studio-spotlight': return <StudioSpotlightPanel studioTabId={activeTab.id} />;
            }
            // Non-studio tools cannot render on a studio tab (they'd
            // have nothing meaningful to do without an editor).
            return null;
        }
        if (!activeTab || !s.isEditorTab(activeTab)) {
            // 'find' doesn't need an editor tab to render its UI, but it
            // does need an editor instance to drive — punt on rendering
            // when there's no active editor tab.
            if (id === 'find' && s.editorRef.current) {
                return <WordFindPane mode={s.replaceWidgetOpen ? 'replace' : 'find'} />;
            }
            return null;
        }
        switch (id) {
            case 'general':
                return (
                    <GeneralEditPanel
                        docked
                        isOpen
                        onClose={() => s.setGeneralEditPanelOpen(false)}
                        editorContent={s.editorRef.current?.getValue() || activeTab.content}
                        onContentChange={s.handleGeneralEditContentChange}
                        filePath={activeTab.filePath ?? undefined}
                        onLibraryInsert={s.recordJadelibInsert}
                    />
                );
            case 'particle':
                return (
                    <ParticleEditorPanel
                        docked
                        isOpen
                        onClose={() => s.setParticlePanelOpen(false)}
                        editorContent={s.editorRef.current?.getValue() || activeTab.content}
                        onContentChange={s.handleGeneralEditContentChange}
                        onScrollToLine={s.handleScrollToLine}
                        onStatusUpdate={s.setStatusMessage}
                    />
                );
            case 'markdown':
                return (
                    <MarkdownEditPanel
                        docked
                        isOpen
                        onClose={() => s.setGeneralEditPanelOpen(false)}
                        wrapSelection={s.mdWrapSelection}
                        prefixLines={s.mdPrefixLines}
                        insertAtCaret={s.mdInsertAtCaret}
                    />
                );
            case 'find':
                return <WordFindPane mode={s.replaceWidgetOpen ? 'replace' : 'find'} />;
            case 'texture':
                return <MaterialOverridePanel entryType="texture" onClose={() => s.setTextureInsertOpen(false)} />;
            case 'material':
                return <MaterialOverridePanel entryType="material" onClose={() => s.setMaterialInsertOpen(false)} />;
            case 'binnav':
                return (
                    <BinNavPanel
                        docked
                        isOpen
                        onClose={() => s.setBinNavOpen(false)}
                        editorContent={s.editorRef.current?.getValue() || activeTab.content}
                        onScrollToLine={s.handleScrollToLine}
                    />
                );
        }
    };

    /** Render a single sub-pane inside a dock group. Uses `fill` so the
     *  enclosing `VSDockGroup` owns the outer resize. */
    const renderDockSubPane = (side: DockSide, group: DockGroup, ids: ToolId[]) => {
        if (ids.length === 0) return null;
        const active = activeBySideGroup[side][group] ?? ids[0];
        const tabs = ids.map(id => ({ id, label: TOOL_LABELS[id] }));
        const otherGroupHasTools = docked[side][group === 0 ? 1 : 0].length > 0;

        return (
            <VSDockPane
                key={`${side}-${group}`}
                side={dockPaneSide(side)}
                defaultSize={DOCK_DEFAULT_SIZE[side]}
                minSize={DOCK_MIN_SIZE[side]}
                storageKey={undefined}
                fill
                tabs={tabs.length > 1 ? tabs : undefined}
                title={tabs.length === 1 ? TOOL_LABELS[ids[0]] : undefined}
                activeTabId={active}
                onTabSelect={id => setActiveBySideGroup(prev => {
                    const cur = prev[side];
                    const next: [ToolId | null, ToolId | null] = group === 0
                        ? [id as ToolId, cur[1]]
                        : [cur[0], id as ToolId];
                    return { ...prev, [side]: next };
                })}
                onTabPointerDown={(e, id) => startToolDrag(e, id as ToolId, 'relocate')}
                onHeaderPointerDown={tabs.length === 1 ? (e => startToolDrag(e, ids[0], 'relocate')) : undefined}
                onClose={() => closeTool(active)}
                // Show the split button when the side has only one group
                // populated AND it has at least 2 tools (you can't split
                // off a single tool — it'd just leave one group empty).
                // Once both groups exist, the button still toggles so a
                // user can rejoin them.
                onSplit={
                    (otherGroupHasTools || ids.length >= 2)
                        ? () => {
                            // Move THIS pane's active tool to the other
                            // group, then keep that tool focused in its
                            // new home — otherwise the rebalance effect
                            // would surface whatever tool already sat in
                            // the destination group, making it look like
                            // the *other* tool was the one that moved.
                            const destGroup: DockGroup = group === 0 ? 1 : 0;
                            splitTool(active);
                            setActiveBySideGroup(prev => {
                                const cur = prev[side];
                                const next: [ToolId | null, ToolId | null] = destGroup === 0
                                    ? [active, cur[1]]
                                    : [cur[0], active];
                                return { ...prev, [side]: next };
                            });
                        }
                        : undefined
                }
                splitState={
                    otherGroupHasTools
                        ? (group === 0 ? 'group0' : 'group1')
                        : 'splittable'
                }
            >
                {renderToolBody(active)}
            </VSDockPane>
        );
    };

    const renderDock = (side: DockSide) => {
        const [g0, g1] = docked[side];
        if (g0.length === 0 && g1.length === 0) return null;

        // If only one group has tools, render a single sub-pane wrapped
        // in VSDockGroup (the wrapper provides the outer resize handle).
        const hasBoth = g0.length > 0 && g1.length > 0;
        const single = !hasBoth ? (g0.length > 0 ? g0 : g1) : null;

        return (
            <VSDockGroup
                key={side}
                side={dockPaneSide(side)}
                defaultSize={DOCK_DEFAULT_SIZE[side]}
                minSize={DOCK_MIN_SIZE[side]}
                storageKey={DOCK_STORAGE_KEY[side]}
                splitStorageKey={DOCK_SPLIT_STORAGE_KEY[side]}
            >
                {single
                    ? renderDockSubPane(side, g0.length > 0 ? 0 : 1, single)
                    : [
                        renderDockSubPane(side, 0, g0),
                        renderDockSubPane(side, 1, g1),
                    ] as [ReactNode, ReactNode]}
            </VSDockGroup>
        );
    };

    const containerRect = bodyRef.current?.getBoundingClientRect() ?? null;

    const welcomeVisible = s.welcomeOverride === 'force'
        || (s.welcomeOverride !== 'hide' && s.tabs.length === 0);

    return (
        <div className={`app-container visualstudio-shell ${s.isDragging ? 'dragging' : ''}`}>
            <VSTitleBar />

            <VSToolbar />

            <div className="vs-shell-body" ref={bodyRef}>
                {renderDock('outer-left')}
                {renderDock('inner-left')}

                <div className="vs-shell-center">
                    {renderDock('outer-top')}
                    {renderDock('inner-top')}

                    {/* Tab strip lives inside the editor column so any
                        top dock pushes tabs + editor down together. In
                        VS the tabs belong to the editor pane, not the
                        workspace top. */}
                    {visibleTabs.length > 0 && (
                        s.splitMode ? (
                            // Split mode: two pane-filtered bars. We
                            // skip the pop-out pointer-down hook here
                            // — TabBar's internal cross-pane drag
                            // already consumes pointerdown, and the
                            // user said "moving the tab just pops it
                            // out" was a bug. Pop-out remains
                            // available in single-pane mode below.
                            <div style={{ display: 'flex', flexDirection: 'row' }}>
                                <div
                                    style={{
                                        flex: `0 0 calc(${s.splitRatio * 100}% - 2px)`,
                                        minWidth: 0,
                                    }}
                                >
                                    <TabBar
                                        tabs={visibleTabs}
                                        activeTabId={s.leftActiveTabId}
                                        onTabSelect={s.onTabSelect}
                                        onTabClose={s.onTabClose}
                                        onTabCloseAll={s.onTabCloseAll}
                                        onTabPin={s.onTabPin}
                                onRevealInExplorer={s.revealInExplorer}
                                        splitMode={s.splitMode}
                                        onToggleSplit={() => s.setSplitMode(!s.splitMode)}
                                        paneFilter="left"
                                        onDropTabIntoPane={s.onTabSetPane}
                                    />
                                </div>
                                <div style={{ flex: '0 0 4px' }} />
                                <div
                                    style={{
                                        flex: `0 0 calc(${(1 - s.splitRatio) * 100}% - 2px)`,
                                        minWidth: 0,
                                    }}
                                >
                                    <TabBar
                                        tabs={visibleTabs}
                                        activeTabId={s.rightActiveTabId}
                                        onTabSelect={s.onTabSelect}
                                        onTabClose={s.onTabClose}
                                        onTabCloseAll={s.onTabCloseAll}
                                        onTabPin={s.onTabPin}
                                onRevealInExplorer={s.revealInExplorer}
                                        paneFilter="right"
                                        onDropTabIntoPane={s.onTabSetPane}
                                    />
                                </div>
                            </div>
                        ) : (
                            <TabBar
                                tabs={visibleTabs}
                                activeTabId={s.activeTabId}
                                onTabSelect={s.onTabSelect}
                                onTabClose={s.onTabClose}
                                onTabCloseAll={s.onTabCloseAll}
                                onTabPin={s.onTabPin}
                                onRevealInExplorer={s.revealInExplorer}
                                onTabPointerDown={e => startEditorDrag(e, 'pop')}
                                splitMode={s.splitMode}
                                onToggleSplit={() => s.setSplitMode(!s.splitMode)}
                                splitDisabled={s.tabs.length < 2}
                            />
                        )
                    )}

                    <div className={`vs-shell-editor${editorFloating ? ' editor-popped-out' : ''}`}>
                        <WelcomeScreenWithExit
                            visible={welcomeVisible && !s.fileLoading}
                            onOpenFile={s.onOpen}
                            onNewFile={s.onNew}
                            onContinueWithoutFile={() => s.setWelcomeOverride('hide')}
                            openFileDisabled={s.openFileDisabled}
                            recentFiles={s.recentFiles}
                            onOpenRecentFile={s.openFileFromPath}
                            onMaterialLibrary={s.onMaterialLibrary}
                            onThemes={s.onThemes}
                            onSettings={s.onSettings}
                            onAbout={s.onAbout}
                            onNewStudioScene={s.onNewStudioScene}
                            onOpenFolder={s.onOpenFolder}
                            onOpenSkinBinAsText={s.onOpenSkinBinAsText}
                            onSendMeshToStudio={s.onSendMeshToStudio}
                            appIcon={s.appIcon}
                            onMinimize={s.onMinimize}
                            onMaximize={s.onMaximize}
                            onClose={s.onClose}
                            isMaximized={s.isMaximized}
                        />
                        {welcomeVisible && s.fileLoading && <div className="file-loading-backdrop" />}
                        <EditorPane />
                    </div>

                    {renderDock('inner-bottom')}
                    {renderDock('outer-bottom')}
                </div>

                {renderDock('inner-right')}
                {renderDock('outer-right')}

                {/* Floating tool windows. They live above the body so they
                    can sit anywhere over the editor / docked panes. */}
                {floating.map(id => {
                    const p = layout[id];
                    if (p.kind !== 'float') return null;
                    return (
                        <FloatingToolWindow
                            key={id}
                            title={TOOL_LABELS[id]}
                            x={p.x}
                            y={p.y}
                            width={p.width}
                            height={p.height}
                            onClose={() => closeTool(id)}
                            onHeaderPointerDown={e => startToolDrag(e, id, 'float-move')}
                            onResizePointerDown={e => startFloatResize(e, id)}
                        >
                            {renderToolBody(id)}
                        </FloatingToolWindow>
                    );
                })}

                <DockGuides
                    container={containerRect}
                    cursor={cursor}
                    visible={!!draggingTool && dragModeRef.current !== 'float-resize'}
                />

                {/* Popped-out editor pane — in-app floating window. */}
                {editorFloating && (
                    <FloatingEditorPane
                        x={editorFloating.x}
                        y={editorFloating.y}
                        width={editorFloating.width}
                        height={editorFloating.height}
                        onHeaderPointerDown={e => startEditorDrag(e, 'editor-move')}
                        onResizePointerDown={e => startEditorDrag(e, 'editor-resize')}
                        onClose={reDockEditor}
                    />
                )}
            </div>

            <StatusBar
                status={s.statusText}
                lineCount={s.lineCount}
                caretLine={s.caretPosition.line}
                caretColumn={s.caretPosition.column}
                ramUsage={s.appMemoryBytes > 0 ? `${(s.appMemoryBytes / (1024 * 1024)).toFixed(0)} MB` : ''}
            />

            <SharedDialogs />
        </div>
    );
}
