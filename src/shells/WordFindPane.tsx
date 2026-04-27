import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as MonacoType from 'monaco-editor';
import { SearchIcon, ReplaceIcon, CloseIcon } from '../components/Icons';
import { useShell } from './ShellContext';

/**
 * Word-style find/replace pane. Lives in the WordShell's left task pane.
 * Drives Monaco via the model's findMatches API + decorations rather
 * than opening Monaco's native find widget.
 *
 * Accepts an explicit `mode` so the ribbon can flip between plain Find
 * and Find + Replace without unmounting the input state.
 */
export default function WordFindPane({ mode }: { mode: 'find' | 'replace' }) {
    const s = useShell();
    const [query, setQuery] = useState('');
    const [replaceText, setReplaceText] = useState('');
    const [matches, setMatches] = useState<MonacoType.editor.FindMatch[]>([]);
    const [currentIdx, setCurrentIdx] = useState(0);
    const [matchCase, setMatchCase] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const decorationIdsRef = useRef<string[]>([]);
    const queryInputRef = useRef<HTMLInputElement | null>(null);

    const showReplace = mode === 'replace';

    const clearDecorations = useCallback(() => {
        const editor = s.editorRef.current;
        if (!editor) return;
        decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
    }, [s.editorRef]);

    // Recompute matches whenever the query, options, or active tab change.
    useEffect(() => {
        const editor = s.editorRef.current;
        if (!editor) return;
        const model = editor.getModel();
        if (!model || !query) {
            setMatches([]);
            setCurrentIdx(0);
            clearDecorations();
            return;
        }
        const found = model.findMatches(
            query,
            true,
            false,
            matchCase,
            wholeWord ? ' \t\n.,;:!?(){}[]<>"\'`/\\|' : null,
            true,
        );
        setMatches(found);
        setCurrentIdx(found.length > 0 ? 0 : -1);
        if (found.length > 0) {
            editor.revealRangeInCenter(found[0].range);
            editor.setSelection(found[0].range);
        }
        decorationIdsRef.current = editor.deltaDecorations(
            decorationIdsRef.current,
            found.map((m, i) => ({
                range: m.range,
                options: {
                    className: i === 0 ? 'word-find-match-current' : 'word-find-match',
                    overviewRuler: null,
                    stickiness: 1,
                },
            })),
        );
        // Re-run when the active document changes too.
    }, [query, matchCase, wholeWord, s.activeTabId, clearDecorations, s.editorRef]);

    // Update which match is "current" highlight as user navigates.
    useEffect(() => {
        const editor = s.editorRef.current;
        if (!editor || matches.length === 0) return;
        decorationIdsRef.current = editor.deltaDecorations(
            decorationIdsRef.current,
            matches.map((m, i) => ({
                range: m.range,
                options: {
                    className: i === currentIdx ? 'word-find-match-current' : 'word-find-match',
                    overviewRuler: null,
                    stickiness: 1,
                },
            })),
        );
    }, [currentIdx, matches, s.editorRef]);

    // Clean up decorations when the pane unmounts.
    useEffect(() => () => clearDecorations(), [clearDecorations]);

    // Auto-focus the query input on mount and when switching modes.
    useEffect(() => {
        queryInputRef.current?.focus();
    }, [mode]);

    const goNext = useCallback(() => {
        const editor = s.editorRef.current;
        if (!editor || matches.length === 0) return;
        const next = (currentIdx + 1) % matches.length;
        setCurrentIdx(next);
        editor.revealRangeInCenter(matches[next].range);
        editor.setSelection(matches[next].range);
    }, [currentIdx, matches, s.editorRef]);

    const goPrev = useCallback(() => {
        const editor = s.editorRef.current;
        if (!editor || matches.length === 0) return;
        const prev = (currentIdx - 1 + matches.length) % matches.length;
        setCurrentIdx(prev);
        editor.revealRangeInCenter(matches[prev].range);
        editor.setSelection(matches[prev].range);
    }, [currentIdx, matches, s.editorRef]);

    const replaceCurrent = useCallback(() => {
        const editor = s.editorRef.current;
        if (!editor || matches.length === 0 || currentIdx < 0) return;
        const target = matches[currentIdx];
        editor.executeEdits('word-find-replace', [
            { range: target.range, text: replaceText, forceMoveMarkers: true },
        ]);
        // findMatches will re-run via state effect after the model changes —
        // but we trigger an explicit refresh by jiggling the query.
        setQuery(q => q);
    }, [currentIdx, matches, replaceText, s.editorRef]);

    const replaceAll = useCallback(() => {
        const editor = s.editorRef.current;
        if (!editor || matches.length === 0) return;
        editor.executeEdits(
            'word-find-replace-all',
            matches.map(m => ({ range: m.range, text: replaceText, forceMoveMarkers: true })),
        );
        setQuery(q => q);
    }, [matches, replaceText, s.editorRef]);

    const matchLabel = useMemo(() => {
        if (!query) return '';
        if (matches.length === 0) return 'No matches';
        return `${currentIdx + 1} of ${matches.length}`;
    }, [query, matches, currentIdx]);

    return (
        <div className="word-find-pane">
            <div className="word-pane-header">
                <span className="word-pane-title">
                    {showReplace ? <ReplaceIcon size={14} /> : <SearchIcon size={14} />}
                    {showReplace ? 'Replace' : 'Navigation'}
                </span>
                <button
                    type="button"
                    className="word-pane-close"
                    onClick={() => {
                        if (showReplace) {
                            // Replace open → close everything (find + replace).
                            // (`onReplace` toggles replaceWidgetOpen on the same flow.)
                            // We only close *this* pane, not the panels below.
                        }
                        // Close both — ribbon Find/Replace toggle these flags.
                        if (s.findWidgetOpen) s.onFind();
                        else if (s.replaceWidgetOpen) s.onReplace();
                    }}
                    aria-label="Close"
                >
                    <CloseIcon size={12} />
                </button>
            </div>

            <div className="word-pane-body">
                <input
                    ref={queryInputRef}
                    type="text"
                    className="word-find-input"
                    placeholder="Search document"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            if (e.shiftKey) goPrev();
                            else goNext();
                        } else if (e.key === 'Escape') {
                            if (s.findWidgetOpen) s.onFind();
                            else if (s.replaceWidgetOpen) s.onReplace();
                        }
                    }}
                />

                {showReplace && (
                    <input
                        type="text"
                        className="word-find-input"
                        placeholder="Replace with"
                        value={replaceText}
                        onChange={e => setReplaceText(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') replaceCurrent();
                        }}
                    />
                )}

                <div className="word-find-options">
                    <label className="word-find-option">
                        <input
                            type="checkbox"
                            checked={matchCase}
                            onChange={e => setMatchCase(e.target.checked)}
                        />
                        Match case
                    </label>
                    <label className="word-find-option">
                        <input
                            type="checkbox"
                            checked={wholeWord}
                            onChange={e => setWholeWord(e.target.checked)}
                        />
                        Whole word
                    </label>
                </div>

                <div className="word-find-controls">
                    <button
                        type="button"
                        className="word-find-btn"
                        onClick={goPrev}
                        disabled={matches.length === 0}
                        title="Previous (Shift+Enter)"
                    >
                        Previous
                    </button>
                    <button
                        type="button"
                        className="word-find-btn"
                        onClick={goNext}
                        disabled={matches.length === 0}
                        title="Next (Enter)"
                    >
                        Next
                    </button>
                    <span className="word-find-count">{matchLabel}</span>
                </div>

                {showReplace && (
                    <div className="word-find-controls">
                        <button
                            type="button"
                            className="word-find-btn"
                            onClick={replaceCurrent}
                            disabled={matches.length === 0 || currentIdx < 0}
                        >
                            Replace
                        </button>
                        <button
                            type="button"
                            className="word-find-btn"
                            onClick={replaceAll}
                            disabled={matches.length === 0}
                        >
                            Replace all
                        </button>
                    </div>
                )}

                {!query && (
                    <p className="word-find-hint">
                        {showReplace
                            ? 'Type a search term, then a replacement. Press Enter in the second field to replace the current match.'
                            : 'Search across the active document. Press Enter to step through matches.'}
                    </p>
                )}
            </div>
        </div>
    );
}
