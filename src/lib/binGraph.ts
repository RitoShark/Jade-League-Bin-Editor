// Bin → graph extraction.
//
// Parses ritobin TEXT (the same content Monaco holds for a .bin tab) into a
// typed node/edge graph describing a skin bin's link structure, laid out
// like a Blender shader graph: inputs (textures) flow left → right into the
// mesh "output" node.
//
//     [Texture] ─┐
//     [Texture] ─┤→ [ MESH / SKN node ]   (one socket row per submesh)
//     [Material]─┘        ▲ each row = a submesh, wired via its override
//
// The graph is a *view* over the text — text stays the single source of
// truth. We parse the text (not a backend BinTree) so re-derivation on edit
// is a pure synchronous step and edits map straight back to text splices.
//
// v1 scope: skin bins. The mesh node collapses the SkinCharacterDataProperties
// + SkinMeshDataProperties + every submesh override into one multi-row node;
// each override is represented as the *wire* into its submesh row (not a
// node of its own). Non-skin bins return isSkinBin=false.

export type BinNodeKind = 'texture' | 'material' | 'mesh';

/** One input socket row on the mesh node. `key` doubles as the React Flow
 *  target-handle id so a wire can attach to this specific row. */
export interface MeshRow {
    key: string;            // 'base' | `sub:${lowername}`
    label: string;          // 'Base' | submesh display name
    via: 'texture' | 'material' | 'none';
    /** Submesh name as written in the bin (for edit splices). */
    submesh?: string;
    /** 0-based line of the override entry backing this row (for unlink /
     *  relink in the edit phase). Absent for the base row. */
    overrideLine?: number;
}

/** One sampler input socket row on a material node — same idea as MeshRow but
 *  for a StaticMaterialDef's texture slots (Diffuse_Texture, Mask_*, …). */
export interface MaterialSampler {
    key: string;            // handle id, `samp:${index}`
    label: string;          // TextureName (e.g. "Diffuse_Texture")
    texturePath: string;
    /** 0-based line of the `texturePath:` field (for relink splices). */
    line?: number;
}

export interface BinGraphNode {
    id: string;
    kind: BinNodeKind;
    title: string;
    subtitle?: string;
    /** Asset path for texture nodes. */
    path?: string;
    /** Material link that resolves into a *different* bin (dimmed leaf). */
    externalUnresolved?: boolean;
    /** 0-based line of the backing entry/field in the source text. */
    line?: number;
    // ── material-node only ───────────────────────────────────────
    samplers?: MaterialSampler[];
    // ── mesh-node only ───────────────────────────────────────────
    rows?: MeshRow[];
    meta?: { label: string; value: string }[];
    /** Absolute SkinScale value in the file (1.0 when absent). */
    skinScale?: number;
    /** 0-based line of the `SkinScale:` field, or -1 when absent. */
    skinScaleLine?: number;
    /** 0-based line of the mesh open line — insert anchor for a missing
     *  SkinScale field. */
    meshLine?: number;
}

export interface BinGraphEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
    label?: string;
    kind: 'texture-mesh' | 'material-mesh' | 'texture-material';
}

export interface BinGraph {
    nodes: BinGraphNode[];
    edges: BinGraphEdge[];
    diagnostics: string[];
    isSkinBin: boolean;
    skinName?: string;
    /** Id of the single mesh node, if present (convenience for the view). */
    meshId?: string;
}

// ── low-level text helpers ────────────────────────────────────────────────

function findBlockEnd(lines: string[], openIdx: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = openIdx; i < lines.length; i++) {
        for (const c of lines[i]) {
            if (c === '{') { depth++; seenOpen = true; }
            else if (c === '}') depth--;
        }
        if (seenOpen && depth <= 0) return i;
    }
    return -1;
}

function fieldValue(line: string, key: string): string | null {
    const t = line.trim();
    if (!t.toLowerCase().startsWith(key.toLowerCase() + ':')) return null;
    const eq = t.indexOf('=');
    if (eq === -1) return null;
    return t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
}

function findField(lines: string[], from: number, to: number, key: string): { value: string; line: number } | null {
    for (let i = from; i < to; i++) {
        const v = fieldValue(lines[i], key);
        if (v !== null) return { value: v, line: i };
    }
    return null;
}

export function basename(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
}

