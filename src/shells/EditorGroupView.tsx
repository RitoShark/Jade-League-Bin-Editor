import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { RITOBIN_LANGUAGE_ID } from '../lib/ritobinLanguage';
import TabBar, { getFileName } from '../components/TabBar';
import MarkdownPreview from '../components/MarkdownPreview';
import TexturePreviewTab from '../components/TexturePreviewTab';
import QuartzDiffTab from '../components/QuartzDiffTab';
import CompareTab from '../components/CompareTab';
import { Camera, Clapperboard } from 'lucide-react';
import { useShell } from './ShellContext';
import { groupCount, type EditorGroup } from './editorLayout';

// Lazy so React Flow only loads when a node-graph tab is actually opened.
const NodeGraphTab = lazy(() => import('../components/NodeGraphTab'));

/**
 * Renders ONE editor group: its own tab strip + the content of its
 * active tab (any tab type) + its own Monaco instance for editor tabs.
 *
 * Generalizes the old two-pane `EditorPane`/`SecondaryPaneView` split so
 * any number of groups can coexist. Each group attaches the SHARED model
 * from `monacoModelsRef` (so the same file open in two groups stays in
 * sync) and uses `keepCurrentModel` so unmounting a group never disposes
 * a model another group might still need.
 *
 * The *focused* group's editor becomes the app's primary editor
 * (`editorRef`) via `setPrimaryEditor`, so find / edit panels / syntax
 * markers target whichever group the user last touched.
 */
