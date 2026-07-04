//! Tauri commands for the WAD extraction UI.
//!
//! Phase 1 surface: hashtable status, download, preload/unload, and a
//! debug single-hash resolver.
//! Phase 2 adds mount/list/inspect commands that parse a WAD's TOC and
//! bulk-resolve every path hash. Extraction lands in Phase 3.

use crate::core::hash::get_frogtools_hash_dir;
use crate::core::wad::{
    cancel_extraction, check_for_hash_update, detect_layout, download_combined_hashes,
    extract_hashes, extract_to_dir, hashes_present, list_mounted, loaded_stats, mount,
    read_chunk_decompressed_bytes, resolve_wad, unload_envs, unmount, with_mount, ExtractResult,
    HashScanResult, HashUpdateStatus, MountInfo,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct WadHashStatus {
    pub present: bool,
    /// "split" | "combined" | "missing"
    pub layout: String,
    pub hash_dir: String,
}

#[derive(Serialize)]
pub struct WadPreloadStatus {
    pub wad_loaded: bool,
    pub bin_loaded: bool,
    /// Layout detected on disk at the time of the call.
    pub layout: String,
}

/// Probe disk for the FrogTools hash directory and report which layout (if
/// any) is populated. Cheap — no env opens, just `data.mdb` existence checks.
#[tauri::command]
pub async fn wad_hash_status() -> Result<WadHashStatus, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let layout = detect_layout(&dir);
    Ok(WadHashStatus {
        present: hashes_present(&dir),
        layout: layout.as_str().to_string(),
        hash_dir: dir.to_string_lossy().into_owned(),
    })
}

/// Download `lol-hashes-combined.zst` and decompress it into the FrogTools
/// dir. No-ops with a "complete" event when a layout is already present
/// unless `force == true`. Returns the resulting layout string.
#[tauri::command]
pub async fn wad_download_hashes(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<String, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let layout = download_combined_hashes(&app, &dir, force.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;
    Ok(layout.as_str().to_string())
}

/// Read current env state. The LMDB envs are opened lazily on first
/// lookup; this command just reports whether that has happened yet so
/// the UI can show a passive "ready" indicator.
#[tauri::command]
pub async fn wad_get_preload_status() -> Result<WadPreloadStatus, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let env_stats = loaded_stats(&dir);
    Ok(WadPreloadStatus {
        wad_loaded: env_stats.wad_loaded,
        bin_loaded: env_stats.bin_loaded,
        layout: detect_layout(&dir).as_str().to_string(),
    })
}

/// Compare the local `releaseTag` against the latest published release.
/// One HTTPS round-trip — the every-launch auto-update mode runs this
/// and only triggers a real download when the tags differ.
#[tauri::command]
pub async fn wad_check_for_hash_update() -> Result<HashUpdateStatus, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    check_for_hash_update(&dir).await.map_err(|e| e.to_string())
}

/// Drop the cached LMDB env(s). Free at runtime — only the OS-cached
/// pages get released. Use when the user leaves the Extract Files tab if
/// auto-unload is enabled.
#[tauri::command]
pub async fn wad_unload_hashes() -> Result<(), String> {
    unload_envs();
    Ok(())
}

/// Resolve a single 16-char hex WAD path hash. Test/debug helper for the
/// UI; returns the hex string itself when the hash is unknown.
#[tauri::command]
pub async fn wad_resolve_hash(hex: String) -> Result<String, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let trimmed = hex.trim().trim_start_matches("0x").trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", hex, e))?;
    Ok(resolve_wad(hash, &dir))
}

// ── Phase 2 — mount + entry listing ─────────────────────────────────────────

#[derive(Serialize)]
pub struct WadOpenResult {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub version: String,
    pub chunk_count: usize,
}

/// One row of a mounted WAD's chunk list — what the frontend uses to
/// build its folder tree. `path` is the resolved string when the LMDB
/// hashtable knows the hash, else its 16-char hex form.
#[derive(Serialize)]
pub struct WadEntry {
    pub path: String,
    pub path_hash_hex: String,
    pub size: u64,
    pub compressed_size: u64,
    pub compression: &'static str,
    /// True when the chunk is a duplicate of an earlier chunk's data
    /// section (v3.0–v3.3 only). Phase 3 may surface this in the UI.
    pub is_duplicated: bool,
    /// True when the path was unresolved — the UI can render hex names
    /// under an "unknown/" bucket or with a different icon.
    pub unknown: bool,
}

/// Open + parse a WAD, bulk-resolve every path hash, and register it in
/// the in-process mount registry. Returns the new `MountId` plus a small
/// header describing the file.
#[tauri::command]
pub async fn wad_open(path: String) -> Result<WadOpenResult, String> {
    let id = mount(&path).map_err(|e| e.to_string())?;
    with_mount(id, |m| WadOpenResult {
        id: m.id,
        name: m.display_name(),
        path: m.path.to_string_lossy().into_owned(),
        version: m.version.to_string(),
        chunk_count: m.chunks.len(),
    })
    .ok_or_else(|| "Mount disappeared between insert and read".to_string())
}

/// Drop a mount and free its TOC + resolved paths. Idempotent.
#[tauri::command]
pub async fn wad_close(id: u64) -> Result<bool, String> {
    Ok(unmount(id))
}

