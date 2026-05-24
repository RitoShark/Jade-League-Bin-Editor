import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { RITOBIN_LANGUAGE_ID } from '../lib/ritobinLanguage';
import './QuartzDiffTab.css';

const JADE_RUNTIME_THEME_ID = 'jade-dynamic';

interface CompareTabProps {
  leftName: string;
  rightName: string;
  leftContent: string;
  rightContent: string;
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
  leftName,
  rightName,
  leftContent,
  rightContent,
  fontFamily,
  fontSize,
  lineHeight,
  onSwap,
}: CompareTabProps) {
  const diffEditorRef = useRef<MonacoType.editor.IStandaloneDiffEditor | null>(null);
  const diffUpdateDisposableRef = useRef<MonacoType.IDisposable | null>(null);

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

  const handleMount = useCallback((editor: MonacoType.editor.IStandaloneDiffEditor) => {
    diffEditorRef.current = editor;
    diffUpdateDisposableRef.current?.dispose();
    try {
      diffUpdateDisposableRef.current = editor.onDidUpdateDiff(() => refreshDiffChanges());
    } catch {
      diffUpdateDisposableRef.current = null;
    }
    refreshDiffChanges();
  }, [refreshDiffChanges]);

  useEffect(() => {
    const t = window.setTimeout(() => refreshDiffChanges(), 0);
    return () => window.clearTimeout(t);
  }, [leftContent, rightContent, refreshDiffChanges]);

  useEffect(() => {
    return () => {
      diffUpdateDisposableRef.current?.dispose();
      diffUpdateDisposableRef.current = null;
      diffEditorRef.current = null;
    };
  }, []);

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
        <DiffEditor
          height="100%"
          language={RITOBIN_LANGUAGE_ID}
          theme={JADE_RUNTIME_THEME_ID}
          original={leftContent}
          modified={rightContent}
          options={{
            renderSideBySide: true,
            readOnly: true,
            originalEditable: false,
            // The minimap on a side-by-side diff renders TWO syntax-
            // highlighted miniature copies of the file and was a
            // dominant cost on the 10k-line BIN files we ship through
            // this — keep it off.
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontSize: fontSize ?? 14,
            lineHeight: lineHeight && lineHeight > 0 ? lineHeight : 0,
            fontFamily: fontFamily || undefined,
            lineNumbersMinChars: 6,
            fixedOverflowWidgets: true,
            // Monaco 0.55 defaults to the "advanced" diff algorithm
            // which uses Myers + heuristics and is dramatically
            // slower than the legacy algorithm on big files. For
            // BIN-style content with thousands of nearly-identical
            // lines the legacy algorithm is usually fast enough that
            // the diff appears instantly.
            diffAlgorithm: 'legacy',
            // Safety net: cap compute time so a pathological case
            // can't lock the editor for minutes.
            maxComputationTime: 5000,
            // Trim some "nice to have" diff features that add
            // per-line work for no benefit on BINs.
            experimental: { showMoves: false, showEmptyDecorations: false },
            enableSplitViewResizing: false,
            renderOverviewRuler: false,
            // Token highlighting cap — keeps long string literals
            // from blowing up tokenization on either inner editor.
            maxTokenizationLineLength: 5000,
            largeFileOptimizations: true,
            find: {
              addExtraSpaceOnTop: false,
              autoFindInSelection: 'never',
              seedSearchStringFromSelection: 'always',
            },
            ...({
              "bracketPairColorization.enabled": true,
              "suggest.maxVisibleSuggestions": 5,
            } as any),
          }}
          onMount={handleMount}
        />
      </div>
    </div>
  );
}
