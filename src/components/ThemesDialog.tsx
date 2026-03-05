import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    THEMES,
    SYNTAX_THEME_OPTIONS,
    getTheme,
    getSyntaxColors,
    getBracketColors,
    type ThemeColors
} from '../lib/themes';
import { applyTheme, applyRoundedCorners, applyModernUI, applyCustomBackground } from '../lib/themeApplicator';
import { PaletteIcon, SparklesIcon, EyeIcon, ImageIcon, SettingsIcon } from './Icons';
import './ThemesDialog.css';

interface ThemesDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onThemeApplied?: (themeId: string) => void;
}

interface CustomTheme {
    windowBg: string;
    editorBg: string;
    titleBar: string;
    statusBar: string;
    text: string;
    tabBg: string;
    selectedTab: string;
}

type NavSection = 'ui' | 'syntax' | 'preview' | 'background' | 'options';

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ReactNode }[] = [
    { id: 'ui',         label: 'UI Theme',      icon: <PaletteIcon size={15} />  },
    { id: 'syntax',     label: 'Syntax Colors',  icon: <SparklesIcon size={15} /> },
    { id: 'preview',    label: 'Live Preview',   icon: <EyeIcon size={15} />     },
    { id: 'background', label: 'Background',     icon: <ImageIcon size={15} />   },
    { id: 'options',    label: 'Options',         icon: <SettingsIcon size={15} />},
];

