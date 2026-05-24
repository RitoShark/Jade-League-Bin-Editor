import React, { useState } from 'react';
import './SettingsDialog.css';

/** Mirrors the main SettingsDialog's chrome (sidebar + content panes) so
 *  Extraction settings have somewhere to grow. Only one section today —
 *  "General" — but the layout is built to slot more in (Performance,
 *  Output naming, etc.) without restructuring. */
export type ExtractMode = 'structure' | 'flat';

interface ExtractionSettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
    useRenamePattern: boolean;
    onUseRenamePatternChange: (next: boolean) => void;
    autoCheckOnClick: boolean;
    onAutoCheckOnClickChange: (next: boolean) => void;
    extractMode: ExtractMode;
    onExtractModeChange: (next: ExtractMode) => void;
    makeWadFolder: boolean;
    onMakeWadFolderChange: (next: boolean) => void;
    useDefaultLocation: boolean;
    onUseDefaultLocationChange: (next: boolean) => void;
    defaultLocation: string;
    onPickDefaultLocation: () => void;
    /** Folder name inserted directly under `assets/` and `data/`
     *  when the Viewer's (or Extractor's) "repath" checkbox is on.
     *  Empty string disables repathing even with the checkbox set. */
    repathPrefix: string;
    onRepathPrefixChange: (next: string) => void;
}

type NavSection = 'general';

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ReactNode }[] = [
    {
        id: 'general',
        label: 'General',
        icon: (
            <svg
                width={15}
                height={15}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M21 15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
        ),
    },
];

