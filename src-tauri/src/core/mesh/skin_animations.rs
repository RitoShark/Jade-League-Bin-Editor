//! Extract the animation-clip listing for a skin from its BIN tree.
//!
//! Layout (cross-checked against the Volibear / Fiddlesticks skin BIN
//! samples in `Documents/jade/`):
//!
//! ```text
//! "characters/<champ>/skins/skinN" SkinCharacterDataProperties {
//!     SkinAnimationProperties: embed = SkinAnimationProperties {
//!         AnimationGraphData: link = "characters/<champ>/Animations/SkinN"
//!     }
//! }
//!
//! // In the linked animation BIN file:
//! "characters/<champ>/Animations/SkinN" AnimationGraphData {
//!     mClipDataMap: map[hash, pointer] = {
//!         "Idle1" → AtomicClipData {
//!             mAnimationResourceData: embed = AnimationResourceData {
//!                 mAnimationFilePath: string = "ASSETS/.../<...>.anm"
//!             }
//!         }
//!         "Attack1"     → SequencerClipData { mClipNameList: list[hash] = { "Attack1_A", "Attack1_B" } }
//!         "Spell1_To_Run" → ParametricClipData { mParametricPairDataList: ... }
//!         ...
//!     }
//! }
//! ```
//!
//! For a v1 picker we want only the **leaf** clips — `AtomicClipData`
//! entries — because they're the ones that map to a single `.anm`.
//! Compound types (`SequencerClipData`, `SelectorClipData`,
//! `ParametricClipData`, ...) reference children by hash and don't
//! own a file path.
//!
//! ## Inheritance
//!
//! Non-legendary skins set `AnimationGraphData = link =
//! "characters/<champ>/Animations/Skin0"` and have no animation BIN of
//! their own. The link target lives in skin0's animation BIN. So just
//! following the link gives us the right clip set whether the skin is
//! legendary or not — no special fallback code needed.
//!
//! ## Naming
//!
//! Clip-map keys are FNV1a-32 hashes. When the hash table resolves
//! the key, we use the readable name (e.g. `"Idle1"`). When it
//! doesn't, we fall back to the ANM file's stem (e.g.
//! `"volibear_spell4_tower_attacks_1"`) — `mAnimationFilePath` is
//! always a string and never gets hashed away, so this fallback is
//! always available.

use std::collections::HashSet;
use std::hash::Hasher;

// Canonical engine-agnostic tree: the Jade-native `Bin`/`BinValue`.
// `read_bin_engine` parses with whichever converter engine is selected,
// so this walker never references `ltk_meta`.
use crate::core::bin::{BinField, BinValue, JadeBin as BinTree};
use crate::core::bin::jade::view;
use serde::Serialize;
use twox_hash::XxHash64;

use crate::core::bin::jade::hash_manager as jade_hashes;
use crate::core::bin::read_bin_engine;
use crate::core::wad::{read_chunk_decompressed_bytes, with_mount};

use super::skin_bin::{
    assets_path_variants, data_path_variants, disk_layout_for_skn, find_skin_bin,
};

// ── FNV1a-32 hash constants — same shape as skin_textures.rs ───────

const fn fnv1a_lower(s: &str) -> u32 {
    let bytes = s.as_bytes();
    let mut hash: u32 = 0x811c_9dc5;
    let mut i = 0;
    while i < bytes.len() {
        let mut b = bytes[i];
        if b >= b'A' && b <= b'Z' {
            b += 32;
        }
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
        i += 1;
    }
    hash
}

const H_SKIN_ANIMATION_PROPERTIES: u32 = fnv1a_lower("SkinAnimationProperties");
const H_ANIMATION_GRAPH_DATA: u32 = fnv1a_lower("AnimationGraphData");
pub(crate) const H_CLIP_DATA_MAP: u32 = fnv1a_lower("mClipDataMap");
const H_ANIMATION_RESOURCE_DATA: u32 = fnv1a_lower("mAnimationResourceData");
const H_ANIMATION_FILE_PATH: u32 = fnv1a_lower("mAnimationFilePath");
const C_ATOMIC_CLIP_DATA: u32 = fnv1a_lower("AtomicClipData");

