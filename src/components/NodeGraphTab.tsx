import { useCallback, useContext, useEffect, useMemo, useRef, useState, createContext } from 'react';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import {
    ReactFlow,
    ReactFlowProvider,
    Background,
    BackgroundVariant,
    Controls,
    MiniMap,
    Handle,
    Position,
    useNodesState,
    useEdgesState,
    useUpdateNodeInternals,
    useReactFlow,
    type Node,
    type Edge,
    type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './NodeGraphTab.css';
import { invoke } from '@tauri-apps/api/core';
import { Image as ImageIcon, Palette, Box, AlertTriangle, Plus } from 'lucide-react';
import { useShell } from '../shells/ShellContext';
import MaterialOverrideDialog from './MaterialOverrideDialog';
import type { LibraryPairResult } from '../shells/MaterialOverrideDockPanel';
import { uniqueMaterialName, renameMaterialInSnippet } from '../lib/materialInsert';
import {
    parseBinGraph, setSkinScale, basename, injectMaterialDef,
    clearOverrideForSubmesh, setOverrideTexture, setOverrideMaterial, setBaseTexture, setSamplerTexture, replaceTexturePath,
    type BinGraph, type BinGraphEdge, type MeshRow, type MaterialSampler,
} from '../lib/binGraph';
import type { Connection } from '@xyflow/react';

// Cached library material as returned by `library_get_cached_material`.
interface MaterialSnippet {
    id: string;
    name: string;
    materialName: string;
    snippet: string;
}
interface MaterialSuggestion { material: string; texture: string }
interface AutoMaterialResult { matches: MaterialSuggestion[]; skn_path: string; unmatched: string[]; textures: string[] }

// First `key: ... = "value"` line in the bin text (case-insensitive key).
function extractField(text: string, key: string): string {
    for (const raw of text.split('\n')) {
        const t = raw.trim();
        if (t.toLowerCase().startsWith(key.toLowerCase() + ':')) {
            const eq = t.indexOf('='); if (eq !== -1) return t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        }
    }
    return '';
}

// Disk path → game asset path (mirrors backend extract_asset_relative).
function toAssetPath(abs: string): string {
    const n = abs.replace(/\\/g, '/');
    const i = n.toLowerCase().indexOf('assets/');
    return i !== -1 ? n.slice(i) : n;
}

// Build an uncompressed 32-bpp B8G8R8A8 DDS of a single colour. League/most
// tools load uncompressed DDS, and it's trivial to author without an encoder.
function makeSolidDDS(hex: string, size: number): Uint8Array {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    const headerLen = 128;
    const data = new Uint8Array(headerLen + size * size * 4);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, 0x20534444, true);          // "DDS "
    dv.setUint32(4, 124, true);                  // dwSize
    dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x8, true); // CAPS|HEIGHT|WIDTH|PIXELFORMAT|PITCH
    dv.setUint32(12, size, true);                // height
    dv.setUint32(16, size, true);                // width
    dv.setUint32(20, size * 4, true);            // pitch
    dv.setUint32(76, 32, true);                  // ddspf.dwSize
    dv.setUint32(80, 0x40 | 0x1, true);          // DDPF_RGB | DDPF_ALPHAPIXELS
    dv.setUint32(88, 32, true);                  // RGB bit count
    dv.setUint32(92, 0x00ff0000, true);          // R mask
    dv.setUint32(96, 0x0000ff00, true);          // G mask
    dv.setUint32(100, 0x000000ff, true);         // B mask
    dv.setUint32(104, 0xff000000, true);         // A mask
    dv.setUint32(108, 0x1000, true);             // DDSCAPS_TEXTURE
    for (let i = 0; i < size * size; i++) {
        const o = headerLen + i * 4;
        data[o] = b; data[o + 1] = g; data[o + 2] = r; data[o + 3] = 255;
    }
    return data;
}

// Tools the Image Texture nodes use (browse / new-solid / pick-from-skin),
// shared via context so floating and derived nodes alike get them.
interface TexTools {
    skinTextures: string[];
    onBrowse: () => Promise<string | null>;
    onNewSolid: (hex: string) => Promise<string | null>;
}
const TexToolsContext = createContext<TexTools | null>(null);

// ── fixed geometry so socket handles line up with their rows ──────────────
const MESH_HEADER_H = 50;   // title + skn subtitle
const MESH_SCALE_H = 46;    // skin-scale slider row
const MESH_META_H = 18;     // each meta row (skl)
const MESH_ROW_H = 26;      // each submesh socket row
const TEX_HEADER_H = 26;
const TEX_COLOR_H = 24;     // "Color" output row
const MAT_HEADER_H = 26;
const MAT_ROW_H = 24;       // each sampler socket row

const COL_X = { texture: 0, material: 360, mesh: 760 } as const;
const STACK_Y = 175;        // vertical gap between stacked input nodes (tall texture nodes)

