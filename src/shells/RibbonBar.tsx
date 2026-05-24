import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import {
    SearchIcon, EditIcon, SparklesIcon, LibraryIcon,
    PaletteIcon, SettingsIcon, HelpIcon, PencilIcon, ChevronDownIcon,
    ClipboardIcon, CutIcon, CopyIcon, FileIcon, FolderOpenIcon, ClockIcon,
    SaveIcon, SaveAsIcon, LogIcon, PowerIcon, UndoIcon, RedoIcon,
    SelectAllIcon, DiffIcon, SendIcon,
} from '../components/Icons';
import { PRESET_FONTS, SYNTAX_THEME_OPTIONS, type FontLibraryEntry } from '../lib/themes';
import { fontFileNameToFamily } from '../lib/themeApplicator';
import { useShell } from './ShellContext';

type RibbonTab = 'file' | 'home' | 'insert' | 'view' | 'help';

interface RibbonButtonProps {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    title?: string;
    large?: boolean;
}

function RibbonButton({ label, icon, onClick, active, disabled, title, large }: RibbonButtonProps) {
    return (
        <button
            type="button"
            className={`ribbon-btn${large ? ' ribbon-btn-lg' : ''}${active ? ' active' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={title ?? label}
        >
            {icon && <span className="ribbon-btn-icon">{icon}</span>}
            <span className="ribbon-btn-label">{label}</span>
        </button>
    );
}

function RibbonGroup({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="ribbon-group">
            <div className="ribbon-group-content">{children}</div>
            <div className="ribbon-group-title">{title}</div>
        </div>
    );
}

/* ── Word's "Font" group, repurposed for Syntax controls.
   - The big dropdown lists every entry from SYNTAX_THEME_OPTIONS and
     writes the chosen one to the SyntaxTheme preference (same key the
     Themes dialog uses), then asks ShellContext.handleThemeApplied()
     to re-run loadSavedTheme so Monaco picks up the new tokens.
   - Font size: writes EditorFontSize pref + dispatches
     jade-editor-fontsize-changed; EditorPane listens and updates
     Monaco's fontSize option live.
   - Line height: writes EditorLineHeight pref + dispatches
     jade-editor-lineheight-changed; EditorPane applies it to Monaco's
     lineHeight option live. */
/* Floating dropdown that escapes the ribbon's overflow:auto clipping by
   rendering through a portal at viewport-fixed coordinates. Width and
   X position come from the trigger button's bounding rect; the popup
   itself caps at ~5-6 visible items and scrolls beyond that. */
function PortalDropdown<T extends string | number>({
    triggerRef,
    open,
    onClose,
    items,
    activeValue,
    onPick,
    minWidth,
}: {
    triggerRef: React.RefObject<HTMLElement | null>;
    open: boolean;
    onClose: () => void;
    items: Array<{ value: T; label: string }>;
    activeValue: T;
    onPick: (value: T) => void;
    minWidth?: number;
}) {
    const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
    const popRef = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) return;
        const r = triggerRef.current.getBoundingClientRect();
        setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, minWidth ?? r.width) });
    }, [open, triggerRef, minWidth]);

    useEffect(() => {
        if (!open) return;
        const onAway = (e: MouseEvent) => {
            const tgt = e.target as Node;
            if (popRef.current && popRef.current.contains(tgt)) return;
            if (triggerRef.current && triggerRef.current.contains(tgt)) return;
            onClose();
        };
        const onResize = () => onClose();
        window.addEventListener('mousedown', onAway);
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('mousedown', onAway);
            window.removeEventListener('resize', onResize);
        };
    }, [open, onClose, triggerRef]);

    if (!open || !pos) return null;
    return createPortal(
        <div
            ref={popRef}
            className="ribbon-dropdown-portal"
            style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
        >
            {items.map(it => (
                <button
                    key={String(it.value)}
                    type="button"
                    className={`ribbon-dropdown-item${it.value === activeValue ? ' active' : ''}`}
                    onClick={() => { onPick(it.value); onClose(); }}
                >
                    {it.label}
                </button>
            ))}
        </div>,
        document.body
    );
}

function SyntaxRibbonGroup({
    onApplied,
}: {
    onApplied: () => void;
}) {
    const [syntaxTheme, setSyntaxTheme] = useState('Default');
    const [fontSize, setFontSize] = useState(14);
    const [fontSizeText, setFontSizeText] = useState('14');
    const [lineHeight, setLineHeight] = useState(0); // 0 = auto (Monaco default)
    const [themeOpen, setThemeOpen] = useState(false);
    const [lhOpen, setLhOpen] = useState(false);
    const themeBtnRef = useRef<HTMLButtonElement | null>(null);
    const lhBtnRef = useRef<HTMLButtonElement | null>(null);
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const t = await invoke<string>('get_preference', { key: 'SyntaxTheme', defaultValue: 'Default' });
            if (!cancelled) setSyntaxTheme(t || 'Default');
            const sz = await invoke<string>('get_preference', { key: 'EditorFontSize', defaultValue: '14' });
            const szNum = Number(sz) || 14;
            if (!cancelled) { setFontSize(szNum); setFontSizeText(String(szNum)); }
            const lh = await invoke<string>('get_preference', { key: 'EditorLineHeight', defaultValue: '0' });
            if (!cancelled) setLineHeight(Number(lh) || 0);
        })();
        const onSize = (e: Event) => {
            const n = Number((e as CustomEvent).detail);
            if (Number.isFinite(n)) { setFontSize(n); setFontSizeText(String(n)); }
        };
        const onLh = (e: Event) => {
            const n = Number((e as CustomEvent).detail);
            if (Number.isFinite(n)) setLineHeight(n);
        };
        window.addEventListener('jade-editor-fontsize-changed', onSize);
        window.addEventListener('jade-editor-lineheight-changed', onLh);
        return () => {
            cancelled = true;
            window.removeEventListener('jade-editor-fontsize-changed', onSize);
            window.removeEventListener('jade-editor-lineheight-changed', onLh);
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    }, []);

    const applySyntaxTheme = async (id: string) => {
        // SyntaxTheme + OverrideSyntax/UseCustomSyntaxTheme prefs are stored
        // as strings in preferences.json — set_preference only accepts
        // string values.
        await invoke('set_preference', { key: 'SyntaxTheme', value: id });
        await invoke('set_preference', { key: 'OverrideSyntax', value: 'true' });
        await invoke('set_preference', { key: 'UseCustomSyntaxTheme', value: 'false' });
        setSyntaxTheme(id);
        onApplied();
    };

    const applyFontSize = async (next: number) => {
        const clamped = Math.max(10, Math.min(28, Math.round(next)));
        await invoke('set_preference', { key: 'EditorFontSize', value: String(clamped) });
        setFontSize(clamped);
        setFontSizeText(String(clamped));
        window.dispatchEvent(new CustomEvent('jade-editor-fontsize-changed', { detail: clamped }));
    };

    const applyLineHeight = async (next: number) => {
        const valid = next === 0 ? 0 : Math.max(1.0, Math.min(2.5, next));
        await invoke('set_preference', { key: 'EditorLineHeight', value: String(valid) });
        setLineHeight(valid);
        window.dispatchEvent(new CustomEvent('jade-editor-lineheight-changed', { detail: valid }));
    };

    /** Debounced commit of the font-size input. The timer is reset on
     *  every keystroke, so the apply only fires 500ms *after* the user
     *  stops typing. Blur does NOT commit early — leaving the box still
     *  waits the full 500ms — only Enter forces an immediate commit. */
    const scheduleFontSizeCommit = (text: string) => {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = window.setTimeout(() => {
            debounceTimer.current = null;
            const n = parseInt(text, 10);
            if (!Number.isFinite(n)) {
                setFontSizeText(String(fontSize));
                return;
            }
            applyFontSize(n);
        }, 500);
    };

    const commitFontSizeNow = () => {
        if (debounceTimer.current) { clearTimeout(debounceTimer.current); debounceTimer.current = null; }
        const n = parseInt(fontSizeText, 10);
        if (!Number.isFinite(n)) {
            setFontSizeText(String(fontSize));
            return;
        }
        applyFontSize(n);
    };

    /** A▲ / A▼ click handler — same debounce path as typing. Updates the
     *  displayed value instantly and resets the 500ms timer, so spamming
     *  the button only re-applies to Monaco once after you stop. Reads
     *  from the displayed text so consecutive clicks accumulate. */
    const bumpFontSize = (delta: number) => {
        const current = parseInt(fontSizeText, 10);
        const base = Number.isFinite(current) ? current : fontSize;
        const next = Math.max(10, Math.min(28, base + delta));
        setFontSizeText(String(next));
        scheduleFontSizeCommit(String(next));
    };

    const resetSyntaxControls = async () => {
        // Re-derive the syntax theme from the active UI theme. Custom
        // themes don't have a matching SYNTAX_COLORS entry, so fall back
        // to 'Default' the way loadSavedTheme does internally.
        const useCustom = await invoke<string>('get_preference', { key: 'UseCustomTheme', defaultValue: 'false' });
        const themeId = await invoke<string>('get_preference', { key: 'Theme', defaultValue: 'Default' });
        const targetSyntax = (useCustom === 'true' || themeId === 'Custom') ? 'Default' : themeId;

        await invoke('set_preference', { key: 'SyntaxTheme', value: targetSyntax });
        await invoke('set_preference', { key: 'OverrideSyntax', value: 'false' });
        await invoke('set_preference', { key: 'UseCustomSyntaxTheme', value: 'false' });
        await invoke('set_preference', { key: 'EditorFontSize', value: '14' });
        await invoke('set_preference', { key: 'EditorLineHeight', value: '0' });
        setSyntaxTheme(targetSyntax);
        setFontSize(14);
        setFontSizeText('14');
        setLineHeight(0);
        window.dispatchEvent(new CustomEvent('jade-editor-fontsize-changed', { detail: 14 }));
        window.dispatchEvent(new CustomEvent('jade-editor-lineheight-changed', { detail: 0 }));
        onApplied();
    };

    const lineHeightOptions: Array<{ value: number; label: string }> = [
        { value: 0,    label: 'Default' },
        { value: 1.0,  label: '1.0' },
        { value: 1.15, label: '1.15' },
        { value: 1.3,  label: '1.3' },
        { value: 1.5,  label: '1.5' },
        { value: 1.8,  label: '1.8' },
        { value: 2.0,  label: '2.0' },
    ];

    const activeThemeLabel =
        SYNTAX_THEME_OPTIONS.find(o => o.id === syntaxTheme)?.displayName ?? syntaxTheme;

    return (
        <div className="ribbon-group ribbon-group-syntax">
            <div className="ribbon-group-content ribbon-group-syntax-content">
                <div className="syntax-row">
                    <button
                        ref={themeBtnRef}
                        type="button"
                        className="ribbon-syntax-scheme-btn"
                        onClick={() => setThemeOpen(o => !o)}
                        title="Syntax theme"
                    >
                        <span className="ribbon-syntax-scheme-label">{activeThemeLabel}</span>
                        <ChevronDownIcon size={11} strokeWidth={1.6} />
                    </button>
                    <PortalDropdown
                        triggerRef={themeBtnRef}
                        open={themeOpen}
                        onClose={() => setThemeOpen(false)}
                        items={SYNTAX_THEME_OPTIONS.map(o => ({ value: o.id, label: o.displayName }))}
                        activeValue={syntaxTheme}
                        onPick={applySyntaxTheme}
                        minWidth={200}
                    />
                    <input
                        type="text"
                        inputMode="numeric"
                        className="ribbon-fontsize-input"
                        title="Font size"
                        value={fontSizeText}
                        onChange={e => {
                            const cleaned = e.target.value.replace(/[^\d]/g, '');
                            setFontSizeText(cleaned);
                            scheduleFontSizeCommit(cleaned);
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                commitFontSizeNow();
                                (e.currentTarget as HTMLInputElement).blur();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="ribbon-fontsize-tweak"
                        title="Increase font size"
                        onClick={() => bumpFontSize(1)}
                    >
                        <span className="ribbon-fontsize-tweak-letter">A</span>
                        <span className="ribbon-fontsize-tweak-arrow">▲</span>
                    </button>
                    <button
                        type="button"
                        className="ribbon-fontsize-tweak"
                        title="Decrease font size"
                        onClick={() => bumpFontSize(-1)}
                    >
                        <span className="ribbon-fontsize-tweak-letter">A</span>
                        <span className="ribbon-fontsize-tweak-arrow">▼</span>
                    </button>
                </div>
                <div className="syntax-row">
                    <button
                        ref={lhBtnRef}
                        type="button"
                        className="ribbon-syntax-scheme-btn ribbon-syntax-scheme-btn-lh"
                        onClick={() => setLhOpen(o => !o)}
                        title="Line spacing"
                    >
                        <span className="ribbon-syntax-scheme-label">
                            Line spacing: {lineHeight === 0 ? 'Default' : lineHeight}
                        </span>
                        <ChevronDownIcon size={11} strokeWidth={1.6} />
                    </button>
                    <PortalDropdown
                        triggerRef={lhBtnRef}
                        open={lhOpen}
                        onClose={() => setLhOpen(false)}
                        items={lineHeightOptions}
                        activeValue={lineHeight}
                        onPick={applyLineHeight}
                        minWidth={140}
                    />
                    <button
                        type="button"
                        className="ribbon-syntax-reset"
                        title="Reset font size, line spacing, and syntax theme"
                        onClick={resetSyntaxControls}
                    >
                        ⟲
                    </button>
                </div>
            </div>
            <div className="ribbon-group-title">Syntax</div>
        </div>
    );
}

/* ── Word's "Styles" gallery, here used as a Fonts gallery. Each cell
   shows the font name in its own typeface; clicking applies it via
   the same EditorFont preference + jade-editor-font-changed event the
   Themes dialog uses, so changing the font here is identical to
   changing it from settings. */
/* Number of font cells visible at all times in the ribbon. The "more"
 * button on the right opens a portal popup with everything else. */
const FONTS_VISIBLE_COUNT = 7;

function FontsRibbonGroup() {
    const [editorFont, setEditorFont] = useState('');
    const [library, setLibrary] = useState<FontLibraryEntry[]>([]);
    const [moreOpen, setMoreOpen] = useState(false);
    const moreBtnRef = useRef<HTMLButtonElement | null>(null);
    const morePopRef = useRef<HTMLDivElement | null>(null);
    const [popPos, setPopPos] = useState<{ left: number; top: number } | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const f = await invoke<string>('get_preference', { key: 'EditorFont', defaultValue: '' });
            if (!cancelled) setEditorFont(f || '');
            try {
                const stored = await invoke<string[]>('get_stored_fonts');
                if (!cancelled && Array.isArray(stored)) {
                    setLibrary(stored.map(fileName => ({ name: fontFileNameToFamily(fileName), fileName })));
                    // Eagerly load font faces so previews render in the
                    // ribbon cells even before the user picks one.
                    for (const fileName of stored) {
                        try {
                            const url = await invoke<string>('get_font_data_url', { fileName });
                            const family = fontFileNameToFamily(fileName);
                            if (![...document.fonts].some(f => f.family === family)) {
                                const ff = new FontFace(family, `url("${url}")`);
                                await ff.load();
                                document.fonts.add(ff);
                            }
                        } catch { /* preview is non-critical */ }
                    }
                }
            } catch { /* command may not exist on older builds */ }
        })();
        const onChange = () => {
            (async () => {
                const f = await invoke<string>('get_preference', { key: 'EditorFont', defaultValue: '' });
                setEditorFont(f || '');
            })();
        };
        window.addEventListener('jade-editor-font-changed', onChange);
        return () => {
            cancelled = true;
            window.removeEventListener('jade-editor-font-changed', onChange);
        };
    }, []);

    useLayoutEffect(() => {
        if (!moreOpen || !moreBtnRef.current) return;
        const r = moreBtnRef.current.getBoundingClientRect();
        // Anchor the popup so its right edge aligns with the button's
        // right edge, then clamp to the viewport so it never spills off.
        const popupWidth = 720;
        const margin = 8;
        const desiredLeft = r.right - popupWidth;
        const clampedLeft = Math.max(margin, Math.min(desiredLeft, window.innerWidth - popupWidth - margin));
        setPopPos({ left: clampedLeft, top: r.bottom + 4 });
    }, [moreOpen]);

    useEffect(() => {
        if (!moreOpen) return;
        const onAway = (e: MouseEvent) => {
            const t = e.target as Node;
            if (morePopRef.current?.contains(t)) return;
            if (moreBtnRef.current?.contains(t)) return;
            setMoreOpen(false);
        };
        window.addEventListener('mousedown', onAway);
        return () => window.removeEventListener('mousedown', onAway);
    }, [moreOpen]);

    const apply = async (name: string) => {
        await invoke('set_preference', { key: 'EditorFont', value: name });
        setEditorFont(name);
        const resolved = name ? `"${name}", monospace` : '';
        window.dispatchEvent(new CustomEvent('jade-editor-font-changed', { detail: resolved }));
    };

    /** Open a file picker and import a TTF/OTF/WOFF/WOFF2 into the user's
     *  font library. Mirrors the Themes-dialog import flow so it shares
     *  the same backend command + storage layout. */
    const importFont = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.ttf,.otf,.woff,.woff2';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
                alert('Font file must be smaller than 10 MB.');
                return;
            }
            const reader = new FileReader();
            reader.onload = async () => {
                const dataUrl = reader.result as string;
                try {
                    const storedName = await invoke<string>('store_font', { dataUrl, fileName: file.name });
                    const family = fontFileNameToFamily(storedName);
                    const entry: FontLibraryEntry = { name: family, fileName: storedName };
                    setLibrary(prev => prev.some(f => f.fileName === storedName)
                        ? prev
                        : [...prev, entry].sort((a, b) => a.name.localeCompare(b.name))
                    );
                    try {
                        const url = await invoke<string>('get_font_data_url', { fileName: storedName });
                        const ff = new FontFace(family, `url("${url}")`);
                        await ff.load();
                        document.fonts.add(ff);
                    } catch { /* preview is non-critical */ }
                } catch (err) {
                    alert(`Failed to import font: ${err}`);
                }
            };
            reader.readAsDataURL(file);
        };
        input.click();
    };

    const all: string[] = ['', ...PRESET_FONTS, ...library.map(e => e.name)];
    const visible = all.slice(0, FONTS_VISIBLE_COUNT);

    const cell = (name: string, key?: string) => {
        const active = (editorFont || '') === name;
        const display = name || 'Default';
        return (
            <button
                key={key ?? (name || '__default__')}
                type="button"
                className={`ribbon-fonts-cell${active ? ' active' : ''}`}
                onClick={() => apply(name)}
                title={name || 'Theme / Monaco default font'}
            >
                <span
                    className="ribbon-fonts-cell-text"
                    style={name ? { fontFamily: `"${name}", monospace` } : undefined}
                >
                    {display}
                </span>
            </button>
        );
    };

    return (
        <div className="ribbon-group ribbon-group-fonts">
            <div className="ribbon-group-content ribbon-group-fonts-content">
                <div className="ribbon-fonts-grid">
                    {visible.map((n, i) => cell(n, n || `__default__${i}`))}
                </div>
                <button
                    ref={moreBtnRef}
                    type="button"
                    className="ribbon-fonts-more"
                    title="More fonts…"
                    onClick={() => setMoreOpen(o => !o)}
                >
                    <ChevronDownIcon size={12} strokeWidth={1.6} />
                </button>
                {moreOpen && popPos && createPortal(
                    <div
                        ref={morePopRef}
                        className="ribbon-fonts-more-popup"
                        style={{ left: popPos.left, top: popPos.top }}
                    >
                        <div className="ribbon-fonts-popup-grid">
                            {all.map((name, i) => {
                                const active = (editorFont || '') === name;
                                const display = name || 'Default';
                                return (
                                    <button
                                        key={name || `__default__${i}`}
                                        type="button"
                                        className={`ribbon-fonts-popup-cell${active ? ' active' : ''}`}
                                        onClick={() => { apply(name); setMoreOpen(false); }}
                                        title={name || 'Theme / Monaco default font'}
                                    >
                                        <span
                                            className="ribbon-fonts-popup-cell-text"
                                            style={name ? { fontFamily: `"${name}", monospace` } : undefined}
                                        >
                                            {display}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="ribbon-fonts-popup-divider" />
                        <div className="ribbon-fonts-popup-actions">
                            <button
                                type="button"
                                className="ribbon-fonts-popup-action"
                                onClick={() => { importFont(); }}
                            >
                                <span className="ribbon-fonts-popup-action-icon">A+</span>
                                <span>Import font…</span>
                            </button>
                            <button
                                type="button"
                                className="ribbon-fonts-popup-action"
                                onClick={() => { apply(''); setMoreOpen(false); }}
                            >
                                <span className="ribbon-fonts-popup-action-icon">A⟲</span>
                                <span>Reset to default</span>
                            </button>
                        </div>
                    </div>,
                    document.body
                )}
            </div>
            <div className="ribbon-group-title">Fonts</div>
        </div>
    );
}

/**
 * MS-Word-style ribbon: category tabs across the top, large action
 * buttons grouped underneath. Each "tool" the app offers has a button
 * that opens it as its own panel/window — no menus.
 */
export default function RibbonBar() {
    const s = useShell();
    const [activeTab, setActiveTab] = useState<RibbonTab>('home');
    const [showRecent, setShowRecent] = useState(false);

    const binDisabled = !s.isBinFileOpen();

    return (
        <div className="ribbon-bar">
            <div className="ribbon-tabs">
                {(['file', 'home', 'insert', 'view', 'help'] as RibbonTab[]).map(t => (
                    <button
                        key={t}
                        type="button"
                        className={`ribbon-tab${activeTab === t ? ' active' : ''}${t === 'file' ? ' ribbon-tab-file' : ''}`}
                        onClick={() => setActiveTab(t)}
                    >
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                ))}
            </div>

            {activeTab === 'file' && (
                <div className="ribbon-body">
                    <RibbonGroup title="New / Open">
                        <RibbonButton large label="New" icon={<FileIcon size={22} />} onClick={s.onNew} title="New file (Ctrl+N)" />
                        <RibbonButton
                            large label="Open"
                            icon={<FolderOpenIcon size={22} />}
                            onClick={s.onOpen}
                            disabled={s.openFileDisabled}
                            title="Open file..."
                        />
                        <div className="ribbon-recent-wrap">
                            <RibbonButton
                                label="Recent"
                                icon={<ClockIcon size={16} />}
                                onClick={() => setShowRecent(v => !v)}
                                title="Recent files"
                            />
                            {showRecent && s.recentFiles.length > 0 && (
                                <div className="ribbon-recent-pop" onMouseLeave={() => setShowRecent(false)}>
                                    {s.recentFiles.slice(0, 10).map((p, i) => {
                                        const fileName = p.split(/[\\/]/).pop() || p;
                                        return (
                                            <button
                                                key={i}
                                                type="button"
                                                className="ribbon-recent-item"
                                                title={p}
                                                disabled={s.openFileDisabled}
                                                onClick={() => { setShowRecent(false); s.openFileFromPath(p); }}
                                            >
                                                {fileName}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </RibbonGroup>

                    <RibbonGroup title="Save">
                        <RibbonButton large label="Save" icon={<SaveIcon size={22} />} onClick={s.onSave} title="Save (Ctrl+S)" />
                        <RibbonButton large label="Save As" icon={<SaveAsIcon size={22} />} onClick={s.onSaveAs} title="Save As (Ctrl+Shift+S)" />
                    </RibbonGroup>

                    <RibbonGroup title="Logs">
                        <RibbonButton label="Open Log" icon={<LogIcon size={16} />} onClick={s.onOpenLog} />
                    </RibbonGroup>

                    <RibbonGroup title="App">
                        <RibbonButton
                            label="Main page"
                            icon={<FileIcon size={16} />}
                            onClick={() => s.setWelcomeOverride('force')}
                            title="Open Welcome / Main page"
                        />
                        <RibbonButton label="Exit" icon={<PowerIcon size={16} />} onClick={s.onClose} />
                    </RibbonGroup>
                </div>
            )}

            {activeTab === 'home' && (
                <div className="ribbon-body">
                    {/* Clipboard: Word-style — big Paste on the left, small
                        Cut + Copy stacked next to it. */}
                    <RibbonGroup title="Clipboard">
                        <RibbonButton
                            large
                            label="Paste"
                            icon={<ClipboardIcon size={26} />}
                            onClick={s.onPaste}
                            title="Paste (Ctrl+V)"
                        />
                        <div className="ribbon-stack">
                            <RibbonButton
                                label="Cut"
                                icon={<CutIcon size={14} />}
                                onClick={s.onCut}
                                title="Cut (Ctrl+X)"
                            />
                            <RibbonButton
                                label="Copy"
                                icon={<CopyIcon size={14} />}
                                onClick={s.onCopy}
                                title="Copy (Ctrl+C)"
                            />
                        </div>
                    </RibbonGroup>

                    <RibbonGroup title="History">
                        <RibbonButton label="Undo" icon={<UndoIcon size={16} />} onClick={s.onUndo} title="Undo (Ctrl+Z)" />
                        <RibbonButton label="Redo" icon={<RedoIcon size={16} />} onClick={s.onRedo} title="Redo (Ctrl+Y)" />
                    </RibbonGroup>

                    <RibbonGroup title="Find">
                        {/* One button for the combined Find+Replace
                            panel — the dedicated Replace button was
                            redundant. */}
                        <RibbonButton
                            large
                            label="Find"
                            icon={<SearchIcon size={22} />}
                            onClick={s.onFind}
                            active={s.replaceWidgetOpen}
                            title="Find / Replace (Ctrl+F)"
                        />
                    </RibbonGroup>

                    <RibbonGroup title="Selection">
                        <RibbonButton label="Select All" icon={<SelectAllIcon size={16} />} onClick={s.onSelectAll} title="Select All (Ctrl+A)" />
                        <RibbonButton label="Compare Files" icon={<DiffIcon size={16} />} onClick={s.onCompareFiles} title="Compare Files (Ctrl+D)" />
                        <RibbonButton
                            label="Scan Assets"
                            icon={<DiffIcon size={16} />}
                            onClick={s.onScanBinAssets}
                            disabled={!s.isBinFileOpen()}
                            title={s.isBinFileOpen()
                                ? 'Scan this BIN + linked BINs and report every asset they reference'
                                : 'Open a BIN file to scan its assets'}
                        />
                    </RibbonGroup>

                    <SyntaxRibbonGroup onApplied={s.handleThemeApplied} />

                    <FontsRibbonGroup />
                </div>
            )}

            {activeTab === 'insert' && (
                <div className="ribbon-body">
                    <RibbonGroup title="Editing Tools">
                        <RibbonButton
                            large
                            label="General Edit"
                            icon={<EditIcon size={22} />}
                            onClick={s.onGeneralEdit}
                            active={s.generalEditPanelOpen}
                            title="General Editing (Ctrl+O)"
                        />
                        <RibbonButton
                            large
                            label="Particle"
                            icon={<SparklesIcon size={22} />}
                            onClick={s.onParticlePanel}
                            active={s.particlePanelOpen}
                            disabled={binDisabled}
                            title={binDisabled ? 'Particle editing only works on .bin or .py files' : 'Particle Editing (Ctrl+P)'}
                        />
                        <RibbonButton
                            label="Particle Window"
                            icon={<SparklesIcon size={16} />}
                            onClick={s.onParticleEditor}
                            disabled={binDisabled}
                            title={binDisabled ? 'Open as a separate window — bin/py only' : 'Open particle editor as a window'}
                        />
                    </RibbonGroup>

                    <RibbonGroup title="Material">
                        <RibbonButton
                            large
                            label="Material Library"
                            icon={<LibraryIcon size={22} />}
                            onClick={s.onMaterialLibrary}
                        />
                    </RibbonGroup>


                    <RibbonGroup title="Quartz">
                        <RibbonButton label="Send: Paint" icon={<SendIcon size={16} />} onClick={() => s.onSendToQuartz('paint')} disabled={binDisabled} />
                        <RibbonButton label="Send: Port" icon={<SendIcon size={16} />} onClick={() => s.onSendToQuartz('port')} disabled={binDisabled} />
                        <RibbonButton label="Send: BIN Editor" icon={<SendIcon size={16} />} onClick={() => s.onSendToQuartz('bineditor')} disabled={binDisabled} />
                        <RibbonButton label="Send: VFX Hub" icon={<SendIcon size={16} />} onClick={() => s.onSendToQuartz('vfxhub')} disabled={binDisabled} />
                    </RibbonGroup>
                </div>
            )}

            {activeTab === 'view' && (
                <div className="ribbon-body">
                    <RibbonGroup title="Themes">
                        <RibbonButton
                            large
                            label="Themes"
                            icon={<PaletteIcon size={22} />}
                            onClick={s.onThemes}
                        />
                    </RibbonGroup>

                    <RibbonGroup title="App">
                        <RibbonButton
                            large
                            label="Settings"
                            icon={<SettingsIcon size={22} />}
                            onClick={s.onSettings}
                        />
                        <RibbonButton
                            label="Preferences"
                            icon={<PencilIcon size={16} />}
                            onClick={s.onPreferences}
                        />
                    </RibbonGroup>
                </div>
            )}

            {activeTab === 'help' && (
                <div className="ribbon-body">
                    <RibbonGroup title="About">
                        <RibbonButton
                            large
                            label="About Jade"
                            icon={<HelpIcon size={22} />}
                            onClick={s.onAbout}
                        />
                    </RibbonGroup>
                </div>
            )}
        </div>
    );
}
