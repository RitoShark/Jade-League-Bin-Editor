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
import TexHoverPopup from '../components/TexHoverPopup';
import EditorContextMenu from '../components/EditorContextMenu';
import SmokeOverlay from '../components/SmokeOverlay';
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

            <NewFileDialog
                isOpen={s.showNewFileDialog}
                onCancel={() => s.setShowNewFileDialog(false)}
                onCreate={s.handleCreateNewFile}
            />

            <SmokeOverlay active={s.cigaretteMode} />
        </>
    );
}