/// Return every entry in the given mount as a flat list, suitable for
/// the frontend to fold into a tree by `/`-splitting `path`. Ordered by
/// resolved path so identical structure across re-opens is stable.
#[tauri::command]
pub async fn wad_list_entries(id: u64) -> Result<Vec<WadEntry>, String> {
    with_mount(id, |m| {
        let mut entries: Vec<WadEntry> = m
            .chunks
            .iter()
            .map(|c| {
                let hex = format!("{:016x}", c.path_hash);
                let path = m
                    .resolved
                    .get(&c.path_hash)
                    .cloned()
                    .unwrap_or_else(|| hex.clone());
                // `unknown` originally meant "resolved name equals the
                // hex fallback". The lazy magic-byte sniffer rewrites
                // that fallback to `<hex>.<ext>` once it has data, so
                // compare against the **file stem** (without extension)
                // — anything whose stem is still the hex didn't come
                // from a hashtable and should still render with the
                // unknown styling.
                let stem = std::path::Path::new(&path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let unknown = stem == hex;
                WadEntry {
                    path,
                    path_hash_hex: hex,
                    size: c.uncompressed_size,
                    compressed_size: c.compressed_size,
                    compression: c.compression.as_str(),
                    is_duplicated: c.is_duplicated,
                    unknown,
                }
            })
            .collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        entries
    })
    .ok_or_else(|| format!("No mounted WAD with id {}", id))
}

/// Snapshot of all currently-mounted WADs.
#[tauri::command]
pub async fn wad_list_mounted() -> Vec<MountInfo> {
    list_mounted()
}

// ── Phase 3 — extraction ─────────────────────────────────────────────────────

/// Extract chunks from a mounted WAD into `output_dir`. When
/// `selected_hashes` is empty or omitted, every chunk is extracted.
/// Otherwise only chunks whose 16-char hex hash is in the list are written.
///
/// Progress is emitted on the `wad-extract-progress` event tagged with
/// `action_id` so multiple concurrent extractions don't bleed into each
/// other's UI.
#[tauri::command]
pub async fn wad_extract(
    app: tauri::AppHandle,
    id: u64,
    output_dir: String,
    action_id: String,
    selected_hashes: Option<Vec<String>>,
    use_rename: Option<bool>,
    flatten: Option<bool>,
) -> Result<ExtractResult, String> {
    let selected: HashSet<u64> = match selected_hashes {
        Some(list) => list
            .into_iter()
            .filter_map(|s| {
                let trimmed = s.trim().trim_start_matches("0x").trim_start_matches("0X");
                u64::from_str_radix(trimmed, 16).ok()
            })
            .collect(),
        None => HashSet::new(),
    };
    let use_rename = use_rename.unwrap_or(true);
    let flatten = flatten.unwrap_or(false);

    let output_path = PathBuf::from(&output_dir);

    // Run on the Tokio blocking pool so the rayon work doesn't block the
    // async runtime that's pumping IPC events.
    let app_clone = app.clone();
    let action_clone = action_id.clone();
    tokio::task::spawn_blocking(move || {
        extract_to_dir(
            &app_clone,
            id,
            &selected,
            &output_path,
            &action_clone,
            use_rename,
            flatten,
        )
    })
    .await
    .map_err(|e| format!("Extraction task failed to join: {}", e))?
    .map_err(|e| e.to_string())
}

/// Signal a running extraction to stop. Returns `true` when the action
/// id matched a live job. Workers check the cancel flag between chunks,
/// so cancellation is cooperative — already-flying writes finish first.
#[tauri::command]
pub async fn wad_cancel_extract(action_id: String) -> bool {
    cancel_extraction(&action_id)
}

/// BIN-walked skin extraction. Given a skin's SKN chunk hash, walks
/// the sibling skin BIN + every linked dependency BIN, collects every
/// `assets/…` / `data/…` string they reference, resolves each to a
/// WAD chunk, and writes the union of:
///   1. The skin's per-folder chunks (SKN, SKL, ANM, particles…)
///   2. All BIN-referenced asset chunks (textures, secondary meshes,
///      VFX BINs, materials referenced from other skins, …)
///   3. The skin BIN and its linked deps
///
/// When `repath=true`, every output disk path is rewritten to insert
/// `repath_prefix` directly after the leading `assets/` / `data/`
/// segment (Quartz-style), and every BIN file's string fields are
/// rewritten in lockstep so the resulting mod tree is self-consistent.
///
/// Empty `repath_prefix` disables repathing even if `repath=true`.
///
/// `wad_folder_name` mirrors the Extraction Settings "Create WAD-name
/// folder" toggle — when present every output path is nested under
/// the supplied folder name. Caller passes `None` to write straight
/// into `output_dir`.
///
/// Returns the standard `ExtractResult` plus a `error_messages` list
/// describing every skipped/failed chunk so the frontend can surface
/// concrete failure reasons instead of just an error count.
#[derive(serde::Serialize, Clone)]
pub struct RenamePair {
    /// The original WAD-relative path (lowercased), e.g.
    /// `assets/characters/akali/skins/skin1/akali_skin1_long_long_name_tx_cm.tex`.
    pub original: String,
    /// The shortened WAD-relative path the file actually lives at on
    /// disk after extraction, e.g.
    /// `assets/jade/characters/akali/skins/skin1/_j_a3f0b178.tex`.
    /// Includes repath prefix when repath is on.
    pub renamed: String,
}

#[derive(serde::Serialize)]
pub struct SkinAssetExtractResult {
    #[serde(flatten)]
    pub base: ExtractResult,
    /// Human-readable lines for every chunk that failed to write or
    /// repath-encode. Includes the WAD path and the error text.
    pub error_messages: Vec<String>,
    /// Long-path renames applied during extraction. Empty when no
    /// path crossed the threshold. Also serialized as the
    /// `_jade_rename_map.json` sidecar in the output dir.
    pub renames: Vec<RenamePair>,
}

/// Detect the champion's gameplay BIN — `data/characters/<champ>/<champ>.bin`.
/// This BIN holds Riot's per-patch ability/AI code; bundling a stale
/// copy with a mod is a guaranteed in-game crash the first time the
/// abilities are touched. Always excluded from skin-asset extraction
/// (and from the linked-BIN merge below), regardless of user flags.
///
/// Pattern: the filename stem matches the immediate parent folder
/// name AND the parent's parent is `characters/` — that combination
/// is unique to the champion-root BIN. Works for re-pathed mod trees
/// too (`data/<prefix>/characters/akali/akali.bin`).
fn is_champion_root_bin(path: &str) -> bool {
    let lower = path.to_lowercase();
    let parts: Vec<&str> = lower.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 3 {
        return false;
    }
    let n = parts.len();
    let filename = parts[n - 1];
    let parent = parts[n - 2];
    let grandparent = parts[n - 3];
    let Some(stem) = filename.strip_suffix(".bin") else {
        return false;
    };
    stem == parent && grandparent == "characters"
}

#[tauri::command]
pub async fn wad_extract_skin_assets(
    app: tauri::AppHandle,
    id: u64,
    output_dir: String,
    action_id: String,
    skn_chunk_hash_hex: String,
    repath: Option<bool>,
    repath_prefix: Option<String>,
    wad_folder_name: Option<String>,
    merge_linked: Option<bool>,
    // When true, every `assets/characters/<champ>/hud/icons2d/*`
    // chunk in the WAD is forcibly added to the extraction plan.
    // Quartz's `preserveHudIcons2D`: HUD icons are referenced through
    // hash-table lookups rather than direct BIN strings, so the
    // BIN-walk often misses them and they vanish from the extracted
    // mod. Off by default — the user opts in when they want them.
    preserve_hud_icons: Option<bool>,
    // When true, paths under SFX/audio roots are EXCLUDED from the
    // repath rewrite — both the disk path stays canonical and the
    // BIN references stay verbatim. The audio engine resolves SFX
    // through its own indirection layer; prefixing those strings
    // silently breaks audio. Mirrors Quartz's `skipSfxRepath`. On
    // by default.
    skip_sfx_repath: Option<bool>,
    // When true, voiceover .wpk/.bnk chunks are pulled from the
    // locale WAD (mount id supplied via `vo_mount_id`) for THIS
    // champion + skin, written into the main extracted folder, and
    // their BIN refs are repathed alongside everything else. League
    // happily reads VO out of the main WAD so we don't need a
    // separate output tree.
    export_vo: Option<bool>,
    // Mount id of the locale-tagged VO WAD (e.g. `Akali.en_US.wad.client`).
    // Frontend opens it via `wad_open` before calling us and
    // closes it after. Ignored when `export_vo` is false.
    vo_mount_id: Option<u64>,
    // When Some(n), a chroma occupying skin slot `n` is selected. We
    // collect assets from the CHROMA's `skin{n}.bin` (so its textures —
    // not the base skin's — land in the extraction plan) and write the
    // chroma BIN's bytes onto the PARENT skin BIN path, so the extracted
    // mod renders as the chroma when the parent skin loads. Mirrors the
    // Photo Studio chroma path (`viewer_extract_for_studio`). `None` =
    // ordinary base-skin extraction.
    chroma_skin_num: Option<u32>,
) -> Result<SkinAssetExtractResult, String> {
    use crate::core::bin::repath::{
        collect_asset_paths_lower, is_audio_path, is_hud_icon_path,
        is_voiceover_path, repath_wad_relative, rewrite_bin_strings,
    };
    use crate::core::bin::{read_bin_engine, write_bin_engine, BinValue};
    use crate::core::bin::jade::view;
    use crate::core::mesh::find_skin_bin;
    use crate::core::mesh::skin_bin::find_chroma_bin;
    use crate::core::wad::WadChunk;
    use std::collections::{HashMap, HashSet};
    use std::hash::Hasher;
    use std::path::Path;
    use tauri::Emitter;
    use twox_hash::XxHash64;

    /// Long-path safety threshold. Windows' classic limit is 260 chars
    /// including the drive letter + terminator; we leave headroom for
    /// the `.jdtmp` suffix some downstream writers add.
    const LONG_PATH_THRESHOLD: usize = 240;

    /// Build a short, human-friendly renamed basename — `linked<N>.<ext>`
    /// where N is the per-extension index. Sequential rather than
    /// hash-based so the user can tell at a glance which file is
    /// which when working in the extracted folder (`linked1.bin`,
    /// `linked2.bin`, …). Pair with the sidecar JSON for the original
    /// names. `counters` tracks the next index per extension.
    fn next_renamed_basename(
        rel_path: &str,
        counters: &mut HashMap<String, usize>,
    ) -> String {
        let ext = Path::new(rel_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let n = counters.entry(ext.clone()).or_insert(0);
        *n += 1;
        format!("linked{n}.{ext}")
    }

    /// Replace the basename of a WAD-relative path with `new_basename`,
    /// preserving the parent folders. Always returns a lowercased
    /// path so rename-map lookups are consistent.
    fn replace_basename(rel_path: &str, new_basename: &str) -> String {
        let lower = rel_path.to_ascii_lowercase();
        match lower.rfind('/') {
            Some(cut) => format!("{}/{}", &lower[..cut], new_basename),
            None => new_basename.to_string(),
        }
    }

    // Same event name + payload shape the existing `wad_extract` flow
    // emits — reusing it means the WelcomeScreen's `wad-extract-progress`
    // listener (which drives the swipe-progress bar in the status bar
    // and the Windows taskbar overlay) picks our progress up for free.
    fn emit_progress(
        app: &tauri::AppHandle,
        action_id: &str,
        phase: &'static str,
        current: u64,
        total: u64,
        written: u64,
        errors: u64,
    ) {
        let payload = serde_json::json!({
            "action_id": action_id,
            "phase": phase,
            "current": current,
            "total": total,
            "written": written,
            "errors": errors,
            "message": "",
        });
        let _ = app.emit("wad-extract-progress", payload);
    }

    // Same hash function each subsystem uses for path → chunk lookup.
    // Inlined here to keep the helper self-contained without forking a
    // utility crate around it.
    fn path_hash(s: &str) -> u64 {
        let mut h = XxHash64::with_seed(0);
        h.write(s.as_bytes());
        h.finish()
    }

    let trimmed = skn_chunk_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let skn_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{skn_chunk_hash_hex}': {e}"))?;

    let repath_on = repath.unwrap_or(false);
    let prefix_raw = repath_prefix.unwrap_or_default();
    let prefix = prefix_raw.trim().trim_matches('/').to_string();
    let do_repath = repath_on && !prefix.is_empty();
    let do_merge_linked = merge_linked.unwrap_or(false);
    let do_preserve_hud = preserve_hud_icons.unwrap_or(false);
    let do_skip_sfx = skip_sfx_repath.unwrap_or(true);
    let do_export_vo = export_vo.unwrap_or(false);
    let vo_mount = vo_mount_id;
    let wad_folder = wad_folder_name
        .as_deref()
        .map(|s| s.trim().trim_matches(['/', '\\']).to_string())
        .filter(|s| !s.is_empty());

    let output_path = PathBuf::from(&output_dir);
    let app_clone = app.clone();
    let action_clone = action_id.clone();

    tokio::task::spawn_blocking(move || -> Result<SkinAssetExtractResult, String> {
        // ── 1. Resolve skin BIN from SKN hash ────────────────────────
        // For a chroma we resolve the CHROMA bin (`skin{N}.bin`) and treat
        // it exactly like a base skin bin: asset collection is driven by
        // it, AND it's written out at its OWN path (`skin{N}.bin`) — not
        // redirected over the parent skin slot. The parent skin bin is the
        // chroma's linked dependency, so it (and its shared assets) still
        // ride along through the BIN-walk below.
        let parent_bin = find_skin_bin(id, skn_hash);
        let bin_match = match chroma_skin_num {
            Some(n) => find_chroma_bin(id, skn_hash, n)
                .ok_or_else(|| format!("chroma BIN skin{n} not found for SKN"))?,
            None => parent_bin
                .clone()
                .ok_or_else(|| "skin BIN not found for SKN".to_string())?,
        };
        let bin_hash = u64::from_str_radix(&bin_match.path_hash_hex, 16)
            .map_err(|e| format!("bad skin bin hash hex: {e}"))?;
        // The WAD-relative path the skin bin is written to — its own path,
        // for both base skins and chromas.
        let skin_bin_out_rel: String = bin_match.path.to_lowercase();

        // SKN folder = parent of the SKN path (used to also grab
        // sibling files Riot conventionally keeps next to the mesh
        // — anims, particles, etc. — even when not explicitly named
        // in the BIN). `m.path` is a PathBuf — keep it as one so the
        // extractor's `read_chunk_decompressed_bytes(&Path, _)`
        // signature is satisfied without an extra conversion at each
        // call site.
        let (skn_folder, wad_path_snapshot): (Option<String>, std::path::PathBuf) =
            with_mount(id, |m| {
                let folder = m.resolved.get(&skn_hash).and_then(|p| {
                    let lower = p.to_lowercase();
                    let cut = lower.rfind('/')?;
                    Some(lower[..cut].to_string() + "/")
                });
                (folder, m.path.clone())
            })
            .ok_or_else(|| format!("mount {id} not registered"))?;

        // Derive the champion id from the SKN folder so we can scope
        // the HUD-icons sweep. SKN paths conventionally live under
        // `assets/characters/<champ>/skins/<skinN>/<champ>.skn`; the
        // 3rd path segment is the champion.
        let hud_icons_prefix: Option<String> = if do_preserve_hud {
            skn_folder.as_deref().and_then(|f| {
                let parts: Vec<&str> = f.split('/').filter(|p| !p.is_empty()).collect();
                if parts.len() >= 3 && parts[0] == "assets" && parts[1] == "characters" {
                    Some(format!("assets/characters/{}/hud/icons2d/", parts[2]))
                } else {
                    None
                }
            })
        } else {
            None
        };

        // ── 2. Read the skin BIN bytes, parse it ─────────────────────
        let skin_bin_chunk = with_mount(id, |m| {
            m.chunks
                .iter()
                .find(|c| c.path_hash == bin_hash)
                .copied()
        })
        .flatten()
        .ok_or_else(|| "skin bin chunk missing from mount".to_string())?;
        let skin_bin_bytes = read_chunk_decompressed_bytes(&wad_path_snapshot, &skin_bin_chunk)
            .map_err(|e| format!("read skin bin: {e}"))?;
        let mut primary_tree = read_bin_engine(&skin_bin_bytes)
            .map_err(|e| format!("parse skin bin: {e}"))?;

        // ── 3. Parse every linked dependency BIN ─────────────────────
        // Same "linked" set used by the texture binder — covers
        // multi-skin / multi-character setups where the materialDef
        // lives in a sibling BIN.
        let dep_paths: Vec<String> = view::dependencies(&primary_tree)
            .iter()
            .map(|d| d.to_lowercase())
            .collect();
        let mut linked: Vec<(u64, String, Vec<u8>)> = Vec::new();
        for dep_path in &dep_paths {
            let dep_hash = path_hash(dep_path);
            let Some(dep_chunk) = with_mount(id, |m| {
                m.chunks
                    .iter()
                    .find(|c| c.path_hash == dep_hash)
                    .copied()
            })
            .flatten()
            else {
                continue;
            };
            let Ok(bytes) = read_chunk_decompressed_bytes(&wad_path_snapshot, &dep_chunk) else {
                continue;
            };
            linked.push((dep_hash, dep_path.clone(), bytes));
        }
        let linked_trees: Vec<(u64, String, crate::core::bin::JadeBin)> = linked
            .iter()
            .filter_map(|(h, p, b)| read_bin_engine(b).ok().map(|t| (*h, p.clone(), t)))
            .collect();

        // ── 3b. Pre-compute which linked BINs will be merged ─────────
        // The actual merge serialization is deferred until after the
        // rename map is built so renames + repath fold into the same
        // serialization pass. Here we just figure out which linked
        // chunk hashes the merge would consume — the plan filter
        // needs this to drop them from the write set.
        let mut merged_linked_hashes: HashSet<u64> = HashSet::new();
        if do_merge_linked {
            for (h, dep_path, _) in &linked_trees {
                if is_champion_root_bin(dep_path) {
                    eprintln!(
                        "[skin-extract] skipping champion gameplay BIN from merge: {dep_path}"
                    );
                    continue;
                }
                merged_linked_hashes.insert(*h);
            }
        }

        // ── 4. Collect every asset path referenced from any BIN ──────
        let mut asset_paths: HashSet<String> = HashSet::new();
        for p in collect_asset_paths_lower(&primary_tree) {
            asset_paths.insert(p);
        }
        for (_, _, tree) in &linked_trees {
            for p in collect_asset_paths_lower(tree) {
                asset_paths.insert(p);
            }
        }
        let mut wanted_hashes: HashMap<u64, ()> = HashMap::new();
        for p in &asset_paths {
            wanted_hashes.insert(path_hash(p), ());
        }

        // ── 5. Build extraction plan ─────────────────────────────────
        // Each entry is (chunk, lowercased WAD path, source WAD path
        // on disk). The source WAD is normally the main champion WAD
        // we mounted, but VO entries point at the locale WAD passed
        // in via `vo_mount_id`. Carrying the source path per entry
        // lets the write loop read from either mount with no extra
        // bookkeeping.
        let mut plan: Vec<(WadChunk, String, std::path::PathBuf)> = with_mount(id, |m| {
            let mut out: Vec<(WadChunk, String, std::path::PathBuf)> = Vec::new();
            let wad_path = m.path.clone();
            let mut seen: HashSet<u64> = HashSet::new();
            for chunk in &m.chunks {
                if seen.contains(&chunk.path_hash) {
                    continue;
                }
                let Some(path) = m.resolved.get(&chunk.path_hash) else { continue };
                let lower = path.to_lowercase();
                // Hard-skip the champion's gameplay BIN regardless of
                // any other rule that might otherwise include it.
                if is_champion_root_bin(&lower) {
                    continue;
                }
                // When merging is on, the linked BINs we successfully
                // consumed get dropped from the plan — their objects
                // now live inside the consolidated primary BIN.
                if merged_linked_hashes.contains(&chunk.path_hash) {
                    continue;
                }
                // Hard exclusions driven by the user's checkboxes.
                // These run BEFORE any inclusion rule because the user
                // explicitly opted out of these file groups — even if
                // the skin folder sweep or BIN-walk would otherwise
                // pull them in, we drop them. The corresponding BIN
                // refs stay verbatim (no repath) so the game falls
                // back to whatever's installed in the original WAD.
                //
                // VO is treated separately — when `do_export_vo` is
                // on we don't filter VO here even if `do_skip_sfx` is
                // on; the actual VO chunks come from the locale WAD
                // below, but any happen-to-be-here VO chunks in the
                // main mount also get to ride along.
                if do_skip_sfx && is_audio_path(&lower)
                    && !(do_export_vo && is_voiceover_path(&lower))
                {
                    continue;
                }
                if !do_preserve_hud && is_hud_icon_path(&lower) {
                    continue;
                }
                // The blind skin-folder sweep grabs every chunk physically
                // sitting in the SKN's folder (anims/particles/etc. Riot
                // keeps next to the mesh but doesn't always name in the
                // BIN). For a CHROMA that folder is the PARENT skin's
                // (skin10) — sweeping it would drag in the base skin's own
                // textures, which the chroma overrides and the user doesn't
                // want. So we disable the sweep for chromas: extraction is
                // then driven purely by the chroma BIN's references (and its
                // linked deps, incl. the parent BIN — which still pulls the
                // shared mesh/material assets via the BIN-walk below).
                let is_skin_folder_member = chroma_skin_num.is_none()
                    && skn_folder
                        .as_deref()
                        .map(|f| lower.starts_with(f))
                        .unwrap_or(false);
                let is_wanted_asset = wanted_hashes.contains_key(&chunk.path_hash);
                let is_skin_bin = chunk.path_hash == bin_hash;
                let is_linked_bin = linked.iter().any(|(h, _, _)| *h == chunk.path_hash);
                // HUD icons live under `assets/characters/<champ>/hud/
                // icons2d/` and are usually picked up by the engine via
                // a hash-table lookup, not a direct BIN string. That
                // makes them invisible to the BIN-walk filter, so we
                // sweep the whole `icons2d/` folder when the user has
                // the preserve-HUD option on.
                let is_hud_icon = hud_icons_prefix
                    .as_deref()
                    .map(|p| lower.starts_with(p))
                    .unwrap_or(false);
                if is_skin_folder_member
                    || is_wanted_asset
                    || is_skin_bin
                    || is_linked_bin
                    || is_hud_icon
                {
                    seen.insert(chunk.path_hash);
                    out.push((*chunk, lower, wad_path.clone()));
                }
            }
            out
        })
        .unwrap_or_default();

        // ── 5a. VO chunks from the locale WAD ────────────────────────
        // The frontend mounted `<Champ>.<locale>.wad.client` and
        // handed us the mount id. We walk that mount's chunks,
        // filter to ones whose path lives under this skin's VO
        // folder, and append them to the plan with the locale WAD's
        // file path as their source. Renames + repath + write loop
        // treat them identically to main-WAD entries after this.
        if do_export_vo {
            if let Some(vo_id) = vo_mount {
                // VO selection is BIN-driven: every voiceover path the
                // skin's BIN actually mentions has its hash already in
                // `wanted_hashes` (populated by step 4 from primary +
                // linked trees). Skins that borrow another skin's VO
                // (e.g. NurseAkali pointing at `Skins/Base/Akali_Base_VO_*`)
                // are picked up automatically because the BIN names the
                // base-skin paths verbatim — we just match hashes.
                //
                // We still gate by `is_voiceover_path` so SFX/non-VO
                // audio refs that happen to live in the locale WAD
                // don't sneak in.
                eprintln!(
                    "[vo-extract] mount_id={vo_id} hash-driven; wanted_hash_count={}",
                    wanted_hashes.len()
                );
                let mut total_chunks: usize = 0;
                let mut resolved_chunks: usize = 0;
                let mut vo_chunks: usize = 0;
                let mut sample_vo_unmatched: Vec<String> = Vec::new();
                let extra: Vec<(WadChunk, String, std::path::PathBuf)> = with_mount(vo_id, |m| {
                    let mut out: Vec<(WadChunk, String, std::path::PathBuf)> = Vec::new();
                    let vo_wad_path = m.path.clone();
                    eprintln!(
                        "[vo-extract] mount path={} total chunks={}",
                        vo_wad_path.display(),
                        m.chunks.len()
                    );
                    total_chunks = m.chunks.len();
                    for chunk in &m.chunks {
                        let Some(path) = m.resolved.get(&chunk.path_hash) else { continue };
                        resolved_chunks += 1;
                        let lower = path.to_lowercase();
                        if !is_voiceover_path(&lower) {
                            continue;
                        }
                        vo_chunks += 1;
                        if !wanted_hashes.contains_key(&chunk.path_hash) {
                            if sample_vo_unmatched.len() < 8 {
                                sample_vo_unmatched.push(lower.clone());
                            }
                            continue;
                        }
                        out.push((*chunk, lower, vo_wad_path.clone()));
                    }
                    out
                })
                .unwrap_or_default();
                eprintln!(
                    "[vo-extract] total={total_chunks} resolved={resolved_chunks} \
                     voicePaths={vo_chunks} matched={} sample_vo_unmatched={:?}",
                    extra.len(),
                    sample_vo_unmatched
                );
                if !extra.is_empty() {
                    plan.extend(extra);
                }
            } else {
                eprintln!("[vo-extract] export_vo=true but no vo_mount_id supplied");
            }
        }

        // Normalize the skin-BIN plan entry: drop whatever the walk pulled
        // in for the skin bin itself (we re-push it below with the correct
        // output path), which also rescues the BIN when its own WAD path
        // isn't resolved in the mount and would otherwise silently drop.
        // For a chroma the parent skin bin is deliberately LEFT in the plan
        // — it's a linked dependency the chroma needs to render.
        plan.retain(|(c, _, _)| c.path_hash != bin_hash);
        plan.push((
            skin_bin_chunk,
            skin_bin_out_rel.clone(),
            wad_path_snapshot.clone(),
        ));

        if plan.is_empty() {
            return Err("nothing to extract — skin BIN walk produced no paths".to_string());
        }

        // ── 5b. Long-path detection + rename map ──────────────────────
        // Walk the plan and pre-compute every chunk's eventual disk
        // path (repath if asset, optional wad_folder wrapper, joined
        // under output_path). When the projected length crosses the
        // safety threshold we generate a shortened deterministic
        // basename — `_j_<8hex>.<ext>` — and remember it so BIN string
        // references can be rewritten in lockstep.
        //
        // The rename map's keys are LOWERCASE original WAD-relative
        // paths (what BIN strings will match against). Values are the
        // final WAD-relative path with both repath and rename folded
        // in, so a single map lookup yields the post-everything
        // string the BIN should reference.
        let mut rename_map: HashMap<String, String> = HashMap::new();
        let mut rename_counters: HashMap<String, usize> = HashMap::new();
        let output_path_len = output_path.to_string_lossy().len();
        let wad_folder_len = wad_folder
            .as_deref()
            .map(|f| f.len() + 1)
            .unwrap_or(0);
        for (_chunk, rel_path, _src) in &plan {
            // Repath gates:
            //   - Audio (SFX or VO): exempt when `do_skip_sfx` is on,
            //     except VO when the user opted into exporting it —
            //     those files DO land on disk and the BIN ref must
            //     follow.
            //   - HUD icons: exempt when "Preserve HUD" is on (engine
            //     hash-table indirection doesn't follow our prefix).
            let is_vo = is_voiceover_path(rel_path);
            let audio_exempt = do_skip_sfx
                && is_audio_path(rel_path)
                && !(do_export_vo && is_vo);
            let repath_exempt = audio_exempt
                || (do_preserve_hud && is_hud_icon_path(rel_path));
            let repathed_rel = if do_repath && !repath_exempt {
                repath_wad_relative(rel_path, &prefix)
            } else {
                rel_path.clone()
            };
            // +1 for the separator between output_path and the rel.
            let total_len = output_path_len + 1 + wad_folder_len + repathed_rel.len();
            if total_len > LONG_PATH_THRESHOLD {
                let new_basename =
                    next_renamed_basename(rel_path, &mut rename_counters);
                let renamed_rel = replace_basename(&repathed_rel, &new_basename);
                rename_map.insert(rel_path.to_ascii_lowercase(), renamed_rel);
            }
        }

        // ── 5c. Deferred merge serialization (with renames + repath) ──
        // Now that the rename map is final we can perform the actual
        // Quartz-style merge. Linked BINs marked for merging get their
        // `objects` inlined into the primary, the primary's
        // `dependencies` entries for those deps are removed, the
        // combined rename/repath rewrite is applied to every string
        // in the merged tree, and the result is re-serialized.
        let mut merged_primary_bytes: Option<Vec<u8>> = None;
        if do_merge_linked && !merged_linked_hashes.is_empty() {
            let mut consumed_deps: HashSet<String> = HashSet::new();
            // Path hashes already present in the primary — used to avoid
            // clobbering an object the primary already defines (mirrors
            // the old `entry().or_insert_with()` semantics).
            let mut existing: HashSet<u32> =
                view::objects(&primary_tree).iter().map(|o| o.path_hash).collect();
            if let Some(prim_entries) = view::entries_mut(&mut primary_tree) {
                for (h, dep_path, tree) in &linked_trees {
                    if !merged_linked_hashes.contains(h) {
                        continue;
                    }
                    for (key, val) in view::entries(tree) {
                        if let BinValue::Hash(hh) = key {
                            if !existing.insert(hh.hash) {
                                continue; // already present in primary
                            }
                        }
                        prim_entries.push((key.clone(), val.clone()));
                    }
                    consumed_deps.insert(dep_path.to_lowercase());
                }
            }
            if let Some(deps) = view::dependencies_mut(&mut primary_tree) {
                deps.retain(|d| match d {
                    BinValue::String(s) => !consumed_deps.contains(&s.to_lowercase()),
                    _ => true,
                });
            }
            rewrite_bin_strings(
                &mut primary_tree,
                &prefix,
                &rename_map,
                do_repath,
                do_skip_sfx,
                do_preserve_hud,
                do_export_vo,
            );
            match write_bin_engine(&primary_tree) {
                Ok(b) => {
                    merged_primary_bytes = Some(b);
                }
                Err(e) => {
                    eprintln!(
                        "[skin-extract] merge re-encode failed: {e}; falling back to per-BIN write"
                    );
                    merged_linked_hashes.clear();
                }
            }
        }

        // ── 6. Write everything to disk ──────────────────────────────
        std::fs::create_dir_all(&output_path)
            .map_err(|e| format!("create output dir: {e}"))?;

        // Preparing phase — drives the indeterminate state of the
        // status-bar progress strip while the first writes start.
        emit_progress(
            &app_clone,
            &action_clone,
            "preparing",
            0,
            plan.len() as u64,
            0,
            0,
        );
        // Throttle "extracting" emits so a 500-chunk skin doesn't spam
        // the IPC channel. ~40 ticks is enough resolution for a smooth
        // bar without being noisy.
        let emit_step: usize = std::cmp::max(1, plan.len() / 40);

        // Set of BIN hashes that need string-rewriting under repath:
        // the skin BIN + every linked dep. Other BINs (e.g. random
        // BINs picked up from the skin folder) get rewritten too if
        // present, since their refs would otherwise dangle.
        let bin_hashes_to_rewrite: HashSet<u64> = if do_repath {
            std::iter::once(bin_hash)
                .chain(linked.iter().map(|(h, _, _)| *h))
                .collect()
        } else {
            HashSet::new()
        };

        let mut extracted: usize = 0;
        let mut failed: usize = 0;
        // Concrete error lines surfaced to the frontend so the user can
        // see *why* a chunk failed (read failure / re-encode failure /
        // write failure) instead of just an opaque count.
        let mut error_messages: Vec<String> = Vec::new();
        for (idx, (chunk, rel_path, source_wad_path)) in plan.iter().enumerate() {
            // Final WAD-relative path:
            //   1. If a rename was issued for this chunk (long-path
            //      mitigation), use it verbatim — the rename map's
            //      values already include the repath prefix.
            //   2. Otherwise apply normal repath (assets/ only).
            let rel_key = rel_path.to_ascii_lowercase();
            let is_vo = is_voiceover_path(rel_path);
            let audio_exempt = do_skip_sfx
                && is_audio_path(rel_path)
                && !(do_export_vo && is_vo);
            let repath_exempt = audio_exempt
                || (do_preserve_hud && is_hud_icon_path(rel_path));
            let mut out_rel = if let Some(renamed) = rename_map.get(&rel_key) {
                renamed.clone()
            } else if do_repath && !repath_exempt {
                repath_wad_relative(rel_path, &prefix)
            } else {
                rel_path.clone()
            };
            // Optional `WadFolderName` wrapper — when supplied (e.g.
            // `aatrox/`) the user gets `aatrox/assets/...` instead of
            // `assets/...` straight in the output root.
            if let Some(folder) = &wad_folder {
                out_rel = format!("{folder}/{out_rel}");
            }
            let out_full = output_path.join(&out_rel);
            if let Some(parent) = out_full.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            // Primary skin BIN + merge mode: we already serialized
            // the consolidated tree (with repath baked in if both are
            // on). Write it straight, no per-chunk parse round-trip.
            if chunk.path_hash == bin_hash && merged_primary_bytes.is_some() {
                let merged = merged_primary_bytes.take().unwrap();
                if let Err(e) = std::fs::write(&out_full, &merged) {
                    let msg = format!(
                        "write failed {} (merged): {}",
                        out_full.display(),
                        e
                    );
                    eprintln!("[skin-extract] {msg}");
                    error_messages.push(msg);
                    failed += 1;
                } else {
                    extracted += 1;
                }
                if idx % emit_step == 0 || idx + 1 == plan.len() {
                    emit_progress(
                        &app_clone,
                        &action_clone,
                        "extracting",
                        (idx + 1) as u64,
                        plan.len() as u64,
                        extracted as u64,
                        failed as u64,
                    );
                }
                continue;
            }

            // Decide whether to rewrite this chunk's BIN strings.
            // Triggered by: (a) the user enabled repath, OR (b) at
            // least one rename was registered for this skin (we need
            // to apply rename-map lookups even without repath so
            // post-rename BIN refs resolve). Only `.bin` chunks +
            // known-BIN hashes get the rewrite — other extensions
            // can't be parsed.
            let needs_rewrite = (do_repath || !rename_map.is_empty())
                && (bin_hashes_to_rewrite.contains(&chunk.path_hash)
                    || Path::new(rel_path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("bin"))
                        .unwrap_or(false));
            let bytes = match read_chunk_decompressed_bytes(source_wad_path, chunk) {
                Ok(b) => b,
                Err(e) => {
                    let msg = format!("read failed for {rel_path}: {e}");
                    eprintln!("[skin-extract] {msg}");
                    error_messages.push(msg);
                    failed += 1;
                    continue;
                }
            };
            let final_bytes: Vec<u8> = if needs_rewrite {
                match read_bin_engine(&bytes) {
                    Ok(mut tree) => {
                        rewrite_bin_strings(
                            &mut tree,
                            &prefix,
                            &rename_map,
                            do_repath,
                            do_skip_sfx,
                            do_preserve_hud,
                            do_export_vo,
                        );
                        match write_bin_engine(&tree) {
                            Ok(b) => b,
                            Err(e) => {
                                let msg = format!(
                                    "BIN re-encode failed for {rel_path}: {e}; writing original"
                                );
                                eprintln!("[skin-extract] {msg}");
                                error_messages.push(msg);
                                bytes
                            }
                        }
                    }
                    Err(e) => {
                        let msg = format!(
                            "BIN parse failed for {rel_path}: {e}; writing original"
                        );
                        eprintln!("[skin-extract] {msg}");
                        error_messages.push(msg);
                        bytes
                    }
                }
            } else {
                bytes
            };
            if let Err(e) = std::fs::write(&out_full, &final_bytes) {
                let msg = format!("write failed {}: {}", out_full.display(), e);
                eprintln!("[skin-extract] {msg}");
                error_messages.push(msg);
                failed += 1;
                continue;
            }
            extracted += 1;
            // Throttled progress tick — `idx` is post-loop-step here
            // so the bar lands at 100% on the final iteration.
            if idx % emit_step == 0 || idx + 1 == plan.len() {
                emit_progress(
                    &app_clone,
                    &action_clone,
                    "extracting",
                    (idx + 1) as u64,
                    plan.len() as u64,
                    extracted as u64,
                    failed as u64,
                );
            }
        }

        // Final "complete" so the listener can hold at 100% and then
        // fade the status text + bar together after its 2s timer.
        emit_progress(
            &app_clone,
            &action_clone,
            "complete",
            plan.len() as u64,
            plan.len() as u64,
            extracted as u64,
            failed as u64,
        );

        // ── 6b. Rename sidecar ────────────────────────────────────────
        // When any chunk got a long-path rename, drop a sidecar JSON
        // at the root of the output dir (under the wad_folder wrapper
        // if any) so the user can audit which short stem maps to which
        // original Riot filename later. Lives next to the extracted
        // tree as `_jade_rename_map.json`.
        let mut rename_pairs: Vec<RenamePair> = rename_map
            .iter()
            .map(|(orig, new)| RenamePair {
                original: orig.clone(),
                renamed: new.clone(),
            })
            .collect();
        rename_pairs.sort_by(|a, b| a.original.cmp(&b.original));
        if !rename_pairs.is_empty() {
            let sidecar_dir = if let Some(folder) = &wad_folder {
                output_path.join(folder)
            } else {
                output_path.clone()
            };
            let _ = std::fs::create_dir_all(&sidecar_dir);
            let sidecar_path = sidecar_dir.join("_jade_rename_map.json");
            let payload = serde_json::json!({
                "note": "Long-path renames performed during skin extract. \
                         BIN references inside the extracted mod were rewritten \
                         to point at the renamed filenames.",
                "renames": rename_pairs,
            });
            match serde_json::to_string_pretty(&payload) {
                Ok(json) => {
                    if let Err(e) = std::fs::write(&sidecar_path, json) {
                        error_messages.push(format!(
                            "rename sidecar write failed at {}: {}",
                            sidecar_path.display(),
                            e
                        ));
                    }
                }
                Err(e) => {
                    error_messages
                        .push(format!("rename sidecar serialize failed: {e}"));
                }
            }
        }

        // Touch app_clone + action_clone so the variable bindings
        // aren't flagged unused — both are kept for future progress
        // event hookup (mirrors `wad_extract`'s plumbing).
        let _ = (&app_clone, &action_clone);

        Ok(SkinAssetExtractResult {
            base: ExtractResult {
                action_id: action_clone.clone(),
                written: extracted,
                skipped: 0,
                errors: failed,
                elapsed_ms: 0,
                output_dir: output_dir.clone(),
                cancelled: false,
            },
            error_messages,
            renames: rename_pairs,
        })
    })
    .await
    .map_err(|e| format!("skin asset extract task join: {e}"))?
}

// ── Lazy extension sniff for unhashed entries ──────────────────────────────

/// Decompress just the magic bytes of every chunk in `id` whose
/// resolved name is still the 16-char hex fallback, append the sniffed
/// extension (`.dds`, `.bin`, `.skn`, …), and return the count of
/// chunks that gained an extension. Heavy operation — runs on the
/// blocking pool. The frontend kicks this off right after `wad_open`
/// so the file list shows real types instead of every unhashed entry
/// looking like a generic unknown blob.
#[tauri::command]
pub async fn wad_sniff_unknown(id: u64) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || crate::core::wad::sniff::sniff_unknown_in_mount(id))
        .await
        .map_err(|e| format!("Sniff task failed to join: {}", e))?
        .map_err(|e| e.to_string())
}

