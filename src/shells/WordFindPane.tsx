import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as MonacoType from 'monaco-editor';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import {
    Search as LucideSearch,
    Replace as LucideReplace,
    ReplaceAll as LucideReplaceAll,
    ChevronUp,
    ChevronDown,
    ChevronRight,
    CaseSensitive,
    WholeWord,
    FileText,
    Layers,
    X as LucideX,
} from 'lucide-react';
import { useShell } from './ShellContext';

// ── Search / replace history ─────────────────────────────────────
// Module-level so the ↑/↓ recall list survives the pane unmounting (dock
// re-layouts, shell switches) AND is shared between find and replace modes —
// switching find↔replace must never wipe what you've already searched for.
// Newest entry first; capped so it can't grow without bound.
const HISTORY_LIMIT = 50;
const findHistoryStore: string[] = [];
const replaceHistoryStore: string[] = [];

/** Record a committed search/replace term: dedupe, move to front, cap. */
function pushHistory(store: string[], raw: string) {
    const value = raw.trim();
    if (!value) return;
    const existing = store.indexOf(value);
    if (existing !== -1) store.splice(existing, 1);
    store.unshift(value);
    if (store.length > HISTORY_LIMIT) store.length = HISTORY_LIMIT;
}

/**
 * ↑/↓ recall for a history-backed input, mirroring Monaco's find widget.
 * `idxRef` tracks the position in `store` (-1 == the live, un-recalled value).
 * Returns true when the key was handled as history navigation so the caller
 * can `preventDefault()` and stop.
 */
function navigateHistory(
    store: string[],
    idxRef: { current: number },
    key: string,
    setValue: (v: string) => void,
): boolean {
    if (key === 'ArrowUp') {
        if (store.length === 0) return false;
        idxRef.current = Math.min(idxRef.current + 1, store.length - 1);
        setValue(store[idxRef.current]);
        return true;
    }
    if (key === 'ArrowDown') {
        if (idxRef.current < 0) return false;
        idxRef.current -= 1;
        setValue(idxRef.current < 0 ? '' : store[idxRef.current]);
        return true;
    }
    return false;
}

/**
 * Word-style find/replace pane. Lives in the WordShell's left task pane
 * and the VS shell's bottom dock. Drives Monaco via the model's
 * findMatches API + decorations rather than opening Monaco's native
 * find widget.
 *
 * Supports two scopes — the active document, or every open editor
 * tab — and renders a VS Code-style result list with clickable line
 * snippets. Replace All is gated behind an inline confirmation step.
 */
