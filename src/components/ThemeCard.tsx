import { THEMES, SYNTAX_COLORS } from '../lib/themes';
import './ThemeCard.css';

/** Colors needed to draw a theme's mini app-preview card, derived from
 *  the real theme + its syntax palette so the card matches the editor. */
export interface ThemePreview {
    id: string;
    name: string;
    bg: string;
    bar: string;
    accent: string;
    /** UI text color for the name label — uses `titleBarText` when the
     *  theme defines one (chrome-readability override) so muted-keyword
     *  themes (2023 / 2077 / YoRHa) stay legible. */
    text: string;
    lineA: string;  // keyword
    lineB: string;  // comment
    lineC: string;  // string
}

export function buildPreview(id: string): ThemePreview {
    const t = THEMES.find(th => th.id === id) ?? THEMES[0];
    const syn = SYNTAX_COLORS[id] ?? SYNTAX_COLORS.Default;
    return {
        id: t.id,
        name: t.displayName,
        bg: t.windowBg,
        bar: t.titleBar,
        accent: t.statusBar,
        text: t.titleBarText || t.text,
        lineA: syn.keyword,
        lineB: syn.comment,
        lineC: syn.stringColor,
    };
}

interface ThemeCardProps {
    /** Theme to render. Omit (or pass `placeholder`) for an empty
     *  "coming soon" slot. */
    themeId?: string;
    selected?: boolean;
    /** Greyed-out + non-interactive (e.g. requires Modern UI). */
    locked?: boolean;
    title?: string;
    /** Renders a disabled placeholder card with this label instead of a
     *  real theme — used for reserved slots (Light / High Contrast). */
    placeholder?: { name: string; sub?: string };
    onClick?: () => void;
}

/**
 * A theme as a little app-mockup card: title bar strip, an editor area
 * with three colored "code lines", a status-bar strip, and a name label.
 * Shared between the onboarding guide and the Themes dialog.
 */
export default function ThemeCard({ themeId, selected, locked, title, placeholder, onClick }: ThemeCardProps) {
    if (placeholder || !themeId) {
        return (
            <button
                type="button"
                className="theme-card theme-card-placeholder"
                disabled
                title={placeholder?.sub ?? placeholder?.name}
            >
                <div className="theme-card-preview theme-card-preview-empty">
                    <span className="theme-card-soon">Soon</span>
                </div>
                <div className="theme-card-name">{placeholder?.name ?? '—'}</div>
            </button>
        );
    }

    const t = buildPreview(themeId);
    return (
        <button
            type="button"
            className={`theme-card${selected ? ' selected' : ''}${locked ? ' locked' : ''}`}
            onClick={() => { if (!locked) onClick?.(); }}
            disabled={locked}
            title={title ?? t.name}
        >
            <div className="theme-card-preview" style={{ background: t.bg }}>
                <div className="theme-card-bar" style={{ background: t.bar }} />
                <div className="theme-card-editor" style={{ background: t.bg }}>
                    <div className="theme-card-line" style={{ background: t.lineA, width: '70%' }} />
                    <div className="theme-card-line" style={{ background: t.lineB, width: '50%' }} />
                    <div className="theme-card-line" style={{ background: t.lineC, width: '60%' }} />
                </div>
                <div className="theme-card-status" style={{ background: t.accent }} />
            </div>
            <div className="theme-card-name" style={{ background: t.bar, color: t.text }}>{t.name}</div>
        </button>
    );
}
