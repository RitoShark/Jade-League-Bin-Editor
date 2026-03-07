// Theme application utilities
// Applies themes dynamically to the application

import { getTheme, getSyntaxColors, getBracketColors } from './themes';
import type { SyntaxColors, BracketColors } from './themes';
import type { Monaco } from '@monaco-editor/react';

interface CustomSyntaxOptions {
    customSyntax?: SyntaxColors;
    customBrackets?: BracketColors;
}

interface CustomThemeColors {
    windowBg: string;
    editorBg: string;
    titleBar: string;
    statusBar: string;
    text: string;
    tabBg: string;
    selectedTab: string;
}

interface CustomBackgroundOptions {
    enabled: boolean;
    imageDataUrl?: string | null;
    blur?: number;
    brightness?: number;
    saturation?: number;
    opacity?: number;
    vignette?: number;
}

/**
 * Lighten or darken a hex color
 */
function adjustColor(hex: string, amount: number): string {
    // Remove # if present
    hex = hex.replace('#', '');
    
    // Parse the color
    const num = parseInt(hex, 16);
    let r = (num >> 16) + amount;
    let g = ((num >> 8) & 0x00FF) + amount;
    let b = (num & 0x0000FF) + amount;
    
    // Clamp values
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Ensure an accent color is bright enough to be readable as text on dark surfaces.
 * Mixes the color toward white until perceived luminance reaches a minimum threshold.
 * Colors already above the threshold are returned unchanged, so bright accents stay vivid.
 */
function makeTextAccent(hex: string): string {
    hex = hex.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);

    // Perceived luminance (0–1)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    // Already readable — keep original hue and saturation
    if (lum >= 0.38) return `#${hex}`;

    // Mix toward white: find blend factor t so that blended luminance ≈ 0.45
    // blended_lum = lum*t + 1.0*(1-t)  →  t = (0.45 - 1) / (lum - 1)
    const t = Math.max(0, Math.min(1, (0.45 - 1) / (lum - 1 + 0.0001)));
    const nr = Math.min(255, Math.round(r * t + 255 * (1 - t)));
    const ng = Math.min(255, Math.round(g * t + 255 * (1 - t)));
    const nb = Math.min(255, Math.round(b * t + 255 * (1 - t)));
    return '#' + [nr, ng, nb].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Calculate scrollbar colors based on theme
 */
function calculateScrollbarColors(selectedTab: string, _editorBg: string): { thumb: string; thumbHover: string } {
    // Use selectedTab as the base for scrollbar thumb
    // Make hover state slightly lighter
    return {
        thumb: selectedTab,
        thumbHover: adjustColor(selectedTab, 30)
    };
}

/**
 * Apply a theme to the application by updating CSS custom properties
 */
export function applyTheme(themeId: string, customColors?: CustomThemeColors) {
    const root = document.documentElement;

    if (themeId === 'Custom' && customColors) {
        // Apply custom theme colors
        root.style.setProperty('--window-bg', customColors.windowBg);
        root.style.setProperty('--editor-bg', customColors.editorBg);
        root.style.setProperty('--title-bar-bg', customColors.titleBar);
        root.style.setProperty('--status-bar-bg', customColors.statusBar);
        root.style.setProperty('--text-color', customColors.text);
        root.style.setProperty('--tab-bg', customColors.tabBg);
        root.style.setProperty('--selected-tab-bg', customColors.selectedTab);

        // Calculate and apply scrollbar colors
        const scrollbarColors = calculateScrollbarColors(customColors.selectedTab, customColors.editorBg);
        root.style.setProperty('--scrollbar-thumb', scrollbarColors.thumb);
        root.style.setProperty('--scrollbar-thumb-hover', scrollbarColors.thumbHover);

        // Accent color: drives jade-accent for glows/highlights
        root.style.setProperty('--jade-accent', customColors.statusBar);
        // Text-safe version: guaranteed readable luminance on dark surfaces
        root.style.setProperty('--jade-accent-text', makeTextAccent(customColors.statusBar));

        // Adaptive utility colors derived from this theme's text / window colors
        root.style.setProperty('--border-color', `color-mix(in srgb, ${customColors.text} 25%, ${customColors.windowBg})`);
        root.style.setProperty('--text-muted', `color-mix(in srgb, ${customColors.text} 55%, ${customColors.windowBg})`);

        // Update Monaco editor background
        updateMonacoBackground(customColors.editorBg);
    } else {
        // Apply built-in theme
        const theme = getTheme(themeId);
        if (theme) {
            root.style.setProperty('--window-bg', theme.windowBg);
            root.style.setProperty('--editor-bg', theme.editorBg);
            root.style.setProperty('--title-bar-bg', theme.titleBar);
            root.style.setProperty('--status-bar-bg', theme.statusBar);
            root.style.setProperty('--text-color', theme.text);
            root.style.setProperty('--tab-bg', theme.tabBg);
            root.style.setProperty('--selected-tab-bg', theme.selectedTab);

            // Calculate and apply scrollbar colors
            const scrollbarColors = calculateScrollbarColors(theme.selectedTab, theme.editorBg);
            root.style.setProperty('--scrollbar-thumb', scrollbarColors.thumb);
            root.style.setProperty('--scrollbar-thumb-hover', scrollbarColors.thumbHover);

            // Accent color: drives jade-accent for glows/highlights
            root.style.setProperty('--jade-accent', theme.statusBar);
            // Text-safe version: guaranteed readable luminance on dark surfaces
            root.style.setProperty('--jade-accent-text', makeTextAccent(theme.statusBar));

            // Adaptive utility colors derived from this theme's text / window colors
            root.style.setProperty('--border-color', `color-mix(in srgb, ${theme.text} 25%, ${theme.windowBg})`);
            root.style.setProperty('--text-muted', `color-mix(in srgb, ${theme.text} 55%, ${theme.windowBg})`);

            // Update Monaco editor background
            updateMonacoBackground(theme.editorBg);
        }
    }
}

/**
 * Update Monaco editor background color.
 * In modern UI mode we force transparent so the app-container gradient
 * shows through.  In classic mode we restore the solid color.
 *
 * Targets every element Monaco uses to paint its background:
 *   - .monaco-editor            outermost shell
 *   - .overflow-guard           clipping container
 *   - .monaco-editor-background the inner div Monaco fills with the theme bg
 *   - .margin                   gutter / line numbers
 *
 * NOTE: .minimap is intentionally excluded so it keeps its solid themed
 * background (set via Monaco theme token), ensuring minimap code pixels
 * render with correct contrast regardless of the app gradient beneath.
 */
function updateMonacoBackground(bgColor: string) {
    const isModern = document.documentElement.getAttribute('data-ui-mode') === 'modern';
    const bg = isModern ? 'transparent' : bgColor;

    const selectors = [
        '.monaco-editor',
        '.monaco-editor .overflow-guard',
        '.monaco-editor .monaco-editor-background',
        '.monaco-editor .margin',
    ];

    selectors.forEach((selector) => {
        document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
            el.style.backgroundColor = bg;
        });
    });
}

