import { useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import TabBar from '../components/TabBar';
import { useShell, type PerfMode } from './ShellContext';

interface FloatingEditorPaneProps {
    x: number;
    y: number;
    width: number;
    height: number;
    onHeaderPointerDown: (e: React.PointerEvent) => void;
    onResizePointerDown: (e: React.PointerEvent) => void;
    onClose: () => void;
}

/**
 * The whole editor pane (tab strip + Monaco) popped out as a free
 * floating window inside the same shell. Mounts its own Monaco editor
 * that attaches to the shared `ITextModel` from the main editor's
 * model registry, so the main editor (kept mounted but hidden under
 * the popped state) and the floating one stay in sync. Tabs render
 * the same way as in the main shell — clicking switches the active
 * tab everywhere.
 */
export default function FloatingEditorPane({
    x, y, width, height,
    onHeaderPointerDown,
    onResizePointerDown,
    onClose,
}: FloatingEditorPaneProps) {
    const s = useShell();
    const editorInstance = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);

    const onMount = (editor: MonacoType.editor.IStandaloneCodeEditor) => {
        editorInstance.current = editor;
        const model = s.activeTabId ? s.monacoModelsRef.current.get(s.activeTabId) : null;
        if (model && !model.isDisposed()) editor.setModel(model);
    };

    useEffect(() => {
        const ed = editorInstance.current;
        if (!ed) return;
        const model = s.activeTabId ? s.monacoModelsRef.current.get(s.activeTabId) : null;
        if (model && !model.isDisposed()) ed.setModel(model);
        else ed.setModel(null);
    }, [s.activeTabId, s.monacoModelsRef]);

    useEffect(() => () => {
        const ed = editorInstance.current;
        if (ed) ed.setModel(null);
    }, []);

    const isBig = s.lineCount > s.bigFileLines;
    const isOn = (mode: PerfMode) => mode === 'on' ? true : mode === 'off' ? false : !isBig;

    return (
        <div className="vs-floating-editor" style={{ left: x, top: y, width, height }}>
            <div className="vs-floating-editor-handle" onPointerDown={onHeaderPointerDown}>
                <span className="vs-floating-editor-title">Editor</span>
                <button
                    type="button"
                    className="vs-dock-close"
                    onClick={onClose}
                    onPointerDown={e => e.stopPropagation()}
                    aria-label="Re-dock to center"
                >
                    &times;
                </button>
            </div>

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

            <div className="vs-floating-editor-body">
                <Editor
                    height="100%"
                    // Shared model from the registry — don't let the
                    // wrapper dispose it when this floating pane unmounts.
                    keepCurrentModel
                    theme={s.editorTheme}
                    onMount={onMount}
                    options={{
                        minimap: { enabled: !isBig && isOn(s.perfPrefs.minimap) },
                        glyphMargin: true,
                        fontSize: 14,
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        fontFamily: s.editorFontFamily || undefined,
                        lineNumbersMinChars: 4,
                        contextmenu: false,
                        largeFileOptimizations: false,
                        maxTokenizationLineLength: 100_000,
                        folding: isOn(s.perfPrefs.folding),
                        renderWhitespace: 'none',
                        bracketPairColorization: { enabled: isOn(s.perfPrefs.bracketColors) },
                        find: {
                            addExtraSpaceOnTop: false,
                            autoFindInSelection: 'never' as const,
                            seedSearchStringFromSelection: 'always' as const,
                        },
                    }}
                />
            </div>

            <div className="vs-floating-editor-resize" onPointerDown={onResizePointerDown} />
        </div>
    );
}