// ── Public types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AnimationClip {
    /// User-facing label. Resolved clip-key name when our hash table
    /// has it ("Idle1"); ANM file stem otherwise
    /// ("volibear_spell4_tower_attacks_1").
    pub name: String,
    /// Source ANM path as written in the BIN — uppercased Riot
    /// convention with `ASSETS/...` prefix. Frontend uses this to
    /// log or debug; loading goes through `anm_chunk_hash_hex`
    /// (WAD source) or `anm_disk_path` (disk source).
    pub anm_path: String,
    /// xxh64 chunk hash hex of the ANM inside the same mount, when
    /// it exists there. `None` for ANMs that live outside this WAD
    /// or for disk-source previews where the WAD lookup doesn't
    /// apply.
    pub anm_chunk_hash_hex: Option<String>,
    /// Absolute disk path to the ANM file when the SKN was loaded
    /// from disk and the file exists in the extracted tree. `None`
    /// for WAD-source previews or for ANMs that aren't on disk
    /// alongside the SKN.
    pub anm_disk_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnimationListing {
    /// `data/.../animations/skinN.bin` — the BIN we read clips from.
    /// Surfaced for the frontend's "where did these come from?"
    /// affordance and for the legendary-vs-inherited indicator.
    pub bin_path: String,
    pub bin_path_hash_hex: String,
    pub clips: Vec<AnimationClip>,
}

// ── End-to-end command path ─────────────────────────────────────────