/**
 * Apply rounded corners setting
 */
export function applyRoundedCorners(enabled: boolean) {
    const root = document.documentElement;
    root.style.setProperty('--border-radius', enabled ? '4px' : '0px');
}

/**
 * Apply/remove the Modern UI (Quartz-inspired glass morphism) mode.
 * Sets data-ui-mode="modern" on <html> when enabled, removes it when disabled.
 * Also refreshes Monaco's background immediately so transparency kicks in
 * without needing a full theme reload.
 */
export function applyModernUI(enabled: boolean) {
    const root = document.documentElement;
    if (enabled) {
        root.setAttribute('data-ui-mode', 'modern');
    } else {
        root.removeAttribute('data-ui-mode');
    }

    // Read the current editor bg from the CSS custom property and re-apply.
    // updateMonacoBackground checks data-ui-mode itself, so it will use
    // 'transparent' when modern is on and the solid color when it's off.
    const editorBg =
        root.style.getPropertyValue('--editor-bg') ||
        getComputedStyle(root).getPropertyValue('--editor-bg').trim() ||
        '#1E1E1E';
    updateMonacoBackground(editorBg);
}

/**
 * Apply/remove a user-provided background image behind the full app shell.
 * When enabled, data-custom-background="true" is added to <html> so CSS can
 * switch chrome to neutral glass styling.
 */