// ── texture node (Blender "Image Texture") ────────────────────────────────
interface TextureData extends Record<string, unknown> {
    title: string;
    path?: string;
    onPathCommit: (oldPath: string, newPath: string) => void;
}
function TextureNode({ data }: NodeProps<Node<TextureData>>) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(data.path ?? '');
    const [color, setColor] = useState('#808080');
    const [picking, setPicking] = useState(false);
    const [pickPos, setPickPos] = useState<{ x: number; y: number } | null>(null);
    const pickBtnRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const tools = useContext(TexToolsContext);
    useEffect(() => { if (!editing) setText(data.path ?? ''); }, [data.path, editing]);

    // The pick menu is portalled to <body> because the node clips overflow and
    // React Flow's node transform breaks position:fixed inside it.
    const togglePick = () => {
        if (picking) { setPicking(false); return; }
        const r = pickBtnRef.current?.getBoundingClientRect();
        if (r) setPickPos({ x: r.right, y: r.bottom + 4 });
        setPicking(true);
    };
    useEffect(() => {
        if (!picking) return;
        const onDown = (e: PointerEvent) => {
            const t = e.target as HTMLElement;
            if (menuRef.current?.contains(t) || pickBtnRef.current?.contains(t)) return;
            setPicking(false);
        };
        window.addEventListener('pointerdown', onDown, true);
        return () => window.removeEventListener('pointerdown', onDown, true);
    }, [picking]);

    const commit = () => {
        setEditing(false);
        const np = text.trim();
        if (np && np !== data.path) data.onPathCommit(data.path ?? '', np);
    };
    const setPath = (p: string | null) => { if (p && p !== data.path) data.onPathCommit(data.path ?? '', p); };

    return (
        <div className="jade-rf-node kind-texture">
            <div className="jade-rf-node-head">
                <span className="jade-rf-node-icon"><ImageIcon size={13} /></span>
                <span className="jade-rf-node-title">Image Texture</span>
            </div>
            <div className="jade-rf-color-row">
                <span className="jade-rf-color-dot" />
                <span>Color</span>
                <Handle
                    type="source" id="out" position={Position.Right}
                    className="jade-rf-handle handle-tex"
                    style={{ top: TEX_HEADER_H + TEX_COLOR_H / 2 }}
                />
            </div>
            {editing ? (
                <input
                    className="jade-rf-tex-input nodrag nopan"
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                        else if (e.key === 'Escape') { setEditing(false); setText(data.path ?? ''); }
                    }}
                />
            ) : (
                <div
                    className="jade-rf-tex-name nodrag nopan"
                    title={`${data.path}\n(click to repoint this texture)`}
                    onClick={() => setEditing(true)}
                >
                    {data.title || '(no texture — set one below)'}
                </div>
            )}

            {/* Blender-style image-box controls: new solid colour, browse,
                or pick a texture already in the skin folder. */}
            <div className="jade-rf-tex-tools nodrag nopan">
                <input
                    type="color" className="jade-rf-tex-color" value={color}
                    title="Colour for a new solid texture"
                    onChange={(e) => setColor(e.target.value)}
                />
                <button title="Create a new solid-colour texture" onClick={async () => setPath(await tools?.onNewSolid(color) ?? null)}>New</button>
                <button title="Browse for a texture file on disk" onClick={async () => setPath(await tools?.onBrowse() ?? null)}>Open</button>
                <div className="jade-rf-tex-pickwrap">
                    <button ref={pickBtnRef} title="Pick a texture from the skin folder" onClick={togglePick} disabled={!tools?.skinTextures.length}>Pick ▾</button>
                    {picking && pickPos && tools && tools.skinTextures.length > 0 && createPortal(
                        <div
                            ref={menuRef}
                            className="jade-rf-tex-picklist"
                            style={{ position: 'fixed', left: pickPos.x, top: pickPos.y, transform: 'translateX(-100%)' }}
                        >
                            {tools.skinTextures.map(t => (
                                <button key={t} title={t} onClick={() => { setPath(t); setPicking(false); }}>{basename(t)}</button>
                            ))}
                        </div>,
                        document.body,
                    )}
                </div>
            </div>
        </div>
    );
}

// ── material node (sampler receiver, mirrors the mesh node) ────────────────
interface MaterialData extends Record<string, unknown> {
    title: string;
    subtitle?: string;
    externalUnresolved?: boolean;
    samplers: MaterialSampler[];
}
function MaterialNode({ id, data }: NodeProps<Node<MaterialData>>) {
    const updateNodeInternals = useUpdateNodeInternals();
    useEffect(() => {
        updateNodeInternals(id);
    }, [id, data.samplers.length, updateNodeInternals]);

    const rowTop = (i: number) => MAT_HEADER_H + i * MAT_ROW_H + MAT_ROW_H / 2;
    const bodyH = Math.max(1, data.samplers.length) * MAT_ROW_H;

    return (
        <div className={`jade-rf-node kind-material${data.externalUnresolved ? ' is-external' : ''}`}>
            <div className="jade-rf-node-head">
                <span className="jade-rf-node-icon"><Palette size={13} /></span>
                <span className="jade-rf-node-title" title={data.title}>{data.title}</span>
                {data.externalUnresolved && (
                    <span className="jade-rf-node-warn" title="Links into another bin"><AlertTriangle size={12} /></span>
                )}
            </div>

            {data.externalUnresolved && <div className="jade-rf-mat-body">external material</div>}

            {/* One socket row per sampler — texture wires land on the slot. */}
            {data.samplers.map((sm) => (
                <div key={sm.key} className="jade-rf-srow via-texture">
                    <span className="jade-rf-srow-label" title={sm.texturePath}>{sm.label}</span>
                </div>
            ))}

            {/* Node-level handles so the `top` is measured against the node. */}
            {data.samplers.map((sm, i) => (
                <Handle
                    key={`h-${sm.key}`}
                    type="target"
                    id={sm.key}
                    position={Position.Left}
                    className="jade-rf-handle handle-tex"
                    style={{ top: rowTop(i) }}
                />
            ))}

            {/* Output → mesh, centred on the sampler body. */}
            <Handle
                type="source" id="out" position={Position.Right}
                className="jade-rf-handle handle-mat"
                style={{ top: MAT_HEADER_H + bodyH / 2 }}
            />
        </div>
    );
}