/// Walk the skin BIN of `skn_path_hash`, follow its
/// `SkinAnimationProperties.AnimationGraphData` link, parse the
/// referenced animation BIN, and return its `AtomicClipData` entries.
///
/// Returns `Ok(None)` for any structural miss along the way (skin BIN
/// not in mount, no animation graph link, animation BIN not in mount,
/// link hash unresolvable). The frontend treats `None` as "no
/// animations available for this SKN" rather than erroring out.
pub fn read_skn_animations(
    mount_id: u64,
    skn_path_hash: u64,
) -> Result<Option<AnimationListing>, String> {
    // Collect chunk hashes + a snapshot of the resolved-path map once
    // so the BIN walker and the folder-scan fallback can both consult
    // them without re-entering `with_mount` repeatedly.
    let mount_view: Option<(HashSet<u64>, std::collections::HashMap<u64, String>, Option<String>)> =
        with_mount(mount_id, |m| {
            let chunk_hashes: HashSet<u64> = m.chunks.iter().map(|c| c.path_hash).collect();
            // Clone the resolved map — it's typically small (<50k
            // entries) and we need read access outside `with_mount`'s
            // closure lifetime.
            let resolved = m.resolved.clone();
            let skn_path = m.resolved.get(&skn_path_hash).cloned();
            (chunk_hashes, resolved, skn_path)
        });
    let Some((chunk_hashes, resolved, skn_resolved_path)) = mount_view else {
        return Ok(None);
    };

    // BIN-driven path. Each early-return falls through to the
    // animations-folder fallback below so the user still gets
    // *something* playable instead of an empty picker — same shape
    // as the disk variant.
    let bin_walk: Option<(Vec<AnimationClip>, String, u64)> = (|| {
        let bin_match = find_skin_bin(mount_id, skn_path_hash)?;
        let skin_bin_hash = u64::from_str_radix(&bin_match.path_hash_hex, 16).ok()?;

        let info = with_mount(mount_id, |m| {
            m.chunks
                .iter()
                .find(|c| c.path_hash == skin_bin_hash)
                .map(|c| (m.path.clone(), *c))
        })
        .flatten()?;

        let bytes = read_chunk_decompressed_bytes(&info.0, &info.1).ok()?;
        let skin_tree = read_bin_engine(&bytes).ok()?;

        let link_hash = find_animation_graph_link(&skin_tree)?;
        let anim_bin_path = resolve_animation_bin_path(&skin_tree, link_hash)?;
        let anim_bin_chunk_hash = xxh64_lower(&anim_bin_path);

        let anim_info = with_mount(mount_id, |m| {
            m.chunks
                .iter()
                .find(|c| c.path_hash == anim_bin_chunk_hash)
                .map(|c| (m.path.clone(), *c))
        })
        .flatten()?;

        let anim_bytes = read_chunk_decompressed_bytes(&anim_info.0, &anim_info.1).ok()?;
        let anim_tree = read_bin_engine(&anim_bytes).ok()?;

        let graph_obj = view::object(&anim_tree, link_hash)?;
        let clip_map_value = view::field(graph_obj.fields, H_CLIP_DATA_MAP)?;
        let map_entries = match clip_map_value {
            BinValue::Map { items, .. } => items.as_slice(),
            _ => return None,
        };

        let clips = collect_clips(map_entries, |path| {
            path_candidates(path)
                .into_iter()
                .find_map(|c| {
                    let h = xxh64_lower(&c);
                    chunk_hashes.contains(&h).then(|| format!("{:016x}", h))
                })
                .map(|chunk_hex| (Some(chunk_hex), None))
                .unwrap_or((None, None))
        });

        Some((clips, anim_bin_path, anim_bin_chunk_hash))
    })();

    let (bin_clips, bin_path, bin_path_hash) = bin_walk
        .map(|(c, p, h)| (c, Some(p), Some(h)))
        .unwrap_or((Vec::new(), None, None));

    let mut clips = bin_clips;

    // Folder-scan fallback. Same conditions as the disk path: trigger
    // when the BIN walk yielded zero usable clips. We "scan" by
    // walking the mount's resolved-path map for ANMs whose path lies
    // under the SKN's sibling `animations/` directory (the canonical
    // Riot layout). If that directory has < 10 entries, augment with
    // the base/skin0 sibling.
    let any_resolved = clips
        .iter()
        .any(|c| c.anm_chunk_hash_hex.is_some() || c.anm_disk_path.is_some());
    if !any_resolved {
        if let Some(skn_path) = &skn_resolved_path {
            let scanned = scan_animations_chunks_wad(&resolved, skn_path);
            if !scanned.is_empty() {
                clips = scanned;
            }
        }
    }

    // Stable sort so the dropdown is alphabetical regardless of BIN
    // map iteration order. Case-insensitive — animations like
    // "attack1" and "Attack1_A" should sit next to each other.
    clips.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Dedup display names. When two AtomicClipData entries fall back
    // to the same ANM stem (or the hash table happens to resolve
    // distinct hashes to the same string), the user otherwise sees
    // "Idle" three times with no way to tell them apart. Numbering
    // starts at 1 so the FIRST occurrence keeps its bare name —
    // "Idle, Idle1, Idle2, ..." — which reads cleaner than
    // "Idle1, Idle2, Idle3, ...".
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for clip in &mut clips {
        let count = seen.entry(clip.name.clone()).or_insert(0);
        if *count > 0 {
            clip.name = format!("{}{}", clip.name, *count);
        }
        *count += 1;
    }

    if clips.is_empty() {
        return Ok(None);
    }

    Ok(Some(AnimationListing {
        bin_path: bin_path.unwrap_or_default(),
        bin_path_hash_hex: format!("{:016x}", bin_path_hash.unwrap_or(0)),
        clips,
    }))
}

