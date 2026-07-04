//! Repath / asset-walk helpers for BIN trees.
//!
//! Two related operations sit here:
//!
//! - **Asset path enumeration** — given a parsed `BinTree`, walk every
//!   string field (recursively into structs, embedded objects, and
//!   containers) and collect the ones that look like WAD-relative
//!   asset paths (`ASSETS/…`, `DATA/…`, case-insensitive). Used to
//!   build a "what does this skin actually reference" extraction plan
//!   that goes beyond the per-skin folder dump.
//!
//! - **String mutation for repathing** — same walk but mutable; lets a
//!   caller rewrite every asset string in-place so a re-serialized BIN
//!   points at the new layout (e.g. `assets/jade/characters/…`).
//!
//! Quartz's asset-extractor mirror: the prefix is inserted directly
//! after the top-level `assets/` or `data/` segment, preserving the
//! rest of the path verbatim. Anything that isn't an asset path
//! (UUIDs, GUIDs, hash strings, raw words) is left untouched.

// Operates on the canonical Jade-native tree. Containers/maps/options
// are plain `Vec`s here, so the walkers (read and mutate) are simple
// recursion with no rebuilds.
use crate::core::bin::{BinField, BinValue, JadeBin as BinTree};
use crate::core::bin::jade::view;
use std::collections::HashMap;

/// Lowercase the first segment, check if it's `assets/`. Returns the
/// prefix kind and the byte offset where the *rest of the path*
/// begins, so the caller can splice without re-parsing.
///
/// Repath intentionally does NOT touch `data/…` paths: the `data/`
/// tree contains BINs (skin defs, materialDef BINs, sound banks) that
/// the game looks up by canonical hash, and prefixing them tends to
/// break gameplay code paths that don't go through the asset
/// indirection layer. Asset paths (`assets/…`) are the only ones we
/// remap.
fn classify_asset_path(s: &str) -> Option<(&'static str, usize)> {
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("assets/") {
        Some(("assets", "assets/".len()))
    } else {
        None
    }
}

/// True iff the string looks like a BIN-referenced WAD asset path —
/// only `assets/…` (case-insensitive). `data/…` strings are
/// deliberately excluded. Used to gate the repath-rewrite pass so
/// `data/` references stay verbatim while `assets/` paths get the
/// user's prefix spliced in.
pub fn is_asset_path(s: &str) -> bool {
    classify_asset_path(s).is_some()
}

/// True for asset paths the audio engine resolves through its own
/// indirection layer (SFX banks, voiceover banks, generic sound
/// assets). Repathing those strings silently breaks audio because
/// the engine doesn't follow our prefix — the resolver lookup
/// produces the original path and never finds the moved file.
///
/// Pattern matches both Riot's `assets/sounds/...` (Wwise SFX/VO
/// banks) and the older `assets/audio/...` tree. Quartz mirrors this
/// with its `skipSfxRepath` + `skipVoiceoverRepath` flags.
pub fn is_audio_path(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.starts_with("assets/sounds/") || lower.starts_with("assets/audio/")
}

/// True for HUD ability/champion icons under any `…/hud/icons2d/…`
/// folder. The engine looks these up by hash through the HUD layer
/// and doesn't follow our repath prefix, so we must leave both the
/// disk path and the BIN refs canonical when "Preserve HUD icons"
/// is on. Paired with the same option in the extractor.
pub fn is_hud_icon_path(s: &str) -> bool {
    s.to_ascii_lowercase().contains("/hud/icons2d/")
}

/// True for voiceover paths — audio paths whose intermediate
/// segments include `/vo/`. Matches both `assets/sounds/wwise2016/
/// vo/<locale>/...` and the older `assets/audio/vo/...` tree.
/// Distinct from SFX (also audio but NOT under `/vo/`) so the
/// extractor can opt SFX out while VO opts in.
pub fn is_voiceover_path(s: &str) -> bool {
    if !is_audio_path(s) {
        return false;
    }
    s.to_ascii_lowercase().contains("/vo/")
}

/// Collect every string the BIN references — both `assets/` and
/// `data/` (and possibly more), normalized to lowercase. Used by the
/// extractor's BIN-walk plan to figure out which chunks to pull.
///
/// Unlike [`is_asset_path`], this doesn't care about repath — `data/`
/// strings are full WAD-relative paths that need extracting even
/// though they won't be repathed.
pub fn is_referenced_path(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.starts_with("assets/") || lower.starts_with("data/")
}

