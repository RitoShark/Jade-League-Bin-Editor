import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { RITOBIN_LANGUAGE_ID } from '../lib/ritobinLanguage';
import './QuartzDiffTab.css';

const JADE_RUNTIME_THEME_ID = 'jade-dynamic';

export type QuartzDiffStatus = 'pending' | 'accepted' | 'rejected';

interface QuartzDiffTabProps {
  fileName: string;
  mode: 'paint' | 'port' | 'bineditor' | 'vfxhub';
  status: QuartzDiffStatus;
  originalContent: string;
  modifiedContent: string;
  revisionIndex?: number;
  revisionCount?: number;
  onPrevRevision?: () => void;
  onNextRevision?: () => void;
  onAccept: () => void;
  onReject: () => void;
}

function getModeLabel(mode: 'paint' | 'port' | 'bineditor' | 'vfxhub'): string {
  if (mode === 'port') return 'Port';
  if (mode === 'bineditor') return 'BinEditor';
  if (mode === 'vfxhub') return 'VFXHub';
  return 'Paint';
}

function getStatusLabel(status: QuartzDiffStatus): string {
  if (status === 'accepted') return 'Accepted';
  if (status === 'rejected') return 'Rejected';
  return 'Pending';
}

function getPreferredDiffLine(change: MonacoType.editor.ILineChange): number {
  if (change.modifiedStartLineNumber > 0) return change.modifiedStartLineNumber;
  if (change.modifiedEndLineNumber > 0) return change.modifiedEndLineNumber;
  if (change.originalStartLineNumber > 0) return change.originalStartLineNumber;
  if (change.originalEndLineNumber > 0) return change.originalEndLineNumber;
  return 1;
}