/// WAD analogue of `scan_animations_folder_disk`. Walks the mount's
/// resolved-path map for chunk paths that look like
/// `<skn_parent>/animations/*.anm`. If the skin folder has fewer than
/// 10 hits, also probes the base/skin0 sibling — same heuristic as
/// the disk path, which is what League itself loads from.
fn scan_animations_chunks_wad(
    resolved: &std::collections::HashMap<u64, String>,
    skn_path: &str,
) -> Vec<AnimationClip> {
    let normalized = skn_path.replace('\\', "/").to_lowercase();
    let Some(slash) = normalized.rfind('/') else {
        return Vec::new();
    };
    let skn_parent = &normalized[..slash];

    let primary_prefix = format!("{}/animations/", skn_parent);
    let mut clips = scan_chunks_for_anims(resolved, &primary_prefix);

    if clips.len() < 10 {
        let skin_parent_name = skn_parent.rsplit('/').next().unwrap_or("");
        if let Some(skins_idx) = skn_parent.rfind('/') {
            let skins_dir = &skn_parent[..skins_idx];
            for fallback_skin in ["base", "skin0"] {
                if skin_parent_name == fallback_skin {
                    continue;
                }
                let prefix = format!("{}/{}/animations/", skins_dir, fallback_skin);
                for c in scan_chunks_for_anims(resolved, &prefix) {
                    if !clips.iter().any(|x| x.name == c.name) {
                        clips.push(c);
                    }
                }
            }
        }
    }

    clips
}

/// Direct children of `dir_prefix` ending in `.anm`. Children only —
/// we exclude paths nested in sub-directories so a particle SKN's
/// own animations next door don't bleed into the parent skin's set.
fn scan_chunks_for_anims(
    resolved: &std::collections::HashMap<u64, String>,
    dir_prefix: &str,
) -> Vec<AnimationClip> {
    let mut out = Vec::new();
    for (&path_hash, path) in resolved.iter() {
        let lower = path.to_lowercase();
        if !lower.starts_with(dir_prefix) {
            continue;
        }
        let rest = &lower[dir_prefix.len()..];
        if rest.contains('/') {
            continue;
        }
        if !rest.ends_with(".anm") {
            continue;
        }
        // Strip `.anm` for the display name. Lowercased to match the
        // disk fallback's behavior — stem comes from a lowercased
        // path either way.
        let stem = &rest[..rest.len() - 4];
        out.push(AnimationClip {
            name: stem.to_string(),
            anm_path: path.clone(),
            anm_chunk_hash_hex: Some(format!("{:016x}", path_hash)),
            anm_disk_path: None,
        });
    }
    out
}

/// Walk a `mClipDataMap`'s entries and produce the listing of
/// AtomicClipData clips. The `resolver` closure receives each clip's
/// `mAnimationFilePath` (as written in the BIN — usually
/// `ASSETS/...`) and returns `(chunk_hash_hex, disk_path)` — exactly
/// one of which is set, depending on whether we're previewing from
/// a WAD mount or a disk tree.
///
/// Pulled out so the WAD and disk paths share the same BIN walking
/// logic + dedup/sort post-processing, differing only in how each
/// ANM resolves to a fetchable address.
pub(crate) fn collect_clips<F>(
    map_entries: &[(BinValue, BinValue)],
    mut resolver: F,
) -> Vec<AnimationClip>
where
    F: FnMut(&str) -> (Option<String>, Option<String>),
{
    let mut clips = Vec::new();
    for (key, value) in map_entries {
        let Some(name_hash) = clip_key_hash(key) else {
            continue;
        };
        let Some(props) = atomic_clip_props(value) else {
            continue;
        };
        let Some(anm_path) = atomic_clip_anm_path(props) else {
            continue;
        };

        let display_name = resolve_clip_name(name_hash).unwrap_or_else(|| {
            // Fallback: ANM file stem. mAnimationFilePath is always a
            // string so this is always available — better than
            // surfacing a hex placeholder to the user.
            anm_file_stem(&anm_path).to_string()
        });

        let (anm_chunk_hash_hex, anm_disk_path) = resolver(&anm_path);
        clips.push(AnimationClip {
            name: display_name,
            anm_path: anm_path.clone(),
            anm_chunk_hash_hex,
            anm_disk_path,
        });
    }
    clips
}

