/**
 * Searchable bone-picker dropdown used across the Animation Studio
 * panels.
 *
 * The popover is rendered into a React portal at `document.body` so
 * it escapes the panel's `overflow: auto` clipping and sits above
 * sibling docks. Position is computed from the trigger's bounding
 * rect each open + on scroll/resize, with a vertical flip when the
 * default below-trigger position would overflow the viewport
 * bottom, and a horizontal clamp.
 *
 * Three flavours of items:
 *   - The empty/default option (`emptyLabel`, picks `null`)
 *   - Special non-bone options (`specialItems` — e.g. "Rigid")
 *   - The bone list (`options` — searchable)
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown as ChevronDownIcon } from 'lucide-react';

export interface BoneDropdownOption {
    /** Bone hash (or any unique numeric id). */
    hash: number;
    /** Display name. */
    name: string;
}

export interface BoneDropdownSpecial {
    /** Stable key for React. */
    key: string;
    /** Display label. */
    label: string;
    /** Fired when the user picks this row. */
    onPick: () => void;
    /** When true, the option renders highlighted as the current
     *  selection. */
    active?: boolean;
}

interface Props {
    /** Currently selected hash, or `null` for the empty / default
     *  state. */
    value: number | null;
    /** Bones to choose from, in display order. */
    options: BoneDropdownOption[];
    /** Fired when the user picks a bone option or the empty option.
     *  Special-items use their own `onPick`. */
    onChange: (hash: number | null) => void;
    /** Optional empty/default option label (e.g. "(SKL parent)"). */
    emptyLabel?: string;
    /** Optional non-bone options shown above the bone list. */
    specialItems?: BoneDropdownSpecial[];
    /** Label shown on the trigger when no value is set. */
    placeholder?: string;
    /** Label override for when a `specialItems` row is currently
     *  active — the dropdown can't know which special is selected
     *  without help. Pass a string to show on the trigger instead of
     *  the bone name / placeholder. */
    activeLabel?: string;
    /** Title attribute for the trigger. */
    title?: string;
    /** Disable interaction. */
    disabled?: boolean;
}

interface PopoverRect {
    left: number;
    /** When flipping above the trigger we anchor by the popover's
     *  bottom edge (so it grows upward only as tall as content
     *  needs and always hugs the trigger), otherwise by the top.
     *  Exactly one of `top` / `bottom` is a number. */
    top: number | null;
    bottom: number | null;
    width: number;
    maxHeight: number;
    /** True when the popover flipped to render ABOVE the trigger
     *  (no room below). */
    above: boolean;
}

const POPOVER_MIN_HEIGHT = 140;
const POPOVER_MAX_HEIGHT = 320;
const VIEWPORT_MARGIN = 6;

