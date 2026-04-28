import { useEffect, useRef, useState } from 'react';
import { ChevronRightIcon } from './Icons';

export interface FontPickerGroup {
    title?: string;
    items: { value: string; label: string; fontFamily?: string }[];
}

interface FontPickerProps {
    value: string;
    /** First group is also the "default" entry — use `value: ''` to mark it. */
    groups: FontPickerGroup[];
    placeholder?: string;
    onChange: (value: string) => void;
    /** Optional `aria-label` so the trigger has an accessible name. */
    label?: string;
}

/**
 * Themed dropdown for picking a font from grouped options. Replaces the
 * native `<select>` so the menu matches the rest of the dark UI — group
 * headers are visible chips, items render in their own font for a true
 * preview, and selected/hover states use the theme's accent.
 */
export default function FontPicker({ value, groups, placeholder = 'Select…', onChange, label }: FontPickerProps) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    // Close on outside click + Escape.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const allItems = groups.flatMap(g => g.items);
    const current = allItems.find(i => i.value === value);
    const display = current?.label ?? placeholder;
    const displayFont = current?.fontFamily;

    return (
        <div ref={wrapRef} className={`font-picker${open ? ' open' : ''}`}>
            <button
                type="button"
                className="font-picker-trigger"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={label}
            >
                <span
                    className="font-picker-trigger-label"
                    style={displayFont ? { fontFamily: displayFont } : undefined}
                >
                    {display}
                </span>
                <span className={`font-picker-chevron${open ? ' open' : ''}`}>
                    <ChevronRightIcon size={12} />
                </span>
            </button>

            {open && (
                <div className="font-picker-menu" role="listbox">
                    {groups.map((group, gi) => (
                        <div key={gi} className="font-picker-group">
                            {group.title && (
                                <div className="font-picker-group-title">{group.title}</div>
                            )}
                            {group.items.map(item => (
                                <button
                                    key={item.value || '__default__'}
                                    type="button"
                                    role="option"
                                    aria-selected={item.value === value}
                                    className={`font-picker-item${item.value === value ? ' selected' : ''}`}
                                    style={item.fontFamily ? { fontFamily: item.fontFamily } : undefined}
                                    onClick={() => { onChange(item.value); setOpen(false); }}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
