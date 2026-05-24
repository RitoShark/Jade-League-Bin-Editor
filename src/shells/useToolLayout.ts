import { useCallback, useEffect, useState } from 'react';

export type ToolId =
    | 'general' | 'particle' | 'markdown' | 'find' | 'texture' | 'material'
    // Bin Navigation — jump shortcuts for animationGraphData /
    // ResourceResolver / materialOverride.
    | 'binnav'
    // Photo Studio panels — only meaningful when a studio tab is active.
    // Default-placed on the right edge so they stack alongside the
    // existing edit panels.
    | 'studio-anim' | 'studio-bg' | 'studio-actions' | 'studio-mesh' | 'studio-objects'
    // Spotlight — shading / transparency / ground-shadow controls
    // for the active studio scene.
    | 'studio-spotlight'
    // File Explorer — dockable folder/WAD browser with tree + grid
    // views. Default-placed on the outer-left edge so it lives where
    // a VS Code sidebar would.
    | 'file-explorer';
/**
 * Each cardinal side has two parallel lanes — `outer` sits at the
 * workspace edge, `inner` sits between outer and the editor. Tools in
 * different lanes appear side-by-side; tools in the same lane stack as
 * tabs. This matches Visual Studio's "between middle and edge"
 * docking depth.
 */
export type DockSide =
    | 'outer-left'   | 'inner-left'
    | 'outer-right'  | 'inner-right'
    | 'outer-top'    | 'inner-top'
    | 'outer-bottom' | 'inner-bottom';

export const DOCK_SIDES: DockSide[] = [
    'outer-left', 'inner-left',
    'outer-right', 'inner-right',
    'outer-top', 'inner-top',
    'outer-bottom', 'inner-bottom',
];

/**
 * Each dock side can host up to two stacked sub-groups (`0` is the
 * primary slot, `1` is the split slot). Tools in the same group tab
 * together; tools in different groups stack along the side's
 * perpendicular axis with a resizable divider.
 */
export type DockGroup = 0 | 1;

export interface DockPlacement {
    kind: 'dock';
    side: DockSide;
    group: DockGroup;
}

export interface FloatPlacement {
    kind: 'float';
    x: number;
    y: number;
    width: number;
    height: number;
}

export type ToolPlacement = DockPlacement | FloatPlacement;

export type LayoutMap = Record<ToolId, ToolPlacement>;

const DEFAULT_LAYOUT: LayoutMap = {
    general:  { kind: 'dock', side: 'inner-right',  group: 0 },
    particle: { kind: 'dock', side: 'inner-right',  group: 0 },
    markdown: { kind: 'dock', side: 'inner-right',  group: 0 },
    find:     { kind: 'dock', side: 'inner-bottom', group: 0 },
    texture:  { kind: 'dock', side: 'inner-right',  group: 0 },
    material: { kind: 'dock', side: 'inner-right',  group: 0 },
    binnav:   { kind: 'dock', side: 'inner-right',  group: 0 },
    'studio-anim':    { kind: 'dock', side: 'inner-right',  group: 0 },
    'studio-bg':      { kind: 'dock', side: 'inner-bottom', group: 0 },
    'studio-actions': { kind: 'dock', side: 'inner-right',  group: 1 },
    // Textures + submeshes panel docks next to Background at the
    // bottom (same side, same group — they tab together) so users see
    // both surface controls in one horizontal strip.
    'studio-mesh':    { kind: 'dock', side: 'inner-bottom', group: 0 },
    // Objects list lives on the right above the photo panel so the
    // user has both "what's in the scene" and "what to do with it"
    // in their vertical sightline.
    'studio-objects': { kind: 'dock', side: 'inner-right',  group: 1 },
    // Spotlight panel — docks next to the Actions panel on the right
    // so the rendering / lighting controls sit in the same column as
    // the photo controls. Same group → they tab together.
    'studio-spotlight': { kind: 'dock', side: 'inner-right',  group: 1 },
    // File Explorer lives on the outer-left lane by default — the same
    // edge VS Code / Cursor users expect a folder tree on. Doesn't fight
    // for room with the right-side panels.
    'file-explorer':    { kind: 'dock', side: 'outer-left',   group: 0 },
};

const STORAGE_KEY = 'vs-tool-layout';

function isDockSide(v: unknown): v is DockSide {
    return typeof v === 'string' && DOCK_SIDES.includes(v as DockSide);
}

/** Migration helper: the old layout used 'left' / 'right' / 'top' /
 *  'bottom' without the lane prefix. Treat those as the inner lane. */
const LEGACY_SIDE_MAP: Record<string, DockSide> = {
    left:   'inner-left',
    right:  'inner-right',
    top:    'inner-top',
    bottom: 'inner-bottom',
};

function asGroup(v: unknown): DockGroup {
    return v === 1 ? 1 : 0;
}