export default function BoneDropdown({
    value,
    options,
    onChange,
    emptyLabel,
    specialItems,
    placeholder = 'pick bone…',
    activeLabel,
    title,
    disabled,
}: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [popRect, setPopRect] = useState<PopoverRect | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Compute popover position relative to the trigger. Called on
    // open + on scroll/resize while open.
    const recalc = () => {
        const trig = triggerRef.current;
        if (!trig) return;
        const r = trig.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const spaceBelow = vh - r.bottom - VIEWPORT_MARGIN;
        const spaceAbove = r.top - VIEWPORT_MARGIN;
        // Flip above whenever there's more vertical room above the
        // trigger than below. Below-the-trigger anchors by `top`
        // (popover grows downward from r.bottom). Above-the-trigger
        // anchors by `bottom` so the popover's bottom edge always
        // sits 4px above the trigger and the box only grows up by
        // however much content needs — without bottom-anchoring, a
        // short popover (e.g. 5 items) would render way up at the
        // top of the screen because `top = r.top - maxHeight` and
        // maxHeight was the full available `spaceAbove`.
        const above = spaceAbove > spaceBelow;
        const maxHeight = Math.max(
            POPOVER_MIN_HEIGHT,
            Math.min(POPOVER_MAX_HEIGHT, above ? spaceAbove : spaceBelow),
        );
        // Horizontal placement: prefer left-aligned with the trigger
        // for natural visual continuity, but right-align if the
        // popover would overflow the viewport's right edge (panel
        // docked at the right of the screen). Final clamp to the
        // viewport margin handles the case where neither alignment
        // fits and we just push it onto screen.
        const width = Math.max(180, r.width);
        let left = r.left;
        if (left + width > vw - VIEWPORT_MARGIN) {
            left = r.right - width;
        }
        if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
        if (left + width > vw - VIEWPORT_MARGIN) {
            left = vw - width - VIEWPORT_MARGIN;
        }
        const top = above ? null : r.bottom + 4;
        const bottom = above ? (vh - r.top + 4) : null;
        setPopRect({ left, top, bottom, width, maxHeight, above });
    };

    useLayoutEffect(() => {
        if (!open) return;
        recalc();
        const onWin = () => recalc();
        window.addEventListener('scroll', onWin, true);
        window.addEventListener('resize', onWin);
        return () => {
            window.removeEventListener('scroll', onWin, true);
            window.removeEventListener('resize', onWin);
        };
    }, [open]);

    // Close on outside click / escape.
    useEffect(() => {
        if (!open) return;
        const onDocPointer = (e: PointerEvent) => {
            const trig = triggerRef.current;
            const pop = popoverRef.current;
            const target = e.target as Node;
            if (trig && trig.contains(target)) return;
            if (pop && pop.contains(target)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onDocPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDocPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    useEffect(() => {
        if (open) {
            requestAnimationFrame(() => inputRef.current?.focus());
            setQuery('');
        }
    }, [open]);

    const nameByHash = useMemo(() => {
        const m = new Map<number, string>();
        for (const o of options) m.set(o.hash, o.name);
        return m;
    }, [options]);
    const currentName = value !== null ? nameByHash.get(value) ?? null : null;
    const activeSpecial = specialItems?.find(s => s.active) ?? null;

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return options.slice(0, 250);
        return options.filter(o => o.name.toLowerCase().includes(q)).slice(0, 250);
    }, [options, query]);

    const labelText = activeLabel
        ?? (activeSpecial ? activeSpecial.label : null)
        ?? currentName
        ?? (emptyLabel ?? placeholder);

    const popover = (open && popRect) ? createPortal(
        <div
            ref={popoverRef}
            style={{
                position: 'fixed',
                left: popRect.left,
                // Use whichever anchor matches the placement. `top`
                // for below-the-trigger; `bottom` for above-the-
                // trigger so the popover grows upward to content
                // height without leaving empty space pinned at the
                // top of the viewport.
                top: popRect.top ?? undefined,
                bottom: popRect.bottom ?? undefined,
                width: popRect.width,
                maxHeight: popRect.maxHeight,
                zIndex: 9999,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: 4,
                background: 'var(--vscode-editorWidget-background, var(--editor-bg, #1e1e1e))',
                border: '1px solid var(--border-color, #3e3e42)',
                borderRadius: 'var(--border-radius, 4px)',
                boxShadow: popRect.above
                    ? '0 -4px 14px rgba(0, 0, 0, 0.45)'
                    : '0 4px 14px rgba(0, 0, 0, 0.45)',
            }}
        >
            <input
                ref={inputRef}
                type="text"
                placeholder="search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="anim-search"
                style={{ width: '100%', flex: '0 0 auto' }}
            />
            <div className="anim-pick-list" style={listStyle}>
                {emptyLabel && (
                    <button
                        type="button"
                        className="anim-pick-item"
                        onClick={() => { onChange(null); setOpen(false); }}
                        style={value === null && !activeSpecial ? activeItemStyle : undefined}
                    >
                        <em style={{ opacity: 0.7 }}>{emptyLabel}</em>
                    </button>
                )}
                {specialItems?.map(si => (
                    <button
                        type="button"
                        key={`special:${si.key}`}
                        className="anim-pick-item"
                        onClick={() => { si.onPick(); setOpen(false); }}
                        style={si.active ? activeItemStyle : undefined}
                    >
                        <em style={{ opacity: 0.85 }}>{si.label}</em>
                    </button>
                )) ?? null}
                {filtered.length === 0 ? (
                    <div className="anim-pick-empty">No matching bones.</div>
                ) : filtered.map(o => (
                    <button
                        type="button"
                        key={o.hash}
                        className="anim-pick-item"
                        onClick={() => { onChange(o.hash); setOpen(false); }}
                        style={value === o.hash ? activeItemStyle : undefined}
                    >
                        {o.name}
                    </button>
                ))}
            </div>
        </div>,
        document.body,
    ) : null;

    return (
        <>
            <div style={wrapStyle}>
                <button
                    ref={triggerRef}
                    type="button"
                    disabled={disabled}
                    onClick={() => setOpen(o => !o)}
                    className={`anim-select${open ? ' is-open' : ''}`}
                    style={triggerStyle}
                    title={title ?? labelText}
                >
                    <span style={triggerLabelStyle}>{labelText}</span>
                    <ChevronDownIcon size={11} style={triggerArrowStyle} aria-hidden />
                </button>
            </div>
            {popover}
        </>
    );
}

const wrapStyle: React.CSSProperties = {
    position: 'relative',
    // basis 0 so the trigger sizes off available row space, not its
    // label content. Without this, rows containing long bone names
    // expand to fit, producing a ragged column. Callers that want a
    // content-sized trigger can wrap in a fixed-width div.
    flex: '1 1 0',
    minWidth: 0,
};

const triggerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    width: '100%',
    cursor: 'pointer',
    textAlign: 'left',
};

const triggerLabelStyle: React.CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

const triggerArrowStyle: React.CSSProperties = {
    flex: '0 0 auto',
    fontSize: 9,
    opacity: 0.7,
};

const listStyle: React.CSSProperties = {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
};

const activeItemStyle: React.CSSProperties = {
    background: 'color-mix(in srgb, var(--jade-accent, #007acc) 25%, transparent)',
    color: 'var(--text-primary, #ffffff)',
};
