import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RITOBIN_LANGUAGE_ID } from '../lib/ritobinLanguage';
import { getFileExtension } from '../lib/binOperations';
import { getFileName } from '../components/TabBar';
import GeneralEditPanel from '../components/GeneralEditPanel';
import ParticleEditorPanel from '../components/ParticleEditorPanel';
import BinNavPanel from '../components/BinNavPanel';
import MarkdownPreview from '../components/MarkdownPreview';
import MarkdownEditPanel from '../components/MarkdownEditPanel';
import TexturePreviewTab from '../components/TexturePreviewTab';
import QuartzDiffTab from '../components/QuartzDiffTab';
import CompareTab from '../components/CompareTab';
import StudioTab from '../components/StudioTab';
import AnimStudioTab from '../components/AnimStudioTab';
import SecondaryPaneView from './SecondaryPaneView';
import { useShell, type PerfMode } from './ShellContext';

/**
 * The editor surface — Monaco plus the variant tab types (texture, markdown
 * preview, quartz diff) plus the floating edit panels that anchor against
 * `.editor-container`.
 *
 * Shared between shells. The chrome around it (title bar, tab strip, ribbon
 * vs menu bar, etc.) lives in each shell's component.
 */
export default function EditorPane() {
    const s = useShell();
    const { shellVariant } = s;
    // The LEFT pane always tracks `leftActiveTabId`, never the
    // derived `activeTabId` (which follows focus). Without this,
    // focusing the right pane in split mode would yank the left
    // pane's preview/editor over to the right tab's content too.
    const activeTab = s.leftActiveTabId
        ? s.tabs.find(t => t.id === s.leftActiveTabId) ?? null
        : null;
    const isWord = shellVariant === 'word';
    const isVS = shellVariant === 'visualstudio';
    const stripChrome = isWord; // VS keeps full Monaco chrome — only Word goes "page" mode
    const dockPanels = isWord || isVS;

    // User-tunable editor font size + line height. Loaded from prefs on
    // mount and live-updated via custom events the ribbon's Syntax group
    // dispatches. lineHeight=0 means "use Monaco's default", anything
    // else is a multiplier of the font size.
    const [editorFontSize, setEditorFontSize] = useState(14);
    const [editorLineHeight, setEditorLineHeight] = useState(0);

    // Container ref for the split-pane divider's drag math — we need
    // the container's bounding box to convert the mouse's clientX
    // into a left-pane fraction.
    const splitContainerRef = useRef<HTMLDivElement>(null);
    const startSplitDrag = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const container = splitContainerRef.current;
        if (!container) return;
        // Capture the bounding box once at drag-start — Monaco's
        // automaticLayout may re-flow on resize, but the container's
        // own rect doesn't move during a single drag gesture, and
        // re-reading every move would noticeably hitch on big files.
        const rect = container.getBoundingClientRect();
        const onMove = (ev: MouseEvent) => {
            const x = ev.clientX - rect.left;
            const ratio = x / rect.width;
            // Hand off clamping to setSplitRatio (declared in App).
            // Snapping into [0.1, 0.9] there keeps the call sites
            // honest: any caller that sets ratio gets the same bound.
            s.setSplitRatio(ratio);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        // Lock the cursor + suppress selection during drag so the
        // user gets a consistent resize affordance instead of the
        // browser-default text selection that would otherwise flicker
        // across the editor as they move.
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [s]);
    useEffect(() => {
        let cancelled = false;
        invoke<string>('get_preference', { key: 'EditorFontSize', defaultValue: '14' })
            .then(v => { if (!cancelled) setEditorFontSize(Number(v) || 14); })
            .catch(() => {});
        invoke<string>('get_preference', { key: 'EditorLineHeight', defaultValue: '0' })
            .then(v => { if (!cancelled) setEditorLineHeight(Number(v) || 0); })
            .catch(() => {});
        const onSize = (e: Event) => {
            const n = Number((e as CustomEvent).detail);
            if (Number.isFinite(n)) setEditorFontSize(n);
        };
        const onLh = (e: Event) => {
            const n = Number((e as CustomEvent).detail);
            if (Number.isFinite(n)) setEditorLineHeight(n);
        };
        window.addEventListener('jade-editor-fontsize-changed', onSize);
        window.addEventListener('jade-editor-lineheight-changed', onLh);
        return () => {
            cancelled = true;
            window.removeEventListener('jade-editor-fontsize-changed', onSize);
            window.removeEventListener('jade-editor-lineheight-changed', onLh);
        };
    }, []);



    return (
        <>
            {activeTab?.tabType === 'texture-preview' && activeTab.filePath && (
                <TexturePreviewTab
                    filePath={activeTab.filePath}
                    imageDataUrl={activeTab.textureDataUrl ?? null}
                    texWidth={activeTab.textureWidth ?? 0}
                    texHeight={activeTab.textureHeight ?? 0}
                    format={activeTab.textureFormat ?? 0}
                    error={activeTab.textureError ?? null}
                    isReloading={s.reloadingTexTabId === activeTab.id}
                    onEditImage={() => s.handleTexEditImage(activeTab.filePath)}
                    onShowInExplorer={() => s.handleTexShowInExplorer(activeTab.filePath)}
                    onReload={s.handleTexReload}
                />
            )}
            {activeTab?.tabType === 'markdown-preview' && (
                <MarkdownPreview content={s.mdPreviewContent} />
            )}
            {/* Studio tabs render ALL at once (one per studio tab) and
                hide the inactive ones via display:none. Unmounting on
                tab-switch would dispose the Babylon scene and force
                the user to re-drop their model — keeping them mounted
                preserves the scene, animation player, manually-linked
                textures, etc. for the lifetime of the tab. */}
            {s.tabs.filter(t => t.tabType === 'studio').map(studioTab => (
                <div
                    key={studioTab.id}
                    style={{
                        flex: '1 1 auto',
                        minHeight: 0,
                        position: 'relative',
                        display: activeTab?.id === studioTab.id ? 'block' : 'none',
                    }}
                >
                    <StudioTab tabId={studioTab.id} />
                </div>
            ))}
            {/* Animation Studio tabs follow the same mount-all/hide-
                inactive pattern as Photo Studio — unmounting would
                disposes the dual-engine scene and force a reload of
                both SKNs on every tab switch. */}
            {s.tabs.filter(t => t.tabType === 'animstudio').map(animTab => (
                <div
                    key={animTab.id}
                    style={{
                        flex: '1 1 auto',
                        minHeight: 0,
                        position: 'relative',
                        display: activeTab?.id === animTab.id ? 'block' : 'none',
                    }}
                >
                    <AnimStudioTab tabId={animTab.id} />
                </div>
            ))}
            {/* Compare tabs render all-at-once with `display:none` for
                inactive ones, mirroring the Studio-tab strategy.
                Unmounting on every switch was disposing the DiffEditor's
                TextModels mid-event, which fired the
                "TextModel got disposed before DiffEditorWidget model got
                reset" + "Invoking deltaDecorations recursively" cascade
                visible in the console, and forced Monaco to recompute
                the diff from scratch every time the user revisits the
                tab. Keeping them mounted preserves the diff state and
                kills the spam. */}
            {s.tabs.filter(t => t.tabType === 'compare').map(cmpTab => {
                const leftSrc = s.tabs.find(t => t.id === cmpTab.compareLeftTabId);
                const rightSrc = s.tabs.find(t => t.id === cmpTab.compareRightTabId);
                const lineHeightPx = editorLineHeight > 0
                    ? Math.round(editorFontSize * editorLineHeight)
                    : 0;
                return (
                    <div
                        key={cmpTab.id}
                        style={{
                            flex: '1 1 auto',
                            minHeight: 0,
                            display: activeTab?.id === cmpTab.id ? 'flex' : 'none',
                            flexDirection: 'column',
                        }}
                    >
                        <CompareTab
                            leftName={leftSrc?.fileName ?? '(missing)'}
                            rightName={rightSrc?.fileName ?? '(missing)'}
                            leftContent={leftSrc?.content ?? ''}
                            rightContent={rightSrc?.content ?? ''}
                            fontFamily={s.editorFontFamily || undefined}
                            fontSize={editorFontSize}
                            lineHeight={lineHeightPx}
                            onSwap={() => s.swapCompareTabSides(cmpTab.id)}
                        />
                    </div>
                );
            })}
            {activeTab?.tabType === 'quartz-diff' && (
                <QuartzDiffTab
                    fileName={activeTab.diffSourceFilePath ? getFileName(activeTab.diffSourceFilePath) : activeTab.fileName}
                    mode={activeTab.diffMode ?? 'paint'}
                    status={activeTab.diffStatus ?? 'pending'}
                    originalContent={activeTab.diffOriginalContent ?? ''}
                    modifiedContent={activeTab.diffModifiedContent ?? ''}
                    revisionIndex={s.activeDiffRevisionIndex}
                    revisionCount={Math.max(1, s.activeDiffEntriesLength)}
                    onPrevRevision={() => s.switchQuartzDiffRevision(activeTab.id, 'prev')}
                    onNextRevision={() => s.switchQuartzDiffRevision(activeTab.id, 'next')}
                    onAccept={() => {
                        if (activeTab.diffEntryId) {
                            s.handleAcceptQuartzHistory(activeTab.diffEntryId);
                        }
                    }}
                    onReject={() => {
                        if (activeTab.diffEntryId) {
                            s.handleRejectQuartzHistory(activeTab.diffEntryId);
                        }
                    }}
                />
            )}

            <div
                ref={splitContainerRef}
                className={`editor-container${s.splitMode ? ' split-mode' : ''}`}
                style={
                    s.tabs.length === 0 || !s.isEditorTab(activeTab)
                        ? { display: 'none' }
                        : s.splitMode
                            ? { display: 'flex', flexDirection: 'row' }
                            : undefined
                }
            >
                {/* Left pane wrapper — wraps the existing Editor so
                    we can size it via flex-basis in split mode. In
                    single-pane mode the wrapper has no flex and the
                    Editor fills the whole container exactly like
                    before, so non-split behavior is byte-for-byte
                    identical. */}
                <div
                    onMouseDown={() => {
                        // Clicking inside the left pane focuses it.
                        // Routing in the tab bar uses `focusedPane`
                        // to decide which pane's active tab to
                        // update when the user clicks a tab.
                        if (s.splitMode && s.focusedPane !== 'left') {
                            s.setFocusedPane('left');
                        }
                    }}
                    style={
                        s.splitMode
                            ? {
                                  // `min-width: 0` lets the flex item
                                  // shrink below its content's intrinsic
                                  // size — without it Monaco's giant
                                  // intrinsic min-width would force the
                                  // pane to stay near 100% and refuse
                                  // to shrink.
                                  flex: `0 0 calc(${s.splitRatio * 100}% - 2px)`,
                                  minWidth: 0,
                                  height: '100%',
                                  position: 'relative',
                                  // Visible focus ring so the user
                                  // knows where the next tab click
                                  // will land.
                                  outline:
                                      s.focusedPane === 'left'
                                          ? '1px solid color-mix(in srgb, var(--accent-color, #2196f3) 60%, transparent)'
                                          : '1px solid transparent',
                                  outlineOffset: -1,
                              }
                            : { width: '100%', height: '100%', position: 'relative' }
                    }
                >
                <Editor
                    height="100%"
                    defaultLanguage={RITOBIN_LANGUAGE_ID}
                    theme={s.editorTheme}
                    beforeMount={s.handleBeforeMount}
                    onMount={s.handleEditorMount}
                    onChange={s.handleEditorChange}
                    options={(() => {
                        const isBig = s.lineCount > s.bigFileLines;
                        const isOn = (mode: PerfMode) => mode === 'on' ? true : mode === 'off' ? false : !isBig;
                        // Word shell mimics MS Word's clean page surface — no
                        // minimap, no line numbers, no gutter, no overview ruler.
                        // The editor still keeps full bin syntax + features, but
                        // the chrome is stripped to feel like a document, not an IDE.
                        return {
                            minimap: { enabled: stripChrome ? false : isOn(s.perfPrefs.minimap) },
                            glyphMargin: !stripChrome,
                            lineNumbers: (stripChrome ? 'off' : 'on') as 'off' | 'on',
                            fontSize: editorFontSize,
                            // 0 == Monaco default. Non-zero is a multiplier
                            // of fontSize, converted to pixels for Monaco.
                            lineHeight: editorLineHeight > 0
                                ? Math.round(editorFontSize * editorLineHeight)
                                : 0,
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            // Word shell defaults to a sans-serif "document"
                            // stack but yields to a user-selected font when
                            // one is set, so swapping fonts from the ribbon
                            // gallery actually changes Monaco's typeface.
                            // Other shells just honor the user override (or
                            // leave undefined to keep Monaco's own default).
                            fontFamily: stripChrome
                                ? (s.editorFontFamily || "'Aptos', 'Calibri', 'Segoe UI', system-ui, sans-serif")
                                : (s.editorFontFamily || undefined),
                            lineNumbersMinChars: stripChrome ? 0 : 6,
                            fixedOverflowWidgets: true,
                            contextmenu: false,
                            largeFileOptimizations: false,
                            maxTokenizationLineLength: 100_000,
                            folding: stripChrome ? false : isOn(s.perfPrefs.folding),
                            occurrencesHighlight: (!stripChrome && isOn(s.perfPrefs.occurrencesHighlight) ? 'singleFile' : 'off') as 'singleFile' | 'off',
                            selectionHighlight: !stripChrome && isOn(s.perfPrefs.selectionHighlight),
                            renderLineHighlight: (stripChrome
                                ? 'none'
                                : (isOn(s.perfPrefs.lineHighlight) ? 'all' : 'gutter')) as 'all' | 'gutter' | 'none',
                            stopRenderingLineAfter: isOn(s.perfPrefs.stopRenderingLine) ? -1 : 10000,
                            renderWhitespace: 'none' as const,
                            overviewRulerLanes: stripChrome ? 0 : 3,
                            overviewRulerBorder: !stripChrome,
                            hideCursorInOverviewRuler: stripChrome,
                            scrollbar: stripChrome
                                ? {
                                    // Word mode: the page rectangle is now
                                    // decorative (full height of the desk,
                                    // not scrollable on its own). Text
                                    // scrolls inside Monaco like a normal
                                    // code editor.
                                    vertical: 'auto' as const,
                                    horizontal: 'hidden' as const,
                                    useShadows: false,
                                }
                                : undefined,
                            // Word shell: inner top/bottom padding so the first
                            // and last lines don't hug the page edge. Combined
                            // with the desk margin in .editor-container this
                            // gives the standard Word ~1in page-margin feel.
                            padding: stripChrome ? { top: 56, bottom: 112 } : undefined,
                            // Pad the left side of every line so text starts
                            // ~1in from the page edge — Monaco has no native
                            // horizontal padding option, so we abuse the line
                            // decorations gutter instead.
                            lineDecorationsWidth: stripChrome ? 64 : undefined,
                            // Wrap earlier in Word mode so text leaves a
                            // right margin that visually mirrors the 64px
                            // left page margin (lineDecorationsWidth above).
                            // 'bounded' keeps the viewport edge as a hard
                            // backstop on narrow windows.
                            wordWrap: (stripChrome ? 'on' : 'off') as 'on' | 'off',
                            wordWrapColumn: stripChrome ? 64 : undefined,
                            find: {
                                addExtraSpaceOnTop: false,
                                autoFindInSelection: 'never' as const,
                                seedSearchStringFromSelection: 'always' as const,
                            },
                            ...({
                                "bracketPairColorization.enabled": !stripChrome && isOn(s.perfPrefs.bracketColors),
                                "suggest.maxVisibleSuggestions": 5,
                                "semanticHighlighting.enabled": false,
                                "guides.indentation": !stripChrome,
                            } as any),
                        };
                    })()}
                />
                </div>
                {s.splitMode && (
                    <>
                        {/* Divider — mouse-down starts a drag that
                            updates `splitRatio`. The 4px column is
                            wide enough to hit reliably without
                            stealing real estate from either pane. */}
                        <div
                            onMouseDown={startSplitDrag}
                            title="Drag to resize split"
                            style={{
                                flex: '0 0 4px',
                                cursor: 'col-resize',
                                background:
                                    'color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                                position: 'relative',
                                zIndex: 2,
                            }}
                        />
                        <div
                            style={{
                                flex: `0 0 calc(${(1 - s.splitRatio) * 100}% - 2px)`,
                                minWidth: 0,
                                height: '100%',
                                position: 'relative',
                                outline:
                                    s.focusedPane === 'right'
                                        ? '1px solid color-mix(in srgb, var(--accent-color, #2196f3) 60%, transparent)'
                                        : '1px solid transparent',
                                outlineOffset: -1,
                            }}
                        >
                            <SecondaryPaneView />
                        </div>
                    </>
                )}
                {/* Floating edit panels are VSCode-shell only. The Word
                    and Visual Studio shells dock these in their own
                    side/right/bottom panes. */}
                {!dockPanels && activeTab && s.isEditorTab(activeTab) && (() => {
                    const tabName = activeTab.filePath ?? activeTab.fileName;
                    const ext = getFileExtension(tabName);
                    const isMarkdown = ext === 'md' || ext === 'markdown';
                    if (isMarkdown) {
                        return (
                            <MarkdownEditPanel
                                isOpen={s.generalEditPanelOpen}
                                onClose={() => s.setGeneralEditPanelOpen(false)}
                                wrapSelection={s.mdWrapSelection}
                                prefixLines={s.mdPrefixLines}
                                insertAtCaret={s.mdInsertAtCaret}
                            />
                        );
                    }
                    return (
                        <GeneralEditPanel
                            isOpen={s.generalEditPanelOpen}
                            onClose={() => s.setGeneralEditPanelOpen(false)}
                            editorContent={s.editorRef.current?.getValue() || activeTab.content}
                            onContentChange={s.handleGeneralEditContentChange}
                            filePath={activeTab.filePath ?? undefined}
                            onLibraryInsert={s.recordJadelibInsert}
                        />
                    );
                })()}
                {!dockPanels && activeTab && s.isEditorTab(activeTab) && (
                    <ParticleEditorPanel
                        isOpen={s.particlePanelOpen}
                        onClose={() => s.setParticlePanelOpen(false)}
                        editorContent={s.editorRef.current?.getValue() || activeTab.content}
                        onContentChange={s.handleGeneralEditContentChange}
                        onScrollToLine={s.handleScrollToLine}
                        onStatusUpdate={s.setStatusMessage}
                    />
                )}
                {!dockPanels && activeTab && s.isEditorTab(activeTab) && (
                    <BinNavPanel
                        isOpen={s.binNavOpen}
                        onClose={() => s.setBinNavOpen(false)}
                        editorContent={s.editorRef.current?.getValue() || activeTab.content}
                        onScrollToLine={s.handleScrollToLine}
                    />
                )}
            </div>
        </>
    );
}
