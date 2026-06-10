// Theme definitions for Jade Editor
// Based on JadeCS theme system

export interface ThemeColors {
    id: string;
    displayName: string;
    windowBg: string;
    editorBg: string;
    titleBar: string;
    statusBar: string;
    text: string;
    tabBg: string;
    selectedTab: string;
    font?: string;
    icon?: string;              // Optional icon path (served from public/)
    defaultBackground?: string;   // Optional default background image path (served from public/)
    statusBarText?: string;       // Optional override for status bar text color
    titleBarText?: string;        // Optional override for title bar text color (app-name + chrome fallback)
    /** One color that drives every top-bar element (window controls, toolbar
     *  buttons, menu triggers, menu icon buttons). Light themes (e.g.
     *  YoRHa) set this dark so chrome icons stay readable. Per-element
     *  overrides via the matching CSS variables still win when set. */
    chromeForeground?: string;
    titleBarGradient?: string;    // Optional CSS gradient overlaid on the title bar background
    windowGradient?: string;      // Optional CSS gradient for the app window background
    themeBackgroundSize?: string;       // CSS background-size for defaultBackground (overrides per-theme default)
    themeBackgroundPositionX?: number; // 0–100 horizontal position for defaultBackground (default 50)
    themeBackgroundPositionY?: number; // 0–100 vertical position for defaultBackground (default 50)
    /** When true, this theme depends on the modern UI's frosted glass + gradients
     *  to look right. The theme list disables it when Modern UI is off, and
     *  toggling Modern UI off while one is active reverts to the Default theme. */
    requiresModernUI?: boolean;
    /** When true, the modern UI's glass + gradient layer is suppressed while
     *  this theme is active — even if the user has Modern UI enabled in
     *  preferences. Used by minimalist palettes that look "wrong" when
     *  semi-transparent washes mute their flat colors. */
    disableModernUIEffects?: boolean;
    /** Optional animated background effect for this theme (see themeEffects.ts).
     *  Resolves to the effect's id; alternate themes set this so they get some
     *  life by default. Users can override or disable it in the Effects tab. */
    effect?: string;
}

// Cascadia Code already covers the Cascadia family — its Mono variant
// is the same metrics minus ligatures, so we expose only one entry.
export const PRESET_FONTS = [
    'Cascadia Code',
    'Comic Sans MS',
    'Consolas',
    'Courier New',
    'Fira Code',
    'Hack',
    'Inconsolata',
    'JetBrains Mono',
    'Lucida Console',
    'Roboto Mono',
    'Source Code Pro',
    'Ubuntu Mono',
];

export interface SyntaxColors {
    keyword: string;
    comment: string;
    stringColor: string;
    number: string;
    propertyColor: string;
    symbolColor?: string;
}

export interface BracketColors {
    color1: string;
    color2: string;
    color3: string;
}

export interface FontSettings {
    uiFont?: string;
    editorFont?: string;
}

export interface FontLibraryEntry {
    name: string;      // CSS font-family name (filename without extension)
    fileName: string;  // stored file name on disk
}

