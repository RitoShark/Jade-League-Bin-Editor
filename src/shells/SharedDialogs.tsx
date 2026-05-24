import { invoke } from '@tauri-apps/api/core';
import AboutDialog from '../components/AboutDialog';
import ThemesDialog from '../components/ThemesDialog';
import MaterialLibraryBrowser from '../components/MaterialLibraryBrowser';
import SettingsDialog from '../components/SettingsDialog';
import PreferencesDialog from '../components/PreferencesDialog';
import ParticleEditorDialog from '../components/ParticleEditorDialog';
import UpdateToast from '../components/UpdateToast';
import HashSyncToast from '../components/HashSyncToast';
import FileLoadingToast from '../components/FileLoadingToast';
import NewFileDialog from '../components/NewFileDialog';
import QuartzInstallModal from '../components/QuartzInstallModal';
import CompareFilesPicker from '../components/CompareFilesPicker';
import AssetGalleryDialog from '../components/AssetGalleryDialog';
import TexHoverPopup from '../components/TexHoverPopup';
import EditorContextMenu from '../components/EditorContextMenu';
import SmokeOverlay from '../components/SmokeOverlay';
import JamesOverlay from '../components/JamesOverlay';
import GuideOverlay from '../components/GuideOverlay';
import { useShell } from './ShellContext';

/**
 * Modal dialogs, toasts, and overlays that are identical across every
 * shell. Each shell renders this once at the bottom of its tree.
 */
