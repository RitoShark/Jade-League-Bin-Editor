import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Search, FolderOpen, ChevronDown, ChevronLeft } from 'lucide-react';
import ModelViewerStage from './ModelViewerStage';
import {
  fetchChampions,
  fetchChampionDetails,
  getChampionCircleUrl,
  preloadChampionCircle,
  preloadImage,
  getCachedImageUrl,
  resolveAsset,
  CDragonChampion,
  CDragonChampionDetails,
  CDragonSkin,
} from '../lib/cdragon';
import './ViewerTab.css';

/** Champion WAD entry as returned by the `viewer_list_champions` Tauri
 *  command. Sorted A→Z. `id` is the WAD filename stem. */
interface ChampionEntry {
  id: string;
  wad_path: string;
}

/** Open WAD mount — shared across stage 2 (skin browsing) and stage 3
 *  (model preview) so we don't pay the open cost twice when the user
 *  picks a skin. Opened on champion click, closed when the user heads
 *  back to the gallery or switches champion. */
interface WadMount {
  id: number;
  wadPath: string;
}

interface WadOpenResult {
  id: number;
  name: string;
  path: string;
  version: string;
  chunk_count: number;
}

/** "Live" / "PBE" / a user-picked folder. Decides which `Game/DATA/FINAL`
 *  the gallery enumerates from. */
type InstallSource =
  | { kind: 'live'; path: string }
  | { kind: 'pbe'; path: string }
  | { kind: 'custom'; path: string };

interface ViewerTabProps {
  /** Hidden when the welcome screen swaps to a different rail item. */
  active: boolean;
  /** Hands a skin-BIN text payload up so the host can open it as an
   *  editor tab. Wired by App.tsx — when omitted, the model viewer's
   *  "Open in BIN editor" button is disabled. */
  onOpenSkinBinAsText?: (text: string, displayName: string) => void;
  /** Asks the host to send the currently-loaded mesh into a Photo Studio
   *  scene. App.tsx extracts the skin's folder to a temp dir, opens a
   *  new studio scene, and loads the model. */
  onSendMeshToStudio?: (
    mountId: number,
    sknChunkHashHex: string,
    champion: string,
    skinNum: number,
    label: string,
    shadowForm: boolean,
    chromaSkinNum: number | null,
    textureBindings: Array<{ submeshName: string; chunkHashHex: string | null }> | null,
  ) => void;
  /** Update the welcome-screen-level status bar text. Used by the
   *  Viewer's Export buttons to show extract progress / completion. */
  onExtractStatus?: (text: string | null) => void;
  /** Switch to Extract Files + pre-navigate to a path inside the WAD.
   *  Fired by the "Show BIN" / "Show files" buttons in the Viewer's
   *  Export accordion. */
  onJumpToExtractor?: (target: {
    wadPath: string;
    subPath: string;
    mode: 'file' | 'folder';
  }) => void;
}

/**
 * Viewer — Khada-style three-stage browser:
 *  1. Champion gallery (this file, for now — split out later).
 *  2. Skin gallery.
 *  3. Model viewer.
 *
 * Stage 1 reads the user's WAD folder, lists every champion WAD it
 * finds, and shows a dense circular-avatar grid. No WAD is mounted at
 * this stage — mounts happen when the user clicks a champion (stage 2).
 *
 * Portraits come from CommunityDragon (cached in-memory as blob URLs),
 * matched to our local WAD filename via CDragon's `alias` field.
 */
/** Selected champion across stage 2 / 3 — carries enough to load skins
 *  and (later) mount the WAD without re-querying anything. */
interface SelectedChampion {
  entry: ChampionEntry;
  cdChamp: CDragonChampion;
}

type ViewerStage = 'gallery' | 'skins' | 'viewer';

