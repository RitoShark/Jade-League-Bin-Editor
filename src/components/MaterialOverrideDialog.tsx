import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { texBufferToDataURL, ddsBufferToDataURL } from '../lib/texFormat';
import './MaterialOverrideDialog.css';

const PREVIEW_MAX_DIM = 256;
const BROWSER_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.webp'];

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface MaterialSuggestion {
  material: string;
  texture: string;
}

// Mirrors library_commands.rs
interface LibraryIndexEntry {
  id: string;
  path: string;
  name: string;
  category: string;
  champion: string | null;
  skin: string | null;
  description: string;
  tags: string[];
  hasPreview: boolean;
  userSlots: string[];
  featured: boolean;
  version: number;
  updatedAt: string;
  materialName: string | null;
}
interface LibraryIndex {
  schemaVersion: number;
  lastUpdated: string;
  categories: { id: string; name: string }[];
  champions: string[];
  materials: LibraryIndexEntry[];
}
interface DownloadedMaterialInfo {
  id: string;
  path: string;
  name: string;
  category: string;
  version: number;
  sizeBytes: number;
  hasPreview: boolean;
  previewPath: string | null;
}

export interface LibraryPairResult {
  materialId: string;
  materialPath: string;
  materialName: string; // jadelib_<id> the override should link to
  texture: string; // texture path to put in the override entry
}

interface MaterialOverrideDialogProps {
  type: 'texture' | 'material';
  defaultPath: string;
  onSubmit: (path: string, submesh: string) => void;
  /** Called instead of onSubmit when the user picked a library material to pair with. */
  onSubmitWithLibrary?: (
    path: string,
    submesh: string,
    library: LibraryPairResult
  ) => void;
  onCancel: () => void;
  suggestions?: MaterialSuggestion[];
  /** Every texture detected in the skin's texture folder. Used by the
   *  manual-match mode so the user can pick any texture, not just the
   *  auto-matched one. */
  detectedTextures?: string[];
  /** Bin file path — used to resolve asset-relative texture paths for
   *  the hover preview. */
  binFilePath?: string;
}