export default function SharedDialogs() {
    const s = useShell();
    const { activeTab } = s;

    return (
        <>
            {s.ctxMenu && (
                <EditorContextMenu
                    x={s.ctxMenu.x}
                    y={s.ctxMenu.y}
                    onClose={() => s.setCtxMenu(null)}
                    onCut={s.onCut}
                    onCopy={s.onCopy}
                    onPaste={s.onPaste}
                    onSelectAll={s.onSelectAll}
                    onFoldEmitters={s.foldAllEmitters}
                    onUnfoldEmitters={s.unfoldAllEmitters}
                    hasEmitters={s.hasEmitters()}
                />
            )}

            {s.texPopup && (
                <TexHoverPopup
                    top={s.texPopup.top}
                    left={s.texPopup.left}
                    above={s.texPopup.above}
                    rawPath={s.texPopup.rawPath}
                    resolvedPath={s.texPopup.resolvedPath}
                    imageDataUrl={s.texPopup.imageDataUrl}
                    texWidth={s.texPopup.texWidth}
                    texHeight={s.texPopup.texHeight}
                    formatName={s.texPopup.formatStr}
                    error={s.texPopup.error}
                    onOpenFull={s.handleTexOpenFull}
                    onEditImage={() => s.handleTexEditImage(s.texPopup!.resolvedPath)}
                    onShowInExplorer={() => s.handleTexShowInExplorer(s.texPopup!.resolvedPath)}
                    onClose={s.closeTexPopup}
                    onMouseEnter={() => { s.isOverTexPopupRef.current = true; }}
                    onMouseLeave={() => { s.isOverTexPopupRef.current = false; }}
                />
            )}

            <AboutDialog
                isOpen={s.showAboutDialog}
                onClose={() => s.setShowAboutDialog(false)}
                onRestartGuide={() => {
                    invoke('set_preference', { key: 'GuideCompleted', value: 'False' }).catch(() => {});
                    // The guide's first steps point at the welcome screen, so
                    // force it open — the user may be restarting from inside
                    // the editor where the rail / quick-actions don't exist.
                    s.setWelcomeOverride('force');
                    s.setShowGuideOverlay(true);
                }}
            />

            <ThemesDialog
                isOpen={s.showThemesDialog}
                onClose={() => s.setShowThemesDialog(false)}
                onThemeApplied={s.handleThemeApplied}
            />

            {s.showMaterialLibrary && (
                <MaterialLibraryBrowser
                    onClose={() => s.setShowMaterialLibrary(false)}
                />
            )}

            <SettingsDialog
                isOpen={s.showSettingsDialog}
                onClose={() => s.setShowSettingsDialog(false)}
            />

            <PreferencesDialog
                isOpen={s.showPreferencesDialog}
                onClose={() => s.setShowPreferencesDialog(false)}
                onEmitterHintsChange={(enabled) => {
                    s.emitterHintsEnabled.current = enabled;
                    if (s.editorRef.current) s.updateEmitterNameDecorations(s.editorRef.current);
                }}
                onSyntaxCheckingChange={(enabled) => {
                    s.syntaxCheckingEnabled.current = enabled;
                    if (s.editorRef.current) s.updateSyntaxMarkers(s.editorRef.current);
                }}
            />

            {s.updateToastVersion && (
                <UpdateToast
                    version={s.updateToastVersion}
                    onOpenSettings={() => s.setShowSettingsDialog(true)}
                    onDismiss={() => s.setUpdateToastVersion(null)}
                />
            )}

            {s.fileLoading && (
                <FileLoadingToast fileName={s.fileLoading.name} detail={s.fileLoading.detail} />
            )}

            {s.hashSyncToast?.visible && (
                <HashSyncToast
                    status={s.hashSyncToast.status}
                    message={s.hashSyncToast.message}
                    onDismiss={() => {
                        if (s.hashToastHideTimeoutRef.current) {
                            clearTimeout(s.hashToastHideTimeoutRef.current);
                            s.hashToastHideTimeoutRef.current = null;
                        }
                        s.hashToastDismissedRef.current = true;
                        s.setHashSyncToast(null);
                    }}
                />
            )}

            {activeTab && s.isEditorTab(activeTab) && s.particleDialogOpen && (
                <ParticleEditorDialog
                    isOpen={s.particleDialogOpen}
                    onClose={() => s.setParticleDialogOpen(false)}
                    editorContent={s.editorRef.current?.getValue() || activeTab.content}
                    onContentChange={s.handleGeneralEditContentChange}
                    onScrollToLine={s.handleScrollToLine}
                    onStatusUpdate={s.setStatusMessage}
                />
            )}

            <QuartzInstallModal
                isOpen={s.showQuartzInstallModal}
                onClose={() => s.setShowQuartzInstallModal(false)}
                onDownload={async () => {
                    try {
                        await invoke('open_url', { url: 'https://github.com/LeagueToolkit/Quartz/releases' });
                    } catch {
                        window.open('https://github.com/LeagueToolkit/Quartz/releases', '_blank', 'noopener,noreferrer');
                    }
                }}
            />

            {s.assetGalleryTabId && (() => {
                const tab = s.tabs.find(t => t.id === s.assetGalleryTabId);
                if (!tab) return null;
                // Prefer the live editor value so user edits to the
                // .md report (e.g. removing entries before review) are
                // reflected in the gallery.
                const liveContent = s.editorRef.current?.getValue();
                const content = (s.activeTabId === tab.id && liveContent) || tab.content || '';
                return (
                    <AssetGalleryDialog
                        content={content}
                        baseFile={tab.filePath}
                        onClose={() => s.setAssetGalleryTabId(null)}
                    />
                );
            })()}

            {s.comparePicker && (
                <CompareFilesPicker
                    editorTabs={s.tabs.filter(t => (t.tabType ?? 'editor') === 'editor')}
                    initialLeftId={s.comparePicker.leftId}
                    initialRightId={s.comparePicker.rightId}
                    onCancel={() => s.setComparePicker(null)}
                    onConfirm={(leftId, rightId) => {
                        s.setComparePicker(null);
                        s.openCompareTab(leftId, rightId);
                    }}
                />
            )}

            <NewFileDialog
                isOpen={s.showNewFileDialog}
                onCancel={() => s.setShowNewFileDialog(false)}
                onCreate={s.handleCreateNewFile}
            />

            <SmokeOverlay active={s.cigaretteMode} />
            <JamesOverlay active={s.jamesMode} />
            {s.showGuideOverlay && (
                <GuideOverlay onDone={() => s.setShowGuideOverlay(false)} />
            )}
        </>
    );
}
