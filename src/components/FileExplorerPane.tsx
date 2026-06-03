/**
 * File Explorer pane — dockable folder browser, studio-shell only.
 *
 * Stage 1 of the feature plan in `docs/file-explorer-plan.md`:
 * tree view, folder mode, virtualized rows, keyboard nav (VS Code
 * bindings), context menu + header buttons for New File / New Folder
 * / Rename / Delete, manual refresh. Grid view, WAD mode, the
 * `notify` watcher, and Extract-WAD all land in later stages.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
    ChevronRight,
    ChevronDown,
    FilePlus,
    FolderPlus,
    RefreshCw,
    FolderOpen,
    ExternalLink,
    LayoutGrid,
    List as ListIcon,
    ArrowUp,
    Download as DownloadIcon,
    Search as SearchIcon,
    X as XIcon,
} from 'lucide-react';
import { FormatIcon, FileTypeIcon } from './FormatIcons';
import type { FileExplorerRoot } from '../shells/ShellContext';
import { useDrag } from '../lib/dnd';
import './FileExplorerPane.css';

interface WadEntry {
    path: string;
    path_hash_hex: string;
    size: number;
    compressed_size: number;
    compression: string;
    is_duplicated: boolean;
    unknown: boolean;
}

const ROW_HEIGHT = 22;
const INDENT_PX = 14;
const OVERSCAN = 6;

const GRID_CELL_SIZE = 96;
const GRID_CELL_PAD = 8;
// Bigger batch size now that the Rust decoder is parallel + downscales
// before PNG-encoding — per-thumbnail cost dropped enough that we can
// ship 32 paths per IPC call without stalling the UI.
const THUMB_BATCH = 32;
// Cap on concurrent decode batches in flight. Rayon already saturates
// CPU cores per batch; running two batches simultaneously hides the
// IPC + scheduler overhead between flushes so the queue drains
// smoothly during fast scrolls.
const THUMB_MAX_IN_FLIGHT = 2;
const THUMB_CACHE_LIMIT = 500;
const IMAGE_EXTS = new Set(['tex', 'dds', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

type ViewMode = 'tree' | 'grid';

interface ThumbResult {
    path: string;
    data_url: string | null;
    width: number;
    height: number;
    error: string | null;
}

interface DirEntry {
    name: string;
    path: string;
    is_dir: boolean;
    size: number;
    modified: number;
    extension: string;
}

interface ExplorerNode {
    path: string;
    name: string;
    isDir: boolean;
    ext: string;
    size: number;
    /** Unix-seconds mtime; 0 for folders or unknown. */
    mtime: number;
    /** Lazily-loaded children. `null` = not loaded yet. */
    children: ExplorerNode[] | null;
    loadError: string | null;
}

interface FlatRow {
    node: ExplorerNode;
    depth: number;
}

interface FileExplorerPaneProps {
    root: FileExplorerRoot | null;
    onPickFolder: () => void;
    onPickWad?: () => void;
    onOpenFile: (path: string) => void;
    setRoot?: (root: FileExplorerRoot | null) => void;
    setStatusMessage?: (msg: string) => void;
    /** Right-click on a `.skn` (on-disk root only — not inside a WAD)
     *  surfaces "Open in Animation Studio as source / target". Wired
     *  by App.tsx to spin up an animstudio tab pre-loaded with the
     *  picked SKN on the requested side. */
    onOpenInAnimStudio?: (sknPath: string, side: 'source' | 'target') => void;
    /** Right-click on a `.anm` surfaces "Load as source clip in
     *  Animation Studio". Loads into the most-recent open animstudio
     *  tab, or spawns a new one. */
    onLoadAnmInAnimStudio?: (anmPath: string) => void;
}

const STORAGE_KEY_EXPANDED = 'file-explorer-expanded';
const STORAGE_KEY_SELECTED = 'file-explorer-selected';
const STORAGE_KEY_VIEW_MODE = 'file-explorer-view-mode';
const STORAGE_KEY_GRID_FOLDER = 'file-explorer-grid-folder';
const STORAGE_KEY_SORT = 'file-explorer-sort';

type SortKey = 'type' | 'name' | 'size' | 'mtime';
type SortDir = 'asc' | 'desc';
interface SortSpec { key: SortKey; dir: SortDir }

const DEFAULT_SORT: SortSpec = { key: 'type', dir: 'asc' };

interface RecursiveEntry {
    rel_path: string;
    is_dir: boolean;
    extension: string;
}

function loadSortSpec(): SortSpec {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY_SORT);
        if (!raw) return DEFAULT_SORT;
        const parsed = JSON.parse(raw) as Partial<SortSpec>;
        const key: SortKey = parsed.key === 'name' || parsed.key === 'size' || parsed.key === 'mtime' || parsed.key === 'type'
            ? parsed.key : 'type';
        const dir: SortDir = parsed.dir === 'desc' ? 'desc' : 'asc';
        return { key, dir };
    } catch { return DEFAULT_SORT; }
}

/** Tiny LRU for decoded-thumbnail data URLs. Capped at
 *  THUMB_CACHE_LIMIT entries so a 5000-image folder doesn't balloon
 *  memory while the user scrolls through it. */
class ThumbLRU {
    private map = new Map<string, string>();
    constructor(private capacity: number) {}
    get(key: string): string | undefined {
        const v = this.map.get(key);
        if (v !== undefined) {
            // Re-insert so most-recent stays at the end.
            this.map.delete(key);
            this.map.set(key, v);
        }
        return v;
    }
    set(key: string, value: string): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.capacity) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
        }
    }
    has(key: string): boolean { return this.map.has(key); }
}

function entryToNode(e: DirEntry): ExplorerNode {
    return {
        path: e.path,
        name: e.name,
        isDir: e.is_dir,
        ext: e.extension,
        size: e.size,
        mtime: e.modified,
        children: null,
        loadError: null,
    };
}

function sortNodes(nodes: ExplorerNode[], spec: SortSpec): ExplorerNode[] {
    const sign = spec.dir === 'asc' ? 1 : -1;
    return [...nodes].sort((a, b) => {
        // 'type' keeps folders pinned regardless of direction — that's
        // what users expect from VS Code / Cursor's "folders first"
        // toggle. Within a kind, name asc/desc applies.
        if (spec.key === 'type' && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        // For non-type keys, still keep folders ahead unless the
        // user explicitly sorts files-with-folders; we go with the
        // pinned-folders default since the "type" key is the way to
        // express the alternative.
        if (a.isDir !== b.isDir && spec.key !== 'name') return a.isDir ? -1 : 1;
        let cmp = 0;
        switch (spec.key) {
            case 'name':
            case 'type':
                cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                break;
            case 'size':
                cmp = a.size - b.size;
                break;
            case 'mtime':
                cmp = a.mtime - b.mtime;
                break;
        }
        return cmp * sign;
    });
}

/** Walk `node` looking for the child whose `.path === target`. Returns
 *  null if nothing in the loaded subtree matches. */
function findNode(node: ExplorerNode, target: string): ExplorerNode | null {
    if (node.path === target) return node;
    if (!node.children) return null;
    for (const c of node.children) {
        const hit = findNode(c, target);
        if (hit) return hit;
    }
    return null;
}

function flatten(
    root: ExplorerNode,
    expanded: Set<string>,
    sortSpec: SortSpec,
    forceExpand: boolean,
    visiblePaths: Set<string> | null,
): FlatRow[] {
    const out: FlatRow[] = [];
    const walk = (n: ExplorerNode, depth: number) => {
        if (visiblePaths && !visiblePaths.has(n.path)) return;
        out.push({ node: n, depth });
        const isExpanded = forceExpand || expanded.has(n.path);
        if (n.isDir && isExpanded && n.children) {
            for (const c of sortNodes(n.children, sortSpec)) walk(c, depth + 1);
        }
    };
    if (root.children) {
        for (const c of sortNodes(root.children, sortSpec)) walk(c, 0);
    }
    return out;
}

function loadStringSet(key: string): Set<string> {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return new Set();
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) return new Set(arr.filter(s => typeof s === 'string'));
    } catch { /* ignore */ }
    return new Set();
}