/// Disk-source variant of [`read_skn_animations`]. Walks up from the
/// SKN's path to find the matching skin BIN, follows
/// `AnimationGraphData`, parses the animation BIN, and resolves each
/// ANM file path under the disk root.
///
/// Re-pathed mods (where a WAD's contents live under
/// `assets/<WadName>/` instead of directly under `assets/`) are
/// handled transparently — the same subfolder is mirrored under
/// `data/` and injected when reconstructing both the animation BIN
/// path and each ANM file path. As long as `assets/` is in the
/// SKN's path, the folder *between* `assets/` and `characters/` can
/// be named anything (or empty).
///
/// When the BIN-driven walk produces zero clips for any reason (no
/// skin BIN, no `AnimationGraphData`, missing animation BIN, empty
/// `mClipDataMap`, or every clip unresolved), we fall back to a
/// directory scan of `assets/<wad>/characters/<champ>/animations/
/// <skin>/`. This is what League actually loads anyway, and it
/// keeps preview working for mods that ship ANM files without the
/// matching animation BIN.
pub fn read_skn_animations_disk(skn_disk_path: &str) -> Result<Option<AnimationListing>, String> {
    use super::skin_bin::find_skin_bin_disk;

    // For bare SKNs (no `assets/` ancestor — e.g. the user dropped
    // `hwei_base.skn` into Downloads), we skip the BIN-driven walk
    // entirely and rely on the sibling-folder scan below. The
    // "Fetch animations from game" button drops ANMs into the same
    // place the scan reads from, so this is the path that makes it
    // work outside a mod tree.
    let layout_opt = disk_layout_for_skn(skn_disk_path);

    // BIN-driven path. Each early-return falls through to the
    // animations-folder fallback below so the user still gets
    // *something* playable instead of an empty picker.
    let (bin_clips, bin_path_normalized): (Vec<AnimationClip>, Option<String>) = (|| {
        let layout = layout_opt.as_ref()?;
        let skin_bin_path = find_skin_bin_disk(skn_disk_path)?;
        let skin_bytes = std::fs::read(&skin_bin_path).ok()?;
        let skin_tree = read_bin_engine(&skin_bytes).ok()?;

        let link_hash = find_animation_graph_link(&skin_tree)?;
        let anim_bin_rel = resolve_animation_bin_path(&skin_tree, link_hash)?;
        // Try both data/ variants so asymmetric re-paths (asset side
        // carrying a subfolder while data/ stays canonical, or vice
        // versa) still resolve. First existing file wins.
        let anim_bin_path = data_path_variants(&anim_bin_rel, layout)
            .into_iter()
            .find(|p| std::path::Path::new(p).is_file())?;
        let anim_bytes = std::fs::read(&anim_bin_path).ok()?;
        let anim_tree = read_bin_engine(&anim_bytes).ok()?;

        let graph_obj = view::object(&anim_tree, link_hash)?;
        let clip_map_value = view::field(graph_obj.fields, H_CLIP_DATA_MAP)?;
        let map_entries = match clip_map_value {
            BinValue::Map { items, .. } => items.as_slice(),
            _ => return None,
        };

        let clips = collect_clips(map_entries, |anm_path| {
            // BIN-string paths come in as `ASSETS/...`. Lowercase,
            // strip the `assets/` prefix, then probe each candidate
            // form (with subfolder, then without). On Windows NTFS
            // is case-insensitive so casing doesn't matter; on a
            // case-sensitive mount we'd add casing probes here.
            let lower = anm_path.to_lowercase();
            let rel = lower.strip_prefix("assets/").unwrap_or(&lower);
            for candidate in assets_path_variants(rel, layout) {
                if std::path::Path::new(&candidate).is_file() {
                    return (None, Some(candidate));
                }
            }
            (None, None)
        });

        Some((clips, anim_bin_path.replace('\\', "/").to_lowercase()))
    })()
    .map(|(c, p)| (c, Some(p)))
    .unwrap_or((Vec::new(), None));

    let mut clips = bin_clips;

    // Decide whether to augment / replace with folder-scan results.
    //
    //   - If BIN walk produced ZERO clips → use the folder scan
    //     wholesale as the picker source.
    //   - If BIN walk produced clips but every one is unresolved
    //     (chunk_hash and disk_path both None) → folder scan
    //     replaces them.
    //   - If BIN walk produced some resolved clips → leave them
    //     alone. Splicing folder hits in would create duplicates and
    //     possibly mislabel the dedup-suffix numbering.
    let any_resolved = clips
        .iter()
        .any(|c| c.anm_chunk_hash_hex.is_some() || c.anm_disk_path.is_some());
    if !any_resolved {
        let scanned = scan_animations_folder_disk(skn_disk_path);
        if !scanned.is_empty() {
            clips = scanned;
        }
    }

    clips.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for clip in &mut clips {
        let count = seen.entry(clip.name.clone()).or_insert(0);
        if *count > 0 {
            clip.name = format!("{}{}", clip.name, *count);
        }
        *count += 1;
    }

    if clips.is_empty() {
        return Ok(None);
    }

    Ok(Some(AnimationListing {
        bin_path: bin_path_normalized.unwrap_or_default(),
        // No xxh64 hash for disk; surface zeros so the existing
        // `bin_path_hash_hex` field stays populated.
        bin_path_hash_hex: format!("{:016x}", 0u64),
        clips,
    }))
}

