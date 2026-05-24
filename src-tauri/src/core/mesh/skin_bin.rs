//! Find the .bin that belongs to a given .skn inside a mounted WAD.
//!
//! League's convention (cross-checked with Flint's `find_skin_bin` and
//! Quartz's mod-tree layout):
//!
//! ```text
//! data/characters/{champion}/skins/{skin}.bin       ← the material/skin BIN
//! assets/characters/{champion}/skins/{skin}/<file>.skn  ← mesh (typical)
//! data/characters/{champion}/skins/{skin}/<file>.skn    ← mesh (some champs)
//! ```
//!
//! `{skin}` is `skin0`..`skinNN` (or sometimes the mesh sits under
//! `base/` which Riot maps to `skin0.bin`).
//!
//! We don't walk the disk — the mount has every chunk already, both
//! resolved and as raw path hashes. So the lookup is:
//!   1. Pull the SKN's resolved path.
//!   2. Derive `{champion}` and `{skin}` from it.
//!   3. Construct candidate BIN paths.
//!   4. xxh64-hash each candidate, look it up in the mount's chunk set.
//!   5. Return the first hit (path + hash).
//!
//! If the SKN's path is unresolved (only the 16-char hex is known), we
//! can't derive the champion → return `None`. Once the hash scanner
//! recovers the SKN's name, the next call will succeed.

use std::collections::HashSet;
use std::hash::Hasher;
use std::path::PathBuf;

use serde::Serialize;
use twox_hash::XxHash64;

use crate::core::wad::with_mount;

/// Result of a successful skin-BIN lookup. `path` is normalized to the
/// canonical lower-case forward-slash form Riot uses internally.
#[derive(Debug, Clone, Serialize)]
pub struct SkinBinMatch {
    pub path: String,
    pub path_hash_hex: String,
}

/// Look up the skin BIN belonging to an SKN by its `path_hash` inside
/// the mount identified by `mount_id`. Returns `None` if the SKN isn't
/// in the mount, its path isn't resolved yet, or no candidate BIN
/// matches a chunk in the mount.
pub fn find_skin_bin(mount_id: u64, skn_path_hash: u64) -> Option<SkinBinMatch> {
    with_mount(mount_id, |m| {
        // Build a hash-set of every chunk hash in the mount for O(1)
        // candidate testing. (One mount has at most ~50k chunks, so the
        // set fits comfortably in memory.)
        let chunk_hashes: HashSet<u64> = m.chunks.iter().map(|c| c.path_hash).collect();
        let resolved_skn = m.resolved.get(&skn_path_hash)?.to_lowercase();
        let candidates = candidate_skin_bin_paths(&resolved_skn);

        for candidate in candidates {
            let h = xxh64_path(&candidate);
            if chunk_hashes.contains(&h) {
                return Some(SkinBinMatch {
                    path: candidate,
                    path_hash_hex: format!("{:016x}", h),
                });
            }
        }
        None
    })
    .flatten()
}

/// Disk-source layout extracted from an SKN path.
///
/// `root` is everything *before* the `assets/` segment, including the
/// trailing slash (e.g. `C:/extracted/MyMod/`).
///
/// `wad_subfolder` is the intermediate path between `assets/` and
/// `characters/` — empty for canonical mods, populated for "re-pathed"
/// mods where the contents of a WAD live under a named subfolder of
/// `assets/` (e.g. `assets/Sett.wad/characters/...`). The same
/// subfolder mirrors under `data/`, so we have to inject it when
/// reconstructing BIN / ANM / texture paths.
#[derive(Debug, Clone)]
pub struct DiskLayout {
    pub root: String,
    pub wad_subfolder: String,
}

