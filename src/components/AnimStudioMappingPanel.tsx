/**
 * Animation Studio — Bone Mapping panel.
 *
 * Dock-friendly wrapper around the same UI the inline-drawer
 * version (`BoneMappingPanel`) shipped, with the chrome adapted to
 * the VS dock system: no explicit width / close button, no custom
 * header bar (the dock pane provides one). Pulls its scene via
 * `ShellContext.getAnimStudioScene` keyed by tab id, same pattern as
 * the Photo Studio panels.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight as ArrowRightIcon } from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import {
    IGNORED,
    type AnimStudioScene,
    type MappingEntry,
    type MappingRow,
} from '../lib/babylon/animStudioScene';
import BoneDropdown from './BoneDropdown';
import './StudioPanels.css';

interface AnimStudioMappingPanelProps {
    animStudioTabId: string;
}

type StatusFilter = 'all' | 'unmapped' | 'mapped' | 'fuzzy' | 'ignored';

const ROW_HEIGHT = 32;
const OVERSCAN = 10;

export default function AnimStudioMappingPanel({ animStudioTabId }: AnimStudioMappingPanelProps) {
    const s = useShell();
    const [tick, setTick] = useState(0);
    const scene: AnimStudioScene | null = s.getAnimStudioScene(animStudioTabId);
    useEffect(() => {
        if (!scene) {
            // Scene not built yet — keep polling. Triggers a fresh
            // read of `getAnimStudioScene` on the next render.
            const t = setTimeout(() => setTick(n => n + 1), 80);
            return () => clearTimeout(t);
        }
        return scene.onChange(() => setTick(n => n + 1));
    }, [animStudioTabId, scene]);
    const rows = useMemo<MappingRow[]>(() => scene?.getBoneMappingRows() ?? [], [scene, tick]);
    const targetOptions = useMemo(() => scene?.getTargetJoints() ?? [], [scene, tick]);

    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [query, setQuery] = useState('');
    const filteredRows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return rows.filter((r) => {
            if (statusFilter === 'unmapped' && r.status !== 'unmapped') return false;
            if (statusFilter === 'mapped'
                && r.status !== 'exact'
                && r.status !== 'fuzzy'
                && r.status !== 'override') return false;
            if (statusFilter === 'fuzzy' && r.status !== 'fuzzy') return false;
            if (statusFilter === 'ignored' && r.status !== 'ignored') return false;
            if (q) {
                if (!r.sourceName.toLowerCase().includes(q)
                    && !(r.targetName?.toLowerCase().includes(q) ?? false)) {
                    return false;
                }
            }
            return true;
        });
    }, [rows, statusFilter, query]);

    const counts = useMemo(() => {
        const c = { all: rows.length, exact: 0, override: 0, fuzzy: 0, unmapped: 0, ignored: 0 };
        for (const r of rows) c[r.status]++;
        return c;
    }, [rows]);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(400);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
        ro.observe(el);
        setViewportH(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    // rAF-coalesced scroll. Native `onScroll` can fire 100+ times per
    // second on a wheel scroll; without coalescing each event triggers
    // a setState + full re-render of the (large) list of `<select>`
    // elements. Stash the raw scrollTop in a ref and flush once per
    // frame.
    const pendingScrollRef = useRef<number | null>(null);
    const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const top = (e.target as HTMLDivElement).scrollTop;
        if (pendingScrollRef.current !== null) {
            pendingScrollRef.current = top;
            return;
        }
        pendingScrollRef.current = top;
        requestAnimationFrame(() => {
            const v = pendingScrollRef.current;
            pendingScrollRef.current = null;
            if (v !== null) setScrollTop(v);
        });
    };

    // Memoize the visible slice + paddings so a parent re-render
    // (scene.onChange tick) doesn't reslice unless inputs really
    // changed.
    const { visible, padTop, padBottom } = useMemo(() => {
        const firstIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
        const lastIdx = Math.min(
            filteredRows.length,
            Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN,
        );
        return {
            visible: filteredRows.slice(firstIdx, lastIdx),
            padTop: firstIdx * ROW_HEIGHT,
            padBottom: Math.max(0, (filteredRows.length - lastIdx) * ROW_HEIGHT),
        };
    }, [filteredRows, scrollTop, viewportH]);

    const onPickTarget = useCallback((sourceHash: number, entry: MappingEntry | null) => {
        if (!scene) return;
        scene.setBoneOverride(sourceHash, entry);
    }, [scene]);

    const onClearOverrides = () => scene?.clearBoneOverrides();
    const onAutoRemap = () => scene?.recomputeAutoMapping();

    if (!scene || rows.length === 0) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
                <div className="mop-content">
                    <div className="anim-empty">
                        {scene
                            ? 'Load a source and target SKN to start mapping bones.'
                            : 'Animation Studio scene initialising…'}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel anim-panel-flush">
            <div className="mop-content">
            <div className="anim-panel-status">
                <span>{counts.exact + counts.fuzzy + counts.override} / {counts.all} mapped</span>
                {counts.ignored > 0 && (
                    <span style={{ opacity: 0.65, marginLeft: 8 }}>({counts.ignored} rigid)</span>
                )}
            </div>

            <div className="anim-filter-row">
                <FilterChip label={`All ${counts.all}`} active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
                <FilterChip
                    label={`Unmapped ${counts.unmapped}`}
                    active={statusFilter === 'unmapped'}
                    accent="red"
                    onClick={() => setStatusFilter('unmapped')}
                />
                <FilterChip
                    label={`Mapped ${counts.exact + counts.fuzzy + counts.override}`}
                    active={statusFilter === 'mapped'}
                    accent="green"
                    onClick={() => setStatusFilter('mapped')}
                />
                <FilterChip
                    label={`Fuzzy ${counts.fuzzy}`}
                    active={statusFilter === 'fuzzy'}
                    accent="yellow"
                    onClick={() => setStatusFilter('fuzzy')}
                />
                <FilterChip
                    label={`Rigid ${counts.ignored}`}
                    active={statusFilter === 'ignored'}
                    accent="gray"
                    onClick={() => setStatusFilter('ignored')}
                />
            </div>

            <div className="anim-pick-block" style={{ padding: '6px 8px', flexDirection: 'row', alignItems: 'center' }}>
                <input
                    type="text"
                    placeholder="search bones…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    className="anim-search"
                />
                <button onClick={onAutoRemap} title="Re-run auto-mapping (overrides survive)" className="anim-add-btn">
                    Auto-map
                </button>
                <button onClick={onClearOverrides} title="Clear every manual override" className="anim-add-btn">
                    Clear overrides
                </button>
            </div>

            <div style={columnHeaderStyle}>
                <span style={{ width: 8 }} />
                <span style={{ flex: '1 1 0', minWidth: 0 }}>Source bone</span>
                <ArrowRightIcon size={10} style={{ opacity: 0.5, flex: '0 0 auto' }} />
                <span style={{ flex: '1 1 0', minWidth: 0 }}>Target bone (click to override)</span>
            </div>

            <div
                ref={scrollRef}
                onScroll={onScroll}
                style={listStyle}
            >
                <div style={{ height: padTop }} />
                {visible.map((row) => (
                    <BoneRow
                        key={row.sourceHash}
                        row={row}
                        targetOptions={targetOptions}
                        onPickTarget={onPickTarget}
                    />
                ))}
                <div style={{ height: padBottom }} />
                {filteredRows.length === 0 && (
                    <div className="anim-empty" style={{ padding: 16 }}>
                        No bones match this filter.
                    </div>
                )}
            </div>

            <div style={legendStyle}>
                <Legend color={STATUS_COLOURS.exact} label="exact" />
                <Legend color={STATUS_COLOURS.override} label="override" />
                <Legend color={STATUS_COLOURS.fuzzy} label="fuzzy" />
                <Legend color={STATUS_COLOURS.unmapped} label="unmapped" />
                <Legend color={STATUS_COLOURS.ignored} label="rigid" />
            </div>
            </div>
        </div>
    );
}

// ── Subcomponents ────────────────────────────────────────────────

const BoneRow = memo(BoneRowImpl, (a, b) =>
    a.row === b.row
    && a.targetOptions === b.targetOptions
    && a.onPickTarget === b.onPickTarget
);

function BoneRowImpl({ row, targetOptions, onPickTarget }: {
    row: MappingRow;
    targetOptions: { hash: number; name: string }[];
    onPickTarget: (sourceHash: number, entry: MappingEntry | null) => void;
}) {
    const isIgnored = row.status === 'ignored';
    const emptyLabel = row.status === 'unmapped'
        ? '(unmapped — pick target)'
        : '(auto)';
    return (
        <div style={rowStyle} title={`Source: ${row.sourceName}${row.targetName ? ` → ${row.targetName}` : ''}`}>
            <span style={{ ...statusDotStyle, background: STATUS_COLOURS[row.status] }} />
            <span style={cellNameStyle}>{row.sourceName}</span>
            <ArrowRightIcon size={11} style={{ flex: '0 0 auto', opacity: 0.45 }} />
            <BoneDropdown
                value={isIgnored ? null : row.targetHash}
                options={targetOptions}
                onChange={(hash) => onPickTarget(row.sourceHash, hash)}
                emptyLabel={emptyLabel}
                specialItems={[{
                    key: 'ignore',
                    label: 'Rigid (follow parent)',
                    active: isIgnored,
                    onPick: () => onPickTarget(row.sourceHash, IGNORED),
                }]}
                activeLabel={isIgnored ? 'Rigid (follow parent)' : undefined}
            />
        </div>
    );
}

function FilterChip({ label, active, accent, onClick }: {
    label: string;
    active: boolean;
    accent?: 'red' | 'green' | 'yellow' | 'gray';
    onClick: () => void;
}) {
    const accentColour = accent ? ACCENT_COLOURS[accent] : 'var(--jade-accent, #007acc)';
    return (
        <button
            type="button"
            onClick={onClick}
            className={`anim-chip${active ? ' active' : ''}`}
            style={active ? {
                borderColor: accentColour,
                background: `color-mix(in srgb, ${accentColour} 25%, transparent)`,
            } : undefined}
        >{label}</button>
    );
}

function Legend({ color, label }: { color: string; label: string }) {
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            color: 'var(--text-secondary, #9DA5B4)', fontSize: 10,
        }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }} />
            {label}
        </span>
    );
}

// ── Constants / styles ─────────────────────────────────────────────

const STATUS_COLOURS: Record<MappingRow['status'], string> = {
    exact:    '#3fb950',
    override: '#58a6ff',
    fuzzy:    '#d4a72c',
    unmapped: '#f85149',
    ignored:  '#8b949e',
};

const ACCENT_COLOURS = {
    red:    '#f85149',
    green:  '#3fb950',
    yellow: '#d4a72c',
    gray:   '#8b949e',
};

const columnHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.05,
    textTransform: 'uppercase',
    color: 'var(--text-secondary, #9DA5B4)',
    background: 'rgba(255, 255, 255, 0.03)',
    borderBottom: '1px solid var(--border-color, #3e3e42)',
    flex: '0 0 auto',
};

const listStyle: React.CSSProperties = {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
};

const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '0 8px',
    height: ROW_HEIGHT,
    borderBottom: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 35%, transparent)',
    fontSize: 11,
};

const statusDotStyle: React.CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: 3,
    flex: '0 0 auto',
};

const cellNameStyle: React.CSSProperties = {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text-primary, #d4d4d4)',
};

const legendStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 10px',
    borderTop: '1px solid var(--border-color, #3e3e42)',
    flex: '0 0 auto',
    background: 'rgba(255, 255, 255, 0.02)',
    flexWrap: 'wrap',
};
