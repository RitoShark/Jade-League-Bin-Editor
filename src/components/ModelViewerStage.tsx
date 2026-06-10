import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog, open as openDirDialogFromPlugin } from '@tauri-apps/plugin-dialog';
import {
  ChevronLeft, ChevronDown, Search as SearchIcon,
  Info, Clapperboard, Layers, Palette, Settings as SettingsIcon, Upload,
  ChevronLeft as PrevIcon, ChevronRight as NextIcon,
  Play, Pause, Repeat as FormCycleIcon,
} from 'lucide-react';

import { MeshPreview, type AnimationListing, type MeshPreviewCameraState } from './MeshPreview';
import { Accordion, AccordionSection } from './Accordion';
import {
  getChampionCircleUrl,
  getCachedImageUrl,
  getChromaIconUrl,
  resolveAsset,
  preloadImage,
  CDragonChampion,
  CDragonSkin,
} from '../lib/cdragon';
import {
  X as CloseIcon,
  FileCode,
  Camera as CameraIcon,
  Box as BoxIcon,
  Package as PackageIcon,
  FolderArchive,
  ExternalLink,
  FolderOpen as FolderOpenIcon,
} from 'lucide-react';
import './ModelViewerStage.css';

/** Champion entry the parent (ViewerTab) handed us — same shape as
 *  stage 1 / 2 use. Carries the WAD path so we can mount it when we
 *  start loading real models in the next phase. */
interface ChampionEntry {
  id: string;
  wad_path: string;
}

interface ModelViewerStageProps {
  selected: {
    entry: ChampionEntry;
    cdChamp: CDragonChampion;
  };
  skin: CDragonSkin;
  branch: 'latest' | 'pbe';
  /** The shared WAD mount opened upstream when the user clicked the
   *  champion tile. `null` while the open is still in flight. */
  mountId: number | null;
  /** Whether the Viewer tab is the active/visible view. When false the
   *  heavy Babylon canvas (MeshPreview) is unmounted to free the GPU
   *  scene; all other React state is preserved so the model, animation,
   *  pause-state and camera restore instantly when the user returns. */
  active: boolean;
  onBack: () => void;
  /** When provided, the Export accordion's "Open in BIN editor" entry
   *  reads the skin BIN, converts it to text, and hands it off to the
   *  host. The host is expected to open the text in a new editor tab. */
  onOpenSkinBinAsText?: (text: string, displayName: string) => void;
  /** Updates the welcome-screen status bar text. Used to show export
   *  progress + completion / failure messages from the Export
   *  accordion's WAD-extract buttons. */
  onExtractStatus?: (text: string | null) => void;
  /** Switch the welcome screen over to the Extract tab + navigate
   *  inside the WAD to a specific sub-path. `mode: 'folder'` selects
   *  the folder; `mode: 'file'` selects the file (highlights it +
   *  shows its preview). Used by the two Open-in-Extractor buttons. */
  onJumpToExtractor?: (target: {
    wadPath: string;
    subPath: string;
    mode: 'file' | 'folder';
  }) => void;
  /** When provided, the Export accordion's "Send to Photo Studio"
   *  entry hands the currently-loaded mesh's mount id + SKN chunk hash
   *  + champion id + skin number up. The host extracts the full skin
   *  folder to a temp dir and loads it into a new Studio tab. `label`
   *  is a friendly name for the studio object list. */
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
}

interface WadEntry {
  path: string;
  path_hash_hex: string;
  size: number;
  compressed_size: number;
  compression: string;
  is_duplicated: boolean;
  unknown: boolean;
}

/** Result of the BIN-driven SKN lookup. The chunk hash is what we
 *  actually feed to MeshPreview; bin_path is kept for debug logs. */
interface SimpleSknRef {
  bin_path: string;
  chunk_hash_hex: string | null;
}


/**
 * Stage 3 of the Viewer — Khada-style model previewer.
 *
 * **Scaffold phase only**: shows a placeholder cube in the canvas and
 * empty accordion sections on the right. Actual model loading + the
 * Information / Animations / Model Parts / Chromas / Options / Export
 * content lands in subsequent passes once the WAD-mount plumbing wires
 * up.
 */