export function applyCustomBackground(options: CustomBackgroundOptions) {
    const root = document.documentElement;
    const imageDataUrl = options.imageDataUrl ?? '';
    const hasImage = imageDataUrl.length > 0;
    const enabled = options.enabled && hasImage;

    if (!enabled) {
        root.removeAttribute('data-custom-background');
        root.style.removeProperty('--custom-bg-image');
        root.style.removeProperty('--custom-bg-blur');
        root.style.removeProperty('--custom-bg-scale');
        root.style.removeProperty('--custom-bg-brightness');
        root.style.removeProperty('--custom-bg-saturation');
        root.style.removeProperty('--custom-bg-opacity');
        root.style.removeProperty('--custom-bg-vignette');
        return;
    }

    const parsedBlur = Number.isFinite(options.blur) ? Number(options.blur) : 8;
    const blur = Math.min(40, Math.max(0, parsedBlur));
    const scale = (1 + (blur / 100)).toFixed(2);
    const escapedUrl = imageDataUrl.replace(/"/g, '\\"');

    const brightness = Math.min(1, Math.max(0, options.brightness ?? 1));
    const saturation = Math.min(1, Math.max(0, options.saturation ?? 1));
    const opacity = Math.min(1, Math.max(0, options.opacity ?? 1));
    const vignette = Math.min(1, Math.max(0, options.vignette ?? 0));

    root.setAttribute('data-custom-background', 'true');
    root.style.setProperty('--custom-bg-image', `url("${escapedUrl}")`);
    root.style.setProperty('--custom-bg-blur', `${blur}px`);
    root.style.setProperty('--custom-bg-scale', scale);
    root.style.setProperty('--custom-bg-brightness', brightness.toFixed(2));
    root.style.setProperty('--custom-bg-saturation', saturation.toFixed(2));
    root.style.setProperty('--custom-bg-opacity', opacity.toFixed(2));
    root.style.setProperty('--custom-bg-vignette', vignette.toFixed(2));
}

/**
 * Create and register a Monaco editor theme from syntax colors
 */
export function createMonacoTheme(monaco: Monaco, themeId: string, syntaxThemeId: string, syntaxOpts?: CustomSyntaxOptions) {
    const colors = getSyntaxColors(syntaxThemeId, syntaxOpts?.customSyntax);
    const brackets = getBracketColors(syntaxThemeId, syntaxOpts?.customBrackets);
    const theme = getTheme(themeId);

    // Expose syntax colors as CSS variables so non-Monaco UI (e.g. texture
    // preview filename) can stay in sync with the active syntax theme.
    document.documentElement.style.setProperty('--syntax-string-color', colors.stringColor);

    const editorBg = theme?.editorBg || '#1E1E1E';
    const textColor = theme?.text || '#D4D4D4';

    // Always pass the real editorBg as editor.background — even in modern UI
    // mode.  Monaco uses this color internally to composite the minimap pixel
    // map (syntax token colors blended against editor.background).  Passing
    // #00000000 here causes minimap colors to be computed against
    // transparent-black, which produces wrong shades for every theme.
    //
    // Visual transparency in the main editor is achieved entirely through CSS
    // `background: transparent !important` rules and the JS inline-style
    // override in updateMonacoBackground — neither of which requires the
    // Monaco theme token to be transparent.
    monaco.editor.defineTheme('jade-dynamic', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment', foreground: colors.comment.replace('#', '') },
            { token: 'string', foreground: colors.stringColor.replace('#', '') },
            { token: 'keyword', foreground: colors.keyword.replace('#', ''), fontStyle: 'bold' },
            { token: 'number', foreground: colors.number.replace('#', '') },
            { token: 'type', foreground: colors.propertyColor.replace('#', '') },
            { token: 'identifier', foreground: colors.propertyColor.replace('#', '') },
            { token: 'delimiter.bracket', foreground: brackets.color1.replace('#', '') },
            { token: 'delimiter.square', foreground: brackets.color2.replace('#', '') },
            { token: 'delimiter.parenthesis', foreground: brackets.color3.replace('#', '') },
        ],
        colors: {
            'editor.background': editorBg,
            'editor.foreground': textColor,
            'editorLineNumber.foreground': '#858585',
            'editor.selectionBackground': '#264F78',
            'editor.inactiveSelectionBackground': '#3A3D41',

            // Find/Replace Widget
            'editorWidget.background': theme?.editorBg || '#252526',
            'editorWidget.border': '#454545',
            'editorWidget.resizeBorder': '#454545',

            // Input fields in widgets
            'input.background': theme?.tabBg || '#3C3C3C',
            'input.foreground': textColor,
            'input.border': '#3C3C3C',

            // Buttons
            'button.background': '#0E639C',
            'button.foreground': '#FFFFFF',
            'button.hoverBackground': '#1177BB',

            // Bracket pair colorization (depth-based)
            'editorBracketHighlight.foreground1': brackets.color1,
            'editorBracketHighlight.foreground2': brackets.color2,
            'editorBracketHighlight.foreground3': brackets.color3,
            'editorBracketHighlight.foreground4': brackets.color1,
            'editorBracketHighlight.foreground5': brackets.color2,
            'editorBracketHighlight.foreground6': brackets.color3,
            'editorBracketHighlight.unexpectedBracket.foreground': '#FF0000',

            // Validation
            'inputValidation.infoBackground': '#063B49',
            'inputValidation.infoBorder': '#007ACC',
            'inputValidation.warningBackground': '#352A05',
            'inputValidation.warningBorder': '#B89500',
            'inputValidation.errorBackground': '#5A1D1D',
            'inputValidation.errorBorder': '#BE1100',

            // Minimap: always use the solid editor bg so its tiny code pixels
            // render with correct contrast (we don't make minimap transparent).
            'minimap.background': editorBg,
            'minimapSlider.background': adjustColor(editorBg, 20) + '66',
            'minimapSlider.hoverBackground': adjustColor(editorBg, 30) + '99',
            'minimapSlider.activeBackground': adjustColor(editorBg, 40) + 'BB',

            // Sticky scroll: explicitly pin to the solid editor bg so lines
            // remain readable when editor.background is #00000000 (transparent).
            'editorStickyScroll.background': editorBg,
            'editorStickyScrollHover.background': adjustColor(editorBg, 12),
            'editorStickyScrollBorder.background': adjustColor(editorBg, 20),
        }
    });

    return 'jade-dynamic';
}

