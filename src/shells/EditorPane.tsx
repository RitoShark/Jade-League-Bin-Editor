import Editor from '@monaco-editor/react';
import { RITOBIN_LANGUAGE_ID } from '../lib/ritobinLanguage';
import { getFileExtension } from '../lib/binOperations';
import { getFileName } from '../components/TabBar';
import GeneralEditPanel from '../components/GeneralEditPanel';
import ParticleEditorPanel from '../components/ParticleEditorPanel';
import MarkdownPreview from '../components/MarkdownPreview';
import MarkdownEditPanel from '../components/MarkdownEditPanel';
import TexturePreviewTab from '../components/TexturePreviewTab';
import QuartzDiffTab from '../components/QuartzDiffTab';
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
    const { activeTab, shellVariant } = s;
    const isWord = shellVariant === 'word';
    const isVS = shellVariant === 'visualstudio';
    const stripChrome = isWord; // VS keeps full Monaco chrome — only Word goes "page" mode
    const dockPanels = isWord || isVS;

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
                className="editor-container"
                style={
                    s.tabs.length === 0 || !s.isEditorTab(activeTab)
                        ? { display: 'none' }
                        : undefined
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
                            lineDecorationsWidth: stripChrome ? 0 : undefined,
                            fontSize: stripChrome ? 13 : 14,
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            fontFamily: stripChrome
                                ? "'Aptos', 'Calibri', 'Segoe UI', system-ui, sans-serif"
                                : "'JetBrains Mono', 'Fira Code', Consolas, monospace",
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
                                    vertical: 'auto' as const,
                                    horizontal: 'hidden' as const,
                                    verticalScrollbarSize: 10,
                                    useShadows: false,
                                }
                                : undefined,
                            wordWrap: (stripChrome ? 'on' : 'off') as 'on' | 'off',
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
            </div>
        </>
    );
}