const ExtractionSettingsDialog: React.FC<ExtractionSettingsDialogProps> = ({
    isOpen,
    onClose,
    useRenamePattern,
    onUseRenamePatternChange,
    autoCheckOnClick,
    onAutoCheckOnClickChange,
    extractMode,
    onExtractModeChange,
    makeWadFolder,
    onMakeWadFolderChange,
    useDefaultLocation,
    onUseDefaultLocationChange,
    defaultLocation,
    onPickDefaultLocation,
    repathPrefix,
    onRepathPrefixChange,
}) => {
    const [activeSection, setActiveSection] = useState<NavSection>('general');

    if (!isOpen) return null;

    const renderGeneral = () => (
        <>
            <h2 className="settings-section-title">Extraction</h2>
            <p className="settings-section-subtitle">
                How Jade writes extracted files to disk.
            </p>

            <h3 className="settings-section-title" style={{ fontSize: 16 }}>Output layout</h3>
            <p className="settings-section-subtitle">
                Whether extracted files keep the WAD's folder tree or land directly in the target.
            </p>

            <RadioRow
                label="Preserve structure"
                description="Recreate the WAD's full directory tree on disk — the default Quartz-style layout."
                checked={extractMode === 'structure'}
                groupName="extract-mode"
                onSelect={() => onExtractModeChange('structure')}
            />
            <RadioRow
                label="Per file (flat)"
                description={
                    <>
                        Drop every extracted file straight into the target folder with no
                        sub-directories. Best when picking just one or two files. Files with
                        the same name overwrite each other.
                    </>
                }
                checked={extractMode === 'flat'}
                groupName="extract-mode"
                onSelect={() => onExtractModeChange('flat')}
            />

            <ToggleRow
                label="Create WAD-name folder"
                description={
                    <>
                        Nest the structure under a folder named after the WAD — e.g.
                        <code>aatrox/assets/…</code>. Disable to extract the WAD's top-level
                        folders straight into the target. Only applies when preserving structure.
                    </>
                }
                checked={makeWadFolder}
                disabled={extractMode !== 'structure'}
                onChange={onMakeWadFolderChange}
            />

            <div className="settings-row">
                <div className="settings-row-header">
                    <span className="settings-row-title">Default extraction location</span>
                    <label className="settings-toggle">
                        <input
                            type="checkbox"
                            checked={useDefaultLocation}
                            onChange={e => onUseDefaultLocationChange(e.target.checked)}
                        />
                        <span className="settings-toggle-track" />
                    </label>
                </div>
                <p className="settings-row-desc">
                    Skip the "pick a folder" dialog and extract straight to a fixed location.
                    Defaults to <code>Documents/Jade Exports</code>.
                </p>
                {useDefaultLocation && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                        <input
                            className="settings-select"
                            type="text"
                            readOnly
                            value={defaultLocation}
                            placeholder="No location set"
                            title={defaultLocation}
                            style={{ flex: 1, minWidth: 0 }}
                        />
                        <button
                            type="button"
                            className="action-button gray"
                            onClick={onPickDefaultLocation}
                        >
                            Change…
                        </button>
                    </div>
                )}
            </div>

            <ToggleRow
                label="Fast overwrite"
                description={
                    <>
                        Writes each chunk to a temp file (<code>.jdtmp</code>) then atomically
                        renames it over the target. Re-extracts into a populated folder finish in
                        roughly the same time as a fresh extract. Disable for a classic in-place
                        overwrite (slower on NTFS, but never leaves <code>.jdtmp</code> files
                        behind on cancel).
                    </>
                }
                checked={useRenamePattern}
                onChange={onUseRenamePatternChange}
            />

            <ToggleRow
                label="Auto-check on click"
                description={
                    <>
                        Clicking a file inside a WAD adds it to the extraction queue (and clicking
                        a queued file removes it). Disable to require checkbox clicks — clicking
                        a row will only update the preview, never touch selection.
                    </>
                }
                checked={autoCheckOnClick}
                onChange={onAutoCheckOnClickChange}
            />

            <div className="settings-row">
                <div className="settings-row-header">
                    <span className="settings-row-title">Repath prefix</span>
                </div>
                <p className="settings-row-desc">
                    When the "Re-path" checkbox is on, this folder name gets inserted directly
                    under <code>assets/</code> and <code>data/</code> in the extracted tree — e.g.
                    <code>assets/{repathPrefix || 'jade'}/characters/…</code>. BIN strings are
                    rewritten in lockstep so the resulting mod stays consistent.
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                    <input
                        className="settings-select"
                        type="text"
                        value={repathPrefix}
                        onChange={e => onRepathPrefixChange(e.target.value)}
                        placeholder="jade"
                        spellCheck={false}
                        style={{ flex: 1, minWidth: 0 }}
                    />
                </div>
            </div>
        </>
    );

    const sectionContent: Record<NavSection, () => React.ReactNode> = {
        general: renderGeneral,
    };

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div
                className="settings-modal"
                onClick={e => e.stopPropagation()}
            >
                <div className="settings-header">
                    <div className="settings-header-left">
                        <h2>Extraction Settings</h2>
                        <p>Tweaks specific to the WAD extraction flow</p>
                    </div>
                    <button className="settings-close-btn" onClick={onClose}>&times;</button>
                </div>

                <div className="settings-body">
                    <nav className="settings-sidebar">
                        {NAV_ITEMS.map(item => (
                            <div
                                key={item.id}
                                className={`settings-nav-item${activeSection === item.id ? ' active' : ''}`}
                                onClick={() => setActiveSection(item.id)}
                            >
                                <span className="settings-nav-icon">{item.icon}</span>
                                {item.label}
                            </div>
                        ))}
                    </nav>

                    <div className="settings-content">
                        {sectionContent[activeSection]()}
                    </div>
                </div>

                <div className="settings-footer">
                    <button className="action-button gray" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
};

/** Local copy of the same toggle component the main SettingsDialog uses
 *  — keeping it inline here so Extraction settings can ship without
 *  depending on the main dialog's internals. Uses the shared CSS classes. */
function ToggleRow({
    label, description, checked, disabled, onChange,
}: {
    label: string;
    description?: React.ReactNode;
    checked: boolean;
    disabled?: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <div className="settings-row">
            <div className="settings-row-header">
                <span className="settings-row-title">{label}</span>
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={e => onChange(e.target.checked)}
                    />
                    <span className="settings-toggle-track" />
                </label>
            </div>
            {description && <p className="settings-row-desc">{description}</p>}
        </div>
    );
}

/** Radio-style row — same chrome as ToggleRow but participates in a
 *  named radio group so the options are mutually exclusive. */
function RadioRow({
    label, description, checked, groupName, onSelect,
}: {
    label: string;
    description?: React.ReactNode;
    checked: boolean;
    groupName: string;
    onSelect: () => void;
}) {
    return (
        <div className="settings-row">
            <div className="settings-row-header">
                <span className="settings-row-title">{label}</span>
                <label className="settings-toggle">
                    <input
                        type="radio"
                        name={groupName}
                        checked={checked}
                        onChange={onSelect}
                    />
                    <span className="settings-toggle-track" />
                </label>
            </div>
            {description && <p className="settings-row-desc">{description}</p>}
        </div>
    );
}

export default ExtractionSettingsDialog;