// All available themes
export const THEMES: ThemeColors[] = [
    {
        id: 'Default',
        displayName: 'Cold Construct',
        windowBg: '#1E1E1E',
        editorBg: '#1E1E1E',
        titleBar: '#252526',
        statusBar: '#505050',
        text: '#D4D4D4',
        tabBg: '#252526',
        selectedTab: '#3E3E42'
    },
    {
        id: 'DarkBlue',
        displayName: 'Calm Sea',
        windowBg: '#0F1928',
        editorBg: '#141E2D',
        titleBar: '#19232E',
        statusBar: '#005A9E',
        text: '#DCE6F0',
        tabBg: '#19232E',
        selectedTab: '#2D415A'
    },
    {
        id: 'DarkRed',
        displayName: 'Crimson Forest',
        // Hue pulled from ~348° (magenta-rose) to ~355° (true crimson) and
        // the accent desaturated, per feedback that it read "between magenta
        // and red." Revert snapshot lives in chat history if needed.
        windowBg: '#280F11',
        editorBg: '#2D1416',
        titleBar: '#32191B',
        statusBar: '#A0161E',
        text: '#F0DDE1',
        tabBg: '#32191B',
        selectedTab: '#5A2D31'
    },
    {
        id: 'LightPink',
        displayName: 'Sakura Garden',
        // Text was pure black ("cancer" per feedback) → dark plum; the
        // status/accent magenta desaturated from 80%→~41% so it stops
        // screaming against the pastel surfaces.
        windowBg: '#C896B4',
        editorBg: '#D2A5BE',
        titleBar: '#B482A0',
        statusBar: '#B14A82',
        text: '#3A2233',
        tabBg: '#B482A0',
        selectedTab: '#E696BE',
        effect: 'petals'
    },
    {
        id: 'PastelBlue',
        displayName: 'Frost Lens',
        // Text was pure black → dark slate-blue (~12:1 on the pale cyan).
        // Title bar's pink-white tint replaced with a cool white so the
        // theme stays in the blue family.
        windowBg: '#E6F5FF',
        editorBg: '#D2F0FF',
        titleBar: '#EAF6FF',
        statusBar: '#50C8FF',
        text: '#1B2A38',
        tabBg: '#EBE1FF',
        selectedTab: '#A0E6FF',
        effect: 'snow'
    },
    {
        id: 'ForestGreen',
        displayName: 'Evergreen Hills',
        // Text nudged whiter and the accent desaturated (60%→~46%, same
        // hue) per "too saturated, texts could be more whiteish."
        windowBg: '#142319',
        editorBg: '#192D1E',
        titleBar: '#1E3223',
        statusBar: '#328632',
        text: '#DEEFE6',
        tabBg: '#1E3223',
        selectedTab: '#32553C',
        effect: 'fireflies'
    },
    {
        id: 'AMOLED',
        displayName: 'AMOLED',
        windowBg: '#000000',
        editorBg: '#000000',
        titleBar: '#0A0A0A',
        statusBar: '#141414',
        text: '#B4B4B4',
        tabBg: '#0A0A0A',
        selectedTab: '#1E1E1E'
    },
    {
        // Generic clean light theme (MS Word-ish): near-white surfaces,
        // soft dark-slate text (not pure black), a Word-blue status bar.
        // Flat by design — the modern UI glass/gradient wash is tuned for
        // dark palettes and muddies the clean white surfaces.
        id: 'Light',
        displayName: 'Light',
        windowBg: '#F3F3F3',
        editorBg: '#FFFFFF',
        titleBar: '#EAEAEA',
        statusBar: '#2B579A',
        text: '#1F1F1F',
        tabBg: '#ECECEC',
        selectedTab: '#FFFFFF',
        statusBarText: '#FFFFFF',
        titleBarText: '#1F1F1F',
        chromeForeground: '#1F1F1F',
        disableModernUIEffects: true,
    },
    {
        // Accessibility high-contrast: ONLY pure black + white. Elements
        // are separated by 1px white borders (see the
        // [data-active-theme='HighContrast'] rules in App.css) since the
        // flat black bg gives no other visual separation. Flat — no glass.
        id: 'HighContrast',
        displayName: 'High Contrast',
        windowBg: '#000000',
        editorBg: '#000000',
        titleBar: '#000000',
        statusBar: '#000000',
        text: '#FFFFFF',
        tabBg: '#000000',
        selectedTab: '#000000',
        statusBarText: '#FFFFFF',
        titleBarText: '#FFFFFF',
        chromeForeground: '#FFFFFF',
        disableModernUIEffects: true,
    },
    {
        id: 'Void',
        displayName: 'Deep Space',
        // Surface hues used to drift 249°–270°; locked to a single ~262°
        // and derived purely by lightness, per "keep one hue, vary the
        // tint by lightness" feedback. The statusBar (also the modern-UI
        // accent) was the bluish outlier that got pulled into line.
        windowBg: '#0D0618',
        editorBg: '#130A24',
        titleBar: '#1A0D30',
        statusBar: '#2B1353',
        text: '#B4AADC',
        tabBg: '#1A0D30',
        selectedTab: '#2E1F47',
        effect: 'stars'
    },
    {
        id: 'VioletSorrow',
        displayName: 'Orchid Origami',
        // Same hue-lock treatment as Deep Space (~262°), kept at this
        // theme's lighter levels. Mostly a tidy — surfaces were already
        // ~257–263°; the title bar was the one outlier.
        windowBg: '#130A23',
        editorBg: '#170C2A',
        titleBar: '#1E1036',
        statusBar: '#402274',
        text: '#B9AAD7',
        tabBg: '#21113C',
        selectedTab: '#4A3274',
        effect: 'rain'
    },
    {
        id: 'OrangeBurnout',
        displayName: 'Autumn Ember',
        windowBg: '#230F05',
        editorBg: '#2A1408',
        titleBar: '#32190A',
        statusBar: '#CC5500',
        text: '#FFE4D1',
        tabBg: '#32190A',
        selectedTab: '#6E2D0F',
        effect: 'embers'
    },
    {
        id: 'PurpleGrief',
        displayName: 'Stormy Sea',
        windowBg: '#190F1E',
        editorBg: '#1E1423',
        titleBar: '#231928',
        statusBar: '#462850',
        text: '#DCC8E6',
        tabBg: '#231928',
        selectedTab: '#50325A',
        effect: 'storm'
    },
    {
        id: '2077',
        displayName: '2077',
        windowBg: '#050910',
        editorBg: '#050910',
        titleBar: '#ECFF40',
        statusBar: '#ECFF40',
        text: '#D0E0F0',
        tabBg: '#080C14',
        selectedTab: '#0E1520',
        font: 'Play-Regular',
        icon: '/theme-icons/cblogo.png',
        defaultBackground: '/theme-icons/bg2077.png',
        statusBarText: '#0A0A10',
        titleBarText: '#0A0A10',
        // Yellow title bar — keep all chrome icons dark for readability.
        chromeForeground: '#0A0A10',
        requiresModernUI: true,
        windowGradient: 'linear-gradient(to bottom, #071220 0%, #030508 100%)',
        themeBackgroundSize: 'min(594px, 58%) auto',
        themeBackgroundPositionY: 52
    },
    {
        id: '2023',
        displayName: '2023',
        windowBg: '#090909',
        editorBg: '#090909',
        titleBar: '#E01010',
        statusBar: '#E01010',
        text: '#E8DDD0',
        tabBg: '#0D0808',
        selectedTab: '#1C0A0A',
        font: 'Play-Regular',
        icon: '/theme-icons/samurai.png',
        defaultBackground: '/theme-icons/bg2023.png',
        statusBarText: '#F0F0F0',
        titleBarText: '#6BFBFC',
        windowGradient: 'linear-gradient(to bottom, #2E0A0A 0%, #080405 100%)',
        themeBackgroundSize: 'auto 68%',
        themeBackgroundPositionY: 57,
        requiresModernUI: true,
    },
    {
        id: 'YoRHa',
        displayName: 'YoRHa',
        windowBg: '#D4CFBA',
        editorBg: '#CAC5AF',
        titleBar: '#B8B3A0',
        statusBar: '#C8401C',
        text: '#2A2620',
        tabBg: '#C4BFA8',
        selectedTab: '#3E3B35',
        font: 'FOT-Rodin Pro DB',
        icon: '/theme-icons/yorhalogo.png',
        defaultBackground: '/theme-icons/yorhabg.png',
        statusBarText: '#F0EBE0',
        // Light tan title bar — chrome elements need to be dark to read.
        chromeForeground: '#2A2620',
        themeBackgroundSize: '91% auto',
        themeBackgroundPositionX: 0,
        themeBackgroundPositionY: 97,
        requiresModernUI: true,
    },
    {
        id: 'LetsAllLoveLain',
        displayName: 'letsalllovelain',
        windowBg: '#000000',
        editorBg: '#000000',
        titleBar: '#D2738A',
        statusBar: '#D2738A',
        text: '#C1B492',
        tabBg: '#000000',
        selectedTab: '#2E1118',
        font: 'Lovelt__',
        icon: '/theme-icons/lain.png',
        defaultBackground: '/theme-icons/bglain.png',
        statusBarText: '#000000',
        requiresModernUI: true,
    },
    {
        // Three-color minimalist theme: pink-magenta surfaces with black
        // chrome/text and a deeper wine-red for selection + accent
        // differentiation. Syntax tokens (besides keywords) render in the
        // same wine-red so highlighted code visually echoes the UI accent.
        // Opts out of modern UI glass — the flat palette is the look.
        id: 'MilkBag',
        displayName: 'Milk Bag',
        windowBg: '#890092',
        editorBg: '#890092',
        titleBar: '#890092',
        statusBar: '#640020',
        text: '#000000',
        tabBg: '#890092',
        selectedTab: '#640020',
        statusBarText: '#000000',
        titleBarText: '#000000',
        chromeForeground: '#000000',
        disableModernUIEffects: true,
    }
];