function saveStringSet(key: string, set: Set<string>): void {
    try { window.localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

function parentDirOf(p: string): string {
    // Keep the input's separator style — paths coming back from
    // `list_directory` are native (`\` on Windows), and `loadChildren`
    // calls Rust again with the parent path. Normalising to `/` here
    // was making the "Up" button look like it always jumped to root
    // because the new path no longer compared equal to the root.
    let lastSep = -1;
    for (let i = p.length - 1; i >= 0; i--) {
        if (p[i] === '/' || p[i] === '\\') { lastSep = i; break; }
    }
    if (lastSep <= 0) return p;
    return p.slice(0, lastSep);
}

/** Single-confirm modal for the delete action. Reused as the pane's
 *  in-flight inline dialog so we don't depend on a global toast. */
function ConfirmDelete({
    target,
    onConfirm,
    onCancel,
}: {
    target: ExplorerNode;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="fe-modal-backdrop" onClick={onCancel}>
            <div className="fe-modal" onClick={e => e.stopPropagation()}>
                <div className="fe-modal-title">Delete {target.isDir ? 'folder' : 'file'}?</div>
                <div className="fe-modal-body">
                    <code>{target.name}</code>
                    {target.isDir && (
                        <div className="fe-modal-warn">All contents will be removed.</div>
                    )}
                </div>
                <div className="fe-modal-actions">
                    <button className="fe-btn" onClick={onCancel}>Cancel</button>
                    <button className="fe-btn fe-btn-danger" onClick={onConfirm}>Delete</button>
                </div>
            </div>
        </div>
    );
}

/** Blender-style file grid. One folder at a time, ~96px cells, with
 *  IntersectionObserver-driven thumbnail loading: image / texture
 *  cells request a decoded PNG via `decode_texture_paths_to_png` only
 *  when they scroll into view, and only in batches so IPC overhead
 *  doesn't dominate. */
function ExplorerGrid({
    entries,
    selectedPath,
    setSelectedPath,
    onActivate,
    onContextMenu,
    onPointerDownDrag,
    thumbCache,
    thumbPending,
    thumbVersion,
    onThumbVersionBump,
    setStatusMessage,
    filter,
    sortSpec,
}: {
    entries: ExplorerNode[];
    selectedPath: string | null;
    setSelectedPath: (p: string | null) => void;
    onActivate: (node: ExplorerNode) => void;
    onContextMenu: (node: ExplorerNode, x: number, y: number) => void;
    onPointerDownDrag: (e: React.PointerEvent<HTMLElement>, node: ExplorerNode) => void;
    thumbCache: ThumbLRU;
    thumbPending: Set<string>;
    thumbVersion: number;
    onThumbVersionBump: () => void;
    setStatusMessage?: (msg: string) => void;
    filter: string;
    sortSpec: SortSpec;
}) {
    const observerRef = useRef<IntersectionObserver | null>(null);
    const visibleQueueRef = useRef<Set<string>>(new Set());
    const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Number of `decode_texture_paths_to_png` calls currently
     *  awaiting a response. Caps at `THUMB_MAX_IN_FLIGHT` so we
     *  don't queue an unbounded number of concurrent calls during
     *  fast scrolls — each call already saturates CPU cores via
     *  rayon, so more concurrency only adds scheduling cost. */
    const inFlightRef = useRef<number>(0);

    // Flush queued visible thumbnails. Multiple batches can be in
    // flight simultaneously up to THUMB_MAX_IN_FLIGHT so the IPC
    // pipeline stays full while one batch is still decoding.
    const flushQueue = useCallback(async () => {
        flushTimerRef.current = null;
        while (inFlightRef.current < THUMB_MAX_IN_FLIGHT) {
            const todo: string[] = [];
            // Snapshot the queue into an array so we can iterate and
            // mutate (delete consumed entries) without invalidating
            // the iterator. The Set keeps us O(1) on add/has from the
            // observer side.
            const queue = Array.from(visibleQueueRef.current);
            for (const p of queue) {
                if (thumbCache.has(p) || thumbPending.has(p)) {
                    visibleQueueRef.current.delete(p);
                    continue;
                }
                thumbPending.add(p);
                visibleQueueRef.current.delete(p);
                todo.push(p);
                if (todo.length >= THUMB_BATCH) break;
            }
            if (todo.length === 0) return;
            inFlightRef.current += 1;
            // Don't await here — let the next iteration of the while
            // loop kick off another batch in parallel up to the cap.
            invoke<ThumbResult[]>('decode_texture_paths_to_png', { paths: todo })
                .then(results => {
                    for (const r of results) {
                        thumbPending.delete(r.path);
                        if (r.data_url) thumbCache.set(r.path, r.data_url);
                    }
                    onThumbVersionBump();
                })
                .catch(e => {
                    for (const p of todo) thumbPending.delete(p);
                    const msg = e instanceof Error ? e.message : String(e);
                    setStatusMessage?.(`Thumbnail decode failed: ${msg}`);
                })
                .finally(() => {
                    inFlightRef.current -= 1;
                    // Pick up any cells that scrolled into view while
                    // we were decoding.
                    if (visibleQueueRef.current.size > 0 && !flushTimerRef.current) {
                        flushTimerRef.current = setTimeout(() => {
                            flushQueueRef.current?.();
                        }, 20);
                    }
                });
        }
    }, [thumbCache, thumbPending, onThumbVersionBump, setStatusMessage]);

    // Keep the latest flushQueue reachable from the observer callback
    // without rebuilding the observer every render — the callback was
    // closing over a stale flushQueue when the deps array changed.
    const flushQueueRef = useRef<(() => Promise<void>) | null>(null);
    flushQueueRef.current = flushQueue;

    // The observer is built ONCE per mount. The previous version
    // re-created it on every flushQueue change, which meant the
    // initial cells (mounted before the very first useEffect ran)
    // never got observed — that was the "thumbs stop loading on
    // scroll" bug. Now we also scan existing `[data-path]` cells
    // when the observer first comes online so the initial viewport
    // gets covered.
    useEffect(() => {
        const obs = new IntersectionObserver((records) => {
            let changed = false;
            for (const r of records) {
                const path = (r.target as HTMLElement).dataset.path;
                if (!path) continue;
                if (r.isIntersecting) {
                    if (!thumbCache.has(path) && !thumbPending.has(path)) {
                        visibleQueueRef.current.add(path);
                        changed = true;
                    }
                }
            }
            if (changed && !flushTimerRef.current) {
                flushTimerRef.current = setTimeout(() => {
                    flushQueueRef.current?.();
                }, 50);
            }
        }, { rootMargin: '160px' });
        observerRef.current = obs;
        // Catch up: observe any cells the initial render already
        // committed before the observer existed.
        const initial = document.querySelectorAll('.fe-grid [data-path]');
        initial.forEach(el => obs.observe(el));
        return () => {
            obs.disconnect();
            observerRef.current = null;
            if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
        };
    }, [thumbCache, thumbPending]);

    const cellRef = useCallback((el: HTMLDivElement | null) => {
        if (!el) return;
        const obs = observerRef.current;
        if (obs) obs.observe(el);
    }, []);

    // Honour the same sort spec the tree uses, plus the filter for
    // the current folder (grid is non-recursive — only the visible
    // folder's contents are filtered).
    const sorted = useMemo(() => {
        const filtered = filter
            ? entries.filter(e => e.name.toLowerCase().includes(filter))
            : entries;
        return sortNodes(filtered, sortSpec);
    }, [entries, filter, sortSpec]);

    return (
        <div
            className="fe-grid"
            style={{
                gridTemplateColumns: `repeat(auto-fill, minmax(${GRID_CELL_SIZE}px, 1fr))`,
                gap: GRID_CELL_PAD,
            }}
            data-thumb-version={thumbVersion}
        >
            {sorted.length === 0 && (
                <div className="fe-grid-empty">Empty folder</div>
            )}
            {sorted.map((node) => {
                const isImage = !node.isDir && IMAGE_EXTS.has(node.ext);
                const isSelected = node.path === selectedPath;
                const thumb = isImage ? thumbCache.get(node.path) : undefined;
                return (
                    <div
                        key={node.path}
                        ref={isImage ? cellRef : undefined}
                        data-path={isImage ? node.path : undefined}
                        className={`fe-cell${isSelected ? ' fe-cell-selected' : ''}`}
                        onPointerDown={(e) => {
                            setSelectedPath(node.path);
                            onPointerDownDrag(e, node);
                        }}
                        onDoubleClick={() => onActivate(node)}
                        onContextMenu={(e) => { e.preventDefault(); onContextMenu(node, e.clientX, e.clientY); }}
                        title={node.name}
                    >
                        <div className="fe-cell-thumb">
                            {thumb ? (
                                <img src={thumb} alt={node.name} loading="lazy" draggable={false} />
                            ) : node.isDir ? (
                                <FormatIcon isFolder size={48} />
                            ) : (
                                <FileTypeIcon
                                    extension={node.ext}
                                    fileName={node.name}
                                    size={isImage ? 40 : 48}
                                />
                            )}
                        </div>
                        <div className="fe-cell-name">{node.name}</div>
                    </div>
                );
            })}
        </div>
    );
}

export default function FileExplorerPane({
    root,
    onPickFolder,
    onPickWad,
    onOpenFile,
    setRoot,
    setStatusMessage,
    onOpenInAnimStudio,
    onLoadAnmInAnimStudio,
}: FileExplorerPaneProps) {
    // Derive the "root path" used as a key throughout the pane: the
    // folder path for disk roots, or a synthetic `wad://<id>` for
    // mounted WADs. Synthetic prefix means existing path-keyed state
    // (expanded set, selection, grid folder) keeps working without
    // a structural rewrite.
    const rootPath = root === null
        ? null
        : root.kind === 'folder' ? root.path : `wad://${root.mountId}`;
    const isWadRoot = root?.kind === 'wad';
    const [rootNode, setRootNode] = useState<ExplorerNode | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(() => loadStringSet(STORAGE_KEY_EXPANDED));
    const [selectedPath, setSelectedPath] = useState<string | null>(() => {
        try { return window.localStorage.getItem(STORAGE_KEY_SELECTED); } catch { return null; }
    });
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [creating, setCreating] = useState<{ parent: string; kind: 'file' | 'folder' } | null>(null);
    const [createValue, setCreateValue] = useState('');
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: ExplorerNode } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<ExplorerNode | null>(null);
    const ctxMenuRef = useRef<HTMLDivElement | null>(null);
    const drag = useDrag();

    // Drag-source — pointer-driven (NOT HTML5 native), because
    // Tauri 2's `dragDropEnabled: true` interceptor (which we need
    // for OS file drops) swallows HTML5 dragover/drop events
    // before they reach the DOM (refs: tauri#14373, tauri#9445).
    // Pointer events bypass that subsystem entirely. The actual
    // drag-tracking + ghost rendering lives in `DragProvider`;
    // here we just feed it the path on pointerdown.
    const onRowPointerDown = (e: React.PointerEvent<HTMLElement>, node: ExplorerNode) => {
        // Folders aren't useful payloads — none of our editors
        // accept a directory. Skip them entirely.
        if (node.isDir) return;
        if (e.button !== 0) return; // primary button only
        if (!drag) return;
        drag.beginDrag(node.path, node.name, e.clientX, e.clientY);
    };

    // Clamp the right-click context menu so it never escapes the
    // viewport. Without this, opening the menu near the bottom or
    // right edge clips items off-screen. Measured + adjusted in a
    // layout effect so the menu paints once at the corrected
    // position — no flicker.
    useLayoutEffect(() => {
        if (!contextMenu || !ctxMenuRef.current) return;
        const el = ctxMenuRef.current;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 6;
        let left = contextMenu.x;
        let top = contextMenu.y;
        if (left + rect.width > vw - margin) {
            // Flip to the left of the cursor; clamp to viewport if
            // the menu is wider than the cursor's distance to the
            // left edge.
            left = Math.max(margin, contextMenu.x - rect.width);
            if (left + rect.width > vw - margin) left = vw - rect.width - margin;
        }
        if (top + rect.height > vh - margin) {
            top = Math.max(margin, contextMenu.y - rect.height);
            if (top + rect.height > vh - margin) top = vh - rect.height - margin;
        }
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }, [contextMenu]);

    // ── Reveal-in-Explorer pulse listener ───────────────────────
    // App.tsx writes `file-explorer-reveal-pulse` and dispatches a
    // `file-explorer-reveal` event when the user picks "Reveal in
    // Explorer" on a tab. We expand every ancestor folder between
    // the current root and the target, then select the target.
    useEffect(() => {
        const onReveal = async () => {
            try {
                const pulse = window.localStorage.getItem('file-explorer-reveal-pulse');
                if (!pulse) return;
                const [, ...rest] = pulse.split('|');
                const target = rest.join('|');
                if (!target || !rootPath) return;
                const targetNorm = target.replace(/\\/g, '/');
                const rootNorm = rootPath.replace(/\\/g, '/');
                if (!targetNorm.startsWith(rootNorm + '/')) return;
                // Compute every ancestor folder path the target lives
                // under, push them all into `expanded`.
                const rel = targetNorm.slice(rootNorm.length + 1);
                const parts = rel.split('/');
                const ancestorPaths: string[] = [];
                let acc = rootNorm;
                for (let i = 0; i < parts.length - 1; i++) {
                    acc = `${acc}/${parts[i]}`;
                    ancestorPaths.push(acc);
                }
                setExpanded(prev => {
                    const next = new Set(prev);
                    for (const p of ancestorPaths) next.add(p);
                    return next;
                });
                setSelectedPath(targetNorm);
                // Lazy-load any unloaded ancestors so the chain is
                // actually visible. We walk the tree breadth-first.
                if (rootNode) {
                    const queue: ExplorerNode[] = rootNode.children ? [...rootNode.children] : [];
                    while (queue.length > 0) {
                        const n = queue.shift()!;
                        if (!n.isDir) continue;
                        if (!ancestorPaths.includes(n.path) && n.path !== targetNorm) continue;
                        if (n.children === null) {
                            await ensureChildren(n);
                            bumpRender();
                        }
                        if (n.children) queue.push(...n.children);
                    }
                }
            } catch { /* ignore */ }
        };
        window.addEventListener('file-explorer-reveal', onReveal);
        // Also fire once on mount in case the pulse landed before us.
        onReveal();
        return () => window.removeEventListener('file-explorer-reveal', onReveal);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rootPath, rootNode]);

    // ── Filter row state ────────────────────────────────────────
    // The filter is ephemeral by design — typing a query and hopping
    // tabs shouldn't leave it set when the user comes back. Stored
    // in component state only.
    const [filter, setFilter] = useState('');
    const filterLower = filter.trim().toLowerCase();
    // Recursive index — lazy-fetched the first time the filter
    // becomes non-empty, refreshed on root change or manual refresh.
    const [recursiveIndex, setRecursiveIndex] = useState<RecursiveEntry[] | null>(null);
    const [recursiveIndexLoading, setRecursiveIndexLoading] = useState(false);

    useEffect(() => {
        // Drop the index whenever the root changes — both folder
        // path and WAD mount-id swaps land here.
        setRecursiveIndex(null);
    }, [rootPath]);

    useEffect(() => {
        if (!filterLower) return;
        if (recursiveIndex !== null || recursiveIndexLoading) return;
        if (!rootPath) return;
        setRecursiveIndexLoading(true);
        (async () => {
            try {
                if (isWadRoot && wadEntriesRef.current) {
                    // For WAD roots we already have the flat list — no
                    // need to ask Rust to walk anything.
                    const entries: RecursiveEntry[] = wadEntriesRef.current.map(e => {
                        const idx = e.path.lastIndexOf('.');
                        return {
                            rel_path: e.path,
                            is_dir: false,
                            extension: idx > 0 ? e.path.slice(idx + 1).toLowerCase() : '',
                        };
                    });
                    setRecursiveIndex(entries);
                } else if (rootPath) {
                    const entries = await invoke<RecursiveEntry[]>('list_directory_recursive', { path: rootPath });
                    setRecursiveIndex(entries);
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setStatusMessage?.(`Filter index failed: ${msg}`);
                setRecursiveIndex([]);
            } finally {
                setRecursiveIndexLoading(false);
            }
        })();
    }, [filterLower, recursiveIndex, recursiveIndexLoading, rootPath, isWadRoot, setStatusMessage]);

    // Sort preference — persists across sessions, applied to all
    // children lists in both tree and grid modes.
    const [sortSpec, setSortSpec] = useState<SortSpec>(loadSortSpec);
    const [sortMenuOpen, setSortMenuOpen] = useState(false);
    useEffect(() => {
        try { window.localStorage.setItem(STORAGE_KEY_SORT, JSON.stringify(sortSpec)); } catch { /* */ }
    }, [sortSpec]);

    // ── Grid mode state ─────────────────────────────────────────
    // Grid mode shows ONE folder at a time (Blender-style). Tree
    // mode shows the hierarchy. The toggle survives sessions.
    const [viewMode, setViewMode] = useState<ViewMode>(() => {
        try { return (window.localStorage.getItem(STORAGE_KEY_VIEW_MODE) as ViewMode) === 'grid' ? 'grid' : 'tree'; } catch { return 'tree'; }
    });
    const [gridFolderPath, setGridFolderPath] = useState<string | null>(() => {
        try { return window.localStorage.getItem(STORAGE_KEY_GRID_FOLDER); } catch { return null; }
    });
    const [gridEntries, setGridEntries] = useState<ExplorerNode[]>([]);
    const [gridLoadError, setGridLoadError] = useState<string | null>(null);

    useEffect(() => { try { window.localStorage.setItem(STORAGE_KEY_VIEW_MODE, viewMode); } catch { /* */ } }, [viewMode]);
    useEffect(() => {
        try {
            if (gridFolderPath) window.localStorage.setItem(STORAGE_KEY_GRID_FOLDER, gridFolderPath);
            else window.localStorage.removeItem(STORAGE_KEY_GRID_FOLDER);
        } catch { /* */ }
    }, [gridFolderPath]);

    // ── WAD extraction state ────────────────────────────────────
    const [extractInFlight, setExtractInFlight] = useState(false);

    const extractEntireWad = useCallback(async () => {
        if (root?.kind !== 'wad') return;
        if (extractInFlight) return;
        try {
            const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
            // Default target dir = the WAD's parent folder. The user
            // confirms in the picker; the wad-stem subfolder is added
            // automatically below.
            const picked = await openDialog({ directory: true, multiple: false });
            if (typeof picked !== 'string') return;
            // Compute the wad stem (strip `.wad.client` / `.wad`).
            const wadName = root.label;
            const stem = wadName
                .replace(/\.wad\.client$/i, '')
                .replace(/\.wad$/i, '');
            const sep = picked.includes('\\') ? '\\' : '/';
            const targetDir = picked.endsWith(sep) ? `${picked}${stem}` : `${picked}${sep}${stem}`;
            setExtractInFlight(true);
            setStatusMessage?.(`Extracting ${wadName}…`);
            const actionId = `fe-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            try {
                await invoke('wad_extract', {
                    id: root.mountId,
                    outputDir: targetDir,
                    actionId,
                    selectedHashes: null,
                    useRename: true,
                    flatten: false,
                });
                setStatusMessage?.(`Extracted ${wadName} → ${targetDir}`);
                // Switch the explorer to the freshly-extracted folder
                // so the user can edit files in place. Unmount the
                // source WAD in the same step (the new root has the
                // same content on disk).
                const oldMount = root.mountId;
                setRoot?.({ kind: 'folder', path: targetDir });
                invoke('wad_close', { id: oldMount }).catch(() => {});
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setStatusMessage?.(`Extract failed: ${msg}`);
            } finally {
                setExtractInFlight(false);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatusMessage?.(`Extract failed: ${msg}`);
            setExtractInFlight(false);
        }
    }, [root, extractInFlight, setRoot, setStatusMessage]);

    const extractWadEntry = useCallback(async (node: ExplorerNode) => {
        if (root?.kind !== 'wad' || node.isDir) return;
        try {
            const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
            const picked = await openDialog({ directory: true, multiple: false });
            if (typeof picked !== 'string') return;
            // node.path is the WAD-relative path. We need its hash.
            const list = wadEntriesRef.current;
            if (!list) {
                setStatusMessage?.('WAD entry list not ready');
                return;
            }
            const match = list.find(e => e.path === node.path);
            if (!match) {
                setStatusMessage?.('Entry not found in WAD');
                return;
            }
            const actionId = `fe-extract-one-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            setStatusMessage?.(`Extracting ${node.name}…`);
            await invoke('wad_extract', {
                id: root.mountId,
                outputDir: picked,
                actionId,
                selectedHashes: [match.path_hash_hex],
                useRename: true,
                flatten: false,
            });
            setStatusMessage?.(`Extracted ${node.name} → ${picked}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatusMessage?.(`Extract failed: ${msg}`);
        }
    }, [root, setStatusMessage]);

    // Thumb cache lives in a ref so we don't trip re-renders when
    // populating it. A render counter forces redraws when new thumbs
    // land for the visible cells.
    const thumbCacheRef = useRef<ThumbLRU>(new ThumbLRU(THUMB_CACHE_LIMIT));
    const thumbPendingRef = useRef<Set<string>>(new Set());
    const [thumbVersion, setThumbVersion] = useState(0);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(400);

    // Type-ahead — when the user types letters in quick succession we
    // jump selection to the next sibling that matches the running buffer.
    const typeAheadRef = useRef<{ buf: string; timer: ReturnType<typeof setTimeout> | null }>({ buf: '', timer: null });

    // Persist expanded set / selection across pane open/close.
    useEffect(() => { saveStringSet(STORAGE_KEY_EXPANDED, expanded); }, [expanded]);
    useEffect(() => {
        try {
            if (selectedPath) window.localStorage.setItem(STORAGE_KEY_SELECTED, selectedPath);
            else window.localStorage.removeItem(STORAGE_KEY_SELECTED);
        } catch { /* ignore */ }
    }, [selectedPath]);

    // ── Root loading ──────────────────────────────────────────────
    /** Cache of the WAD's full entry list. Built once per mount; the
     *  synthetic tree resolves children by prefix-filtering this list. */
    const wadEntriesRef = useRef<WadEntry[] | null>(null);

    /** Build the immediate children of `wadRelPath` (no leading slash;
     *  empty string = WAD root) by prefix-filtering the cached entry
     *  list. Folders are synthesised from path segments. */
    const buildWadChildren = useCallback((wadRelPath: string): ExplorerNode[] => {
        const all = wadEntriesRef.current ?? [];
        const prefix = wadRelPath === '' ? '' : wadRelPath + '/';
        const folderNames = new Set<string>();
        const files: ExplorerNode[] = [];
        for (const e of all) {
            if (!e.path.startsWith(prefix)) continue;
            const rest = e.path.slice(prefix.length);
            if (rest === '') continue;
            const slashIdx = rest.indexOf('/');
            if (slashIdx >= 0) {
                folderNames.add(rest.slice(0, slashIdx));
            } else {
                const ext = rest.lastIndexOf('.') > 0 ? rest.slice(rest.lastIndexOf('.') + 1).toLowerCase() : '';
                files.push({
                    // Use the WAD entry path verbatim (relative to WAD
                    // root) as our node path — the synthetic-tree
                    // identity. The "open" handler will recognise the
                    // missing drive letter and treat it as a WAD entry.
                    path: e.path,
                    name: rest,
                    isDir: false,
                    ext,
                    size: e.size,
                    mtime: 0,
                    children: null,
                    loadError: null,
                });
            }
        }
        const folders: ExplorerNode[] = Array.from(folderNames).map(name => ({
            path: prefix + name,
            name,
            isDir: true,
            ext: '',
            size: 0,
            mtime: 0,
            children: null,
            loadError: null,
        }));
        return [...folders, ...files];
    }, []);

    const loadChildren = useCallback(async (dirPath: string): Promise<ExplorerNode[]> => {
        if (isWadRoot) {
            // Lazy-fetch the entry list on first access.
            if (wadEntriesRef.current === null && root?.kind === 'wad') {
                const list = await invoke<WadEntry[]>('wad_list_entries', { id: root.mountId });
                wadEntriesRef.current = list;
            }
            // `dirPath` here is either the synthetic root key
            // (`wad://N`) or a WAD-relative folder path. Map the root
            // back to "" so the prefix filter works.
            const wadRel = dirPath.startsWith('wad://') ? '' : dirPath;
            return buildWadChildren(wadRel);
        }
        const entries = await invoke<DirEntry[]>('list_directory', { path: dirPath });
        return entries.map(entryToNode);
    }, [isWadRoot, root, buildWadChildren]);

    const refreshRoot = useCallback(async () => {
        if (!rootPath) return;
        try {
            // For WAD roots, force-reload the entry list so a refresh
            // re-fetches from Rust (in case the user re-mounted).
            if (isWadRoot) wadEntriesRef.current = null;
            const children = await loadChildren(rootPath);
            setRootNode({
                path: rootPath,
                name: isWadRoot && root?.kind === 'wad'
                    ? root.label
                    : (rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? rootPath),
                isDir: true,
                ext: '',
                size: 0,
                mtime: 0,
                children,
                loadError: null,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setRootNode({
                path: rootPath,
                name: rootPath,
                isDir: true,
                ext: '',
                size: 0,
                mtime: 0,
                children: [],
                loadError: msg,
            });
            setStatusMessage?.(`Open ${isWadRoot ? 'WAD' : 'folder'} failed: ${msg}`);
        }
    }, [rootPath, isWadRoot, root, loadChildren, setStatusMessage]);

    useEffect(() => {
        if (!rootPath) {
            setRootNode(null);
            return;
        }
        // Re-walk when the root changes — preserve expanded set across
        // root switches (paths are absolute so it stays meaningful).
        refreshRoot();
    }, [rootPath, refreshRoot]);

    // ── Expand / collapse ─────────────────────────────────────────
    const ensureChildren = useCallback(async (target: ExplorerNode) => {
        if (target.children !== null) return target;
        try {
            const children = await loadChildren(target.path);
            target.children = children;
        } catch (e) {
            target.children = [];
            target.loadError = e instanceof Error ? e.message : String(e);
        }
        return target;
    }, [loadChildren]);

    /** Mutate the loaded tree in place — fine because rendering is
     *  driven by `flatten()` running every render against the expanded
     *  set. We bump a render counter to force a re-flatten when the
     *  underlying mutation isn't reflected in React state. */
    const [, forceRender] = useState(0);
    const bumpRender = useCallback(() => forceRender(n => n + 1), []);

    const expandNode = useCallback(async (node: ExplorerNode) => {
        if (!node.isDir) return;
        if (!expanded.has(node.path)) {
            await ensureChildren(node);
            setExpanded(prev => {
                const next = new Set(prev);
                next.add(node.path);
                return next;
            });
        }
    }, [expanded, ensureChildren]);

    const collapseNode = useCallback((node: ExplorerNode) => {
        if (!node.isDir) return;
        setExpanded(prev => {
            if (!prev.has(node.path)) return prev;
            const next = new Set(prev);
            next.delete(node.path);
            return next;
        });
    }, []);

    const toggleNode = useCallback(async (node: ExplorerNode) => {
        if (!node.isDir) return;
        if (expanded.has(node.path)) collapseNode(node);
        else await expandNode(node);
    }, [expanded, expandNode, collapseNode]);

    // After the root finishes loading, walk every folder in the
    // hydrated `expanded` set and lazy-load its children. Without
    // this, a folder restored as expanded across sessions shows its
    // chevron open but renders no children (because `children`
    // stayed null on the fresh node) — the user had to click twice
    // to "re-open" it.
    useEffect(() => {
        if (!rootNode) return;
        let cancelled = false;
        (async () => {
            const queue: ExplorerNode[] = rootNode.children ? [...rootNode.children] : [];
            while (queue.length > 0) {
                if (cancelled) return;
                const n = queue.shift()!;
                if (!n.isDir) continue;
                if (!expanded.has(n.path)) continue;
                if (n.children === null) {
                    await ensureChildren(n);
                    bumpRender();
                }
                if (n.children) queue.push(...n.children);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rootNode]);

    // Refresh a single folder's children — invoked after create /
    // rename / delete so the new state reflects on screen.
    const refreshFolder = useCallback(async (folderPath: string) => {
        if (!rootNode) return;
        const target = folderPath === rootNode.path ? rootNode : findNode(rootNode, folderPath);
        if (!target || !target.isDir) return;
        try {
            target.children = await loadChildren(folderPath);
            target.loadError = null;
        } catch (e) {
            target.loadError = e instanceof Error ? e.message : String(e);
        }
        bumpRender();
    }, [rootNode, loadChildren, bumpRender]);

    // ── Grid mode loading ───────────────────────────────────────
    // When the grid folder changes (or root changes / view switches
    // into grid), re-read the directory listing. Sticks with the saved
    // grid folder across sessions when it's still inside the current
    // root; falls back to the root otherwise.
    useEffect(() => {
        if (viewMode !== 'grid') return;
        if (!rootPath) { setGridEntries([]); setGridLoadError(null); return; }
        // Normalize separators before comparing — list_directory on
        // Windows returns native `\` paths but parentDirOf flips to
        // `/`. The old direct startsWith was falling through to
        // rootPath every time, which was the "always jumps to root"
        // bug on Up navigation.
        const normPath = (p: string) => p.replace(/\\/g, '/');
        const rootNorm = normPath(rootPath);
        const inside = gridFolderPath && (
            normPath(gridFolderPath) === rootNorm ||
            normPath(gridFolderPath).startsWith(rootNorm + '/')
        );
        const target = inside ? gridFolderPath! : rootPath;
        if (target !== gridFolderPath) {
            setGridFolderPath(target);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const children = await loadChildren(target);
                if (!cancelled) {
                    setGridEntries(children);
                    setGridLoadError(null);
                }
            } catch (e) {
                if (!cancelled) {
                    setGridEntries([]);
                    setGridLoadError(e instanceof Error ? e.message : String(e));
                }
            }
        })();
        return () => { cancelled = true; };
    }, [viewMode, rootPath, gridFolderPath, loadChildren]);

    // Refresh helper that handles both modes.
    const refreshAll = useCallback(async () => {
        await refreshRoot();
        if (viewMode === 'grid' && gridFolderPath) {
            try {
                const children = await loadChildren(gridFolderPath);
                setGridEntries(children);
                setGridLoadError(null);
            } catch (e) {
                setGridLoadError(e instanceof Error ? e.message : String(e));
            }
        }
    }, [refreshRoot, viewMode, gridFolderPath, loadChildren]);

    // ── Flatten + virtualization ─────────────────────────────────
    // Set of node-paths the tree-mode filter should keep visible —
    // every matching entry plus every ancestor folder on the path to
    // it. Null = no filter active (all rows visible).
    const filteredVisiblePaths: Set<string> | null = useMemo(() => {
        if (!filterLower || !rootPath || !recursiveIndex) return null;
        // Match against both the full rel path and the final segment
        // so a query like "akali" picks up both "skins/akali/skin0"
        // and "akali_tx.tex" hits.
        const visible = new Set<string>();
        for (const e of recursiveIndex) {
            const rel = e.rel_path.toLowerCase();
            const last = rel.split('/').pop() ?? rel;
            if (!rel.includes(filterLower) && !last.includes(filterLower)) continue;
            // Convert rel_path → absolute node-path. WAD entries are
            // already absolute (no rootPath prefix).
            const nodePath = isWadRoot ? e.rel_path : `${rootPath}/${e.rel_path}`;
            visible.add(nodePath);
            // Add every ancestor folder.
            const parts = e.rel_path.split('/');
            let acc = '';
            for (let i = 0; i < parts.length - 1; i++) {
                acc = acc === '' ? parts[i] : `${acc}/${parts[i]}`;
                const folderPath = isWadRoot ? acc : `${rootPath}/${acc}`;
                visible.add(folderPath);
            }
        }
        return visible;
    }, [filterLower, rootPath, recursiveIndex, isWadRoot]);

    // When the filter is active, force every loaded folder open so
    // matches are visible without the user clicking chevrons. We
    // also lazy-load children for any ancestor we don't yet have.
    useEffect(() => {
        if (!filteredVisiblePaths || !rootNode) return;
        let cancelled = false;
        (async () => {
            // Walk loaded tree breadth-first; for any folder in the
            // visible set whose children aren't loaded yet, fetch them.
            const queue: ExplorerNode[] = rootNode.children ? [...rootNode.children] : [];
            while (queue.length > 0) {
                if (cancelled) return;
                const n = queue.shift()!;
                if (!n.isDir) continue;
                if (!filteredVisiblePaths.has(n.path)) continue;
                if (n.children === null) {
                    await ensureChildren(n);
                    bumpRender();
                }
                if (n.children) queue.push(...n.children);
            }
        })();
        return () => { cancelled = true; };
    }, [filteredVisiblePaths, rootNode, ensureChildren, bumpRender]);

    const rows: FlatRow[] = useMemo(() => {
        if (!rootNode) return [];
        const forceExpand = filteredVisiblePaths !== null;
        return flatten(rootNode, expanded, sortSpec, forceExpand, filteredVisiblePaths);
    }, [rootNode, expanded, sortSpec, filteredVisiblePaths]);

    // Track scroll position for windowing.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onScroll = () => setScrollTop(el.scrollTop);
        const onResize = () => setViewportH(el.clientHeight);
        onResize();
        el.addEventListener('scroll', onScroll, { passive: true });
        const ro = new ResizeObserver(onResize);
        ro.observe(el);
        return () => {
            el.removeEventListener('scroll', onScroll);
            ro.disconnect();
        };
    }, [rootNode]);

    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);

    // Scroll-into-view helper for keyboard nav.
    const scrollRowIntoView = useCallback((idx: number) => {
        const el = scrollRef.current;
        if (!el) return;
        const top = idx * ROW_HEIGHT;
        const bottom = top + ROW_HEIGHT;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }, []);

    // ── Selection helpers ─────────────────────────────────────────
    const selectedIdx = useMemo(() => {
        if (!selectedPath) return -1;
        return rows.findIndex(r => r.node.path === selectedPath);
    }, [rows, selectedPath]);

    const selectRow = useCallback((idx: number) => {
        if (idx < 0 || idx >= rows.length) return;
        setSelectedPath(rows[idx].node.path);
        scrollRowIntoView(idx);
    }, [rows, scrollRowIntoView]);

    // ── Activation (double-click / Enter) ─────────────────────────
    const activateNode = useCallback(async (node: ExplorerNode) => {
        if (node.isDir) {
            if (viewMode === 'grid') {
                // Grid mode: navigate INTO the folder. Selection
                // resets to nothing in the new directory.
                setGridFolderPath(node.path);
                setSelectedPath(null);
            } else {
                await toggleNode(node);
            }
            return;
        }
        // WAD files have no on-disk reality — opening them directly
        // would need a stream-from-WAD path the editor doesn't have
        // yet. Nudge the user toward the Extract action instead.
        if (isWadRoot) {
            setStatusMessage?.('Extract the WAD (or this entry) to edit files. Right-click → Extract.');
            return;
        }
        onOpenFile(node.path);
    }, [toggleNode, onOpenFile, viewMode, isWadRoot, setStatusMessage]);

    // Grid breadcrumb segments — split the current grid folder
    // against the root so we can render clickable crumbs that jump
    // back up the chain.
    const breadcrumb = useMemo(() => {
        if (!rootPath || !gridFolderPath) return [];
        const rootNorm = rootPath.replace(/\\/g, '/');
        const cur = gridFolderPath.replace(/\\/g, '/');
        if (!cur.startsWith(rootNorm)) return [];
        const rel = cur.slice(rootNorm.length).replace(/^\/+/, '');
        const parts = rel === '' ? [] : rel.split('/');
        const out: Array<{ label: string; path: string }> = [{ label: rootNorm.split('/').filter(Boolean).pop() ?? rootNorm, path: rootPath }];
        let acc = rootNorm;
        for (const p of parts) {
            acc = `${acc}/${p}`;
            out.push({ label: p, path: acc });
        }
        return out;
    }, [rootPath, gridFolderPath]);

    const navigateGridUp = useCallback(() => {
        if (!gridFolderPath || !rootPath) return;
        if (gridFolderPath === rootPath) return;
        setGridFolderPath(parentDirOf(gridFolderPath));
        setSelectedPath(null);
    }, [gridFolderPath, rootPath]);

    // ── File ops ─────────────────────────────────────────────────
    const startCreate = useCallback((kind: 'file' | 'folder') => {
        // Default parent = selected folder, or selected file's parent,
        // or the root.
        let parent = rootNode?.path ?? null;
        if (selectedPath && rootNode) {
            const node = findNode(rootNode, selectedPath);
            if (node) parent = node.isDir ? node.path : parentDirOf(node.path);
        }
        if (!parent) return;
        // Expand the target parent so the new entry is visible.
        if (rootNode && parent !== rootNode.path) {
            setExpanded(prev => {
                const next = new Set(prev);
                next.add(parent!);
                return next;
            });
        }
        setCreating({ parent, kind });
        setCreateValue(kind === 'folder' ? 'New Folder' : 'untitled.txt');
    }, [rootNode, selectedPath]);

    const commitCreate = useCallback(async () => {
        if (!creating) return;
        const name = createValue.trim();
        if (!name) { setCreating(null); return; }
        try {
            const cmd = creating.kind === 'folder' ? 'fs_create_directory' : 'fs_create_file';
            const newPath = await invoke<string>(cmd, { parentPath: creating.parent, name });
            await refreshFolder(creating.parent);
            setSelectedPath(newPath);
            setStatusMessage?.(`Created ${name}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatusMessage?.(`Create failed: ${msg}`);
        }
        setCreating(null);
    }, [creating, createValue, refreshFolder, setStatusMessage]);

    const startRename = useCallback((node: ExplorerNode) => {
        setRenaming(node.path);
        setRenameValue(node.name);
    }, []);

    const commitRename = useCallback(async () => {
        if (!renaming || !rootNode) return;
        const node = findNode(rootNode, renaming);
        const name = renameValue.trim();
        if (!node || !name || name === node.name) { setRenaming(null); return; }
        try {
            const newPath = await invoke<string>('fs_rename_entry', { path: node.path, newName: name });
            await refreshFolder(parentDirOf(node.path));
            setSelectedPath(newPath);
            setStatusMessage?.(`Renamed to ${name}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatusMessage?.(`Rename failed: ${msg}`);
        }
        setRenaming(null);
    }, [renaming, renameValue, rootNode, refreshFolder, setStatusMessage]);

    const performDelete = useCallback(async (node: ExplorerNode) => {
        try {
            await invoke('fs_delete_entry', { path: node.path });
            await refreshFolder(parentDirOf(node.path));
            if (selectedPath === node.path) setSelectedPath(null);
            setStatusMessage?.(`Deleted ${node.name}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatusMessage?.(`Delete failed: ${msg}`);
        }
    }, [refreshFolder, selectedPath, setStatusMessage]);

    // ── Keyboard navigation ──────────────────────────────────────
    const onKeyDown = useCallback(async (e: React.KeyboardEvent) => {
        if (renaming || creating) return;
        // Grid mode handles its own selection via mouse + Enter / Del
        // shortcuts below; full arrow-driven nav is tree-only for now.
        if (viewMode === 'grid') {
            if (e.key === 'Enter' && selectedPath) {
                const node = gridEntries.find(n => n.path === selectedPath);
                if (node) { e.preventDefault(); await activateNode(node); }
            } else if (e.key === 'F2' && selectedPath) {
                const node = gridEntries.find(n => n.path === selectedPath);
                if (node) { e.preventDefault(); startRename(node); }
            } else if (e.key === 'Delete' && selectedPath) {
                const node = gridEntries.find(n => n.path === selectedPath);
                if (node) { e.preventDefault(); setDeleteTarget(node); }
            } else if (e.key === 'Backspace') {
                e.preventDefault();
                navigateGridUp();
            }
            return;
        }
        if (rows.length === 0) return;
        let idx = selectedIdx;
        if (idx < 0) idx = 0;

        // Type-ahead: a printable char that isn't a modifier-driven
        // shortcut jumps to the next sibling whose name starts with the
        // buffered prefix.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const buf = typeAheadRef.current.buf + e.key.toLowerCase();
            typeAheadRef.current.buf = buf;
            if (typeAheadRef.current.timer) clearTimeout(typeAheadRef.current.timer);
            typeAheadRef.current.timer = setTimeout(() => { typeAheadRef.current.buf = ''; }, 500);
            for (let i = 1; i <= rows.length; i++) {
                const j = (idx + i) % rows.length;
                if (rows[j].node.name.toLowerCase().startsWith(buf)) {
                    selectRow(j);
                    break;
                }
            }
            e.preventDefault();
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectRow(Math.min(rows.length - 1, idx + 1));
                return;
            case 'ArrowUp':
                e.preventDefault();
                selectRow(Math.max(0, idx - 1));
                return;
            case 'ArrowRight': {
                e.preventDefault();
                const node = rows[idx]?.node;
                if (!node) return;
                if (node.isDir && !expanded.has(node.path)) {
                    await expandNode(node);
                } else if (node.isDir && expanded.has(node.path) && node.children && node.children.length > 0) {
                    selectRow(idx + 1);
                }
                return;
            }
            case 'ArrowLeft': {
                e.preventDefault();
                const row = rows[idx];
                if (!row) return;
                if (row.node.isDir && expanded.has(row.node.path)) {
                    collapseNode(row.node);
                } else {
                    const parentPath = parentDirOf(row.node.path);
                    const parentIdx = rows.findIndex(r => r.node.path === parentPath);
                    if (parentIdx >= 0) selectRow(parentIdx);
                }
                return;
            }
            case 'Enter':
                e.preventDefault();
                if (rows[idx]) await activateNode(rows[idx].node);
                return;
            case ' ':
                e.preventDefault();
                if (rows[idx]?.node.isDir) await toggleNode(rows[idx].node);
                return;
            case 'F2':
                e.preventDefault();
                if (rows[idx]) startRename(rows[idx].node);
                return;
            case 'Delete':
                e.preventDefault();
                if (rows[idx]) setDeleteTarget(rows[idx].node);
                return;
        }

        if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
            e.preventDefault();
            startCreate(e.shiftKey ? 'folder' : 'file');
            return;
        }
    }, [renaming, creating, rows, selectedIdx, selectRow, expanded, expandNode, collapseNode, activateNode, toggleNode, startRename, startCreate]);

    // Focus the rename / create input as soon as it mounts.
    const editInputRef = useRef<HTMLInputElement | null>(null);
    useLayoutEffect(() => {
        if (renaming || creating) {
            editInputRef.current?.focus();
            editInputRef.current?.select();
        }
    }, [renaming, creating]);

    // Close context menu on outside click.
    useEffect(() => {
        if (!contextMenu) return;
        const onDown = (ev: MouseEvent) => {
            const target = ev.target as HTMLElement;
            if (!target.closest('.fe-ctx-menu')) setContextMenu(null);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [contextMenu]);

    // ── Render ───────────────────────────────────────────────────
    if (!rootPath) {
        return (
            <div className="file-explorer-pane file-explorer-empty">
                <div className="fe-empty-content">
                    <FolderOpen size={32} strokeWidth={1.3} />
                    <div className="fe-empty-title">No folder opened</div>
                    <div className="fe-empty-actions">
                        <button className="fe-btn fe-btn-primary" onClick={onPickFolder}>
                            Open Folder…
                        </button>
                        {onPickWad && (
                            <button className="fe-btn" onClick={onPickWad}>
                                Open WAD…
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    const rootLabel = rootPath.replace(/\\/g, '/');

    return (
        <div
            className="file-explorer-pane"
            tabIndex={0}
            onKeyDown={onKeyDown}
        >
            <div className="fe-header">
                <div className="fe-root-label" title={rootLabel}>
                    {rootLabel.split('/').filter(Boolean).pop() ?? rootLabel}
                </div>
                <div className="fe-header-btns">
                    {!isWadRoot && (
                        <>
                            <button
                                className="fe-icon-btn"
                                title="New File"
                                onClick={() => startCreate('file')}
                            >
                                <FilePlus size={14} />
                            </button>
                            <button
                                className="fe-icon-btn"
                                title="New Folder"
                                onClick={() => startCreate('folder')}
                            >
                                <FolderPlus size={14} />
                            </button>
                        </>
                    )}
                    {isWadRoot && (
                        <button
                            className="fe-icon-btn"
                            title="Extract entire WAD to a folder…"
                            onClick={() => extractEntireWad()}
                            disabled={extractInFlight}
                        >
                            <DownloadIcon size={14} />
                        </button>
                    )}
                    <button
                        className="fe-icon-btn"
                        title="Refresh"
                        onClick={refreshAll}
                    >
                        <RefreshCw size={14} />
                    </button>
                    <button
                        className="fe-icon-btn"
                        title={viewMode === 'tree' ? 'Switch to grid view' : 'Switch to tree view'}
                        onClick={() => setViewMode(viewMode === 'tree' ? 'grid' : 'tree')}
                    >
                        {viewMode === 'tree' ? <LayoutGrid size={14} /> : <ListIcon size={14} />}
                    </button>
                    {!isWadRoot && (
                        <button
                            className="fe-icon-btn"
                            title="Reveal in OS"
                            onClick={() => invoke('open_folder_in_explorer', { path: viewMode === 'grid' ? (gridFolderPath ?? rootPath) : rootPath }).catch(() => {})}
                        >
                            <ExternalLink size={14} />
                        </button>
                    )}
                    <button
                        className="fe-icon-btn"
                        title="Change folder"
                        onClick={onPickFolder}
                    >
                        <FolderOpen size={14} />
                    </button>
                </div>
            </div>

            <div className="fe-filter-row">
                <SearchIcon size={12} className="fe-filter-icon" />
                <input
                    type="text"
                    className="fe-filter-input"
                    placeholder="Filter…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                        // Stop the filter input from triggering the
                        // pane-level keyboard nav handler.
                        e.stopPropagation();
                        if (e.key === 'Escape') setFilter('');
                    }}
                />
                {filter && (
                    <button
                        className="fe-icon-btn fe-filter-clear"
                        title="Clear filter"
                        onClick={() => setFilter('')}
                    >
                        <XIcon size={12} />
                    </button>
                )}
                <div className="fe-sort-wrap">
                    <button
                        className="fe-icon-btn fe-sort-btn"
                        title={`Sort: ${sortSpec.key} ${sortSpec.dir}`}
                        onClick={() => setSortMenuOpen(o => !o)}
                    >
                        <span className="fe-sort-label">{sortSpec.key} {sortSpec.dir === 'asc' ? '↑' : '↓'}</span>
                    </button>
                    {sortMenuOpen && (
                        <div className="fe-sort-menu" onMouseLeave={() => setSortMenuOpen(false)}>
                            {(['type', 'name', 'size', 'mtime'] as SortKey[]).map(k => (
                                <button
                                    key={k}
                                    className={sortSpec.key === k ? 'fe-sort-active' : ''}
                                    onClick={() => { setSortSpec({ ...sortSpec, key: k }); setSortMenuOpen(false); }}
                                >{k === 'type' ? 'Folders first' : k.charAt(0).toUpperCase() + k.slice(1)}</button>
                            ))}
                            <div className="fe-ctx-sep" />
                            <button
                                className={sortSpec.dir === 'asc' ? 'fe-sort-active' : ''}
                                onClick={() => { setSortSpec({ ...sortSpec, dir: 'asc' }); setSortMenuOpen(false); }}
                            >Ascending ↑</button>
                            <button
                                className={sortSpec.dir === 'desc' ? 'fe-sort-active' : ''}
                                onClick={() => { setSortSpec({ ...sortSpec, dir: 'desc' }); setSortMenuOpen(false); }}
                            >Descending ↓</button>
                        </div>
                    )}
                </div>
            </div>

            {viewMode === 'grid' && (
                <div className="fe-breadcrumb">
                    <button
                        className="fe-icon-btn fe-breadcrumb-up"
                        title="Up one folder"
                        onClick={navigateGridUp}
                        disabled={gridFolderPath === rootPath}
                    >
                        <ArrowUp size={13} />
                    </button>
                    {breadcrumb.map((b, i) => (
                        <span key={b.path} className="fe-crumb-wrap">
                            {i > 0 && <span className="fe-crumb-sep">/</span>}
                            <button
                                className={`fe-crumb${b.path === gridFolderPath ? ' fe-crumb-active' : ''}`}
                                onClick={() => { setGridFolderPath(b.path); setSelectedPath(null); }}
                                title={b.path}
                            >
                                {b.label}
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <div className="fe-body" ref={scrollRef}>
                {rootNode?.loadError && viewMode === 'tree' && (
                    <div className="fe-error">{rootNode.loadError}</div>
                )}
                {gridLoadError && viewMode === 'grid' && (
                    <div className="fe-error">{gridLoadError}</div>
                )}

                {viewMode === 'grid' && (
                    <ExplorerGrid
                        entries={gridEntries}
                        selectedPath={selectedPath}
                        setSelectedPath={setSelectedPath}
                        onActivate={activateNode}
                        onContextMenu={(node, x, y) => {
                            setSelectedPath(node.path);
                            setContextMenu({ x, y, node });
                        }}
                        onPointerDownDrag={onRowPointerDown}
                        thumbCache={thumbCacheRef.current}
                        thumbPending={thumbPendingRef.current}
                        thumbVersion={thumbVersion}
                        onThumbVersionBump={() => setThumbVersion(v => v + 1)}
                        setStatusMessage={setStatusMessage}
                        filter={filterLower}
                        sortSpec={sortSpec}
                    />
                )}

                {viewMode === 'tree' && (
                /* Virtual list — total height = rows × ROW_HEIGHT, plus
                    a translateY-positioned slice of visible rows. */
                <div className="fe-rows" style={{ height: rows.length * ROW_HEIGHT }}>
                    {rows.slice(firstVisible, lastVisible).map((r, i) => {
                        const idx = firstVisible + i;
                        const node = r.node;
                        const isSelected = node.path === selectedPath;
                        const isExpanded = node.isDir && expanded.has(node.path);
                        const isRenaming = renaming === node.path;
                        return (
                            <div
                                key={node.path}
                                className={`fe-row${isSelected ? ' fe-row-selected' : ''}`}
                                style={{
                                    transform: `translateY(${idx * ROW_HEIGHT}px)`,
                                    paddingLeft: 6 + r.depth * INDENT_PX,
                                }}
                                onPointerDown={(e) => {
                                    setSelectedPath(node.path);
                                    onRowPointerDown(e, node);
                                }}
                                onDoubleClick={() => activateNode(node)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setSelectedPath(node.path);
                                    setContextMenu({ x: e.clientX, y: e.clientY, node });
                                }}
                            >
                                <span
                                    className="fe-chevron"
                                    onClick={(e) => { e.stopPropagation(); if (node.isDir) toggleNode(node); }}
                                >
                                    {node.isDir ? (
                                        isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
                                    ) : null}
                                </span>
                                <span className="fe-icon">
                                    {node.isDir ? (
                                        <FormatIcon isFolder size={14} />
                                    ) : (
                                        <FileTypeIcon extension={node.ext} fileName={node.name} size={14} />
                                    )}
                                </span>
                                {isRenaming ? (
                                    <input
                                        ref={editInputRef}
                                        className="fe-edit-input"
                                        value={renameValue}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        onKeyDown={(e) => {
                                            e.stopPropagation();
                                            if (e.key === 'Enter') commitRename();
                                            else if (e.key === 'Escape') setRenaming(null);
                                        }}
                                        onBlur={() => commitRename()}
                                    />
                                ) : (
                                    <span className="fe-name">{node.name}</span>
                                )}
                            </div>
                        );
                    })}

                    {/* Inline "create" row — rendered at the very end of
                        the parent folder's children (after virtualized
                        rows so it's always findable in the DOM). */}
                    {creating && (
                        <div
                            className="fe-row fe-row-creating"
                            style={{
                                transform: `translateY(${rows.length * ROW_HEIGHT}px)`,
                                paddingLeft: 6 + (
                                    creating.parent === rootNode?.path
                                        ? 0
                                        : (rows.find(r => r.node.path === creating.parent)?.depth ?? -1) + 1
                                ) * INDENT_PX,
                            }}
                        >
                            <span className="fe-chevron" />
                            <span className="fe-icon">
                                {creating.kind === 'folder' ? (
                                    <FormatIcon isFolder size={14} />
                                ) : (
                                    <FileTypeIcon size={14} />
                                )}
                            </span>
                            <input
                                ref={editInputRef}
                                className="fe-edit-input"
                                value={createValue}
                                onChange={(e) => setCreateValue(e.target.value)}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') commitCreate();
                                    else if (e.key === 'Escape') setCreating(null);
                                }}
                                onBlur={() => commitCreate()}
                            />
                        </div>
                    )}
                </div>
                )}
            </div>

            {contextMenu && (
                <div
                    ref={ctxMenuRef}
                    className="fe-ctx-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    <button onClick={() => { activateNode(contextMenu.node); setContextMenu(null); }}>
                        {contextMenu.node.isDir ? 'Open / Toggle' : 'Open'}
                    </button>
                    {!isWadRoot && (
                        <button onClick={() => {
                            invoke('open_folder_in_explorer', { path: contextMenu.node.isDir ? contextMenu.node.path : parentDirOf(contextMenu.node.path) }).catch(() => {});
                            setContextMenu(null);
                        }}>Reveal in OS</button>
                    )}
                    <button onClick={() => {
                        navigator.clipboard.writeText(contextMenu.node.path).catch(() => {});
                        setStatusMessage?.('Path copied');
                        setContextMenu(null);
                    }}>Copy path</button>
                    {isWadRoot ? (
                        <>
                            <div className="fe-ctx-sep" />
                            {!contextMenu.node.isDir && (
                                <button onClick={() => { extractWadEntry(contextMenu.node); setContextMenu(null); }}>
                                    Extract this file…
                                </button>
                            )}
                            <button onClick={() => { extractEntireWad(); setContextMenu(null); }}>
                                Extract entire WAD…
                            </button>
                        </>
                    ) : (
                        <>
                            {/* Animation Studio entry — only on `.skn`
                                files on disk. Above the file-ops block
                                so it sits next to "Open" semantically. */}
                            {!contextMenu.node.isDir
                                && /\.skn$/i.test(contextMenu.node.path)
                                && onOpenInAnimStudio && (
                                <>
                                    <div className="fe-ctx-sep" />
                                    <button onClick={() => {
                                        onOpenInAnimStudio(contextMenu.node.path, 'source');
                                        setContextMenu(null);
                                    }}>Open in Animation Studio as source</button>
                                    <button onClick={() => {
                                        onOpenInAnimStudio(contextMenu.node.path, 'target');
                                        setContextMenu(null);
                                    }}>Open in Animation Studio as target</button>
                                </>
                            )}
                            {!contextMenu.node.isDir
                                && /\.anm$/i.test(contextMenu.node.path)
                                && onLoadAnmInAnimStudio && (
                                <>
                                    <div className="fe-ctx-sep" />
                                    <button onClick={() => {
                                        onLoadAnmInAnimStudio(contextMenu.node.path);
                                        setContextMenu(null);
                                    }}>Load as source clip in Animation Studio</button>
                                </>
                            )}
                            <div className="fe-ctx-sep" />
                            <button onClick={() => { startCreate('file'); setContextMenu(null); }}>New File</button>
                            <button onClick={() => { startCreate('folder'); setContextMenu(null); }}>New Folder</button>
                            <div className="fe-ctx-sep" />
                            <button onClick={() => { startRename(contextMenu.node); setContextMenu(null); }}>Rename (F2)</button>
                            <button
                                className="fe-ctx-danger"
                                onClick={() => { setDeleteTarget(contextMenu.node); setContextMenu(null); }}
                            >Delete</button>
                        </>
                    )}
                </div>
            )}

            {deleteTarget && (
                <ConfirmDelete
                    target={deleteTarget}
                    onCancel={() => setDeleteTarget(null)}
                    onConfirm={async () => {
                        const t = deleteTarget;
                        setDeleteTarget(null);
                        await performDelete(t);
                    }}
                />
            )}
        </div>
    );
}

// Convenience helper for picking a folder from a UI event. Exported so
// other entry points (welcome tile, menu bar) can share the flow.
export async function pickFolderFromDialog(): Promise<string | null> {
    try {
        const picked = await openDialog({ directory: true, multiple: false });
        if (typeof picked !== 'string') return null;
        return picked;
    } catch {
        return null;
    }
}