/**
 * Apply the theme to the Monaco editor
 */
export function applyMonacoTheme(
    monaco: Monaco,
    themeId: string,
    syntaxThemeId: string,
    syntaxOpts?: CustomSyntaxOptions
) {
    const themeName = createMonacoTheme(monaco, themeId, syntaxThemeId, syntaxOpts);
    monaco.editor.setTheme(themeName);

    // Monaco resets inline background styles during setTheme, so we
    // re-apply transparency on the next animation frame after Monaco settles.
    if (document.documentElement.getAttribute('data-ui-mode') === 'modern') {
        const editorBg =
            document.documentElement.style.getPropertyValue('--editor-bg') ||
            getComputedStyle(document.documentElement).getPropertyValue('--editor-bg').trim() ||
            '#1E1E1E';
        requestAnimationFrame(() => updateMonacoBackground(editorBg));
    }
}

/**
 * Load and apply saved theme from preferences
 */
export async function loadSavedTheme(
    invoke: (cmd: string, args?: any) => Promise<any>,
    monaco?: Monaco
) {
    try {
        const theme = await invoke('get_preference', { key: 'Theme', defaultValue: 'Default' }) as string;
        const useCustom = await invoke('get_preference', { key: 'UseCustomTheme', defaultValue: 'false' }) as string;
        const roundedCorners = await invoke('get_preference', { key: 'RoundedCorners', defaultValue: 'true' }) as string;
        const modernUI = await invoke('get_preference', { key: 'ModernUI', defaultValue: 'true' }) as string;
        const syntaxTheme = await invoke('get_preference', { key: 'SyntaxTheme', defaultValue: 'Default' }) as string;
        const overrideSyntax = await invoke('get_preference', { key: 'OverrideSyntax', defaultValue: 'false' }) as string;
        const useCustomBackground = await invoke('get_preference', { key: 'UseCustomBackgroundImage', defaultValue: 'false' }) as string;
        const customBackgroundImage = await invoke('get_preference', { key: 'CustomBackgroundImage', defaultValue: '' }) as string;
        const customBackgroundBlurRaw = await invoke('get_preference', { key: 'CustomBackgroundBlur', defaultValue: '8' }) as string;
        const customBackgroundBrightnessRaw = await invoke('get_preference', { key: 'CustomBackgroundBrightness', defaultValue: '100' }) as string;
        const customBackgroundSaturationRaw = await invoke('get_preference', { key: 'CustomBackgroundSaturation', defaultValue: '100' }) as string;
        const customBackgroundOpacityRaw = await invoke('get_preference', { key: 'CustomBackgroundOpacity', defaultValue: '100' }) as string;
        const customBackgroundVignetteRaw = await invoke('get_preference', { key: 'CustomBackgroundVignette', defaultValue: '0' }) as string;

        // Apply rounded corners (default to true/ON)
        applyRoundedCorners(roundedCorners === 'true');

        // Apply Modern UI mode (default to true/ON)
        applyModernUI(modernUI !== 'false');

        let activeThemeId = theme;

        if (useCustom === 'true') {
            // Load custom theme colors
            const customBg = await invoke('get_preference', { key: 'Custom_Bg', defaultValue: '#0F1928' }) as string;
            const customEditorBg = await invoke('get_preference', { key: 'Custom_EditorBg', defaultValue: '#141E2D' }) as string;
            const customTitleBar = await invoke('get_preference', { key: 'Custom_TitleBar', defaultValue: '#0F1928' }) as string;
            const customStatusBar = await invoke('get_preference', { key: 'Custom_StatusBar', defaultValue: '#005A9E' }) as string;
            const customText = await invoke('get_preference', { key: 'Custom_Text', defaultValue: '#D4D4D4' }) as string;
            const customTabBg = await invoke('get_preference', { key: 'Custom_TabBg', defaultValue: '#1E1E1E' }) as string;
            const customSelectedTab = await invoke('get_preference', { key: 'Custom_SelectedTab', defaultValue: '#007ACC' }) as string;

            activeThemeId = 'Custom';

            applyTheme('Custom', {
                windowBg: customBg,
                editorBg: customEditorBg,
                titleBar: customTitleBar,
                statusBar: customStatusBar,
                text: customText,
                tabBg: customTabBg,
                selectedTab: customSelectedTab
            });
        } else {
            applyTheme(theme);
        }

        // Apply user background image + effect settings.
        const parsedBlur = Number.parseInt(customBackgroundBlurRaw, 10);
        const customBackgroundBlur = Number.isFinite(parsedBlur)
            ? Math.min(40, Math.max(0, parsedBlur))
            : 8;
        const parsePercent = (raw: string, fallback: number) => {
            const v = Number.parseInt(raw, 10);
            return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : fallback;
        };
        applyCustomBackground({
            enabled: useCustomBackground === 'true',
            imageDataUrl: customBackgroundImage,
            blur: customBackgroundBlur,
            brightness: parsePercent(customBackgroundBrightnessRaw, 1),
            saturation: parsePercent(customBackgroundSaturationRaw, 1),
            opacity: parsePercent(customBackgroundOpacityRaw, 1),
            vignette: parsePercent(customBackgroundVignetteRaw, 0),
        });

        // Load custom syntax theme if enabled
        const useCustomSyntax = await invoke('get_preference', { key: 'UseCustomSyntaxTheme', defaultValue: 'false' }) as string;
        let customSyntaxOpts: CustomSyntaxOptions | undefined;
        if (useCustomSyntax === 'true') {
            const cs: SyntaxColors = {
                keyword: await invoke('get_preference', { key: 'CustomSyntax_Keyword', defaultValue: '#569CD6' }) as string,
                comment: await invoke('get_preference', { key: 'CustomSyntax_Comment', defaultValue: '#6A9955' }) as string,
                stringColor: await invoke('get_preference', { key: 'CustomSyntax_String', defaultValue: '#CE9178' }) as string,
                number: await invoke('get_preference', { key: 'CustomSyntax_Number', defaultValue: '#B5CEA8' }) as string,
                propertyColor: await invoke('get_preference', { key: 'CustomSyntax_Property', defaultValue: '#569CD6' }) as string,
            };
            const cb: BracketColors = {
                color1: await invoke('get_preference', { key: 'CustomSyntax_Bracket1', defaultValue: '#FFD700' }) as string,
                color2: await invoke('get_preference', { key: 'CustomSyntax_Bracket2', defaultValue: '#DA70D6' }) as string,
                color3: await invoke('get_preference', { key: 'CustomSyntax_Bracket3', defaultValue: '#87CEEB' }) as string,
            };
            customSyntaxOpts = { customSyntax: cs, customBrackets: cb };
        }

        // Apply Monaco theme if instance is available
        if (monaco) {
            let activeSyntaxTheme = useCustomSyntax === 'true' ? 'CustomSyntax' : syntaxTheme;
            if (activeSyntaxTheme === 'Default') {
                activeSyntaxTheme = (activeThemeId === 'Custom') ? 'Dark Emptiness' : activeThemeId;
            }

            applyMonacoTheme(monaco, activeThemeId, activeSyntaxTheme, customSyntaxOpts);
        }

        return {
            theme,
            useCustom: useCustom === 'true',
            roundedCorners: roundedCorners === 'true',
            syntaxTheme,
            overrideSyntax: overrideSyntax === 'true'
        };
    } catch (error) {
        console.error('[Theme] Failed to load saved theme:', error);
        // Apply defaults
        applyTheme('Default');
        applyRoundedCorners(true); // Default to ON
        applyModernUI(true); // Default to ON
        applyCustomBackground({ enabled: false, imageDataUrl: '', blur: 8 });

        if (monaco) {
            applyMonacoTheme(monaco, 'Default', 'Default');
        }

        return { theme: 'Default', useCustom: false, roundedCorners: true, modernUI: true };
    }
}