/// Walk the `animations/` folder *next to the SKN* (the canonical
/// Riot layout) and return one [`AnimationClip`] per `.anm` file.
/// Display names are the file stem.
///
/// If the skin-specific folder has fewer than 10 ANMs, we also merge
/// in the base/skin0 skin's `animations/` folder (skipping any name
/// collisions). Non-legendary skins typically inherit most of their
/// animations from skin0 — when a skin folder has only a few
/// overrides we want to show the full animation listing, not just
/// the deltas.
fn scan_animations_folder_disk(skn_disk_path: &str) -> Vec<AnimationClip> {
    let normalized = skn_disk_path.replace('\\', "/");
    let Some(slash) = normalized.rfind('/') else {
        return Vec::new();
    };
    let skn_parent = &normalized[..slash];

    // Primary: literally the `animations/` directory next to the SKN.
    let primary_dir = format!("{}/animations/", skn_parent);
    let mut clips = scan_anm_dir(&primary_dir);

    // < 10 → augment with the base/skin0 skin's animations. We don't
    // know if the current skin folder is `base`, `skin0`, `skin01`,
    // etc.; walk up one segment to the `skins/` parent and probe
    // both `base/` and `skin0/`. The 10-file threshold is approximate
    // but separates "non-legendary with a few overrides" from
    // "legendary with its own full set" without needing per-skin
    // metadata.
    if clips.len() < 10 {
        let skin_parent_name = skn_parent.rsplit('/').next().unwrap_or("");
        if let Some(skins_idx) = skn_parent.rfind('/') {
            let skins_dir = &skn_parent[..skins_idx];
            for fallback_skin in ["base", "skin0"] {
                if skin_parent_name == fallback_skin {
                    continue;
                }
                let base_dir = format!("{}/{}/animations/", skins_dir, fallback_skin);
                for c in scan_anm_dir(&base_dir) {
                    if !clips.iter().any(|x| x.name == c.name) {
                        clips.push(c);
                    }
                }
            }
        }
    }

    clips
}

/// Read one directory and emit an [`AnimationClip`] for every `.anm`
/// file inside (non-recursive). Missing or unreadable directories
/// produce an empty list — the caller falls through.
pub fn scan_anm_dir(dir: &str) -> Vec<AnimationClip> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_anm = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("anm"))
            .unwrap_or(false);
        if !is_anm {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let disk_path = path.to_string_lossy().replace('\\', "/").to_string();
        out.push(AnimationClip {
            name: stem.to_string(),
            // `anm_path` doubles as the picker tooltip. Use the
            // disk path here — there's no BIN-side string to
            // attribute to in the fallback path.
            anm_path: disk_path.clone(),
            anm_chunk_hash_hex: None,
            anm_disk_path: Some(disk_path),
        });
    }
    out
}

