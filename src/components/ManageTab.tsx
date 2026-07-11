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

type RecommendedAction = 'update' | 'rename' | 'remove' | 'content_fix' | 'none';

type IssueKind =
    | 'missing_linked'
    | 'stale_override'
    | 'missing_asset'
    | 'wrong_extension'
    | 'parse_error'
    | 'sampler_key'
    | 'unreferenced_entry'
    | 'gameplay_bin'
    | 'tex_bad_dimensions';

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
    /** Ready-to-send structured fix for content issues (echoed back to
     *  mod_apply_fixes verbatim). Present only for content kinds. */
    recommended_fix?: object | null;
    /** Multi-line preview of what the fix changes. */
    detail?: string | null;
    /** Risk of the recommended fix: 'low' | 'medium' | 'high'. */
    risk?: 'low' | 'medium' | 'high' | null;
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

type Category = 'all' | 'linked' | 'overrides' | 'assets' | 'content' | 'other';

const CATEGORY_OF_KIND: Record<IssueKind, Category> = {
    missing_linked: 'linked',
    stale_override: 'overrides',
    missing_asset: 'assets',
    wrong_extension: 'assets',
    sampler_key: 'content',
    unreferenced_entry: 'content',
    gameplay_bin: 'content',
    tex_bad_dimensions: 'content',
    parse_error: 'other',
};