// Blender-style numeric field: drag horizontally to scrub, click to type.
// Used for Skin Scale. Value is a percentage of the captured baseline.
const SCRUB_MIN = 1;
const SCRUB_MAX = 1000;
function ScrubField({ pct, onCommit }: { pct: number; onCommit: (v: number) => void }) {
    const [local, setLocal] = useState(pct);
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(String(pct));
    const drag = useRef<{ startX: number; startVal: number; moved: boolean } | null>(null);

    useEffect(() => { if (!editing && !drag.current) setLocal(pct); }, [pct, editing]);

    const clamp = (v: number) => Math.max(SCRUB_MIN, Math.min(SCRUB_MAX, Math.round(v)));

    const commitText = () => {
        const parsed = parseFloat(text.replace('%', '').trim());
        const v = isNaN(parsed) ? local : clamp(parsed);
        setLocal(v);
        setEditing(false);
        onCommit(v);
    };

    if (editing) {
        return (
            <div className="jade-rf-scale nodrag nopan">
                <span className="jade-rf-scale-label">Skin Scale</span>
                <input
                    className="jade-rf-scale-input"
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onBlur={commitText}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commitText();
                        else if (e.key === 'Escape') { setEditing(false); setLocal(pct); }
                    }}
                />
            </div>
        );
    }

    // Visual fill mirrors Blender's slider feel (10–300% of the field width).
    const fill = Math.max(0, Math.min(100, ((local - 10) / (300 - 10)) * 100));
    return (
        <div
            className="jade-rf-scale jade-rf-scale-scrub nodrag nopan"
            style={{ ['--fill' as string]: `${fill}%` }}
            onPointerDown={(e) => {
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                drag.current = { startX: e.clientX, startVal: local, moved: false };
            }}
            onPointerMove={(e) => {
                const d = drag.current;
                if (!d) return;
                const dx = e.clientX - d.startX;
                if (Math.abs(dx) > 2) d.moved = true;
                if (d.moved) setLocal(clamp(d.startVal + dx));
            }}
            onPointerUp={(e) => {
                const d = drag.current;
                drag.current = null;
                (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                if (!d) return;
                if (d.moved) onCommit(local);
                else { setText(String(local)); setEditing(true); }   // click → type
            }}
            title="Drag to scrub · click to type"
        >
            <span className="jade-rf-scale-label">Skin Scale</span>
            <span className="jade-rf-scale-val">{local}%</span>
        </div>
    );
}

// ── mesh node (the big "output" node, Principled-BSDF style) ───────────────
interface MeshData extends Record<string, unknown> {
    title: string;
    subtitle?: string;
    meta?: { label: string; value: string }[];
    rows: MeshRow[];
    skinScale: number;
    originalScale: number;
    onScaleCommit: (pct: number) => void;
}
function MeshNode({ id, data }: NodeProps<Node<MeshData>>) {
    const original = data.originalScale || 1;
    const dataPct = Math.round((data.skinScale / original) * 100);
    const updateNodeInternals = useUpdateNodeInternals();
    const metaH = (data.meta?.length ?? 0) * MESH_META_H;

    // Handle tops are positioned dynamically, so React Flow must re-measure
    // them whenever the row/meta layout changes — otherwise edges route to
    // stale socket positions.
    useEffect(() => {
        updateNodeInternals(id);
    }, [id, data.rows.length, data.meta?.length, updateNodeInternals]);

    const rowTop = (i: number) => MESH_HEADER_H + MESH_SCALE_H + metaH + i * MESH_ROW_H + MESH_ROW_H / 2;

    return (
        <div className="jade-rf-node kind-mesh jade-rf-mesh">
            <div className="jade-rf-node-head jade-rf-mesh-head">
                <span className="jade-rf-node-icon"><Box size={14} /></span>
                <div className="jade-rf-mesh-titles">
                    <span className="jade-rf-node-title" title={data.title}>{data.title}</span>
                    {data.subtitle && <span className="jade-rf-mesh-sub" title={data.subtitle}>{data.subtitle}</span>}
                </div>
            </div>

            <ScrubField pct={dataPct} onCommit={data.onScaleCommit} />

            {data.meta?.map((m, i) => (
                <div key={i} className="jade-rf-mesh-meta">
                    <span className="jade-rf-meta-key">{m.label}</span>
                    <span className="jade-rf-meta-val" title={m.value}>{m.value}</span>
                </div>
            ))}

            {/* Visual submesh rows (label + tag only). */}
            {data.rows.map((r) => (
                <div key={r.key} className={`jade-rf-srow via-${r.via}`}>
                    <span className="jade-rf-srow-label">{r.label}</span>
                    {r.via !== 'none' && <span className={`jade-rf-srow-tag tag-${r.via}`}>{r.via}</span>}
                </div>
            ))}

            {/* Socket handles live at the NODE level (not inside the rows) so
                their `top` is measured against the node, not a positioned row.
                This is what makes the wires actually land on each submesh. */}
            {data.rows.map((r, i) => (
                <Handle
                    key={`h-${r.key}`}
                    type="target"
                    id={r.key}
                    position={Position.Left}
                    className="jade-rf-handle handle-row"
                    style={{ top: rowTop(i) }}
                />
            ))}
        </div>
    );
}

const NODE_TYPES = { texture: TextureNode, material: MaterialNode, mesh: MeshNode };

const EDGE_COLOR: Record<string, string> = {
    'texture-mesh': '#e0902e',
    'material-mesh': '#a974d6',
    'texture-material': '#e0902e',
};

