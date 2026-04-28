import { useState, useEffect, useRef, useCallback, type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import FontPicker from './FontPicker';
import {
    THEMES,
    PRESET_FONTS,
    SYNTAX_THEME_OPTIONS,
    getTheme,
    getSyntaxColors,
    getBracketColors,
    type ThemeColors,
    type SyntaxColors,
    type BracketColors,
    type FontLibraryEntry,
} from '../lib/themes';
import {
    applyTheme, applyRoundedCorners, applyModernUI, applyCustomBackground,
    applyUIFont, injectFontFaces, fontFileNameToFamily,
    ensurePresetFontLoaded, preloadBundledFonts,
} from '../lib/themeApplicator';
import { PaletteIcon, SparklesIcon, ImageIcon, SettingsIcon, TypeIcon, FontSourceWindowsIcon, FontSourceBundledIcon, FontSourceImportedIcon } from './Icons';
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

type NavSection = 'ui' | 'syntax' | 'background' | 'options' | 'fonts';

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ReactNode }[] = [
    { id: 'ui',         label: 'UI Theme',      icon: <PaletteIcon size={15} />  },
    { id: 'syntax',     label: 'Syntax Colors',  icon: <SparklesIcon size={15} /> },
    { id: 'background', label: 'Background',     icon: <ImageIcon size={15} />   },
    { id: 'fonts',      label: 'Fonts',          icon: <TypeIcon size={15} />    },
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
    const [useThemeBackground, setUseThemeBackground] = useState(true);
    const [themeBgBlur, setThemeBgBlur] = useState(4);
    const [customBackgroundImage, setCustomBackgroundImage] = useState('');
    const [customBackgroundName, setCustomBackgroundName] = useState('');
    const [customBackgroundBlur, setCustomBackgroundBlur] = useState(8);
    const [customBackgroundBrightness, setCustomBackgroundBrightness] = useState(100);
    const [customBackgroundSaturation, setCustomBackgroundSaturation] = useState(100);
    const [customBackgroundOpacity, setCustomBackgroundOpacity] = useState(100);
    const [customBackgroundVignette, setCustomBackgroundVignette] = useState(0);
    const [customBackgroundPosX, setCustomBackgroundPosX] = useState(50);
    const [customBackgroundPosY, setCustomBackgroundPosY] = useState(50);
    const [customBackgroundZoom, setCustomBackgroundZoom] = useState(1);
    const [bgImageSize, setBgImageSize] = useState<{ w: number; h: number } | null>(null);
    const backgroundInputRef = useRef<HTMLInputElement | null>(null);
    const viewportPickerRef = useRef<HTMLDivElement | null>(null);
    const uiPreviewRef = useRef<HTMLIFrameElement | null>(null);
    const uiPreviewContainerRef = useRef<HTMLDivElement | null>(null);

    const [customTheme, setCustomTheme] = useState<CustomTheme>({
        windowBg: '#0F1928',
        editorBg: '#141E2D',
        titleBar: '#0F1928',
        statusBar: '#005A9E',
        text: '#D4D4D4',
        tabBg: '#1E1E1E',
        selectedTab: '#007ACC'
    });

    // Font state
    const [fontLibrary, setFontLibrary] = useState<FontLibraryEntry[]>([]);
    const [uiFont, setUiFont] = useState('');
    const [editorFont, setEditorFont] = useState('');
    const [fontsReady, setFontsReady] = useState(false);
    const fontFileInputRef = useRef<HTMLInputElement | null>(null);

    const [useCustomSyntaxTheme, setUseCustomSyntaxTheme] = useState(false);
    const [customSyntax, setCustomSyntax] = useState<SyntaxColors>({
        keyword: '#569CD6',
        comment: '#6A9955',
        stringColor: '#CE9178',
        number: '#B5CEA8',
        propertyColor: '#569CD6'
    });
    const [customBrackets, setCustomBrackets] = useState<BracketColors>({
        color1: '#FFD700',
        color2: '#DA70D6',
        color3: '#87CEEB'
    });

    const buildSrcdoc = useCallback(() => {
        const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
            .map(el => el.outerHTML).join('\n');
        const bodyClone = document.body.cloneNode(true) as HTMLElement;
        bodyClone.querySelectorAll('.themes-dialog-overlay').forEach(el => el.remove());
        const bodyHTML = bodyClone.innerHTML;
        const rootStyles = document.documentElement.getAttribute('style') || '';
        const dataAttrs = Array.from(document.documentElement.attributes)
            .filter(a => a.name.startsWith('data-'))
            .map(a => `${a.name}="${a.value}"`)
            .join(' ');
        return `<!DOCTYPE html><html style="${rootStyles}" ${dataAttrs}><head>${styles}</head><body>${bodyHTML}</body></html>`;
    }, []);

    const [srcdoc, setSrcdoc] = useState('');

    useEffect(() => {
        if (isOpen && activeSection === 'ui') {
            setSrcdoc(buildSrcdoc());
        }
    }, [isOpen, activeSection, buildSrcdoc]);

    const syncThemeToIframe = useCallback(() => {
        const iframe = uiPreviewRef.current;
        if (!iframe?.contentDocument) return;
        const root = iframe.contentDocument.documentElement;

        const theme = useCustomTheme ? customTheme : (getTheme(selectedTheme) || THEMES[0]);
        root.style.setProperty('--window-bg', theme.windowBg);
        root.style.setProperty('--editor-bg', theme.editorBg);
        root.style.setProperty('--title-bar-bg', theme.titleBar);
        root.style.setProperty('--status-bar-bg', theme.statusBar);
        root.style.setProperty('--text-color', theme.text);
        root.style.setProperty('--tab-bg', theme.tabBg);
        root.style.setProperty('--selected-tab-bg', theme.selectedTab);

        // Sync syntax colors from the selected theme
        const syntaxColors = getSyntaxColors(!useCustomTheme ? selectedTheme : 'Default');
        root.style.setProperty('--syntax-keyword-color',  syntaxColors.keyword);
        root.style.setProperty('--syntax-comment-color',  syntaxColors.comment);
        root.style.setProperty('--syntax-string-color',   syntaxColors.stringColor);
        root.style.setProperty('--syntax-number-color',   syntaxColors.number);
        root.style.setProperty('--syntax-property-color', syntaxColors.propertyColor);

        // Sync gradient and background image from the selected preset theme
        const fullTheme = !useCustomTheme ? getTheme(selectedTheme) : null;

        // Sync theme font
        if (fullTheme?.font) {
            root.style.setProperty('--ui-font', `"${fullTheme.font}", sans-serif`);
        } else {
            root.style.removeProperty('--ui-font');
        }

        if (fullTheme?.windowGradient) {
            root.style.setProperty('--window-gradient', fullTheme.windowGradient);
            root.setAttribute('data-theme-gradient', 'true');
        } else {
            root.style.removeProperty('--window-gradient');
            root.removeAttribute('data-theme-gradient');
        }

        if (fullTheme?.defaultBackground) {
            root.style.setProperty('--custom-bg-image', `url("${fullTheme.defaultBackground}")`);
            root.style.setProperty('--custom-bg-blur', '0px');
            root.style.setProperty('--custom-bg-scale', '1');
            root.style.setProperty('--custom-bg-brightness', '1');
            root.style.setProperty('--custom-bg-saturation', '1');
            root.style.setProperty('--custom-bg-opacity', '1');
            root.style.setProperty('--custom-bg-vignette', '0');
            root.style.setProperty('--custom-bg-position', `${fullTheme.themeBackgroundPositionX ?? 50}% ${fullTheme.themeBackgroundPositionY ?? 50}%`);
            root.style.setProperty('--custom-bg-origin', `${fullTheme.themeBackgroundPositionX ?? 50}% ${fullTheme.themeBackgroundPositionY ?? 50}%`);
            root.style.setProperty('--custom-bg-size', fullTheme.themeBackgroundSize ?? 'auto');
            root.style.setProperty('--custom-bg-color', fullTheme.windowGradient ? 'transparent' : (fullTheme.windowBg ?? '#000000'));
            root.setAttribute('data-custom-background', 'true');
        } else {
            root.style.removeProperty('--custom-bg-image');
            root.style.removeProperty('--custom-bg-opacity');
            root.removeAttribute('data-custom-background');
        }
    }, [useCustomTheme, customTheme, selectedTheme]);

    useEffect(() => {
        syncThemeToIframe();
    }, [syncThemeToIframe]);

    useEffect(() => {
        const container = uiPreviewContainerRef.current;
        if (!container) return;
        const observer = new ResizeObserver(([entry]) => {
            const w = entry.contentRect.width;
            const scale = w / 1280;
            container.style.setProperty('--ui-preview-scale', String(scale));
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [isOpen, activeSection]);

    useEffect(() => {
        if (isOpen) {
            setFontsReady(false);
            loadPreferences();
            preloadBundledFonts().then(() => setFontsReady(true));
        }
    }, [isOpen]);


    // Non-passive wheel listener so we can preventDefault (React onWheel is passive)
    useEffect(() => {
        const el = viewportPickerRef.current;
        if (!el) return;
        const handler = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            setCustomBackgroundZoom(prev =>
                Math.round(Math.min(5, Math.max(1, prev * factor)) * 100) / 100
            );
        };
        el.addEventListener('wheel', handler, { passive: false });
        return () => el.removeEventListener('wheel', handler);
    });

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
        setCustomBackgroundBlur(8);
        setCustomBackgroundBrightness(100);
        setCustomBackgroundSaturation(100);
        setCustomBackgroundOpacity(100);
        setCustomBackgroundVignette(0);
        setCustomBackgroundPosX(50);
        setCustomBackgroundPosY(50);
        setCustomBackgroundZoom(1);
        setBgImageSize(null);
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
            const useThemeBg = await invoke<string>('get_preference', { key: 'UseThemeBackground', defaultValue: 'true' });
            const themeBgBlurRaw = await invoke<string>('get_preference', { key: 'ThemeBackgroundBlur', defaultValue: '4' });
            // Background image bytes are stored as a real file in the
            // config dir (not inlined into preferences.json). Read via
            // the dedicated command which returns a data URL on demand.
            const backgroundImage = (await invoke<string | null>('get_custom_background_image')) ?? '';
            const backgroundName = await invoke<string>('get_preference', { key: 'CustomBackgroundImageName', defaultValue: '' });
            const backgroundBlurRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundBlur', defaultValue: '8' });
            const backgroundBrightnessRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundBrightness', defaultValue: '100' });
            const backgroundSaturationRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundSaturation', defaultValue: '100' });
            const backgroundOpacityRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundOpacity', defaultValue: '100' });
            const backgroundVignetteRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundVignette', defaultValue: '0' });
            const backgroundPosXRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundPositionX', defaultValue: '50' });
            const backgroundPosYRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundPositionY', defaultValue: '50' });
            const backgroundZoomRaw = await invoke<string>('get_preference', { key: 'CustomBackgroundZoom', defaultValue: '1' });

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
            setUseThemeBackground(useThemeBg !== 'false');
            {
                const bl = Number.parseInt(themeBgBlurRaw, 10);
                if (Number.isFinite(bl)) setThemeBgBlur(Math.max(0, Math.min(40, bl)));
            }
            {
                const parsedBlur = Number.parseInt(backgroundBlurRaw, 10);
                const blur = Number.isFinite(parsedBlur) ? clampBlur(parsedBlur) : 8;
                setCustomBackgroundBlur(blur);
            }
            {
                const v = Number.parseInt(backgroundBrightnessRaw, 10);
                setCustomBackgroundBrightness(Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100);
            }
            {
                const v = Number.parseInt(backgroundSaturationRaw, 10);
                setCustomBackgroundSaturation(Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100);
            }
            {
                const v = Number.parseInt(backgroundOpacityRaw, 10);
                setCustomBackgroundOpacity(Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100);
            }
            {
                const v = Number.parseInt(backgroundVignetteRaw, 10);
                setCustomBackgroundVignette(Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);
            }
            {
                const px = Number.parseFloat(backgroundPosXRaw);
                setCustomBackgroundPosX(Number.isFinite(px) ? px : 50);
            }
            {
                const py = Number.parseFloat(backgroundPosYRaw);
                setCustomBackgroundPosY(Number.isFinite(py) ? py : 50);
            }
            {
                const z = Number.parseFloat(backgroundZoomRaw);
                setCustomBackgroundZoom(Number.isFinite(z) && z >= 1 ? z : 1);
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

            const useCustomSyntaxRaw = await invoke<string>('get_preference', { key: 'UseCustomSyntaxTheme', defaultValue: 'false' });
            setUseCustomSyntaxTheme(useCustomSyntaxRaw === 'true');
            // Font library + assignments
            const storedFonts = await invoke<string[]>('get_stored_fonts');
            setFontLibrary(storedFonts.map(fileName => ({
                name: fontFileNameToFamily(fileName),
                fileName,
            })));
            setUiFont(await invoke<string>('get_preference',     { key: 'UIFont',    defaultValue: '' }));
            setEditorFont(await invoke<string>('get_preference', { key: 'EditorFont', defaultValue: '' }));

            if (useCustomSyntaxRaw === 'true') {
                const csKeyword  = await invoke<string>('get_preference', { key: 'CustomSyntax_Keyword',  defaultValue: '#569CD6' });
                const csComment  = await invoke<string>('get_preference', { key: 'CustomSyntax_Comment',  defaultValue: '#6A9955' });
                const csString   = await invoke<string>('get_preference', { key: 'CustomSyntax_String',   defaultValue: '#CE9178' });
                const csNumber   = await invoke<string>('get_preference', { key: 'CustomSyntax_Number',   defaultValue: '#B5CEA8' });
                const csProperty = await invoke<string>('get_preference', { key: 'CustomSyntax_Property', defaultValue: '#569CD6' });
                const csBracket1 = await invoke<string>('get_preference', { key: 'CustomSyntax_Bracket1', defaultValue: '#FFD700' });
                const csBracket2 = await invoke<string>('get_preference', { key: 'CustomSyntax_Bracket2', defaultValue: '#DA70D6' });
                const csBracket3 = await invoke<string>('get_preference', { key: 'CustomSyntax_Bracket3', defaultValue: '#87CEEB' });
                setCustomSyntax({ keyword: csKeyword, comment: csComment, stringColor: csString, number: csNumber, propertyColor: csProperty });
                setCustomBrackets({ color1: csBracket1, color2: csBracket2, color3: csBracket3 });
            }
        } catch (error) {
            console.error('Failed to load theme preferences:', error);
        }
    };

    const handleFontFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const validExts = ['.ttf', '.otf', '.woff', '.woff2'];
        if (!validExts.some(ext => file.name.toLowerCase().endsWith(ext))) {
            alert('Please select a TTF, OTF, WOFF, or WOFF2 font file.');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            alert('Font file must be smaller than 10 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
            const dataUrl = reader.result as string;
            try {
                const storedName = await invoke<string>('store_font', { dataUrl, fileName: file.name });
                const entry: FontLibraryEntry = { name: fontFileNameToFamily(storedName), fileName: storedName };
                setFontLibrary(prev => {
                    if (prev.some(f => f.fileName === storedName)) return prev;
                    return [...prev, entry].sort((a, b) => a.name.localeCompare(b.name));
                });
                // Load via FontFace API so the dropdown option previews correctly
                try {
                    const urlForFace = await invoke<string>('get_font_data_url', { fileName: storedName });
                    const ff = new FontFace(entry.name, `url("${urlForFace}")`);
                    await ff.load();
                    document.fonts.add(ff);
                } catch { /* preview injection is non-critical */ }
            } catch (err) {
                alert(`Failed to import font: ${err}`);
            }
        };
        reader.readAsDataURL(file);
    };

    const handleDeleteFont = async (entry: FontLibraryEntry) => {
        try {
            await invoke('delete_font', { fileName: entry.fileName });
            setFontLibrary(prev => prev.filter(f => f.fileName !== entry.fileName));
            // Clear any font assignments referencing this font
            if (uiFont === entry.name) setUiFont('');
            if (editorFont === entry.name) setEditorFont('');
        } catch (err) {
            alert(`Failed to delete font: ${err}`);
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
            await invoke('set_preference', { key: 'UseCustomSyntaxTheme', value: useCustomSyntaxTheme.toString() });

            if (useCustomSyntaxTheme) {
                await invoke('set_preference', { key: 'CustomSyntax_Keyword',  value: customSyntax.keyword });
                await invoke('set_preference', { key: 'CustomSyntax_Comment',  value: customSyntax.comment });
                await invoke('set_preference', { key: 'CustomSyntax_String',   value: customSyntax.stringColor });
                await invoke('set_preference', { key: 'CustomSyntax_Number',   value: customSyntax.number });
                await invoke('set_preference', { key: 'CustomSyntax_Property', value: customSyntax.propertyColor });
                await invoke('set_preference', { key: 'CustomSyntax_Bracket1', value: customBrackets.color1 });
                await invoke('set_preference', { key: 'CustomSyntax_Bracket2', value: customBrackets.color2 });
                await invoke('set_preference', { key: 'CustomSyntax_Bracket3', value: customBrackets.color3 });
            }
            await invoke('set_preference', { key: 'RoundedCorners', value: roundedCorners.toString()  });
            await invoke('set_preference', { key: 'ModernUI',       value: modernUI.toString()         });
            await invoke('set_preference', { key: 'CigaretteMode',  value: cigaretteMode.toString()    });
            await invoke('set_preference', { key: 'UseCustomBackgroundImage', value: (useCustomBackground && customBackgroundImage.length > 0).toString() });
            await invoke('set_preference', { key: 'UseThemeBackground', value: useThemeBackground.toString() });
            await invoke('set_preference', { key: 'ThemeBackgroundBlur', value: String(themeBgBlur) });
            // Background image bytes go to a real file via dedicated command;
            // we never store the data URL in preferences.json anymore.
            if (customBackgroundImage.length > 0) {
                await invoke('set_custom_background_image', { dataUrl: customBackgroundImage });
            } else {
                await invoke('clear_custom_background_image');
            }
            await invoke('set_preference', { key: 'CustomBackgroundImageName', value: customBackgroundName });
            await invoke('set_preference', { key: 'CustomBackgroundBlur', value: String(customBackgroundBlur) });
            await invoke('set_preference', { key: 'CustomBackgroundBrightness', value: String(customBackgroundBrightness) });
            await invoke('set_preference', { key: 'CustomBackgroundSaturation', value: String(customBackgroundSaturation) });
            await invoke('set_preference', { key: 'CustomBackgroundOpacity', value: String(customBackgroundOpacity) });
            await invoke('set_preference', { key: 'CustomBackgroundVignette', value: String(customBackgroundVignette) });
            await invoke('set_preference', { key: 'CustomBackgroundPositionX', value: String(customBackgroundPosX) });
            await invoke('set_preference', { key: 'CustomBackgroundPositionY', value: String(customBackgroundPosY) });
            await invoke('set_preference', { key: 'CustomBackgroundZoom', value: String(customBackgroundZoom) });

            applyRoundedCorners(roundedCorners);
            applyModernUI(modernUI);

            // Background priority: custom image > theme default > none
            {
                const hasCustomBg = useCustomBackground && customBackgroundImage.length > 0;
                const themeForBg = !useCustomTheme ? getTheme(selectedTheme) : undefined;
                const hasThemeBg = useThemeBackground && !!themeForBg?.defaultBackground;
                if (hasCustomBg) {
                    applyCustomBackground({
                        enabled: true,
                        imageDataUrl: customBackgroundImage,
                        blur: customBackgroundBlur,
                        brightness: customBackgroundBrightness / 100,
                        saturation: customBackgroundSaturation / 100,
                        opacity: customBackgroundOpacity / 100,
                        vignette: customBackgroundVignette / 100,
                        positionX: customBackgroundPosX,
                        positionY: customBackgroundPosY,
                        zoom: customBackgroundZoom,
                    });
                } else if (hasThemeBg) {
                    const hasGradient = !!themeForBg?.windowGradient;
                    applyCustomBackground({
                        enabled: true,
                        imageDataUrl: themeForBg!.defaultBackground!,
                        blur: themeBgBlur,
                        brightness: 1,
                        saturation: 1,
                        opacity: 1,
                        vignette: 0,
                        positionX: themeForBg?.themeBackgroundPositionX ?? 50,
                        positionY: themeForBg?.themeBackgroundPositionY ?? 50,
                        zoom: 1,
                        backgroundSize: themeForBg?.themeBackgroundSize ?? (hasGradient ? 'contain' : 'auto'),
                        backgroundColor: hasGradient ? 'transparent' : (themeForBg?.windowBg ?? '#000000'),
                    });
                } else {
                    applyCustomBackground({ enabled: false, imageDataUrl: '', blur: 0 });
                }
            }
            // Save font preferences
            await invoke('set_preference', { key: 'UIFont',    value: uiFont });
            await invoke('set_preference', { key: 'EditorFont', value: editorFont });

            // Apply font changes immediately (re-inject faces + ui font + editor font event)
            const fontData = await Promise.all(
                fontLibrary.map(async entry => {
                    try {
                        const dataUrl = await invoke<string>('get_font_data_url', { fileName: entry.fileName });
                        return { name: entry.name, dataUrl };
                    } catch { return null; }
                })
            );
            // await so all fonts are decoded before Monaco measures them
            await injectFontFaces(fontData.filter((f): f is { name: string; dataUrl: string } => f !== null));
            // Resolve effective font: user override → theme default → built-in stack
            const appliedThemeObj = useCustomTheme ? null : getTheme(selectedTheme);
            const themeFontRaw = appliedThemeObj?.font;
            // Fuzzy-match the theme font name against the imported font library so that
            // 'FOT-Rodin Pro DB' (theme) finds 'fot-rodin-pro-db' (stored filename), etc.
            const normFont = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, '');
            const resolvedThemeFont = themeFontRaw
                ? (fontLibrary.find(f => normFont(f.name) === normFont(themeFontRaw))?.name ?? themeFontRaw)
                : undefined;
            if (resolvedThemeFont) await ensurePresetFontLoaded(resolvedThemeFont);
            applyUIFont(uiFont || resolvedThemeFont || '');
            const activeFont = editorFont || resolvedThemeFont || '';

            // Ensure the chosen preset font is loaded from CDN before applying
            if (activeFont) await ensurePresetFontLoaded(activeFont);

            // Empty string when no font is selected — App.tsx leaves Monaco's
            // fontFamily undefined so the editor uses its built-in default.
            const resolvedEditorFont = activeFont ? `"${activeFont}", monospace` : "";
            window.dispatchEvent(new CustomEvent('jade-editor-font-changed', { detail: resolvedEditorFont }));

            window.dispatchEvent(new CustomEvent('cigarette-mode-changed', { detail: cigaretteMode }));

            onThemeApplied?.(useCustomTheme ? 'Custom' : selectedTheme);
        } catch (error) {
            console.error('Failed to save theme preferences:', error);
        }
    };

    const handleThemeSelect = (themeId: string) => {
        setSelectedTheme(themeId);
        if (!overrideSyntax) setSelectedSyntaxTheme(themeId);
        // When switching to a theme that has its own font, clear any stale font
        // override so the theme font takes effect on Apply. The user can still
        // go to the Fonts tab and pick something else before applying.
        const newTheme = getTheme(themeId);
        if (newTheme?.font) {
            setUiFont('');
            setEditorFont('');
        }
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
    const activeSyntaxId = useCustomSyntaxTheme ? 'CustomSyntax' : selectedSyntaxTheme;
    const currentSyntax = getSyntaxColors(activeSyntaxId, customSyntax);
    const currentBrackets = getBracketColors(activeSyntaxId, customBrackets);

    if (!isOpen) return null;

    /* ── Section renderers ── */
    const uiPreview = (
        <div className="ui-preview-container" ref={uiPreviewContainerRef}>
            <iframe
                ref={uiPreviewRef}
                className="ui-preview-iframe"
                srcDoc={srcdoc}
                sandbox="allow-same-origin"
                title="Theme Preview"
                onLoad={syncThemeToIframe}
            />
        </div>
    );

    const isLightTheme = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
    };

    const renderUI = () => {
        const currentIsLight = isLightTheme(currentTheme.windowBg);

        return (
            <>
                <div className="section-header">
                    <h4>UI Theme</h4>
                    <label className="checkbox-label">
                        <input type="checkbox" checked={useCustomTheme}
                            onChange={e => handleCustomThemeToggle(e.target.checked)} />
                        Custom
                    </label>
                </div>

                <div className="syntax-split-layout">
                    {!useCustomTheme ? (
                        <div className="theme-list">
                            {THEMES.map(theme => {
                                const lockedByModern = !!theme.requiresModernUI && !modernUI;
                                return (
                                <div
                                    key={theme.id}
                                    className={`theme-item${selectedTheme === theme.id ? ' selected' : ''}${lockedByModern ? ' disabled' : ''}`}
                                    onClick={() => { if (!lockedByModern) handleThemeSelect(theme.id); }}
                                    title={lockedByModern ? 'This theme requires Modern UI' : undefined}
                                >
                                    <span>{theme.displayName}{lockedByModern && <span className="theme-item-lock"> · Modern UI only</span>}</span>
                                    {theme.icon ? (
                                        <img
                                            src={theme.icon}
                                            className={`theme-item-icon${
                                                theme.id === 'YoRHa'
                                                    ? (currentIsLight ? ' theme-item-icon-light' : ' theme-item-icon-invert')
                                                    : ''
                                            }`}
                                            alt=""
                                            draggable={false}
                                        />
                                    ) : (
                                        <div className="theme-preview-dots">
                                            <div className="preview-dot" style={{ backgroundColor: theme.windowBg }} />
                                            <div className="preview-dot" style={{ backgroundColor: theme.statusBar }} />
                                        </div>
                                    )}
                                </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="custom-theme-editor compact">
                            {([
                                ['Window Bg',    'windowBg'],
                                ['Editor Bg',    'editorBg'],
                                ['Title Bar',    'titleBar'],
                                ['Status Bar',   'statusBar'],
                                ['Text',         'text'],
                                ['Tab Bg',       'tabBg'],
                                ['Selected Tab', 'selectedTab'],
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
                    {uiPreview}
                </div>
            </>
        );
    };

    const handleCustomSyntaxToggle = (checked: boolean) => {
        setUseCustomSyntaxTheme(checked);
        if (checked) {
            const base = getSyntaxColors(selectedSyntaxTheme);
            const baseBrackets = getBracketColors(selectedSyntaxTheme);
            setCustomSyntax({ ...base });
            setCustomBrackets({ ...baseBrackets });
        }
    };

    const syntaxPreview = (
        <div className="syntax-preview" style={{ backgroundColor: currentTheme.editorBg, color: currentTheme.text }}>
            <pre>
                <code>
                    <span style={{ color: currentBrackets.color1 }}>{'{'}</span>{'\n'}
                    {'  '}<span style={{ color: currentSyntax.comment }}># This is a comment</span>{'\n'}
                    {'  '}<span style={{ color: currentSyntax.propertyColor }}>skinScale</span>: <span style={{ color: currentSyntax.keyword }}>f32</span> = <span style={{ color: currentSyntax.number }}>1.0</span>{'\n'}
                    {'  '}<span style={{ color: currentSyntax.propertyColor }}>name</span>: <span style={{ color: currentSyntax.keyword }}>string</span> = <span style={{ color: currentSyntax.stringColor }}>"Example"</span>{'\n'}
                    {'  '}<span style={{ color: currentSyntax.propertyColor }}>enabled</span>: <span style={{ color: currentSyntax.keyword }}>bool</span> = <span style={{ color: currentSyntax.keyword }}>true</span>{'\n'}
                    {'  '}<span style={{ color: currentSyntax.propertyColor }}>data</span>: <span style={{ color: currentSyntax.keyword }}>hash</span> = <span style={{ color: currentSyntax.number }}>0xDEADBEEF</span>{'\n'}
                    {'  '}<span style={{ color: currentSyntax.propertyColor }}>items</span>: <span style={{ color: currentSyntax.keyword }}>list</span><span style={{ color: currentBrackets.color2 }}>{'['}</span><span style={{ color: currentSyntax.keyword }}>embed</span><span style={{ color: currentBrackets.color2 }}>{']'}</span> = <span style={{ color: currentBrackets.color2 }}>{'{'}</span>{'\n'}
                    {'    '}<span style={{ color: currentSyntax.keyword }}>EntryData</span> <span style={{ color: currentBrackets.color3 }}>{'{'}</span>{'\n'}
                    {'      '}<span style={{ color: currentSyntax.propertyColor }}>path</span>: <span style={{ color: currentSyntax.keyword }}>string</span> = <span style={{ color: currentSyntax.stringColor }}>"ASSETS/Example/File.bin"</span>{'\n'}
                    {'      '}<span style={{ color: currentSyntax.propertyColor }}>offset</span>: <span style={{ color: currentSyntax.keyword }}>vec3</span> = <span style={{ color: currentBrackets.color1 }}>{'('}</span> <span style={{ color: currentSyntax.number }}>1.0</span> <span style={{ color: currentSyntax.number }}>2.5</span> <span style={{ color: currentSyntax.number }}>3.0</span> <span style={{ color: currentBrackets.color1 }}>{')'}</span>{'\n'}
                    {'    '}<span style={{ color: currentBrackets.color3 }}>{'}'}</span>{'\n'}
                    {'  '}<span style={{ color: currentBrackets.color2 }}>{'}'}</span>{'\n'}
                    <span style={{ color: currentBrackets.color1 }}>{'}'}</span>
                </code>
            </pre>
        </div>
    );

    const renderSyntax = () => (
        <>
            <div className="section-header">
                <h4>Syntax Color Scheme</h4>
                <div className="section-header-checks">
                    <label className="checkbox-label">
                        <input type="checkbox" checked={overrideSyntax}
                            onChange={e => setOverrideSyntax(e.target.checked)} />
                        Override
                    </label>
                    <label className="checkbox-label">
                        <input type="checkbox" checked={useCustomSyntaxTheme}
                            onChange={e => handleCustomSyntaxToggle(e.target.checked)} />
                        Custom
                    </label>
                </div>
            </div>

            <div className="syntax-split-layout">
                {!useCustomSyntaxTheme ? (
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
                ) : (
                    <div className="custom-theme-editor compact">
                        <h5 className="custom-syntax-group-title">Token Colors</h5>
                        {([
                            ['Keywords',   'keyword'],
                            ['Comments',   'comment'],
                            ['Strings',    'stringColor'],
                            ['Numbers',    'number'],
                            ['Properties', 'propertyColor'],
                        ] as [string, keyof SyntaxColors][]).map(([label, key]) => (
                            <div key={key} className="color-input-group">
                                <label>{label}</label>
                                <input type="color" value={customSyntax[key]}
                                    onChange={e => setCustomSyntax({ ...customSyntax, [key]: e.target.value })} />
                                <input type="text" value={customSyntax[key]}
                                    onChange={e => setCustomSyntax({ ...customSyntax, [key]: e.target.value })} />
                            </div>
                        ))}
                        <h5 className="custom-syntax-group-title">Bracket Colors</h5>
                        {([
                            ['Curly Braces { }',     'color1'],
                            ['Square Brackets [ ]',  'color2'],
                            ['Parentheses ( )',      'color3'],
                        ] as [string, keyof BracketColors][]).map(([label, key]) => (
                            <div key={key} className="color-input-group">
                                <label>{label}</label>
                                <input type="color" value={customBrackets[key]}
                                    onChange={e => setCustomBrackets({ ...customBrackets, [key]: e.target.value })} />
                                <input type="text" value={customBrackets[key]}
                                    onChange={e => setCustomBrackets({ ...customBrackets, [key]: e.target.value })} />
                            </div>
                        ))}
                    </div>
                )}
                {syntaxPreview}
            </div>
        </>
    );

    const renderBackground = () => {
        const themeForBg = !useCustomTheme ? getTheme(selectedTheme) : undefined;
        const hasThemeDefaultBg = !!themeForBg?.defaultBackground;
        const hasCustomBg = useCustomBackground && customBackgroundImage.length > 0;
        return (
        <>
            <h2 className="themes-section-title">Background Image</h2>
            <p className="themes-section-subtitle">
                Use your own image behind the app. When enabled, top ribbons and bars switch to neutral glass.
            </p>

            {hasThemeDefaultBg && (
                <div className="theme-bg-section">
                    <div className="theme-bg-row">
                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={useThemeBackground}
                                onChange={e => setUseThemeBackground(e.target.checked)}
                            />
                            <span>
                                <strong>Theme background</strong>
                                <span style={{ display: 'block', fontSize: 11, opacity: 0.5, fontWeight: 400 }}>
                                    Bundled with {themeForBg!.displayName}
                                    {hasCustomBg && ' · overridden by your image'}
                                </span>
                            </span>
                        </label>
                        <img
                            src={themeForBg!.defaultBackground}
                            className="theme-bg-thumbnail"
                            alt=""
                            draggable={false}
                        />
                    </div>
                    {useThemeBackground && (
                        <div className="background-slider-row theme-bg-blur">
                            <label htmlFor="theme-bg-blur-slider">
                                Blur <strong>{themeBgBlur}px</strong>
                            </label>
                            <input
                                id="theme-bg-blur-slider"
                                type="range"
                                min={0}
                                max={40}
                                step={1}
                                value={themeBgBlur}
                                onChange={e => setThemeBgBlur(Math.max(0, Math.min(40, Number.parseInt(e.target.value, 10) || 0)))}
                            />
                        </div>
                    )}
                </div>
            )}

            <div className="themes-options background-options">
                <div className="background-header-row">
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={useCustomBackground}
                            onChange={e => setUseCustomBackground(e.target.checked)}
                            disabled={!customBackgroundImage}
                        />
                        <strong>Enable</strong>
                    </label>
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

                <div className="background-sliders-grid">
                    <div className="background-slider-row">
                        <label htmlFor="background-blur-slider">
                            Blur <strong>{customBackgroundBlur}px</strong>
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

                    <div className="background-slider-row">
                        <label htmlFor="background-brightness-slider">
                            Brightness <strong>{customBackgroundBrightness}%</strong>
                        </label>
                        <input
                            id="background-brightness-slider"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={customBackgroundBrightness}
                            onChange={e => {
                                const v = Number.parseInt(e.target.value, 10);
                                setCustomBackgroundBrightness(Number.isFinite(v) ? v : 100);
                            }}
                            disabled={!customBackgroundImage}
                        />
                    </div>

                    <div className="background-slider-row">
                        <label htmlFor="background-saturation-slider">
                            Saturation <strong>{customBackgroundSaturation}%</strong>
                        </label>
                        <input
                            id="background-saturation-slider"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={customBackgroundSaturation}
                            onChange={e => {
                                const v = Number.parseInt(e.target.value, 10);
                                setCustomBackgroundSaturation(Number.isFinite(v) ? v : 100);
                            }}
                            disabled={!customBackgroundImage}
                        />
                    </div>

                    <div className="background-slider-row">
                        <label htmlFor="background-opacity-slider">
                            Opacity <strong>{customBackgroundOpacity}%</strong>
                        </label>
                        <input
                            id="background-opacity-slider"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={customBackgroundOpacity}
                            onChange={e => {
                                const v = Number.parseInt(e.target.value, 10);
                                setCustomBackgroundOpacity(Number.isFinite(v) ? v : 100);
                            }}
                            disabled={!customBackgroundImage}
                        />
                    </div>

                    <div className="background-slider-row">
                        <label htmlFor="background-vignette-slider">
                            Vignette <strong>{customBackgroundVignette}%</strong>
                        </label>
                        <input
                            id="background-vignette-slider"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={customBackgroundVignette}
                            onChange={e => {
                                const v = Number.parseInt(e.target.value, 10);
                                setCustomBackgroundVignette(Number.isFinite(v) ? v : 0);
                            }}
                            disabled={!customBackgroundImage}
                        />
                    </div>
                </div>

                <div
                    className="background-viewport-picker"
                    ref={viewportPickerRef}
                >
                    {customBackgroundImage ? (
                        <>
                            <img
                                src={customBackgroundImage}
                                className="viewport-picker-image"
                                alt=""
                                draggable={false}
                                onLoad={e => {
                                    const img = e.currentTarget;
                                    setBgImageSize({ w: img.naturalWidth, h: img.naturalHeight });
                                }}
                            />
                            {bgImageSize && (() => {
                                const picker = viewportPickerRef.current;
                                if (!picker) return null;
                                const pickerW = picker.clientWidth;
                                const pickerH = picker.clientHeight;
                                const imgW = bgImageSize.w;
                                const imgH = bgImageSize.h;
                                const imgAspect = imgW / imgH;
                                const pickerAspect = pickerW / pickerH;

                                let displayW: number, displayH: number, offsetX: number, offsetY: number;
                                if (imgAspect > pickerAspect) {
                                    displayW = pickerW;
                                    displayH = pickerW / imgAspect;
                                    offsetX = 0;
                                    offsetY = (pickerH - displayH) / 2;
                                } else {
                                    displayH = pickerH;
                                    displayW = pickerH * imgAspect;
                                    offsetX = (pickerW - displayW) / 2;
                                    offsetY = 0;
                                }

                                const appAspect = window.innerWidth / window.innerHeight;
                                let coverVisW: number, coverVisH: number;
                                if (appAspect > imgAspect) {
                                    coverVisW = imgW;
                                    coverVisH = imgW / appAspect;
                                } else {
                                    coverVisH = imgH;
                                    coverVisW = imgH * appAspect;
                                }

                                const visW = coverVisW / customBackgroundZoom;
                                const visH = coverVisH / customBackgroundZoom;
                                const imageScale = displayW / imgW;
                                const boxW = visW * imageScale;
                                const boxH = visH * imageScale;
                                const panRangeW = (imgW - visW) * imageScale;
                                const panRangeH = (imgH - visH) * imageScale;
                                const boxX = offsetX + panRangeW * customBackgroundPosX / 100;
                                const boxY = offsetY + panRangeH * customBackgroundPosY / 100;

                                return (
                                    <div
                                        className="viewport-picker-box"
                                        style={{
                                            left: boxX,
                                            top: boxY,
                                            width: Math.max(boxW, 8),
                                            height: Math.max(boxH, 8),
                                        }}
                                        onMouseDown={e => {
                                            e.preventDefault();
                                            const startX = e.clientX;
                                            const startY = e.clientY;
                                            const startPosX = customBackgroundPosX;
                                            const startPosY = customBackgroundPosY;

                                            const onMove = (ev: MouseEvent) => {
                                                const dx = ev.clientX - startX;
                                                const dy = ev.clientY - startY;
                                                if (panRangeW > 0) {
                                                    setCustomBackgroundPosX(
                                                        Math.min(100, Math.max(0, startPosX + (dx / panRangeW) * 100))
                                                    );
                                                }
                                                if (panRangeH > 0) {
                                                    setCustomBackgroundPosY(
                                                        Math.min(100, Math.max(0, startPosY + (dy / panRangeH) * 100))
                                                    );
                                                }
                                            };
                                            const onUp = () => {
                                                document.removeEventListener('mousemove', onMove);
                                                document.removeEventListener('mouseup', onUp);
                                            };
                                            document.addEventListener('mousemove', onMove);
                                            document.addEventListener('mouseup', onUp);
                                        }}
                                    />
                                );
                            })()}
                            <div className="viewport-picker-hud">
                                <span className="viewport-picker-zoom">{customBackgroundZoom.toFixed(1)}x</span>
                                {customBackgroundZoom > 1 && (
                                    <button
                                        className="viewport-picker-reset"
                                        onClick={() => {
                                            setCustomBackgroundZoom(1);
                                            setCustomBackgroundPosX(50);
                                            setCustomBackgroundPosY(50);
                                        }}
                                    >
                                        Reset
                                    </button>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="background-preview-empty">Scroll to zoom, drag to position</div>
                    )}
                </div>
            </div>
        </>
        );
    };

    const renderOptions = () => (
        <>
            <h2 className="themes-section-title">Display Options</h2>
            <p className="themes-section-subtitle">Control the visual style of the application.</p>

            <div className="themes-options" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
                <label className="checkbox-label">
                    <input type="checkbox" checked={modernUI}
                        onChange={e => {
                            const next = e.target.checked;
                            setModernUI(next);
                            // Themes that depend on the glass morphism look
                            // can't survive the classic chrome — bounce back
                            // to Default when modern UI is turned off, and
                            // reset the matching syntax scheme so the editor
                            // doesn't keep monochrome tokens on a dark bg.
                            if (!next) {
                                const cur = getTheme(selectedTheme);
                                if (cur?.requiresModernUI) {
                                    setSelectedTheme('Default');
                                    setSelectedSyntaxTheme('Default');
                                }
                            }
                        }} />
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

    const WINDOWS_SYSTEM_FONTS = new Set(['Comic Sans MS', 'Consolas', 'Courier New', 'Lucida Console']);
    const fontThemeMap = new Map(THEMES.flatMap(t => t.font ? [[t.font, t]] : []));

    const FontSourceBadge = ({ name }: { name: string }) => {
        if (WINDOWS_SYSTEM_FONTS.has(name))
            return <span className="font-source-icon" title="Windows system font"><FontSourceWindowsIcon size={13} /></span>;
        if (PRESET_FONTS.includes(name))
            return <span className="font-source-icon" title="Bundled with Jade"><FontSourceBundledIcon size={13} /></span>;
        const linkedTheme = fontThemeMap.get(name);
        if (linkedTheme)
            return (
                <span className="font-source-icon font-source-theme" title={`Theme font: ${linkedTheme.displayName}`} style={{ color: linkedTheme.statusBar }}>
                    <PaletteIcon size={13} />
                </span>
            );
        return <span className="font-source-icon" title="Imported by you"><FontSourceImportedIcon size={13} /></span>;
    };

    const renderFonts = () => {
        const activeThemeFont = ('font' in currentTheme) ? (currentTheme as ThemeColors).font : undefined;
        const previewFont = editorFont || '';
        // When nothing is picked, the editor leaves Monaco to its own default
        // — fall back to the same stack so the preview matches.
        const previewFontStack = previewFont
            ? `"${previewFont}", monospace`
            : 'Menlo, Monaco, "Courier New", monospace';

        const themeOnlyFonts = [...new Set(
            THEMES.filter(t => t.font && !PRESET_FONTS.includes(t.font)).map(t => t.font!)
        )];

        return (
            <>
                <div className="section-header">
                    <h4>Fonts</h4>
                </div>
                <div className="fonts-split-layout">
                    {/* ── Left: font list ── */}
                    <div className="font-list-panel">
                        <div className="font-ui-row">
                            <span className="font-assignment-label">UI Font</span>
                            <FontPicker
                                label="UI Font"
                                value={uiFont}
                                onChange={setUiFont}
                                groups={[
                                    { items: [{ value: '', label: '(Default)' }] },
                                    {
                                        title: 'Popular Fonts',
                                        items: PRESET_FONTS.map(f => ({ value: f, label: f, fontFamily: `"${f}", monospace` })),
                                    },
                                    ...(themeOnlyFonts.length > 0 ? [{
                                        title: 'Theme Fonts',
                                        items: themeOnlyFonts.map(f => ({ value: f, label: f, fontFamily: `"${f}", monospace` })),
                                    }] : []),
                                    ...(fontLibrary.length > 0 ? [{
                                        title: 'Imported',
                                        items: fontLibrary.map(f => ({ value: f.name, label: f.name, fontFamily: `"${f.name}", monospace` })),
                                    }] : []),
                                ]}
                            />
                        </div>

                        <div className="font-list-label">Editor Font</div>

                        <div className="font-list" key={fontsReady ? 'ready' : 'loading'}>
                            {/* Default (no override) */}
                            <div
                                className={`font-list-item${!editorFont ? ' selected' : ''}`}
                                onClick={() => setEditorFont('')}
                            >
                                <span className="font-list-item-name">
                                    {activeThemeFont ? `(Theme: ${activeThemeFont})` : '(Default)'}
                                </span>
                            </div>

                            {/* Preset fonts */}
                            {PRESET_FONTS.map(name => (
                                <div
                                    key={name}
                                    className={`font-list-item${editorFont === name ? ' selected' : ''}`}
                                    onClick={() => setEditorFont(name)}
                                >
                                    <span
                                        className="font-list-item-name"
                                        style={{ fontFamily: `"${name}", monospace` }}
                                    >
                                        {name}
                                    </span>
                                    <FontSourceBadge name={name} />
                                </div>
                            ))}

                            {/* Theme-specific font not in preset list */}
                            {themeOnlyFonts.length > 0 && (
                                <>
                                    <div className="font-list-section-header">Theme</div>
                                    {themeOnlyFonts.map(name => (
                                        <div
                                            key={name}
                                            className={`font-list-item${editorFont === name ? ' selected' : ''}`}
                                            onClick={() => setEditorFont(name)}
                                        >
                                            <span
                                                className="font-list-item-name"
                                                style={{ fontFamily: `"${name}", monospace` }}
                                            >
                                                {name}
                                            </span>
                                            <FontSourceBadge name={name} />
                                        </div>
                                    ))}
                                </>
                            )}

                            {/* Imported fonts */}
                            {fontLibrary.length > 0 && (
                                <>
                                    <div className="font-list-section-header">Imported</div>
                                    {fontLibrary.map(entry => (
                                        <div
                                            key={entry.fileName}
                                            className={`font-list-item${editorFont === entry.name ? ' selected' : ''}`}
                                            onClick={() => setEditorFont(entry.name)}
                                        >
                                            <span
                                                className="font-list-item-name"
                                                style={{ fontFamily: `"${entry.name}", monospace` }}
                                            >
                                                {entry.name}
                                            </span>
                                            <FontSourceBadge name={entry.name} />
                                            <button
                                                className="font-library-delete"
                                                onClick={e => { e.stopPropagation(); handleDeleteFont(entry); }}
                                                title={`Remove ${entry.name}`}
                                            >×</button>
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>

                        <input
                            ref={fontFileInputRef}
                            type="file"
                            accept=".ttf,.otf,.woff,.woff2"
                            onChange={handleFontFileSelected}
                            style={{ display: 'none' }}
                        />
                        <button
                            className="background-action-btn"
                            onClick={() => fontFileInputRef.current?.click()}
                        >
                            + Import Font File
                        </button>
                    </div>

                    {/* ── Right: preview ── */}
                    <div
                        className="font-preview-panel"
                        style={{ backgroundColor: currentTheme.editorBg, color: currentTheme.text }}
                    >
                        <div
                            className="font-preview-name"
                            style={{ fontFamily: previewFontStack }}
                        >
                            {previewFont || 'Default'}
                        </div>
                        <div className="font-preview-chars" style={{ fontFamily: previewFontStack }}>
                            AaBbCcDd&nbsp;&nbsp;0123456789&nbsp;&nbsp;{'{}[]()=>'}&nbsp;&nbsp;!@#$
                        </div>
                        <pre className="font-preview-code" style={{ fontFamily: previewFontStack }}>
                            <code>
                                <span style={{ color: currentBrackets.color1 }}>{'{'}</span>{'\n'}
                                {'  '}<span style={{ color: currentSyntax.comment }}># This is a comment</span>{'\n'}
                                {'  '}<span style={{ color: currentSyntax.propertyColor }}>skinScale</span>{': '}<span style={{ color: currentSyntax.keyword }}>f32</span>{' = '}<span style={{ color: currentSyntax.number }}>1.0</span>{'\n'}
                                {'  '}<span style={{ color: currentSyntax.propertyColor }}>name</span>{': '}<span style={{ color: currentSyntax.keyword }}>string</span>{' = '}<span style={{ color: currentSyntax.stringColor }}>"Example"</span>{'\n'}
                                {'  '}<span style={{ color: currentSyntax.propertyColor }}>enabled</span>{': '}<span style={{ color: currentSyntax.keyword }}>bool</span>{' = '}<span style={{ color: currentSyntax.keyword }}>true</span>{'\n'}
                                {'  '}<span style={{ color: currentSyntax.propertyColor }}>data</span>{': '}<span style={{ color: currentSyntax.keyword }}>hash</span>{' = '}<span style={{ color: currentSyntax.number }}>0xDEADBEEF</span>{'\n'}
                                {'  '}<span style={{ color: currentSyntax.propertyColor }}>items</span>{': '}<span style={{ color: currentSyntax.keyword }}>list</span><span style={{ color: currentBrackets.color2 }}>{'['}</span><span style={{ color: currentSyntax.keyword }}>embed</span><span style={{ color: currentBrackets.color2 }}>{']'}</span>{' = '}<span style={{ color: currentBrackets.color2 }}>{'{'}</span>{'\n'}
                                {'    '}<span style={{ color: currentSyntax.keyword }}>EntryData</span>{' '}<span style={{ color: currentBrackets.color3 }}>{'{'}</span>{'\n'}
                                {'      '}<span style={{ color: currentSyntax.propertyColor }}>path</span>{': '}<span style={{ color: currentSyntax.keyword }}>string</span>{' = '}<span style={{ color: currentSyntax.stringColor }}>"ASSETS/Example/File.bin"</span>{'\n'}
                                {'    '}<span style={{ color: currentBrackets.color3 }}>{'}'}</span>{'\n'}
                                {'  '}<span style={{ color: currentBrackets.color2 }}>{'}'}</span>{'\n'}
                                <span style={{ color: currentBrackets.color1 }}>{'}'}</span>
                            </code>
                        </pre>
                    </div>
                </div>
            </>
        );
    };

    const sectionContent: Record<NavSection, () => React.ReactElement> = {
        ui:         renderUI,
        syntax:     renderSyntax,
        background: renderBackground,
        fonts:      renderFonts,
        options:    renderOptions,
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