/// Compute the [`DiskLayout`] for an SKN path. Returns `None` only when
/// the path doesn't contain an `assets/` segment — without that anchor
/// we can't infer where the data tree lives. If `characters/` doesn't
/// appear under `assets/`, `wad_subfolder` is empty (we treat the SKN
/// as canonical-but-non-champion rather than refusing it).
pub fn disk_layout_for_skn(skn_disk_path: &str) -> Option<DiskLayout> {
    let normalized = skn_disk_path.replace('\\', "/");
    let lower = normalized.to_lowercase();

    let assets_idx = if let Some(idx) = lower.find("/assets/") {
        idx + 1
    } else if lower.starts_with("assets/") {
        0
    } else {
        return None;
    };

    let root = normalized[..assets_idx].to_string();
    let after_assets_idx = assets_idx + "assets/".len();
    if after_assets_idx > normalized.len() {
        return Some(DiskLayout { root, wad_subfolder: String::new() });
    }

    // Look for the `characters/` segment in what comes after `assets/`.
    // Anything between the two segments is the wad-subfolder injection.
    // Mods often re-path the entire contents of a WAD into a folder
    // named after the source WAD ("Sett.wad/", "MyMod/", whatever); the
    // SKN, BIN, animations, and textures all live under that same
    // subfolder so we only have to capture it once here and pass it
    // through.
    let after_assets_lower = &lower[after_assets_idx..];
    let chars_idx = match after_assets_lower.find("characters/") {
        Some(i) => i,
        None => {
            return Some(DiskLayout { root, wad_subfolder: String::new() });
        }
    };
    let wad_subfolder = normalized[after_assets_idx..after_assets_idx + chars_idx].to_string();

    Some(DiskLayout { root, wad_subfolder })
}

/// Look up the chroma BIN (`data/characters/{champ}/skins/skin{N}.bin`)
/// belonging to a CDragon chroma id, *given* the base SKN's path so we
/// can derive `{champ}`. `chroma_skin_num` is `chroma_cdragon_id % 1000`
/// — chromas occupy their own `skinNN` slot on disk, siblings of the
/// parent skin (not children embedded in its BIN).
///
/// Tries the literal `skinNN.bin` first and the no-leading-zero form
/// `skin{n}.bin` second (Riot uses both inconsistently for single-digit
/// numbers). Returns `None` if the SKN isn't resolved, the champion
/// can't be inferred, or no candidate BIN exists in the mount.
pub fn find_chroma_bin(
    mount_id: u64,
    base_skn_path_hash: u64,
    chroma_skin_num: u32,
) -> Option<SkinBinMatch> {
    with_mount(mount_id, |m| {
        let chunk_hashes: HashSet<u64> = m.chunks.iter().map(|c| c.path_hash).collect();
        let resolved_skn = m.resolved.get(&base_skn_path_hash)?.to_lowercase();

        let parts: Vec<&str> = resolved_skn
            .split(|c| c == '/' || c == '\\')
            .filter(|s| !s.is_empty())
            .collect();
        let champion = extract_champion(&parts)?;

        let raw = format!("data/characters/{champion}/skins/skin{chroma_skin_num:02}.bin");
        let stripped = format!("data/characters/{champion}/skins/skin{chroma_skin_num}.bin");

        for candidate in [raw, stripped] {
            let h = xxh64_path(&candidate);
            if chunk_hashes.contains(&h) {
                return Some(SkinBinMatch {
                    path: candidate,
                    path_hash_hex: format!("{:016x}", h),
                });
            }
        }
        None
    })
    .flatten()
}

/// Same as [`find_skin_bin`] but for disk-source previews. Walks up
/// from the SKN path until it finds an `assets/` segment, then tries
/// both `data/<wad_subfolder>/...` and plain `data/...` to construct
/// the canonical skin-BIN candidate. Returns the absolute disk path
/// of the first existing BIN.
///
/// Why try both: re-paths can be *asymmetric*. A mod can repath only
/// `assets/` (e.g. `assets/4c4b59aa/characters/...`) while keeping
/// `data/` at the canonical layout (`data/characters/...`). The
/// reverse also exists. We don't know which side carries the
/// subfolder until we look, so we probe both.
pub fn find_skin_bin_disk(skn_disk_path: &str) -> Option<String> {
    let layout = disk_layout_for_skn(skn_disk_path)?;
    // Normalise to forward slashes for the candidate generator —
    // it splits on both, but the join we do below assumes one.
    let normalized = skn_disk_path.replace('\\', "/").to_lowercase();

    // Reuse the canonical-BIN candidate logic — same skin/champ
    // extraction the WAD path goes through.
    let candidates = candidate_skin_bin_paths(&normalized);
    for candidate in candidates {
        for variant in data_path_variants(&candidate, &layout) {
            if std::path::Path::new(&variant).is_file() {
                return Some(variant);
            }
        }
    }
    None
}