// ── Tree walkers ────────────────────────────────────────────────────

/// Find `SkinAnimationProperties.AnimationGraphData` (an ObjectLink)
/// anywhere in the skin BIN's top-level objects. Returns the link's
/// u32 hash, which is the `path_hash` of the corresponding entry in
/// the animation BIN.
pub(crate) fn find_animation_graph_link(tree: &BinTree) -> Option<u32> {
    for obj in view::objects(tree) {
        let sap_value = match view::field(obj.fields, H_SKIN_ANIMATION_PROPERTIES) {
            Some(p) => p,
            None => continue,
        };
        let sap_props = match embedded_props(sap_value) {
            Some(p) => p,
            None => continue,
        };
        if let Some(link) = object_link_field(sap_props, H_ANIMATION_GRAPH_DATA) {
            return Some(link);
        }
    }
    None
}

/// Two paths to the animation BIN file:
///   1. Resolve the link hash through the cached BIN hash table to its
///      readable entry path (e.g. "Characters/Volibear/Animations/Skin0"),
///      then build `data/<lowercased>.bin`. Fast + canonical.
///   2. If the hash isn't in the table (custom modder content), scan the
///      skin BIN's `dependencies` list for a path that ends in
///      `/animations/<...>.bin` and use that.
pub(crate) fn resolve_animation_bin_path(skin_tree: &BinTree, link_hash: u32) -> Option<String> {
    if let Some(entry_path) = resolve_clip_name(link_hash) {
        return Some(format!("data/{}.bin", entry_path.to_lowercase()));
    }
    // Dependency-list fallback. The list is small (low-double-digits)
    // so a linear scan is fine.
    for dep in view::dependencies(skin_tree) {
        let lower = dep.to_lowercase();
        // Strip the conventional "data/" prefix off the listed path
        // before pattern-matching — both DATA/... and data/... show
        // up in the wild, and dependencies are emitted as written.
        let stripped = lower.strip_prefix("data/").unwrap_or(&lower);
        if stripped.contains("/animations/") && stripped.ends_with(".bin") {
            return Some(format!("data/{}", stripped));
        }
    }
    None
}

/// Return the property map of an `AtomicClipData`-typed value, or
/// `None` for any other clip-data variant (Sequencer, Selector,
/// Parametric, ...) — those reference children by name and don't own
/// an ANM file directly.
fn atomic_clip_props(value: &BinValue) -> Option<&[BinField]> {
    match value {
        // Map values declared as `pointer` come through as Embed/Pointer.
        BinValue::Embed { name, fields } if name.hash == C_ATOMIC_CLIP_DATA => Some(fields),
        BinValue::Pointer { name, fields } if name.hash == C_ATOMIC_CLIP_DATA => Some(fields),
        _ => None,
    }
}

