import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { RITOBIN_LANGUAGE_ID } from '../lib/ritobinLanguage';
import { getFileName } from '../components/TabBar';
import MarkdownPreview from '../components/MarkdownPreview';
import TexturePreviewTab from '../components/TexturePreviewTab';
import QuartzDiffTab from '../components/QuartzDiffTab';
import StudioTab from '../components/StudioTab';
import { useShell } from './ShellContext';

/**
 * The right-pane content for split-pane mode.
 *
 * Each pane in split mode tracks its own active tab via the shell's
 * `rightActiveTabId` (null means "mirror the left pane"). This
 * component renders whichever tab the right pane is on, mirroring
 * the four tab kinds the main `EditorPane` handles:
 *
 *   - `editor`         → Monaco bound to the tab's shared model
 *   - `texture-preview` → `TexturePreviewTab`
 *   - `markdown-preview` → `MarkdownPreview` (content pulled live
 *      from the source tab's model)
 *   - `quartz-diff`    → `QuartzDiffTab`
 *
 * Monaco model handling notes:
 *
 *   - We attach the SHARED model from `monacoModelsRef`, the same one
 *     the left editor is using when both panes show the same tab.
 *     Edits sync via Monaco's per-model change broadcast.
 *   - We DETACH the model in cleanup (`setModel(null)`). The
 *     `@monaco-editor/react` wrapper otherwise disposes the editor
 *     while it's still holding our shared model, and on some
 *     environments that takes the model with it — leaving the left
 *     pane staring at a disposed model the next time it tries to
 *     access it. The "split → unsplit nukes the editor" symptom
 *     traced back here.
 *   - The view-state (scroll, cursor, folding, selection) is
 *     per-editor instance, so the two panes can show different
 *     regions of the same file independently.
 */