export default function ModelViewerStage({
  selected,
  skin,
  branch,
  mountId,
  active,
  onBack,
  onOpenSkinBinAsText,
  onSendMeshToStudio,
  onExtractStatus,
  onJumpToExtractor,
}: ModelViewerStageProps) {
  // Mount lives in the parent (opened on the gallery → skins
  // transition so the open is already in flight or done by the time
  // the user clicks into the model viewer). All we do here is find
  // the right .skn inside that mount.
  const [skn, setSkn] = useState<WadEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Form switching ────────────────────────────────────────────────
  // Many champions ship "forms" / spawned units as SEPARATE character
  // folders in the same WAD (Elise → elisespider / elisespiderling;
  // Azir → azirsoldier / azirsundisc / …). Each is a fully-loadable
  // character, so we discover them by scanning the mount's resolved
  // entry paths for sibling `characters/<champ-prefix>*/skins/` folders
  // and let the user cycle through them. `forms[0]` is always the base
  // champion; `formIdx` is which one is currently shown.
  interface FormEntry { id: string; label: string }
  const [forms, setForms] = useState<FormEntry[]>([]);
  const [formIdx, setFormIdx] = useState(0);
  const activeCharId = forms[formIdx]?.id ?? selected.entry.id;

  // Animations + parts — populated via callbacks from the controlled
  // MeshPreview once the SKN's skin BIN walk + animation table resolve.
  const [animations, setAnimations] = useState<AnimationListing | null>(null);
  const [selectedAnimationName, setSelectedAnimationName] = useState<string | null>(null);
  const [submeshNames, setSubmeshNames] = useState<string[]>([]);
  // Submesh visibility map. Defaults every part to visible — the user
  // ticks off pieces they want hidden.
  const [submeshVisibility, setSubmeshVisibility] = useState<Record<string, boolean>>({});
  // Playback controls. Cycle order matches MeshPreview's own button
  // (1× → 2× → 0.1× → 0.5× → 1×) so users get the same "tap to speed
  // up first, then explore slowdowns" feel.
  const [playerPaused, setPlayerPaused] = useState(false);
  const [playerSpeed, setPlayerSpeed] = useState(1);
  // Tracks whether we've already auto-picked an idle for this skin so
  // we don't override the user's later choice when state re-syncs.
  const autoIdleAppliedRef = useRef(false);

  // Selected chroma id. `null` = the base skin. MeshPreview's chroma
  // effect picks this up and re-resolves bindings via
  // `wad_read_chroma_textures` — see [MeshPreview.tsx] chroma swap.
  const [selectedChromaId, setSelectedChromaId] = useState<number | null>(null);
  // Shadow-form toggle (Evelynn-style alt diffuse). `shadowAvailable`
  // is reported by MeshPreview after its BIN walk — when false, we
  // hide the toggle entirely.
  const [shadowAvailable, setShadowAvailable] = useState(false);
  const [shadowForm, setShadowForm] = useState(false);
  // Transparency controls. Default to game-accurate-ish values: alpha
  // on, cutoff at 0.2 (the original hardcoded value). Persist as
  // preferences so the user's choice survives session restarts.
  const [transparencyEnabled, setTransparencyEnabled] = useState(true);
  const [alphaCutoff, setAlphaCutoff] = useState(0.2);
  // Splash-art lightbox state — opens when the user clicks "Splashart".
  const [splashOpen, setSplashOpen] = useState(false);
  // STL export plumbing — MeshPreview writes a callable here each
  // render that builds a binary STL of the currently-visible meshes.
  const exportStlRef = useRef<(() => Uint8Array | null) | null>(null);
  // Cache of the most recent per-submesh texture binding MeshPreview
  // resolved (refreshed on chroma swap). Forwarded to the host on
  // Send-to-Photo-Studio so the studio doesn't re-derive bindings.
  const textureBindingsRef = useRef<
    Array<{ submeshName: string; chunkHashHex: string | null }> | null
  >(null);
  // Survives MeshPreview unmount (Babylon teardown on tab-switch) so the
  // camera orbit is restored when the user returns to the Viewer.
  const cameraStateRef = useRef<MeshPreviewCameraState | null>(null);
  // Latest animation frame + pause-state, kept current via onPlayerProgress
  // and read once by MeshPreview on remount to restore a paused shot.
  const playerRestoreRef = useRef<{ time: number; paused: boolean } | null>(null);
  // Animation playback progress (driven by MeshPreview's onPlayerProgress
  // callback) + a seek ref that lets the seek bar scrub the player.
  const [playerTime, setPlayerTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const seekRef = useRef<((time: number) => void) | null>(null);
  const [stlBusy, setStlBusy] = useState(false);
  // WAD / skin-files export state. `repath` is a placeholder until we
  // wire the option through `wad_extract` itself; for now it stays
  // disabled with a tooltip explaining the deferral.
  const [wadBusy, setWadBusy] = useState(false);
  const [skinFilesBusy, setSkinFilesBusy] = useState(false);
  const [repath, setRepath] = useState(false);
  // Quartz-style "fold every linked dep BIN into the primary skin
  // BIN" toggle. Off by default — some workflows want the linked
  // BINs left as separate files (easier to audit). The champion
  // gameplay BIN (`<champ>.bin`) is excluded from this merge
  // unconditionally on the Rust side.
  const [mergeLinked, setMergeLinked] = useState(false);
  // Off by default — opt-in because the icon sweep can add a handful
  // of extra files even when the user doesn't need UI icons in the mod.
  const [preserveHudIcons, setPreserveHudIcons] = useState(false);
  // On by default — repathing audio paths silently breaks sound, and
  // most users don't need their SFX/VO assets remapped anyway.
  const [skipSfxRepath, setSkipSfxRepath] = useState(true);
  // Off by default — voiceover is locale-specific (Akali.en_US.wad.client),
  // most modders work without it. When on, we mount the sibling
  // locale WAD, pull this skin's VO chunks (.wpk/.bnk), and write
  // them into the main extracted folder alongside everything else.
  // BIN refs to VO are repathed in lockstep when repath is on.
  const [exportVo, setExportVo] = useState(false);
  // Collapsible "Advanced options" disclosure for the secondary
  // export modifiers (Merge / HUD / SFX). Repath stays out at the
  // top level since it's the primary toggle most exports touch.
  // Persisted so power users who keep it open stop seeing it
  // collapse every session.
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mv-export-advanced-open') === 'true';
    } catch {
      return false;
    }
  });
  const toggleAdvanced = () => {
    setAdvancedOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('mv-export-advanced-open', String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  useEffect(() => {
    if (mountId === null) {
      // Parent's `wad_open` is still in flight (or failed silently).
      // Surface a load spinner; the effect re-runs when the id lands.
      return;
    }
    let cancelled = false;
    setLoadError(null);
    setSkn(null);
    // BIN-driven SKN lookup — the skin BIN's `simpleSkin: string` is
    // the engine's ground-truth pointer to which .skn to render
    // (covers Rell rider vs. horse, Mel's variants, anything else
    // ambiguous by filename). The backend reads + resolves it for us.
    // `activeCharId` is the base champ or a selected form character.
    const isForm = activeCharId !== selected.entry.id.toLowerCase()
      && activeCharId !== selected.entry.id;
    (async () => {
      // Try the current skin number first; for a form that doesn't ship
      // this skin, fall back to skin 0 (its base) rather than erroring.
      let ref = await invoke<SimpleSknRef | null>('viewer_resolve_skn', {
        id: mountId, champion: activeCharId, skinNum: skin.num,
      });
      if (!ref && isForm && skin.num !== 0) {
        ref = await invoke<SimpleSknRef | null>('viewer_resolve_skn', {
          id: mountId, champion: activeCharId, skinNum: 0,
        });
      }
      if (cancelled) return;
      if (!ref) {
        setLoadError(
          `Couldn't find skin${skin.num}.bin or its simpleSkin field for ${activeCharId}.`,
        );
        return;
      }
      if (!ref.chunk_hash_hex) {
        setLoadError(`Skin BIN points at '${ref.bin_path}' but that .skn isn't in the WAD.`);
        return;
      }
      console.log(`[viewer] BIN-resolved SKN (${activeCharId}): ${ref.bin_path}`);
      setSkn({
        path: ref.bin_path,
        path_hash_hex: ref.chunk_hash_hex,
        size: 0,
        compressed_size: 0,
        compression: 'unknown',
        is_duplicated: false,
        unknown: false,
      });
    })().catch((err: unknown) => {
      if (cancelled) return;
      setLoadError(typeof err === 'string' ? err : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [mountId, skin.num, selected.entry.id, activeCharId]);

  // Discover related characters (forms / spawned units) in the mounted
  // WAD by scanning resolved entry paths for `characters/<prefix>*`
  // siblings. Runs once per champ/mount; resets the selection to base.
  useEffect(() => {
    if (mountId === null) { setForms([]); setFormIdx(0); return; }
    const base = selected.entry.id.toLowerCase();
    let cancelled = false;
    setFormIdx(0);
    (async () => {
      try {
        const entries = await invoke<WadEntry[]>('wad_list_entries', { id: mountId });
        if (cancelled) return;
        // Match `(assets|data)/characters/<name>/skins/` and keep names
        // that start with the base champ id (the form-prefix convention).
        const charRe = /(?:assets|data)\/characters\/([a-z0-9_]+)\/skins\//i;
        const found = new Set<string>();
        for (const e of entries) {
          const m = charRe.exec(e.path.replace(/\\/g, '/').toLowerCase());
          if (!m) continue;
          const name = m[1];
          if (name === base || name.startsWith(base)) found.add(name);
        }
        found.add(base); // base is always present
        // Base first, then the rest alphabetically by their suffix.
        const others = Array.from(found).filter(n => n !== base).sort();
        const ordered = [base, ...others];
        const labelFor = (id: string): string => {
          if (id === base) return 'Base';
          const suffix = id.startsWith(base) ? id.slice(base.length) : id;
          return (suffix || id).replace(/^[_-]+/, '').replace(/\b\w/g, c => c.toUpperCase()) || id;
        };
        setForms(ordered.map(id => ({ id, label: labelFor(id) })));
      } catch {
        if (!cancelled) setForms([]);
      }
    })();
    return () => { cancelled = true; };
  }, [mountId, selected.entry.id]);

  const portraitUrl = getChampionCircleUrl(selected.cdChamp.alias, branch);
  const portraitBlob = getCachedImageUrl(portraitUrl);

  // Reset transient panel state whenever the skin/champ changes so the
  // accordion never displays stale animation/part data from a previous
  // selection while the new one is still loading.
  useEffect(() => {
    setAnimations(null);
    setSelectedAnimationName(null);
    setSubmeshNames([]);
    setSubmeshVisibility({});
    setPlayerPaused(false);
    setPlayerSpeed(1);
    autoIdleAppliedRef.current = false;
    setSelectedChromaId(null);
    setShadowAvailable(false);
    setShadowForm(false);
  }, [selected.entry.wad_path, skin.num, activeCharId]);

  // Auto-pick an idle clip the first time the animation listing lands
  // for a skin. Scoring approach because the simple "first clip with
  // 'idle' in the name" picks transitional / variant idles instead of
  // the canonical loop — e.g. `Idle1_Base` is the right one but the
  // exact-match chain we used to have missed it and the fallback
  // grabbed `CombatIdle_to_NoncombatIdle` because that string also
  // contains "idle". Each clip gets a numeric score; highest wins.
  useEffect(() => {
    if (autoIdleAppliedRef.current) return;
    if (!animations || animations.clips.length === 0) return;
    let best = animations.clips[0];
    let bestScore = -Infinity;
    for (const c of animations.clips) {
      const score = scoreIdleClip(c.name);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    setSelectedAnimationName(best.name);
    autoIdleAppliedRef.current = true;
  }, [animations]);

  // Animation navigation — prev/next walk the clip list cyclically.
  const clips = animations?.clips ?? [];
  const selectedClipIdx = useMemo(() => {
    if (!selectedAnimationName) return -1;
    return clips.findIndex((c) => c.name === selectedAnimationName);
  }, [clips, selectedAnimationName]);

  const stepAnimation = (dir: 1 | -1) => {
    if (clips.length === 0) return;
    const base = selectedClipIdx >= 0 ? selectedClipIdx : 0;
    const next = (base + dir + clips.length) % clips.length;
    setSelectedAnimationName(clips[next].name);
  };

  const cycleSpeed = () => {
    const order = [1, 2, 0.1, 0.5];
    const idx = order.indexOf(playerSpeed);
    setPlayerSpeed(order[(idx + 1) % order.length] ?? 1);
  };

  // Two "show in Extract" jumps — both flip the welcome view over to
  // Extract Files and pre-navigate to a path inside the same WAD.
  // When a chroma is selected we point at *its* skinNN slot, not the
  // parent skin's — chromas live in their own data/characters/...
  // skin{N}.bin file + assets folder (`chroma_id % 1000`).
  const champLower = selected.entry.id.toLowerCase();
  const effectiveSkinNum =
    selectedChromaId !== null ? selectedChromaId % 1000 : skin.num;
  const skinFolder = effectiveSkinNum === 0 ? 'base' : `skin${effectiveSkinNum}`;

  const jumpToBinInExtractor = () => {
    if (!onJumpToExtractor) return;
    onJumpToExtractor({
      wadPath: selected.entry.wad_path,
      subPath: `data/characters/${champLower}/skins/skin${effectiveSkinNum}.bin`,
      mode: 'file',
    });
  };

  const jumpToSkinFilesInExtractor = () => {
    if (!onJumpToExtractor) return;
    onJumpToExtractor({
      wadPath: selected.entry.wad_path,
      subPath: `assets/characters/${champLower}/skins/${skinFolder}`,
      mode: 'folder',
    });
  };

  const openSkinBinInEditor = async () => {
    if (mountId === null || !onOpenSkinBinAsText) return;
    try {
      const res = await invoke<{ bin_path: string; bytes: number[] } | null>(
        'viewer_read_skin_bin',
        {
          id: mountId,
          champion: selected.entry.id,
          skinNum: skin.num,
        },
      );
      if (!res) {
        console.warn('[viewer] skin BIN not found in mount');
        return;
      }
      const text = await invoke<string>('convert_bin_bytes_to_text', {
        binData: res.bytes,
      });
      // Strip directories, keep the .bin name — same convention the
      // tab bar uses for synthetic file names.
      const fileName =
        res.bin_path.split('/').pop() ?? `${selected.entry.id}_skin${skin.num}.bin`;
      onOpenSkinBinAsText(text, fileName);
    } catch (e) {
      console.warn('[viewer] open-in-bin-editor failed:', e);
    }
  };

  // Prompt for a destination folder and run the existing wad_extract
  // pipeline. Shared by Export WAD (no filter — every chunk) and
  // Export skin files (filtered to the skin's folder).
  const runExtract = async (
    selectedHashes: string[] | null,
    label: string,
  ): Promise<boolean> => {
    if (mountId === null) return false;
    const picked = await openDirDialogFromPlugin({
      directory: true,
      multiple: false,
      title: `Choose output folder for ${label}`,
    });
    if (!picked || typeof picked !== 'string') return false;
    try {
      const actionId = `viewer-${Date.now()}`;
      onExtractStatus?.(`Extracting ${label}…`);
      const result = await invoke<{ written: number; errors: number }>('wad_extract', {
        id: mountId,
        outputDir: picked,
        actionId,
        selectedHashes,
        useRename: true,
        flatten: false,
      });
      const errorTail = result.errors > 0 ? ` (${result.errors} errors)` : '';
      onExtractStatus?.(`Extracted ${result.written} file${result.written === 1 ? '' : 's'} from ${label}${errorTail}`);
      console.log(`[viewer] extracted ${label} to ${picked}`, result);
      return true;
    } catch (e) {
      onExtractStatus?.(`Extract failed: ${e}`);
      console.warn(`[viewer] ${label} extract failed:`, e);
      return false;
    }
  };

  const exportFullWad = async () => {
    if (mountId === null) return;
    setWadBusy(true);
    try {
      await runExtract(null, 'full WAD');
    } finally {
      setWadBusy(false);
    }
  };

  const exportSkinFiles = async () => {
    if (mountId === null || !skn) return;
    setSkinFilesBusy(true);
    // When a chroma is active, extract IT (its skin{N}.bin + textures),
    // written over the parent skin slot — otherwise the parent skin's
    // base textures come out instead of the chroma the user is viewing.
    const chromaSkinNum =
      selectedChromaId !== null ? selectedChromaId % 1000 : null;
    const label = chromaSkinNum !== null
      ? `${selected.cdChamp.name} skin${skin.num} chroma`
      : `${selected.cdChamp.name} skin${skin.num}`;
    // Hoisted so the `finally` block can unmount whichever locale
    // WAD we opened for VO, even if extraction throws.
    let voMountId: number | null = null;
    try {
      const picked = await openDirDialogFromPlugin({
        directory: true,
        multiple: false,
        title: `Choose output folder for ${label}`,
      });
      if (!picked || typeof picked !== 'string') return;
      // Pull the user's relevant extraction prefs in parallel — the
      // repath prefix, and whether to nest output under a WAD-name
      // folder. Both live under the same keys WelcomeScreen reads.
      let prefix = 'jade';
      let makeWadFolder = true;
      try {
        const [vPrefix, vWadFolder] = await Promise.all([
          invoke<string>('get_preference', {
            key: 'WadRepathPrefix',
            defaultValue: 'jade',
          }),
          invoke<string>('get_preference', {
            key: 'WadMakeWadFolder',
            defaultValue: 'True',
          }),
        ]);
        prefix = (vPrefix || 'jade').trim();
        makeWadFolder = vWadFolder === 'True';
      } catch { /* keep defaults */ }

      // WAD folder name = champion id (lowercased), matching the
      // convention WelcomeScreen's "Create WAD-name folder" uses
      // when invoking `wad_extract`.
      const wadFolderName = makeWadFolder
        ? selected.entry.id.toLowerCase()
        : null;

      // Resolve + mount the locale VO WAD when the user opted into
      // exporting voiceover. Mirrors the same `<base>.<locale>.<ext>`
      // sibling lookup the WelcomeScreen's VO switcher uses. We mount
      // here and unmount in `finally` so the locale mount is gone as
      // soon as extraction finishes.
      if (exportVo) {
        try {
          const mainPath = selected.entry.wad_path;
          const norm = mainPath.replace(/\\/g, '/');
          const slash = norm.lastIndexOf('/');
          const dir = slash === -1 ? '' : mainPath.slice(0, slash);
          const baseName = slash === -1 ? mainPath : mainPath.slice(slash + 1);
          const tailMatch = baseName.match(/(\.wad(?:\.(?:client|mobile))?)$/i);
          console.log('[viewer] export VO: discovery', { mainPath, dir, baseName, tail: tailMatch?.[1] });
          if (tailMatch) {
            const stem = baseName.slice(0, baseName.length - tailMatch[1].length);
            const tail = tailMatch[1];
            const prefix2 = `${stem}.`;
            const entries = await invoke<{ name: string; is_dir: boolean; path: string }[]>(
              'list_directory',
              { path: dir },
            ).catch((err) => {
              console.warn('[viewer] export VO: list_directory failed:', err);
              return [] as { name: string; is_dir: boolean; path: string }[];
            });
            const candidates = entries.filter(
              (e) => !e.is_dir && e.name.startsWith(prefix2) && e.name.endsWith(tail)
            );
            console.log('[viewer] export VO: candidate siblings', candidates.map(c => c.name));
            let localePath: string | null = null;
            for (const e of candidates) {
              const inner = e.name.slice(prefix2.length, e.name.length - tail.length);
              if (/^[a-z]{2}_[a-z]{2}$/i.test(inner)) {
                localePath = e.path;
                console.log('[viewer] export VO: picked locale WAD', e.path, 'locale =', inner);
                break;
              }
            }
            if (localePath) {
              const opened = await invoke<{ id: number; chunk_count: number }>('wad_open', {
                path: localePath,
              });
              voMountId = opened.id;
              console.log('[viewer] export VO: mounted', { id: opened.id, chunks: opened.chunk_count });
            } else {
              console.warn('[viewer] export VO: no locale WAD found next to', mainPath);
            }
          } else {
            console.warn('[viewer] export VO: main WAD name does not match expected tail pattern:', baseName);
          }
        } catch (e) {
          console.warn('[viewer] export VO: locale WAD mount failed:', e);
        }
      }

      const actionId = `viewer-skin-${Date.now()}`;
      const flags: string[] = [];
      if (repath) flags.push('repath');
      if (mergeLinked) flags.push('merged');
      if (exportVo && voMountId !== null) flags.push('VO');
      const flagTail = flags.length > 0 ? ` (${flags.join(', ')})` : '';
      onExtractStatus?.(`Extracting ${label}${flagTail}…`);
      const result = await invoke<{
        written: number;
        errors: number;
        skipped: number;
        cancelled: boolean;
        error_messages: string[];
        renames: { original: string; renamed: string }[];
      }>(
        'wad_extract_skin_assets',
        {
          id: mountId,
          outputDir: picked,
          actionId,
          sknChunkHashHex: skn.path_hash_hex,
          repath,
          repathPrefix: prefix,
          wadFolderName,
          mergeLinked,
          preserveHudIcons,
          skipSfxRepath,
          exportVo,
          voMountId,
          chromaSkinNum,
        },
      );
      const errorTail = result.errors > 0 ? ` (${result.errors} errors — see console)` : '';
      const renameTail = result.renames && result.renames.length > 0
        ? ` · ${result.renames.length} long-path renames (see _jade_rename_map.json)`
        : '';
      onExtractStatus?.(
        `Extracted ${result.written} file${result.written === 1 ? '' : 's'} from ${label}${errorTail}${renameTail}`,
      );
      console.log(`[viewer] extracted ${label} to ${picked}`, result);
      // Surface per-chunk failures so they aren't silently buried —
      // the user explicitly asked for the error texts to land in the
      // devtools console.
      if (result.error_messages && result.error_messages.length > 0) {
        console.group(`[viewer] ${label} — ${result.error_messages.length} chunk errors`);
        for (const line of result.error_messages) console.warn(line);
        console.groupEnd();
      }
      if (result.renames && result.renames.length > 0) {
        console.group(`[viewer] ${label} — ${result.renames.length} long-path renames`);
        for (const { original, renamed } of result.renames) {
          console.info(`${original}  →  ${renamed}`);
        }
        console.groupEnd();
      }
      // Status text auto-clears via the host's `wad-extract-progress`
      // listener — it fires a 2s reset after the Rust side emits the
      // `complete` phase. No JS timeout needed on the happy path.
    } catch (e) {
      onExtractStatus?.(`Extract failed: ${e}`);
      console.warn('[viewer] skin-files export failed:', e);
      // Error path doesn't emit a `complete` event, so clear manually.
      setTimeout(() => onExtractStatus?.(null), 6000);
    } finally {
      // Unmount the locale VO WAD we opened for this export. Fire
      // and forget — failure here only leaves a mount handle around.
      if (voMountId !== null) {
        invoke('wad_close', { id: voMountId }).catch(() => {});
      }
      setSkinFilesBusy(false);
    }
  };

  const exportStl = async () => {
    const build = exportStlRef.current;
    if (!build) return;
    setStlBusy(true);
    try {
      const bytes = build();
      if (!bytes) {
        console.warn('[viewer] STL export produced no geometry');
        return;
      }
      const defaultName = `${selected.cdChamp.alias.toLowerCase()}_skin${skin.num}.stl`;
      const picked = await saveDialog({
        title: 'Export STL',
        defaultPath: defaultName,
        filters: [{ name: 'STL mesh', extensions: ['stl'] }],
      });
      if (!picked || typeof picked !== 'string') return;
      // Tauri's invoke can pass typed arrays to the Rust side as Vec<u8>
      // — same wire we use for write_bytes_file in the BIN converter.
      await invoke('write_bytes_file', { path: picked, bytes: Array.from(bytes) });
      console.log(`[viewer] wrote STL (${bytes.byteLength} bytes) to ${picked}`);
    } catch (e) {
      console.warn('[viewer] STL export failed:', e);
    } finally {
      setStlBusy(false);
    }
  };

  const toggleSubmesh = (name: string) => {
    setSubmeshVisibility((prev) => {
      const cur = prev[name];
      const visible = cur === undefined ? true : cur;
      return { ...prev, [name]: !visible };
    });
  };

  const setAllSubmeshes = (visible: boolean) => {
    setSubmeshVisibility(() => {
      const next: Record<string, boolean> = {};
      for (const n of submeshNames) next[n] = visible;
      return next;
    });
  };

  return (
    <div className="viewer-tab mv-stage">
      <header className="viewer-header viewer-header-detail">
        <button
          type="button"
          className="viewer-back-btn"
          onClick={onBack}
          title="Back to skins"
        >
          <ChevronLeft size={16} />
          <span>Skins</span>
        </button>
        <span className="viewer-breadcrumb-pill" title={selected.cdChamp.name}>
          {selected.cdChamp.name}
        </span>
        {/* Skin pill — tracks the active chroma so the number matches
            which `skinNN.bin` is actually being rendered. */}
        <span
          className="viewer-breadcrumb-pill"
          title={skin.name}
        >
          skin{effectiveSkinNum}
        </span>
      </header>

      <div className="mv-body">
        <div className="mv-canvas-wrap">
          {loadError ? (
            <div className="mv-state mv-state-error">{loadError}</div>
          ) : !mountId || !skn ? (
            <div className="mv-state">Loading model…</div>
          ) : !active ? (
            // Viewer not visible — tear Babylon down to free the GPU
            // scene. All selection/animation/pause/camera state is held
            // in React state + refs here, so it restores on return.
            <div className="mv-state" />
          ) : (
            <MeshPreview
              cameraStateRef={cameraStateRef}
              playerRestoreRef={playerRestoreRef}
              source={{ kind: 'wad', mountId, pathHashHex: skn.path_hash_hex }}
              label={`${selected.cdChamp.name} — skin${skin.num}`}
              controlled
              selectedAnimationName={selectedAnimationName}
              submeshVisibility={submeshVisibility}
              playerPaused={playerPaused}
              playerSpeed={playerSpeed}
              chromaId={selectedChromaId}
              shadowForm={shadowForm}
              onShadowAvailable={setShadowAvailable}
              onTextureBindingsReady={(entries) => {
                textureBindingsRef.current = entries;
              }}
              transparencyEnabled={transparencyEnabled}
              alphaCutoff={alphaCutoff}
              exportStlRef={exportStlRef}
              seekRef={seekRef}
              onPlayerProgress={(p) => {
                setPlayerTime(p.time);
                setPlayerDuration(p.duration);
                // Keep the restore snapshot current so a tab-switch
                // (MeshPreview unmount) preserves the exact frame + pause.
                playerRestoreRef.current = { time: p.time, paused: p.paused };
              }}
              onAnimationsLoaded={(a) => setAnimations(a)}
              onSubmeshesLoaded={(names) => {
                setSubmeshNames(names);
                setSubmeshVisibility((prev) => {
                  // Initialise every newly-discovered submesh to visible.
                  // Preserve any explicit toggles the user already made
                  // (shouldn't happen on first load but cheap to keep).
                  const next: Record<string, boolean> = { ...prev };
                  for (const n of names) {
                    if (next[n] === undefined) next[n] = true;
                  }
                  return next;
                });
              }}
            />
          )}
        </div>

        <aside className="mv-rail">
          <Accordion>
            <AccordionSection
              id="information"
              title="Information"
              icon={Info}
              defaultOpen
              prefKey="ViewerAccordion"
            >
              <div className="mv-info">
                <div className="mv-info-portrait">
                  {portraitBlob ? (
                    <img src={portraitBlob} alt="" draggable={false} />
                  ) : (
                    <span className="viewer-tile-letter">
                      {selected.cdChamp.name[0]?.toUpperCase() ?? '?'}
                    </span>
                  )}
                </div>
                <div className="mv-info-text">
                  <div className="mv-info-name">{selected.cdChamp.name}</div>
                  <div className="mv-info-id">{selected.entry.id}</div>
                </div>
              </div>
              <div className="mv-info-actions">
                <button
                  type="button"
                  className="mv-info-btn"
                  onClick={() => setSplashOpen(true)}
                  disabled={!skin.splashPath && !skin.uncenteredSplashPath}
                  title="Open full splash art"
                >
                  Splashart
                </button>
                <button
                  type="button"
                  className="mv-info-btn"
                  onClick={() => {
                    const q = encodeURIComponent(
                      `${selected.cdChamp.name} ${skin.name} spotlight`,
                    );
                    window.open(
                      `https://www.youtube.com/results?search_query=${q}`,
                      '_blank',
                      'noopener,noreferrer',
                    );
                  }}
                  title="Search YouTube for a spotlight video"
                >
                  Spotlight
                </button>
                <button
                  type="button"
                  className="mv-info-btn"
                  onClick={() => {
                    const slug = selected.cdChamp.name.replace(/\s+/g, '_');
                    window.open(
                      `https://leagueoflegends.fandom.com/wiki/${encodeURIComponent(slug)}`,
                      '_blank',
                      'noopener,noreferrer',
                    );
                  }}
                  title="Open the League wiki entry"
                >
                  Wiki
                </button>
              </div>
            </AccordionSection>

            <AccordionSection
              id="animations"
              title="Animations"
              icon={Clapperboard}
              defaultOpen
              prefKey="ViewerAccordion"
              trailing={clips.length > 0 ? `${clips.length}` : undefined}
            >
              {clips.length === 0 ? (
                <div className="mv-placeholder">
                  {animations === null ? 'Loading…' : 'None available.'}
                </div>
              ) : (
                <>
                  <div className="mv-anim-row">
                    <button
                      type="button"
                      className="mv-anim-step"
                      onClick={() => stepAnimation(-1)}
                      title="Previous animation"
                    >
                      <PrevIcon size={14} />
                    </button>
                    <AnimationDropdown
                      clips={clips}
                      selected={selectedAnimationName}
                      onPick={setSelectedAnimationName}
                    />
                    <button
                      type="button"
                      className="mv-anim-step"
                      onClick={() => stepAnimation(1)}
                      title="Next animation"
                    >
                      <NextIcon size={14} />
                    </button>
                  </div>
                  {selectedAnimationName && (
                    <>
                      <div className="mv-anim-controls">
                        <button
                          type="button"
                          className="mv-anim-step"
                          onClick={() => setPlayerPaused((p) => !p)}
                          title={playerPaused ? 'Play' : 'Pause'}
                        >
                          {playerPaused ? <Play size={14} /> : <Pause size={14} />}
                        </button>
                        <input
                          type="range"
                          className="mv-anim-scrub"
                          min={0}
                          max={Math.max(0.0001, playerDuration)}
                          step={playerDuration > 0 ? playerDuration / 500 : 0.001}
                          value={playerTime}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setPlayerTime(v);
                            seekRef.current?.(v);
                          }}
                          disabled={playerDuration <= 0}
                        />
                        <span className="mv-anim-time">
                          {formatClock(playerTime)} / {formatClock(playerDuration)}
                        </span>
                      </div>
                      <div className="mv-anim-controls">
                        <button
                          type="button"
                          className="mv-anim-speed"
                          onClick={cycleSpeed}
                          title="Cycle playback speed"
                        >
                          {playerSpeed}×
                        </button>
                        <button
                          type="button"
                          className="mv-anim-clear"
                          onClick={() => setSelectedAnimationName(null)}
                        >
                          Stop
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </AccordionSection>

            <AccordionSection
              id="modelParts"
              title="Model Parts"
              icon={Layers}
              prefKey="ViewerAccordion"
              trailing={
                submeshNames.length > 0
                  ? `${submeshNames.filter((n) => submeshVisibility[n] !== false).length}/${submeshNames.length}`
                  : undefined
              }
            >
              {submeshNames.length === 0 ? (
                <div className="mv-placeholder">Loading…</div>
              ) : (
                <>
                  <ul className="mv-parts-list">
                    {submeshNames.map((name) => {
                      const visible = submeshVisibility[name] !== false;
                      return (
                        <li key={name} className="mv-parts-row">
                          <label className="mv-parts-label">
                            <input
                              type="checkbox"
                              checked={visible}
                              onChange={() => toggleSubmesh(name)}
                            />
                            <span className="mv-parts-name" title={name}>
                              {name}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mv-parts-actions">
                    <button
                      type="button"
                      className="mv-info-btn"
                      onClick={() => setAllSubmeshes(true)}
                    >
                      Show all
                    </button>
                    <button
                      type="button"
                      className="mv-info-btn"
                      onClick={() => setAllSubmeshes(false)}
                    >
                      Hide all
                    </button>
                  </div>
                </>
              )}
            </AccordionSection>

            {(skin.chromas && skin.chromas.length > 0) && (
              <AccordionSection
                id="chromas"
                title="Chromas"
                icon={Palette}
                prefKey="ViewerAccordion"
                trailing={`${skin.chromas.length}`}
              >
                <div className="mv-chroma-grid">
                  {/* Base skin first — leftmost tile, uses the skin's
                      own tile/splash art since CDragon's chroma-icon
                      endpoint has no entry for the base. */}
                  <ChromaTile
                    label={skin.isBase ? 'Base' : skin.name}
                    imageUrl={
                      skin.tilePath
                        ? resolveAsset(skin.tilePath, branch)
                        : skin.splashPath
                          ? resolveAsset(skin.splashPath, branch)
                          : null
                    }
                    active={selectedChromaId === null}
                    onClick={() => setSelectedChromaId(null)}
                  />
                  {skin.chromas.map((c) => (
                    <ChromaTile
                      key={c.id}
                      label={c.name}
                      imageUrl={getChromaIconUrl(selected.cdChamp.id, c.id, branch)}
                      active={selectedChromaId === c.id}
                      onClick={() => setSelectedChromaId(c.id)}
                      colors={c.colors}
                    />
                  ))}
                </div>
              </AccordionSection>
            )}

            <AccordionSection
              id="options"
              title="Options"
              icon={SettingsIcon}
              prefKey="ViewerAccordion"
            >
              {forms.length > 1 && (
                <button
                  type="button"
                  className="mv-info-btn mv-form-cycle-btn"
                  onClick={() => setFormIdx(i => (i + 1) % forms.length)}
                  title="Cycle through this champion's forms / spawned units (e.g. Elise spider, Azir soldiers)"
                >
                  <FormCycleIcon size={14} />
                  <span className="mv-form-cycle-label">
                    Form: {forms[formIdx]?.label ?? 'Base'}
                  </span>
                  <span className="mv-form-cycle-count">
                    {formIdx + 1}/{forms.length}
                  </span>
                </button>
              )}
              <label className="mv-option-row">
                <input
                  type="checkbox"
                  checked={transparencyEnabled}
                  onChange={(e) => setTransparencyEnabled(e.target.checked)}
                />
                <span>Transparency</span>
              </label>
              {transparencyEnabled && (
                <div className="mv-option-slider">
                  <div className="mv-option-slider-label">
                    <span>Alpha cutoff</span>
                    <span className="mv-option-slider-value">{alphaCutoff.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={alphaCutoff}
                    onChange={(e) => setAlphaCutoff(parseFloat(e.target.value))}
                  />
                </div>
              )}
              {shadowAvailable && (
                <label className="mv-option-row">
                  <input
                    type="checkbox"
                    checked={shadowForm}
                    onChange={(e) => setShadowForm(e.target.checked)}
                  />
                  <span>Shadow form</span>
                </label>
              )}
            </AccordionSection>

            <AccordionSection
              id="export"
              title="Export"
              icon={Upload}
              prefKey="ViewerAccordion"
            >
              <div className="mv-export-list">
                <button
                  type="button"
                  className="mv-info-btn mv-export-btn"
                  onClick={exportSkinFiles}
                  disabled={skinFilesBusy || mountId === null}
                  title="Extract every WAD chunk that belongs to this skin (mesh, BIN, textures, particles) to a folder"
                >
                  <FolderArchive size={14} />
                  <span>{skinFilesBusy ? 'Extracting…' : 'Export skin files'}</span>
                </button>
                <label
                  className={`mv-export-repath${repath ? ' on' : ''}`}
                  title="Insert a prefix folder under assets/ and data/ (set in Extraction Settings → Repath prefix). BIN strings are rewritten in lockstep so the mod still loads."
                >
                  <input
                    type="checkbox"
                    checked={repath}
                    onChange={(e) => setRepath(e.target.checked)}
                  />
                  <span>Repath into wad-style folders</span>
                </label>
                <button
                  type="button"
                  className={`mv-export-advanced-toggle${advancedOpen ? ' open' : ''}`}
                  onClick={toggleAdvanced}
                  aria-expanded={advancedOpen}
                >
                  <ChevronDown size={12} className="mv-export-advanced-chevron" />
                  <span>Advanced options</span>
                </button>
                {advancedOpen && (
                  <div className="mv-export-advanced">
                    <label
                      className={`mv-export-repath${mergeLinked ? ' on' : ''}`}
                      title="Fold every linked dependency BIN into the primary skin BIN — the mod ships with one consolidated BIN instead of a chain of linked files. The champion's gameplay BIN is never merged."
                    >
                      <input
                        type="checkbox"
                        checked={mergeLinked}
                        onChange={(e) => setMergeLinked(e.target.checked)}
                      />
                      <span>Merge linked BINs into one</span>
                    </label>
                    <label
                      className={`mv-export-repath${preserveHudIcons ? ' on' : ''}`}
                      title="On: include every assets/characters/<champ>/hud/icons2d/ file and keep BIN refs canonical (no repath). Off: skip HUD icons entirely — they aren't extracted and the game falls back to Riot's installed icons."
                    >
                      <input
                        type="checkbox"
                        checked={preserveHudIcons}
                        onChange={(e) => setPreserveHudIcons(e.target.checked)}
                      />
                      <span>Preserve HUD icons</span>
                    </label>
                    <label
                      className={`mv-export-repath${skipSfxRepath ? ' on' : ''}`}
                      title="On: skip SFX/VO files entirely — assets/sounds/ and assets/audio/ are NOT extracted, BIN refs stay canonical, game uses Riot's installed audio. Off: include audio files and repath them along with the rest of the mod."
                    >
                      <input
                        type="checkbox"
                        checked={skipSfxRepath}
                        onChange={(e) => setSkipSfxRepath(e.target.checked)}
                      />
                      <span>Skip SFX/VO</span>
                    </label>
                    <label
                      className={`mv-export-repath${exportVo ? ' on' : ''}`}
                      title="On: open the sibling locale VO WAD (e.g. Akali.en_US.wad.client) and pull this skin's voiceover .wpk / .bnk files into the main extracted folder. BIN VO refs get repathed alongside them when repath is on."
                    >
                      <input
                        type="checkbox"
                        checked={exportVo}
                        onChange={(e) => setExportVo(e.target.checked)}
                      />
                      <span>Export VO and events</span>
                    </label>
                  </div>
                )}
                <button
                  type="button"
                  className="mv-info-btn mv-export-btn"
                  onClick={exportFullWad}
                  disabled={wadBusy || mountId === null}
                  title="Extract the entire champion WAD to a folder"
                >
                  <PackageIcon size={14} />
                  <span>{wadBusy ? 'Extracting…' : 'Export WAD'}</span>
                </button>
                <button
                  type="button"
                  className="mv-info-btn mv-export-btn"
                  onClick={exportStl}
                  disabled={stlBusy}
                  title="Export the current mesh as a binary STL"
                >
                  <BoxIcon size={14} />
                  <span>{stlBusy ? 'Exporting…' : 'Export STL'}</span>
                </button>

                {/* Quick jumps over to the Extract tab. Don't extract
                    anything themselves — they just pre-navigate the
                    file browser. Sit side-by-side as a pair since both
                    target the same WAD, just different sub-paths. */}
                <div className="mv-export-pair">
                  <button
                    type="button"
                    className="mv-info-btn mv-export-btn"
                    onClick={jumpToBinInExtractor}
                    disabled={!onJumpToExtractor || mountId === null}
                    title="Open this skin's .bin in the Extract Files tab"
                  >
                    <ExternalLink size={14} />
                    <span>Show BIN</span>
                  </button>
                  <button
                    type="button"
                    className="mv-info-btn mv-export-btn"
                    onClick={jumpToSkinFilesInExtractor}
                    disabled={!onJumpToExtractor || mountId === null}
                    title="Open this skin's folder in the Extract Files tab"
                  >
                    <FolderOpenIcon size={14} />
                    <span>Show files</span>
                  </button>
                </div>
                <button
                  type="button"
                  className="mv-info-btn mv-export-btn"
                  onClick={openSkinBinInEditor}
                  disabled={!onOpenSkinBinAsText || mountId === null}
                  title="Open this skin's .bin in the editor"
                >
                  <FileCode size={14} />
                  <span>Open in BIN editor</span>
                </button>
                <button
                  type="button"
                  className="mv-info-btn mv-export-btn"
                  onClick={() => {
                    if (!onSendMeshToStudio || mountId === null || !skn) return;
                    // Mesh + anims come from the PARENT skin (chromas
                    // reuse the parent SKN). When a chroma is active
                    // we also pass its skinNum so the host can swap
                    // the parent BIN out for the chroma BIN on disk
                    // — that way the disk texture pipeline reads the
                    // chroma's material refs instead of the parent's.
                    const chromaOverride =
                      selectedChromaId !== null ? selectedChromaId % 1000 : null;
                    onSendMeshToStudio(
                      mountId,
                      skn.path_hash_hex,
                      selected.entry.id,
                      skin.num,
                      `${selected.cdChamp.name} — skin${effectiveSkinNum}`,
                      shadowForm,
                      chromaOverride,
                      textureBindingsRef.current,
                    );
                  }}
                  disabled={!onSendMeshToStudio || mountId === null || !skn}
                  title="Add this mesh to a Photo Studio scene"
                >
                  <CameraIcon size={14} />
                  <span>Send to Photo Studio</span>
                </button>
              </div>
            </AccordionSection>
          </Accordion>
        </aside>
      </div>

      {splashOpen && (() => {
        // Pick the best-available splash path, preferring the wide
        // uncentered one for the lightbox so it fills the viewport.
        const splashRel = skin.uncenteredSplashPath ?? skin.splashPath;
        if (!splashRel) return null;
        return (
          <SplashLightbox
            url={resolveAsset(splashRel, branch)}
            label={skin.name}
            onClose={() => setSplashOpen(false)}
          />
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------
// AnimationDropdown — themed replacement for the native <select> so the
// picker matches the app's chrome. Includes an inline filter so users
// can narrow long Riot clip lists (50+ entries on most champions).
// Closes on outside click / Escape / option pick.
// ---------------------------------------------------------------------
interface AnimationDropdownProps {
  clips: { name: string }[];
  selected: string | null;
  onPick: (name: string | null) => void;
}

function AnimationDropdown({ clips, selected, onPick }: AnimationDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Fixed-position rect for the portal menu — recomputed on open and
  // on scroll/resize so the menu stays glued to the trigger as the
  // user pans the accordion or resizes the window.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number }>(
    { top: 0, left: 0, width: 0 },
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return clips;
    const q = query.toLowerCase();
    return clips.filter((c) => c.name.toLowerCase().includes(q));
  }, [clips, query]);

  const updateMenuPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
  }, []);

  // Position the menu when it opens; track scroll/resize so it stays
  // anchored to the trigger as the surrounding layout shifts.
  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPos();
    const onScroll = () => updateMenuPos();
    const onResize = () => updateMenuPos();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, updateMenuPos]);

  // Close on outside click + Escape. Focus the search on open so the
  // user can just start typing without an extra click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    queueMicrotask(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the filter every time the menu closes — re-opening on the
  // same selection should land fresh rather than remembering a stale
  // query from earlier.
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  return (
    <div className="mv-anim-dd">
      <button
        ref={triggerRef}
        type="button"
        className={`mv-anim-dd-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mv-anim-dd-value">
          {selected ?? '— Pick an animation —'}
        </span>
        <ChevronDown size={14} className="mv-anim-dd-caret" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="mv-anim-dd-menu"
          role="listbox"
          style={{
            position: 'fixed',
            top: `${menuPos.top}px`,
            left: `${menuPos.left}px`,
            width: `${menuPos.width}px`,
          }}
        >
          <div className="mv-anim-dd-search">
            <SearchIcon size={12} className="mv-anim-dd-search-icon" />
            <input
              ref={searchRef}
              type="text"
              className="mv-anim-dd-search-input"
              placeholder="Filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length > 0) {
                  onPick(filtered[0].name);
                  close();
                }
              }}
            />
          </div>
          <div className="mv-anim-dd-list">
            {filtered.length === 0 ? (
              <div className="mv-anim-dd-empty">No clips match “{query}”.</div>
            ) : (
              filtered.map((c) => {
                const isSelected = c.name === selected;
                return (
                  <button
                    key={c.name}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`mv-anim-dd-item${isSelected ? ' is-selected' : ''}`}
                    onClick={() => {
                      onPick(c.name);
                      close();
                    }}
                  >
                    {c.name}
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface SplashLightboxProps {
  url: string;
  label: string;
  onClose: () => void;
}

function SplashLightbox({ url, label, onClose }: SplashLightboxProps) {
  // Esc closes the lightbox. Backdrop click does too. Plain
  // implementation — no portal / focus-trap; the modal's brief enough
  // that the trade-offs don't pay off.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="mv-lightbox" onClick={onClose}>
      <button
        type="button"
        className="mv-lightbox-close"
        onClick={onClose}
        aria-label="Close"
      >
        <CloseIcon size={18} />
      </button>
      <div className="mv-lightbox-stage" onClick={(e) => e.stopPropagation()}>
        <img src={url} alt={label} draggable={false} />
        <div className="mv-lightbox-caption">{label}</div>
      </div>
    </div>
  );
}

interface ChromaTileProps {
  label: string;
  imageUrl: string | null;
  active: boolean;
  onClick: () => void;
  /** Optional chroma color list (`#rrggbb` strings) — when set we show
   *  a fallback split-color square if the image hasn't resolved yet. */
  colors?: string[];
}

function ChromaTile({ label, imageUrl, active, onClick, colors }: ChromaTileProps) {
  // Preload + memoize the blob so the tile doesn't re-fetch on rerenders.
  // Identical pipeline to the champion gallery preloader.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!imageUrl) return;
    let cancelled = false;
    preloadImage(imageUrl)
      .then(() => {
        if (!cancelled) setTick((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const blob = imageUrl ? getCachedImageUrl(imageUrl) : null;
  const fallback = !blob && colors && colors.length > 0
    ? `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1] ?? colors[0]} 50%)`
    : undefined;

  return (
    <button
      type="button"
      className={`mv-chroma-tile${active ? ' active' : ''}`}
      onClick={onClick}
      title={label}
    >
      {blob ? (
        <img src={blob} alt="" draggable={false} />
      ) : fallback ? (
        <div className="mv-chroma-fallback" style={{ background: fallback }} />
      ) : (
        <div className="mv-chroma-fallback" />
      )}
    </button>
  );
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds * 100) % 100);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

/** Score a clip name against the "canonical idle" pattern. Higher
 *  score = more likely to be the loop the viewer should auto-play.
 *
 *  Riot's idle naming is inconsistent across champions and reworks:
 *    - "Idle"             (oldest)
 *    - "Idle1" / "Idle_1"
 *    - "IdleBase" / "Idle_Base"
 *    - "Idle1_Base"       (newer skins)
 *
 *  Penalty words knock down transitional / situational idles like
 *  `CombatIdle_to_NoncombatIdle` (a transition, not a loop) and
 *  `IdleIn_Homeguard` (entry, plays once). */
function scoreIdleClip(name: string): number {
  const lower = name.toLowerCase();
  if (!lower.includes('idle')) return -Infinity;

  let score = 0;

  // Anchor by position — idles whose name STARTS with "idle" are
  // canonical; ones that contain it mid-name are usually variants
  // or transitions.
  if (lower.startsWith('idle')) score += 100;
  else score += 10;

  // Base / loop suffixes win.
  if (lower === 'idle' || lower === 'idle1' || lower === 'idle_1') score += 80;
  if (lower === 'idlebase' || lower === 'idle_base') score += 80;
  if (lower === 'idle1_base' || lower === 'idle_1_base') score += 90;

  // Penalty words — transitions, situational variants, non-loops.
  const penalties = [
    'to',         // *_to_* = transition
    'from',
    'combat',
    'noncombat',
    'death',
    'crit',
    'dance',
    'recall',
    'joke',
    'laugh',
    'taunt',
    'kneel',
    'passive',
    'homeguard',
    'spawn',
    'channel',
    'cast',
    'attack',
    'in',         // "IdleIn" = entry, not the loop
  ];
  // Match against `_`-separated tokens so we don't false-positive on
  // substrings (e.g. "to" inside "Tortured" shouldn't trigger).
  const tokens = lower.split(/[_\s]+/);
  for (const p of penalties) {
    if (tokens.includes(p)) score -= 50;
  }

  // Prefer shorter names — `Idle1_Base` (10 chars) over
  // `Idle1_Base_Variation_03` (23 chars). Tiny weight so it only
  // tie-breaks between otherwise-equal candidates.
  score -= name.length * 0.5;

  return score;
}