const KIND_LABEL: Record<IssueKind, string> = {
    missing_linked: 'Linked bin missing',
    stale_override: 'Dead override',
    missing_asset: 'Missing reference',
    wrong_extension: 'Extension changed',
    sampler_key: 'Material samplers',
    unreferenced_entry: 'Stale entry',
    gameplay_bin: 'Gameplay data',
    tex_bad_dimensions: 'Texture size',
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

interface CheckerPrefs {
    sampler: boolean;
    unreferenced: boolean;
    gameplay: boolean;
    texDims: boolean;
    autoSelect: boolean;
    showRisky: boolean;
}

const DEFAULT_CHECKER_PREFS: CheckerPrefs = {
    sampler: true,
    unreferenced: true,
    gameplay: true,
    texDims: true,
    autoSelect: true,
    showRisky: true,
};

/** Content-check kinds gated by a settings toggle. Reference-integrity
 *  kinds always run and aren't listed here. */
const KIND_PREF: Partial<Record<IssueKind, keyof CheckerPrefs>> = {
    sampler_key: 'sampler',
    unreferenced_entry: 'unreferenced',
    gameplay_bin: 'gameplay',
    tex_bad_dimensions: 'texDims',
};

export default function ManageTab({ active, onStatus }: ManageTabProps) {
    const [leagueFinal, setLeagueFinal] = useState<string | null>(null);
    const [prefs, setPrefs] = useState<CheckerPrefs>(DEFAULT_CHECKER_PREFS);
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

    // Load the mod-checker settings, and reload when the tab is (re)shown
    // or the Settings dialog fires a change so toggles take effect live.
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            const g = async (key: string) =>
                (await invoke<string>('get_preference', { key, defaultValue: 'True' })) === 'True';
            try {
                const next: CheckerPrefs = {
                    sampler: await g('ModCheckSampler'),
                    unreferenced: await g('ModCheckUnreferenced'),
                    gameplay: await g('ModCheckGameplay'),
                    texDims: await g('ModCheckTexDims'),
                    autoSelect: await g('ModCheckAutoSelect'),
                    showRisky: await g('ModCheckShowRisky'),
                };
                if (!cancelled) setPrefs(next);
            } catch {
                /* keep defaults */
            }
        };
        load();
        const onChange = () => load();
        window.addEventListener('modchecker-settings-changed', onChange);
        return () => {
            cancelled = true;
            window.removeEventListener('modchecker-settings-changed', onChange);
        };
    }, [active]);

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

    // Button label + past-tense note for a content fix, keyed off the
    // structured fix's kind so a "drop bin" doesn't read as "repaired".
    const contentFixMeta = (issue: ModIssue): { label: string; note: string } => {
        const kind = (issue.recommended_fix as { kind?: string } | null | undefined)?.kind;
        switch (kind) {
            case 'remove_chunk':
                return { label: 'Drop bin', note: 'bin dropped' };
            case 'remove_entry':
                return { label: 'Remove entry', note: 'entry removed' };
            case 'fix_tex_dimensions':
                return { label: 'Crop texture', note: 'cropped to ×4' };
            default:
                return { label: 'Apply fix', note: 'repaired' };
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
            const result = await invoke<{
                applied: number;
                bins_rewritten: number;
                errors: string[];
                results: Array<{ ok: boolean; error: string | null }>;
            }>('mod_apply_fixes', { id: mod.id, fixes: entries.map((e) => e.fix) });
            // Per-fix results come back in submit order — mark exactly the
            // issues that applied, so a partial failure no longer discards
            // the successes.
            setApplied((prev) => {
                const next = { ...prev };
                entries.forEach((e, i) => {
                    if (result.results[i]?.ok) next[e.issue.id] = e.note;
                });
                return next;
            });
            if (result.applied > 0) setEditCount((c) => c + result.applied);
            if (result.errors.length > 0) {
                const failed = result.errors.length;
                setError(result.errors.join('\n'));
                status(
                    result.applied > 0
                        ? `Applied ${result.applied}, ${failed} failed`
                        : `${failed} fix${failed === 1 ? '' : 'es'} failed`,
                );
            } else {
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
        // Content issues carry a ready-made structured fix — no path pick.
        if (issue.recommended_fix) {
            applyFixes([{ issue, fix: issue.recommended_fix, note: contentFixMeta(issue).note }]);
            return;
        }
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
        if (issue.recommended_fix) {
            return { issue, fix: issue.recommended_fix, note: contentFixMeta(issue).note };
        }
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
        for (const issue of shownIssues) {
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

    // Issues after applying the user's mod-checker settings: disabled
    // content checks are hidden, and risky findings are hidden unless the
    // user opted to see them. Everything downstream derives from this.
    const shownIssues = useMemo(() => {
        if (!scan) return [];
        return scan.issues.filter((i) => {
            const pref = KIND_PREF[i.kind];
            if (pref && !prefs[pref]) return false;
            if (!prefs.showRisky && (i.risk === 'medium' || i.risk === 'high')) return false;
            return true;
        });
    }, [scan, prefs]);

    const counts = useMemo(() => {
        const c: Record<Category, number> = { all: 0, linked: 0, overrides: 0, assets: 0, content: 0, other: 0 };
        for (const issue of shownIssues) {
            c.all++;
            c[CATEGORY_OF_KIND[issue.kind]]++;
        }
        return c;
    }, [shownIssues]);

    const visibleIssues = useMemo(() => {
        const order = { error: 0, warning: 1, info: 2 } as const;
        return shownIssues
            .filter((i) => category === 'all' || CATEGORY_OF_KIND[i.kind] === category)
            .sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));
    }, [shownIssues, category]);

    const confidentCount = useMemo(
        () => (prefs.autoSelect ? shownIssues.filter((i) => !applied[i.id] && i.auto_fixable).length : 0),
        [shownIssues, applied, prefs.autoSelect],
    );

    // Plain-language health verdict for the summary — leads with the worst
    // thing wrong so the user knows the stakes before drilling in.
    const verdict = useMemo(() => {
        if (shownIssues.length === 0) return null;
        const has = (k: IssueKind) => shownIssues.some((i) => i.kind === k);
        const errors = shownIssues.filter((i) => i.severity === 'error').length;
        const warnings = shownIssues.filter((i) => i.severity === 'warning').length;
        if (errors > 0) {
            if (has('missing_linked'))
                return 'This mod will crash on load until the missing linked bin is fixed.';
            return 'This mod is broken — part of it points at files the game no longer has.';
        }
        if (warnings > 0) {
            if (has('sampler_key'))
                return 'This mod will load, but a material is mis-keyed so the model will render white until fixed.';
            if (has('tex_bad_dimensions'))
                return 'This mod will load, but a texture has bad dimensions and may render as noise.';
            return 'This mod will load, but some references or assets may not apply correctly.';
        }
        return 'No blocking problems — just a few things worth a look.';
    }, [shownIssues]);

    const worstSeverity: ModIssue['severity'] = useMemo(() => {
        if (shownIssues.some((i) => i.severity === 'error')) return 'error';
        if (shownIssues.some((i) => i.severity === 'warning')) return 'warning';
        return 'info';
    }, [shownIssues]);

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
    const CATEGORY_TABS: Array<[Category, string]> = [
        ['all', 'All issues'],
        ['linked', 'Linked bins'],
        ['overrides', 'Dead overrides'],
        ['assets', 'Asset references'],
        ['content', 'Content'],
        ['other', 'Other'],
    ];
    return (
        <div className="manage-view">
            {/* Title + primary actions — mirrors the Extract tab's title row. */}
            <div className="manage-titlebar">
                <h1 className="manage-title" title={mod.name || mod.file_name}>
                    {mod.name || mod.file_name}
                    {mod.version && <span className="manage-title-version">v{mod.version}</span>}
                </h1>
                <div className="manage-title-actions">
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
                    <button type="button" className="manage-btn manage-btn-quiet manage-btn-icon" onClick={closeMod} disabled={busy !== null} title="Close this mod">
                        <CloseIcon size={16} />
                    </button>
                </div>
            </div>

            {/* Compact meta line — thumb + author/type/date + WAD chips. */}
            <div className="manage-meta">
                {mod.image_b64 && (
                    <img className="manage-meta-thumb" src={`data:image/png;base64,${mod.image_b64}`} alt="" draggable={false} />
                )}
                {mod.author && <span className="manage-meta-by">by {mod.author}</span>}
                <span className="manage-chip">{KIND_CHIP[mod.kind]}</span>
                {mod.created_ms && <span className="manage-chip">built {formatDate(mod.created_ms)}</span>}
                {scan?.game_newer_than_mod && <span className="manage-chip manage-chip-warn">game updated since</span>}
                <span className="manage-meta-spacer" />
                {mod.wads.map((w) => {
                    const live = scan?.wads.find((s) => s.name === w.name)?.live_wad;
                    return (
                        <span
                            key={w.name}
                            className={`manage-wad-chip${scan && !live ? ' manage-wad-chip-unmatched' : ''}`}
                            title={live ? `Matched live WAD: ${live}` : scan ? 'No matching live WAD found' : `${w.chunk_count} files, ${formatSize(w.size_bytes)}`}
                        >
                            {w.name} · {w.chunk_count}
                        </span>
                    );
                })}
            </div>

            {error && <div className="manage-error">{error}</div>}

            {/* Not scanned yet — a centered prompt filling the work area. */}
            {!scan && (
                <div className="manage-panel manage-panel-center">
                    <div className="manage-notice">
                        <WrenchIcon size={22} />
                        <span>
                            {busy === 'scan' ? (
                                'Scanning this mod against your live game files…'
                            ) : (
                                <>
                                    Hit <strong>Scan</strong> to compare this mod against your live game files
                                    {!leagueFinal && ' — League install not detected, so scanning is unavailable'}.
                                </>
                            )}
                        </span>
                    </div>
                </div>
            )}

            {/* Scanned & clean (or everything filtered out by settings). */}
            {scan && shownIssues.length === 0 && (
                <div className="manage-panel manage-panel-center">
                    <div className="manage-healthy">
                        <OkIcon size={26} />
                        <div>
                            <div className="manage-healthy-title">This mod looks healthy</div>
                            <div className="manage-healthy-sub">
                                {scan.refs_checked} references checked across {scan.wads.reduce((n, w) => n + w.bins_parsed, 0)} bins — everything resolves against the live game.
                                {scan.issues.length > 0 && (
                                    <> {scan.issues.length} finding{scan.issues.length === 1 ? '' : 's'} hidden by your Mod Checker settings.</>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Scanned with issues — full-height two-column workspace. */}
            {scan && shownIssues.length > 0 && (
                <div className="manage-cols">
                    <aside className="manage-sidebar">
                        <div className="manage-side-counts">
                            <span className="manage-count manage-sev-error"><ErrorIcon size={14} /> {shownIssues.filter((i) => i.severity === 'error').length}</span>
                            <span className="manage-count manage-sev-warning"><WarnIcon size={14} /> {shownIssues.filter((i) => i.severity === 'warning').length}</span>
                            <span className="manage-count manage-sev-info"><InfoIcon size={14} /> {shownIssues.filter((i) => i.severity === 'info').length}</span>
                        </div>
                        <div className="manage-side-title">Filter</div>
                        <nav className="manage-cats">
                            {CATEGORY_TABS.map(([key, label]) => (
                                <button
                                    key={key}
                                    type="button"
                                    className={`manage-cat${category === key ? ' active' : ''}`}
                                    onClick={() => setCategory(key)}
                                    disabled={counts[key] === 0 && key !== 'all'}
                                >
                                    <span className="manage-cat-label">{label}</span>
                                    <span className="manage-cat-count">{counts[key]}</span>
                                </button>
                            ))}
                        </nav>
                        {confidentCount > 0 && (
                            <div className="manage-side-actions">
                                <button type="button" className="manage-btn manage-btn-accent manage-btn-block" onClick={applyAllConfident} disabled={busy !== null}>
                                    <WrenchIcon size={14} />
                                    Apply {confidentCount} confident fix{confidentCount === 1 ? '' : 'es'}
                                </button>
                            </div>
                        )}
                    </aside>

                    <div className="manage-work">
                        {verdict && (
                            <div className={`manage-verdict manage-verdict-${worstSeverity}`}>
                                {severityIcon(worstSeverity)}
                                <span>{verdict}</span>
                                {scan.truncated && <span className="manage-chip manage-chip-warn">list truncated</span>}
                            </div>
                        )}
                        <div className="manage-panel">
                            <div className="manage-list">
                                {visibleIssues.map((issue) => {
                                    const done = applied[issue.id];
                                    const recommendsRemove = issue.recommended_action === 'remove';
                                    const isContentFix = !!issue.recommended_fix;
                                    const selected = choice[issue.id] ?? issue.recommended_path ?? issue.suggestions[0]?.path ?? '__custom__';
                                    const isCustom = selected === '__custom__';
                                    const canFix = issue.kind !== 'parse_error';
                                    const canRemove = issue.kind === 'stale_override';
                                    const showRename = canFix && !recommendsRemove && !isContentFix;
                                    return (
                                        <div key={issue.id} className={`manage-row manage-row-${issue.severity}${done ? ' manage-row-done' : ''}`}>
                                            <span className="manage-row-sev">
                                                {done ? <OkIcon size={16} /> : severityIcon(issue.severity)}
                                            </span>
                                            <div className="manage-row-body">
                                                <div className="manage-row-top">
                                                    <span className="manage-row-kind">{KIND_LABEL[issue.kind]}</span>
                                                    <span className="manage-row-wad">{issue.wad_name}</span>
                                                    {issue.ref_count > 1 && <span className="manage-row-refs">×{issue.ref_count}</span>}
                                                    {issue.risk && <span className={`manage-issue-risk manage-risk-${issue.risk}`}>{issue.risk} risk</span>}
                                                </div>
                                                <div className="manage-row-path" title={issue.path}>{issue.path}</div>
                                                {issue.owner && (
                                                    <div className="manage-row-owner" title={issue.owner}>referenced by {issue.owner}</div>
                                                )}
                                                <div className="manage-row-msg">{done ? `Fixed ${done}` : issue.message}</div>
                                                {!done && issue.detail && <pre className="manage-row-detail">{issue.detail}</pre>}
                                                {!done && isContentFix && (
                                                    <div className="manage-row-fix">
                                                        <button
                                                            type="button"
                                                            className="manage-btn manage-btn-accent manage-btn-sm"
                                                            onClick={() => applyOne(issue)}
                                                            disabled={busy !== null}
                                                            title="Apply this fix"
                                                        >
                                                            <WrenchIcon size={13} />
                                                            {contentFixMeta(issue).label}
                                                            {issue.auto_fixable && <span className="manage-rec-tag">Recommended</span>}
                                                        </button>
                                                    </div>
                                                )}
                                                {!done && !isContentFix && (showRename || canRemove) && (
                                                    <div className="manage-row-fix">
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
                                        </div>
                                    );
                                })}
                                {visibleIssues.length === 0 && <div className="manage-list-empty">No issues in this category.</div>}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