/// Pull the ANM path out of an AtomicClipData's properties:
///   AtomicClipData.mAnimationResourceData (embed) .mAnimationFilePath (string)
fn atomic_clip_anm_path(props: &[BinField]) -> Option<String> {
    let res_value = view::field(props, H_ANIMATION_RESOURCE_DATA)?;
    let res_props = embedded_props(res_value)?;
    let path = string_field(res_props, H_ANIMATION_FILE_PATH)?;
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

fn clip_key_hash(value: &BinValue) -> Option<u32> {
    match value {
        BinValue::Hash(h) => Some(h.hash),
        // Some clip maps in the wild use `string` keys instead of
        // `hash`. Accept those by hashing on-the-fly so the picker
        // still lists them.
        BinValue::String(s) => Some(fnv1a_runtime_lower(s)),
        _ => None,
    }
}

fn resolve_clip_name(hash: u32) -> Option<String> {
    let lock = jade_hashes::get_cached_hashes();
    let mgr = lock.read();
    mgr.get_fnv1a(hash).map(|cow| cow.into_owned())
}

fn anm_file_stem(path: &str) -> &str {
    let last_slash = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let basename = &path[last_slash..];
    match basename.rfind('.') {
        Some(dot) => &basename[..dot],
        None => basename,
    }
}

// Same convention as `mesh_commands::path_candidates` — try the
// canonical lowercase form first, then a `data/...` mirror for paths
// that point at the asset side. Animation paths are usually
// `ASSETS/Characters/...` which xxh64-matches once we lowercase.
fn path_candidates(path: &str) -> Vec<String> {
    let lower = path.to_lowercase();
    let mut out = vec![lower.clone()];
    if let Some(rest) = lower.strip_prefix("assets/") {
        out.push(format!("data/{rest}"));
    }
    out
}

fn xxh64_lower(s: &str) -> u64 {
    let mut h = XxHash64::with_seed(0);
    h.write(s.as_bytes());
    h.finish()
}

fn fnv1a_runtime_lower(s: &str) -> u32 {
    let bytes = s.as_bytes();
    let mut hash: u32 = 0x811c_9dc5;
    for &b in bytes {
        let lower = if b.is_ascii_uppercase() { b + 32 } else { b };
        hash ^= lower as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

// ── Property unwrappers (mirror skin_textures.rs) ──────────────────

fn embedded_props(v: &BinValue) -> Option<&[BinField]> {
    match v {
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => Some(fields),
        _ => None,
    }
}

fn string_field(fields: &[BinField], name_hash: u32) -> Option<&str> {
    match view::field(fields, name_hash)? {
        BinValue::String(s) => Some(s),
        _ => None,
    }
}

fn object_link_field(fields: &[BinField], name_hash: u32) -> Option<u32> {
    match view::field(fields, name_hash)? {
        BinValue::Link(link) => Some(link.hash),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity-check the FNV1a constants the walker keys on. If any
    /// drift (e.g. a typo in the field name or a case-handling bug
    /// in `fnv1a_lower`), the walker would silently return empty
    /// listings; this catches it at build time instead.
    #[test]
    fn hash_constants_match() {
        // These are the FNV1a-32 of the field names lowercased — same
        // values that the BIN reader would compute when it sees
        // these identifiers.
        assert_eq!(H_SKIN_ANIMATION_PROPERTIES, fnv1a_lower("SkinAnimationProperties"));
        assert_eq!(H_ANIMATION_GRAPH_DATA, fnv1a_lower("AnimationGraphData"));
        assert_eq!(H_CLIP_DATA_MAP, fnv1a_lower("mClipDataMap"));
        assert_eq!(H_ANIMATION_RESOURCE_DATA, fnv1a_lower("mAnimationResourceData"));
        assert_eq!(H_ANIMATION_FILE_PATH, fnv1a_lower("mAnimationFilePath"));
        assert_eq!(C_ATOMIC_CLIP_DATA, fnv1a_lower("AtomicClipData"));
    }

    #[test]
    fn fnv1a_runtime_matches_const() {
        // The runtime fallback (used for clip maps that key on
        // strings) must match the const-time hasher byte-for-byte —
        // otherwise a string-keyed clip's display name resolution
        // would diverge from the hash-keyed path.
        for s in ["Idle1", "Attack1_A", "Spell4_Cast", "RUN_HASTE"] {
            assert_eq!(fnv1a_lower(s), fnv1a_runtime_lower(s), "mismatch on {s}");
        }
    }

    #[test]
    fn anm_stem_strips_extension_and_path() {
        assert_eq!(
            anm_file_stem("ASSETS/Characters/Volibear/Skins/Base/Animations/Volibear_Spell4_Tower_Attacks_1.anm"),
            "Volibear_Spell4_Tower_Attacks_1",
        );
        // No extension and no slash — pass through.
        assert_eq!(anm_file_stem("plain"), "plain");
        // Slash but no dot in the basename.
        assert_eq!(anm_file_stem("path/to/file"), "file");
    }
}