/// Build absolute-path candidates for a `data/`-rooted relative path.
/// Tries the `wad_subfolder`-injected form first, then the plain form
/// — order matters only when both files exist (preferred = the one
/// that matches the SKN's own subtree).
pub fn data_path_variants(rel: &str, layout: &DiskLayout) -> Vec<String> {
    let mut out = Vec::with_capacity(2);
    let injected = rejoin_under_data(rel, &layout.wad_subfolder);
    out.push(format!("{}{}", layout.root, injected));
    // If subfolder is empty, `injected == rel` and the plain push is
    // redundant — skip it to keep the candidate list dedup'd.
    if !layout.wad_subfolder.is_empty() {
        out.push(format!("{}{}", layout.root, rel));
    }
    out
}

/// Build absolute-path candidates for a BIN-string `assets/`-rooted
/// relative path (the leading `assets/` already stripped by the caller).
/// Tries `<root>assets/<wad_subfolder><rel>` first, then
/// `<root>assets/<rel>` as a fallback. Asymmetric repaths can have
/// `assets/` carry the subfolder but BIN strings reference the
/// canonical path — or vice versa.
pub fn assets_path_variants(rel: &str, layout: &DiskLayout) -> Vec<String> {
    let mut out = Vec::with_capacity(2);
    out.push(format!(
        "{}assets/{}{}",
        layout.root, layout.wad_subfolder, rel
    ));
    if !layout.wad_subfolder.is_empty() {
        out.push(format!("{}assets/{}", layout.root, rel));
    }
    out
}

/// Inject `wad_subfolder` after the `data/` prefix of a canonical
/// relative path. `data/characters/x/y` + `Sett.wad/` →
/// `data/Sett.wad/characters/x/y`. Empty subfolder is a no-op.
pub fn rejoin_under_data(rel: &str, wad_subfolder: &str) -> String {
    if wad_subfolder.is_empty() {
        return rel.to_string();
    }
    if let Some(rest) = rel.strip_prefix("data/") {
        format!("data/{}{}", wad_subfolder, rest)
    } else {
        rel.to_string()
    }
}

/// Generate every `data/characters/{champion}/skins/{skin}.bin` candidate
/// for a given SKN path. Multiple variants because Riot is inconsistent
/// — sometimes the mesh sits under `assets/`, sometimes `data/`,
/// sometimes `skin0/` and sometimes `base/`. We try them all and let
/// the chunk-set lookup pick the one that exists.
fn candidate_skin_bin_paths(skn_path_lower: &str) -> Vec<String> {
    let parts: Vec<&str> = skn_path_lower
        .split(|c| c == '/' || c == '\\')
        .filter(|s| !s.is_empty())
        .collect();

    let champion = extract_champion(&parts);
    let skin = extract_skin(&parts);

    let mut out: Vec<String> = Vec::new();
    let Some(champion) = champion else {
        return out;
    };

    // Helper to push without duplicates.
    let mut push = |s: String| {
        if !out.iter().any(|x| x == &s) {
            out.push(s);
        }
    };

    if let Some(ref skin) = skin {
        // Primary candidate — the literal skin folder name with `.bin`.
        push(format!("data/characters/{champion}/skins/{skin}.bin"));

        // Zero-stripped variant. Riot is inconsistent: the mesh folder
        // is sometimes `skin02/` while the matching BIN file is named
        // `skin2.bin` (no leading zero). Emit both so whichever is
        // present in the WAD wins. For double-digit skins the strip
        // is a no-op (`skin11` → `skin11`), so the dedup helper
        // handles it cleanly.
        if let Some(num_str) = skin.strip_prefix("skin") {
            if let Ok(n) = num_str.parse::<u32>() {
                push(format!("data/characters/{champion}/skins/skin{}.bin", n));
            }
        }
        // IMPORTANT: do NOT fall back to `skin0.bin` here. A `skin02`
        // SKN whose specific BIN happens to be missing from the WAD
        // would otherwise falsely match the base-skin BIN — wrong
        // materials, wrong textures, hours of confusion. Returning an
        // empty/short list and `None` from the lookup is much better
        // than returning a wrong answer.
    } else {
        // We couldn't determine the skin from the path (the SKN sits
        // outside the canonical `skins/{skinNN}/` layout). Last-resort
        // fallback to skin0.bin so we still try *something* useful.
        push(format!("data/characters/{champion}/skins/skin0.bin"));
    }

    out
}

