import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import MaterialOverrideDockPanel, { type LibraryPairResult } from './MaterialOverrideDockPanel';
import { useShell } from './ShellContext';
import { uniqueMaterialName, renameMaterialInSnippet } from '../lib/materialInsert';

interface AutoMaterialResult {
    matches: { material: string; texture: string }[];
    skn_path: string;
    unmatched: string[];
    textures: string[];
}

// Mirrors GeneralEditPanel's library snippet shape — name, materialName,
// userSlots, and the ritobin text we splice in.
interface MaterialSnippet {
    id: string;
    name: string;
    materialName: string;
    userSlots: { name: string; kind: string; description: string }[];
    snippet: string;
}

interface MaterialOverridePanelProps {
    /** `'texture'`: insert `texture: string = "..."`.
     *  `'material'`: insert `material: link = "..."`. */
    entryType: 'texture' | 'material';
    /** Called when the user closes the panel via Cancel / dock × button. */
    onClose: () => void;
}

/**
 * Dockable variant of the material-override insert flow. Re-uses the
 * full `MaterialOverrideDialog` component in `embedded` mode so SKN
 * suggestions, library pairing, texture previews, and the manual
 * texture picker all keep working — only the modal overlay is
 * stripped. State (active bin path, default texture, suggestions,
 * detected textures) is derived from `useShell()` instead of being
 * piped through props from a parent.
 */