/// Insert `prefix` immediately after the leading `assets/` or `data/`
/// segment. Returns `None` if the string isn't an asset path. Casing
/// of the original segment is preserved (`ASSETS/…` stays uppercase).
pub fn repath_asset_string(s: &str, prefix: &str) -> Option<String> {
    let (_kind, head_len) = classify_asset_path(s)?;
    let head = &s[..head_len];
    let tail = &s[head_len..];
    // Trim any leading/trailing slashes on the user-supplied prefix so
    // we don't accidentally double up.
    let clean_prefix = prefix.trim_matches('/');
    if clean_prefix.is_empty() {
        return Some(s.to_string());
    }
    Some(format!("{head}{clean_prefix}/{tail}"))
}

/// Mirror of [`repath_asset_string`] but for an on-disk WAD-relative
/// path. Same logic — the disk path string and BIN string formats
/// happen to be identical (both `assets/…` / `data/…`).
pub fn repath_wad_relative(rel: &str, prefix: &str) -> String {
    repath_asset_string(rel, prefix).unwrap_or_else(|| rel.to_string())
}

/// Walk every string leaf in a `BinTree`, calling `f` on each one.
/// Recurses into struct/embedded/container values. Used to enumerate
/// every asset path the BIN references.
pub fn visit_strings<F: FnMut(&str)>(tree: &BinTree, f: &mut F) {
    for obj in view::objects(tree) {
        visit_fields(obj.fields, f);
    }
}

fn visit_fields<F: FnMut(&str)>(fields: &[BinField], f: &mut F) {
    for field in fields {
        visit_value(&field.value, f);
    }
}

fn visit_value<F: FnMut(&str)>(v: &BinValue, f: &mut F) {
    match v {
        BinValue::String(s) => f(s),
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => visit_fields(fields, f),
        // Lists, list2s and `option[...]` all hold a `Vec<BinValue>`.
        // Optionals matter here too — Akali's HUD icons (`iconCircle`,
        // …) live in `option[string]` fields; without recursing them
        // the BIN refs never get repathed.
        BinValue::List { items, .. } | BinValue::List2 { items, .. } | BinValue::Option { items, .. } => {
            for item in items {
                visit_value(item, f);
            }
        }
        // Maps occasionally carry string keys or values.
        BinValue::Map { items, .. } => {
            for (k, v) in items {
                visit_value(k, f);
                visit_value(v, f);
            }
        }
        _ => {}
    }
}

/// Mutable mirror of [`visit_strings`]. Callback can rewrite the
/// string in-place; the caller decides what to do (e.g. only rewrite
/// asset paths). Used for repath BIN rewriting before re-serializing.
pub fn visit_strings_mut<F: FnMut(&mut String)>(tree: &mut BinTree, f: &mut F) {
    if let Some(entries) = view::entries_mut(tree) {
        for (_key, val) in entries.iter_mut() {
            // `_key` is the entry's path-hash (never a string), so we
            // only descend into the object value.
            visit_value_mut(val, f);
        }
    }
}

fn visit_fields_mut<F: FnMut(&mut String)>(fields: &mut [BinField], f: &mut F) {
    for field in fields.iter_mut() {
        visit_value_mut(&mut field.value, f);
    }
}

fn visit_value_mut<F: FnMut(&mut String)>(v: &mut BinValue, f: &mut F) {
    match v {
        BinValue::String(s) => f(s),
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => {
            visit_fields_mut(fields, f)
        }
        BinValue::List { items, .. } | BinValue::List2 { items, .. } | BinValue::Option { items, .. } => {
            for item in items.iter_mut() {
                visit_value_mut(item, f);
            }
        }
        BinValue::Map { items, .. } => {
            for (k, v) in items.iter_mut() {
                visit_value_mut(k, f);
                visit_value_mut(v, f);
            }
        }
        _ => {}
    }
}

/// Convenience: collect every WAD-relative path the BIN references
/// (both `assets/…` and `data/…`), lowercased for hash-table lookup
/// against `m.resolved` entries. The extractor uses this to know
/// which chunks to pull — repathing only affects `assets/` strings,
/// but the BIN still legitimately references `data/` chunks that
/// need to land on disk too.
pub fn collect_asset_paths_lower(tree: &BinTree) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    visit_strings(tree, &mut |s| {
        if is_referenced_path(s) {
            out.push(s.to_ascii_lowercase());
        }
    });
    out
}

/// Convenience: rewrite every asset string in `tree` using
/// [`repath_asset_string`] with the supplied prefix. Strings that
/// aren't asset paths are left untouched. No-op for empty prefix.
pub fn rewrite_asset_paths(tree: &mut BinTree, prefix: &str) {
    let clean = prefix.trim_matches('/');
    if clean.is_empty() {
        return;
    }
    visit_strings_mut(tree, &mut |s| {
        if let Some(rewritten) = repath_asset_string(s, clean) {
            *s = rewritten;
        }
    });
}