/// Pick the champion name out of a path. Two common patterns:
///   - `.../characters/{champion}/...`     ← the canonical one
///   - `assets/characters/{champion}/...`  ← same, just rooted at assets/
/// First match wins.
fn extract_champion(parts: &[&str]) -> Option<String> {
    for (i, p) in parts.iter().enumerate() {
        if *p == "characters" && i + 1 < parts.len() {
            return Some(parts[i + 1].to_string());
        }
    }
    None
}

/// Pick the skin folder out of a path. Looks for `skins/{skinNN|base}`
/// — falls back to `None` if the path doesn't follow that layout.
fn extract_skin(parts: &[&str]) -> Option<String> {
    for (i, p) in parts.iter().enumerate() {
        if *p == "skins" && i + 1 < parts.len() {
            let next = parts[i + 1];
            if next == "base" {
                return Some("skin0".to_string());
            }
            // Any `skinNN` literal is taken verbatim.
            if next.starts_with("skin")
                && next.len() > 4
                && next[4..].chars().all(|c| c.is_ascii_digit())
            {
                return Some(next.to_string());
            }
        }
    }
    None
}

fn xxh64_path(s: &str) -> u64 {
    let mut h = XxHash64::with_seed(0);
    h.write(s.as_bytes());
    h.finish()
}