function getDiffLineLabel(change: MonacoType.editor.ILineChange): string {
  const startLine = getPreferredDiffLine(change);
  const endLine = change.modifiedEndLineNumber > 0
    ? Math.max(startLine, change.modifiedEndLineNumber)
    : Math.max(startLine, change.originalEndLineNumber);

  return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

function findNearestChangeIndex(changes: MonacoType.editor.ILineChange[], lineNumber: number): number {
  if (changes.length === 0) return 0;

  let bestIndex = 0;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    const start = getPreferredDiffLine(change);
    const end = change.modifiedEndLineNumber > 0
      ? Math.max(start, change.modifiedEndLineNumber)
      : Math.max(start, change.originalEndLineNumber);

    if (lineNumber >= start && lineNumber <= end) {
      return index;
    }

    const distance = lineNumber < start ? start - lineNumber : lineNumber - end;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

export default function QuartzDiffTab({
  fileName,
  mode,
  status,
  originalContent,
  modifiedContent,
  revisionIndex = 0,
  revisionCount = 1,
  onPrevRevision,
  onNextRevision,
  onAccept,
  onReject,
}: QuartzDiffTabProps) {
  const diffEditorRef = useRef<MonacoType.editor.IStandaloneDiffEditor | null>(null);
  const diffUpdateDisposableRef = useRef<MonacoType.IDisposable | null>(null);

  const [lineChanges, setLineChanges] = useState<MonacoType.editor.ILineChange[]>([]);
  const [selectedChangeIndex, setSelectedChangeIndex] = useState(0);
  const [jumpLineValue, setJumpLineValue] = useState('');

  const refreshDiffChanges = useCallback(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;

    const nextChanges = editor.getLineChanges() ?? [];
    setLineChanges(nextChanges);
    setSelectedChangeIndex((prevIndex) => {
      if (nextChanges.length === 0) return 0;
      return Math.min(prevIndex, nextChanges.length - 1);
    });
  }, []);

  const focusChangeByIndex = useCallback((index: number) => {
    const editor = diffEditorRef.current;
    if (!editor) return;

    const changes = editor.getLineChanges() ?? [];
    if (changes.length === 0) return;

    const safeIndex = Math.max(0, Math.min(index, changes.length - 1));
    const target = changes[safeIndex];
    const modifiedLine = target.modifiedStartLineNumber > 0
      ? target.modifiedStartLineNumber
      : target.modifiedEndLineNumber;

    if (modifiedLine > 0) {
      const modifiedEditor = editor.getModifiedEditor();
      modifiedEditor.revealLineInCenter(modifiedLine);
      modifiedEditor.setPosition({ lineNumber: modifiedLine, column: 1 });
      modifiedEditor.focus();
    } else {
      const originalLine = Math.max(target.originalStartLineNumber, 1);
      const originalEditor = editor.getOriginalEditor();
      originalEditor.revealLineInCenter(originalLine);
      originalEditor.setPosition({ lineNumber: originalLine, column: 1 });
      originalEditor.focus();
    }

    setSelectedChangeIndex(safeIndex);
  }, []);

  const handlePreviousChange = useCallback(() => {
    if (lineChanges.length === 0) return;

    const previousIndex = selectedChangeIndex <= 0 ? lineChanges.length - 1 : selectedChangeIndex - 1;
    focusChangeByIndex(previousIndex);
  }, [focusChangeByIndex, lineChanges.length, selectedChangeIndex]);

  const handleNextChange = useCallback(() => {
    if (lineChanges.length === 0) return;

    const nextIndex = selectedChangeIndex >= lineChanges.length - 1 ? 0 : selectedChangeIndex + 1;
    focusChangeByIndex(nextIndex);
  }, [focusChangeByIndex, lineChanges.length, selectedChangeIndex]);

  const handleChangeSelect = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextIndex = Number.parseInt(event.target.value, 10);
    if (Number.isNaN(nextIndex)) return;
    focusChangeByIndex(nextIndex);
  }, [focusChangeByIndex]);

  const handleJumpLineChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setJumpLineValue(event.target.value);
  }, []);

  const handleJumpLineSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsedLine = Number.parseInt(jumpLineValue, 10);
    if (Number.isNaN(parsedLine) || parsedLine < 1) return;

    const editor = diffEditorRef.current;
    const changes = editor?.getLineChanges() ?? lineChanges;
    if (changes.length === 0) return;

    const nextIndex = findNearestChangeIndex(changes, parsedLine);
    focusChangeByIndex(nextIndex);
  }, [focusChangeByIndex, jumpLineValue, lineChanges]);

  const handleDiffEditorMount = useCallback((editor: MonacoType.editor.IStandaloneDiffEditor) => {
    diffEditorRef.current = editor;

    diffUpdateDisposableRef.current?.dispose();
    try {
      diffUpdateDisposableRef.current = editor.onDidUpdateDiff(() => {
        refreshDiffChanges();
      });
    } catch {
      diffUpdateDisposableRef.current = null;
    }

    refreshDiffChanges();
  }, [refreshDiffChanges]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshDiffChanges();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [originalContent, modifiedContent, refreshDiffChanges]);

  useEffect(() => {
    return () => {
      diffUpdateDisposableRef.current?.dispose();
      diffUpdateDisposableRef.current = null;
      diffEditorRef.current = null;
    };
  }, []);

  const hasDiffChanges = lineChanges.length > 0;
  const changeOptions = useMemo(() => (
    lineChanges.map((change, index) => ({
      value: index,
      label: `#${index + 1} ${getDiffLineLabel(change)}`,
    }))
  ), [lineChanges]);

  return (
    <div className="quartz-diff-tab">
      <div className="quartz-diff-tab__header">
        <div className="quartz-diff-tab__meta">
          <span className="quartz-diff-tab__file">{fileName}</span>
          <span className="quartz-diff-tab__separator">|</span>
          <span>{getModeLabel(mode)}</span>
          <span className={`quartz-diff-tab__status quartz-diff-tab__status--${status}`}>
            {getStatusLabel(status)}
          </span>
        </div>
        <div className="quartz-diff-tab__header-controls">
          <div className="quartz-diff-tab__nav">
            <span className="quartz-diff-tab__change-indicator">
              Revision {Math.max(1, revisionIndex + 1)}/{Math.max(1, revisionCount)}
            </span>
            <button
              type="button"
              className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
              onClick={onPrevRevision}
              disabled={revisionCount <= 1}
            >
              Prev Rev
            </button>
            <button
              type="button"
              className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
              onClick={onNextRevision}
              disabled={revisionCount <= 1}
            >
              Next Rev
            </button>
          </div>
          <div className="quartz-diff-tab__nav">
            <span className="quartz-diff-tab__change-indicator">
              {hasDiffChanges ? `Change ${selectedChangeIndex + 1}/${lineChanges.length}` : 'No changes'}
            </span>
            <button
              type="button"
              className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
              onClick={handlePreviousChange}
              disabled={!hasDiffChanges}
            >
              Prev
            </button>
            <button
              type="button"
              className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
              onClick={handleNextChange}
              disabled={!hasDiffChanges}
            >
              Next
            </button>
            <select
              className="quartz-diff-tab__select"
              value={hasDiffChanges ? String(selectedChangeIndex) : ''}
              onChange={handleChangeSelect}
              disabled={!hasDiffChanges}
            >
              {!hasDiffChanges && <option value="">No changes</option>}
              {changeOptions.map((option) => (
                <option key={option.value} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
            <form className="quartz-diff-tab__jump-form" onSubmit={handleJumpLineSubmit}>
              <input
                className="quartz-diff-tab__input"
                type="number"
                min={1}
                step={1}
                placeholder="Line"
                value={jumpLineValue}
                onChange={handleJumpLineChange}
              />
              <button
                type="submit"
                className="quartz-diff-tab__btn quartz-diff-tab__btn--nav"
                disabled={!hasDiffChanges}
              >
                Jump
              </button>
            </form>
          </div>
          {status === 'pending' && (
            <div className="quartz-diff-tab__actions">
              <button type="button" className="quartz-diff-tab__btn quartz-diff-tab__btn--accept" onClick={onAccept}>
                Accept
              </button>
              <button type="button" className="quartz-diff-tab__btn quartz-diff-tab__btn--reject" onClick={onReject}>
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="quartz-diff-tab__editor">
        <DiffEditor
          height="100%"
          language={RITOBIN_LANGUAGE_ID}
          theme={JADE_RUNTIME_THEME_ID}
          original={originalContent}
          modified={modifiedContent}
          options={{
            renderSideBySide: true,
            readOnly: true,
            originalEditable: false,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
            lineNumbersMinChars: 6,
            fixedOverflowWidgets: true,
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
          onMount={handleDiffEditorMount}
        />
      </div>
    </div>
  );
}
