import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Clapperboard } from 'lucide-react';
import { getAudioIconForFileName } from './FormatIcons';
import { texBufferToDataURL, ddsBufferToDataURL } from '../lib/texFormat';
import './AssetGalleryDialog.css';

interface AssetGalleryDialogProps {
  /** Raw markdown content of the asset-list report. */
  content: string;
  /** The report's own file path (often null for in-memory reports); used
   *  as a base for `resolve_asset_path` when the user-opened mod root
   *  isn't otherwise reachable. We fall back to the mod root the report
   *  embeds as `Mod root: \`...\`` in its header. */
  baseFile: string | null;
  onClose: () => void;
}

interface AssetEntry {
  /** Path as it appears in the BIN — `assets/...` / `data/...`. */
  path: string;
  /** BIN labels (per-BIN sections) that referenced this asset. Empty
   *  for `kind === 'unused'`. */
  bins: string[];
  /** Where this entry came from: a `## \`label\`` section ('referenced')
   *  or the `## Unused files` section ('unused'). */
  kind: 'referenced' | 'unused';
  /** Pre-resolved size in bytes for unused entries (parsed from the
   *  trailing `_(N KB)_`); 0 for referenced entries. */
  sizeBytes: number;
}

const IMAGE_EXTS = ['.tex', '.dds', '.png', '.jpg', '.jpeg', '.bmp', '.webp'];
const PREVIEW_MAX_DIM = 256;

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Parse the markdown body into entries + mod-root metadata. */
function parseReport(md: string): {
  entries: AssetEntry[];
  modRoot: string | null;
} {
  const lines = md.split('\n');
  const byPathReferenced = new Map<string, string[]>();
  const unused: AssetEntry[] = [];
  let currentBin: string | null = null;
  let inUnusedSection = false;
  let modRoot: string | null = null;
  const binHeader = /^##\s+`([^`]+)`/;
  const unusedHeader = /^##\s+Unused files/i;
  const assetLine = /^-\s+"([^"]+)"\s*(?:_\(([^)]+)\)_)?/;
  const modRootHeader = /^Mod root:\s+`([^`]+)`/;

  const parseSizeFromTag = (tag: string): number => {
    // Reverse of the formatter above: "N KB" / "N MB" / "N B".
    const m = /^([\d.]+)\s*(B|KB|MB|GB)$/i.exec(tag.trim());
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return 0;
    const unit = m[2].toUpperCase();
    return unit === 'GB' ? Math.round(n * 1024 * 1024 * 1024)
      : unit === 'MB' ? Math.round(n * 1024 * 1024)
      : unit === 'KB' ? Math.round(n * 1024)
      : Math.round(n);
  };

  for (const line of lines) {
    const mr = modRootHeader.exec(line);
    if (mr) { modRoot = mr[1]; continue; }
    if (unusedHeader.test(line)) {
      inUnusedSection = true;
      currentBin = null;
      continue;
    }
    const bh = binHeader.exec(line);
    if (bh) {
      inUnusedSection = false;
      currentBin = bh[1];
      continue;
    }
    const al = assetLine.exec(line);
    if (al) {
      const path = al[1];
      if (inUnusedSection) {
        unused.push({
          path,
          bins: [],
          kind: 'unused',
          sizeBytes: al[2] ? parseSizeFromTag(al[2]) : 0,
        });
      } else {
        const list = byPathReferenced.get(path) ?? [];
        if (currentBin && !list.includes(currentBin)) list.push(currentBin);
        byPathReferenced.set(path, list);
      }
    }
  }

  const referenced: AssetEntry[] = Array.from(byPathReferenced.entries())
    .map(([path, bins]) => ({ path, bins, kind: 'referenced' as const, sizeBytes: 0 }));

  // Stable ordering: referenced alphabetical; unused already came in
  // big-first from Rust, preserve that.
  referenced.sort((a, b) => a.path.localeCompare(b.path));

  return { entries: [...referenced, ...unused], modRoot };
}

interface Thumb {
  dataUrl: string | null;
  error: string | null;
  resolvedPath: string | null;
}

type FilterMode = 'all' | 'images' | 'unused';

export default function AssetGalleryDialog({ content, baseFile, onClose }: AssetGalleryDialogProps) {
  const { entries, modRoot } = useMemo(() => parseReport(content), [content]);
  const [thumbs, setThumbs] = useState<Map<string, Thumb>>(new Map());
  const [filterText, setFilterText] = useState('');
  const [mode, setMode] = useState<FilterMode>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteSummary, setDeleteSummary] = useState<string | null>(null);

  // Base file for `resolve_asset_path`. Prefer the report tab's own
  // file path; fall back to a sentinel inside the parsed mod root.
  const effectiveBase = baseFile || (modRoot ? `${modRoot}/dummy.bin` : null);

  // Decode thumbnails for image-typed entries (both referenced and
  // unused). Throttle so big mods don't fire hundreds of reads at once.
  useEffect(() => {
    let cancelled = false;
    if (!effectiveBase) return;
    const imageEntries = entries.filter(e => {
      const lower = e.path.toLowerCase();
      const ext = lower.slice(lower.lastIndexOf('.'));
      return IMAGE_EXTS.includes(ext);
    });
    const queue = [...imageEntries];
    const consume = async () => {
      while (!cancelled && queue.length > 0) {
        const batch = queue.splice(0, 8);
        await Promise.all(batch.map(async (e) => {
          if (cancelled) return;
          try {
            const resolved: string | null = await invoke('resolve_asset_path', {
              baseFile: effectiveBase, assetPath: e.path,
            });
            if (!resolved) {
              setThumbs(prev => {
                const next = new Map(prev);
                next.set(e.path, { dataUrl: null, error: 'not found', resolvedPath: null });
                return next;
              });
              return;
            }
            const lower = resolved.toLowerCase();
            const ext = lower.slice(lower.lastIndexOf('.'));
            let dataUrl: string | null = null;
            if (ext === '.tex') {
              const bytes = b64ToBytes(await invoke<string>('read_file_base64', { path: resolved }));
              dataUrl = texBufferToDataURL(bytes.buffer, PREVIEW_MAX_DIM).dataURL;
            } else if (ext === '.dds') {
              const bytes = b64ToBytes(await invoke<string>('read_file_base64', { path: resolved }));
              dataUrl = ddsBufferToDataURL(bytes.buffer, PREVIEW_MAX_DIM).dataURL;
            } else {
              const b64 = await invoke<string>('read_file_base64', { path: resolved });
              const mime = ext === '.png' ? 'image/png'
                : ext === '.bmp' ? 'image/bmp'
                : ext === '.webp' ? 'image/webp'
                : 'image/jpeg';
              dataUrl = `data:${mime};base64,${b64}`;
            }
            if (cancelled) return;
            setThumbs(prev => {
              const next = new Map(prev);
              next.set(e.path, { dataUrl, error: null, resolvedPath: resolved });
              return next;
            });
          } catch (err) {
            if (cancelled) return;
            setThumbs(prev => {
              const next = new Map(prev);
              next.set(e.path, { dataUrl: null, error: String(err), resolvedPath: null });
              return next;
            });
          }
        }));
      }
    };
    void consume();
    return () => { cancelled = true; };
  }, [entries, effectiveBase]);

  const unusedEntries = useMemo(() => entries.filter(e => e.kind === 'unused'), [entries]);
  const filtered = useMemo(() => {
    let arr = entries;
    if (mode === 'unused') arr = unusedEntries;
    else if (mode === 'images') {
      arr = arr.filter(e => {
        const lower = e.path.toLowerCase();
        const ext = lower.slice(lower.lastIndexOf('.'));
        return IMAGE_EXTS.includes(ext);
      });
    }
    const q = filterText.trim().toLowerCase();
    if (q) arr = arr.filter(e => e.path.toLowerCase().includes(q));
    return arr;
  }, [entries, unusedEntries, mode, filterText]);

  const toggleSelect = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const selectAllUnusedVisible = () => {
    const visibleUnused = filtered.filter(e => e.kind === 'unused').map(e => e.path);
    setSelected(prev => {
      const next = new Set(prev);
      const allOn = visibleUnused.every(p => next.has(p));
      if (allOn) visibleUnused.forEach(p => next.delete(p));
      else visibleUnused.forEach(p => next.add(p));
      return next;
    });
  };

  // For deletion we need the absolute paths from the original entries
  // (the parser kept the relative path only; we re-derive abs by
  // walking the entries again here, but unused entries carry no
  // abs… we hold it in a side-map built from the markdown lines).
  // Simpler: re-parse the unused section keeping abs paths via the
  // resolve_asset_path call on demand at delete time.

  const handleDelete = async () => {
    if (!modRoot) {
      setDeleteSummary('Cannot delete — no mod root parsed from the report.');
      return;
    }
    setDeleting(true);
    try {
      // Resolve every selected path to its absolute disk location.
      // We do this at delete time rather than caching at parse time
      // so the user can't accidentally hit a stale path.
      const baseForResolve = effectiveBase || `${modRoot}/dummy.bin`;
      const resolvedTargets: string[] = [];
      for (const p of selected) {
        // Prefer the path we already resolved during thumbnail decode
        // — saves a round-trip and keeps non-image unused files
        // working even though they have no thumb.
        const cached = thumbs.get(p)?.resolvedPath;
        if (cached) { resolvedTargets.push(cached); continue; }
        try {
          const r = await invoke<string | null>('resolve_asset_path', {
            baseFile: baseForResolve, assetPath: p,
          });
          if (r) resolvedTargets.push(r);
        } catch { /* skip */ }
      }
      if (resolvedTargets.length === 0) {
        setDeleteSummary('Nothing to delete — paths could not be resolved.');
        setConfirmOpen(false);
        setDeleting(false);
        return;
      }
      const result = await invoke<{ deleted: number; failed: [string, string][] }>(
        'delete_files', { modRoot, paths: resolvedTargets }
      );
      const failedCount = result.failed.length;
      setDeleteSummary(
        failedCount === 0
          ? `Deleted ${result.deleted} file${result.deleted === 1 ? '' : 's'}.`
          : `Deleted ${result.deleted}, ${failedCount} failed.`
      );
      // Drop the successfully-deleted paths from selection and from
      // the thumbnail map. We don't know which exactly succeeded, so
      // remove every selected entry whose resolved path was not in the
      // failed list.
      const failedSet = new Set(result.failed.map(([p]) => p));
      setSelected(prev => {
        const next = new Set<string>();
        for (const p of prev) {
          const resolved = thumbs.get(p)?.resolvedPath;
          if (resolved && failedSet.has(resolved)) next.add(p);
        }
        return next;
      });
      setConfirmOpen(false);
    } catch (err) {
      setDeleteSummary(`Delete failed: ${String(err)}`);
    } finally {
      setDeleting(false);
    }
  };

  const selectedUnusedCount = Array.from(selected).filter(p => {
    const e = entries.find(x => x.path === p);
    return e?.kind === 'unused';
  }).length;
  const totalSelectedSize = Array.from(selected).reduce((sum, p) => {
    const e = entries.find(x => x.path === p);
    return sum + (e?.sizeBytes ?? 0);
  }, 0);

  return (
    <div className="asset-gallery-overlay" onClick={onClose}>
      <div className="asset-gallery-modal" onClick={e => e.stopPropagation()}>
        <div className="asset-gallery-header">
          <span>Asset gallery</span>
          <div className="asset-gallery-modes">
            <button
              className={`asset-gallery-mode${mode === 'all' ? ' on' : ''}`}
              onClick={() => setMode('all')}
            >All ({entries.length})</button>
            <button
              className={`asset-gallery-mode${mode === 'images' ? ' on' : ''}`}
              onClick={() => setMode('images')}
            >Images</button>
            <button
              className={`asset-gallery-mode${mode === 'unused' ? ' on' : ''}`}
              onClick={() => setMode('unused')}
            >Unused ({unusedEntries.length})</button>
          </div>
          <input
            type="search"
            className="asset-gallery-filter"
            placeholder="Filter…"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
          />
          <button className="asset-gallery-close" onClick={onClose}>×</button>
        </div>

        {selected.size > 0 && (
          <div className="asset-gallery-actions">
            <span className="asset-gallery-actions-info">
              {selected.size} selected{selectedUnusedCount !== selected.size && ` (${selectedUnusedCount} unused)`}
              {totalSelectedSize > 0 && ` · ${humanSize(totalSelectedSize)}`}
            </span>
            <button
              className="asset-gallery-actions-btn"
              onClick={() => setSelected(new Set())}
            >Clear</button>
            <button
              className="asset-gallery-actions-btn asset-gallery-actions-btn--danger"
              onClick={() => setConfirmOpen(true)}
              disabled={selectedUnusedCount === 0}
              title={selectedUnusedCount === 0
                ? 'Only files in the "Unused" set can be deleted'
                : `Delete ${selectedUnusedCount} unused file${selectedUnusedCount === 1 ? '' : 's'} from disk`}
            >Delete {selectedUnusedCount > 0 ? selectedUnusedCount : ''} unused</button>
          </div>
        )}

        {mode === 'unused' && unusedEntries.length > 0 && (
          <div className="asset-gallery-actions">
            <span className="asset-gallery-actions-info">
              Bulk: select all unused currently visible
            </span>
            <button className="asset-gallery-actions-btn" onClick={selectAllUnusedVisible}>
              Toggle all visible
            </button>
          </div>
        )}

        {deleteSummary && (
          <div className="asset-gallery-summary">
            {deleteSummary}
            <button className="asset-gallery-summary-x" onClick={() => setDeleteSummary(null)}>×</button>
          </div>
        )}

        <div className="asset-gallery-body">
          {filtered.length === 0 && (
            <div className="asset-gallery-empty">
              {mode === 'unused' ? 'No unused files.' : 'No entries match.'}
            </div>
          )}
          <div className="asset-gallery-grid">
            {filtered.map(entry => {
              const t = thumbs.get(entry.path);
              const isSelected = selected.has(entry.path);
              const isImage = (() => {
                const lower = entry.path.toLowerCase();
                const ext = lower.slice(lower.lastIndexOf('.'));
                return IMAGE_EXTS.includes(ext);
              })();
              return (
                <div
                  key={entry.path}
                  className={`asset-gallery-cell${isSelected ? ' selected' : ''}${entry.kind === 'unused' ? ' unused' : ''}`}
                  title={entry.path}
                  onClick={() => toggleSelect(entry.path)}
                >
                  <div className="asset-gallery-cell-check">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(entry.path)}
                      onClick={e => e.stopPropagation()}
                    />
                  </div>
                  {entry.kind === 'unused' && (
                    <div className="asset-gallery-cell-tag">UNUSED</div>
                  )}
                  <div className="asset-gallery-thumb">
                    {!isImage ? (() => {
                      const ext = entry.path.slice(entry.path.lastIndexOf('.')).toLowerCase();
                      const baseName = entry.path.split('/').slice(-1)[0];
                      // Animation files get a clapperboard mark with
                      // the extension underneath — distinguishable at
                      // a glance from mesh / generic asset placeholders.
                      if (ext === '.anm') {
                        return (
                          <div className="asset-gallery-thumb-typed">
                            <Clapperboard size={36} strokeWidth={1.5} />
                            <div className="asset-gallery-thumb-typed-label">.anm</div>
                          </div>
                        );
                      }
                      // Audio containers — VO audio, SFX events, etc.
                      // — pick a role-specific Lucide icon from the
                      // shared `getAudioIconForFileName` helper so the
                      // extractor and the gallery agree on glyphs.
                      const AudioIcon = getAudioIconForFileName(baseName);
                      if (AudioIcon) {
                        return (
                          <div className="asset-gallery-thumb-typed">
                            <AudioIcon size={36} strokeWidth={1.5} />
                            <div className="asset-gallery-thumb-typed-label">{ext}</div>
                          </div>
                        );
                      }
                      return (
                        <div className="asset-gallery-thumb-loading">{ext}</div>
                      );
                    })() : t?.dataUrl ? (
                      <img src={t.dataUrl} alt={entry.path} />
                    ) : t?.error ? (
                      <div className="asset-gallery-thumb-error">{t.error}</div>
                    ) : (
                      <div className="asset-gallery-thumb-loading">…</div>
                    )}
                  </div>
                  <div className="asset-gallery-meta">
                    <div className="asset-gallery-path">{entry.path.split('/').slice(-1)[0]}</div>
                    <div className="asset-gallery-bins">
                      {entry.kind === 'unused'
                        ? (entry.sizeBytes > 0 ? humanSize(entry.sizeBytes) : 'unreferenced')
                        : `${entry.bins.length} BIN${entry.bins.length === 1 ? '' : 's'}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {confirmOpen && (
          <div className="asset-gallery-confirm-overlay" onClick={() => !deleting && setConfirmOpen(false)}>
            <div className="asset-gallery-confirm" onClick={e => e.stopPropagation()}>
              <h3>Delete unused files?</h3>
              <p>
                This will permanently remove {selectedUnusedCount} file{selectedUnusedCount === 1 ? '' : 's'} from disk
                {totalSelectedSize > 0 && ` (${humanSize(totalSelectedSize)})`}. This cannot be undone.
              </p>
              <div className="asset-gallery-confirm-list">
                {Array.from(selected)
                  .filter(p => entries.find(e => e.path === p)?.kind === 'unused')
                  .slice(0, 12)
                  .map(p => (
                    <div key={p} className="asset-gallery-confirm-line">{p}</div>
                  ))}
                {selectedUnusedCount > 12 && (
                  <div className="asset-gallery-confirm-more">+ {selectedUnusedCount - 12} more…</div>
                )}
              </div>
              <div className="asset-gallery-confirm-actions">
                <button onClick={() => setConfirmOpen(false)} disabled={deleting}>Cancel</button>
                <button
                  className="asset-gallery-confirm-delete"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : `Delete ${selectedUnusedCount}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
