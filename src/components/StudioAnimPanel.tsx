/**
 * Photo Studio — pose picker panel.
 *
 * Renders a searchable clip list + play/scrub/speed bar bound to the
 * active studio's animation player. Re-renders whenever the scene
 * emits a model/player change so loading a new model or picking a
 * clip refreshes the UI without prop wiring.
 *
 * Clip selection: clicking a clip asks the scene to start playback
 * (`scene.playClip`). The scene constructs the `AnimationPlayer` and
 * wires it to `scene.onBeforeRenderObservable`. We poll the player
 * each rAF tick for scrub-bar progress so the slider tracks the
 * actual `time` without the player needing to push events.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import type { StudioAnimClip } from '../lib/babylon/studioScene';
import './StudioPanels.css';

interface StudioAnimPanelProps {
    studioTabId: string;
}

const SPEED_CYCLE = [1, 2, 0.1, 0.5];

export default function StudioAnimPanel({ studioTabId }: StudioAnimPanelProps) {
    const s = useShell();
    const [revision, setRevision] = useState(0);
    const [filter, setFilter] = useState('');
    const [selectedName, setSelectedName] = useState<string | null>(null);
    const [paused, setPaused] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [speed, setSpeed] = useState(1);
    // `fetching` must live above the early-return below — calling a
    // hook AFTER a conditional return changes the hook count between
    // renders (active.skn flipping from null → populated when an SKN
    // loads), which is a Rules-of-Hooks violation. Crashed the whole
    // app on SKN open before this was hoisted.
    const [fetching, setFetching] = useState(false);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        const scene = s.getStudioScene(studioTabId);
        if (!scene) return;
        const off = scene.onChange(() => setRevision((r) => r + 1));
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [studioTabId]);

    useEffect(() => {
        const tick = () => {
            const scene = s.getStudioScene(studioTabId);
            const player = scene?.getPlayer() ?? null;
            if (player) {
                setTime(player.time);
                setDuration(player.duration);
                setPaused(player.paused);
                setSpeed(player.speed);
            }
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [studioTabId]);

    const scene = s.getStudioScene(studioTabId);
    const active = scene?.getActiveObject() ?? null;
    const player = scene?.getPlayer() ?? null;
    const listing = active?.skn?.animations ?? null;

    const filtered = useMemo(() => {
        const clips = listing?.clips ?? [];
        if (!filter.trim()) return clips;
        const q = filter.toLowerCase();
        return clips.filter((c) => c.name.toLowerCase().includes(q));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [listing, filter, revision]);

    const onPickClip = async (clip: StudioAnimClip) => {
        const scn = s.getStudioScene(studioTabId);
        if (!scn) return;
        setSelectedName(clip.name);
        await scn.playClip(clip);
    };

    const togglePlay = () => {
        if (!player) return;
        player.paused = !player.paused;
        setPaused(player.paused);
    };

    const cycleSpeed = () => {
        if (!player) return;
        const i = SPEED_CYCLE.indexOf(player.speed);
        const next = SPEED_CYCLE[(i + 1) % SPEED_CYCLE.length];
        player.speed = next;
        setSpeed(next);
    };

    const onScrub = (v: number) => {
        if (!player) return;
        player.time = v;
        setTime(v);
    };

    const stop = () => {
        const scn = s.getStudioScene(studioTabId);
        if (!scn) return;
        scn.stopClip();
        setSelectedName(null);
    };

    if (!active || !active.skn) {
        return (
            <div className="mop-dialog mop-dialog-docked studio-panel">
                <div className="mop-content">
                    <div className="mop-field-hint">
                        {active
                            ? `${active.name} has no skeleton — only SKN models with a sibling SKL play animations.`
                            : 'Drop a .skn file on the viewport to load a model. Animations will list here once it loads.'}
                    </div>
                </div>
            </div>
        );
    }

    const sknPath = active.sourcePath ?? null;
    const onFetchAnims = async () => {
        if (!sknPath || fetching) return;
        setFetching(true);
        try {
            await s.openFetchAnimationsDialog(sknPath);
        } finally {
            setFetching(false);
        }
    };

    return (
        <div className="mop-dialog mop-dialog-docked studio-panel">
            <div className="mop-content">
                <div className="studio-anim-search-row">
                    <input
                        type="text"
                        className="mop-input"
                        placeholder={`Search ${listing?.clips.length ?? 0} clip(s)…`}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    <button
                        type="button"
                        onClick={onFetchAnims}
                        disabled={!sknPath || fetching}
                        className="studio-icon-btn studio-fetch-anim-btn"
                        title={sknPath
                            ? 'Pull this champion\'s animations from your League install'
                            : 'Load an SKN with a recognizable mod-tree path to enable this'}
                    >
                        <Download size={14} />
                    </button>
                </div>
                <div className="studio-anim-list" style={{ marginTop: 8 }}>
                    {filtered.length === 0 && (
                        <div className="mop-field-hint" style={{ padding: 8 }}>
                            {listing ? 'No clips match the filter.' : 'No animations found for this model.'}
                        </div>
                    )}
                    {filtered.map((c) => {
                        const unsupported = !c.anm_disk_path;
                        const isSelected = c.name === selectedName;
                        return (
                            <button
                                key={c.name + ':' + (c.anm_disk_path ?? c.anm_chunk_hash_hex ?? '')}
                                onClick={() => !unsupported && onPickClip(c)}
                                disabled={unsupported}
                                className={`studio-anim-clip${isSelected ? ' active' : ''}`}
                                title={unsupported
                                    ? 'WAD-source clip — studio is disk-only for now'
                                    : c.anm_path}
                            >
                                {c.name}
                            </button>
                        );
                    })}
                </div>
                <div className="studio-controls">
                    <button onClick={togglePlay} disabled={!player} className="studio-icon-btn" title={paused ? 'Play' : 'Pause'}>
                        {paused ? '▶' : '⏸'}
                    </button>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(0.0001, duration)}
                        step={duration > 0 ? duration / 500 : 0.001}
                        value={time}
                        onChange={(e) => onScrub(Number(e.target.value))}
                        disabled={!player}
                        className="studio-scrub"
                    />
                    <span className="studio-time">
                        {formatClock(time)} / {formatClock(duration)}
                    </span>
                    <button onClick={cycleSpeed} disabled={!player} className="studio-icon-btn studio-speed-btn" title="Cycle speed">
                        {formatSpeed(speed)}
                    </button>
                    <button onClick={stop} disabled={!player} className="studio-icon-btn" title="Unload clip">
                        ✕
                    </button>
                </div>
            </div>
        </div>
    );
}

function formatClock(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds * 100) % 100);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

function formatSpeed(n: number): string {
    if (n === 1) return '1×';
    if (n === 2) return '2×';
    if (n === 0.5) return '0.5×';
    if (n === 0.1) return '0.1×';
    return `${n}×`;
}
