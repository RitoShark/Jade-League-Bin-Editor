import TitleBar from '../components/TitleBar';
import TabBar from '../components/TabBar';
import StatusBar from '../components/StatusBar';
import WelcomeScreen from '../components/WelcomeScreen';
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
            />

            <RibbonBar />

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

            <div className="word-shell-body">
                <WordSidePane />
                <div className="word-shell-doc">
                    {s.tabs.length === 0 && !s.fileLoading && (
                        <WelcomeScreen
                            onOpenFile={s.onOpen}
                            openFileDisabled={s.openFileDisabled}
                            recentFiles={s.recentFiles}
                            onOpenRecentFile={s.openFileFromPath}
                            onMaterialLibrary={s.onMaterialLibrary}
                            appIcon={s.appIcon}
                        />
                    )}
                    {s.tabs.length === 0 && s.fileLoading && <div className="file-loading-backdrop" />}
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