interface NodeHandlers {
    originalScale: number;
    onScaleCommit: (pct: number) => void;
    onTexPathCommit: (oldPath: string, newPath: string) => void;
    /** Texture node identity is decoupled from the path: this maps a path to a
     *  STABLE node id that survives re-pathing, so swapping a texture keeps the
     *  same node (no remount). */
    texId: (path: string) => string;
}

function buildNodes(
    graph: BinGraph,
    prevPos: Map<string, { x: number; y: number }>,
    h: NodeHandlers,
): { nodes: Node[]; idMap: Map<string, string> } {
    const counts: Record<string, number> = {};
    const idMap = new Map<string, string>();   // bin id (tex:<path>) → render id
    const nodes = graph.nodes.map((n) => {
        const col = COL_X[n.kind];
        const idx = counts[n.kind] = (counts[n.kind] ?? 0) + 1;
        const id = n.kind === 'texture' ? h.texId(n.path ?? n.id) : n.id;
        idMap.set(n.id, id);
        const saved = prevPos.get(id);
        const position = saved ?? { x: col, y: (idx - 1) * STACK_Y };
        if (n.kind === 'mesh') {
            return {
                id, type: 'mesh', position,
                data: {
                    title: n.title, subtitle: n.subtitle, meta: n.meta, rows: n.rows ?? [],
                    skinScale: n.skinScale ?? 1, originalScale: h.originalScale, onScaleCommit: h.onScaleCommit,
                } satisfies MeshData,
            };
        }
        if (n.kind === 'material') {
            return { id, type: 'material', position, data: { title: n.title, subtitle: n.subtitle, externalUnresolved: n.externalUnresolved, samplers: n.samplers ?? [] } satisfies MaterialData };
        }
        return { id, type: 'texture', position, data: { title: n.title, path: n.path, onPathCommit: h.onTexPathCommit } satisfies TextureData };
    });
    return { nodes, idMap };
}

function buildEdges(graph: BinGraph, idMap: Map<string, string>): Edge[] {
    return graph.edges.map((e) => {
        const color = EDGE_COLOR[e.kind] ?? '#6b7280';
        return {
            id: e.id,
            source: idMap.get(e.source) ?? e.source,
            target: idMap.get(e.target) ?? e.target,
            sourceHandle: 'out',
            targetHandle: e.targetHandle,   // sampler key or submesh row key
            label: e.label,
            type: 'default',
            style: { stroke: color, strokeWidth: 1.6 },
            labelStyle: { fill: 'var(--text-color, #ccc)', fontSize: 9 },
            labelBgStyle: { fill: 'var(--window-bg, #1e1e1e)', fillOpacity: 0.85 },
        };
    });
}

// Do segments (a→b) and (c→d) cross? Standard orientation test, used by the
// knife tool to decide which wires a slash passes through.
function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
    const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
        Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    const o1 = o(ax, ay, bx, by, cx, cy);
    const o2 = o(ax, ay, bx, by, dx, dy);
    const o3 = o(cx, cy, dx, dy, ax, ay);
    const o4 = o(cx, cy, dx, dy, bx, by);
    return o1 !== o2 && o3 !== o4;
}

// Map a cut wire to the text transform that UNLINKS it (empties the value,
// never deletes the entry). Returns null for wires that can't be unlinked.
function unlinkTransformForEdge(edge: BinGraphEdge, g: BinGraph): ((t: string) => string) | null {
    if (edge.target === g.meshId) {
        if (edge.targetHandle === 'base') return (t) => setBaseTexture(t, '');
        const row = g.nodes.find(n => n.kind === 'mesh')?.rows?.find(r => r.key === edge.targetHandle);
        if (row?.submesh) { const sm = row.submesh; return (t) => clearOverrideForSubmesh(t, sm); }
        return null;
    }
    const mat = g.nodes.find(n => n.id === edge.target && n.kind === 'material');
    if (mat?.subtitle && edge.targetHandle) {
        const link = mat.subtitle, key = edge.targetHandle;
        return (t) => setSamplerTexture(t, link, key, '');
    }
    return null;
}