export default function ThemesDialog({ isOpen, onClose, onThemeApplied }: ThemesDialogProps) {
    const [activeSection, setActiveSection] = useState<NavSection>('ui');
    const [selectedTheme, setSelectedTheme] = useState('Default');
    const [selectedSyntaxTheme, setSelectedSyntaxTheme] = useState('Default');
    const [useCustomTheme, setUseCustomTheme] = useState(false);
    const [overrideSyntax, setOverrideSyntax] = useState(false);
    const [roundedCorners, setRoundedCorners] = useState(true);
    const [modernUI, setModernUI] = useState(true);
    const [cigaretteMode, setCigaretteMode] = useState(false);
    const [useCustomBackground, setUseCustomBackground] = useState(false);
    const [customBackgroundImage, setCustomBackgroundImage] = useState('');
    const [customBackgroundName, setCustomBackgroundName] = useState('');
    const [customBackgroundBlur, setCustomBackgroundBlur] = useState(8);
    const backgroundInputRef = useRef<HTMLInputElement | null>(null);

    const [customTheme, setCustomTheme] = useState<CustomTheme>({
        windowBg: '#0F1928',
        editorBg: '#141E2D',
        titleBar: '#0F1928',
        statusBar: '#005A9E',
        text: '#D4D4D4',
        tabBg: '#1E1E1E',
        selectedTab: '#007ACC'
    });

    useEffect(() => {
        if (isOpen) loadPreferences();
    }, [isOpen]);

    const clampBlur = (value: number): number => Math.min(40, Math.max(0, value));

    const handleBackgroundFileSelected = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            alert('Please select an image file.');
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            alert('Please choose an image smaller than 8 MB.');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            if (!result.startsWith('data:image/')) {
                alert('Failed to read image data.');
                return;
            }
            setCustomBackgroundImage(result);
            setCustomBackgroundName(file.name);
            setUseCustomBackground(true);
        };
        reader.onerror = () => {
            alert('Failed to load image file.');
        };
        reader.readAsDataURL(file);
    };

    const handleClearBackgroundImage = () => {
        setCustomBackgroundImage('');
        setCustomBackgroundName('');
        setUseCustomBackground(false);
    };

    const loadPreferences = async () => {
        try {
            const theme      = await invoke<string>('get_preference', { key: 'Theme',         defaultValue: 'Default' });
            const syntaxTheme= await invoke<string>('get_preference', { key: 'SyntaxTheme',   defaultValue: 'Default' });
            const override   = await invoke<string>('get_preference', { key: 'OverrideSyntax',defaultValue: 'false'   });
            const useCustom  = await invoke<string>('get_preference', { key: 'UseCustomTheme',defaultValue: 'false'   });
            const rounded    = await invoke<string>('get_preference', { key: 'RoundedCorners',  defaultValue: 'true'  });
            const modern     = await invoke<string>('get_preference', { key: 'ModernUI',        defaultValue: 'true'  });
            const cigarette  = await invoke<string>('get_preference', { key: 'CigaretteMode',   defaultValue: 'false' });
            const useBackground = await invoke<string>('get_preference', { key: 'UseCustomBackgroundImage', defaultValue: 'false' });
            const backgroundImage = await invoke<string>('get_preference', { key: 'CustomBackgroundImage', defaultValue: '' });
            const backgroundName = await invoke<string>('get_preference', { key: 'CustomBackgroundImageName', defaultValue: '' });
            const backgroundBlurRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundBlur', defaultValue: '8' });

            setSelectedTheme(theme);
            setSelectedSyntaxTheme(syntaxTheme);
            setOverrideSyntax(override === 'true');
            setUseCustomTheme(useCustom === 'true');
            setRoundedCorners(rounded === 'true');
            setModernUI(modern !== 'false');
            setCigaretteMode(cigarette === 'true');
            setCustomBackgroundImage(backgroundImage);
            setCustomBackgroundName(backgroundName);
            setUseCustomBackground(useBackground === 'true' && backgroundImage.length > 0);
            {
                const parsedBlur = Number.parseInt(backgroundBlurRaw, 10);
                const blur = Number.isFinite(parsedBlur) ? clampBlur(parsedBlur) : 8;
                setCustomBackgroundBlur(blur);
            }

            if (useCustom === 'true') {
                const customBg          = await invoke<string>('get_preference', { key: 'Custom_Bg',          defaultValue: '#0F1928' });
                const customEditorBg    = await invoke<string>('get_preference', { key: 'Custom_EditorBg',    defaultValue: '#141E2D' });
                const customTitleBar    = await invoke<string>('get_preference', { key: 'Custom_TitleBar',    defaultValue: '#0F1928' });
                const customStatusBar   = await invoke<string>('get_preference', { key: 'Custom_StatusBar',   defaultValue: '#005A9E' });
                const customText        = await invoke<string>('get_preference', { key: 'Custom_Text',        defaultValue: '#D4D4D4' });
                const customTabBg       = await invoke<string>('get_preference', { key: 'Custom_TabBg',       defaultValue: '#1E1E1E' });
                const customSelectedTab = await invoke<string>('get_preference', { key: 'Custom_SelectedTab', defaultValue: '#007ACC' });
                setCustomTheme({ windowBg: customBg, editorBg: customEditorBg, titleBar: customTitleBar,
                    statusBar: customStatusBar, text: customText, tabBg: customTabBg, selectedTab: customSelectedTab });
            }
        } catch (error) {
            console.error('Failed to load theme preferences:', error);
        }
    };

    const handleApply = async () => {
        try {
            if (useCustomTheme) {
                await invoke('set_preference', { key: 'Custom_Bg',          value: customTheme.windowBg    });
                await invoke('set_preference', { key: 'Custom_EditorBg',    value: customTheme.editorBg    });
                await invoke('set_preference', { key: 'Custom_TitleBar',    value: customTheme.titleBar    });
                await invoke('set_preference', { key: 'Custom_StatusBar',   value: customTheme.statusBar   });
                await invoke('set_preference', { key: 'Custom_Text',        value: customTheme.text        });
                await invoke('set_preference', { key: 'Custom_TabBg',       value: customTheme.tabBg       });
                await invoke('set_preference', { key: 'Custom_SelectedTab', value: customTheme.selectedTab });
                await invoke('set_preference', { key: 'UseCustomTheme',     value: 'true'                  });
                await invoke('set_preference', { key: 'Theme',              value: 'Custom'                });
                applyTheme('Custom', customTheme);
            } else {
                await invoke('set_preference', { key: 'Theme',          value: selectedTheme  });
                await invoke('set_preference', { key: 'UseCustomTheme', value: 'false'        });
                applyTheme(selectedTheme);
            }

            await invoke('set_preference', { key: 'SyntaxTheme',   value: selectedSyntaxTheme        });
            await invoke('set_preference', { key: 'OverrideSyntax', value: overrideSyntax.toString() });
            await invoke('set_preference', { key: 'RoundedCorners', value: roundedCorners.toString()  });
            await invoke('set_preference', { key: 'ModernUI',       value: modernUI.toString()         });
            await invoke('set_preference', { key: 'CigaretteMode',  value: cigaretteMode.toString()    });
            await invoke('set_preference', { key: 'UseCustomBackgroundImage', value: (useCustomBackground && customBackgroundImage.length > 0).toString() });
            await invoke('set_preference', { key: 'CustomBackgroundImage', value: customBackgroundImage });
            await invoke('set_preference', { key: 'CustomBackgroundImageName', value: customBackgroundName });
            await invoke('set_preference', { key: 'CustomBackgroundBlur', value: String(customBackgroundBlur) });

            applyRoundedCorners(roundedCorners);
            applyModernUI(modernUI);
            applyCustomBackground({
                enabled: useCustomBackground && customBackgroundImage.length > 0,
                imageDataUrl: customBackgroundImage,
                blur: customBackgroundBlur
            });
            window.dispatchEvent(new CustomEvent('cigarette-mode-changed', { detail: cigaretteMode }));

            onThemeApplied?.(useCustomTheme ? 'Custom' : selectedTheme);
            alert('Theme applied successfully!');
        } catch (error) {
            console.error('Failed to save theme preferences:', error);
            alert('Failed to apply theme. Please try again.');
        }
    };

    const handleThemeSelect = (themeId: string) => {
        setSelectedTheme(themeId);
        if (!overrideSyntax) setSelectedSyntaxTheme(themeId);
    };

    const handleCustomThemeToggle = (checked: boolean) => {
        setUseCustomTheme(checked);
        if (checked && customTheme.windowBg === '#0F1928') {
            const theme = getTheme(selectedTheme);
            if (theme) {
                setCustomTheme({
                    windowBg: theme.windowBg, editorBg: theme.editorBg,
                    titleBar: theme.titleBar, statusBar: theme.statusBar,
                    text: theme.text, tabBg: theme.tabBg, selectedTab: theme.selectedTab
                });
            }
        }
    };

    const getCurrentDisplayTheme = (): ThemeColors | CustomTheme =>
        useCustomTheme ? customTheme : (getTheme(selectedTheme) || THEMES[0]);

    const currentTheme  = getCurrentDisplayTheme();
    const currentSyntax = getSyntaxColors(selectedSyntaxTheme);
    const currentBrackets = getBracketColors(selectedSyntaxTheme);

    if (!isOpen) return null;

    /* ── Section renderers ── */
    const renderUI = () => (
        <>
            <p className="current-theme">
                Current: <strong style={{ color: 'rgba(255,255,255,0.85)' }}>
                    {useCustomTheme ? 'Custom Theme' : (getTheme(selectedTheme)?.displayName || 'Unknown')}
                </strong>
            </p>

            <div className="section-header">
                <h4>Select Theme</h4>
                <label className="checkbox-label">
                    <input type="checkbox" checked={useCustomTheme}
                        onChange={e => handleCustomThemeToggle(e.target.checked)} />
                    Custom
                </label>
            </div>

            {!useCustomTheme ? (
                <div className="theme-list">
                    {THEMES.map(theme => (
                        <div
                            key={theme.id}
                            className={`theme-item${selectedTheme === theme.id ? ' selected' : ''}`}
                            onClick={() => handleThemeSelect(theme.id)}
                        >
                            <span>{theme.displayName}</span>
                            <div className="theme-preview-dots">
                                <div className="preview-dot" style={{ backgroundColor: theme.windowBg }} />
                                <div className="preview-dot" style={{ backgroundColor: theme.statusBar }} />
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="custom-theme-editor">
                    {([
                        ['Window Background', 'windowBg'],
                        ['Editor Background', 'editorBg'],
                        ['Title Bar',         'titleBar'],
                        ['Status Bar',        'statusBar'],
                        ['Foreground Text',   'text'],
                        ['Tab Background',    'tabBg'],
                        ['Selected Tab',      'selectedTab'],
                    ] as [string, keyof CustomTheme][]).map(([label, key]) => (
                        <div key={key} className="color-input-group">
                            <label>{label}</label>
                            <input type="color" value={customTheme[key]}
                                onChange={e => setCustomTheme({ ...customTheme, [key]: e.target.value })} />
                            <input type="text" value={customTheme[key]}
                                onChange={e => setCustomTheme({ ...customTheme, [key]: e.target.value })} />
                        </div>
                    ))}
                </div>
            )}
        </>
    );

    const renderSyntax = () => (
        <>
            <div className="section-header">
                <h4>Syntax Color Scheme</h4>
                <label className="checkbox-label">
                    <input type="checkbox" checked={overrideSyntax}
                        onChange={e => setOverrideSyntax(e.target.checked)} />
                    Override
                </label>
            </div>

            <div className="theme-list">
                {SYNTAX_THEME_OPTIONS.map(theme => (
                    <div
                        key={theme.id}
                        className={`theme-item${selectedSyntaxTheme === theme.id ? ' selected' : ''}`}
                        onClick={() => setSelectedSyntaxTheme(theme.id)}
                    >
                        <span>{theme.displayName}</span>
                        <div className="theme-preview-dots">
                            <div className="preview-dot" style={{ backgroundColor: getBracketColors(theme.id).color1 }} />
                            <div className="preview-dot" style={{ backgroundColor: getBracketColors(theme.id).color2 }} />
                        </div>
                    </div>
                ))}
            </div>
        </>
    );

    const renderPreview = () => (
        <div className="preview-column">
            <h4>Color Palette</h4>
            <div className="color-palette">
                {([
                    ['Window Background', 'windowBg'],
                    ['Editor Background', 'editorBg'],
                    ['Title Bar',         'titleBar'],
                    ['Status Bar',        'statusBar'],
                    ['Foreground Text',   'text'],
                    ['Tab Background',    'tabBg'],
                    ['Selected Tab',      'selectedTab'],
                ] as [string, keyof typeof currentTheme][]).map(([label, key]) => (
                    <div key={key} className="palette-item">
                        <div className="palette-color" style={{ backgroundColor: currentTheme[key] as string }} />
                        <span>{label}</span>
                    </div>
                ))}
            </div>

            <h5>Syntax Preview</h5>
            <div className="syntax-preview" style={{ backgroundColor: currentTheme.editorBg, color: currentTheme.text }}>
                <pre>
                    <code>
                        <span style={{ color: currentBrackets.color1 }}>{'{'}</span>{'\n'}
                        {'  '}<span style={{ color: currentSyntax.comment }}># This is a comment</span>{'\n'}
                        {'  '}<span style={{ color: currentSyntax.propertyColor }}>skinScale</span> : <span style={{ color: currentSyntax.keyword }}>f32</span> = <span style={{ color: currentSyntax.number }}>1.0</span>{'\n'}
                        {'  '}<span style={{ color: currentSyntax.propertyColor }}>name</span> : <span style={{ color: currentSyntax.keyword }}>string</span> = <span style={{ color: currentSyntax.stringColor }}>"Example"</span>{'\n'}
                        {'  '}<span style={{ color: currentBrackets.color2 }}>{'['}</span>{'\n'}
                        {'    '}<span style={{ color: currentSyntax.number }}>i32</span> <span style={{ color: currentBrackets.color3 }}>(</span> <span style={{ color: currentSyntax.stringColor }}>"value"</span> <span style={{ color: currentBrackets.color3 }}>)</span>{'\n'}
                        {'  '}<span style={{ color: currentBrackets.color2 }}>{']'}</span>{'\n'}
                        <span style={{ color: currentBrackets.color1 }}>{'}'}</span>
                    </code>
                </pre>
            </div>
        </div>
    );

    const renderBackground = () => (
        <>
            <h2 className="themes-section-title">Background Image</h2>
            <p className="themes-section-subtitle">
                Use your own image behind the app. When enabled, top ribbons and bars switch to neutral glass.
            </p>

            <div className="themes-options background-options">
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={useCustomBackground}
                        onChange={e => setUseCustomBackground(e.target.checked)}
                        disabled={!customBackgroundImage}
                    />
                    <span>
                        <strong>Enable custom image background</strong>
                        <span style={{ display: 'block', fontSize: 11, opacity: 0.55, fontWeight: 400 }}>
                            Disable this to restore normal theme-colored bars.
                        </span>
                    </span>
                </label>

                <div className="background-file-row">
                    <input
                        ref={backgroundInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleBackgroundFileSelected}
                        style={{ display: 'none' }}
                    />
                    <button
                        className="background-action-btn"
                        onClick={() => backgroundInputRef.current?.click()}
                    >
                        Choose image
                    </button>
                    <button
                        className="background-action-btn"
                        onClick={handleClearBackgroundImage}
                        disabled={!customBackgroundImage}
                    >
                        Clear
                    </button>
                    <span className="background-file-name">
                        {customBackgroundName || 'No image selected'}
                    </span>
                </div>

                <div className="background-slider-row">
                    <label htmlFor="background-blur-slider">
                        Blur strength: <strong>{customBackgroundBlur}px</strong>
                    </label>
                    <input
                        id="background-blur-slider"
                        type="range"
                        min={0}
                        max={40}
                        step={1}
                        value={customBackgroundBlur}
                        onChange={e => {
                            const parsed = Number.parseInt(e.target.value, 10);
                            setCustomBackgroundBlur(clampBlur(Number.isFinite(parsed) ? parsed : 0));
                        }}
                        disabled={!customBackgroundImage}
                    />
                </div>

                <div className="background-preview">
                    {customBackgroundImage ? (
                        <>
                            <img
                                src={customBackgroundImage}
                                className="background-preview-sizer"
                                alt=""
                            />
                            <div
                                className="background-preview-image"
                                style={{
                                    backgroundImage: `url(${customBackgroundImage})`,
                                    filter: `blur(${customBackgroundBlur}px)`,
                                }}
                            />
                        </>
                    ) : (
                        <div className="background-preview-empty">Image preview</div>
                    )}
                </div>
            </div>
        </>
    );

    const renderOptions = () => (
        <>
            <h2 className="themes-section-title">Display Options</h2>
            <p className="themes-section-subtitle">Control the visual style of the application.</p>

            <div className="themes-options" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
                <label className="checkbox-label">
                    <input type="checkbox" checked={modernUI}
                        onChange={e => setModernUI(e.target.checked)} />
                    <span>
                        <strong>Modern UI</strong>
                        <span style={{ display: 'block', fontSize: 11, opacity: 0.5, fontWeight: 400 }}>
                            Quartz-inspired glass morphism — frosted panels, glows and gradients
                        </span>
                    </span>
                </label>
                <label className="checkbox-label">
                    <input type="checkbox" checked={roundedCorners}
                        onChange={e => setRoundedCorners(e.target.checked)} />
                    <span>
                        <strong>Rounded Corners</strong>
                        <span style={{ display: 'block', fontSize: 11, opacity: 0.5, fontWeight: 400 }}>
                            Apply rounded corners to panels and buttons
                        </span>
                    </span>
                </label>
                <label className="checkbox-label">
                    <input type="checkbox" checked={cigaretteMode}
                        onChange={e => setCigaretteMode(e.target.checked)} />
                    <span>
                        <strong>Cigarette Mode</strong>
                    </span>
                </label>
            </div>
        </>
    );

    const sectionContent: Record<NavSection, () => React.ReactElement> = {
        ui:      renderUI,
        syntax:  renderSyntax,
        preview: renderPreview,
        background: renderBackground,
        options: renderOptions,
    };

    return (
        <div className="themes-dialog-overlay" onClick={onClose}>
            <div className="themes-dialog" onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div className="themes-dialog-header">
                    <h2>Jade Themes</h2>
                    <button className="close-button" onClick={onClose}>×</button>
                </div>

                {/* Body */}
                <div className="themes-body">
                    {/* Sidebar */}
                    <nav className="themes-sidebar">
                        {NAV_ITEMS.map(item => (
                            <div
                                key={item.id}
                                className={`themes-nav-item${activeSection === item.id ? ' active' : ''}`}
                                onClick={() => setActiveSection(item.id)}
                            >
                                <span className="themes-nav-icon">{item.icon}</span>
                                {item.label}
                            </div>
                        ))}
                    </nav>

                    {/* Content */}
                    <div className="themes-content">
                        {sectionContent[activeSection]()}
                    </div>
                </div>

                {/* Footer */}
                <div className="themes-dialog-footer">
                    <button className="btn-apply" onClick={handleApply}>Apply</button>
                    <button className="btn-close" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