// Syntax highlighting colors for each theme
export const SYNTAX_COLORS: Record<string, SyntaxColors> = {
    Default: {
        keyword: '#569CD6',
        comment: '#6A9955',
        stringColor: '#CE9178',
        number: '#B5CEA8',
        propertyColor: '#569CD6'
    },
    DarkBlue: {
        keyword: '#5DADE2',
        comment: '#52BE80',
        stringColor: '#F39C12',
        number: '#AED6F1',
        propertyColor: '#5DADE2'
    },
    DarkRed: {
        keyword: '#EC7063',
        comment: '#82E0AA',
        stringColor: '#F8C471',
        number: '#F1948A',
        propertyColor: '#EC7063'
    },
    LightPink: {
        keyword: '#7D3C98',
        comment: '#1E8449',
        stringColor: '#BA4A00',
        number: '#6C3483',
        propertyColor: '#7D3C98'
    },
    PastelBlue: {
        keyword: '#2874A6',
        comment: '#117A65',
        stringColor: '#D68910',
        number: '#1F618D',
        propertyColor: '#2874A6'
    },
    ForestGreen: {
        keyword: '#85C1E9',
        comment: '#52BE80',
        stringColor: '#F39C12',
        number: '#AED6F1',
        propertyColor: '#85C1E9'
    },
    AMOLED: {
        keyword: '#5DADE2',
        comment: '#52BE80',
        stringColor: '#F39C12',
        number: '#AED6F1',
        propertyColor: '#5DADE2'
    },
    Void: {
        keyword: '#BB8FCE',
        comment: '#82E0AA',
        stringColor: '#F8C471',
        number: '#D7BDE2',
        propertyColor: '#BB8FCE'
    },
    VioletSorrow: {
        keyword: '#9B7EDE',
        comment: '#7EC8A3',
        stringColor: '#E8A87C',
        number: '#C8A2E0',
        propertyColor: '#9B7EDE'
    },
    OrangeBurnout: {
        keyword: '#FF8C00',
        // Was #8B4513 (~2.3:1 on the dark bg — effectively invisible);
        // lifted to a readable warm tan (~5:1).
        comment: '#C0916F',
        stringColor: '#FFD700',
        number: '#F4A460',
        propertyColor: '#FFA07A'
    },
    PurpleGrief: {
        keyword: '#BE9FE1',
        comment: '#6F4E7C',
        stringColor: '#E1BEE7',
        number: '#9575CD',
        propertyColor: '#B39DDB'
    },
    LetsAllLoveLain: {
        keyword: '#B8697A',
        comment: '#7A5060',
        stringColor: '#C1B492',
        number: '#CC8A9A',
        propertyColor: '#A89E84'
    },
    // Most tokens stay black (the theme's default text color) so code
    // reads as plain prose; only comments and string literals pop in
    // wine-red, so quoted asset paths and notes are easy to spot at a
    // glance without flooding the file with color.
    MilkBag: {
        keyword: '#000000',
        comment: '#640020',
        stringColor: '#640020',
        number: '#000000',
        propertyColor: '#000000',
        symbolColor: '#000000',
    },
    '2023': {
        keyword: '#F65752',
        comment: '#885540',
        stringColor: '#6BFBFC',
        number: '#F65752',
        propertyColor: '#F65752'
    },
    YoRHa: {
        keyword: '#4E4B42',
        comment: '#4E4B42',
        stringColor: '#4E4B42',
        number: '#C8401C',
        propertyColor: '#4E4B42',
        symbolColor: '#4E4B42'
    },
    '2077': {
        keyword: '#EBFA5C',
        comment: '#3D5080',
        stringColor: '#6BFBFC',
        number: '#EBFA5C',
        propertyColor: '#5269B3'
    },
    Light: {
        // VS Code Light+ palette — dark tokens with proper contrast on white.
        keyword: '#0000FF',
        comment: '#008000',
        stringColor: '#A31515',
        number: '#098658',
        propertyColor: '#001080',
        symbolColor: '#1F1F1F',
    },
    HighContrast: {
        // Pure black + white only. No syntax color differentiation —
        // keywords still read as bold via the Monaco theme's fontStyle.
        keyword: '#FFFFFF',
        comment: '#FFFFFF',
        stringColor: '#FFFFFF',
        number: '#FFFFFF',
        propertyColor: '#FFFFFF',
        symbolColor: '#FFFFFF',
    },
    VSCode: {
        keyword: '#569CD6',
        comment: '#6A9955',
        stringColor: '#CE9178',
        number: '#B5CEA8',
        propertyColor: '#9CDCFE'
    },
    StandardFlint: {
        keyword: '#569CD6',
        comment: '#6A9955',
        stringColor: '#CE9178',
        number: '#B5CEA8',
        propertyColor: '#DCDCAA'
    }
};