function readStoredLayout(): LayoutMap {
    if (typeof window === 'undefined') return DEFAULT_LAYOUT;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_LAYOUT;
        const parsed = JSON.parse(raw) as Partial<Record<ToolId, ToolPlacement | { side: string }>>;
        const out: LayoutMap = { ...DEFAULT_LAYOUT };
        for (const id of Object.keys(DEFAULT_LAYOUT) as ToolId[]) {
            const entry = parsed[id] as any;
            if (!entry) continue;
            if (entry.kind === 'dock' && isDockSide(entry.side)) {
                out[id] = { kind: 'dock', side: entry.side, group: asGroup(entry.group) };
            } else if (entry.kind === 'dock' && typeof entry.side === 'string' && LEGACY_SIDE_MAP[entry.side]) {
                // Migration: pre-lane layouts had bare 'left' / 'right' etc.
                out[id] = { kind: 'dock', side: LEGACY_SIDE_MAP[entry.side], group: asGroup(entry.group) };
            } else if (entry.kind === 'float'
                && Number.isFinite(entry.x) && Number.isFinite(entry.y)
                && Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
                out[id] = {
                    kind: 'float',
                    x: entry.x, y: entry.y,
                    width: Math.max(220, entry.width),
                    height: Math.max(160, entry.height),
                };
            } else if (isDockSide(entry.side)) {
                out[id] = { kind: 'dock', side: entry.side, group: asGroup(entry.group) };
            } else if (typeof entry.side === 'string' && LEGACY_SIDE_MAP[entry.side]) {
                out[id] = { kind: 'dock', side: LEGACY_SIDE_MAP[entry.side], group: asGroup(entry.group) };
            }
        }
        return out;
    } catch {
        return DEFAULT_LAYOUT;
    }
}

/**
 * Per-tool placement preference for the Visual Studio shell. Tools can
 * be docked to a side or floating with their own coordinates / size.
 * The map persists across sessions.
 */
export function useToolLayout() {
    const [layout, setLayout] = useState<LayoutMap>(readStoredLayout);

    useEffect(() => {
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* quota / private mode */ }
    }, [layout]);

    const dockTool = useCallback((id: ToolId, side: DockSide, group: DockGroup = 0) => {
        setLayout(prev => {
            const cur = prev[id];
            if (cur.kind === 'dock' && cur.side === side && cur.group === group) return prev;
            return { ...prev, [id]: { kind: 'dock', side, group } };
        });
    }, []);

    /** Click action for the dock pane's split icon.
     *
     *  Always moves `id` (the clicked pane's active tool) into the
     *  side's *other* group — a per-tool toggle, not a side-wide
     *  operation. This is what makes peeling tools off one at a time
     *  work: with `[A,B,C]` stacked in group 0, splitting A sends A→1,
     *  then splitting B sends B→1 (group 0 keeps `[C]`), and so on.
     *  Pressing split on a tool that's already in group 1 sends it
     *  back to group 0, so the same button merges it again. A side
     *  collapses back to one group naturally once a group empties out.
     *
     *  The earlier implementation merged *everything* back to group 0
     *  the moment both groups were populated, which made the 2nd split
     *  in a row impossible. */
    const splitTool = useCallback((id: ToolId) => {
        setLayout(prev => {
            const cur = prev[id];
            if (cur.kind !== 'dock') return prev;
            const otherGroup: DockGroup = cur.group === 0 ? 1 : 0;
            return { ...prev, [id]: { kind: 'dock', side: cur.side, group: otherGroup } };
        });
    }, []);

    const floatTool = useCallback((id: ToolId, rect: { x: number; y: number; width: number; height: number }) => {
        setLayout(prev => ({
            ...prev,
            [id]: {
                kind: 'float',
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.max(220, Math.round(rect.width)),
                height: Math.max(160, Math.round(rect.height)),
            },
        }));
    }, []);

    const moveFloatingTool = useCallback((id: ToolId, dx: number, dy: number) => {
        setLayout(prev => {
            const cur = prev[id];
            if (cur.kind !== 'float') return prev;
            return {
                ...prev,
                [id]: { ...cur, x: Math.round(cur.x + dx), y: Math.round(cur.y + dy) },
            };
        });
    }, []);

    const resizeFloatingTool = useCallback((id: ToolId, w: number, h: number) => {
        setLayout(prev => {
            const cur = prev[id];
            if (cur.kind !== 'float') return prev;
            return {
                ...prev,
                [id]: { ...cur, width: Math.max(220, Math.round(w)), height: Math.max(160, Math.round(h)) },
            };
        });
    }, []);

    const resetLayout = useCallback(() => {
        setLayout(DEFAULT_LAYOUT);
    }, []);

    return { layout, dockTool, splitTool, floatTool, moveFloatingTool, resizeFloatingTool, resetLayout };
}