export default function SecondaryPaneView() {
    const s = useShell();
    // Right pane has its own active tab — no fallback to the left
    // pane's tab. When `rightActiveTabId` is null the right pane is
    // empty (the user hasn't dragged any tab onto it yet); we show a
    // drop-target hint there instead of duplicating the left view.
    const rightTabId = s.rightActiveTabId;
    const rightTab = rightTabId ? s.tabs.find(t => t.id === rightTabId) ?? null : null;
    const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);

    // Live markdown content. We can't just use `s.mdPreviewContent`
    // — that's bound to the LEFT pane's active markdown tab. For our
    // own source tab we subscribe to its model and mirror onChange.
    const [mdContent, setMdContent] = useState<string>('');
    useEffect(() => {
        if (rightTab?.tabType !== 'markdown-preview') return;
        const sourceId = rightTab.sourceTabId;
        if (!sourceId) {
            setMdContent('');
            return;
        }
        const model = s.monacoModelsRef.current.get(sourceId);
        if (!model) {
            // Fall back to the source tab's saved snapshot. May be a
            // few keystrokes behind if the source is being edited,
            // but it's a reasonable starting point until the source
            // gets focused and creates its model.
            const sourceTab = s.tabs.find(t => t.id === sourceId);
            setMdContent(sourceTab?.content ?? '');
            return;
        }
        setMdContent(model.getValue());
        const sub = model.onDidChangeContent(() => {
            setMdContent(model.getValue());
        });
        return () => sub.dispose();
    }, [rightTab?.tabType, rightTab?.sourceTabId, rightTab, s.monacoModelsRef, s.tabs]);

    // Cleanup function from `setupRightEditor` — captured in onMount,
    // invoked in the unmount effect below.
    const cleanupFeaturesRef = useRef<(() => void) | null>(null);

    const handleMount: OnMount = (editor, _monaco) => {
        editorRef.current = editor;
        if (rightTabId) {
            const model = s.ensureModelForTab(rightTabId);
            if (model) {
                try {
                    editor.setModel(model);
                } catch {
                    // ignore — the effect below will retry
                }
            }
        }
        // Register the right pane's per-editor features (image-path
        // swatches, material jumps, texture popup). Without this the
        // right pane was a bare Monaco view missing the click-to-
        // preview machinery the left pane has.
        cleanupFeaturesRef.current = s.setupRightEditor(editor);
    };

    // Re-attach when the right pane's active tab changes. Uses
    // `ensureModelForTab` so we recover automatically from disposed
    // models (e.g. after a shell remount where the registry still
    // points at a dead model). Without `ensureModelForTab` the right
    // pane would silently bind to a corpse and render blank.
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        if (!rightTabId) {
            try { editor.setModel(null as any); } catch {}
            return;
        }
        const model = s.ensureModelForTab(rightTabId);
        if (!model) return;
        if (editor.getModel() === model) return;
        try {
            editor.setModel(model);
        } catch {
            // ignore — next render will retry
        }
    }, [rightTabId, s.tabs, s.ensureModelForTab]);

    // Detach the model + dispose per-editor features before the
    // React wrapper disposes the editor. Without the setModel(null)
    // detach, the wrapper's cleanup can take our shared model with
    // it on some versions of `@monaco-editor/react`. Without the
    // features cleanup, image-path / material-jump decorations leak
    // their debounce timers across shell remounts.
    useEffect(() => {
        return () => {
            const cleanup = cleanupFeaturesRef.current;
            if (cleanup) {
                try { cleanup(); } catch {}
                cleanupFeaturesRef.current = null;
            }
            const editor = editorRef.current;
            if (editor) {
                try { editor.setModel(null as any); } catch {}
            }
        };
    }, []);

    const focusRight = () => {
        if (s.focusedPane !== 'right') s.setFocusedPane('right');
    };

    if (!rightTab) {
        return (
            <div
                onMouseDown={focusRight}
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-secondary, #9DA5B4)',
                    fontSize: 12,
                    fontStyle: 'italic',
                    textAlign: 'center',
                    padding: 24,
                }}
            >
                Drag a tab from the left here, or click a tab in the
                right tab bar to open it.
            </div>
        );
    }

    // Preview-type tabs — re-render the same components the main
    // EditorPane uses so feature parity is automatic. Some handlers
    // (texture reload / edit) still go through shell context, so
    // they currently target the LEFT pane's active tab. A future
    // pass can per-tab them; for now this matches the user's main
    // ask ("right pane should render previews too").
    if (rightTab.tabType === 'texture-preview' && rightTab.filePath) {
        return (
            <div onMouseDown={focusRight} style={{ width: '100%', height: '100%' }}>
                <TexturePreviewTab
                    filePath={rightTab.filePath}
                    imageDataUrl={rightTab.textureDataUrl ?? null}
                    texWidth={rightTab.textureWidth ?? 0}
                    texHeight={rightTab.textureHeight ?? 0}
                    format={rightTab.textureFormat ?? 0}
                    error={rightTab.textureError ?? null}
                    isReloading={s.reloadingTexTabId === rightTab.id}
                    onEditImage={() => s.handleTexEditImage(rightTab.filePath)}
                    onShowInExplorer={() => s.handleTexShowInExplorer(rightTab.filePath)}
                    onReload={s.handleTexReload}
                />
            </div>
        );
    }
    if (rightTab.tabType === 'markdown-preview') {
        return (
            <div onMouseDown={focusRight} style={{ width: '100%', height: '100%' }}>
                <MarkdownPreview content={mdContent} />
            </div>
        );
    }
    if (rightTab.tabType === 'studio') {
        return (
            <div onMouseDown={focusRight} style={{ width: '100%', height: '100%' }}>
                <StudioTab tabId={rightTab.id} />
            </div>
        );
    }
    if (rightTab.tabType === 'quartz-diff') {
        return (
            <div onMouseDown={focusRight} style={{ width: '100%', height: '100%' }}>
                <QuartzDiffTab
                    fileName={
                        rightTab.diffSourceFilePath
                            ? getFileName(rightTab.diffSourceFilePath)
                            : rightTab.fileName
                    }
                    mode={rightTab.diffMode ?? 'paint'}
                    status={rightTab.diffStatus ?? 'pending'}
                    originalContent={rightTab.diffOriginalContent ?? ''}
                    modifiedContent={rightTab.diffModifiedContent ?? ''}
                    revisionIndex={s.activeDiffRevisionIndex}
                    revisionCount={Math.max(1, s.activeDiffEntriesLength)}
                    onPrevRevision={() => s.switchQuartzDiffRevision(rightTab.id, 'prev')}
                    onNextRevision={() => s.switchQuartzDiffRevision(rightTab.id, 'next')}
                    onAccept={() => {
                        if (rightTab.diffEntryId) s.handleAcceptQuartzHistory(rightTab.diffEntryId);
                    }}
                    onReject={() => {
                        if (rightTab.diffEntryId) s.handleRejectQuartzHistory(rightTab.diffEntryId);
                    }}
                />
            </div>
        );
    }

    // Default: regular editor tab — full Monaco instance bound to
    // the tab's shared model. We mirror the LEFT pane's option set
    // so both panes get the same look + features (minimap, bracket
    // coloring, sticky scroll, hover providers, find widget, etc.).
    // The `isOn` helper applies `s.perfPrefs` the same way the left
    // pane does; we hard-code isBig=false here because per-pane line
    // count tracking would be more plumbing than the right pane
    // currently needs.
    const isBig = false;
    const isOn = (mode: typeof s.perfPrefs[keyof typeof s.perfPrefs]) =>
        mode === 'on' ? true : mode === 'off' ? false : !isBig;
    return (
        <div
            onMouseDown={focusRight}
            style={{ width: '100%', height: '100%', position: 'relative' }}
        >
            <Editor
                height="100%"
                // The model is SHARED (owned by monacoModelsRef, also used
                // by the left pane). `keepCurrentModel` stops the
                // @monaco-editor/react wrapper from disposing it when this
                // pane unmounts on unsplit — the root cause of the
                // "split → unsplit nukes the editor" bug. The wrapper
                // tracks the model it was handed and disposes it on unmount
                // unless this is set, which is why the manual setModel(null)
                // detach below wasn't enough on its own.
                keepCurrentModel
                defaultLanguage={RITOBIN_LANGUAGE_ID}
                theme={s.editorTheme}
                beforeMount={s.handleBeforeMount}
                onMount={handleMount}
                options={{
                    minimap: { enabled: isOn(s.perfPrefs.minimap) },
                    glyphMargin: true,
                    lineNumbers: 'on',
                    fontSize: 14,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    fontFamily: s.editorFontFamily || undefined,
                    lineNumbersMinChars: 6,
                    fixedOverflowWidgets: true,
                    contextmenu: false,
                    largeFileOptimizations: false,
                    maxTokenizationLineLength: 100_000,
                    folding: isOn(s.perfPrefs.folding),
                    occurrencesHighlight:
                        (isOn(s.perfPrefs.occurrencesHighlight) ? 'singleFile' : 'off') as
                            | 'singleFile'
                            | 'off',
                    selectionHighlight: isOn(s.perfPrefs.selectionHighlight),
                    renderLineHighlight: (isOn(s.perfPrefs.lineHighlight) ? 'all' : 'gutter') as
                        | 'all'
                        | 'gutter',
                    stopRenderingLineAfter: isOn(s.perfPrefs.stopRenderingLine) ? -1 : 10000,
                    renderWhitespace: 'none',
                    overviewRulerLanes: 3,
                    overviewRulerBorder: true,
                    wordWrap: 'off',
                    find: {
                        addExtraSpaceOnTop: false,
                        autoFindInSelection: 'never',
                        seedSearchStringFromSelection: 'always',
                    },
                    bracketPairColorization: { enabled: isOn(s.perfPrefs.bracketColors) },
                    ...({
                        'suggest.maxVisibleSuggestions': 5,
                        'semanticHighlighting.enabled': false,
                        'guides.indentation': true,
                    } as any),
                }}
            />
        </div>
    );
}
