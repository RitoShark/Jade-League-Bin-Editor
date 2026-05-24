import TitleBar from '../components/TitleBar';
import MenuBar from '../components/MenuBar';
import TabBar from '../components/TabBar';
import StatusBar from '../components/StatusBar';
import { WelcomeScreenWithExit } from '../components/WelcomeScreen';
import EditorPane from './EditorPane';
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

            {s.tabs.length > 0 && (
                s.splitMode ? (
                    // Split mode: two pane-filtered tab bars side by
                    // side. The split-toggle button lives only on
                    // the left bar so there's a single source of
                    // truth for the action. Drag-drop wires both
                    // bars together via `onTabSetPane`.
                    <div style={{ display: 'flex', flexDirection: 'row' }}>
                        <div
                            style={{
                                flex: `0 0 calc(${s.splitRatio * 100}% - 2px)`,
                                minWidth: 0,
                            }}
                        >
                            <TabBar
                                tabs={s.tabs}
                                activeTabId={s.leftActiveTabId}
                                onTabSelect={s.onTabSelect}
                                onTabClose={s.onTabClose}
                                onTabCloseAll={s.onTabCloseAll}
                                onTabPin={s.onTabPin}
                            onRevealInExplorer={s.revealInExplorer}
                                splitMode={s.splitMode}
                                onToggleSplit={() => s.setSplitMode(!s.splitMode)}
                                paneFilter="left"
                                onDropTabIntoPane={s.onTabSetPane}
                            />
                        </div>
                        {/* Spacer column matches the editor divider's
                            width so the bar split lines up with the
                            pane divider below. */}
                        <div style={{ flex: '0 0 4px' }} />
                        <div
                            style={{
                                flex: `0 0 calc(${(1 - s.splitRatio) * 100}% - 2px)`,
                                minWidth: 0,
                            }}
                        >
                            <TabBar
                                tabs={s.tabs}
                                activeTabId={s.rightActiveTabId}
                                onTabSelect={s.onTabSelect}
                                onTabClose={s.onTabClose}
                                onTabCloseAll={s.onTabCloseAll}
                                onTabPin={s.onTabPin}
                            onRevealInExplorer={s.revealInExplorer}
                                paneFilter="right"
                                onDropTabIntoPane={s.onTabSetPane}
                            />
                        </div>
                    </div>
                ) : (
                    <TabBar
                        tabs={s.tabs}
                        activeTabId={s.activeTabId}
                        onTabSelect={s.onTabSelect}
                        onTabClose={s.onTabClose}
                        onTabCloseAll={s.onTabCloseAll}
                        onTabPin={s.onTabPin}
                        onRevealInExplorer={s.revealInExplorer}
                        splitMode={s.splitMode}
                        onToggleSplit={() => s.setSplitMode(!s.splitMode)}
                        splitDisabled={s.tabs.length < 2}
                    />
                )
            )}

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

            {/* Wrapper takes flex:1 so the StatusBar stays pinned to the
                bottom even when EditorPane has no active tab to render
                (no welcome overlay, e.g. after "Continue without file"). */}
            <div className="vscode-editor-area">
                <EditorPane />
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
