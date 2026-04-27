import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import TitleBar from '../components/TitleBar';
import MenuBar from '../components/MenuBar';
import TabBar from '../components/TabBar';
import StatusBar from '../components/StatusBar';
import WelcomeScreen from '../components/WelcomeScreen';
import GeneralEditPanel from '../components/GeneralEditPanel';
import ParticleEditorPanel from '../components/ParticleEditorPanel';
import MarkdownEditPanel from '../components/MarkdownEditPanel';
import VSToolbar from './VSToolbar';
import VSDockPane from './VSDockPane';
import EditorPane from './EditorPane';
import SharedDialogs from './SharedDialogs';
import WordFindPane from './WordFindPane';
import DockGuides, { hitTestGuides } from './DockGuides';
import FloatingToolWindow from './FloatingToolWindow';
import { useToolLayout, type DockSide, type ToolId } from './useToolLayout';
import { getFileExtension } from '../lib/binOperations';
import { useShell } from './ShellContext';
import './Dock.css';
import './VisualStudioShell.css';

const TOOL_LABELS: Record<ToolId, string> = {
    general: 'General Editing',
    particle: 'Particle Editor',
    markdown: 'Markdown',
    find: 'Find Results',
};

const DOCK_DEFAULT_SIZE: Record<DockSide, number> = {
    left:   320,
    right:  360,
    bottom: 240,
};

const DOCK_MIN_SIZE: Record<DockSide, number> = {
    left:   220,
    right:  240,
    bottom: 120,
};