export default function EditorGroupView({ group }: { group: EditorGroup }) {
  const s = useShell();
  const isFocused = s.focusedGroupId === group.id;
  const activeTabId = group.activeTabId;
  const activeTab = activeTabId ? s.tabs.find(t => t.id === activeTabId) ?? null : null;
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const groupTabs = group.tabIds
    .map(id => s.tabs.find(t => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t);

  const focusGroup = () => {
    if (s.focusedGroupId !== group.id) s.onFocusGroup(group.id);
  };

  // Promote this group's editor to "primary" whenever it's the focused
  // group (and on mount if already focused).
  useEffect(() => {
    if (isFocused && editorRef.current) {
      s.setPrimaryEditor(editorRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, activeTabId]);

  // ── live markdown content for markdown-preview tabs ──
  const [mdContent, setMdContent] = useState<string>('');
  useEffect(() => {
    if (activeTab?.tabType !== 'markdown-preview') return;
    const sourceId = activeTab.sourceTabId;
    if (!sourceId) { setMdContent(''); return; }
    const model = s.monacoModelsRef.current.get(sourceId);
    if (!model) {
      const sourceTab = s.tabs.find(t => t.id === sourceId);
      setMdContent(sourceTab?.content ?? '');
      return;
    }
    setMdContent(model.getValue());
    const sub = model.onDidChangeContent(() => setMdContent(model.getValue()));
    return () => sub.dispose();
  }, [activeTab?.tabType, activeTab?.sourceTabId, activeTab, s.monacoModelsRef, s.tabs]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    if (activeTabId) {
      const model = s.ensureModelForTab(activeTabId);
      if (model) { try { editor.setModel(model); } catch { /* effect retries */ } }
    }
    cleanupRef.current = s.setupRightEditor(editor);
    if (isFocused) s.setPrimaryEditor(editor);
  };

  // Re-attach the model when this group's active tab changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!activeTabId) { try { editor.setModel(null as never); } catch { /* noop */ } return; }
    const model = s.ensureModelForTab(activeTabId);
    if (!model || editor.getModel() === model) return;
    try { editor.setModel(model); } catch { /* next render retries */ }
  }, [activeTabId, s.tabs, s.ensureModelForTab]);

  // Detach + clean up before the wrapper disposes this editor.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      const editor = editorRef.current;
      if (editor) { try { editor.setModel(null as never); } catch { /* noop */ } }
    };
  }, []);

  const isBig = false;
  const isOn = (mode: typeof s.perfPrefs[keyof typeof s.perfPrefs]) =>
    mode === 'on' ? true : mode === 'off' ? false : !isBig;

  // Per-group tab strip.
  const tabBar = (
    <TabBar
      tabs={groupTabs}
      activeTabId={group.activeTabId}
      onTabSelect={(tabId) => s.onGroupSelectTab(group.id, tabId)}
      onTabClose={(tabId) => s.onGroupCloseTab(group.id, tabId)}
      onTabCloseAll={() => s.onGroupCloseAll(group.id)}
      onTabPin={s.onTabPin}
      onReorderTab={(from, to) => s.onGroupReorderTab(group.id, from, to)}
      onRevealInExplorer={s.revealInExplorer}
      onOpenNodeGraph={s.openNodeGraph}
      groupId={group.id}
      onToggleSplit={() => s.onSplitEditor('right', group.id)}
      onSplitDown={() => s.onSplitEditor('bottom', group.id)}
      onUnsplit={groupCount(s.layout) > 1 ? s.onUnsplitAll : undefined}
      splitDisabled={group.tabIds.length < 2}
    />
  );

  const renderContent = () => {
    if (!activeTab) {
      // Don't flash the "open a file" placeholder while a file is loading
      // or the group already has tabs (its active id just hasn't resolved
      // yet) — otherwise it briefly stretches in and reads as a split.
      if (s.fileLoading || group.tabIds.length > 0) return null;
      return (
        <div
          className="editor-group-empty"
          style={{
            width: '100%', height: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary, #9DA5B4)', fontSize: 12,
            fontStyle: 'italic', textAlign: 'center', padding: 24,
          }}
        >
          Open a file, or drag a tab here.
        </div>
      );
    }
    if (activeTab.tabType === 'texture-preview' && activeTab.filePath) {
      return (
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
      );
    }
    if (activeTab.tabType === 'markdown-preview') {
      return <MarkdownPreview content={mdContent} />;
    }
    // Compare + node-graph are mounted all-at-once above — skip here.
    if (activeTab.tabType === 'compare') return null;
    if (activeTab.tabType === 'nodegraph') return null;
    // A studio can't render inside a split pane (it's a full-app view).
    // If a group is resting on one (e.g. it's the only tab here), show a
    // click-to-focus hint instead of a blank pane.
    if (activeTab.tabType === 'studio' || activeTab.tabType === 'animstudio') {
      const isAnim = activeTab.tabType === 'animstudio';
      return (
        <div
          onClick={() => s.onGroupSelectTab(group.id, activeTab.id)}
          title="Open this studio full-screen"
          style={{
            width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer',
            color: 'var(--text-secondary, #9DA5B4)', userSelect: 'none',
          }}
        >
          {isAnim ? <Clapperboard size={42} strokeWidth={1.5} /> : <Camera size={42} strokeWidth={1.5} />}
          <div style={{ fontSize: 13 }}>
            Click here to focus {isAnim ? 'Animation Studio' : 'Photo Studio'}
          </div>
        </div>
      );
    }
    if (activeTab.tabType === 'quartz-diff') {
      return (
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
          onAccept={() => { if (activeTab.diffEntryId) s.handleAcceptQuartzHistory(activeTab.diffEntryId); }}
          onReject={() => { if (activeTab.diffEntryId) s.handleRejectQuartzHistory(activeTab.diffEntryId); }}
        />
      );
    }
    // Default: a real editor tab → Monaco bound to the shared model.
    return (
      <Editor
        height="100%"
        keepCurrentModel
        defaultLanguage={RITOBIN_LANGUAGE_ID}
        theme={s.editorTheme}
        beforeMount={s.handleBeforeMount}
        onMount={handleMount}
        onChange={isFocused ? s.handleEditorChange : undefined}
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
          renderWhitespace: 'none',
          find: {
            addExtraSpaceOnTop: false,
            autoFindInSelection: 'never',
            seedSearchStringFromSelection: 'always',
          },
          bracketPairColorization: { enabled: isOn(s.perfPrefs.bracketColors) },
          ...({
            'semanticHighlighting.enabled': false,
            'guides.indentation': true,
          } as Record<string, unknown>),
        }}
      />
    );
  };

  return (
    <div
      className={`editor-group${isFocused ? ' focused' : ''}`}
      onMouseDown={focusGroup}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {tabBar}
      {/* `editor-pane-surface` gives each pane the SAME background as the
          main editor — opaque `--editor-bg` normally, transparent (so the
          app background/gradient shows through) under the
          `[data-custom-background]` / `[data-theme-gradient]` rules. It
          deliberately avoids `.editor-container`'s `z-index`/overflow so
          nested panes don't get stacking anomalies. */}
      <div data-group-content={group.id} className="editor-pane-surface" style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
        {/* Compare tabs mount all-at-once (unmounting disposes the
            DiffEditor mid-event). Studio / Anim Studio are NOT here —
            they take over the whole editor area via StudioFullView, since
            they're full-app views that can't live inside a split. */}
        {groupTabs.filter(t => t.tabType === 'compare').map(t => {
          const leftSrc = s.tabs.find(x => x.id === t.compareLeftTabId);
          const rightSrc = s.tabs.find(x => x.id === t.compareRightTabId);
          return (
            <div key={t.id} style={{ position: 'absolute', inset: 0, display: activeTabId === t.id ? 'flex' : 'none', flexDirection: 'column' }}>
              <CompareTab
                leftTabId={t.compareLeftTabId ?? ''}
                rightTabId={t.compareRightTabId ?? ''}
                leftName={leftSrc?.fileName ?? '(missing)'}
                rightName={rightSrc?.fileName ?? '(missing)'}
                fontFamily={s.editorFontFamily || undefined}
                onSwap={() => s.swapCompareTabSides(t.id)}
              />
            </div>
          );
        })}
        {/* Node-graph tabs mount all-at-once too — unmounting disposes the
            React Flow instance and loses the user's pan/zoom + node layout. */}
        {groupTabs.filter(t => t.tabType === 'nodegraph').map(t => (
          <div key={t.id} style={{ position: 'absolute', inset: 0, display: activeTabId === t.id ? 'block' : 'none' }}>
            <Suspense fallback={<div style={{ padding: 24, opacity: 0.6 }}>Loading node editor…</div>}>
              <NodeGraphTab tabId={t.id} />
            </Suspense>
          </div>
        ))}
        {renderContent()}
      </div>
    </div>
  );
}