// Bracket colorization for each theme
export const BRACKET_COLORS: Record<string, BracketColors> = {
    Default: { color1: '#FFD700', color2: '#DA70D6', color3: '#87CEEB' },
    DarkBlue: { color1: '#FFD700', color2: '#DA70D6', color3: '#00BFFF' },
    DarkRed: { color1: '#FFD700', color2: '#F06292', color3: '#FF8C00' },
    LightPink: { color1: '#4B0082', color2: '#8A2BE2', color3: '#9400D3' },
    PastelBlue: { color1: '#B8860B', color2: '#8B008B', color3: '#006400' },
    ForestGreen: { color1: '#FFD700', color2: '#40E0D0', color3: '#ADFF2F' },
    AMOLED: { color1: '#FFD700', color2: '#00FFFF', color3: '#FF00FF' },
    Void: { color1: '#FFD700', color2: '#BA55D3', color3: '#8A2BE2' },
    VioletSorrow: { color1: '#9370DB', color2: '#8A2BE2', color3: '#BA55D3' },
    OrangeBurnout: { color1: '#FF8C00', color2: '#DAA520', color3: '#E0632E' },
    PurpleGrief: { color1: '#BE9FE1', color2: '#E1BEE7', color3: '#9575CD' },
    LetsAllLoveLain: { color1: '#B8697A', color2: '#B07868', color3: '#C1B492' },
    MilkBag: { color1: '#640020', color2: '#640020', color3: '#640020' },
    '2023': { color1: '#F65752', color2: '#6BFBFC', color3: '#F65752' },
    YoRHa: { color1: '#4E4B42', color2: '#4E4B42', color3: '#4E4B42' },
    '2077': { color1: '#EBFA5C', color2: '#5269B3', color3: '#6BFBFC' },
    Light: { color1: '#0431FA', color2: '#319331', color3: '#7B3814' },
    HighContrast: { color1: '#FFFFFF', color2: '#FFFFFF', color3: '#FFFFFF' },
    VSCode: { color1: '#FFD700', color2: '#DA70D6', color3: '#179FFF' },
    StandardFlint: { color1: '#FFD700', color2: '#DA70D6', color3: '#179FFF' }
};

// Syntax theme options (includes all UI themes + standalone syntax themes)
export const SYNTAX_THEME_OPTIONS = [
    // HighContrast + Light are now real UI themes, so they come from THEMES.
    ...THEMES.map(t => ({ id: t.id, displayName: t.displayName })),
    { id: 'VSCode', displayName: 'VS Code' },
    { id: 'StandardFlint', displayName: 'Standard Flint' }
];

// Helper functions
export function getTheme(id: string): ThemeColors | undefined {
    return THEMES.find(t => t.id === id);
}

export function getSyntaxColors(id: string, customSyntax?: SyntaxColors): SyntaxColors {
    if (id === 'CustomSyntax' && customSyntax) return customSyntax;
    return SYNTAX_COLORS[id] || SYNTAX_COLORS.Default;
}

export function getBracketColors(id: string, customBrackets?: BracketColors): BracketColors {
    if (id === 'CustomSyntax' && customBrackets) return customBrackets;
    return BRACKET_COLORS[id] || BRACKET_COLORS.Default;
}