// ── graph extraction ──────────────────────────────────────────────────────

const RE_SKIN = /=\s*SkinCharacterDataProperties\s*\{/;
const RE_MESH = /skinMeshProperties\s*:.*SkinMeshDataProperties\s*\{/;
const RE_OVERRIDE_LIST = /materialOverride\s*:\s*list\[embed\]\s*=\s*\{/;
const RE_OVERRIDE_ENTRY = /SkinMeshDataProperties_MaterialOverride\s*\{/;
// Case-insensitive: game bins write `samplerValues`, but library-material
// snippets use `SamplerValues` — both must parse.
const RE_SAMPLER_LIST = /samplerValues\s*:\s*list2?\[embed\]\s*=\s*\{/i;
const RE_SAMPLER_ENTRY = /StaticMaterialShaderSamplerDef\s*\{/i;

export function parseBinGraph(text: string): BinGraph {
    const lines = text.split('\n');
    const diagnostics: string[] = [];
    const nodes: BinGraphNode[] = [];
    const edges: BinGraphEdge[] = [];

    const textureIds = new Map<string, string>();
    const materialIds = new Map<string, string>();
    let edgeSeq = 0;
    const pushEdge = (e: Omit<BinGraphEdge, 'id'>) => { edges.push({ ...e, id: `e${edgeSeq++}` }); };

    const ensureTexture = (path: string): string => {
        const key = path.toLowerCase();
        const existing = textureIds.get(key);
        if (existing) return existing;
        const id = `tex:${key}`;
        textureIds.set(key, id);
        nodes.push({ id, kind: 'texture', title: basename(path), subtitle: path, path });
        return id;
    };

    const ensureMaterial = (link: string): string => {
        const key = link.toLowerCase();
        const existing = materialIds.get(key);
        if (existing) return existing;
        const id = `mat:${key}`;
        materialIds.set(key, id);
        const defIdx = lines.findIndex(l => l.includes(`"${link}"`) && /=\s*StaticMaterialDef\s*\{/.test(l));
        const node: BinGraphNode = { id, kind: 'material', title: basename(link), subtitle: link };
        nodes.push(node);
        if (defIdx === -1) {
            node.externalUnresolved = true;
            diagnostics.push(`Material "${basename(link)}" links into another bin — shown as a leaf.`);
            return id;
        }
        node.line = defIdx;
        node.samplers = [];
        const defEnd = findBlockEnd(lines, defIdx);
        const defScopeEnd = defEnd === -1 ? lines.length : defEnd;
        const sampListIdx = lines.findIndex((l, i) => i >= defIdx && i < defScopeEnd && RE_SAMPLER_LIST.test(l));
        if (sampListIdx !== -1) {
            const sampEnd = findBlockEnd(lines, sampListIdx);
            const sampStop = sampEnd === -1 ? defScopeEnd : sampEnd;
            let i = sampListIdx + 1;
            let sampSeq = 0;
            while (i < sampStop) {
                if (!RE_SAMPLER_ENTRY.test(lines[i])) { i++; continue; }
                const sEnd = findBlockEnd(lines, i);
                const sStop = sEnd === -1 ? i + 1 : sEnd;
                const texName = findField(lines, i, sStop + 1, 'TextureName')?.value;
                const texField = findField(lines, i, sStop + 1, 'texturePath');
                const sampKey = `samp:${sampSeq++}`;
                // Each sampler becomes a socket row on the material node; the
                // texture wires into that row rather than carrying a label.
                node.samplers!.push({
                    key: sampKey,
                    label: texName || 'Texture',
                    texturePath: texField?.value ?? '',
                    line: texField?.line,
                });
                if (texField?.value) {
                    const texId = ensureTexture(texField.value);
                    pushEdge({ source: texId, target: id, targetHandle: sampKey, kind: 'texture-material' });
                }
                i = sStop + 1;
            }
        }
        return id;
    };

    // 1 ── Skin root ───────────────────────────────────────────────
    const skinIdx = lines.findIndex(l => RE_SKIN.test(l));
    if (skinIdx === -1) {
        return { nodes: [], edges: [], diagnostics: ['No SkinCharacterDataProperties entry — not a skin bin.'], isSkinBin: false };
    }
    const skinEnd = findBlockEnd(lines, skinIdx);
    const skinScopeEnd = skinEnd === -1 ? lines.length : skinEnd;
    const champName = findField(lines, skinIdx, skinScopeEnd, 'championSkinName')?.value;
    const entryKey = lines[skinIdx].match(/"([^"]+)"\s*=/)?.[1];
    const skinTitle = champName || (entryKey ? basename(entryKey) : 'Skin');

    const otherSkins = lines.slice(skinIdx + 1).filter(l => RE_SKIN.test(l)).length;
    if (otherSkins > 0) {
        diagnostics.push(`Multi-form bin: ${otherSkins + 1} skins present — showing the first only.`);
    }

    // 2 ── Mesh (the big output node) ──────────────────────────────
    const meshIdx = lines.findIndex((l, i) => i >= skinIdx && RE_MESH.test(l));
    if (meshIdx === -1) {
        diagnostics.push('No SkinMeshDataProperties — nothing to graph.');
        return { nodes, edges, diagnostics, isSkinBin: true, skinName: skinTitle };
    }
    const meshEnd = findBlockEnd(lines, meshIdx);
    const meshScopeEnd = meshEnd === -1 ? lines.length : meshEnd;

    const meshNode: BinGraphNode = {
        id: 'mesh', kind: 'mesh', title: skinTitle, line: meshIdx,
        meta: [], rows: [], skinScale: 1.0, skinScaleLine: -1, meshLine: meshIdx,
    };
    nodes.push(meshNode);

    // Direct mesh fields (depth-1 children) — distinguished from deeper
    // override `texture:` lines by tracking brace depth from the mesh open.
    let baseTexLine = -1;
    let sknName: string | undefined;
    {
        let depth = 0;
        for (let i = meshIdx; i < meshScopeEnd; i++) {
            const startDepth = depth;
            for (const c of lines[i]) {
                if (c === '{') depth++;
                else if (c === '}') depth--;
            }
            if (i === meshIdx) continue;
            if (startDepth !== 1) continue;
            const skn = fieldValue(lines[i], 'simpleSkin');
            if (skn) sknName = basename(skn);   // shown as the node subtitle
            const skl = fieldValue(lines[i], 'skeleton');
            if (skl) meshNode.meta!.push({ label: 'skl', value: basename(skl) });
            // Detect the base texture line even when emptied (unlinked) so the
            // Base row persists with no wire instead of vanishing.
            if (fieldValue(lines[i], 'texture') !== null && baseTexLine === -1) baseTexLine = i;
            const scale = fieldValue(lines[i], 'SkinScale');
            if (scale !== null) {
                const parsed = parseFloat(scale);
                if (!isNaN(parsed)) meshNode.skinScale = parsed;
                meshNode.skinScaleLine = i;
            }
        }
    }
    if (sknName) meshNode.subtitle = sknName;

    // Base texture → 'base' row. An emptied (unlinked) base keeps the row but
    // draws no wire and creates no phantom texture node.
    if (baseTexLine !== -1) {
        const path = fieldValue(lines[baseTexLine], 'texture') || '';
        meshNode.rows!.push({ key: 'base', label: 'Base', via: path ? 'texture' : 'none' });
        if (path) {
            const texId = ensureTexture(path);
            pushEdge({ source: texId, target: 'mesh', targetHandle: 'base', label: 'base', kind: 'texture-mesh' });
        }
    }

    // 3 ── Overrides → submesh rows ────────────────────────────────
    const ovListIdx = lines.findIndex((l, i) => i >= meshIdx && i < meshScopeEnd && RE_OVERRIDE_LIST.test(l));
    if (ovListIdx !== -1) {
        const ovListEnd = findBlockEnd(lines, ovListIdx);
        const ovStop = ovListEnd === -1 ? meshScopeEnd : ovListEnd;
        const seenRows = new Set<string>();
        let idx = ovListIdx + 1;
        while (idx < ovStop) {
            if (!RE_OVERRIDE_ENTRY.test(lines[idx])) { idx++; continue; }
            const entryEnd = findBlockEnd(lines, idx);
            const stop = entryEnd === -1 ? idx + 1 : entryEnd;
            const submesh = findField(lines, idx, stop + 1, 'Submesh')?.value;
            const tex = findField(lines, idx, stop + 1, 'texture')?.value;
            const mat = findField(lines, idx, stop + 1, 'Material')?.value;

            if (submesh) {
                const rowKey = `sub:${submesh.toLowerCase()}`;
                if (!seenRows.has(rowKey)) {
                    seenRows.add(rowKey);
                    const via: MeshRow['via'] = tex ? 'texture' : mat ? 'material' : 'none';
                    meshNode.rows!.push({ key: rowKey, label: submesh, via, submesh, overrideLine: idx });
                    if (tex) {
                        const texId = ensureTexture(tex);
                        pushEdge({ source: texId, target: 'mesh', targetHandle: rowKey, kind: 'texture-mesh' });
                    } else if (mat) {
                        const matId = ensureMaterial(mat);
                        pushEdge({ source: matId, target: 'mesh', targetHandle: rowKey, kind: 'material-mesh' });
                    }
                }
            }
            idx = stop + 1;
        }
    }

    // Surface ALL StaticMaterialDef entries (even ones no submesh currently
    // references) with their sampler textures + internal wires. This keeps a
    // material and its textures intact when it's unlinked from every submesh —
    // the def still exists in the text, so the node still derives.
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/"([^"]+)"\s*=\s*StaticMaterialDef\s*\{/);
        if (m) ensureMaterial(m[1]);
    }

    return { nodes, edges, diagnostics, isSkinBin: true, skinName: skinTitle, meshId: 'mesh' };
}

// ── edit: SkinScale write-back ────────────────────────────────────────────

/** Produce new bin text with SkinScale set to `value`. Replaces the existing
 *  `SkinScale:` line, or inserts one right after the mesh's `texture:` /
 *  `simpleSkin:` line when absent. Returns the original text unchanged if the
 *  mesh block can't be located. Pure — caller applies it to the model. */
export function setSkinScale(text: string, value: number): string {
    const lines = text.split('\n');
    const v = Number.isFinite(value) ? value : 1.0;
    const formatted = formatScale(v);

    // Replace an existing SkinScale (search inside the mesh block only).
    const meshIdx = lines.findIndex(l => RE_MESH.test(l));
    if (meshIdx === -1) return text;
    const meshEnd = findBlockEnd(lines, meshIdx);
    const meshStop = meshEnd === -1 ? lines.length : meshEnd;

    for (let i = meshIdx + 1; i < meshStop; i++) {
        if (fieldValue(lines[i], 'SkinScale') !== null) {
            const indent = lines[i].match(/^(\s*)/)?.[1] ?? '            ';
            lines[i] = `${indent}SkinScale: f32 = ${formatted}`;
            return lines.join('\n');
        }
    }

    // Not present — insert after the base texture / simpleSkin field at the
    // mesh's direct-child depth so it lands inside the mesh block.
    let anchor = -1;
    let depth = 0;
    for (let i = meshIdx; i < meshStop; i++) {
        const startDepth = depth;
        for (const c of lines[i]) {
            if (c === '{') depth++;
            else if (c === '}') depth--;
        }
        if (i === meshIdx) continue;
        if (startDepth !== 1) continue;
        if (fieldValue(lines[i], 'texture') !== null || fieldValue(lines[i], 'simpleSkin') !== null) anchor = i;
    }
    if (anchor === -1) anchor = meshIdx;
    const indent = lines[anchor + 1]?.match(/^(\s*)/)?.[1]
        ?? lines[anchor].match(/^(\s*)/)?.[1] ?? '            ';
    lines.splice(anchor + 1, 0, `${indent}SkinScale: f32 = ${formatted}`);
    return lines.join('\n');
}

/** Compact float formatting that keeps ritobin happy — drops trailing zeros
 *  but always leaves at least one fractional digit for readability. */
function formatScale(v: number): string {
    if (Number.isInteger(v)) return `${v}`;
    return parseFloat(v.toFixed(4)).toString();
}

// ── edit: override / texture / sampler write-back ──────────────────────────
// All are pure text transforms returning new bin text (or the original
// unchanged when the target can't be located). The caller applies the result
// to the source model via applyEditToTab so Monaco undo covers every edit.

/** Locate the mesh's `materialOverride: list[embed]` block. Returns the open
 *  and close line indices, or null. */
function findOverrideList(lines: string[]): { open: number; close: number } | null {
    const meshIdx = lines.findIndex(l => RE_MESH.test(l));
    if (meshIdx === -1) return null;
    const meshEnd = findBlockEnd(lines, meshIdx);
    const meshStop = meshEnd === -1 ? lines.length : meshEnd;
    const open = lines.findIndex((l, i) => i >= meshIdx && i < meshStop && RE_OVERRIDE_LIST.test(l));
    if (open === -1) return null;
    const close = findBlockEnd(lines, open);
    return { open, close: close === -1 ? meshStop : close };
}

/** Find the override entry (start/end line) whose `Submesh` matches `submesh`
 *  (case-insensitive) inside the materialOverride list. */
function findOverrideEntry(lines: string[], submesh: string): { start: number; end: number } | null {
    const list = findOverrideList(lines);
    if (!list) return null;
    const want = submesh.toLowerCase();
    let i = list.open + 1;
    while (i < list.close) {
        if (!RE_OVERRIDE_ENTRY.test(lines[i])) { i++; continue; }
        const end = findBlockEnd(lines, i);
        const stop = end === -1 ? i + 1 : end;
        const sub = findField(lines, i, stop + 1, 'Submesh')?.value;
        if (sub && sub.toLowerCase() === want) return { start: i, end: stop };
        i = stop + 1;
    }
    return null;
}

/** Remove the override entry for a submesh entirely (delete, not unlink).
 *  Kept for completeness; the UI uses clearOverrideForSubmesh instead. */
export function removeOverrideForSubmesh(text: string, submesh: string): string {
    const lines = text.split('\n');
    const entry = findOverrideEntry(lines, submesh);
    if (!entry) return text;
    lines.splice(entry.start, entry.end - entry.start + 1);
    return lines.join('\n');
}

/** Unlink a submesh override — empties its texture / Material value but keeps
 *  the entry (so the submesh stays in the list). An empty path is a valid
 *  intermediate state; the converter flags it on save if it objects. */
export function clearOverrideForSubmesh(text: string, submesh: string): string {
    const lines = text.split('\n');
    const entry = findOverrideEntry(lines, submesh);
    if (!entry) return text;
    for (let i = entry.start; i <= entry.end; i++) {
        const ind = lines[i].match(/^(\s*)/)?.[1] ?? '';
        if (fieldValue(lines[i], 'texture') !== null) { lines[i] = `${ind}texture: string = ""`; return lines.join('\n'); }
        if (fieldValue(lines[i], 'Material') !== null) { lines[i] = `${ind}Material: link = ""`; return lines.join('\n'); }
    }
    return text;
}

/** Point a submesh's override at a texture path. Replaces an existing entry's
 *  `texture:`/`Material:` line, or inserts a new override entry when none
 *  exists (creating the materialOverride list if necessary). */
export function setOverrideTexture(text: string, submesh: string, texturePath: string): string {
    const lines = text.split('\n');
    const entry = findOverrideEntry(lines, submesh);
    if (entry) {
        // Replace the value-bearing line inside the entry; drop a Material
        // line in favour of a texture line so the slot is texture-driven.
        let texLineRel = -1, matLineRel = -1;
        for (let i = entry.start; i <= entry.end; i++) {
            if (fieldValue(lines[i], 'texture') !== null) texLineRel = i;
            if (fieldValue(lines[i], 'Material') !== null) matLineRel = i;
        }
        if (texLineRel !== -1) {
            const indent = lines[texLineRel].match(/^(\s*)/)?.[1] ?? '';
            lines[texLineRel] = `${indent}texture: string = "${texturePath}"`;
            if (matLineRel !== -1) lines.splice(matLineRel, 1);
            return lines.join('\n');
        }
        if (matLineRel !== -1) {
            const indent = lines[matLineRel].match(/^(\s*)/)?.[1] ?? '';
            lines[matLineRel] = `${indent}texture: string = "${texturePath}"`;
            return lines.join('\n');
        }
        // Entry exists but has neither — insert a texture line after the open.
        const indent = (lines[entry.start + 1]?.match(/^(\s*)/)?.[1]) ?? '                ';
        lines.splice(entry.start + 1, 0, `${indent}texture: string = "${texturePath}"`);
        return lines.join('\n');
    }
    return insertOverride(lines, submesh, texturePath, 'texture');
}

/** Point a submesh's override at a material link. Replaces an existing entry's
 *  `Material:`/`texture:` line, or inserts a new override entry. */
export function setOverrideMaterial(text: string, submesh: string, materialLink: string): string {
    const lines = text.split('\n');
    const entry = findOverrideEntry(lines, submesh);
    if (entry) {
        let texLineRel = -1, matLineRel = -1;
        for (let i = entry.start; i <= entry.end; i++) {
            if (fieldValue(lines[i], 'texture') !== null) texLineRel = i;
            if (fieldValue(lines[i], 'Material') !== null) matLineRel = i;
        }
        if (matLineRel !== -1) {
            const indent = lines[matLineRel].match(/^(\s*)/)?.[1] ?? '';
            lines[matLineRel] = `${indent}Material: link = "${materialLink}"`;
            if (texLineRel !== -1) lines.splice(texLineRel, 1);
            return lines.join('\n');
        }
        if (texLineRel !== -1) {
            const indent = lines[texLineRel].match(/^(\s*)/)?.[1] ?? '';
            lines[texLineRel] = `${indent}Material: link = "${materialLink}"`;
            return lines.join('\n');
        }
        const indent = (lines[entry.start + 1]?.match(/^(\s*)/)?.[1]) ?? '                ';
        lines.splice(entry.start + 1, 0, `${indent}Material: link = "${materialLink}"`);
        return lines.join('\n');
    }
    return insertOverride(lines, submesh, materialLink, 'material');
}

/** Insert a new SkinMeshDataProperties_MaterialOverride entry. Mirrors the
 *  MaterialOverridePanel splice logic (creates the list when absent). */
function insertOverride(lines: string[], submesh: string, value: string, type: 'texture' | 'material'): string {
    let list = findOverrideList(lines);
    if (!list) {
        // Create the materialOverride list right after the mesh open line.
        const meshIdx = lines.findIndex(l => RE_MESH.test(l));
        if (meshIdx === -1) return lines.join('\n');
        const indent = (lines[meshIdx + 1]?.match(/^(\s*)/)?.[1]) ?? '            ';
        lines.splice(meshIdx + 1, 0, `${indent}materialOverride: list[embed] = {`, `${indent}}`);
        list = findOverrideList(lines);
        if (!list) return lines.join('\n');
    }
    const entryIndent = (lines[list.open + 1]?.trim() && lines[list.open + 1].match(/^(\s*)/)?.[1])
        || '                ';
    const fieldIndent = entryIndent + '    ';
    const propType = type === 'texture' ? 'string' : 'link';
    const block = [
        `${entryIndent}SkinMeshDataProperties_MaterialOverride {`,
        `${fieldIndent}${type}: ${propType} = "${value}"`,
        `${fieldIndent}Submesh: string = "${submesh}"`,
        `${entryIndent}}`,
    ];
    lines.splice(list.close, 0, ...block);
    return lines.join('\n');
}

/** Set the mesh's base `texture:` (depth-1 child of SkinMeshDataProperties). */
export function setBaseTexture(text: string, texturePath: string): string {
    const lines = text.split('\n');
    const meshIdx = lines.findIndex(l => RE_MESH.test(l));
    if (meshIdx === -1) return text;
    const meshEnd = findBlockEnd(lines, meshIdx);
    const meshStop = meshEnd === -1 ? lines.length : meshEnd;
    let depth = 0;
    for (let i = meshIdx; i < meshStop; i++) {
        const startDepth = depth;
        for (const c of lines[i]) { if (c === '{') depth++; else if (c === '}') depth--; }
        if (i === meshIdx || startDepth !== 1) continue;
        if (fieldValue(lines[i], 'texture') !== null) {
            const indent = lines[i].match(/^(\s*)/)?.[1] ?? '';
            lines[i] = `${indent}texture: string = "${texturePath}"`;
            return lines.join('\n');
        }
    }
    return text;
}

/** Set the texturePath of the Nth sampler (`samp:${index}`) inside the
 *  StaticMaterialDef identified by `materialLink`. Inserts a texturePath
 *  line after TextureName when the sampler lacks one. */
export function setSamplerTexture(text: string, materialLink: string, samplerKey: string, texturePath: string): string {
    const lines = text.split('\n');
    const wantIdx = parseInt(samplerKey.replace('samp:', ''), 10);
    if (isNaN(wantIdx)) return text;
    const defIdx = lines.findIndex(l => l.includes(`"${materialLink}"`) && /=\s*StaticMaterialDef\s*\{/.test(l));
    if (defIdx === -1) return text;
    const defEnd = findBlockEnd(lines, defIdx);
    const defStop = defEnd === -1 ? lines.length : defEnd;
    const sampListIdx = lines.findIndex((l, i) => i >= defIdx && i < defStop && RE_SAMPLER_LIST.test(l));
    if (sampListIdx === -1) return text;
    const sampEnd = findBlockEnd(lines, sampListIdx);
    const sampStop = sampEnd === -1 ? defStop : sampEnd;
    let i = sampListIdx + 1;
    let seq = 0;
    while (i < sampStop) {
        if (!RE_SAMPLER_ENTRY.test(lines[i])) { i++; continue; }
        const sEnd = findBlockEnd(lines, i);
        const sStop = sEnd === -1 ? i + 1 : sEnd;
        if (seq === wantIdx) {
            for (let j = i; j <= sStop; j++) {
                if (fieldValue(lines[j], 'texturePath') !== null) {
                    const indent = lines[j].match(/^(\s*)/)?.[1] ?? '';
                    lines[j] = `${indent}texturePath: string = "${texturePath}"`;
                    return lines.join('\n');
                }
            }
            // No texturePath line — insert after TextureName (or after open).
            let anchor = i;
            for (let j = i; j <= sStop; j++) if (fieldValue(lines[j], 'TextureName') !== null) anchor = j;
            const indent = (lines[anchor + 1]?.match(/^(\s*)/)?.[1]) ?? '                    ';
            lines.splice(anchor + 1, 0, `${indent}texturePath: string = "${texturePath}"`);
            return lines.join('\n');
        }
        seq++;
        i = sStop + 1;
    }
    return text;
}

/** Splice a StaticMaterialDef snippet into the bin's top-level entries map,
 *  anchored after the SkinCharacterDataProperties entry (or before
 *  ResourceResolver as a fallback). Ported from MaterialOverridePanel so the
 *  node editor's "Add Material" lands defs the same way. */
export function injectMaterialDef(content: string, snippetText: string): string {
    const lines = content.split('\n');
    const entryRe = /^(\s*)("[^"]+"|0x[0-9a-fA-F]+)\s*=\s*(\w+)\s*\{/;
    type Entry = { start: number; end: number; indent: string; className: string };
    const entries: Entry[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = entryRe.exec(lines[i]);
        if (!m) continue;
        const end = findBlockEnd(lines, i);
        if (end === -1) continue;
        entries.push({ start: i, end, indent: m[1], className: m[3] });
        i = end;
    }

    let insertIdx = -1;
    let anchorIndent = '    ';
    const skinChar = entries.find(e => e.className === 'SkinCharacterDataProperties');
    if (skinChar) {
        insertIdx = skinChar.end + 1;
        anchorIndent = skinChar.indent;
        // Stack below any existing jadelib_* defs so repeated inserts queue.
        for (const e of entries) {
            if (e.start < insertIdx) continue;
            if (e.className !== 'StaticMaterialDef') break;
            if (!lines[e.start].match(/"(jadelib_[^"]+)"/)) break;
            insertIdx = e.end + 1;
        }
    } else {
        const res = entries.find(e => e.className === 'ResourceResolver');
        if (res) { insertIdx = res.start; anchorIndent = res.indent; }
    }

    if (insertIdx === -1) return content + '\n' + snippetText + '\n';
    const indented = snippetText.split('\n').map(l => (l.length > 0 ? anchorIndent + l : l)).join('\n');
    return [...lines.slice(0, insertIdx), indented, ...lines.slice(insertIdx)].join('\n');
}

/** Replace every reference to a texture path with a new one. Textures are
 *  deduped to one node, so editing a texture node's path repoints every slot
 *  that used it. Matches the quoted path so partial paths aren't clobbered. */
export function replaceTexturePath(text: string, oldPath: string, newPath: string): string {
    if (!oldPath || oldPath === newPath) return text;
    return text.split(`"${oldPath}"`).join(`"${newPath}"`);
}
