/**
 * SkinModPicker — multi-select skin/chroma selector for the "Extract as
 * skin mod" dialog.
 *
 * Like PortalDropdown (themed select, portal-rendered menu so dialog /
 * accordion overflow can't clip it) with two extras the extractor needs:
 *   1. Each row shows the skin's real name (from CDragon) next to its
 *      number — "Dynasty Ahri — Skin 1".
 *   2. Skins that have chromas present in the WAD get a chevron toggle on
 *      the right; expanding reveals the chromas (by name) as rows.
 *
 * Selection is a SET — every skin/chroma row has a checkbox, so the user
 * can tick multiple targets and the extractor pulls files for all of them.
 * Each selection is a (skin hash, chroma slot) pair: the hash is always the
 * PARENT skin's SKN chunk (the extraction root); `chromaSlot` is null for a
 * base skin row, or the chroma's `skin{N}` slot when a chroma is ticked.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Search as SearchIcon } from 'lucide-react';
import './SkinModPicker.css';

export interface SkinModChroma {
    /** The chroma's `skin{N}` slot number (CDragon id % 1000). */
    slot: number;
    name: string;
}

export interface SkinModSkin {
    /** Parent SKN chunk hash — the extraction root passed to Rust. */
    hash: string;
    skinId: number;
    /** Full display label, e.g. "Dynasty Ahri — Skin 1". */
    label: string;
    /** SKN WAD path (tooltip / fallback display). */
    path: string;
    champion: string;
    chromas: SkinModChroma[];
}

export interface SkinModSelectionItem {
    hash: string;
    chromaSlot: number | null;
}

interface Props {
    skins: SkinModSkin[];
    selected: SkinModSelectionItem[];
    onToggle: (hash: string, chromaSlot: number | null) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
}

/** Stable key for a selection pair — membership lookups + React keys. */
const selKey = (hash: string, slot: number | null) => `${hash}:${slot ?? 'base'}`;