/// Combined rewrite pass — applies both:
///   1. The long-path **rename map** (keys are lowercase WAD-relative
///      paths; values are the final destination string the BIN should
///      reference, *already* containing the repath prefix if any).
///   2. The standard **repath** insertion for any asset path that
///      isn't in the rename map.
///
/// The rename branch wins when both could apply because rename-map
/// values are pre-computed to already include the repath prefix —
/// running repath on top would double-prefix them.
pub fn rewrite_bin_strings(
    tree: &mut BinTree,
    prefix: &str,
    rename_map: &HashMap<String, String>,
    do_repath: bool,
    skip_audio_repath: bool,
    skip_hud_repath: bool,
    export_vo: bool,
) {
    let clean = prefix.trim_matches('/');
    let do_repath = do_repath && !clean.is_empty();
    if rename_map.is_empty() && !do_repath {
        return;
    }
    // Single closure used twice — once over the property tree's
    // string leaves, once over the `dependencies` Vec. Keeps the
    // rename / repath / skip-audio / skip-hud logic in one place.
    let mut rewrite_one = |s: &mut String| {
        let lower = s.to_ascii_lowercase();
        if let Some(new) = rename_map.get(&lower) {
            *s = new.clone();
            return;
        }
        if do_repath {
            // Audio refs (SFX + VO) normally stay verbatim — the
            // audio engine resolves them through its own indirection
            // layer. Two exceptions:
            //   - VO when the user opted to export VO (the locale-
            //     WAD walk extracted it into our repathed tree, so
            //     the BIN ref MUST follow).
            // Everything else under `assets/sounds/` / `assets/audio/`
            // stays canonical when the skip flag is on.
            if skip_audio_repath && is_audio_path(s) {
                let is_vo = is_voiceover_path(s);
                if !(is_vo && export_vo) {
                    return;
                }
            }
            // HUD icons go through their own hash-table indirection;
            // when "Preserve HUD icons" is on we keep both the file
            // and its BIN reference at the canonical path.
            if skip_hud_repath && is_hud_icon_path(s) {
                return;
            }
            if let Some(repathed) = repath_asset_string(s, clean) {
                *s = repathed;
            }
        }
    };
    visit_strings_mut(tree, &mut rewrite_one);
    // The `linked:` dependency list is the array Riot uses to find
    // sibling BINs at load time. It sits OUTSIDE the property tree
    // (its own section), so `visit_strings_mut` doesn't touch it. When
    // we rename a linked BIN (long-path mitigation) the dependency
    // string in the primary BIN must update too — otherwise the
    // game looks for `…/skin0.bin` while the file actually lives at
    // `…/linked1.bin` and the link silently dangles.
    if let Some(deps) = view::dependencies_mut(tree) {
        for dep in deps.iter_mut() {
            if let BinValue::String(s) = dep {
                rewrite_one(s);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_assets() {
        // Only assets/ gets a yes — data/ is intentionally excluded
        // from repath because BIN/data paths must stay canonical for
        // the game to resolve them.
        assert!(is_asset_path("ASSETS/Characters/akali/akali.skn"));
        assert!(!is_asset_path("data/characters/akali/skins/skin0.bin"));
        assert!(!is_asset_path("Characters/akali/akali.skn"));
        assert!(!is_asset_path("just-a-name"));
        assert!(!is_asset_path(""));
    }

    #[test]
    fn referenced_path_accepts_both_roots() {
        // `is_referenced_path` is the broader gate used by the
        // extraction plan — we still need to pull `data/`-referenced
        // chunks even though we won't rewrite them.
        assert!(is_referenced_path("assets/x.tex"));
        assert!(is_referenced_path("data/characters/akali/akali.bin"));
        assert!(!is_referenced_path("Characters/akali/akali.skn"));
    }

    #[test]
    fn repath_preserves_casing() {
        assert_eq!(
            repath_asset_string("ASSETS/Characters/akali/akali.skn", "jade").as_deref(),
            Some("ASSETS/jade/Characters/akali/akali.skn"),
        );
    }

    #[test]
    fn repath_leaves_data_paths_alone() {
        assert!(repath_asset_string("data/characters/akali/skins/skin0.bin", "jade").is_none());
    }

    #[test]
    fn repath_trims_slashes_in_prefix() {
        assert_eq!(
            repath_asset_string("assets/foo.tex", "/jade/").as_deref(),
            Some("assets/jade/foo.tex"),
        );
    }

    #[test]
    fn repath_skips_empty_prefix() {
        assert_eq!(
            repath_asset_string("assets/foo.tex", ""),
            Some("assets/foo.tex".to_string()),
        );
    }

    #[test]
    fn repath_skips_non_asset_strings() {
        assert!(repath_asset_string("not-a-path", "jade").is_none());
    }
}
