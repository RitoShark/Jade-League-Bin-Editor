import TitleBar from '../components/TitleBar';
import MenuBar from '../components/MenuBar';
import StatusBar from '../components/StatusBar';
import { WelcomeScreenWithExit } from '../components/WelcomeScreen';
import EditorGroupLayout from './EditorGroupLayout';
import EditorGroupView from './EditorGroupView';
import GeneralEditPanel from '../components/GeneralEditPanel';
import ParticleEditorPanel from '../components/ParticleEditorPanel';
import BinNavPanel from '../components/BinNavPanel';
import MarkdownEditPanel from '../components/MarkdownEditPanel';
import { getFileExtension } from '../lib/binOperations';
import SharedDialogs from './SharedDialogs';
import { useShell } from './ShellContext';

/**
 * VSCode-style shell — title bar, menu bar, tab strip, Monaco editor,
 * status bar. Tools open as floating popovers anchored to the editor.
 */
export default function VSCodeShell() {
    const s = useShell();
    const welcomeVisible = s.welcomeOverride === 'force'
        || (s.welcomeOverride !== 'hide' && s.tabs.length === 0);

    // Floating edit panels (VSCode shell only) anchor to the editor area
    // and target the focused group's editor via `editorRef`.
    const at = s.activeTab;
    const showPanels = !!at && s.isEditorTab(at);
    const ext = at ? getFileExtension(at.filePath ?? at.fileName) : '';
    const isMarkdown = ext === 'md' || ext === 'markdown';
    const editorContent = at ? (s.editorRef.current?.getValue() || at.content) : '';
    const floatingPanels = showPanels && at ? (
        <>
            {isMarkdown ? (
                <MarkdownEditPanel
                    isOpen={s.generalEditPanelOpen}
                    onClose={() => s.setGeneralEditPanelOpen(false)}
                    wrapSelection={s.mdWrapSelection}
                    prefixLines={s.mdPrefixLines}
                    insertAtCaret={s.mdInsertAtCaret}
                />
            ) : (
                <GeneralEditPanel
                    isOpen={s.generalEditPanelOpen}
                    onClose={() => s.setGeneralEditPanelOpen(false)}
                    editorContent={editorContent}
                    onContentChange={s.handleGeneralEditContentChange}
                    filePath={at.filePath ?? undefined}
                    onLibraryInsert={s.recordJadelibInsert}
                />
            )}
            <ParticleEditorPanel
                isOpen={s.particlePanelOpen}
                onClose={() => s.setParticlePanelOpen(false)}
                editorContent={editorContent}
                onContentChange={s.handleGeneralEditContentChange}
                onScrollToLine={s.handleScrollToLine}
                onStatusUpdate={s.setStatusMessage}
            />
            <BinNavPanel
                isOpen={s.binNavOpen}
                onClose={() => s.setBinNavOpen(false)}
                editorContent={editorContent}
                onScrollToLine={s.handleScrollToLine}
            />
        </>
    ) : null;

    return (
        <div className={`app-container ${s.isDragging ? 'dragging' : ''}`}>
            <TitleBar
                appIcon={s.appIcon}
                isMaximized={s.isMaximized}
                onThemes={s.onThemes}
                onPreferences={s.onPreferences}
                onSettings={s.onSettings}
                onAbout={s.onAbout}
                onMinimize={s.onMinimize}
                onMaximize={s.onMaximize}
                onClose={s.onClose}
                onParticleEditor={s.onParticleEditor}
                onMaterialLibrary={s.onMaterialLibrary}
                onQuartzAction={s.onSendToQuartz}
                onIconClick={() => s.setWelcomeOverride('force')}
            />

            <MenuBar
                findActive={s.replaceWidgetOpen}
                replaceActive={s.replaceWidgetOpen}
                generalEditActive={s.generalEditPanelOpen}
                particlePanelActive={s.particlePanelOpen}
                binNavActive={s.binNavOpen}
                particleDisabled={!s.isBinFileOpen()}
                onNewFile={s.onNew}
                onNewStudioScene={s.onNewStudioScene}
                onOpenStudioScene={s.onStudioOpen}
                onOpenFile={s.onOpen}
                onOpenFolder={s.onOpenFolder}
                onOpenWadInExplorer={s.onOpenWadInExplorer}
                onSaveFile={s.onSave}
                onSaveAll={s.onSaveAll}
                onSaveFileAs={s.onSaveAs}
                onOpenLog={s.onOpenLog}
                onExit={s.onClose}
                onUndo={s.onUndo}
                onRedo={s.onRedo}
                onCut={s.onCut}
                onCopy={s.onCopy}
                onPaste={s.onPaste}
                onFind={s.onFind}
                onReplace={s.onReplace}
                onCompareFiles={s.onCompareFiles}
                onScanBinAssets={s.onScanBinAssets}
                scanBinAssetsDisabled={!s.isBinFileOpen()}
                onSelectAll={s.onSelectAll}
                onGeneralEdit={s.onGeneralEdit}
                onParticlePanel={s.onParticlePanel}
                onBinNav={s.onBinNav}
                onThemes={s.onThemes}
                onSettings={s.onSettings}
                onAbout={s.onAbout}
                onMaterialLibrary={s.onMaterialLibrary}
                recentFiles={s.recentFiles}
                onOpenRecentFile={s.openFileFromPath}
                openFileDisabled={s.openFileDisabled}
                onMainPage={() => s.setWelcomeOverride('force')}
            />

            <WelcomeScreenWithExit
                visible={welcomeVisible && !s.fileLoading}
                onOpenFile={s.onOpen}
                onNewFile={s.onNew}
                onContinueWithoutFile={() => s.setWelcomeOverride('hide')}
                openFileDisabled={s.openFileDisabled}
                recentFiles={s.recentFiles}
                onOpenRecentFile={s.openFileFromPath}
                onMaterialLibrary={s.onMaterialLibrary}
                onThemes={s.onThemes}
                onSettings={s.onSettings}
                onAbout={s.onAbout}
                onNewStudioScene={s.onNewStudioScene}
                onNewAnimStudioScene={s.onNewAnimStudioScene}
                onOpenFolder={s.onOpenFolder}
                onOpenSkinBinAsText={s.onOpenSkinBinAsText}
                onSendMeshToStudio={s.onSendMeshToStudio}
                appIcon={s.appIcon}
                onMinimize={s.onMinimize}
                onMaximize={s.onMaximize}
                onClose={s.onClose}
                isMaximized={s.isMaximized}
            />
            {welcomeVisible && s.fileLoading && <div className="file-loading-backdrop" />}

            {/* Wrapper takes flex:1 so the StatusBar stays pinned to the
                bottom even when EditorPane has no active tab to render
                (no welcome overlay, e.g. after "Continue without file"). */}
            <div className="vscode-editor-area editor-container" style={{ position: 'relative', display: 'flex', minHeight: 0 }}>
                <EditorGroupLayout
                    node={s.layout}
                    renderGroup={(g) => <EditorGroupView group={g} />}
                    onResize={s.onResizeSplit}
                />
                {floatingPanels}
            </div>

            <StatusBar
                status={s.statusText}
                lineCount={s.lineCount}
                caretLine={s.caretPosition.line}
                caretColumn={s.caretPosition.column}
                ramUsage={s.appMemoryBytes > 0 ? `${(s.appMemoryBytes / (1024 * 1024)).toFixed(0)} MB` : ''}
            />

            <SharedDialogs />
        </div>
    );
}