export default function SkinModPicker({
    skins,
    selected,
    onToggle,
    placeholder = 'Pick skins…',
    disabled = false,
    className = '',
}: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; maxHeight: number }>(
        { top: 0, left: 0, width: 0, maxHeight: 360 },
    );

    const selectedKeys = useMemo(
        () => new Set(selected.map((s) => selKey(s.hash, s.chromaSlot))),
        [selected],
    );

    // Trigger summary: 0 → placeholder, 1 → that item's label, N → count.
    const triggerLabel = useMemo(() => {
        if (selected.length === 0) return null;
        if (selected.length === 1) {
            const s = selected[0];
            const skin = skins.find((k) => k.hash === s.hash);
            if (!skin) return '1 selected';
            if (s.chromaSlot == null) return skin.label;
            const chroma = skin.chromas.find((c) => c.slot === s.chromaSlot);
            return chroma ? `${skin.label} — ${chroma.name}` : skin.label;
        }
        return `${selected.length} selected`;
    }, [selected, skins]);

    const searchable = skins.length > 8;

    const q = query.trim().toLowerCase();
    const filtered = useMemo(() => {
        if (!q) return skins;
        const out: SkinModSkin[] = [];
        for (const s of skins) {
            if (s.label.toLowerCase().includes(q)) {
                out.push(s);
                continue;
            }
            const matchedChromas = s.chromas.filter((c) =>
                c.name.toLowerCase().includes(q),
            );
            if (matchedChromas.length) out.push({ ...s, chromas: matchedChromas });
        }
        return out;
    }, [skins, q]);

    const updateMenuPos = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const menuW = Math.max(r.width, 200);
        let left = r.left;
        if (left + menuW > vw - margin) {
            left = Math.max(margin, vw - menuW - margin);
        }
        const spaceBelow = vh - r.bottom - margin;
        const spaceAbove = r.top - margin;
        const desiredMax = 360;
        let top: number;
        let maxHeight: number;
        if (spaceBelow >= 180 || spaceBelow >= spaceAbove) {
            top = r.bottom + 4;
            maxHeight = Math.min(desiredMax, spaceBelow);
        } else {
            maxHeight = Math.min(desiredMax, spaceAbove);
            top = r.top - 4 - maxHeight;
        }
        setMenuPos({ top, left, width: menuW, maxHeight });
    }, []);

    useLayoutEffect(() => {
        if (!open) return;
        updateMenuPos();
        const onScroll = () => updateMenuPos();
        const onResize = () => updateMenuPos();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
        };
    }, [open, updateMenuPos]);

    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            const t = e.target as Node;
            if (triggerRef.current?.contains(t)) return;
            if (menuRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        document.addEventListener('keydown', onKey);
        if (searchable) queueMicrotask(() => searchRef.current?.focus());
        return () => {
            document.removeEventListener('mousedown', onClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, searchable]);

    const toggleExpand = (hash: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(hash)) next.delete(hash);
            else next.add(hash);
            return next;
        });
    };

    return (
        <div className="skinmod-pick">
            <button
                ref={triggerRef}
                type="button"
                disabled={disabled}
                className={`skinmod-pick-trigger${open ? ' is-open' : ''} ${className}`.trim()}
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className="skinmod-pick-value">{triggerLabel ?? placeholder}</span>
                <ChevronDown size={13} className="skinmod-pick-caret" />
            </button>
            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        className="skinmod-pick-menu"
                        role="listbox"
                        aria-multiselectable="true"
                        style={{
                            position: 'fixed',
                            top: `${menuPos.top}px`,
                            left: `${menuPos.left}px`,
                            width: `${menuPos.width}px`,
                            maxHeight: `${menuPos.maxHeight}px`,
                        }}
                    >
                        {searchable && (
                            <div className="skinmod-pick-search">
                                <SearchIcon size={12} className="skinmod-pick-search-icon" />
                                <input
                                    ref={searchRef}
                                    type="text"
                                    className="skinmod-pick-search-input"
                                    placeholder="Filter…"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                />
                            </div>
                        )}
                        <div className="skinmod-pick-list">
                            {filtered.length === 0 ? (
                                <div className="skinmod-pick-empty">
                                    {q ? `No matches for “${query}”.` : 'No skins.'}
                                </div>
                            ) : (
                                filtered.map((s) => {
                                    // While filtering, force chroma rows open so
                                    // matches are visible without an extra click.
                                    const isExpanded =
                                        s.chromas.length > 0 && (!!q || expanded.has(s.hash));
                                    const skinChecked = selectedKeys.has(selKey(s.hash, null));
                                    return (
                                        <div key={s.hash} className="skinmod-pick-group">
                                            <div className="skinmod-pick-row">
                                                <button
                                                    type="button"
                                                    role="option"
                                                    aria-selected={skinChecked}
                                                    className={`skinmod-pick-item${skinChecked ? ' is-checked' : ''}`}
                                                    title={s.path}
                                                    onClick={() => onToggle(s.hash, null)}
                                                >
                                                    <span className={`skinmod-pick-check${skinChecked ? ' is-checked' : ''}`}>
                                                        {skinChecked && <Check size={11} strokeWidth={3} />}
                                                    </span>
                                                    <span className="skinmod-pick-label">{s.label}</span>
                                                </button>
                                                {s.chromas.length > 0 && (
                                                    <button
                                                        type="button"
                                                        className="skinmod-pick-expand"
                                                        aria-label={isExpanded ? 'Hide chromas' : 'Show chromas'}
                                                        title={`${s.chromas.length} chroma${s.chromas.length === 1 ? '' : 's'}`}
                                                        // Filtering force-opens, so the
                                                        // toggle is inert until cleared.
                                                        disabled={!!q}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            toggleExpand(s.hash);
                                                        }}
                                                    >
                                                        {isExpanded ? (
                                                            <ChevronDown size={13} />
                                                        ) : (
                                                            <ChevronRight size={13} />
                                                        )}
                                                    </button>
                                                )}
                                            </div>
                                            {isExpanded &&
                                                s.chromas.map((c) => {
                                                    const chromaChecked = selectedKeys.has(
                                                        selKey(s.hash, c.slot),
                                                    );
                                                    return (
                                                        <button
                                                            key={c.slot}
                                                            type="button"
                                                            role="option"
                                                            aria-selected={chromaChecked}
                                                            className={`skinmod-pick-chroma${chromaChecked ? ' is-checked' : ''}`}
                                                            onClick={() => onToggle(s.hash, c.slot)}
                                                        >
                                                            <span className={`skinmod-pick-check${chromaChecked ? ' is-checked' : ''}`}>
                                                                {chromaChecked && <Check size={11} strokeWidth={3} />}
                                                            </span>
                                                            <span className="skinmod-pick-chroma-name">
                                                                {c.name}
                                                            </span>
                                                            <span className="skinmod-pick-chroma-slot">
                                                                skin{c.slot}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
}
