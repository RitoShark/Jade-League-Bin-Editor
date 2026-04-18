import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { LibraryIcon, SparklesIcon } from './Icons';
import './MaterialLibraryBrowser.css';

// ─────────────────────────────────────────────────────────────────────────────
// Types mirroring library_commands.rs
// ─────────────────────────────────────────────────────────────────────────────

interface LibraryCategory {
  id: string;
  name: string;
}

interface LibraryIndexEntry {
  id: string;
  /** Repo-relative path under materials/ — canonical identifier for all commands. */
  path: string;
  name: string;
  category: string;
  /** Lowercase champion alias, or null for curated "general/" materials. */
  champion: string | null;
  /** "skinN" when the material was extracted from a skin bin, else null. */
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
  categories: LibraryCategory[];
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

interface OutdatedMaterial {
  id: string;
  path: string;
  name: string;
  cachedVersion: number;
  remoteVersion: number;
}

interface LibraryProgressEvent {
  phase: string;
  current: number;
  total: number;
  message: string;
  materialId: string;
}

interface MaterialLibraryBrowserProps {
  onClose: () => void;
  /** Optional — when provided, the "Insert" button shows up and calls this with the selected material path. */
  onInsert?: (materialPath: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// "skin77" → 77, null/garbage → Infinity so unsorted entries land at the end.
function skinNumber(skin: string | null | undefined): number {
  if (!skin) return Number.POSITIVE_INFINITY;
  const m = String(skin).match(/^skin(\d+)$/i);
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const ALL_CATEGORY = '__all__';
const FEATURED_CATEGORY = '__featured__';
const INSTALLED_CATEGORY = '__installed__';

// Persisted via Jade's preference system so the user lands back on the
// last-viewed tab when they reopen the library.
const CATEGORY_PREF_KEY = 'LibraryLastCategory';
const CHAMPION_PREF_KEY = 'LibraryLastChampion';
const ALL_CHAMPIONS = '__all__';
const GENERAL_CHAMPION = '__general__';

// ─────────────────────────────────────────────────────────────────────────────
// Champion dropdown with icons
// ─────────────────────────────────────────────────────────────────────────────

interface ChampionDropdownProps {
  open: boolean;
  onToggle: (e: React.MouseEvent) => void;
  onClose: () => void;
  selected: string;
  onSelect: (champion: string) => void;
  champions: string[];
  championMap: Record<string, number>;
}

function ChampionDropdown({
  open,
  onToggle,
  selected,
  onSelect,
  champions,
  championMap,
}: ChampionDropdownProps) {
  const [filter, setFilter] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the search input whenever the menu opens, and clear the
  // previous filter so the list comes back full.
  useEffect(() => {
    if (open) {
      setFilter('');
      // Defer one tick so the input exists before focus.
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const display = (champ: string) => {
    if (champ === ALL_CHAMPIONS) return 'All champions';
    if (champ === GENERAL_CHAMPION) return 'General (curated)';
    return champ.charAt(0).toUpperCase() + champ.slice(1);
  };

  const filteredChampions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return champions;
    return champions.filter((c) => c.includes(q));
  }, [champions, filter]);

  const iconUrl = (champ: string): string | null => {
    const id = championMap[champ];
    if (!id) return null;
    return CD_CHAMPION_ICON(id);
  };

  const renderIcon = (champ: string) => {
    const url = iconUrl(champ);
    if (url) {
      return (
        <img
          className="mlb-champion-icon"
          src={url}
          alt=""
          onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
        />
      );
    }
    return <span className="mlb-champion-icon mlb-champion-icon-placeholder">·</span>;
  };

  const renderMetaIcon = (kind: 'all' | 'general') => {
    if (kind === 'all') {
      // 2x2 grid — "all champions"
      return (
        <span className="mlb-champion-icon mlb-champion-icon-meta">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
            <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
            <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
            <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
            <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
      );
    }
    // Star — "curated / featured picks"
    return (
      <span className="mlb-champion-icon mlb-champion-icon-meta">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
          <path
            d="M8 1.8l1.9 3.85 4.25.62-3.08 3 0.73 4.23L8 11.52 4.2 13.5l0.73-4.23-3.08-3 4.25-0.62L8 1.8z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  };

  return (
    <div className="mlb-champion-dropdown" onClick={(e) => e.stopPropagation()}>
      <button className="mlb-champion-trigger" onClick={onToggle} type="button">
        {selected === ALL_CHAMPIONS
          ? renderMetaIcon('all')
          : selected === GENERAL_CHAMPION
            ? renderMetaIcon('general')
            : renderIcon(selected)}
        <span className="mlb-champion-label">{display(selected)}</span>
        <span className="mlb-champion-caret">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mlb-champion-menu">
          <div className="mlb-champion-search-wrap">
            <input
              ref={searchRef}
              type="text"
              className="mlb-champion-search"
              placeholder="Filter champions…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filteredChampions.length > 0) {
                  onSelect(filteredChampions[0]);
                }
              }}
            />
          </div>
          {/* Meta options only show when there's no active filter. Once
              the user starts typing they're looking for a specific champ,
              so keeping ALL / GENERAL rows at the top would just waste
              real estate. */}
          {!filter && (
            <>
              <div
                className={`mlb-champion-option ${selected === ALL_CHAMPIONS ? 'selected' : ''}`}
                onClick={() => onSelect(ALL_CHAMPIONS)}
              >
                {renderMetaIcon('all')}
                <span>All champions</span>
              </div>
              <div
                className={`mlb-champion-option ${selected === GENERAL_CHAMPION ? 'selected' : ''}`}
                onClick={() => onSelect(GENERAL_CHAMPION)}
              >
                {renderMetaIcon('general')}
                <span>General (curated)</span>
              </div>
              <div className="mlb-champion-separator" />
            </>
          )}
          {filteredChampions.length === 0 ? (
            <div className="mlb-champion-empty">No champions match</div>
          ) : (
            filteredChampions.map((champ) => (
              <div
                key={champ}
                className={`mlb-champion-option ${selected === champ ? 'selected' : ''}`}
                onClick={() => onSelect(champ)}
              >
                {renderIcon(champ)}
                <span>{display(champ)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const CD_CHAMPION_ICON = (id: number) =>
  `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`;

// Per-category sidebar icons — simple inline SVGs that roughly evoke the
// category visually. Jade's existing icon set doesn't have semantic matches
// for shader categories so we roll bespoke minimalist glyphs here.
function CategoryIcon({ id, size = 14 }: { id: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'mlb-nav-icon',
  };
  switch (id) {
    case 'toon':
      // Half-shaded circle — cel shading reference
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 2.5 A5.5 5.5 0 0 1 8 13.5 Z" fill="currentColor" opacity="0.5" stroke="none" />
        </svg>
      );
    case 'glass':
      // Diamond / prism
      return (
        <svg {...common}>
          <path d="M8 2 L13 6 L10 13 L6 13 L3 6 Z" />
          <path d="M3 6 L13 6 M8 2 L8 13 M6 13 L10 6" opacity="0.55" />
        </svg>
      );
    case 'body':
      // Simple figure silhouette — head + torso
      return (
        <svg {...common}>
          <circle cx="8" cy="4" r="2.2" />
          <path d="M3.5 14 V11 Q3.5 8 8 8 Q12.5 8 12.5 11 V14" />
        </svg>
      );
    case 'dissolve':
      // Particle cluster
      return (
        <svg {...common}>
          <circle cx="4" cy="5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="8" cy="3" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="12" cy="5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="5" cy="9" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="10" cy="9" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="7" cy="13" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'glow':
      // Concentric circles radiating light
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="4.2" opacity="0.7" />
          <circle cx="8" cy="8" r="6.4" opacity="0.4" />
        </svg>
      );
    case 'distortion':
      // Stacked sine waves
      return (
        <svg {...common}>
          <path d="M2 5 Q5 2 8 5 T14 5" />
          <path d="M2 8 Q5 5 8 8 T14 8" />
          <path d="M2 11 Q5 8 8 11 T14 11" />
        </svg>
      );
    case 'special':
      // Asterisk — multi-direction catch-all
      return (
        <svg {...common}>
          <path d="M8 3 V13 M3.5 5.5 L12.5 10.5 M12.5 5.5 L3.5 10.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

// Sidebar nav glyph for the Installed filter — stylized checkmark inside
// a box, signalling "already on disk".
function InstalledIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      className="mlb-nav-icon">
      <path d="M2.5 4.5 V13 H13.5 V4.5" />
      <path d="M2 4.5 L8 7.5 L14 4.5 L8 1.5 Z" />
      <path d="M5.5 9.5 L7.5 11.5 L10.5 7.5" />
    </svg>
  );
}

// ── Action icons for the card action rail ──────────────────────────────────
function DownloadGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2 V11" />
      <path d="M4.5 7.5 L8 11 L11.5 7.5" />
      <path d="M3 13 H13" />
    </svg>
  );
}
function RefreshGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 8 A5 5 0 1 1 11.5 4.5" />
      <path d="M13 2 V5 H10" />
    </svg>
  );
}
function TrashGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4 H13" />
      <path d="M6 4 V2.5 H10 V4" />
      <path d="M4.5 4 L5.5 13.5 H10.5 L11.5 4" />
      <path d="M7 7 V11 M9 7 V11" opacity="0.7" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Material detail view — replaces the grid when a card is clicked
// ─────────────────────────────────────────────────────────────────────────────

interface MaterialDetailProps {
  material: LibraryIndexEntry;
  previewUrl: string | null;
  isDownloaded: boolean;
  downloadedInfo: DownloadedMaterialInfo | null;
  outdatedInfo: OutdatedMaterial | null;
  isBusy: boolean;
  progressMessage: string | null;
  onBack: () => void;
  onDownload: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onInsert?: () => void;
}

function MaterialDetail({
  material,
  previewUrl,
  isDownloaded,
  downloadedInfo,
  outdatedInfo,
  isBusy,
  progressMessage,
  onBack,
  onDownload,
  onUpdate,
  onDelete,
  onInsert,
}: MaterialDetailProps) {
  const champDisplay = material.champion
    ? material.champion.charAt(0).toUpperCase() + material.champion.slice(1)
    : 'General';
  // `cover` crops the image to fill the 3:4 box (default — punchier thumbnail
  // framing). `contain` letterboxes so the entire chroma render is visible.
  const [imgFit, setImgFit] = useState<'cover' | 'contain'>('cover');

  return (
    <div className="mlb-detail">
      <div className="mlb-detail-header">
        <button className="mlb-detail-back" onClick={onBack} type="button">
          ← Back
        </button>
        <h3 className="mlb-detail-title">{material.name}</h3>
      </div>

      <div className="mlb-detail-body">
        <div className="mlb-detail-preview">
          {previewUrl && (
            <button
              className="mlb-detail-fit-toggle"
              type="button"
              onClick={() => setImgFit((f) => (f === 'cover' ? 'contain' : 'cover'))}
              title={imgFit === 'cover' ? 'Show full image' : 'Fill box'}
            >
              {imgFit === 'cover' ? '⤢' : '⤡'}
            </button>
          )}
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={material.name}
              className="mlb-detail-img"
              style={{ objectFit: imgFit }}
              onError={(e) => {
                // Same cascading fallback strategy as the cards.
                const img = e.target as HTMLImageElement;
                if (!material.champion) { img.style.display = 'none'; return; }
                const alias = material.champion.charAt(0).toUpperCase() + material.champion.slice(1);
                const cdRe = /champion-chroma-images\/(\d+)\/(\d+)\.png$/;
                const m = img.src.match(cdRe);
                if (m) {
                  const champId = Number(m[1]);
                  const fullId = Number(m[2]);
                  const skinNum = fullId - champId * 1000;
                  img.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${alias}_${skinNum}.jpg`;
                  return;
                }
                const ddRe = /cdn\/img\/champion\/splash\/([A-Za-z0-9]+)_(\d+)\.jpg$/;
                const dd = img.src.match(ddRe);
                if (dd) {
                  const curr = Number(dd[2]);
                  if (curr > 0) {
                    img.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${alias}_${curr - 1}.jpg`;
                    return;
                  }
                }
                img.style.display = 'none';
              }}
            />
          ) : (
            <div className="mlb-detail-noimg">No preview available</div>
          )}
        </div>

        <div className="mlb-detail-meta">
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">ID</span>
            <code className="mlb-detail-meta-value">{material.id}</code>
          </div>
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">Path</span>
            <code className="mlb-detail-meta-value">{material.path}</code>
          </div>
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">Champion</span>
            <span className="mlb-detail-meta-value">{champDisplay}</span>
          </div>
          {material.skin && (
            <div className="mlb-detail-meta-row">
              <span className="mlb-detail-meta-label">Skin</span>
              <span className="mlb-detail-meta-value">{material.skin}</span>
            </div>
          )}
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">Category</span>
            <span className="mlb-detail-meta-value">{material.category}</span>
          </div>
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">Version</span>
            <span className="mlb-detail-meta-value">v{material.version}</span>
          </div>
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">Updated</span>
            <span className="mlb-detail-meta-value">{formatDate(material.updatedAt)}</span>
          </div>
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">Needs</span>
            <span className="mlb-detail-meta-value">
              {material.userSlots.length > 0 ? material.userSlots.join(', ') : '(none)'}
            </span>
          </div>
          <div className="mlb-detail-meta-row">
            <span className="mlb-detail-meta-label">Size</span>
            <span className="mlb-detail-meta-value">
              {downloadedInfo ? formatBytes(downloadedInfo.sizeBytes) : 'Not downloaded'}
            </span>
          </div>
          {material.materialName && (
            <div className="mlb-detail-meta-row">
              <span className="mlb-detail-meta-label">StaticMaterialDef</span>
              <code className="mlb-detail-meta-value">{material.materialName}</code>
            </div>
          )}
          {material.description && (
            <div className="mlb-detail-description">{material.description}</div>
          )}

          <div className="mlb-detail-actions">
            {isBusy ? (
              <span className="mlb-card-status">{progressMessage ?? 'Working…'}</span>
            ) : isDownloaded ? (
              <>
                {outdatedInfo ? (
                  <button className="mlb-btn-download" onClick={onUpdate}>
                    Update to v{outdatedInfo.remoteVersion}
                  </button>
                ) : (
                  <span className="mlb-badge">Downloaded</span>
                )}
                <button className="mlb-btn" onClick={onUpdate}>Force re-download</button>
                <button className="mlb-btn mlb-btn-danger" onClick={onDelete}>Remove</button>
              </>
            ) : (
              <button className="mlb-btn-download" onClick={onDownload}>
                Download
              </button>
            )}
            {onInsert && isDownloaded && (
              <button className="mlb-btn" onClick={onInsert}>Insert</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MaterialLibraryBrowser({ onClose, onInsert }: MaterialLibraryBrowserProps) {
  const [index, setIndex] = useState<LibraryIndex | null>(null);
  const [downloaded, setDownloaded] = useState<DownloadedMaterialInfo[]>([]);
  const [outdated, setOutdated] = useState<OutdatedMaterial[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default to Featured so the browser doesn't load every extracted
  // material on first open. The actual last-used tab is hydrated from
  // the preference store once loaded; this initial value only flashes
  // briefly during the first paint.
  const [selectedCategory, setSelectedCategoryState] = useState<string>(FEATURED_CATEGORY);

  // Wrapper that persists every change to Jade's preference store so
  // the selection survives closing and reopening the dialog.
  const setSelectedCategory = useCallback((value: string) => {
    setSelectedCategoryState(value);
    invoke('set_preference', { key: CATEGORY_PREF_KEY, value }).catch(() => {});
  }, []);
  const [selectedChampion, setSelectedChampionState] = useState<string>(ALL_CHAMPIONS);

  const setSelectedChampion = useCallback((value: string) => {
    setSelectedChampionState(value);
    invoke('set_preference', { key: CHAMPION_PREF_KEY, value }).catch(() => {});
  }, []);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMaterial, setSelectedMaterial] = useState<LibraryIndexEntry | null>(null);
  const scrollPosRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<LibraryProgressEvent | null>(null);
  const [previewCache, setPreviewCache] = useState<Record<string, string | null>>({});
  const [championMap, setChampionMap] = useState<Record<string, number>>({});
  const [championDropdownOpen, setChampionDropdownOpen] = useState(false);

  // ── Data loading ──
  const refreshDownloaded = useCallback(async () => {
    try {
      const d = await invoke<DownloadedMaterialInfo[]>('library_list_downloaded');
      setDownloaded(d);
    } catch (e) {
      console.warn('Failed to list downloaded materials:', e);
    }
  }, []);

  const refreshOutdated = useCallback(async () => {
    try {
      const o = await invoke<OutdatedMaterial[]>('library_list_outdated');
      setOutdated(o);
    } catch (e) {
      console.warn('Failed to list outdated materials:', e);
    }
  }, []);

  const loadCachedIndex = useCallback(async () => {
    try {
      const cached = await invoke<LibraryIndex | null>('library_get_cached_index');
      if (cached) setIndex(cached);
    } catch (e) {
      console.warn('Failed to load cached index:', e);
    }
  }, []);

  const fetchRemoteIndex = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await invoke<LibraryIndex>('library_fetch_index');
      setIndex(fresh);
      await refreshOutdated();
    } catch (e) {
      const msg = typeof e === 'string' ? e : String(e);
      setError(`Failed to fetch library index: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [refreshOutdated]);

  useEffect(() => {
    loadCachedIndex();
    refreshDownloaded();
    fetchRemoteIndex().catch(() => {});
    // Fetch the champion name→id map once so we can render champion icons
    // in the dropdown. On first call the backend goes to Community Dragon
    // and caches the result, so subsequent opens are instant.
    invoke<Record<string, number>>('library_get_champion_map')
      .then((map) => setChampionMap(map))
      .catch(() => {});
    // Restore last-selected category from preferences. This runs once
    // on mount and silently falls back to Featured if the pref is unset
    // or the stored value points at a category that no longer exists.
    invoke<string>('get_preference', {
      key: CATEGORY_PREF_KEY,
      defaultValue: FEATURED_CATEGORY,
    })
      .then((value) => {
        if (value) setSelectedCategoryState(value);
      })
      .catch(() => {});
    // Restore last-selected champion filter the same way.
    invoke<string>('get_preference', {
      key: CHAMPION_PREF_KEY,
      defaultValue: ALL_CHAMPIONS,
    })
      .then((value) => {
        if (value) setSelectedChampionState(value);
      })
      .catch(() => {});
  }, [loadCachedIndex, refreshDownloaded, fetchRemoteIndex]);

  // Listen for progress events
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<LibraryProgressEvent>('library-progress', (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Close champion dropdown when clicking outside
  useEffect(() => {
    if (!championDropdownOpen) return;
    const onClick = () => setChampionDropdownOpen(false);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [championDropdownOpen]);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Derived state ──
  const downloadedPaths = useMemo(
    () => new Set(downloaded.map((d) => d.path)),
    [downloaded]
  );

  const outdatedMap = useMemo(() => {
    const m = new Map<string, OutdatedMaterial>();
    for (const o of outdated) m.set(o.path, o);
    return m;
  }, [outdated]);

  const categoryCounts = useMemo(() => {
    if (!index) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const m of index.materials) {
      counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
    }
    return counts;
  }, [index]);

  const featuredCount = useMemo(
    () => (index ? index.materials.filter((m) => m.featured).length : 0),
    [index]
  );

  // Count of entries the user already has a local cached copy of.
  // Intersection of the live index materials with the downloaded-paths
  // set, so pruned-from-repo entries don't inflate the number.
  const installedCount = useMemo(() => {
    if (!index) return 0;
    return index.materials.filter((m) => downloadedPaths.has(m.path)).length;
  }, [index, downloadedPaths]);

  // Champion list for the dropdown — sourced from the index, fallback to
  // derivation if the backend didn't populate the top-level champions array.
  const championList = useMemo(() => {
    if (!index) return [];
    if (index.champions && index.champions.length > 0) return index.champions;
    const derived = new Set<string>();
    for (const m of index.materials) {
      if (m.champion) derived.add(m.champion);
    }
    return [...derived].sort();
  }, [index]);

  // Token-based search + champion/category filter + skin-number sort.
  //   "ahri skin77" → narrows to Ahri materials whose skin/path contains skin77
  //   champion dropdown → hard filter on champion field
  //   sort → primary by champion, secondary by skin number ascending
  const filteredMaterials = useMemo(() => {
    if (!index) return [];
    const tokens = searchQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const filtered = index.materials.filter((m) => {
      if (selectedCategory === FEATURED_CATEGORY) {
        if (!m.featured) return false;
      } else if (selectedCategory === INSTALLED_CATEGORY) {
        if (!downloadedPaths.has(m.path)) return false;
      } else if (selectedCategory !== ALL_CATEGORY) {
        if (m.category !== selectedCategory) return false;
      }
      if (selectedChampion === GENERAL_CHAMPION) {
        if (m.champion) return false;
      } else if (selectedChampion !== ALL_CHAMPIONS) {
        if (m.champion !== selectedChampion) return false;
      }
      if (tokens.length === 0) return true;

      const haystacks = [
        m.name.toLowerCase(),
        m.description.toLowerCase(),
        (m.champion || '').toLowerCase(),
        (m.skin || '').toLowerCase(),
        m.path.toLowerCase(),
        m.id.toLowerCase(),
        ...m.tags.map((t) => t.toLowerCase()),
      ];
      return tokens.every((tok) => haystacks.some((h) => h.includes(tok)));
    });

    // Stable sort: champion (alpha) → skin number (asc) → id (alpha)
    return filtered.sort((a, b) => {
      const ca = (a.champion || 'zzzz').localeCompare(b.champion || 'zzzz');
      if (ca !== 0) return ca;
      const sa = skinNumber(a.skin);
      const sb = skinNumber(b.skin);
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });
  }, [index, selectedCategory, selectedChampion, searchQuery, downloadedPaths]);

  // Lazy-load preview URLs in batches of 30. Results are cached by path
  // so switching filters is fast and the backend isn't spammed.
  // `null` means "no preview available — don't try again".
  useEffect(() => {
    const toFetch = filteredMaterials
      .map((m) => m.path)
      .filter((p) => !(p in previewCache));
    if (toFetch.length === 0) return;

    let cancelled = false;
    const BATCH = 30;
    // Look up by path so we can forward the index entry's champion/skin
    // fields to the backend. Without these, materials the user hasn't
    // downloaded can't get a thumbnail (no local snippet.json to read).
    const byPath = new Map(index?.materials.map((m) => [m.path, m]) ?? []);
    (async () => {
      for (let i = 0; i < toFetch.length; i += BATCH) {
        if (cancelled) return;
        const batch = toFetch.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map((p) => {
            const entry = byPath.get(p);
            return invoke<string | null>('library_get_preview', {
              path: p,
              champion: entry?.champion ?? null,
              skin: entry?.skin ?? null,
              hasPreview: entry?.hasPreview ?? false,
            }).then((url) => ({ p, url }));
          })
        );
        if (cancelled) return;
        setPreviewCache((prev) => {
          const next = { ...prev };
          for (const r of results) {
            if (r.status === 'fulfilled') next[r.value.p] = r.value.url ?? null;
            else next[(r as any).reason?.p ?? ''] = null;
          }
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filteredMaterials, previewCache]);

  // ── Actions ──
  const handleDownload = useCallback(
    async (materialPath: string) => {
      setBusyPath(materialPath);
      try {
        await invoke('library_fetch_material', { path: materialPath });
        await refreshDownloaded();
        await refreshOutdated();
      } catch (e) {
        const msg = typeof e === 'string' ? e : String(e);
        setError(`Failed to download ${materialPath}: ${msg}`);
      } finally {
        setBusyPath(null);
        setProgress(null);
      }
    },
    [refreshDownloaded, refreshOutdated]
  );

  const handleUpdate = useCallback(
    async (materialPath: string) => {
      setBusyPath(materialPath);
      try {
        await invoke('library_update_material', { path: materialPath });
        await refreshDownloaded();
        await refreshOutdated();
      } catch (e) {
        const msg = typeof e === 'string' ? e : String(e);
        setError(`Failed to update ${materialPath}: ${msg}`);
      } finally {
        setBusyPath(null);
        setProgress(null);
      }
    },
    [refreshDownloaded, refreshOutdated]
  );

  const handleDelete = useCallback(
    async (materialPath: string) => {
      try {
        await invoke('library_delete_material', { path: materialPath });
        await refreshDownloaded();
        await refreshOutdated();
        if (selectedMaterial?.path === materialPath) setSelectedMaterial(null);
      } catch (e) {
        const msg = typeof e === 'string' ? e : String(e);
        setError(`Failed to delete ${materialPath}: ${msg}`);
      }
    },
    [refreshDownloaded, refreshOutdated, selectedMaterial]
  );

  const handleInsert = useCallback(
    async (materialPath: string) => {
      if (!onInsert) return;
      if (!downloadedPaths.has(materialPath)) {
        setBusyPath(materialPath);
        try {
          await invoke('library_fetch_material', { path: materialPath });
          await refreshDownloaded();
        } catch (e) {
          const msg = typeof e === 'string' ? e : String(e);
          setError(`Failed to download for insert: ${msg}`);
          setBusyPath(null);
          return;
        }
        setBusyPath(null);
      }
      onInsert(materialPath);
      onClose();
    },
    [onInsert, onClose, downloadedPaths, refreshDownloaded]
  );

  // ── Render ──
  return (
    <div className="mlb-overlay" onClick={onClose}>
      <div className="mlb-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="mlb-dialog-header">
          <h2>Material Library</h2>
          <button className="close-button" onClick={onClose} title="Close (Esc)">×</button>
        </div>

        {error && (
          <div className="mlb-error">
            <span>{error}</span>
            <button className="mlb-error-dismiss" onClick={() => setError(null)}>×</button>
          </div>
        )}

        {/* Body */}
        <div className="mlb-body">
          {/* Sidebar */}
          <div className="mlb-sidebar">
            {/* Champion dropdown — sits above the category list so the
                user can pick one champion and narrow the grid. Clicking
                the trigger toggles a floating list with champion icons. */}
            <ChampionDropdown
              open={championDropdownOpen}
              onToggle={(e) => {
                e.stopPropagation();
                setChampionDropdownOpen((v) => !v);
              }}
              onClose={() => setChampionDropdownOpen(false)}
              selected={selectedChampion}
              onSelect={(champ) => {
                setSelectedChampion(champ);
                setChampionDropdownOpen(false);
              }}
              champions={championList}
              championMap={championMap}
            />

            <div
              className={`mlb-nav-item ${selectedCategory === ALL_CATEGORY ? 'active' : ''}`}
              onClick={() => setSelectedCategory(ALL_CATEGORY)}
            >
              <LibraryIcon size={14} className="mlb-nav-icon" />
              <span>All</span>
              <span className="mlb-nav-count">{index?.materials.length ?? 0}</span>
            </div>
            <div
              className={`mlb-nav-item ${selectedCategory === FEATURED_CATEGORY ? 'active' : ''}`}
              onClick={() => setSelectedCategory(FEATURED_CATEGORY)}
            >
              <SparklesIcon size={14} className="mlb-nav-icon" />
              <span>Featured</span>
              <span className="mlb-nav-count">{featuredCount}</span>
            </div>
            <div
              className={`mlb-nav-item ${selectedCategory === INSTALLED_CATEGORY ? 'active' : ''}`}
              onClick={() => setSelectedCategory(INSTALLED_CATEGORY)}
            >
              <InstalledIcon />
              <span>Installed</span>
              <span className="mlb-nav-count">{installedCount}</span>
            </div>
            {index?.categories
              // Hide empty buckets so a stale index.json with dropped
              // categories (e.g. the old "accessories") doesn't leave
              // dead nav items in the sidebar.
              .filter((cat) => (categoryCounts.get(cat.id) ?? 0) > 0)
              .map((cat) => {
                const count = categoryCounts.get(cat.id) ?? 0;
                return (
                  <div
                    key={cat.id}
                    className={`mlb-nav-item ${selectedCategory === cat.id ? 'active' : ''}`}
                    onClick={() => setSelectedCategory(cat.id)}
                  >
                    <CategoryIcon id={cat.id} />
                    <span>{cat.name}</span>
                    <span className="mlb-nav-count">{count}</span>
                  </div>
                );
              })}
          </div>

          {/* Content — grid view or detail view depending on selection */}
          <div className="mlb-content" ref={contentRef}>
            {selectedMaterial ? (
              <MaterialDetail
                material={selectedMaterial}
                previewUrl={previewCache[selectedMaterial.path] ?? null}
                isDownloaded={downloadedPaths.has(selectedMaterial.path)}
                downloadedInfo={downloaded.find((d) => d.path === selectedMaterial.path) ?? null}
                outdatedInfo={outdatedMap.get(selectedMaterial.path) ?? null}
                isBusy={busyPath === selectedMaterial.path}
                progressMessage={progress?.message ?? null}
                onBack={() => {
                  setSelectedMaterial(null);
                  requestAnimationFrame(() => {
                    if (contentRef.current) contentRef.current.scrollTop = scrollPosRef.current;
                  });
                }}
                onDownload={() => handleDownload(selectedMaterial.path)}
                onUpdate={() => handleUpdate(selectedMaterial.path)}
                onDelete={async () => {
                  await handleDelete(selectedMaterial.path);
                  setSelectedMaterial(null);
                }}
                onInsert={onInsert ? () => handleInsert(selectedMaterial.path) : undefined}
              />
            ) : (
            <>
            <div className="mlb-content-header">
              <div>
                <h3 className="mlb-section-title">
                  {selectedCategory === ALL_CATEGORY
                    ? 'All Materials'
                    : selectedCategory === FEATURED_CATEGORY
                      ? 'Featured Materials'
                      : selectedCategory === INSTALLED_CATEGORY
                        ? 'Installed Materials'
                        : index?.categories.find((c) => c.id === selectedCategory)?.name ?? 'Materials'}
                </h3>
                <p className="mlb-section-subtitle">
                  Browse and download League of Legends materials from the jade-library repo.
                </p>
              </div>
              <div className="mlb-content-header-actions">
                <input
                  type="text"
                  className="mlb-search"
                  placeholder="Search — try 'ahri skin77' or 'toon'"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button
                  className="mlb-refresh-btn"
                  onClick={fetchRemoteIndex}
                  disabled={loading}
                  title="Refresh catalog"
                >
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </div>

            {!index && !loading && (
              <div className="mlb-empty">No library data. Click Refresh to fetch.</div>
            )}

            {index && filteredMaterials.length === 0 && (
              <div className="mlb-empty">No materials match your filter.</div>
            )}

            <div className="mlb-cards">
              {filteredMaterials.map((material) => {
                const isDownloaded = downloadedPaths.has(material.path);
                const outdatedInfo = outdatedMap.get(material.path);
                const isBusy = busyPath === material.path;
                const previewUrl = previewCache[material.path];

                return (
                  <div
                    key={material.path}
                    className="mlb-card"
                    onClick={(e) => {
                      // Don't hijack clicks on the action rail buttons —
                      // only open the detail view when the user clicks the
                      // card background / preview / body.
                      if ((e.target as HTMLElement).closest('button')) return;
                      scrollPosRef.current = contentRef.current?.scrollTop ?? 0;
                      setSelectedMaterial(material);
                    }}
                  >
                    <div className="mlb-card-preview">
                      {previewUrl ? (
                        <img
                          src={previewUrl}
                          alt={material.name}
                          className="mlb-preview-img"
                          loading="lazy"
                          onError={(e) => {
                            // Fallback strategy:
                            //   0. Repo preview.png → thumb.png (curated
                            //      materials use thumb.*, extracted ones
                            //      use preview.*, both land under the same
                            //      materials/<path>/ URL).
                            //   1. 3D render (CD chroma-images) is EXACT
                            //      MATCH ONLY — if it 404s, switch to
                            //      Data Dragon for the same skin number.
                            //   2. 2D splash (Data Dragon) MAY walk back
                            //      skin→skin-1→…→base since chromas
                            //      share their parent's splash.
                            const img = e.target as HTMLImageElement;

                            // Step 0 — try thumb.png / thumb.jpg / preview.jpg
                            //          if the initial preview.png missed.
                            const repoRe = /\/materials\/[^?]*\/(thumb|preview)\.(png|jpg|jpeg|webp)$/;
                            const repoMatch = img.src.match(repoRe);
                            if (repoMatch) {
                              const [curStem, curExt] = [repoMatch[1], repoMatch[2]];
                              const candidates: Array<[string, string]> = [
                                ['thumb',   'png'],
                                ['thumb',   'jpg'],
                                ['preview', 'jpg'],
                                ['preview', 'webp'],
                                ['thumb',   'webp'],
                              ];
                              const next = candidates.find(
                                ([s, x]) => !(s === curStem && x === curExt)
                              );
                              // Track which variations we've already tried via a
                              // dataset attribute so we don't loop forever.
                              const tried = (img.dataset.previewTries || '').split(',');
                              tried.push(`${curStem}.${curExt}`);
                              const fresh = candidates.find(
                                ([s, x]) => !tried.includes(`${s}.${x}`)
                              );
                              if (fresh) {
                                img.dataset.previewTries = tried.join(',');
                                img.src = img.src.replace(
                                  /\/(thumb|preview)\.(png|jpg|jpeg|webp)$/,
                                  `/${fresh[0]}.${fresh[1]}`
                                );
                                return;
                              }
                              // All repo preview variations exhausted — fall
                              // through to the champion splash fallback.
                              if (!material.champion) {
                                img.style.display = 'none';
                                return;
                              }
                              const champId = championMap[material.champion];
                              const skinNum = material.skin
                                ? parseInt(material.skin.replace(/^skin/i, ''), 10) || 0
                                : 0;
                              if (champId) {
                                img.src = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-chroma-images/${champId}/${champId * 1000 + skinNum}.png`;
                                return;
                              }
                              // No champion id known, hide.
                              img.style.display = 'none';
                              return;
                              void next;
                            }

                            if (!material.champion) {
                              img.style.display = 'none';
                              return;
                            }
                            const alias =
                              material.champion.charAt(0).toUpperCase() +
                              material.champion.slice(1);

                            // Step 1 → 2: CD 3D render failed, start DDragon
                            // at the exact skin number.
                            const cdRe = /champion-chroma-images\/(\d+)\/(\d+)\.png$/;
                            const cdMatch = img.src.match(cdRe);
                            if (cdMatch) {
                              const champId = Number(cdMatch[1]);
                              const fullId = Number(cdMatch[2]);
                              const skinNum = fullId - champId * 1000;
                              img.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${alias}_${skinNum}.jpg`;
                              return;
                            }

                            // Step 2 walk-back: DDragon for skin N failed,
                            // try N-1 until we hit base (0).
                            const ddRe = /cdn\/img\/champion\/splash\/([A-Za-z0-9]+)_(\d+)\.jpg$/;
                            const ddMatch = img.src.match(ddRe);
                            if (ddMatch) {
                              const curr = Number(ddMatch[2]);
                              if (curr > 0) {
                                img.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${alias}_${curr - 1}.jpg`;
                                return;
                              }
                            }

                            // Everything failed — hide.
                            img.style.display = 'none';
                          }}
                        />
                      ) : (
                        <span className="mlb-preview-icon">·</span>
                      )}
                    </div>
                    <div className="mlb-card-body">
                      <div className="mlb-card-header">
                        <span className="mlb-card-name">{material.name}</span>
                        <span className="mlb-card-version">v{material.version}</span>
                      </div>
                      <div className="mlb-card-description">
                        {material.champion
                          ? `${material.champion.charAt(0).toUpperCase()}${material.champion.slice(1)}${material.skin ? ` · ${material.skin}` : ''}`
                          : material.description || '(general)'}
                      </div>
                      <div className="mlb-card-slots">
                        Needs: {material.userSlots.join(', ') || '(none)'}
                      </div>
                      {outdatedInfo && (
                        <div className="mlb-card-outdated">
                          ⚠ v{outdatedInfo.remoteVersion} available
                        </div>
                      )}
                    </div>
                    {/* Compact action rail — pinned to the right of the
                        card. Never taller than the card preview (80px).
                        While busy, shows a status line in place of icons. */}
                    <div className="mlb-card-rail">
                      {isBusy ? (
                        <span className="mlb-card-status mlb-card-rail-status">
                          {progress?.message ?? 'Working…'}
                        </span>
                      ) : isDownloaded ? (
                        <>
                          <button
                            className="mlb-icon-btn mlb-icon-btn-refresh"
                            onClick={(e) => { e.stopPropagation(); handleUpdate(material.path); }}
                            title={outdatedInfo ? `Update to v${outdatedInfo.remoteVersion}` : 'Force re-download'}
                          >
                            <RefreshGlyph />
                          </button>
                          <button
                            className="mlb-icon-btn mlb-icon-btn-danger"
                            onClick={(e) => { e.stopPropagation(); handleDelete(material.path); }}
                            title="Remove from cache"
                          >
                            <TrashGlyph />
                          </button>
                        </>
                      ) : (
                        <button
                          className="mlb-icon-btn mlb-icon-btn-primary"
                          onClick={(e) => { e.stopPropagation(); handleDownload(material.path); }}
                          title="Download"
                        >
                          <DownloadGlyph />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </>
            )}
          </div>
        </div>

        {/* Footer */}
        {index && (
          <div className="mlb-footer">
            <span>
              {downloaded.length} downloaded · {outdated.length} outdated · Updated:{' '}
              {formatDate(index.lastUpdated)}
            </span>
            {selectedMaterial && (
              <span className="mlb-footer-selected">
                Selected: {selectedMaterial.name}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
