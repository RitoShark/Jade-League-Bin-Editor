import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type * as MonacoType from 'monaco-editor';
import { useShell } from '../shells/ShellContext';
import './QuartzDiffTab.css';

const JADE_RUNTIME_THEME_ID = 'jade-dynamic';

interface CompareTabProps {
  leftTabId: string;
  rightTabId: string;
  leftName: string;
  rightName: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  onSwap: () => void;
}

function getDiffLineLabel(change: MonacoType.editor.ILineChange): string {
  const start = change.modifiedStartLineNumber > 0
    ? change.modifiedStartLineNumber
    : Math.max(change.originalStartLineNumber, 1);
  const end = change.modifiedEndLineNumber > 0
    ? Math.max(start, change.modifiedEndLineNumber)
    : Math.max(start, change.originalEndLineNumber);
  return start === end ? `L${start}` : `L${start}-${end}`;
}

export default function CompareTab({
  leftTabId,
  rightTabId,
  leftName,
  rightName,
  fontFamily,
  fontSize,
  lineHeight,
  onSwap,
}: CompareTabProps) {
  const s = useShell();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const diffEditorRef = useRef<MonacoType.editor.IStandaloneDiffEditor | null>(null);
  const diffUpdateDisposableRef = useRef<MonacoType.IDisposable | null>(null);

  // Latest shell callbacks captured in refs so the model-binding effect can
  // call them without listing them as deps — `ensureModelForTab` gets a new
  // identity on every `tabs` change, which would otherwise thrash the effect
  // (re-running setModel + re-subscribing on every keystroke).
  const ensureModelForTabRef = useRef(s.ensureModelForTab);
  ensureModelForTabRef.current = s.ensureModelForTab;
  const markModifiedRef = useRef(s.markTabModifiedById);
  markModifiedRef.current = s.markTabModifiedById;

  const [lineChanges, setLineChanges] = useState<MonacoType.editor.ILineChange[]>([]);
  const [selectedChangeIndex, setSelectedChangeIndex] = useState(0);

  const refreshDiffChanges = useCallback(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const next = editor.getLineChanges() ?? [];
    setLineChanges(next);
    setSelectedChangeIndex(prev => (next.length === 0 ? 0 : Math.min(prev, next.length - 1)));
  }, []);

  const focusChangeByIndex = useCallback((index: number) => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const changes = editor.getLineChanges() ?? [];
    if (changes.length === 0) return;
    const safe = Math.max(0, Math.min(index, changes.length - 1));
    const target = changes[safe];
    const modLine = target.modifiedStartLineNumber > 0
      ? target.modifiedStartLineNumber
      : target.modifiedEndLineNumber;
    if (modLine > 0) {
      const modEditor = editor.getModifiedEditor();
      modEditor.revealLineInCenter(modLine);
      modEditor.setPosition({ lineNumber: modLine, column: 1 });
      modEditor.focus();
    } else {
      const origLine = Math.max(target.originalStartLineNumber, 1);
      const origEditor = editor.getOriginalEditor();
      origEditor.revealLineInCenter(origLine);
      origEditor.setPosition({ lineNumber: origLine, column: 1 });
      origEditor.focus();
    }
    setSelectedChangeIndex(safe);
  }, []);

  const handlePrev = useCallback(() => {
    if (lineChanges.length === 0) return;
    focusChangeByIndex(selectedChangeIndex <= 0 ? lineChanges.length - 1 : selectedChangeIndex - 1);
  }, [focusChangeByIndex, lineChanges.length, selectedChangeIndex]);

  const handleNext = useCallback(() => {
    if (lineChanges.length === 0) return;
    focusChangeByIndex(selectedChangeIndex >= lineChanges.length - 1 ? 0 : selectedChangeIndex + 1);
  }, [focusChangeByIndex, lineChanges.length, selectedChangeIndex]);

  const handleSelectChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const v = Number.parseInt(e.target.value, 10);
    if (!Number.isNaN(v)) focusChangeByIndex(v);
  }, [focusChangeByIndex]);

  // Monaco is loaded lazily by the main editor (which sets `monacoRef` on
  // mount). By the time two tabs exist to compare it's normally ready, but
  // guard anyway and poll until it is.
  const [monacoReady, setMonacoReady] = useState(() => !!s.monacoRef.current);
  useEffect(() => {
    if (s.monacoRef.current) { setMonacoReady(true); return; }
    let raf = 0;
    const tick = () => {
      if (s.monacoRef.current) setMonacoReady(true);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [s.monacoRef]);

  // Build the diff editor by hand (rather than @monaco-editor/react's
  // <DiffEditor>) so we can point it at the SAME shared models the source
  // tabs use. That makes editing in the diff a real edit to those files,
  // sharing one undo stack with each source tab's normal editor — and the
  // existing save path (which reads straight off these models) just works.
  useEffect(() => {
    const monaco = s.monacoRef.current;
    const container = containerRef.current;
    if (!monaco || !container) return;
    const diffEditor = monaco.editor.createDiffEditor(container, {
      renderSideBySide: true,
      // Both sides editable — these are two live source tabs, each with a
      // real file to write back to (unlike a git/saved-snapshot diff).
      readOnly: false,
      originalEditable: true,
      // Minimap on for parity with the normal editor — gives an at-a-glance
      // overview + fast scrubbing across a long diff. It renders two
      // miniatures on a side-by-side diff, so to keep the cost down on the
      // 10k-line BINs we ship through here we draw color blocks instead of
      // real glyphs (renderCharacters:false) and cap the column width.
      minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      fontSize: fontSize ?? 14,
      lineHeight: lineHeight && lineHeight > 0 ? lineHeight : 0,
      fontFamily: fontFamily || undefined,
      lineNumbersMinChars: 6,
      fixedOverflowWidgets: true,
      enableSplitViewResizing: false,
      renderOverviewRuler: false,
      // Token highlighting cap — keeps long string literals from blowing up
      // tokenization on either inner editor.
      maxTokenizationLineLength: 5000,
      largeFileOptimizations: true,
      theme: JADE_RUNTIME_THEME_ID,
      ...({
        // Legacy diff algorithm is dramatically faster than the 0.55
        // default on big BINs with thousands of near-identical lines, and
        // maxComputationTime caps a pathological case from locking the UI.
        diffAlgorithm: 'legacy',
        maxComputationTime: 5000,
        experimental: { showMoves: false, showEmptyDecorations: false },
      } as any),
    });
    diffEditorRef.current = diffEditor;
    try {
      diffUpdateDisposableRef.current = diffEditor.onDidUpdateDiff(() => refreshDiffChanges());
    } catch {
      diffUpdateDisposableRef.current = null;
    }
    return () => {
      diffUpdateDisposableRef.current?.dispose();
      diffUpdateDisposableRef.current = null;
      // Detach the shared models BEFORE disposing — they're owned by App's
      // monacoModelsRef and still drive the source tabs' editors. Disposing
      // the diff editor must not take them down.
      try { diffEditor.setModel(null); } catch { /* ignore */ }
      try { diffEditor.dispose(); } catch { /* ignore */ }
      diffEditorRef.current = null;
    };
    // Font options are applied live in a separate effect; rebuilding the
    // editor on every font tweak would drop the diff state and scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoReady]);

  // Keep font options live without rebuilding the editor.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({
      fontSize: fontSize ?? 14,
      lineHeight: lineHeight && lineHeight > 0 ? lineHeight : 0,
      fontFamily: fontFamily || undefined,
    });
  }, [fontFamily, fontSize, lineHeight]);

  // Bind the two source models onto the diff editor and track edits. Re-runs
  // when the sides change (Swap) or once Monaco becomes ready. The source
  // models are pinned against LRU eviction in App while a compare tab is
  // open, so the references stay valid for the tab's lifetime.
  useEffect(() => {
    if (!monacoReady) return;
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) return;
    const leftModel = ensureModelForTabRef.current(leftTabId);
    const rightModel = ensureModelForTabRef.current(rightTabId);
    if (!leftModel || leftModel.isDisposed() || !rightModel || rightModel.isDisposed()) return;
    diffEditor.setModel({ original: leftModel, modified: rightModel });

    // These ARE the models the normal editors use, so the main editor's
    // onChange never fires for edits made here — flip the source tab's dirty
    // flag ourselves (mirrors handleEditorChange) and refresh the diff nav.
    const origSub = leftModel.onDidChangeContent(() => {
      markModifiedRef.current(leftTabId);
      refreshDiffChanges();
    });
    const modSub = rightModel.onDidChangeContent(() => {
      markModifiedRef.current(rightTabId);
      refreshDiffChanges();
    });
    refreshDiffChanges();
    return () => {
      origSub.dispose();
      modSub.dispose();
    };
  }, [leftTabId, rightTabId, monacoReady, refreshDiffChanges]);

  const hasChanges = lineChanges.length > 0;
  const changeOptions = useMemo(
    () => lineChanges.map((c, i) => ({ value: i, label: `#${i + 1} ${getDiffLineLabel(c)}` })),
    [lineChanges],
  );

  return (
    <div className="quartz-diff-tab">
      <div className="quartz-diff-tab__header">
        <div className="quartz-diff-tab__meta">
          <span className="quartz-diff-tab__file">{leftName}</span>
          <span className="quartz-diff-tab__separator">⇄</span>
          <span className="quartz-diff-tab__file">{rightName}</span>
        </div>
        <div className="quartz-diff-tab__header-controls">
          <div className="quartz-diff-tab__nav">
            <span className="quartz-diff-tab__change-indicator">
              {hasChanges ? `Change ${selectedChangeIndex + 1}/${lineChanges.length}` : 'No changes'}
            </span>
            <button
              type="button"
              className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
              onClick={handlePrev}
              disabled={!hasChanges}
            >
              Prev
            </button>
            <button
              type="button"
              className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
              onClick={handleNext}
              disabled={!hasChanges}
            >
              Next
            </button>
            <select
              className="quartz-diff-tab__select"
              value={hasChanges ? String(selectedChangeIndex) : ''}
              onChange={handleSelectChange}
              disabled={!hasChanges}
            >
              {!hasChanges && <option value="">No changes</option>}
              {changeOptions.map(opt => (
                <option key={opt.value} value={String(opt.value)}>{opt.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
              onClick={onSwap}
              title="Swap left/right"
            >
              Swap
            </button>
          </div>
        </div>
      </div>
      <div className="quartz-diff-tab__editor">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
