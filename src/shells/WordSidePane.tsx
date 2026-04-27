import GeneralEditPanel from '../components/GeneralEditPanel';
import ParticleEditorPanel from '../components/ParticleEditorPanel';
import MarkdownEditPanel from '../components/MarkdownEditPanel';
import WordFindPane from './WordFindPane';
import { useShell } from './ShellContext';
import { getFileExtension } from '../lib/binOperations';

/**
 * Word-shell left task pane. Shows whichever tool the user has active —
 * find/replace, general editing, or particle editing — as a docked panel.
 * When nothing is active, the pane collapses to zero width.
 *
 * Priority when multiple flags are set: replace > find > particle > general.
 */
export default function WordSidePane() {
    const s = useShell();
    const { activeTab } = s;

    const anyOpen =
        s.findWidgetOpen || s.replaceWidgetOpen ||
        s.generalEditPanelOpen || s.particlePanelOpen;
    if (!anyOpen) return null;

    let content: React.ReactNode = null;
    if (s.replaceWidgetOpen) {
        content = <WordFindPane mode="replace" />;
    } else if (s.findWidgetOpen) {
        content = <WordFindPane mode="find" />;
    } else if (s.particlePanelOpen && activeTab && s.isEditorTab(activeTab)) {
        content = (
            <ParticleEditorPanel
                docked
                isOpen
                onClose={() => s.setParticlePanelOpen(false)}
                editorContent={s.editorRef.current?.getValue() || activeTab.content}
                onContentChange={s.handleGeneralEditContentChange}
                onScrollToLine={s.handleScrollToLine}
                onStatusUpdate={s.setStatusMessage}
            />
        );
    } else if (s.generalEditPanelOpen && activeTab && s.isEditorTab(activeTab)) {
        const tabName = activeTab.filePath ?? activeTab.fileName;
        const ext = getFileExtension(tabName);
        const isMarkdown = ext === 'md' || ext === 'markdown';
        content = isMarkdown ? (
            <MarkdownEditPanel
                docked
                isOpen
                onClose={() => s.setGeneralEditPanelOpen(false)}
                wrapSelection={s.mdWrapSelection}
                prefixLines={s.mdPrefixLines}
                insertAtCaret={s.mdInsertAtCaret}
            />
        ) : (
            <GeneralEditPanel
                docked
                isOpen
                onClose={() => s.setGeneralEditPanelOpen(false)}
                editorContent={s.editorRef.current?.getValue() || activeTab.content}
                onContentChange={s.handleGeneralEditContentChange}
                filePath={activeTab.filePath ?? undefined}
                onLibraryInsert={s.recordJadelibInsert}
            />
        );
    }

    return <aside className="word-side-pane">{content}</aside>;
}
