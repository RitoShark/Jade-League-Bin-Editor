import TitleBar from '../components/TitleBar';
import StatusBar from '../components/StatusBar';
import { WelcomeScreenWithExit } from '../components/WelcomeScreen';
import RibbonBar from './RibbonBar';
import EditorPane from './EditorPane';
import SharedDialogs from './SharedDialogs';
import WordSidePane from './WordSidePane';
import { useShell } from './ShellContext';
import './Dock.css';
import './WordShell.css';

/**
 * Word-style shell — title bar, ribbon, document tab strip, page-style
 * editor surface with breathing room around it, optional left task pane
 * for active tools, status bar.
 */
export default function WordShell() {
    const s = useShell();

    const welcomeVisible = s.welcomeOverride === 'force'
        || (s.welcomeOverride !== 'hide' && s.tabs.length === 0);

    return (
        <div className={`app-container word-shell ${s.isDragging ? 'dragging' : ''}`}>
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
                wordMode
                tabs={s.tabs}
                activeTabId={s.activeTabId}
                onTabSelect={s.onTabSelect}
                onTabClose={s.onTabClose}
                onSave={s.onSave}
                onUndo={s.onUndo}
                onRedo={s.onRedo}
            />

            <RibbonBar />

            <div className="word-shell-body">
                <WordSidePane />
                <div className="word-shell-doc">
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
                    <EditorPane />
                </div>
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