const DOCK_STORAGE_KEY: Record<DockSide, string> = {
    left:   'vs-dock-left',
    right:  'vs-dock-right',
    bottom: 'vs-dock-bottom',
};

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
    const { layout, dockTool, floatTool, moveFloatingTool, resizeFloatingTool } = useToolLayout();

    const ext = activeTab && s.isEditorTab(activeTab)
        ? getFileExtension(activeTab.filePath ?? activeTab.fileName)
        : null;
    const isMarkdown = ext === 'md' || ext === 'markdown';

    const findOpen = s.findWidgetOpen || s.replaceWidgetOpen;
    const generalOpen = s.generalEditPanelOpen && !!activeTab && s.isEditorTab(activeTab) && !isMarkdown;
    const markdownOpen = s.generalEditPanelOpen && !!activeTab && s.isEditorTab(activeTab) && isMarkdown;
    const particleOpen = s.particlePanelOpen && !!activeTab && s.isEditorTab(activeTab);

    const isOpen: Record<ToolId, boolean> = {
        general:  generalOpen,
        particle: particleOpen,
        markdown: markdownOpen,
        find:     findOpen,
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
        }
    }, [s]);

    // Bucket the open tools by where they are.
    const docked: Record<DockSide, ToolId[]> = { left: [], right: [], bottom: [] };
    const floating: ToolId[] = [];
    (Object.keys(isOpen) as ToolId[]).forEach(id => {
        if (!isOpen[id]) return;
        const p = layout[id];
        if (p.kind === 'dock') docked[p.side].push(id);
        else floating.push(id);
    });

    // Active tab per dock side.
    const [activeBySide, setActiveBySide] = useState<Record<DockSide, ToolId | null>>({
        left: null, right: null, bottom: null,
    });
    const dockedKey = useMemo(() => JSON.stringify(docked), [docked]);
    useEffect(() => {
        setActiveBySide(prev => {
            const next = { ...prev };
            (Object.keys(docked) as DockSide[]).forEach(side => {
                const ids = docked[side];
                if (ids.length === 0) next[side] = null;
                else if (!prev[side] || !ids.includes(prev[side]!)) next[side] = ids[0];
            });
            return next;
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dockedKey]);

    // ── Drag state ──
    const [draggingTool, setDraggingTool] = useState<ToolId | null>(null);
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);

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

            if (mode === 'relocate' && rect) {
                const target = hitTestGuides(cursorPt, {
                    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                });
                if (target) {
                    dockTool(tool, target.side);
                    setActiveBySide(prev => ({ ...prev, [target.side]: tool }));
                } else {
                    // No guide under the cursor — pop the tool out as a float.
                    const x = Math.max(rect.left + 16, e.clientX - 60);
                    const y = Math.max(rect.top + 16, e.clientY - 12);
                    floatTool(tool, { x, y, width: FLOAT_DEFAULT_W, height: FLOAT_DEFAULT_H });
                }
            } else if (mode === 'float-move' && rect) {
                const target = hitTestGuides(cursorPt, {
                    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                });
                if (target) {
                    dockTool(tool, target.side);
                    setActiveBySide(prev => ({ ...prev, [target.side]: tool }));
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
        }
    };

    const renderDock = (side: DockSide) => {
        const ids = docked[side];
        if (ids.length === 0) return null;
        const active = activeBySide[side] ?? ids[0];
        const tabs = ids.map(id => ({ id, label: TOOL_LABELS[id] }));

        return (
            <VSDockPane
                key={side}
                side={side}
                defaultSize={DOCK_DEFAULT_SIZE[side]}
                minSize={DOCK_MIN_SIZE[side]}
                storageKey={DOCK_STORAGE_KEY[side]}
                tabs={tabs.length > 1 ? tabs : undefined}
                title={tabs.length === 1 ? TOOL_LABELS[ids[0]] : undefined}
                activeTabId={active}
                onTabSelect={id => setActiveBySide(prev => ({ ...prev, [side]: id as ToolId }))}
                onTabPointerDown={(e, id) => startToolDrag(e, id as ToolId, 'relocate')}
                onHeaderPointerDown={tabs.length === 1 ? (e => startToolDrag(e, ids[0], 'relocate')) : undefined}
                onClose={() => closeTool(active)}
            >
                {renderToolBody(active)}
            </VSDockPane>
        );
    };

    const containerRect = bodyRef.current?.getBoundingClientRect() ?? null;

    return (
        <div className={`app-container visualstudio-shell ${s.isDragging ? 'dragging' : ''}`}>
            <TitleBar
                appIcon={s.appIcon}
                isMaximized={s.isMaximized}
                onThemes={s.onThemes}
                onPreferences={s.onPreferences}
                onSettings={s.onSettings}
                onAbout={s.onAbout}
                onMinimize={s.onMinimize}
                onMaximize={s.onMaximize}
                onClose={s.onClose}
                onParticleEditor={s.onParticleEditor}
                onMaterialLibrary={s.onMaterialLibrary}
                onQuartzAction={s.onSendToQuartz}
            />

            <MenuBar
                findActive={s.findWidgetOpen}
                replaceActive={s.replaceWidgetOpen}
                generalEditActive={s.generalEditPanelOpen}
                particlePanelActive={s.particlePanelOpen}
                particleDisabled={!s.isBinFileOpen()}
                onNewFile={s.onNew}
                onOpenFile={s.onOpen}
                onSaveFile={s.onSave}
                onSaveFileAs={s.onSaveAs}
                onOpenLog={s.onOpenLog}
                onExit={s.onClose}
                onUndo={s.onUndo}
                onRedo={s.onRedo}
                onCut={s.onCut}
                onCopy={s.onCopy}
                onPaste={s.onPaste}
                onFind={s.onFind}
                onReplace={s.onReplace}
                onCompareFiles={s.onCompareFiles}
                onSelectAll={s.onSelectAll}
                onGeneralEdit={s.onGeneralEdit}
                onParticlePanel={s.onParticlePanel}
                onThemes={s.onThemes}
                onSettings={s.onSettings}
                onAbout={s.onAbout}
                onMaterialLibrary={s.onMaterialLibrary}
                recentFiles={s.recentFiles}
                onOpenRecentFile={s.openFileFromPath}
                openFileDisabled={s.openFileDisabled}
            />

            <VSToolbar />

            {s.tabs.length > 0 && (
                <TabBar
                    tabs={s.tabs}
                    activeTabId={s.activeTabId}
                    onTabSelect={s.onTabSelect}
                    onTabClose={s.onTabClose}
                    onTabCloseAll={s.onTabCloseAll}
                    onTabPin={s.onTabPin}
                />
            )}

            <div className="vs-shell-body" ref={bodyRef}>
                {renderDock('left')}

                <div className="vs-shell-center">
                    <div className="vs-shell-editor">
                        {s.tabs.length === 0 && !s.fileLoading && (
                            <WelcomeScreen
                                onOpenFile={s.onOpen}
                                openFileDisabled={s.openFileDisabled}
                                recentFiles={s.recentFiles}
                                onOpenRecentFile={s.openFileFromPath}
                                onMaterialLibrary={s.onMaterialLibrary}
                                appIcon={s.appIcon}
                            />
                        )}
                        {s.tabs.length === 0 && s.fileLoading && <div className="file-loading-backdrop" />}
                        <EditorPane />
                    </div>

                    {renderDock('bottom')}
                </div>

                {renderDock('right')}

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