function NodeGraphInner({ tabId }: { tabId: string }) {
    const s = useShell();
    const tab = s.tabs.find(t => t.id === tabId);
    const sourceTabId = tab?.sourceTabId;

    const [graph, setGraph] = useState<BinGraph | null>(null);
    const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
    // The SkinScale baseline ("100%") is captured the first time the mesh
    // appears for this source, so the percentage slider stays meaningful
    // across re-derives instead of re-baselining to each new value.
    const originalScaleRef = useRef<number | null>(null);

    const readText = useCallback((): string => {
        if (!sourceTabId) return '';
        const model = s.monacoModelsRef.current.get(sourceTabId);
        if (model && !model.isDisposed()) return model.getValue();
        return s.tabs.find(t => t.id === sourceTabId)?.content ?? '';
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceTabId]);

    useEffect(() => {
        if (!sourceTabId) { setGraph(null); return; }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const derive = (text: string) => {
            const g = parseBinGraph(text);
            const mesh = g.nodes.find(n => n.kind === 'mesh');
            if (mesh && originalScaleRef.current === null && typeof mesh.skinScale === 'number') {
                originalScaleRef.current = mesh.skinScale || 1;
            }
            setGraph(g);
        };
        const model = s.monacoModelsRef.current.get(sourceTabId);
        if (model && !model.isDisposed()) {
            derive(model.getValue());
            const sub = model.onDidChangeContent(() => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => derive(model.getValue()), 220);
            });
            return () => { if (timer) clearTimeout(timer); sub.dispose(); };
        }
        derive(s.tabs.find(t => t.id === sourceTabId)?.content ?? '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceTabId]);

    const graphRef = useRef<BinGraph | null>(null);
    graphRef.current = graph;
    const rootRef = useRef<HTMLDivElement>(null);
    const rf = useReactFlow();
    // Monotonic counter for new texture node ids. Identity is otherwise
    // determined by matching a referenced path to an existing visual node
    // (see the reconcile effect) — no fragile path→id map to keep in sync.
    const texSeqRef = useRef(0);
    // Knife line (client coords) while a right-drag cut is in progress.
    const [knife, setKnife] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
    // "Add node" UI: texture-path popover + material-override inserter dialog.
    const [addTexOpen, setAddTexOpen] = useState(false);
    const [addTexPath, setAddTexPath] = useState('');
    const [showMaterialDialog, setShowMaterialDialog] = useState(false);
    const [matSuggestions, setMatSuggestions] = useState<MaterialSuggestion[]>([]);
    const [matTextures, setMatTextures] = useState<string[]>([]);
    const [skinTextures, setSkinTextures] = useState<string[]>([]);
    const srcFilePath = s.tabs.find(t => t.id === sourceTabId)?.filePath ?? undefined;

    const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
    const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const rfNodesRef = useRef<Node[]>(rfNodes);
    rfNodesRef.current = rfNodes;

    // Commit a new skin scale (pct of the captured baseline) to the source bin.
    const onScaleCommit = useCallback((pct: number) => {
        if (!sourceTabId) return;
        const base = originalScaleRef.current ?? 1;
        const newValue = base * (pct / 100);
        const next = setSkinScale(readText(), newValue);
        s.applyEditToTab(sourceTabId, next);
    }, [sourceTabId, readText, s]);

    // Repoint a texture node IN PLACE (New / Open / Pick / inline edit). The
    // node id is stable (not path-based), so we MOVE the path→id mapping and
    // just update the node's data — same node, same position, same wires, no
    // remount. Rewrites the text too if the old path was wired.
    const onTexPathCommit = useCallback((oldPath: string, newPath: string) => {
        if (!sourceTabId || !newPath || oldPath === newPath) return;
        const newK = newPath.toLowerCase();
        const text = readText();
        if (oldPath && text.includes(`"${oldPath}"`)) {
            s.applyEditToTab(sourceTabId, replaceTexturePath(text, oldPath, newPath));
        }
        // Update the edited node's path in place (identity is by path-match on
        // re-derive, so this same node keeps the wire) and drop any OTHER node
        // already on the new path so we never end up with two.
        setRfNodes(prev => {
            const node = prev.find(n => n.type === 'texture' && (n.data as TextureData).path === oldPath);
            if (!node) return prev;
            return prev
                .filter(n => !(n.type === 'texture' && n.id !== node.id && ((n.data as TextureData).path ?? '').toLowerCase() === newK))
                .map(n => (n.id === node.id ? { ...n, data: { ...n.data, path: newPath, title: basename(newPath) } } : n));
        });
    }, [sourceTabId, readText, s, setRfNodes]);

    // Load the skin folder's textures (asset-relative) for the "Pick" button.
    useEffect(() => {
        if (!srcFilePath) { setSkinTextures([]); return; }
        let cancelled = false;
        (async () => {
            const text = readText();
            const simpleSkin = extractField(text, 'simpleSkin');
            const texturePath = extractField(text, 'texture');
            if (!simpleSkin || !texturePath) return;
            try {
                const mode = parseInt(await invoke<string>('get_preference', { key: 'MaterialMatchMode', defaultValue: '3' }), 10) || 3;
                const result = await invoke<AutoMaterialResult>('auto_material_override', { binFilePath: srcFilePath, simpleSkinPath: simpleSkin, texturePath, matchMode: mode });
                if (!cancelled) setSkinTextures(result.textures ?? []);
            } catch { /* picker just stays empty */ }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [srcFilePath, sourceTabId]);

    // Disk path of the skin's texture folder (resolved from the base texture).
    const skinDirDisk = useCallback(async (): Promise<string | undefined> => {
        if (!srcFilePath) return undefined;
        const text = readText();
        const baseTex = extractField(text, 'texture') || extractField(text, 'simpleSkin');
        if (!baseTex) return undefined;
        const disk = await invoke<string | null>('resolve_asset_path', { baseFile: srcFilePath, assetPath: baseTex });
        return disk ? disk.replace(/\\/g, '/').split('/').slice(0, -1).join('/') : undefined;
    }, [srcFilePath, readText]);

    // Browse disk for a texture → asset-relative path. Opens in the skin folder.
    const onBrowse = useCallback(async (): Promise<string | null> => {
        try {
            const defaultPath = await skinDirDisk();
            const sel = await open({ defaultPath, multiple: false, filters: [{ name: 'Textures', extensions: ['tex', 'dds', 'png', 'jpg', 'jpeg', 'tga'] }] });
            return (sel && typeof sel === 'string') ? toAssetPath(sel) : null;
        } catch { return null; }
    }, [skinDirDisk]);

    // Create a solid-colour DDS in the skin's texture folder → asset path.
    const onNewSolid = useCallback(async (hex: string): Promise<string | null> => {
        if (!srcFilePath) return null;
        const baseTex = extractField(readText(), 'texture');
        if (!baseTex) { s.setStatusMessage('No skin texture folder to write into'); return null; }
        const folderAsset = baseTex.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        const name = `Solid_${hex.replace('#', '').toUpperCase()}.dds`;
        try {
            const baseDisk = await invoke<string | null>('resolve_asset_path', { baseFile: srcFilePath, assetPath: baseTex });
            if (!baseDisk) { s.setStatusMessage('Could not resolve the skin folder on disk'); return null; }
            const folderDisk = baseDisk.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
            await invoke('write_bytes_file', { path: `${folderDisk}/${name}`, bytes: Array.from(makeSolidDDS(hex, 64)) });
            s.setStatusMessage(`Created ${name}`);
            return `${folderAsset}/${name}`;
        } catch (e) {
            s.setStatusMessage(`New texture failed: ${e}`);
            return null;
        }
    }, [srcFilePath, readText, s]);

    const texTools = useMemo<TexTools>(() => ({ skinTextures, onBrowse, onNewSolid }), [skinTextures, onBrowse, onNewSolid]);

    // Add a floating texture node (visual-only until wired into a slot).
    const addTextureNode = useCallback((path: string) => {
        const p = path.trim();
        if (!p) return;
        const pl = p.toLowerCase();
        // Don't add a second node for a texture that already has one.
        if (rfNodesRef.current.some(n => n.type === 'texture' && ((n.data as TextureData).path ?? '').toLowerCase() === pl)) return;
        const id = `texnode-${texSeqRef.current++}`;
        const rect = rootRef.current?.getBoundingClientRect();
        const pos = rect
            ? rf.screenToFlowPosition({ x: rect.left + rect.width * 0.35, y: rect.top + rect.height * 0.4 })
            : { x: 0, y: 0 };
        posRef.current.set(id, pos);
        setRfNodes(prev => [...prev, { id, type: 'texture', position: pos, data: { title: basename(p), path: p, onPathCommit: onTexPathCommit } }]);
    }, [rf, onTexPathCommit, setRfNodes]);

    // Open the "Add Material Entry" inserter (same dialog as General Edit's
    // Material button), pre-loading SKN-based submesh/texture suggestions.
    const openMaterialDialog = useCallback(async () => {
        setShowMaterialDialog(true);
        setMatSuggestions([]);
        setMatTextures([]);
        if (!srcFilePath) return;
        const text = readText();
        const extract = (key: string) => {
            for (const raw of text.split('\n')) {
                const t = raw.trim();
                if (t.toLowerCase().startsWith(key.toLowerCase() + ':')) {
                    const eq = t.indexOf('='); if (eq !== -1) return t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
                }
            }
            return '';
        };
        const simpleSkin = extract('simpleSkin');
        const texturePath = extract('texture');
        if (!simpleSkin || !texturePath) return;
        try {
            const matchModeStr = await invoke<string>('get_preference', { key: 'MaterialMatchMode', defaultValue: '3' });
            const matchMode = parseInt(matchModeStr, 10) || 3;
            const result = await invoke<AutoMaterialResult>('auto_material_override', { binFilePath: srcFilePath, simpleSkinPath: simpleSkin, texturePath, matchMode });
            const existing = new Set<string>();
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (t.toLowerCase().startsWith('submesh:')) { const p = t.split('='); if (p.length >= 2) existing.add(p[1].trim().replace(/^["']|["']$/g, '').toLowerCase()); }
            }
            const out: MaterialSuggestion[] = [];
            for (const mm of result.matches) if (!existing.has(mm.material.toLowerCase())) out.push({ material: mm.material, texture: mm.texture });
            for (const u of result.unmatched) if (!existing.has(u.toLowerCase())) out.push({ material: u, texture: '' });
            setMatSuggestions(out);
            setMatTextures(result.textures ?? []);
        } catch { /* manual entry still works */ }
    }, [srcFilePath, readText]);

    // Plain material override: link an existing material name to a submesh.
    const onMaterialSubmit = useCallback((path: string, submesh: string) => {
        setShowMaterialDialog(false);
        if (!sourceTabId || !submesh.trim() || !path.trim()) return;
        s.applyEditToTab(sourceTabId, setOverrideMaterial(readText(), submesh.trim(), path.trim()));
    }, [sourceTabId, readText, s]);

    // Library-paired material: inject the StaticMaterialDef (+ swapped texture)
    // AND link it to the submesh, then copy its textures into the mod folder.
    // Ported from MaterialOverridePanel's library flow, targeting the source bin.
    const onMaterialSubmitWithLibrary = useCallback(async (_path: string, submesh: string, library: LibraryPairResult) => {
        setShowMaterialDialog(false);
        if (!sourceTabId) return;
        s.setStatusMessage(`Inserting ${library.materialName}…`);
        try {
            const snippet = await invoke<MaterialSnippet | null>('library_get_cached_material', { path: library.materialPath });
            if (!snippet) { s.setStatusMessage(`Library material ${library.materialPath} not cached`); return; }
            const content0 = readText();
            // Unique unix-timestamped name so the same library material in
            // different mods doesn't merge-clobber (game merges defs by name).
            const finalName = uniqueMaterialName(snippet.materialName, content0);
            let snippetText = renameMaterialInSnippet(snippet.snippet, snippet.materialName, finalName);
            if (library.texture) {
                const phRe = /(texturePath:\s*string\s*=\s*")[^"]*YOURCHAMP[^"]*(")/;
                snippetText = snippetText.replace(phRe, `$1${library.texture}$2`);
            }
            let next = content0;
            if (submesh.trim()) next = setOverrideMaterial(next, submesh.trim(), finalName);
            next = injectMaterialDef(next, snippetText);
            s.applyEditToTab(sourceTabId, next);

            try {
                const modInfo = await invoke<{ mod_root: string | null }>('library_detect_mod_folder', { binPath: srcFilePath });
                if (modInfo.mod_root) {
                    const copied = await invoke<string[]>('library_copy_textures_to_mod', { materialPath: library.materialPath, modRoot: modInfo.mod_root });
                    if (srcFilePath) s.recordJadelibInsert(srcFilePath, modInfo.mod_root, snippet.id);
                    s.setStatusMessage(`Inserted ${finalName} · copied ${copied.length} texture${copied.length === 1 ? '' : 's'}`);
                } else {
                    s.setStatusMessage(`Inserted ${finalName} — no mod root found, textures not copied`);
                }
            } catch (e) {
                s.setStatusMessage(`Inserted ${finalName} (texture copy failed: ${e})`);
            }
        } catch (e) {
            s.setStatusMessage(`Library insert failed: ${e}`);
        }
    }, [sourceTabId, readText, s, srcFilePath]);

    // Drag an output onto a socket → repoint that slot. Resolved from the
    // VISUAL node set (not the derived graph) so a disconnected node can still
    // be dragged back. Textures → any input; materials → a submesh row only.
    const onConnect = useCallback((c: Connection) => {
        if (!sourceTabId || !c.source) return;
        const nodes = rfNodesRef.current;
        const src = nodes.find(n => n.id === c.source);
        const tgt = nodes.find(n => n.id === c.target);
        if (!src || !tgt) return;
        const text = readText();
        let next: string | null = null;

        if (src.type === 'texture') {
            const srcPath = (src.data as TextureData).path;
            if (!srcPath) return;
            if (tgt.type === 'mesh') {
                if (c.targetHandle === 'base') next = setBaseTexture(text, srcPath);
                else {
                    const row = (tgt.data as MeshData).rows?.find(r => r.key === c.targetHandle);
                    if (row?.submesh) next = setOverrideTexture(text, row.submesh, srcPath);
                }
            } else if (tgt.type === 'material' && c.targetHandle) {
                const link = (tgt.data as MaterialData).subtitle;
                if (link) next = setSamplerTexture(text, link, c.targetHandle, srcPath);
            }
        } else if (src.type === 'material') {
            // A material can only drive a submesh's material override.
            const link = (src.data as MaterialData).subtitle;
            if (link && tgt.type === 'mesh' && c.targetHandle?.startsWith('sub:')) {
                const row = (tgt.data as MeshData).rows?.find(r => r.key === c.targetHandle);
                if (row?.submesh) next = setOverrideMaterial(text, row.submesh, link);
            }
        }
        if (next != null) s.applyEditToTab(sourceTabId, next);
    }, [sourceTabId, readText, s]);

    const isValidConnection = useCallback((c: Connection | Edge) => {
        const src = rfNodesRef.current.find(n => n.id === c.source);
        if (!src) return false;
        if (src.type === 'texture') return true;                      // textures → any input
        if (src.type === 'material') return c.target === graphRef.current?.meshId && !!c.targetHandle && c.targetHandle.startsWith('sub:');
        return false;
    }, []);

    // Knife cut: slash across wires to unlink them. Samples each rendered edge
    // path into screen-space points and tests them against the knife segment;
    // every crossed wire is emptied (one combined undo step).
    const performCut = useCallback((x1: number, y1: number, x2: number, y2: number) => {
        const g = graphRef.current;
        const root = rootRef.current;
        if (!sourceTabId || !g || !root) return;
        // Ignore a click with no drag (not a slash).
        if (Math.hypot(x2 - x1, y2 - y1) < 8) return;
        const hits = new Set<string>();
        root.querySelectorAll<SVGGElement>('.react-flow__edge').forEach((el) => {
            const id = el.getAttribute('data-id');
            const path = el.querySelector<SVGPathElement>('.react-flow__edge-path');
            if (!id || !path) return;
            const len = path.getTotalLength();
            const ctm = path.getScreenCTM();
            if (!len || !ctm) return;
            const N = 24;
            let prev: DOMPoint | null = null;
            for (let k = 0; k <= N; k++) {
                const p = path.getPointAtLength((len * k) / N).matrixTransform(ctm);
                if (prev && segmentsCross(x1, y1, x2, y2, prev.x, prev.y, p.x, p.y)) { hits.add(id); break; }
                prev = p;
            }
        });
        if (!hits.size) return;
        // The wires' source nodes stay on the canvas (persistent visual set);
        // we only empty their links in the text.
        let text = readText();
        for (const id of hits) {
            const edge = g.edges.find(e => e.id === id);
            if (!edge) continue;
            const tf = unlinkTransformForEdge(edge, g);
            if (tf) text = tf(text);
        }
        s.applyEditToTab(sourceTabId, text);
    }, [sourceTabId, readText, s]);

    // Right-drag anywhere on the canvas starts the knife.
    const onRootPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 2) return;
        e.preventDefault();
        const x1 = e.clientX, y1 = e.clientY;
        setKnife({ x1, y1, x2: x1, y2: y1 });
        const move = (ev: PointerEvent) => setKnife(k => (k ? { ...k, x2: ev.clientX, y2: ev.clientY } : null));
        const up = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            performCut(x1, y1, ev.clientX, ev.clientY);
            setKnife(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }, [performCut]);

    const capturePositions = useCallback((nodes: Node[]) => {
        for (const n of nodes) posRef.current.set(n.id, n.position);
    }, []);

    // Reconcile, don't rebuild: the visual node set is the source of truth for
    // what's ON the canvas. Text re-derivation updates node DATA and adds new
    // nodes, but never REMOVES a node — so unlinking a wire (which empties the
    // text and drops the derived node) leaves the node visible, just
    // disconnected, ready to be re-wired. Edges are derived purely from text.
    useEffect(() => {
        if (!graph) { setRfNodes([]); setRfEdges([]); return; }
        // Resolve each referenced texture path to a node id by MATCHING the
        // existing visual texture nodes by path. A node the user just re-pathed
        // (data.path updated) matches the newly-referenced path → same id, so
        // it swaps in place. Unmatched paths mint a fresh id.
        const visual = rfNodesRef.current.filter(n => n.type === 'texture');
        const pathToId = new Map<string, string>();
        const matched = new Set<string>();
        for (const n of graph.nodes) {
            if (n.kind !== 'texture' || !n.path) continue;
            const pl = n.path.toLowerCase();
            if (pathToId.has(pl)) continue;
            const v = visual.find(x => !matched.has(x.id) && ((x.data as TextureData).path ?? '').toLowerCase() === pl);
            if (v) { matched.add(v.id); pathToId.set(pl, v.id); }
            else pathToId.set(pl, `texnode-${texSeqRef.current++}`);
        }

        const { nodes: derived, idMap } = buildNodes(graph, posRef.current, {
            originalScale: originalScaleRef.current ?? 1,
            onScaleCommit,
            onTexPathCommit,
            texId: (path) => pathToId.get(path.toLowerCase()) ?? `tex:${path.toLowerCase()}`,
        });
        const derivedIds = new Set(derived.map(n => n.id));
        setRfNodes(prev => {
            const prevById = new Map(prev.map(n => [n.id, n]));
            const out: Node[] = derived.map(dn => {
                const p = prevById.get(dn.id);
                return p ? { ...dn, position: p.position, selected: p.selected } : dn;
            });
            // Keep nodes that fell out of the derived graph (disconnected /
            // floating) — but not a visual texture node we just merged into a
            // derived one (its id is now in derivedIds).
            for (const pn of prev) if (!derivedIds.has(pn.id)) out.push(pn);
            return out;
        });
        setRfEdges(buildEdges(graph, idMap));
    }, [graph, onScaleCommit, onTexPathCommit, setRfNodes, setRfEdges]);

    useEffect(() => { capturePositions(rfNodes); }, [rfNodes, capturePositions]);

    const minimapColor = useCallback((n: Node) => {
        if (n.type === 'mesh') return 'var(--jade-accent, #3794ff)';
        if (n.type === 'material') return '#a974d6';
        return '#e0902e';
    }, []);

    const emptyState = useMemo(() => {
        if (!graph) return 'Loading…';
        if (!graph.isSkinBin) return 'No node editor for this bin type yet — v1 supports skin bins.';
        if (!graph.meshId) return 'This skin bin has no mesh to show.';
        return null;
    }, [graph]);

    if (emptyState) {
        return (
            <div className="jade-rf-empty">
                <Box size={32} />
                <p>{emptyState}</p>
                {graph?.diagnostics?.map((d, i) => <p key={i} className="jade-rf-diag">{d}</p>)}
            </div>
        );
    }

    return (
      <TexToolsContext.Provider value={texTools}>
        <div
            className={`jade-rf-root${knife ? ' is-cutting' : ''}`}
            ref={rootRef}
            onPointerDown={onRootPointerDown}
            onContextMenu={(e) => e.preventDefault()}
        >
            <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={NODE_TYPES}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                isValidConnection={isValidConnection}
                fitView
                minZoom={0.1}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
                nodesConnectable={true}
                deleteKeyCode={null}
            >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="jade-rf-bg" />
                <MiniMap nodeColor={minimapColor} pannable zoomable className="jade-rf-minimap" />
                <Controls showInteractive={false} className="jade-rf-controls" />
            </ReactFlow>

            {/* Add-node toolbar */}
            <div className="jade-rf-toolbar" onPointerDown={(e) => e.stopPropagation()}>
                <button onClick={() => { setAddTexOpen(v => !v); setAddTexPath(''); }} title="Add a texture node">
                    <Plus size={13} /><ImageIcon size={13} /> Texture
                </button>
                <button onClick={openMaterialDialog} title="Add a material override">
                    <Plus size={13} /><Palette size={13} /> Material
                </button>
            </div>
            {addTexOpen && (
                <div className="jade-rf-addtex" onPointerDown={(e) => e.stopPropagation()}>
                    <input
                        autoFocus
                        placeholder="ASSETS/.../Texture.tex"
                        value={addTexPath}
                        onChange={(e) => setAddTexPath(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') { addTextureNode(addTexPath); setAddTexOpen(false); }
                            else if (e.key === 'Escape') setAddTexOpen(false);
                        }}
                    />
                    <button onClick={() => { addTextureNode(addTexPath); setAddTexOpen(false); }}>Add</button>
                </div>
            )}
            {showMaterialDialog && (
                <MaterialOverrideDialog
                    type="material"
                    defaultPath=""
                    binFilePath={srcFilePath}
                    suggestions={matSuggestions}
                    detectedTextures={matTextures}
                    onSubmit={onMaterialSubmit}
                    onSubmitWithLibrary={onMaterialSubmitWithLibrary}
                    onCancel={() => setShowMaterialDialog(false)}
                />
            )}

            {knife && (
                <svg className="jade-rf-knife">
                    <line x1={knife.x1} y1={knife.y1} x2={knife.x2} y2={knife.y2} />
                </svg>
            )}
            {graph && graph.diagnostics.length > 0 && (
                <div className="jade-rf-diagbar" title={graph.diagnostics.join('\n')}>
                    <AlertTriangle size={12} /> {graph.diagnostics.length} note{graph.diagnostics.length === 1 ? '' : 's'}
                </div>
            )}
        </div>
      </TexToolsContext.Provider>
    );
}

export default function NodeGraphTab({ tabId }: { tabId: string }) {
    return (
        <ReactFlowProvider>
            <NodeGraphInner tabId={tabId} />
        </ReactFlowProvider>
    );
}
