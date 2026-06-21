/**
 * Manage tab — mod checkup & repair.
 *
 * Open a .fantome (renamed zip) or raw .wad.client, and Jade compares
 * it against the live game install: linked-list entries that no longer
 * exist (crash on load), chunk overrides whose live path Riot renamed
 * (the mod silently stops applying), and bin string refs that point at
 * nothing. Each finding comes with ranked replacement suggestions the
 * user can apply one-by-one or in bulk, then save a repaired copy —
 * the original file is never touched.
 *
 * Backend surface: mod_open / mod_scan / mod_apply_fixes / mod_save /
 * mod_close in src-tauri/src/manage_commands.rs.
 */

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
    Package as PackageIcon,
    FolderOpen as FolderOpenIcon,
    FolderTree as FolderTreeIcon,
    Save as SaveIcon,
    RefreshCw as RescanIcon,
    X as CloseIcon,
    Wrench as WrenchIcon,
    AlertTriangle as WarnIcon,
    AlertCircle as ErrorIcon,
    Info as InfoIcon,
    CheckCircle as OkIcon,
    ArrowRight as ArrowIcon,
    Trash2 as TrashIcon,
} from 'lucide-react';
import './ManageTab.css';

interface ModWadSummary {
    name: string;
    chunk_count: number;
    size_bytes: number;
    backing: 'packed' | 'folder';
}

interface ModOpenResult {
    id: number;
    kind: 'fantome' | 'wad' | 'folder';
    file_name: string;
    name: string | null;
    author: string | null;
    version: string | null;
    description: string | null;
    image_b64: string | null;
    created_ms: number | null;
    wads: ModWadSummary[];
}

interface ModSuggestion {
    path: string;
    confidence: 'high' | 'medium' | 'low';
    confidence_pct: number;
    reason: string;
}

type RecommendedAction = 'update' | 'rename' | 'remove' | 'none';

type IssueKind = 'missing_linked' | 'stale_override' | 'missing_asset' | 'wrong_extension' | 'parse_error';

interface ModIssue {
    id: number;
    kind: IssueKind;
    severity: 'error' | 'warning' | 'info';
    wad_name: string;
    path: string;
    owner: string;
    ref_count: number;
    message: string;
    suggestions: ModSuggestion[];
    recommended_action: RecommendedAction;
    recommended_path: string | null;
    auto_fixable: boolean;
}

interface ModWadScanInfo {
    name: string;
    live_wad: string | null;
    chunk_count: number;
    bins_parsed: number;
    bins_failed: number;
}

interface ModScanResult {
    issues: ModIssue[];
    wads: ModWadScanInfo[];
    refs_checked: number;
    game_newer_than_mod: boolean;
    truncated: boolean;
}

type Category = 'all' | 'linked' | 'overrides' | 'assets' | 'other';

const CATEGORY_OF_KIND: Record<IssueKind, Category> = {
    missing_linked: 'linked',
    stale_override: 'overrides',
    missing_asset: 'assets',
    wrong_extension: 'assets',
    parse_error: 'other',
};

const KIND_LABEL: Record<IssueKind, string> = {
    missing_linked: 'Linked bin missing',
    stale_override: 'Dead override',
    missing_asset: 'Missing reference',
    wrong_extension: 'Extension changed',
    parse_error: "Couldn't parse",
};

function formatDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatSize(bytes: number): string {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** `Cool Mod.fantome` → `Cool Mod.fixed.fantome`; keeps `.wad.client` intact.
 *  Folder mods get a ` (fixed)` directory-name suffix instead. */
function fixedCopyName(fileName: string, kind: ModOpenResult['kind']): string {
    if (kind === 'folder') return `${fileName} (fixed)`;
    const lower = fileName.toLowerCase();
    for (const ext of ['.wad.client', '.fantome', '.zip', '.wad']) {
        if (lower.endsWith(ext)) {
            return fileName.slice(0, fileName.length - ext.length) + '.fixed' + ext;
        }
    }
    return fileName + '.fixed';
}

const KIND_CHIP: Record<ModOpenResult['kind'], string> = {
    fantome: 'Fantome',
    wad: 'Raw WAD',
    folder: 'Folder',
};

interface ManageTabProps {
    active: boolean;
    onStatus?: (status: string | null) => void;
}

export default function ManageTab({ onStatus }: ManageTabProps) {
    const [leagueFinal, setLeagueFinal] = useState<string | null>(null);
    const [mod, setMod] = useState<ModOpenResult | null>(null);
    const [scan, setScan] = useState<ModScanResult | null>(null);
    const [busy, setBusy] = useState<'open' | 'scan' | 'apply' | 'save' | null>(null);
    const [category, setCategory] = useState<Category>('all');
    /** issue id → selected suggestion path ('' = custom input mode). */
    const [choice, setChoice] = useState<Record<number, string>>({});
    const [customPath, setCustomPath] = useState<Record<number, string>>({});
    /** issue id → human description of the applied fix. */
    const [applied, setApplied] = useState<Record<number, string>>({});
    const [editCount, setEditCount] = useState(0);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        invoke<string | null>('detect_league_install')
            .then(setLeagueFinal)
            .catch(() => setLeagueFinal(null));
    }, []);

    // Errors (collisions, save failures) clear themselves after a few
    // seconds so they don't pile up and clog the panel.
    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), 7000);
        return () => clearTimeout(t);
    }, [error]);

    const status = (s: string | null) => onStatus?.(s);

    const closeMod = async () => {
        if (mod) {
            invoke('mod_close', { id: mod.id }).catch(() => {});
        }
        setMod(null);
        setScan(null);
        setChoice({});
        setCustomPath({});
        setApplied({});
        setEditCount(0);
        setError(null);
        setCategory('all');
    };

    const doOpen = async (picked: string) => {
        await closeMod();
        setBusy('open');
        setError(null);
        status('Opening mod…');
        try {
            const result = await invoke<ModOpenResult>('mod_open', { path: picked });
            setMod(result);
            status(`Loaded ${result.file_name} — ${result.wads.length} WAD${result.wads.length === 1 ? '' : 's'}`);
        } catch (e) {
            setError(String(e));
            status(null);
        } finally {
            setBusy(null);
        }
    };

    const openMod = async () => {
        const picked = await openDialog({
            multiple: false,
            filters: [{ name: 'League mods', extensions: ['fantome', 'zip', 'wad', 'client'] }],
        });
        if (picked && typeof picked === 'string') doOpen(picked);
    };

    const openFolder = async () => {
        const picked = await openDialog({ directory: true, multiple: false });
        if (picked && typeof picked === 'string') doOpen(picked);
    };

    const runScan = async () => {
        if (!mod || !leagueFinal) return;
        setBusy('scan');
        setError(null);
        setScan(null);
        setChoice({});
        setCustomPath({});
        setApplied({});
        setCategory('all');
        status('Comparing against live game files…');
        try {
            const result = await invoke<ModScanResult>('mod_scan', {
                id: mod.id,
                leagueFinalPath: leagueFinal,
            });
            setScan(result);
            const errors = result.issues.filter((i) => i.severity === 'error').length;
            const warnings = result.issues.filter((i) => i.severity === 'warning').length;
            status(
                result.issues.length === 0
                    ? 'Checkup complete — mod looks healthy'
                    : `Checkup complete — ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
            );
        } catch (e) {
            setError(String(e));
            status(null);
        } finally {
            setBusy(null);
        }
    };

    const buildFix = (issue: ModIssue, newPath: string) => {
        switch (issue.kind) {
            case 'missing_linked':
                return { kind: 'update_linked', wad_name: issue.wad_name, old_path: issue.path, new_path: newPath };
            case 'missing_asset':
            case 'wrong_extension':
                return { kind: 'update_string_ref', wad_name: issue.wad_name, old_path: issue.path, new_path: newPath };
            case 'stale_override':
                return { kind: 'rename_chunk', wad_name: issue.wad_name, chunk_path: issue.path, new_path: newPath };
            default:
                return null;
        }
    };

    const applyFixes = async (entries: Array<{ issue: ModIssue; fix: object; note: string }>) => {
        if (!mod || entries.length === 0) return;
        setBusy('apply');
        try {
            const result = await invoke<{ applied: number; bins_rewritten: number; errors: string[] }>(
                'mod_apply_fixes',
                { id: mod.id, fixes: entries.map((e) => e.fix) },
            );
            if (result.errors.length > 0) {
                setError(result.errors.join('\n'));
            }
            // Apply order is preserved backend-side; failures surface in
            // `errors` but we can't map them per-fix, so only mark all
            // applied when everything went through.
            if (result.errors.length === 0) {
                setApplied((prev) => {
                    const next = { ...prev };
                    for (const e of entries) next[e.issue.id] = e.note;
                    return next;
                });
                setEditCount((c) => c + result.applied);
                status(
                    result.bins_rewritten > 0
                        ? `Applied ${result.applied} fix${result.applied === 1 ? '' : 'es'} — ${result.bins_rewritten} bin${result.bins_rewritten === 1 ? '' : 's'} rewritten`
                        : `Applied ${result.applied} fix${result.applied === 1 ? '' : 'es'}`,
                );
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(null);
        }
    };

    const applyOne = (issue: ModIssue) => {
        const selected = choice[issue.id] ?? issue.recommended_path ?? issue.suggestions[0]?.path ?? '';
        const newPath = selected === '__custom__' ? (customPath[issue.id] ?? '').trim() : selected;
        if (!newPath) return;
        const fix = buildFix(issue, newPath);
        if (!fix) return;
        applyFixes([{ issue, fix, note: `→ ${newPath}` }]);
    };

    const removeChunk = (issue: ModIssue) => {
        applyFixes([
            {
                issue,
                fix: { kind: 'remove_chunk', wad_name: issue.wad_name, chunk_path: issue.path },
                note: 'removed from the WAD',
            },
        ]);
    };

    /** Build the fix entry Jade recommends for an issue (rename / update
     *  the ref / remove the file), or null if there's nothing safe to do. */
    const recommendedEntry = (issue: ModIssue): { issue: ModIssue; fix: object; note: string } | null => {
        if (issue.recommended_action === 'remove') {
            return {
                issue,
                fix: { kind: 'remove_chunk', wad_name: issue.wad_name, chunk_path: issue.path },
                note: 'removed (leftover / dead file)',
            };
        }
        if ((issue.recommended_action === 'update' || issue.recommended_action === 'rename') && issue.recommended_path) {
            const fix = buildFix(issue, issue.recommended_path);
            if (fix) return { issue, fix, note: `→ ${issue.recommended_path}` };
        }
        return null;
    };

    const applyAllConfident = () => {
        if (!scan) return;
        const entries: Array<{ issue: ModIssue; fix: object; note: string }> = [];
        for (const issue of scan.issues) {
            if (applied[issue.id] || !issue.auto_fixable) continue;
            const entry = recommendedEntry(issue);
            if (entry) entries.push(entry);
        }
        applyFixes(entries);
    };

    const saveFixed = async () => {
        if (!mod) return;
        let target: string | null = null;
        if (mod.kind === 'folder') {
            // Folder mods save back out as a folder tree — pick a
            // destination directory.
            const picked = await openDialog({ directory: true, multiple: false, title: 'Choose where to save the fixed mod folder' });
            target = picked && typeof picked === 'string' ? `${picked}/${fixedCopyName(mod.file_name, mod.kind)}` : null;
        } else {
            target = await saveDialog({
                defaultPath: fixedCopyName(mod.file_name, mod.kind),
                filters:
                    mod.kind === 'fantome'
                        ? [{ name: 'Fantome mod', extensions: ['fantome'] }]
                        : [{ name: 'WAD', extensions: ['client', 'wad'] }],
            });
        }
        if (!target) return;
        setBusy('save');
        status(mod.kind === 'folder' ? 'Writing repaired mod folder…' : 'Rebuilding WADs…');
        try {
            const result = await invoke<{ out_path: string; wads_rebuilt: number; total_bytes: number }>(
                'mod_save',
                { id: mod.id, outPath: target },
            );
            status(`Saved ${result.out_path} (${formatSize(result.total_bytes)}, ${result.wads_rebuilt} WAD${result.wads_rebuilt === 1 ? '' : 's'} rebuilt)`);
        } catch (e) {
            setError(String(e));
            status(null);
        } finally {
            setBusy(null);
        }
    };

    const counts = useMemo(() => {
        const c: Record<Category, number> = { all: 0, linked: 0, overrides: 0, assets: 0, other: 0 };
        if (scan) {
            for (const issue of scan.issues) {
                c.all++;
                c[CATEGORY_OF_KIND[issue.kind]]++;
            }
        }
        return c;
    }, [scan]);

    const visibleIssues = useMemo(() => {
        if (!scan) return [];
        const order = { error: 0, warning: 1, info: 2 } as const;
        return scan.issues
            .filter((i) => category === 'all' || CATEGORY_OF_KIND[i.kind] === category)
            .sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));
    }, [scan, category]);

    const confidentCount = useMemo(
        () => (scan ? scan.issues.filter((i) => !applied[i.id] && i.auto_fixable).length : 0),
        [scan, applied],
    );

    const severityIcon = (sev: ModIssue['severity']) =>
        sev === 'error' ? <ErrorIcon size={15} /> : sev === 'warning' ? <WarnIcon size={15} /> : <InfoIcon size={15} />;

    // ── Empty state ──
    if (!mod) {
        return (
            <div className="manage-view">
                <div className="manage-empty">
                    <div className="manage-empty-icon">
                        <PackageIcon size={44} strokeWidth={1.4} />
                    </div>
                    <h2>Mod checkup</h2>
                    <p>
                        Open a <strong>.fantome</strong>, a <strong>.wad</strong>, or a <strong>WAD-structured folder</strong> and
                        Jade will compare it against your live game files — broken linked lists, paths Riot renamed, dead
                        overrides — then help you fix them and save a repaired copy.
                    </p>
                    <div className="manage-empty-actions">
                        <button type="button" className="manage-btn manage-btn-primary" onClick={openMod} disabled={busy === 'open'}>
                            <FolderOpenIcon size={15} />
                            {busy === 'open' ? 'Opening…' : 'Open mod file…'}
                        </button>
                        <button type="button" className="manage-btn" onClick={openFolder} disabled={busy === 'open'}>
                            <FolderTreeIcon size={15} />
                            Open folder…
                        </button>
                    </div>
                    {!leagueFinal && (
                        <div className="manage-hint">
                            League install not detected — you can still open mods, but scanning needs the game files.
                        </div>
                    )}
                    {error && <div className="manage-error">{error}</div>}
                </div>
            </div>
        );
    }

    // ── Loaded state ──
    return (
        <div className="manage-view">
            <div className="manage-card manage-head">
                {mod.image_b64 && (
                    <img className="manage-head-image" src={`data:image/png;base64,${mod.image_b64}`} alt="" draggable={false} />
                )}
                <div className="manage-head-info">
                    <div className="manage-head-title">
                        {mod.name || mod.file_name}
                        {mod.version && <span className="manage-head-version">v{mod.version}</span>}
                    </div>
                    <div className="manage-head-sub">
                        {mod.author && <span>by {mod.author}</span>}
                        <span className="manage-chip">{KIND_CHIP[mod.kind]}</span>
                        {mod.created_ms && <span className="manage-chip">built {formatDate(mod.created_ms)}</span>}
                        {scan?.game_newer_than_mod && (
                            <span className="manage-chip manage-chip-warn">game updated since</span>
                        )}
                    </div>
                    {mod.description && <div className="manage-head-desc">{mod.description}</div>}
                    <div className="manage-head-wads">
                        {mod.wads.map((w) => {
                            const live = scan?.wads.find((s) => s.name === w.name)?.live_wad;
                            return (
                                <span
                                    key={w.name}
                                    className={`manage-wad-chip${scan && !live ? ' manage-wad-chip-unmatched' : ''}`}
                                    title={
                                        live
                                            ? `Matched live WAD: ${live}`
                                            : scan
                                              ? 'No matching live WAD found'
                                              : `${w.chunk_count} files, ${formatSize(w.size_bytes)}`
                                    }
                                >
                                    {w.name} · {w.chunk_count}
                                </span>
                            );
                        })}
                    </div>
                </div>
                <div className="manage-head-actions">
                    <button
                        type="button"
                        className="manage-btn manage-btn-primary"
                        onClick={runScan}
                        disabled={!leagueFinal || busy !== null}
                        title={leagueFinal ? 'Compare this mod against the live game files' : 'League install not detected'}
                    >
                        {scan ? <RescanIcon size={15} /> : <WrenchIcon size={15} />}
                        {busy === 'scan' ? 'Scanning…' : scan ? 'Re-scan' : 'Scan'}
                    </button>
                    <button
                        type="button"
                        className="manage-btn"
                        onClick={saveFixed}
                        disabled={busy !== null}
                        title={editCount > 0 ? `Save a copy with ${editCount} fix${editCount === 1 ? '' : 'es'} applied` : 'Save a copy of this mod'}
                    >
                        <SaveIcon size={15} />
                        {busy === 'save' ? 'Saving…' : editCount > 0 ? `Save fixed copy (${editCount})` : 'Save copy'}
                    </button>
                    <button type="button" className="manage-btn manage-btn-quiet" onClick={closeMod} disabled={busy !== null} title="Close this mod">
                        <CloseIcon size={15} />
                    </button>
                </div>
            </div>

            {error && <div className="manage-error">{error}</div>}

            {scan && scan.issues.length === 0 && (
                <div className="manage-card manage-healthy">
                    <OkIcon size={28} />
                    <div>
                        <div className="manage-healthy-title">This mod looks healthy</div>
                        <div className="manage-healthy-sub">
                            {scan.refs_checked} references checked across {scan.wads.reduce((n, w) => n + w.bins_parsed, 0)} bins — everything resolves against the live game.
                        </div>
                    </div>
                </div>
            )}

            {scan && scan.issues.length > 0 && (
                <>
                    <div className="manage-summary">
                        <span className="manage-summary-count manage-sev-error">
                            <ErrorIcon size={14} /> {scan.issues.filter((i) => i.severity === 'error').length} errors
                        </span>
                        <span className="manage-summary-count manage-sev-warning">
                            <WarnIcon size={14} /> {scan.issues.filter((i) => i.severity === 'warning').length} warnings
                        </span>
                        <span className="manage-summary-count manage-sev-info">
                            <InfoIcon size={14} /> {scan.issues.filter((i) => i.severity === 'info').length} info
                        </span>
                        {scan.truncated && <span className="manage-chip manage-chip-warn">list truncated</span>}
                        <div className="manage-summary-spacer" />
                        {confidentCount > 0 && (
                            <button type="button" className="manage-btn manage-btn-accent" onClick={applyAllConfident} disabled={busy !== null}>
                                <WrenchIcon size={14} />
                                Apply {confidentCount} confident fix{confidentCount === 1 ? '' : 'es'}
                            </button>
                        )}
                    </div>

                    <div className="manage-results">
                        <nav className="manage-cats">
                            {(
                                [
                                    ['all', 'All issues'],
                                    ['linked', 'Linked bins'],
                                    ['overrides', 'Dead overrides'],
                                    ['assets', 'Asset references'],
                                    ['other', 'Other'],
                                ] as Array<[Category, string]>
                            ).map(([key, label]) => (
                                <button
                                    key={key}
                                    type="button"
                                    className={`manage-cat${category === key ? ' active' : ''}`}
                                    onClick={() => setCategory(key)}
                                    disabled={counts[key] === 0 && key !== 'all'}
                                >
                                    <span>{label}</span>
                                    <span className="manage-cat-count">{counts[key]}</span>
                                </button>
                            ))}
                        </nav>

                        <div className="manage-issues">
                            {visibleIssues.map((issue) => {
                                const done = applied[issue.id];
                                const recommendsRemove = issue.recommended_action === 'remove';
                                const selected = choice[issue.id] ?? issue.recommended_path ?? issue.suggestions[0]?.path ?? '__custom__';
                                const isCustom = selected === '__custom__';
                                const canFix = issue.kind !== 'parse_error';
                                const canRemove = issue.kind === 'stale_override';
                                // When removal is the call, hide the rename picker — there's
                                // no live path to rename onto (it'd collide or be pointless).
                                const showRename = canFix && !recommendsRemove;
                                return (
                                    <div key={issue.id} className={`manage-issue manage-issue-${issue.severity}${done ? ' manage-issue-done' : ''}`}>
                                        <div className="manage-issue-head">
                                            <span className={`manage-issue-sev manage-sev-${issue.severity}`}>
                                                {done ? <OkIcon size={15} /> : severityIcon(issue.severity)}
                                            </span>
                                            <span className="manage-issue-kind">{KIND_LABEL[issue.kind]}</span>
                                            <span className="manage-issue-wad">{issue.wad_name}</span>
                                            {issue.ref_count > 1 && <span className="manage-issue-refs">×{issue.ref_count}</span>}
                                        </div>
                                        <div className="manage-issue-path" title={issue.path}>
                                            {issue.path}
                                        </div>
                                        {issue.owner && (
                                            <div className="manage-issue-owner" title={issue.owner}>
                                                referenced by {issue.owner}
                                            </div>
                                        )}
                                        <div className="manage-issue-msg">{done ? <>Fixed {done}</> : issue.message}</div>
                                        {!done && (showRename || canRemove) && (
                                            <div className="manage-issue-fix">
                                                {showRename && (
                                                    <>
                                                        <select
                                                            className="manage-fix-select"
                                                            value={selected}
                                                            onChange={(e) => setChoice((p) => ({ ...p, [issue.id]: e.target.value }))}
                                                        >
                                                            {issue.suggestions.map((s) => (
                                                                <option key={s.path} value={s.path}>
                                                                    {s.confidence_pct}% · {s.path}
                                                                </option>
                                                            ))}
                                                            <option value="__custom__">Custom path…</option>
                                                        </select>
                                                        {isCustom && (
                                                            <input
                                                                className="manage-fix-input"
                                                                type="text"
                                                                placeholder="assets/characters/…"
                                                                value={customPath[issue.id] ?? ''}
                                                                onChange={(e) => setCustomPath((p) => ({ ...p, [issue.id]: e.target.value }))}
                                                                spellCheck={false}
                                                            />
                                                        )}
                                                        <button
                                                            type="button"
                                                            className="manage-btn manage-btn-accent manage-btn-sm"
                                                            onClick={() => applyOne(issue)}
                                                            disabled={busy !== null || (isCustom && !(customPath[issue.id] ?? '').trim())}
                                                            title="Update the mod to point at the selected path"
                                                        >
                                                            <ArrowIcon size={13} />
                                                            Apply
                                                            {issue.auto_fixable && <span className="manage-rec-tag">Recommended</span>}
                                                        </button>
                                                    </>
                                                )}
                                                {canRemove && (
                                                    <button
                                                        type="button"
                                                        className={`manage-btn manage-btn-sm ${recommendsRemove ? 'manage-btn-accent' : 'manage-btn-quiet'}`}
                                                        onClick={() => removeChunk(issue)}
                                                        disabled={busy !== null}
                                                        title="Drop this file from the mod entirely"
                                                    >
                                                        <TrashIcon size={13} />
                                                        Remove file
                                                        {recommendsRemove && <span className="manage-rec-tag">Recommended</span>}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {visibleIssues.length === 0 && <div className="manage-issues-empty">No issues in this category.</div>}
                        </div>
                    </div>
                </>
            )}

            {!scan && busy !== 'scan' && (
                <div className="manage-card manage-prescan">
                    <WrenchIcon size={20} />
                    <span>
                        Hit <strong>Scan</strong> to compare this mod against your live game files
                        {!leagueFinal && ' — League install not detected, so scanning is unavailable'}
                        .
                    </span>
                </div>
            )}
        </div>
    );
}