// ── Hash extraction (overlay scan) ──────────────────────────────────────────

/// Scan every chunk in `id` for embedded path strings and submesh names,
/// merge new discoveries into the FrogTools hash overlay files, and
/// return aggregate counts. Progress is emitted on the
/// `wad-hash-scan-progress` channel tagged with `action_id` so the UI
/// can stream chunk-level updates.
#[tauri::command]
pub async fn wad_extract_hashes(
    app: tauri::AppHandle,
    id: u64,
    action_id: String,
) -> Result<HashScanResult, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let app_clone = app.clone();
    let action_clone = action_id.clone();
    tokio::task::spawn_blocking(move || extract_hashes(&app_clone, id, &dir, &action_clone))
        .await
        .map_err(|e| format!("Hash scan task failed to join: {}", e))?
        .map_err(|e| e.to_string())
}

/// Read + decompress a single chunk and return its bytes as base64. Used
/// by the preview pane to feed DDS/TEX/PNG decoders without writing to
/// disk first. Runs on the blocking pool so the main async runtime stays
/// responsive even for multi-MB textures.
#[tauri::command]
pub async fn wad_read_chunk_b64(id: u64, path_hash_hex: String) -> Result<String, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("Chunk {} not in mount {}", path_hash_hex, id))?;

    let (wad_path, chunk) = info;
    let bytes = tokio::task::spawn_blocking(move || read_chunk_decompressed_bytes(&wad_path, &chunk))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| e.to_string())?;

    Ok(B64.encode(&bytes))
}