export default function MaterialOverrideDialog({
  type,
  defaultPath,
  onSubmit,
  onSubmitWithLibrary,
  onCancel,
  suggestions,
  detectedTextures,
  binFilePath,
}: MaterialOverrideDialogProps) {
  // Only default the path for texture entries (where it's an asset path).
  // For material entries, leave blank so the user fills it themselves.
  const [path, setPath] = useState(type === 'texture' ? defaultPath : '');
  const [submesh, setSubmesh] = useState('');
  const [texture, setTexture] = useState('');
  const [error, setError] = useState('');
  // Tracks whether the user manually clicked a texture. Once manual,
  // picking another submesh won't override their choice.
  const [textureLocked, setTextureLocked] = useState(false);
  const [previewCache, setPreviewCache] = useState<Record<string, string | null>>({});
  const [hoverTexture, setHoverTexture] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ top: number; left: number } | null>(null);
  const inflightRef = useRef<Set<string>>(new Set());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);

  // Compute the dropdown menu's fixed position from the trigger's
  // bounding rect. Using position:fixed lets the menu render above
  // the dialog and escape its `overflow: hidden` clip. Flips up when
  // there isn't enough room below (small/scaled viewports).
  const computeMenuStyle = (): React.CSSProperties | null => {
    if (!dropdownRef.current) return null;
    const rect = dropdownRef.current.getBoundingClientRect();
    const menuMaxHeight = 180;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < menuMaxHeight + gap && spaceAbove > spaceBelow;

    if (openUpward) {
      return {
        position: 'fixed',
        top: 'auto',
        bottom: window.innerHeight - rect.top + gap,
        left: rect.left,
        right: 'auto',
        width: rect.width,
        maxHeight: Math.max(120, Math.min(menuMaxHeight, spaceAbove - gap - 8)),
      };
    }
    return {
      position: 'fixed',
      top: rect.bottom + gap,
      bottom: 'auto',
      left: rect.left,
      right: 'auto',
      width: rect.width,
      maxHeight: Math.max(120, Math.min(menuMaxHeight, spaceBelow - gap - 8)),
    };
  };

  const openDropdown = () => {
    setMenuStyle(computeMenuStyle());
    setDropdownOpen(true);
  };

  // Re-anchor the menu on window resize so it follows the trigger.
  useEffect(() => {
    if (!dropdownOpen) return;
    const reposition = () => setMenuStyle(computeMenuStyle());
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [dropdownOpen]);

  // Close the custom dropdown on outside click. Menu is rendered via a
  // portal into document.body, so we check both the trigger wrapper AND
  // any `.mod-lib-dropdown-menu` element for containment.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownRef.current?.contains(target)) return;
      const menu = document.querySelector('.mod-lib-dropdown-menu');
      if (menu?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [dropdownOpen]);

  // Load a preview for the given asset-relative texture path. Results
  // are cached; `null` means "failed to load, don't retry".
  const ensurePreview = async (assetPath: string) => {
    if (!binFilePath) return;
    if (assetPath in previewCache) return;
    if (inflightRef.current.has(assetPath)) return;
    inflightRef.current.add(assetPath);
    try {
      const resolved: string | null = await invoke('resolve_asset_path', {
        baseFile: binFilePath,
        assetPath,
      });
      if (!resolved) {
        setPreviewCache((prev) => ({ ...prev, [assetPath]: null }));
        return;
      }
      const ext = assetPath.toLowerCase().slice(assetPath.lastIndexOf('.'));
      const b64: string = await invoke('read_file_base64', { path: resolved });
      let dataURL: string | null = null;

      if (ext === '.tex') {
        const bytes = b64ToBytes(b64);
        dataURL = texBufferToDataURL(bytes.buffer, PREVIEW_MAX_DIM).dataURL;
      } else if (ext === '.dds') {
        const bytes = b64ToBytes(b64);
        dataURL = ddsBufferToDataURL(bytes.buffer, PREVIEW_MAX_DIM).dataURL;
      } else if (BROWSER_IMAGE_EXTS.includes(ext)) {
        const mime = ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
        dataURL = `data:${mime};base64,${b64}`;
      }
      setPreviewCache((prev) => ({ ...prev, [assetPath]: dataURL }));
    } catch {
      setPreviewCache((prev) => ({ ...prev, [assetPath]: null }));
    } finally {
      inflightRef.current.delete(assetPath);
    }
  };

  const handleTextureEnter = (tex: string, e: React.MouseEvent) => {
    setHoverTexture(tex);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHoverPos({ top: rect.top, left: rect.right + 8 });
    ensurePreview(tex);
  };

  const handleTextureLeave = () => {
    setHoverTexture(null);
    setHoverPos(null);
  };

  // ── Library pairing state (only used for `type === 'material'`) ──
  const [libraryEnabled, setLibraryEnabled] = useState(false);
  const [libraryIndex, setLibraryIndex] = useState<LibraryIndex | null>(null);
  const [downloaded, setDownloaded] = useState<DownloadedMaterialInfo[]>([]);
  const [selectedLibPath, setSelectedLibPath] = useState<string>('');
  const [libraryError, setLibraryError] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // Load library data lazily — only when the section is expanded
  useEffect(() => {
    if (!libraryEnabled || libraryIndex) return;
    (async () => {
      try {
        const cached = await invoke<LibraryIndex | null>('library_get_cached_index');
        if (cached) setLibraryIndex(cached);
        const d = await invoke<DownloadedMaterialInfo[]>('library_list_downloaded');
        setDownloaded(d);
      } catch (e) {
        setLibraryError(typeof e === 'string' ? e : String(e));
      }
    })();
  }, [libraryEnabled, libraryIndex]);

  const downloadedPaths = useMemo(
    () => new Set(downloaded.map((d) => d.path)),
    [downloaded]
  );

  // List for the selector: downloaded materials only. Featured-not-downloaded
  // materials are available via the full Material Library browser.
  const selectorItems = useMemo(() => {
    if (!libraryIndex) return [] as LibraryIndexEntry[];
    return libraryIndex.materials.filter((m) => downloadedPaths.has(m.path));
  }, [libraryIndex, downloadedPaths]);

  const selectedEntry = useMemo(
    () => libraryIndex?.materials.find((m) => m.path === selectedLibPath) ?? null,
    [libraryIndex, selectedLibPath],
  );

  // When the user picks a library material, auto-fill the Material Name
  // field with the library material's name (e.g. "jadelib_toon_shading").
  // This was the old auto-populate we had removed for the general case,
  // but for library pairing the name must match the StaticMaterialDef's
  // entry key — so filling it automatically is the correct behavior.
  useEffect(() => {
    if (!selectedLibPath || type !== 'material') return;
    const entry = libraryIndex?.materials.find((m) => m.path === selectedLibPath);
    const materialName =
      entry?.materialName || `jadelib_${(entry?.id || selectedLibPath).replace(/-/g, '_')}`;
    setPath(materialName);
  }, [selectedLibPath, type, libraryIndex]);

  // Picking a submesh fills its auto-matched texture — but only if the
  // user hasn't manually clicked a texture yet. After that, the texture
  // is locked to their choice.
  const applySuggestion = (s: MaterialSuggestion) => {
    setSubmesh(s.material);
    if (textureLocked) return;
    if (type === 'texture' && s.texture) {
      setPath(s.texture);
    } else if (type === 'material' && s.texture) {
      setTexture(s.texture);
    }
  };

  // Picking a texture locks it — subsequent submesh picks won't overwrite.
  const applyDetectedTexture = (tex: string) => {
    if (type === 'texture') setPath(tex);
    else setTexture(tex);
    setTextureLocked(true);
  };

  const textureValueForHighlight =
    type === 'texture' ? path : texture;

  const handleSubmit = async () => {
    const trimmedPath = path.trim();
    const trimmedSubmesh = submesh.trim();

    if (!trimmedPath) {
      setError('Path cannot be empty');
      return;
    }
    if (!trimmedSubmesh) {
      setError('Submesh cannot be empty');
      return;
    }

    // Library pairing path
    if (libraryEnabled && selectedLibPath && onSubmitWithLibrary) {
      setBusy(true);
      try {
        if (!downloadedPaths.has(selectedLibPath)) {
          await invoke('library_fetch_material', { path: selectedLibPath });
        }
        const entry = libraryIndex?.materials.find((m) => m.path === selectedLibPath);
        const materialName =
          entry?.materialName ||
          `jadelib_${(entry?.id || selectedLibPath).replace(/-/g, '_')}`;
        onSubmitWithLibrary(trimmedPath, trimmedSubmesh, {
          materialId: entry?.id || selectedLibPath,
          materialPath: selectedLibPath,
          materialName,
          texture: texture.trim(),
        });
      } catch (e) {
        setError(`Failed to fetch library material: ${e}`);
        setBusy(false);
        return;
      }
      setBusy(false);
      return;
    }

    onSubmit(trimmedPath, trimmedSubmesh);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    else if (e.key === 'Escape') onCancel();
  };

  const title = type === 'texture' ? 'Add Texture Entry' : 'Add Material Entry';
  const pathLabel = type === 'texture' ? 'Texture Path' : 'Material name';
  const hasSuggestions = suggestions && suggestions.length > 0;

  return (
    <div className="mod-overlay" onClick={onCancel}>
      <div className="mod-dialog" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="mod-header">
          <span className="mod-title">{title}</span>
          <button
            className="mod-close-btn"
            onClick={onCancel}
            title="Cancel (Escape)"
          />
        </div>

        <div className="mod-content">
          {(hasSuggestions || (detectedTextures && detectedTextures.length > 0)) && (
            <div className="mod-field mod-sources-card">
              {hasSuggestions && (
                <div className="mod-sources-section">
                  <label className="mod-label">Submeshes from SKN</label>
                  <div className="mod-pill-list">
                    {suggestions!.map((s, i) => (
                      <button
                        key={i}
                        className={`mod-suggestion ${submesh === s.material ? 'active' : ''}`}
                        onClick={() => applySuggestion(s)}
                        title={s.texture || 'No texture match'}
                      >
                        <span className="mod-suggestion-name">{s.material}</span>
                        {s.texture ? (
                          <span className="mod-suggestion-match">matched</span>
                        ) : (
                          <span className="mod-suggestion-nomatch">no match</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {hasSuggestions && detectedTextures && detectedTextures.length > 0 && (
                <div className="mod-sources-divider" />
              )}

              {detectedTextures && detectedTextures.length > 0 && (
                <div className="mod-sources-section">
                  <label className="mod-label">Textures from folder</label>
                  <div className="mod-pill-list">
                    {detectedTextures.map((tex) => {
                      const name = tex.split('/').pop() || tex;
                      const active = textureValueForHighlight.toLowerCase() === tex.toLowerCase();
                      return (
                        <button
                          key={tex}
                          type="button"
                          className={`mod-suggestion ${active ? 'active' : ''}`}
                          onClick={() => applyDetectedTexture(tex)}
                          onMouseEnter={(e) => handleTextureEnter(tex, e)}
                          onMouseLeave={handleTextureLeave}
                        >
                          <span className="mod-suggestion-name">{name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mod-field">
            <label className="mod-label">{pathLabel}</label>
            <input
              type="text"
              className={`mod-input mod-input-path ${libraryEnabled && selectedLibPath ? 'mod-input-readonly' : ''}`}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={pathLabel}
              autoFocus={!hasSuggestions}
              title={path}
              readOnly={libraryEnabled && !!selectedLibPath}
            />
          </div>

          <div className="mod-field">
            <label className="mod-label">Submesh name</label>
            <input
              type="text"
              className="mod-input"
              value={submesh}
              onChange={(e) => setSubmesh(e.target.value)}
              placeholder="Submesh name"
            />
          </div>

          {/* ── Texture field (shown when pairing with library material) ── */}
          {type === 'material' && libraryEnabled && (
            <div className="mod-field">
              <label className="mod-label">Texture Path</label>
              <input
                type="text"
                className="mod-input mod-input-path"
                value={texture}
                onChange={(e) => setTexture(e.target.value)}
                placeholder="Texture Path"
                title={texture}
              />
            </div>
          )}

          {/* ── Library pairing (only for material entries) ── */}
          {type === 'material' && onSubmitWithLibrary && (
            <div className="mod-library-section">
              <label className="mod-library-toggle">
                <input
                  type="checkbox"
                  checked={libraryEnabled}
                  onChange={(e) => {
                    setLibraryEnabled(e.target.checked);
                    if (!e.target.checked) setSelectedLibPath('');
                  }}
                />
                <span>Pair with Library Material</span>
              </label>

              {libraryEnabled && (
                <div className="mod-library-body">
                  {libraryError && (
                    <div className="mod-library-error">{libraryError}</div>
                  )}

                  {!libraryIndex && !libraryError && (
                    <div className="mod-library-empty">Loading library…</div>
                  )}

                  {libraryIndex && selectorItems.length === 0 && (
                    <div className="mod-library-empty">
                      No materials available. Open the Material Library to download some.
                    </div>
                  )}

                  {libraryIndex && selectorItems.length === 0 && downloaded.length === 0 && null}

                  {selectorItems.length > 0 && (
                    <div className="mod-lib-dropdown" ref={dropdownRef}>
                      <button
                        type="button"
                        className={`mod-lib-dropdown-trigger ${dropdownOpen ? 'open' : ''}`}
                        onClick={() => dropdownOpen ? setDropdownOpen(false) : openDropdown()}
                      >
                        <span className="mod-lib-dropdown-value">
                          {selectedEntry ? (
                            <>
                              <span className="mod-lib-dropdown-name">{selectedEntry.name}</span>
                              <span className="mod-lib-dropdown-version">v{selectedEntry.version}</span>
                            </>
                          ) : (
                            <span className="mod-lib-dropdown-placeholder">Select a material…</span>
                          )}
                        </span>
                        <svg className="mod-lib-dropdown-chevron" width="12" height="8" viewBox="0 0 12 8" fill="none">
                          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      {dropdownOpen && menuStyle && createPortal(
                        <div className="mod-lib-dropdown-menu" style={menuStyle}>
                          {selectorItems.map((entry) => {
                            const active = entry.path === selectedLibPath;
                            return (
                              <button
                                key={entry.path}
                                type="button"
                                className={`mod-lib-dropdown-item ${active ? 'active' : ''}`}
                                onClick={() => {
                                  setSelectedLibPath(entry.path);
                                  setDropdownOpen(false);
                                }}
                              >
                                <span className="mod-lib-dropdown-name">{entry.name}</span>
                                <span className="mod-lib-dropdown-version">v{entry.version}</span>
                              </button>
                            );
                          })}
                        </div>,
                        document.body
                      )}
                    </div>
                  )}

                  {selectedLibPath && (
                    <p className="mod-library-hint">
                      Insert will add both the override entry and the full{' '}
                      <code>StaticMaterialDef</code> from{' '}
                      <code>{selectedLibPath}</code>.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mod-error">{error}</div>
        )}

        <div className="mod-actions">
          <button className="mod-btn mod-btn-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="mod-btn mod-btn-accept" onClick={handleSubmit} disabled={busy}>
            {busy ? 'Working…' : 'Accept'}
          </button>
        </div>
      </div>

      {/* Texture hover preview — floats over everything, viewport-positioned */}
      {hoverTexture && hoverPos && (() => {
        const cached = previewCache[hoverTexture];
        return (
          <div
            className="mod-texture-preview"
            style={{ top: hoverPos.top, left: hoverPos.left }}
          >
            {cached === undefined ? (
              <div className="mod-texture-preview-status">Loading…</div>
            ) : cached === null ? (
              <div className="mod-texture-preview-status">No preview available</div>
            ) : (
              <img src={cached} alt="" />
            )}
            <div className="mod-texture-preview-path">
              {hoverTexture.split('/').pop()}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