#[allow(dead_code)]
fn _suppress_unused_pathbuf_import_warning() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_champion_from_canonical_layout() {
        let parts: Vec<&str> = "data/characters/aatrox/skins/skin0/aatrox.skn".split('/').collect();
        assert_eq!(extract_champion(&parts).as_deref(), Some("aatrox"));
    }

    #[test]
    fn extracts_champion_from_assets_layout() {
        let parts: Vec<&str> =
            "assets/characters/lux/skins/skin12/lux.skn".split('/').collect();
        assert_eq!(extract_champion(&parts).as_deref(), Some("lux"));
    }

    #[test]
    fn maps_base_to_skin0() {
        let parts: Vec<&str> = "data/characters/aatrox/skins/base/aatrox.skn".split('/').collect();
        assert_eq!(extract_skin(&parts).as_deref(), Some("skin0"));
    }

    #[test]
    fn extracts_skin_literal() {
        let parts: Vec<&str> =
            "data/characters/lux/skins/skin42/lux.skn".split('/').collect();
        assert_eq!(extract_skin(&parts).as_deref(), Some("skin42"));
    }

    #[test]
    fn ignores_non_skin_subdir() {
        let parts: Vec<&str> = "data/characters/aatrox/animations/idle.anm".split('/').collect();
        assert_eq!(extract_skin(&parts), None);
    }

    #[test]
    fn candidate_set_includes_skin0_fallback() {
        let cand = candidate_skin_bin_paths("data/characters/aatrox/skins/base/aatrox.skn");
        assert!(cand.iter().any(|p| p == "data/characters/aatrox/skins/skin0.bin"));
    }

    /// Regression: when the SKN sits under a specific skin folder
    /// (e.g. `skin02/`), the candidate set must NOT include `skin0.bin`.
    /// Falling back to skin0 caused wrong-material matches in the wild
    /// (skin02.skn was being paired with skin0.bin's textures).
    #[test]
    fn no_skin0_fallback_when_specific_skin_inferred() {
        let cand = candidate_skin_bin_paths("data/characters/aatrox/skins/skin02/aatrox.skn");
        assert!(cand.contains(&"data/characters/aatrox/skins/skin02.bin".to_string()));
        // Zero-stripped variant — Riot sometimes drops the leading 0 in
        // BIN filenames even when the mesh folder keeps it.
        assert!(cand.contains(&"data/characters/aatrox/skins/skin2.bin".to_string()));
        // The bug we're guarding against:
        assert!(!cand.contains(&"data/characters/aatrox/skins/skin0.bin".to_string()));
    }

    /// Two-digit skins shouldn't generate spurious extra candidates
    /// (no zero to strip, dedup keeps the list at size 1).
    #[test]
    fn double_digit_skin_emits_one_candidate() {
        let cand = candidate_skin_bin_paths("data/characters/lux/skins/skin11/lux.skn");
        assert_eq!(cand, vec!["data/characters/lux/skins/skin11.bin".to_string()]);
    }

    /// Canonical layout: `assets/` directly contains `characters/`.
    /// `wad_subfolder` must be empty so existing mods keep working.
    #[test]
    fn disk_layout_canonical_has_empty_subfolder() {
        let layout = disk_layout_for_skn(
            "C:/extracted/MyMod/assets/characters/sett/skins/skin0/sett.skn",
        )
        .expect("layout");
        assert_eq!(layout.root, "C:/extracted/MyMod/");
        assert_eq!(layout.wad_subfolder, "");
    }

    /// Re-pathed mod: the contents of a WAD are placed under a named
    /// subfolder of `assets/` (and the matching `data/` mirror keeps
    /// the same subfolder). We must capture that name so callers can
    /// inject it back.
    #[test]
    fn disk_layout_repathed_captures_subfolder() {
        let layout = disk_layout_for_skn(
            "C:/extracted/MyMod/assets/Sett.wad/characters/sett/skins/skin0/sett.skn",
        )
        .expect("layout");
        assert_eq!(layout.root, "C:/extracted/MyMod/");
        assert_eq!(layout.wad_subfolder, "Sett.wad/");
    }

    /// The subfolder might itself be a multi-segment path. We
    /// preserve it verbatim — we don't care what it's named, only
    /// that it sits between `assets/` and `characters/`.
    #[test]
    fn disk_layout_multi_segment_subfolder() {
        let layout = disk_layout_for_skn(
            "C:/extracted/assets/wad_dir/sub_dir/characters/sett/skins/skin0/sett.skn",
        )
        .expect("layout");
        assert_eq!(layout.wad_subfolder, "wad_dir/sub_dir/");
    }

    #[test]
    fn rejoin_under_data_inserts_subfolder() {
        assert_eq!(
            rejoin_under_data("data/characters/sett/skins/skin0.bin", "Sett.wad/"),
            "data/Sett.wad/characters/sett/skins/skin0.bin"
        );
    }

    #[test]
    fn rejoin_under_data_no_op_on_empty_subfolder() {
        let p = "data/characters/sett/skins/skin0.bin";
        assert_eq!(rejoin_under_data(p, ""), p);
    }

    /// data_path_variants must produce TWO candidates when a subfolder
    /// is present — injected-first, then plain. The plain variant is
    /// what catches asymmetric repaths (Sett.wad case: `assets/`
    /// carries a subfolder but `data/` is canonical).
    #[test]
    fn data_path_variants_emits_injected_then_plain() {
        let layout = DiskLayout {
            root: "C:/mod/".to_string(),
            wad_subfolder: "4c4b59aa/".to_string(),
        };
        let variants = data_path_variants("data/characters/sett/skins/skin0.bin", &layout);
        assert_eq!(
            variants,
            vec![
                "C:/mod/data/4c4b59aa/characters/sett/skins/skin0.bin".to_string(),
                "C:/mod/data/characters/sett/skins/skin0.bin".to_string(),
            ]
        );
    }

    #[test]
    fn data_path_variants_skips_redundant_when_no_subfolder() {
        let layout = DiskLayout {
            root: "C:/mod/".to_string(),
            wad_subfolder: String::new(),
        };
        let variants = data_path_variants("data/characters/sett/skins/skin0.bin", &layout);
        assert_eq!(variants, vec!["C:/mod/data/characters/sett/skins/skin0.bin"]);
    }

    /// Assets-side resolution: the BIN string is stripped of `assets/`
    /// by the caller, then we re-prefix with each candidate. Subfolder
    /// candidate first, plain fallback second.
    #[test]
    fn assets_path_variants_tries_both_forms() {
        let layout = DiskLayout {
            root: "C:/mod/".to_string(),
            wad_subfolder: "4c4b59aa/".to_string(),
        };
        let variants =
            assets_path_variants("characters/sett/skins/base/sett_base_tx_cm.dds", &layout);
        assert_eq!(
            variants,
            vec![
                "C:/mod/assets/4c4b59aa/characters/sett/skins/base/sett_base_tx_cm.dds".to_string(),
                "C:/mod/assets/characters/sett/skins/base/sett_base_tx_cm.dds".to_string(),
            ]
        );
    }

}