export default function WordFindPane({ mode }: { mode: 'find' | 'replace' }) {
    const s = useShell();
    const [query, setQuery] = useState('');
    const [replaceText, setReplaceText] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [scope, setScope] = useState<'current' | 'all'>('current');
    const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
    const [pendingJump, setPendingJump] = useState<
        | { tabId: string; range: MonacoType.IRange }
        | null
    >(null);

    const decorationIdsRef = useRef<string[]>([]);
    const queryInputRef = useRef<HTMLInputElement | null>(null);
    // Position within the ↑/↓ recall lists; -1 == the live, un-recalled value.
    const queryHistoryIdx = useRef(-1);
    const replaceHistoryIdx = useRef(-1);

    const showReplace = mode === 'replace';

    const clearDecorations = useCallback(() => {
        const editor = s.editorRef.current;
        if (!editor) return;
        decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
    }, [s.editorRef]);

    // Pick which tabs are searchable. We only search editor-type tabs
    // (or untyped legacy tabs, which are editor by default). Texture /
    // studio / diff / markdown-preview tabs have no text model.
    const searchableTabs = useMemo(
        () => s.tabs.filter(t => !t.tabType || t.tabType === 'editor'),
        [s.tabs],
    );

    // ─── Cross-document search ─────────────────────────────────────
    // Runs every time the query, options, scope, or tab set changes.
    // For each searchable tab we ensure its model exists (creates one
    // if Monaco disposed it on a re-mount) and call findMatches.
    interface ResultFile {
        tabId: string;
        fileName: string;
        matches: MonacoType.editor.FindMatch[];
        lineTexts: Map<number, string>;
    }

    const [results, setResults] = useState<ResultFile[]>([]);

    // ── Debounced query + content-change triggers ────────────────
    // The search effect is expensive on multi-file scope (findMatches
    // is O(text-length) per model). Running it on every keystroke —
    // either in the search input OR in the editor — pegged the CPU on
    // setups with lots of big files open. We debounce both signals so
    // the search only fires after input has settled.
    const [debouncedQuery, setDebouncedQuery] = useState(query);
    useEffect(() => {
        const id = setTimeout(() => setDebouncedQuery(query), 200);
        return () => clearTimeout(id);
    }, [query]);

    const [contentTick, setContentTick] = useState(0);
    const [debouncedContentTick, setDebouncedContentTick] = useState(0);
    useEffect(() => {
        // Longer debounce here — content edits land in bursts (typing,
        // Replace All), and the user doesn't need the panel to refresh
        // mid-burst. 350ms lets the burst settle.
        const id = setTimeout(() => setDebouncedContentTick(contentTick), 350);
        return () => clearTimeout(id);
    }, [contentTick]);

    // Subscribe to content-change ONLY for the models that fall in
    // the current scope. When scope is 'current', the bump fires only
    // for the active editor — typing in a non-active tab (e.g. via a
    // diff view) doesn't churn the find pane. Reads from
    // `monacoModelsRef` directly so we don't ensure-create models for
    // tabs the user never opened (each `ensureModelForTab` builds a
    // Monaco model — eagerly building 90 of them on every render
    // would defeat the lazy-model architecture).
    useEffect(() => {
        const disposers: Array<() => void> = [];
        const targets =
            scope === 'all'
                ? searchableTabs
                : searchableTabs.filter(t => t.id === s.activeTabId);
        for (const t of targets) {
            const model = s.monacoModelsRef.current.get(t.id);
            if (!model || model.isDisposed()) continue;
            const sub = model.onDidChangeContent(() => {
                setContentTick(c => c + 1);
            });
            disposers.push(() => sub.dispose());
        }
        return () => disposers.forEach(d => d());
    }, [scope, searchableTabs, s.activeTabId, s.monacoModelsRef]);

    useEffect(() => {
        if (!debouncedQuery) {
            setResults([]);
            return;
        }
        const wordSeparators = wholeWord ? ' \t\n.,;:!?(){}[]<>"\'`/\\|' : null;
        const tabsToScan =
            scope === 'all'
                ? searchableTabs
                : searchableTabs.filter(t => t.id === s.activeTabId);

        // `limitResultCount` defaults to 999 in Monaco — pass a much
        // larger number so result-heavy files (Riot bin dumps, lock
        // files, generated source) report their true totals.
        const NO_LIMIT = 1_000_000;
        const out: ResultFile[] = [];
        for (const t of tabsToScan) {
            const model = s.ensureModelForTab(t.id);
            if (!model) continue;
            const found = model.findMatches(debouncedQuery, true, false, matchCase, wordSeparators, true, NO_LIMIT);
            if (found.length === 0) continue;
            const lineTexts = new Map<number, string>();
            for (const m of found) {
                if (!lineTexts.has(m.range.startLineNumber)) {
                    lineTexts.set(m.range.startLineNumber, model.getLineContent(m.range.startLineNumber));
                }
            }
            out.push({ tabId: t.id, fileName: t.fileName, matches: found, lineTexts });
        }
        setResults(out);
    }, [debouncedQuery, matchCase, wholeWord, scope, searchableTabs, s.activeTabId, s.ensureModelForTab, debouncedContentTick]);

    // ─── Active-document highlighting ─────────────────────────────
    // We mark every match in the currently-focused editor regardless
    // of scope, so the user still gets the yellow swatches even when
    // searching across all open files.
    useEffect(() => {
        const editor = s.editorRef.current;
        if (!editor) return;
        const active = results.find(r => r.tabId === s.activeTabId);
        if (!active || active.matches.length === 0) {
            clearDecorations();
            return;
        }
        decorationIdsRef.current = editor.deltaDecorations(
            decorationIdsRef.current,
            active.matches.map(m => ({
                range: m.range,
                options: {
                    className: 'word-find-match',
                    overviewRuler: null,
                    stickiness: 1,
                },
            })),
        );
    }, [results, s.activeTabId, s.editorRef, clearDecorations]);

    // Clean up decorations when the pane unmounts.
    useEffect(() => () => clearDecorations(), [clearDecorations]);

    // Auto-focus the query input ONLY on mount. Previously this also
    // re-ran on `mode` change so toggling find↔replace would focus
    // the new input, but `mode` is derived from `replaceWidgetOpen`,
    // which the App-level MutationObserver flips when Monaco's
    // internal `.find-widget` DOM mutates — including the first time
    // Monaco lazy-creates it on a tab's first edit. That caused the
    // "type one char, focus snaps to search" bug (one snap per file
    // because the widget creates exactly once per editor model).
    //
    // If we want auto-focus on a real user toggle, drive it from the
    // toggle button's onClick instead of this side-effect chain.
    const initialFocusRef = useRef(false);
    useEffect(() => {
        if (initialFocusRef.current) return;
        initialFocusRef.current = true;
        queryInputRef.current?.focus();
    }, []);

    // ─── Pending cross-tab jump ───────────────────────────────────
    // Clicking a result in another file: switch to that tab first,
    // then once its editor model is current, reveal + select the range.
    useEffect(() => {
        if (!pendingJump) return;
        if (pendingJump.tabId !== s.activeTabId) return;
        const editor = s.editorRef.current;
        if (!editor) return;
        const model = editor.getModel();
        if (!model) return;
        const expected = s.ensureModelForTab(pendingJump.tabId);
        if (!expected || expected !== model) return;
        editor.revealRangeInCenter(pendingJump.range);
        editor.setSelection(pendingJump.range);
        editor.focus();
        setPendingJump(null);
    }, [pendingJump, s.activeTabId, s.editorRef, s.ensureModelForTab]);

    const jumpTo = useCallback(
        (tabId: string, range: MonacoType.IRange) => {
            if (tabId === s.activeTabId) {
                const editor = s.editorRef.current;
                if (editor) {
                    editor.revealRangeInCenter(range);
                    editor.setSelection(range);
                    editor.focus();
                }
            } else {
                setPendingJump({ tabId, range });
                s.onTabSelect(tabId);
            }
        },
        [s],
    );

    // Flat list to drive Previous / Next stepping.
    const flatMatches = useMemo(
        () => results.flatMap(r => r.matches.map(m => ({ tabId: r.tabId, range: m.range }))),
        [results],
    );
    const totalMatches = flatMatches.length;
    const [currentIdx, setCurrentIdx] = useState(0);

    // Reset/clamp the cursor as results change.
    useEffect(() => {
        if (totalMatches === 0) setCurrentIdx(-1);
        else if (currentIdx < 0 || currentIdx >= totalMatches) setCurrentIdx(0);
    }, [totalMatches, currentIdx]);

    const stepBy = useCallback(
        (delta: 1 | -1) => {
            // Stepping through matches is a deliberate search — remember it.
            pushHistory(findHistoryStore, query);
            if (totalMatches === 0) return;
            const next = (currentIdx + delta + totalMatches) % totalMatches;
            setCurrentIdx(next);
            const m = flatMatches[next];
            jumpTo(m.tabId, m.range);
        },
        [currentIdx, flatMatches, totalMatches, jumpTo, query],
    );

    const goNext = useCallback(() => stepBy(1), [stepBy]);
    const goPrev = useCallback(() => stepBy(-1), [stepBy]);

    const replaceCurrent = useCallback(() => {
        if (totalMatches === 0 || currentIdx < 0) return;
        const target = flatMatches[currentIdx];
        // Replace runs against the *active* editor; if the user steps
        // through cross-document matches we hop tabs first.
        if (target.tabId !== s.activeTabId) {
            jumpTo(target.tabId, target.range);
            return;
        }
        const editor = s.editorRef.current;
        if (!editor) return;
        // Both terms are now committed — record them for ↑/↓ recall.
        pushHistory(findHistoryStore, query);
        pushHistory(replaceHistoryStore, replaceText);
        editor.executeEdits('word-find-replace', [
            { range: target.range, text: replaceText, forceMoveMarkers: true },
        ]);
        setQuery(q => q);
    }, [currentIdx, flatMatches, totalMatches, replaceText, s, jumpTo, query]);

    const doReplaceAll = useCallback(() => {
        if (totalMatches === 0) return;
        // Both terms are now committed — record them for ↑/↓ recall.
        pushHistory(findHistoryStore, query);
        pushHistory(replaceHistoryStore, replaceText);
        // Group by tab and apply through each tab's model directly so
        // we don't have to swap the active editor mid-replace. Each
        // model groups its edits in a single undo step.
        const byTab = new Map<string, MonacoType.editor.FindMatch[]>();
        for (const r of results) byTab.set(r.tabId, r.matches);
        for (const [tabId, ms] of byTab) {
            const model = s.ensureModelForTab(tabId);
            if (!model) continue;
            model.pushEditOperations(
                [],
                ms.map(m => ({ range: m.range, text: replaceText, forceMoveMarkers: true })),
                () => null,
            );
        }
        setQuery(q => q);
    }, [results, totalMatches, replaceText, s, query]);

    const requestReplaceAll = useCallback(async () => {
        if (totalMatches === 0) return;
        // Multi-file replace fans edits across documents the user may
        // not have looked at — confirm via the OS dialog before going.
        // Single-file case skips the prompt (undo covers it).
        if (results.length > 1) {
            const proceed = await askDialog(
                `Replace ${totalMatches} ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${results.length} files with '${replaceText}'?`,
                { title: 'Replace All', kind: 'info' },
            );
            if (!proceed) return;
        }
        doReplaceAll();
    }, [totalMatches, results.length, replaceText, doReplaceAll]);

    const toggleFile = (tabId: string) => {
        setCollapsedFiles(prev => {
            const next = new Set(prev);
            if (next.has(tabId)) next.delete(tabId);
            else next.add(tabId);
            return next;
        });
    };

    /** Renders the matched line with the hit text highlighted in-place. */
    const renderSnippet = (
        lineText: string,
        match: MonacoType.editor.FindMatch,
    ) => {
        const startCol = match.range.startColumn - 1;
        const endCol =
            match.range.endLineNumber === match.range.startLineNumber
                ? match.range.endColumn - 1
                : lineText.length;
        const before = lineText.slice(0, startCol);
        const hit = lineText.slice(startCol, endCol);
        const after = lineText.slice(endCol);
        // Trim very long leading whitespace so the snippet stays readable.
        const trimmed = before.replace(/^\s{4,}/, m => (m.length > 16 ? m.slice(0, 8) + '…' : m));
        return (
            <>
                <span className="word-find-snippet-pre">{trimmed}</span>
                <span className="word-find-snippet-hit">{hit}</span>
                <span className="word-find-snippet-post">{after}</span>
            </>
        );
    };

    // Precompute the starting flat-index for each file so per-row
    // lookup is O(1) instead of the O(n) `findIndex` call that
    // turned the render into O(n²) on result-heavy searches.
    const fileFlatStarts = useMemo(() => {
        const m = new Map<string, number>();
        let c = 0;
        for (const r of results) {
            m.set(r.tabId, c);
            c += r.matches.length;
        }
        return m;
    }, [results]);

    // ── True virtualization for the result list ──────────────────
    // Previous renderCap progressive renderer mounted ALL matches
    // over a few frames — still scaled linearly with total match
    // count. For 10k+ matches the DOM weight + React reconciliation
    // were enough to lag the editor on slower machines. We now
    // mount only the rows that fall inside the scroll viewport
    // (plus a small over-scan buffer), absolute-positioned inside a
    // spacer container sized to the full list height so the
    // scrollbar still reflects the real length.
    const FILE_HEADER_H = 26;
    const MATCH_ROW_H = 20;
    const LIST_PAD = 4;
    const OVERSCAN_PX = 240;

    const scrollViewRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(400);

    useLayoutEffect(() => {
        const el = scrollViewRef.current;
        if (!el) return;
        const updateH = () => setViewportH(el.clientHeight);
        updateH();
        const ro = new ResizeObserver(updateH);
        ro.observe(el);
        const onScroll = () => setScrollTop(el.scrollTop);
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            ro.disconnect();
            el.removeEventListener('scroll', onScroll);
        };
    }, []);

    interface VRow {
        kind: 'header' | 'match';
        fileIdx: number;
        matchIdx: number;
        top: number;
        height: number;
    }

    // Flatten results into a virtual-row list with each row's
    // absolute top inside the spacer. Headers are always emitted
    // (file label is always visible); collapsed files skip their
    // match rows so they take only header height.
    const virtual = useMemo(() => {
        const items: VRow[] = [];
        let y = LIST_PAD;
        for (let fi = 0; fi < results.length; fi++) {
            const f = results[fi];
            items.push({ kind: 'header', fileIdx: fi, matchIdx: -1, top: y, height: FILE_HEADER_H });
            y += FILE_HEADER_H;
            if (collapsedFiles.has(f.tabId)) continue;
            for (let mi = 0; mi < f.matches.length; mi++) {
                items.push({ kind: 'match', fileIdx: fi, matchIdx: mi, top: y, height: MATCH_ROW_H });
                y += MATCH_ROW_H;
            }
        }
        return { items, totalH: y + LIST_PAD };
    }, [results, collapsedFiles]);

    const visibleRows = useMemo(() => {
        if (virtual.items.length === 0) return [];
        const lo = scrollTop - OVERSCAN_PX;
        const hi = scrollTop + viewportH + OVERSCAN_PX;
        // Binary-search the first visible item for O(log n) instead
        // of scanning. Items are sorted by `top` by construction.
        const arr = virtual.items;
        let l = 0, r = arr.length - 1, startIdx = 0;
        while (l <= r) {
            const m = (l + r) >> 1;
            if (arr[m].top + arr[m].height >= lo) {
                startIdx = m;
                r = m - 1;
            } else {
                l = m + 1;
            }
        }
        const out: VRow[] = [];
        for (let i = startIdx; i < arr.length; i++) {
            if (arr[i].top > hi) break;
            out.push(arr[i]);
        }
        return out;
    }, [virtual.items, scrollTop, viewportH]);

    // Reset scroll-to-top when the result set changes so the user
    // doesn't end up scrolled into a stale offset of new results.
    useEffect(() => {
        if (scrollViewRef.current) scrollViewRef.current.scrollTop = 0;
        setScrollTop(0);
    }, [results]);

    return (
        <div className="word-find-pane">
            <div className="word-pane-header">
                <span className="word-pane-title">
                    {showReplace ? <LucideReplace size={14} /> : <LucideSearch size={14} />}
                    {showReplace ? 'Replace' : 'Find Results'}
                </span>
                <button
                    type="button"
                    className="word-pane-close"
                    onClick={() => {
                        if (s.findWidgetOpen) s.onFind();
                        else if (s.replaceWidgetOpen) s.onReplace();
                    }}
                    aria-label="Close"
                >
                    <LucideX size={12} />
                </button>
            </div>

            <div className="word-pane-body">
                {/* ── Search row ─────────────────────────────── */}
                <div className="word-find-row">
                    <div className="word-find-field">
                        <LucideSearch size={13} className="word-find-field-icon" />
                        <input
                            ref={queryInputRef}
                            type="text"
                            className="word-find-field-input"
                            placeholder="Search"
                            title="↑ / ↓ to recall recent searches"
                            value={query}
                            onChange={e => {
                                setQuery(e.target.value);
                                // Typing leaves history-recall mode.
                                queryHistoryIdx.current = -1;
                            }}
                            onBlur={() => pushHistory(findHistoryStore, query)}
                            onKeyDown={e => {
                                if (navigateHistory(findHistoryStore, queryHistoryIdx, e.key, setQuery)) {
                                    e.preventDefault();
                                    return;
                                }
                                if (e.key === 'Enter') {
                                    pushHistory(findHistoryStore, query);
                                    queryHistoryIdx.current = -1;
                                    if (e.shiftKey) goPrev();
                                    else goNext();
                                } else if (e.key === 'Escape') {
                                    if (s.findWidgetOpen) s.onFind();
                                    else if (s.replaceWidgetOpen) s.onReplace();
                                }
                            }}
                        />
                    </div>
                    <div className="word-find-pill">
                        <button
                            type="button"
                            className={`word-find-iconbtn ${matchCase ? 'is-on' : ''}`}
                            onClick={() => setMatchCase(v => !v)}
                            title="Match case (Aa)"
                            aria-pressed={matchCase}
                        >
                            <CaseSensitive size={16} />
                        </button>
                        <button
                            type="button"
                            className={`word-find-iconbtn ${wholeWord ? 'is-on' : ''}`}
                            onClick={() => setWholeWord(v => !v)}
                            title="Match whole word"
                            aria-pressed={wholeWord}
                        >
                            <WholeWord size={16} />
                        </button>
                    </div>
                </div>

                {/* ── Replace row ─────────────────────────────── */}
                {showReplace && (
                    <div className="word-find-row">
                        <div className="word-find-field">
                            <LucideReplace size={13} className="word-find-field-icon" />
                            <input
                                type="text"
                                className="word-find-field-input"
                                placeholder="Replace with"
                                title="↑ / ↓ to recall recent replacements"
                                value={replaceText}
                                onChange={e => {
                                    setReplaceText(e.target.value);
                                    // Typing leaves history-recall mode.
                                    replaceHistoryIdx.current = -1;
                                }}
                                onBlur={() => pushHistory(replaceHistoryStore, replaceText)}
                                onKeyDown={e => {
                                    if (navigateHistory(replaceHistoryStore, replaceHistoryIdx, e.key, setReplaceText)) {
                                        e.preventDefault();
                                        return;
                                    }
                                    if (e.key === 'Enter') {
                                        pushHistory(replaceHistoryStore, replaceText);
                                        replaceHistoryIdx.current = -1;
                                        replaceCurrent();
                                    }
                                }}
                            />
                        </div>
                        <div className="word-find-pill">
                            <button
                                type="button"
                                className="word-find-iconbtn"
                                onClick={replaceCurrent}
                                disabled={totalMatches === 0 || currentIdx < 0}
                                title="Replace current match (Enter)"
                            >
                                <LucideReplace size={15} />
                            </button>
                            <button
                                type="button"
                                className="word-find-iconbtn"
                                onClick={requestReplaceAll}
                                disabled={totalMatches === 0}
                                title="Replace all matches"
                            >
                                <LucideReplaceAll size={15} />
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Scope + nav toolbar ─────────────────────── */}
                <div className="word-find-toolbar">
                    <div className="word-find-scope" role="tablist">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={scope === 'current'}
                            className={`word-find-scope-btn ${scope === 'current' ? 'is-on' : ''}`}
                            onClick={() => setScope('current')}
                            title="Search only the active document"
                        >
                            <FileText size={15} />
                            Current
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={scope === 'all'}
                            className={`word-find-scope-btn ${scope === 'all' ? 'is-on' : ''}`}
                            onClick={() => setScope('all')}
                            title="Search across every open document"
                        >
                            <Layers size={15} />
                            All open
                            <span className="word-find-scope-count">{searchableTabs.length}</span>
                        </button>
                    </div>

                    <div className="word-find-nav">
                        <button
                            type="button"
                            className="word-find-iconbtn"
                            onClick={goPrev}
                            disabled={totalMatches === 0}
                            title="Previous (Shift+Enter)"
                            aria-label="Previous match"
                        >
                            <ChevronUp size={16} />
                        </button>
                        <button
                            type="button"
                            className="word-find-iconbtn"
                            onClick={goNext}
                            disabled={totalMatches === 0}
                            title="Next (Enter)"
                            aria-label="Next match"
                        >
                            <ChevronDown size={16} />
                        </button>
                    </div>
                </div>

                {/* ── Status bar ──────────────────────────────── */}
                <div className="word-find-statusbar">
                    {query ? (
                        totalMatches > 0 ? (
                            <>
                                <span className="word-find-status-strong">{totalMatches}</span>
                                <span className="word-find-status-dim">
                                    {totalMatches === 1 ? ' result' : ' results'}
                                    {results.length > 1 ? ` in ${results.length} files` : ''}
                                </span>
                                {currentIdx >= 0 && (
                                    <span className="word-find-status-cursor">
                                        · {currentIdx + 1} of {totalMatches}
                                    </span>
                                )}
                            </>
                        ) : (
                            <span className="word-find-status-dim">No matches</span>
                        )
                    ) : (
                        <span className="word-find-status-dim">
                            {scope === 'all'
                                ? `Searching ${searchableTabs.length} open ${
                                      searchableTabs.length === 1 ? 'document' : 'documents'
                                  }`
                                : 'Searching the active document'}
                        </span>
                    )}
                </div>

            </div>

            <div className="word-find-scroll" ref={scrollViewRef}>
                {!query && (
                    <div className="word-find-empty">
                        <LucideSearch size={28} className="word-find-empty-icon" />
                        <p className="word-find-empty-title">
                            {showReplace ? 'Find & replace' : 'Find in documents'}
                        </p>
                        <p className="word-find-empty-sub">
                            {showReplace
                                ? 'Type a term, then a replacement. Enter replaces the current match.'
                                : 'Press Enter to step through. Switch to All open to search every tab.'}
                        </p>
                    </div>
                )}

                {query && totalMatches === 0 && (
                    <div className="word-find-empty">
                        <p className="word-find-empty-title">Nothing matched</p>
                        <p className="word-find-empty-sub">
                            Try tweaking case sensitivity or whole-word matching.
                        </p>
                    </div>
                )}

                {totalMatches > 0 && (
                    /* Virtualized list. The outer container is sized to
                       the full list height so the scrollbar is honest
                       about how much content there is; only rows that
                       intersect the viewport (+ overscan buffer) are
                       actually mounted, absolutely positioned at their
                       computed `top`. */
                    <div
                        className="word-find-results word-find-results-virtual"
                        style={{ position: 'relative', height: virtual.totalH }}
                    >
                        {visibleRows.map((vr) => {
                            const file = results[vr.fileIdx];
                            if (vr.kind === 'header') {
                                const collapsed = collapsedFiles.has(file.tabId);
                                return (
                                    <button
                                        key={`h-${vr.fileIdx}`}
                                        type="button"
                                        className="word-find-result-fileheader word-find-row-abs"
                                        style={{ top: vr.top, height: vr.height }}
                                        onClick={() => toggleFile(file.tabId)}
                                        title={file.fileName}
                                    >
                                        <ChevronRight
                                            size={12}
                                            className={`word-find-result-caret ${collapsed ? '' : 'is-open'}`}
                                        />
                                        <FileText size={12} className="word-find-result-fileicon" />
                                        <span className="word-find-result-filename">{file.fileName}</span>
                                        <span className="word-find-result-filecount">{file.matches.length}</span>
                                    </button>
                                );
                            }
                            const m = file.matches[vr.matchIdx];
                            const fileStart = fileFlatStarts.get(file.tabId) ?? 0;
                            const flatIdx = fileStart + vr.matchIdx;
                            const isCurrent = flatIdx === currentIdx;
                            const lineText = file.lineTexts.get(m.range.startLineNumber) ?? '';
                            return (
                                <div
                                    key={`m-${vr.fileIdx}-${vr.matchIdx}`}
                                    className={
                                        'word-find-result-row word-find-row-abs' +
                                        (isCurrent ? ' is-current' : '')
                                    }
                                    style={{ top: vr.top, height: vr.height }}
                                    onClick={() => {
                                        setCurrentIdx(flatIdx);
                                        jumpTo(file.tabId, m.range);
                                    }}
                                    title={`Line ${m.range.startLineNumber}`}
                                >
                                    <span className="word-find-result-line">
                                        {m.range.startLineNumber}
                                    </span>
                                    <span className="word-find-result-snippet">
                                        {renderSnippet(lineText, m)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