export default function MaterialOverridePanel({ entryType, onClose }: MaterialOverridePanelProps) {
    const s = useShell();
    const tab = s.activeTab;
    const filePath = tab?.filePath ?? undefined;

    const [defaultPath, setDefaultPath] = useState('');
    const [suggestions, setSuggestions] = useState<{ material: string; texture: string }[]>([]);
    const [detectedTextures, setDetectedTextures] = useState<string[]>([]);

    // ── Helpers — same logic the General Edit panel uses, kept local
    //     so this panel stands alone. ──
    const editorContent = () =>
        s.editorRef.current?.getValue() ?? tab?.content ?? '';

    const extractFirst = (key: string): string => {
        const lines = editorContent().split('\n');
        for (const raw of lines) {
            const trimmed = raw.trim();
            if (trimmed.toLowerCase().startsWith(key.toLowerCase() + ':')) {
                const parts = trimmed.split('=');
                if (parts.length >= 2) {
                    return parts[1].trim().replace(/^["']|["']$/g, '');
                }
            }
        }
        return '';
    };

    // Initial defaults + lazy suggestion load whenever the active file
    // or tool open state changes.
    useEffect(() => {
        let cancelled = false;
        const texturePath = extractFirst('texture');
        setDefaultPath(texturePath);
        setSuggestions([]);
        setDetectedTextures([]);

        if (!filePath) return;
        const simpleSkinPath = extractFirst('simpleSkin');
        if (!simpleSkinPath || !texturePath) return;

        (async () => {
            try {
                const matchModeStr = await invoke<string>('get_preference', {
                    key: 'MaterialMatchMode',
                    defaultValue: '3',
                });
                const matchMode = parseInt(matchModeStr, 10) || 3;
                const result = await invoke<AutoMaterialResult>('auto_material_override', {
                    binFilePath: filePath,
                    simpleSkinPath,
                    texturePath,
                    matchMode,
                });
                if (cancelled) return;

                // Skip submeshes that already have a material override.
                const existing = new Set<string>();
                for (const line of editorContent().split('\n')) {
                    const t = line.trim();
                    if (t.toLowerCase().startsWith('submesh:')) {
                        const parts = t.split('=');
                        if (parts.length >= 2) {
                            existing.add(parts[1].trim().replace(/^["']|["']$/g, '').toLowerCase());
                        }
                    }
                }

                const out: { material: string; texture: string }[] = [];
                for (const m of result.matches) {
                    if (!existing.has(m.material.toLowerCase())) out.push({ material: m.material, texture: m.texture });
                }
                for (const u of result.unmatched) {
                    if (!existing.has(u.toLowerCase())) out.push({ material: u, texture: '' });
                }
                setSuggestions(out);
                setDetectedTextures(result.textures ?? []);
            } catch {
                // Silently fall back to manual mode.
            }
        })();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, tab?.id, entryType]);

    // ── Insert logic — mirrors GeneralEditPanel.addMaterialOverrideEntry. ──
    const insertEntry = useCallback((path: string, submesh: string, type: 'texture' | 'material') => {
        const content = editorContent();
        if (!content) return false;
        const lines = content.split('\n');

        let mainIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('materialOverride:') && lines[i].includes('list[embed]')) {
                mainIndex = i;
                break;
            }
        }
        if (mainIndex === -1) return false;

        let depth = 0;
        let insertIndex = -1;
        for (let j = mainIndex; j < lines.length; j++) {
            for (const c of lines[j]) {
                if (c === '{') depth++;
                else if (c === '}') depth--;
            }
            if (depth === 0 && j > mainIndex) { insertIndex = j; break; }
        }
        if (insertIndex === -1) return false;

        let indent = '            ';
        const sample = lines[mainIndex + 1];
        if (sample && sample.trim()) {
            const m = sample.match(/^(\s*)/);
            if (m) indent = m[1];
        }

        const propertyType = type === 'texture' ? 'string' : 'link';
        const propertyName = type === 'texture' ? 'texture' : 'material';
        const block = [
            `${indent}SkinMeshDataProperties_MaterialOverride {`,
            `${indent}    ${propertyName}: ${propertyType} = "${path}"`,
            `${indent}    Submesh: string = "${submesh}"`,
            `${indent}}`,
        ];

        const next: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (i === insertIndex) next.push(...block);
            next.push(lines[i]);
        }
        s.handleGeneralEditContentChange(next.join('\n'));
        return true;
    }, [s, tab]);

    const onSubmit = useCallback((path: string, submesh: string) => {
        insertEntry(path, submesh, entryType);
        onClose();
    }, [insertEntry, entryType, onClose]);

    /** Insert a `SkinMeshDataProperties_MaterialOverride` entry into the
     *  current bin's `materialOverride: list[embed]`. Returns the modified
     *  string (does NOT write to the editor — caller stitches together
     *  override + snippet first so Ctrl+Z collapses both into one undo). */
    const applyOverrideEntry = useCallback((
        content: string,
        path: string,
        submesh: string,
        type: 'texture' | 'material',
    ): string => {
        let lines = content.split('\n');
        if (!content.includes('materialOverride:')) {
            const next: string[] = [];
            let added = false;
            for (let i = 0; i < lines.length; i++) {
                next.push(lines[i]);
                if (
                    !added &&
                    lines[i].includes('skinMeshProperties:') &&
                    lines[i].includes('embed') &&
                    lines[i].includes('SkinMeshDataProperties')
                ) {
                    let indent = '        ';
                    if (i + 1 < lines.length) {
                        const m2 = lines[i + 1].match(/^(\s*)/);
                        if (m2) indent = m2[1];
                    }
                    next.push(`${indent}materialOverride: list[embed] = {`);
                    next.push(`${indent}}`);
                    added = true;
                }
            }
            lines = next;
        }

        let matIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('materialOverride:') && lines[i].includes('list[embed]')) {
                matIdx = i;
                break;
            }
        }
        if (matIdx === -1) return content;

        let depth = 0;
        let insertIdx = -1;
        for (let j = matIdx; j < lines.length; j++) {
            for (const c of lines[j]) {
                if (c === '{') depth++;
                else if (c === '}') depth--;
            }
            if (depth === 0 && j > matIdx) { insertIdx = j; break; }
        }
        if (insertIdx === -1) return content;

        let indent = '            ';
        if (matIdx + 1 < lines.length && lines[matIdx + 1].trim()) {
            const m2 = lines[matIdx + 1].match(/^(\s*)/);
            if (m2) indent = m2[1];
        }

        const propType = type === 'texture' ? 'string' : 'link';
        const propName = type === 'texture' ? 'texture' : 'material';
        const block = [
            `${indent}SkinMeshDataProperties_MaterialOverride {`,
            `${indent}    ${propName}: ${propType} = "${path}"`,
            `${indent}    Submesh: string = "${submesh}"`,
            `${indent}}`,
        ];

        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (i === insertIdx) out.push(...block);
            out.push(lines[i]);
        }
        return out.join('\n');
    }, []);

    /** Splice a StaticMaterialDef snippet into the bin's top-level
     *  entries map, anchored after the SkinCharacterDataProperties entry
     *  (or before ResourceResolver as a fallback). Stacks below any
     *  existing jadelib_* entries so multiple library inserts queue up
     *  in author order. */
    const injectMaterialDefSnippet = useCallback((content: string, snippetText: string): string => {
        const lines = content.split('\n');
        const entryRe = /^(\s*)("[^"]+"|0x[0-9a-fA-F]+)\s*=\s*(\w+)\s*\{/;
        type Entry = { start: number; end: number; indent: string; className: string };
        const entries: Entry[] = [];
        for (let i = 0; i < lines.length; i++) {
            const m = entryRe.exec(lines[i]);
            if (!m) continue;
            let depth = 0;
            let end = -1;
            for (let j = i; j < lines.length; j++) {
                for (const ch of lines[j]) {
                    if (ch === '{') depth++;
                    else if (ch === '}') depth--;
                }
                if (depth <= 0) { end = j; break; }
            }
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
            for (const e of entries) {
                if (e.start < insertIdx) continue;
                if (e.className !== 'StaticMaterialDef') break;
                const nameMatch = lines[e.start].match(/"(jadelib_[^"]+)"/);
                if (!nameMatch) break;
                insertIdx = e.end + 1;
            }
        } else {
            const res = entries.find(e => e.className === 'ResourceResolver');
            if (res) { insertIdx = res.start; anchorIndent = res.indent; }
        }

        if (insertIdx === -1) return content + '\n' + snippetText + '\n';

        const indented = snippetText
            .split('\n')
            .map(l => (l.length > 0 ? anchorIndent + l : l))
            .join('\n');
        return [
            ...lines.slice(0, insertIdx),
            indented,
            ...lines.slice(insertIdx),
        ].join('\n');
    }, []);

    const onSubmitWithLibrary = useCallback(async (
        _path: string,
        submesh: string,
        library: LibraryPairResult,
    ) => {
        // Full library-pairing flow: matches the classic GeneralEditPanel
        // flow exactly. Loads the cached snippet, auto-increments the
        // material name on collision, swaps the Diffuse_Texture
        // placeholder, applies BOTH the override entry and the snippet
        // in one editor update, and copies the library textures to the
        // user's mod folder.
        s.setStatusMessage(`Inserting ${library.materialName}…`);
        try {
            const snippet = await invoke<MaterialSnippet | null>('library_get_cached_material', {
                path: library.materialPath,
            });
            if (!snippet) {
                s.setStatusMessage(`Library material ${library.materialPath} not cached`);
                onClose();
                return;
            }

            // Uniquely name the material with a unix timestamp so the same
            // library material inserted into DIFFERENT mods never collides —
            // the game merges StaticMaterialDefs by name, so a shared name
            // would clobber and only one mod's material would apply.
            const finalName = uniqueMaterialName(snippet.materialName, editorContent());
            let snippetText = renameMaterialInSnippet(snippet.snippet, snippet.materialName, finalName);

            // Replace the Diffuse_Texture placeholder. Prefer the texture
            // the user picked in the dialog; fall back to SKN auto-resolve.
            if (library.texture) {
                const phRe = /(texturePath:\s*string\s*=\s*")[^"]*YOURCHAMP[^"]*(")/;
                snippetText = snippetText.replace(phRe, `$1${library.texture}$2`);
            } else if (filePath) {
                const simpleSkinPath = extractFirst('simpleSkin');
                const texturePath = extractFirst('texture');
                if (simpleSkinPath && texturePath) {
                    try {
                        const matchModeStr = await invoke<string>('get_preference', {
                            key: 'MaterialMatchMode', defaultValue: '3',
                        });
                        const matchMode = parseInt(matchModeStr, 10) || 3;
                        const result = await invoke<AutoMaterialResult>('auto_material_override', {
                            binFilePath: filePath, simpleSkinPath, texturePath, matchMode,
                        });
                        const submeshLower = submesh.toLowerCase();
                        const matched = result.matches.find(mm => mm.material.toLowerCase() === submeshLower);
                        if (matched && matched.texture) {
                            const fbRe = /(texturePath:\s*string\s*=\s*")[^"]*YOURCHAMP[^"]*(")/g;
                            snippetText = snippetText.replace(fbRe, `$1${matched.texture}$2`);
                        }
                    } catch (e) {
                        console.warn('SKN auto-resolve failed:', e);
                    }
                }
            }

            // Single editor update so override + snippet undo as one step.
            let next = editorContent();
            next = applyOverrideEntry(next, finalName, submesh, 'material');
            next = injectMaterialDefSnippet(next, snippetText);
            s.handleGeneralEditContentChange(next);

            // Copy the library's textures next to the bin so the embedded
            // assets/jadelib/<id>/<file> paths actually resolve on disk.
            try {
                const modInfo = await invoke<{ mod_root: string | null }>(
                    'library_detect_mod_folder',
                    { binPath: filePath },
                );
                if (modInfo.mod_root) {
                    const copied = await invoke<string[]>('library_copy_textures_to_mod', {
                        materialPath: library.materialPath,
                        modRoot: modInfo.mod_root,
                    });
                    if (filePath) s.recordJadelibInsert(filePath, modInfo.mod_root, snippet.id);
                    s.setStatusMessage(
                        `Inserted ${finalName} · copied ${copied.length} texture${copied.length === 1 ? '' : 's'} to assets/jadelib/${snippet.id}/`,
                    );
                } else {
                    s.setStatusMessage(
                        `Inserted ${finalName} — couldn't find a mod root (need META/info.json, a WAD/ folder, or DATA + ASSETS siblings). Textures not copied.`,
                    );
                }
            } catch (e) {
                console.warn('Texture copy failed:', e);
                s.setStatusMessage(`Inserted ${finalName} (texture copy failed: ${e})`);
            }
        } catch (e) {
            console.error('Library insert failed:', e);
            s.setStatusMessage(`Library insert failed: ${e}`);
        }
        onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, applyOverrideEntry, injectMaterialDefSnippet, onClose]);

    return (
        <MaterialOverrideDockPanel
            type={entryType}
            defaultPath={defaultPath}
            suggestions={suggestions}
            detectedTextures={detectedTextures}
            binFilePath={filePath}
            onSubmit={onSubmit}
            onSubmitWithLibrary={onSubmitWithLibrary}
            onCancel={onClose}
        />
    );
}
