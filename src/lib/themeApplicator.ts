// Theme application utilities
// Applies themes dynamically to the application

import { getTheme, getSyntaxColors } from './themes';
import type { Monaco } from '@monaco-editor/react';

interface CustomThemeColors {
    windowBg: string;
    editorBg: string;
    titleBar: string;
    statusBar: string;
    text: string;
    tabBg: string;
    selectedTab: string;
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

            // Update Monaco editor background
            updateMonacoBackground(theme.editorBg);
        }
    }
}

/**
 * Update Monaco editor background color
 */
function updateMonacoBackground(bgColor: string) {
    // Find all Monaco editor elements and update their background
    const editorElements = document.querySelectorAll('.monaco-editor');
    editorElements.forEach((element) => {
        (element as HTMLElement).style.backgroundColor = bgColor;
    });

    // Also update the editor background in the DOM
    const editorBg = document.querySelectorAll('.monaco-editor .overflow-guard');
    editorBg.forEach((element) => {
        (element as HTMLElement).style.backgroundColor = bgColor;
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
 * Create and register a Monaco editor theme from syntax colors
 */
export function createMonacoTheme(monaco: Monaco, themeId: string, syntaxThemeId: string) {
    const colors = getSyntaxColors(syntaxThemeId);
    const theme = getTheme(themeId);

    const editorBg = theme?.editorBg || '#1E1E1E';
    const textColor = theme?.text || '#D4D4D4';

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

            // Validation
            'inputValidation.infoBackground': '#063B49',
            'inputValidation.infoBorder': '#007ACC',
            'inputValidation.warningBackground': '#352A05',
            'inputValidation.warningBorder': '#B89500',
            'inputValidation.errorBackground': '#5A1D1D',
            'inputValidation.errorBorder': '#BE1100',
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
    syntaxThemeId: string
) {
    // If override is disabled, use the UI theme for syntax (if it has mappings)
    // or fallback to the specific syntax theme
    // For now, we'll just use the explicit syntax theme logic

    // Create the dynamic theme
    const themeName = createMonacoTheme(monaco, themeId, syntaxThemeId);

    // Apply it
    monaco.editor.setTheme(themeName);
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
        const syntaxTheme = await invoke('get_preference', { key: 'SyntaxTheme', defaultValue: 'Default' }) as string;
        const overrideSyntax = await invoke('get_preference', { key: 'OverrideSyntax', defaultValue: 'false' }) as string;

        // Apply rounded corners (default to true/ON)
        applyRoundedCorners(roundedCorners === 'true');

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

        // Apply Monaco theme if instance is available
        if (monaco) {
            // Determine syntax theme: if override is false, we might want to match UI theme
            // But for now, let's use the saved SyntaxTheme or fallback to UI theme if Default
            let activeSyntaxTheme = syntaxTheme;
            if (activeSyntaxTheme === 'Default') {
                activeSyntaxTheme = (activeThemeId === 'Custom') ? 'Dark Emptiness' : activeThemeId;
            }

            applyMonacoTheme(monaco, activeThemeId, activeSyntaxTheme);
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

        if (monaco) {
            applyMonacoTheme(monaco, 'Default', 'Default');
        }

        return { theme: 'Default', useCustom: false, roundedCorners: true };
    }
}
