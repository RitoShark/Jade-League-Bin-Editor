/**
 * PortalDropdown — themed replacement for `<select>` whose menu
 * renders via a React portal at `document.body`. Because the menu
 * lives outside any `overflow: hidden` parent (accordions, dock
 * panels, etc.), it can't get clipped or stacked behind sibling
 * chrome — the symptoms that made native selects look "trash"
 * inside accordion sections.
 *
 * Same visual language as the viewer's AnimationDropdown (in fact
 * AnimationDropdown is a thin wrapper for the searchable variant);
 * use the `searchable` prop when the list might be long.
 *
 * The trigger renders inline at the call site; the menu is fixed-
 * positioned against the trigger's bounding rect and re-anchors on
 * scroll / resize so it stays glued through layout shifts.
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
import { ChevronDown, Search as SearchIcon } from 'lucide-react';
import './PortalDropdown.css';

export interface DropdownOption {
    value: string;
    label: string;
}

interface PortalDropdownProps {
    options: DropdownOption[];
    value: string | null;
    onChange: (value: string) => void;
    /** Trigger label when nothing is selected. */
    placeholder?: string;
    /** Whether to show a filter input inside the popup. */
    searchable?: boolean;
    /** Optional CSS class on the trigger button (sizing / layout). */
    className?: string;
    /** Inline style for the trigger (e.g. `flex: 1` in a row). */
    style?: React.CSSProperties;
    /** Disable the trigger entirely. */
    disabled?: boolean;
}

export default function PortalDropdown({
    options,
    value,
    onChange,
    placeholder = 'Select…',
    searchable = false,
    className = '',
    style,
    disabled = false,
}: PortalDropdownProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; maxHeight: number }>(
        { top: 0, left: 0, width: 0, maxHeight: 320 },
    );

    const selectedLabel = useMemo(
        () => options.find((o) => o.value === value)?.label ?? null,
        [options, value],
    );

    const filtered = useMemo(() => {
        if (!searchable || !query.trim()) return options;
        const q = query.toLowerCase();
        return options.filter((o) => o.label.toLowerCase().includes(q));
    }, [options, query, searchable]);

    const updateMenuPos = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Horizontal: pin to trigger's left edge, but if the menu's
        // right edge would spill off-screen, slide it left so it fits.
        // Menu width = trigger width (so the popup aligns with the
        // control). When the trigger itself is narrower than ~160px
        // (small controls), we let the popup grow up to 240px for
        // legibility.
        const menuW = Math.max(r.width, 160);
        let left = r.left;
        if (left + menuW > vw - margin) {
            left = Math.max(margin, vw - menuW - margin);
        }
        // Vertical: try below the trigger first. If there's not enough
        // room below for at least 160px, flip to above. Cap maxHeight
        // so the menu never extends past the viewport — the inner list
        // already scrolls, this just shrinks the cap when needed.
        const spaceBelow = vh - r.bottom - margin;
        const spaceAbove = r.top - margin;
        const desiredMax = 320;
        let top: number;
        let maxHeight: number;
        if (spaceBelow >= 160 || spaceBelow >= spaceAbove) {
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

    const close = useCallback(() => {
        setOpen(false);
        setQuery('');
    }, []);

    return (
        <div className="portal-dd">
            <button
                ref={triggerRef}
                type="button"
                disabled={disabled}
                className={`portal-dd-trigger${open ? ' is-open' : ''} ${className}`.trim()}
                style={style}
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className="portal-dd-value">
                    {selectedLabel ?? placeholder}
                </span>
                <ChevronDown size={13} className="portal-dd-caret" />
            </button>
            {open && createPortal(
                <div
                    ref={menuRef}
                    className="portal-dd-menu"
                    role="listbox"
                    style={{
                        position: 'fixed',
                        top: `${menuPos.top}px`,
                        left: `${menuPos.left}px`,
                        width: `${menuPos.width}px`,
                        maxHeight: `${menuPos.maxHeight}px`,
                    }}
                >
                    {searchable && (
                        <div className="portal-dd-search">
                            <SearchIcon size={12} className="portal-dd-search-icon" />
                            <input
                                ref={searchRef}
                                type="text"
                                className="portal-dd-search-input"
                                placeholder="Filter…"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && filtered.length > 0) {
                                        onChange(filtered[0].value);
                                        close();
                                    }
                                }}
                            />
                        </div>
                    )}
                    <div className="portal-dd-list">
                        {filtered.length === 0 ? (
                            <div className="portal-dd-empty">
                                {searchable && query
                                    ? `No matches for “${query}”.`
                                    : 'No options.'}
                            </div>
                        ) : (
                            filtered.map((o) => {
                                const isSelected = o.value === value;
                                return (
                                    <button
                                        key={o.value}
                                        type="button"
                                        role="option"
                                        aria-selected={isSelected}
                                        className={`portal-dd-item${isSelected ? ' is-selected' : ''}`}
                                        onClick={() => {
                                            onChange(o.value);
                                            close();
                                        }}
                                    >
                                        {o.label}
                                    </button>
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
