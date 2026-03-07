import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './PreferencesDialog.css';

interface PreferencesDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onEmitterHintsChange?: (enabled: boolean) => void;
}

interface ImageEditorStatus {
    paintnet: boolean;
    photoshop: boolean;
    gimp: boolean;
}

const PreferencesDialog: React.FC<PreferencesDialogProps> = ({ isOpen, onClose, onEmitterHintsChange }) => {
    const [importLinkedBins, setImportLinkedBins] = useState(false);
    const [recursiveLinkedBins, setRecursiveLinkedBins] = useState(false);
    const [useQuartzPyWorkflow, setUseQuartzPyWorkflow] = useState(false);
    const [emitterNameHints, setEmitterNameHints] = useState(true);
    const [texEditorApp, setTexEditorApp] = useState<string>('default');
    const [imageEditors, setImageEditors] = useState<ImageEditorStatus>({
        paintnet: false,
        photoshop: false,
        gimp: false,
    });

    useEffect(() => {
        if (isOpen) {
            loadPreferences();
        }
    }, [isOpen]);

    const loadPreferences = async () => {
        try {
            const importLinked = await invoke<string>('get_preference', {
                key: 'ImportLinkedBins',
                defaultValue: 'False',
            });
            setImportLinkedBins(importLinked === 'True');

            const recursiveLinked = await invoke<string>('get_preference', {
                key: 'RecursiveLinkedBins',
                defaultValue: 'False',
            });
            setRecursiveLinkedBins(recursiveLinked === 'True');

            const quartzPyWorkflow = await invoke<string>('get_preference', {
                key: 'UseQuartzPyWorkflow',
                defaultValue: 'False',
            });
            setUseQuartzPyWorkflow(quartzPyWorkflow === 'True');

            const texEditor = await invoke<string>('get_preference', {
                key: 'TexEditorApp',
                defaultValue: 'default',
            });
            setTexEditorApp(texEditor);

            const emitterHints = await invoke<string>('get_preference', {
                key: 'EmitterNameHints',
                defaultValue: 'True',
            });
            setEmitterNameHints(emitterHints !== 'False');

            const editors = await invoke<ImageEditorStatus>('detect_image_editors');
            setImageEditors(editors);
        } catch (e) {
            console.error('Failed to load preferences', e);
        }
    };

    const savePreference = async (key: string, value: string) => {
        try {
            await invoke('set_preference', { key, value });
        } catch (e) {
            console.error(`Failed to save ${key}`, e);
        }
    };

    const handleImportLinkedBinsChange = (checked: boolean) => {
        setImportLinkedBins(checked);
        savePreference('ImportLinkedBins', checked ? 'True' : 'False');
        if (!checked && recursiveLinkedBins) {
            setRecursiveLinkedBins(false);
            savePreference('RecursiveLinkedBins', 'False');
        }
    };

    const handleRecursiveLinkedBinsChange = (checked: boolean) => {
        setRecursiveLinkedBins(checked);
        savePreference('RecursiveLinkedBins', checked ? 'True' : 'False');
    };

    const handleTexEditorChange = (value: string) => {
        setTexEditorApp(value);
        savePreference('TexEditorApp', value);
    };

    const handleQuartzPyWorkflowChange = (checked: boolean) => {
        setUseQuartzPyWorkflow(checked);
        savePreference('UseQuartzPyWorkflow', checked ? 'True' : 'False');
    };

    const handleEmitterNameHintsChange = (checked: boolean) => {
        setEmitterNameHints(checked);
        savePreference('EmitterNameHints', checked ? 'True' : 'False');
        onEmitterHintsChange?.(checked);
    };

    if (!isOpen) return null;

    const editorOptions: { value: string; label: string; available: boolean }[] = [
        { value: 'default', label: 'System Default', available: true },
        { value: 'paintnet', label: 'Paint.NET', available: imageEditors.paintnet },
        { value: 'photoshop', label: 'Adobe Photoshop', available: imageEditors.photoshop },
        { value: 'gimp', label: 'GIMP', available: imageEditors.gimp },
    ];

    return (
        <div className="preferences-overlay" onClick={onClose}>
            <div className="preferences-modal" onClick={(e) => e.stopPropagation()}>
                <div className="preferences-header">
                    <h2>Preferences</h2>
                    <p>Configure your experience</p>
                </div>

                <div className="preferences-content">
                    {/* Import Linked Bin Files Option */}
                    <div className="preference-group">
                        <label className="preference-checkbox">
                            <input
                                type="checkbox"
                                checked={importLinkedBins}
                                onChange={(e) => handleImportLinkedBinsChange(e.target.checked)}
                            />
                            <span className="checkbox-label">Import Linked Bin Files</span>
                        </label>
                        <p className="preference-description">
                            When enabled, opening a bin file will automatically open all linked bin files found in the DATA folder.
                        </p>

                        <label className={`preference-checkbox sub-option ${!importLinkedBins ? 'disabled' : ''}`}>
                            <input
                                type="checkbox"
                                checked={recursiveLinkedBins}
                                onChange={(e) => handleRecursiveLinkedBinsChange(e.target.checked)}
                                disabled={!importLinkedBins}
                            />
                            <span className="checkbox-label">Also load files linked inside imported files</span>
                        </label>
                        <p className="preference-description sub-description">
                            Recursively opens linked files from within the imported linked files (may open many tabs).
                        </p>
                    </div>

                    <div className="preference-group">
                        <label className="preference-checkbox">
                            <input
                                type="checkbox"
                                checked={useQuartzPyWorkflow}
                                onChange={(e) => handleQuartzPyWorkflowChange(e.target.checked)}
                            />
                            <span className="checkbox-label">Quartz-style .py sidecar workflow</span>
                        </label>
                        <p className="preference-description">
                            Keeps an adjacent .py text copy for each opened .bin and uses it when available, matching Quartz's fake .py flow.
                        </p>
                    </div>

                    <div className="preference-group">
                        <label className="preference-checkbox">
                            <input
                                type="checkbox"
                                checked={emitterNameHints}
                                onChange={(e) => handleEmitterNameHintsChange(e.target.checked)}
                            />
                            <span className="checkbox-label">Show Emitter Name Hints</span>
                        </label>
                        <p className="preference-description">
                            Displays emitter names inline next to collapsed VfxEmitterDefinitionData blocks in the editor.
                        </p>
                    </div>

                    {/* Texture Image Editor */}
                    <div className="preference-group">
                        <div className="preference-row">
                            <span className="checkbox-label">Texture Image Editor</span>
                        </div>
                        <p className="preference-description" style={{ marginLeft: 0, marginBottom: 10 }}>
                            Application used when clicking "Edit Image" on a texture preview. Grayed-out options were not detected on this machine.
                        </p>
                        <select
                            className="preference-select"
                            value={texEditorApp}
                            onChange={(e) => handleTexEditorChange(e.target.value)}
                        >
                            {editorOptions.map((opt) => (
                                <option
                                    key={opt.value}
                                    value={opt.value}
                                    disabled={!opt.available}
                                >
                                    {opt.label}{!opt.available && opt.value !== 'default' ? ' (not detected)' : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                <div className="preferences-footer">
                    <button className="action-button gray" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PreferencesDialog;