export default function ViewerTab({
  active,
  onOpenSkinBinAsText,
  onSendMeshToStudio,
  onExtractStatus,
  onJumpToExtractor,
}: ViewerTabProps) {
  // Stage 1 / 2 / 3 — single source of truth for what's on screen.
  const [stage, setStage] = useState<ViewerStage>('gallery');
  const [selected, setSelected] = useState<SelectedChampion | null>(null);
  // The skin the user picked in stage 2 — needed to locate the right
  // .skn inside the mounted WAD when stage 3 loads.
  const [selectedSkin, setSelectedSkin] = useState<CDragonSkin | null>(null);
  // WAD mount lifecycle. Opened when the user clicks a champion tile
  // (so the skin gallery + model viewer share the open mount), closed
  // when they bounce back to the gallery or pick a different champion.
  const [mount, setMount] = useState<WadMount | null>(null);
  const mountRef = useRef<WadMount | null>(null);

  // Install source — Live by default, switchable in the header.
  const [installSources, setInstallSources] = useState<InstallSource[]>([]);
  const [source, setSource] = useState<InstallSource | null>(null);
  const [installPickerOpen, setInstallPickerOpen] = useState(false);

  // Champion list from the backend (filtered + sorted). Null until first load.
  const [champions, setChampions] = useState<ChampionEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // CDragon alias map — lowercased alias → champion. Filled async.
  const [aliasMap, setAliasMap] = useState<Map<string, CDragonChampion>>(
    new Map(),
  );

  // Force re-render when blob caches resolve. Bumped after each portrait
  // preload settles. (Cheaper than tracking individual image states.)
  const [, setPortraitTick] = useState(0);
  const bumpPortraitTick = useCallback(
    () => setPortraitTick((n) => n + 1),
    [],
  );

  const [search, setSearch] = useState('');

  // Detect installs once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [live, pbe] = await Promise.all([
          invoke<string | null>('detect_league_install'),
          invoke<string | null>('detect_league_pbe_install'),
        ]);
        if (cancelled) return;
        const found: InstallSource[] = [];
        if (live) found.push({ kind: 'live', path: live });
        if (pbe) found.push({ kind: 'pbe', path: pbe });
        setInstallSources(found);
        if (found.length > 0 && !source) setSource(found[0]);
      } catch {
        /* no detection — gallery shows empty state with pick-folder button */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the CDragon champion summary once; used for portrait URLs.
  // Driven by the source's branch — PBE has its own summary endpoint.
  const branch = source?.kind === 'pbe' ? 'pbe' : 'latest';
  useEffect(() => {
    let cancelled = false;
    fetchChampions(branch)
      .then((list) => {
        if (cancelled) return;
        const m = new Map<string, CDragonChampion>();
        for (const c of list) m.set(c.alias.toLowerCase(), c);
        setAliasMap(m);
      })
      .catch(() => {
        /* network failure → tiles fall back to initial-letter placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [branch]);

  // Enumerate champions whenever the source changes.
  useEffect(() => {
    if (!source) {
      setChampions(null);
      return;
    }
    let cancelled = false;
    setChampions(null);
    setLoadError(null);
    invoke<ChampionEntry[]>('viewer_list_champions', { finalPath: source.path })
      .then((list) => {
        if (cancelled) return;
        setChampions(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(typeof err === 'string' ? err : String(err));
        setChampions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Background-preload every portrait once we know aliases + champions.
  // CDragon icons are tiny (~5kb each); 170× concurrent would be rude
  // so we cap. The browser layer caches the responses on top of our
  // blob cache, so subsequent sessions cost roughly nothing.
  useEffect(() => {
    if (!champions || aliasMap.size === 0) return;
    let cancelled = false;
    const queue = champions
      .map((c) => aliasMap.get(c.id.toLowerCase()))
      .filter((c): c is CDragonChampion => !!c);

    const CONCURRENCY = 8;
    let i = 0;
    async function worker() {
      while (!cancelled && i < queue.length) {
        const cd = queue[i++];
        try {
          // Races the modern (_circle_0.png) and legacy (_circle.png)
          // paths — whichever exists for this champ wins.
          await preloadChampionCircle(cd.alias, branch);
          if (!cancelled) bumpPortraitTick();
        } catch {
          /* placeholder stays */
        }
      }
    }
    const workers: Promise<void>[] = [];
    for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
    void Promise.all(workers);

    return () => {
      cancelled = true;
    };
  }, [champions, aliasMap, branch, bumpPortraitTick]);

  // Group + filter for render. The A–Z rail and the letter-sectioned
  // grid both consume this. Sorting + bucketing key off the *display
  // name* (CDragon's "Wukong"), not the internal id ("MonkeyKing"), so
  // alphabetical order matches what the user actually reads.
  const { sections, totalAfterFilter } = useMemo(() => {
    const buckets = new Map<string, Array<{ entry: ChampionEntry; display: string }>>();
    const q = search.trim().toLowerCase();
    const annotated = (champions ?? [])
      .map((c) => {
        const cd = aliasMap.get(c.id.toLowerCase());
        return { entry: c, display: cd?.name ?? c.id };
      })
      .filter(({ entry, display }) => {
        if (!q) return true;
        if (display.toLowerCase().includes(q)) return true;
        return entry.id.toLowerCase().includes(q);
      });
    for (const item of annotated) {
      const letter = (item.display[0] ?? '#').toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      const arr = buckets.get(key) ?? [];
      arr.push(item);
      buckets.set(key, arr);
    }
    for (const arr of buckets.values()) {
      arr.sort((a, b) => a.display.localeCompare(b.display));
    }
    const ordered = Array.from(buckets.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return { sections: ordered, totalAfterFilter: annotated.length };
  }, [champions, search, aliasMap]);

  // A–Z rail: render all 26 letters always; dim ones with no champions
  // (visual stability — letters don't shuffle as the user types).
  const sectionRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  // Letter currently at the top of the gallery viewport — drives the
  // floating "you're at X" overlay that pops up while the user scrolls.
  // `scrollLetterTop` is the y-coord (within the gallery wrapper) where
  // the overlay should sit — tracks the scrollbar thumb so the
  // indicator slides up/down with the user's drag, iOS-style.
  const [scrollLetter, setScrollLetter] = useState<string | null>(null);
  const [scrollOverlayVisible, setScrollOverlayVisible] = useState(false);
  const [scrollLetterTop, setScrollLetterTop] = useState<number>(0);
  const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last-known scrollTop for the gallery grid. Persists across stage
  // transitions (gallery → skins → gallery) so jumping into a champ
  // and back puts the user right where they left off. Reset only when
  // the ViewerTab itself unmounts (user leaves the Viewer rail item).
  const gallerySavedScrollRef = useRef<number>(0);
  // Live mirror of `sections` so the scroll-handler (which is set up
  // once via the callback ref) can pick the right letter for the
  // current ratio without re-binding when sections change.
  const sectionsLiveRef = useRef(sections);
  sectionsLiveRef.current = sections;
  // Same memory for the skin gallery (stage 2) so bouncing into the
  // model viewer and back doesn't snap the user back to skin0.
  const skinScrollRef = useRef<number>(0);

  // Sync scroll position → top-most section letter + scrollbar thumb
  // position. Attached via a callback ref so it re-binds whenever the
  // gallery's grid div is remounted (e.g. after the user goes into a
  // champion and comes back) — a `useEffect` would miss that because
  // its deps don't change between the unmount and the new mount.
  const galleryGridRef = useCallback(
    (grid: HTMLDivElement | null) => {
      if (!grid) return;

      // Restore the user's last scroll position. Two-frame wait so
      // React has fully committed the section DOM before the browser
      // applies scrollTop — without it the grid is still height 0 and
      // the assignment becomes a no-op.
      if (gallerySavedScrollRef.current > 0) {
        const saved = gallerySavedScrollRef.current;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            grid.scrollTop = saved;
          });
        });
      }

      const handleScroll = () => {
        gallerySavedScrollRef.current = grid.scrollTop;
        const gridRect = grid.getBoundingClientRect();
        // Map scroll progress to a y-coord inside the grid so the
        // overlay rides the scrollbar thumb. Pin to a 32px margin
        // top and bottom so the letter never escapes the gallery.
        const maxScroll = Math.max(1, grid.scrollHeight - grid.clientHeight);
        const ratio = Math.min(1, Math.max(0, grid.scrollTop / maxScroll));
        const usableHeight = Math.max(0, gridRect.height - 64);
        setScrollLetterTop(32 + ratio * usableHeight);
        // Letter shown = the section at the corresponding fraction of
        // the alphabet list. So scrollTop=0 → first letter (A),
        // scrollTop=max → last letter (Z if present, otherwise the
        // last one in `sections`), middle → middle. Reads sections
        // from a live ref so this stays right as the user filters.
        const live = sectionsLiveRef.current;
        if (live.length > 0) {
          const idx = Math.min(live.length - 1, Math.floor(ratio * live.length));
          setScrollLetter(live[idx][0]);
        }
        setScrollOverlayVisible(true);
        if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
        scrollHideTimerRef.current = setTimeout(() => {
          setScrollOverlayVisible(false);
        }, 600);
      };
      grid.addEventListener('scroll', handleScroll, { passive: true });
      // Bookkeep the listener removal on the DOM node so React's
      // remount triggers it — there's no `removeEventListener` API
      // exposed on a callback ref otherwise.
      const cleanup = () => grid.removeEventListener('scroll', handleScroll);
      (grid as unknown as { __jadeScrollCleanup?: () => void }).__jadeScrollCleanup = cleanup;
    },
    [],
  );
  const allLetters = useMemo(
    () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    [],
  );
  const presentLetters = useMemo(
    () => new Set(sections.map(([k]) => k)),
    [sections],
  );

  // Close the current mount (if any). Idempotent — safe to call when no
  // mount is open. Used by the back-to-gallery transition + before
  // opening a different champion's WAD.
  const closeMount = useCallback(() => {
    const m = mountRef.current;
    if (!m) return;
    invoke('wad_close', { id: m.id }).catch(() => {});
    mountRef.current = null;
    setMount(null);
  }, []);

  // Open the champion's WAD and transition to the skin gallery. If a
  // different WAD is already mounted, close it first. Re-using the
  // same mount when re-clicking the same champion is fine — backend's
  // `wad_open` dedupes by path.
  const openChampion = useCallback(
    (entry: ChampionEntry, cdChamp: CDragonChampion) => {
      // Switching champion invalidates the skin-gallery scroll memory
      // — a fresh champion gets a fresh starting position.
      skinScrollRef.current = 0;
      setSelected({ entry, cdChamp });
      setStage('skins');
      if (mountRef.current && mountRef.current.wadPath === entry.wad_path) {
        return; // already mounted, no-op
      }
      if (mountRef.current) {
        invoke('wad_close', { id: mountRef.current.id }).catch(() => {});
        mountRef.current = null;
        setMount(null);
      }
      invoke<WadOpenResult>('wad_open', { path: entry.wad_path })
        .then((res) => {
          const next = { id: res.id, wadPath: entry.wad_path };
          mountRef.current = next;
          setMount(next);
        })
        .catch(() => {
          // Surface inside stage 3 if the open failed — stage 2 doesn't
          // need the mount yet (CDragon supplies skin metadata), so we
          // stay quiet here and let the model-load step report the error.
        });
    },
    [],
  );

  // Always close the WAD on unmount (e.g. user navigates away from
  // the Viewer rail item entirely).
  useEffect(() => {
    return () => closeMount();
  }, [closeMount]);

  const pickCustomFolder = useCallback(async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: 'Pick your League "Game/DATA/FINAL" folder',
    });
    if (typeof picked === 'string' && picked) {
      const next: InstallSource = { kind: 'custom', path: picked };
      setInstallSources((prev) => {
        const without = prev.filter((p) => p.kind !== 'custom');
        return [...without, next];
      });
      setSource(next);
    }
  }, []);

  if (!active) return null;

  const sourceLabel = (s: InstallSource) =>
    s.kind === 'live' ? 'Live' : s.kind === 'pbe' ? 'PBE' : 'Custom';

  // Stage 2 / 3 use a different header + body; render them via dedicated
  // sub-components so the gallery's header stays simple.
  if (stage === 'skins' && selected) {
    return (
      <SkinView
        selected={selected}
        branch={branch}
        scrollRef={skinScrollRef}
        onBack={() => {
          closeMount();
          setStage('gallery');
        }}
        onPickSkin={(skin) => {
          setSelectedSkin(skin);
          setStage('viewer');
        }}
      />
    );
  }

  if (stage === 'viewer' && selected && selectedSkin) {
    return (
      <ModelViewerStage
        selected={selected}
        skin={selectedSkin}
        branch={branch}
        mountId={mount?.id ?? null}
        onBack={() => setStage('skins')}
        onOpenSkinBinAsText={onOpenSkinBinAsText}
        onSendMeshToStudio={onSendMeshToStudio}
        onExtractStatus={onExtractStatus}
        onJumpToExtractor={onJumpToExtractor}
      />
    );
  }

  return (
    <div className="viewer-tab">
      <header className="viewer-header">
        <div className="viewer-title">Champions</div>

        <div className="viewer-search">
          <Search size={14} className="viewer-search-icon" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search champions…"
            spellCheck={false}
          />
        </div>

        <div className="viewer-source-picker">
          <button
            type="button"
            className="viewer-source-btn"
            onClick={() => setInstallPickerOpen((v) => !v)}
            title={source ? source.path : 'No install detected'}
          >
            <span>{source ? sourceLabel(source) : 'No install'}</span>
            <ChevronDown size={12} />
          </button>
          {installPickerOpen && (
            <div className="viewer-source-menu" role="menu">
              {installSources.map((s) => (
                <button
                  key={`${s.kind}:${s.path}`}
                  type="button"
                  role="menuitem"
                  className={`viewer-source-item${source?.path === s.path ? ' active' : ''}`}
                  onClick={() => {
                    setSource(s);
                    setInstallPickerOpen(false);
                  }}
                  title={s.path}
                >
                  <span className="viewer-source-kind">{sourceLabel(s)}</span>
                  <span className="viewer-source-path">{s.path}</span>
                </button>
              ))}
              <button
                type="button"
                className="viewer-source-item viewer-source-item-pick"
                onClick={() => {
                  setInstallPickerOpen(false);
                  void pickCustomFolder();
                }}
              >
                <FolderOpen size={12} />
                <span>Pick folder…</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="viewer-body">
        {!source ? (
          <EmptyStateNoInstall onPick={pickCustomFolder} />
        ) : loadError ? (
          <div className="viewer-error">{loadError}</div>
        ) : champions === null ? (
          <div className="viewer-loading">Loading champions…</div>
        ) : totalAfterFilter === 0 ? (
          <div className="viewer-empty">
            {search
              ? `No champions match "${search}".`
              : 'No champion WADs found in this folder.'}
          </div>
        ) : (
          <div className="viewer-gallery">
            <div className="viewer-gallery-grid" ref={galleryGridRef}>
              {sections.map(([letter, items]) => (
                <section
                  key={letter}
                  className="viewer-section"
                  ref={(el) => {
                    sectionRefs.current.set(letter, el);
                  }}
                  data-letter={letter}
                >
                  <h3 className="viewer-section-letter">{letter}</h3>
                  <div className="viewer-tile-grid">
                    {items.map(({ entry: c, display }) => {
                      const cd = aliasMap.get(c.id.toLowerCase());
                      return (
                        <ChampionTile
                          key={c.id}
                          entry={c}
                          cdChamp={cd}
                          displayName={display}
                          branch={branch}
                          onClick={() => {
                            if (!cd) return; // no CDragon match — can't load skins
                            openChampion(c, cd);
                          }}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            <nav className="viewer-az-rail" aria-label="Jump to letter">
              {allLetters.map((L) => {
                const present = presentLetters.has(L);
                return (
                  <button
                    type="button"
                    key={L}
                    className={`viewer-az-letter${present ? '' : ' empty'}`}
                    disabled={!present}
                    onClick={() => {
                      const el = sectionRefs.current.get(L);
                      if (el)
                        el.scrollIntoView({
                          behavior: 'smooth',
                          block: 'start',
                        });
                    }}
                  >
                    {L}
                  </button>
                );
              })}
            </nav>

            {scrollLetter && (
              <div
                className={`viewer-scroll-letter${scrollOverlayVisible ? ' visible' : ''}`}
                style={{ top: `${scrollLetterTop}px` }}
                aria-hidden="true"
              >
                {scrollLetter}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------

function EmptyStateNoInstall({ onPick }: { onPick: () => void }) {
  return (
    <div className="viewer-no-install">
      <h2>No League install detected</h2>
      <p>
        Point Jade at your <code>Game/DATA/FINAL</code> folder and the gallery
        will list every champion WAD it finds.
      </p>
      <button
        type="button"
        className="viewer-pick-btn"
        onClick={onPick}
      >
        <FolderOpen size={14} />
        Pick folder…
      </button>
    </div>
  );
}

interface ChampionTileProps {
  entry: ChampionEntry;
  cdChamp?: CDragonChampion;
  displayName: string;
  branch: 'latest' | 'pbe';
  onClick: () => void;
}

function ChampionTile({ entry, cdChamp, displayName, branch, onClick }: ChampionTileProps) {
  const url = cdChamp ? getChampionCircleUrl(cdChamp.alias, branch) : null;
  const blob = url ? getCachedImageUrl(url) : null;
  // Letter placeholder until the portrait blob resolves.
  const initial = displayName[0]?.toUpperCase() ?? '?';
  void entry;

  return (
    <button
      type="button"
      className="viewer-tile"
      title={displayName}
      onClick={onClick}
      disabled={!cdChamp}
    >
      <div className="viewer-tile-circle">
        {blob ? (
          <img
            src={blob}
            alt=""
            draggable={false}
            className="viewer-tile-img"
          />
        ) : (
          <span className="viewer-tile-letter">{initial}</span>
        )}
      </div>
      <span className="viewer-tile-name">{displayName}</span>
    </button>
  );
}

// =====================================================================
// Stage 2 — Skin gallery
// =====================================================================

interface SkinViewProps {
  selected: SelectedChampion;
  branch: 'latest' | 'pbe';
  onBack: () => void;
  onPickSkin: (skin: CDragonSkin) => void;
  /** Parent-owned scroll memory — preserved across mounts (i.e. when
   *  the user dips into the model viewer and comes back). Parent
   *  resets it on champion switch. */
  scrollRef: React.MutableRefObject<number>;
}

function SkinView({ selected, branch, onBack, onPickSkin, scrollRef }: SkinViewProps) {
  const { entry, cdChamp } = selected;

  const bodyRefCb = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      if (scrollRef.current > 0) {
        const saved = scrollRef.current;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.scrollTop = saved;
          });
        });
      }
      const onScroll = () => {
        scrollRef.current = el.scrollTop;
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      (el as unknown as { __jadeSkinScrollCleanup?: () => void })
        .__jadeSkinScrollCleanup = () => el.removeEventListener('scroll', onScroll);
    },
    [scrollRef],
  );
  const [details, setDetails] = useState<CDragonChampionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    fetchChampionDetails(cdChamp.id, branch)
      .then((d) => {
        if (!cancelled) setDetails(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(typeof e === 'string' ? e : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cdChamp.id, branch]);

  // Portrait blob from the gallery's preload — likely already in cache.
  const portraitUrl = getChampionCircleUrl(cdChamp.alias, branch);
  const portraitBlob = getCachedImageUrl(portraitUrl);

  return (
    <div className="viewer-tab">
      <header className="viewer-header viewer-header-detail">
        <button
          type="button"
          className="viewer-back-btn"
          onClick={onBack}
          title="Back to champions"
        >
          <ChevronLeft size={16} />
          <span>Champions</span>
        </button>
        <span className="viewer-breadcrumb-pill" title={cdChamp.name}>
          {cdChamp.name}
        </span>
      </header>

      <div className="viewer-body viewer-body-scroll" ref={bodyRefCb}>
        <div className="viewer-detail">
          <section className="viewer-bio">
            <div className="viewer-bio-portrait">
              {portraitBlob ? (
                <img
                  src={portraitBlob}
                  alt=""
                  draggable={false}
                  className="viewer-tile-img"
                />
              ) : (
                <span className="viewer-tile-letter">
                  {cdChamp.name[0]?.toUpperCase() ?? '?'}
                </span>
              )}
            </div>
            <div className="viewer-bio-text">
              <h1 className="viewer-bio-name">{cdChamp.name}</h1>
              {details?.title ? (
                <p className="viewer-bio-title">{details.title}</p>
              ) : null}
              {details?.shortBio ? (
                <p className="viewer-bio-blurb">{details.shortBio}</p>
              ) : null}
              <p className="viewer-bio-wad" title={entry.wad_path}>
                {entry.wad_path}
              </p>
            </div>
          </section>

          <section className="viewer-skins">
            <h2 className="viewer-skins-heading">Skins</h2>
            {error ? (
              <div className="viewer-error">{error}</div>
            ) : !details ? (
              <div className="viewer-loading">Loading skins…</div>
            ) : details.skins.length === 0 ? (
              <div className="viewer-empty">No skins found.</div>
            ) : (
              <div className="viewer-skin-grid">
                {details.skins.map((s) => (
                  <SkinTile
                    key={s.id}
                    skin={s}
                    branch={branch}
                    onClick={() => onPickSkin(s)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

interface SkinTileProps {
  skin: CDragonSkin;
  branch: 'latest' | 'pbe';
  onClick: () => void;
}

function SkinTile({ skin, branch, onClick }: SkinTileProps) {
  // Prefer the centered loading-screen splash (matches Khada's "card"
  // look); fall back to the uncentered wide art when CDragon doesn't
  // have a centered crop for this skin.
  const splashPath = skin.splashPath ?? skin.uncenteredSplashPath ?? skin.tilePath;
  const splashUrl = splashPath ? resolveAsset(splashPath, branch) : null;

  // Kick off a blob preload and re-render when it lands. The browser
  // caches the response, so even without our blob we'd hit memory next
  // time — but the blob URL avoids a re-fetch on every paint.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!splashUrl) return;
    let cancelled = false;
    preloadImage(splashUrl)
      .then(() => {
        if (!cancelled) setTick((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [splashUrl]);
  // Silence the unused-state warning — the tick is *the* trigger.
  void tick;

  const blob = splashUrl ? getCachedImageUrl(splashUrl) : null;
  const skinIdLabel = `skin${skin.num}`;

  return (
    <button type="button" className="viewer-skin-tile" onClick={onClick}>
      <div className="viewer-skin-art">
        {blob ? (
          <img src={blob} alt="" draggable={false} />
        ) : (
          <div className="viewer-skin-art-fallback" />
        )}
      </div>
      <div className="viewer-skin-meta">
        <span className="viewer-skin-name">{skin.name}</span>
        <span className="viewer-skin-id">{skinIdLabel}</span>
      </div>
    </button>
  );
}

