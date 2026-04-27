import { useCallback, useEffect, useState } from 'react';

export type ToolId = 'general' | 'particle' | 'markdown' | 'find';
export type DockSide = 'left' | 'right' | 'bottom';

export interface DockPlacement {
    kind: 'dock';
    side: DockSide;
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
    general:  { kind: 'dock', side: 'right' },
    particle: { kind: 'dock', side: 'right' },
    markdown: { kind: 'dock', side: 'right' },
    find:     { kind: 'dock', side: 'bottom' },
};

const STORAGE_KEY = 'vs-tool-layout';

function isDockSide(v: unknown): v is DockSide {
    return v === 'left' || v === 'right' || v === 'bottom';
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
                out[id] = { kind: 'dock', side: entry.side };
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
                // Migration: legacy v1 entries used a bare { side } shape.
                out[id] = { kind: 'dock', side: entry.side };
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

    const dockTool = useCallback((id: ToolId, side: DockSide) => {
        setLayout(prev => {
            const cur = prev[id];
            if (cur.kind === 'dock' && cur.side === side) return prev;
            return { ...prev, [id]: { kind: 'dock', side } };
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

    return { layout, dockTool, floatTool, moveFloatingTool, resizeFloatingTool, resetLayout };
}
