//! BIN asset scanner — walks a root BIN plus any dependency BINs it
//! references on disk, producing a deduped list of asset paths grouped
//! by which BIN(s) contained them.
//!
//! Path resolution: dependency strings in a BIN look like
//! `data/characters/akali/skins/skin0.bin`. We find the "mod root" by
//! walking up from the input file until we hit a directory containing
//! a `data/` or `assets/` sibling, then join each dependency against
//! that root. BINs that fail to resolve are still listed in the report
//! so the user can see them.

use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::bin::{read_bin_engine, JadeBin as BinTree};
use crate::core::bin::jade::view;
use crate::core::bin::repath::{is_referenced_path, visit_strings};

#[derive(Debug, Serialize)]
pub struct BinAssetReportBin {
    /// User-facing label — a path relative to the mod root if we
    /// resolved one, otherwise the absolute path or the original
    /// dependency string.
    pub label: String,
    /// Sorted, deduped asset paths referenced by this BIN.
    pub assets: Vec<String>,
    /// `true` if the BIN was found on disk and parsed; `false` for
    /// unresolved dependencies (still listed so the user sees them).
    pub resolved: bool,
}

#[derive(Debug, Serialize)]
pub struct UnusedFile {
    /// Mod-root-relative path with forward slashes — same shape as
    /// what the BIN scanner emits, so visual diffing is easy.
    pub rel_path: String,
    /// Absolute on-disk path. Frontend uses this for the delete call.
    pub abs_path: String,
    /// File size in bytes; lets the UI sort big offenders to the top.
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct BinAssetReport {
    /// Label for the root BIN (the one the user invoked the scan on).
    pub root_label: String,
    /// Resolved mod-root directory we used for dependency joins, if any.
    pub mod_root: Option<String>,
    /// One entry per scanned BIN, including the root and every
    /// dependency we attempted (resolved or not).
    pub bins: Vec<BinAssetReportBin>,
    /// Files we found on disk under `data/` / `assets/` that no scanned
    /// BIN referenced. Empty if we couldn't find a mod root.
    pub unused_files: Vec<UnusedFile>,
    /// `true` if we walked the disk to compute `unused_files`. `false`
    /// means we didn't have a mod root or the walk failed; the UI can
    /// suppress the "Unused files" section in that case.
    pub disk_walked: bool,
}

/// Find the mod root by walking up from `input` until we hit a
/// directory whose direct child is `data` or `assets`. Returns None if
/// we walk off the end of the filesystem without finding one — caller
/// falls back to per-file relative joins against the input's parent.
fn find_mod_root(input: &Path) -> Option<PathBuf> {
    let mut cur = input.parent()?;
    loop {
        let has_data = cur.join("data").is_dir();
        let has_assets = cur.join("assets").is_dir();
        if has_data || has_assets {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
}

fn collect_assets(tree: &BinTree) -> Vec<String> {
    use std::collections::BTreeSet;
    let mut set: BTreeSet<String> = BTreeSet::new();
    visit_strings(tree, &mut |s| {
        if is_referenced_path(s) {
            set.insert(s.to_string());
        }
    });
    set.into_iter().collect()
}

fn label_relative(abs: &Path, mod_root: Option<&Path>) -> String {
    if let Some(root) = mod_root {
        if let Ok(rel) = abs.strip_prefix(root) {
            return rel.to_string_lossy().replace('\\', "/");
        }
    }
    abs.to_string_lossy().replace('\\', "/")
}

pub fn scan_bin_assets(root: &Path) -> Result<BinAssetReport, String> {
    let bytes = fs::read(root)
        .map_err(|e| format!("read root BIN {}: {}", root.display(), e))?;
    let tree = read_bin_engine(&bytes)
        .map_err(|e| format!("parse root BIN {}: {}", root.display(), e))?;

    let mod_root = find_mod_root(root);
    let root_label = label_relative(root, mod_root.as_deref());

    let mut bins: Vec<BinAssetReportBin> = Vec::new();
    bins.push(BinAssetReportBin {
        label: root_label.clone(),
        assets: collect_assets(&tree),
        resolved: true,
    });

    // Walk dependencies. Each dep is a wad-relative path like
    // `data/characters/.../foo.bin`. Resolve against `mod_root`.
    // BINs that can't be found are still reported so the user sees the
    // gap — e.g. for cross-WAD references when only one WAD is on
    // disk in the mod folder.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(root_label.to_lowercase());
    for dep in view::dependencies(&tree) {
        let dep_norm = dep.replace('\\', "/");
        let key = dep_norm.to_lowercase();
        if !seen.insert(key) { continue; }
        let dep_abs = mod_root
            .as_deref()
            .map(|r| r.join(&dep_norm))
            .unwrap_or_else(|| PathBuf::from(&dep_norm));
        if !dep_abs.is_file() {
            bins.push(BinAssetReportBin {
                label: dep_norm,
                assets: Vec::new(),
                resolved: false,
            });
            continue;
        }
        let label = label_relative(&dep_abs, mod_root.as_deref());
        match fs::read(&dep_abs).map_err(|e| e.to_string()).and_then(|b| {
            read_bin_engine(&b).map_err(|e| e.to_string())
        }) {
            Ok(dep_tree) => bins.push(BinAssetReportBin {
                label,
                assets: collect_assets(&dep_tree),
                resolved: true,
            }),
            Err(_) => bins.push(BinAssetReportBin {
                label,
                assets: Vec::new(),
                resolved: false,
            }),
        }
    }

    // Build a small cross-reference index for the caller: every unique
    // asset path → which BIN labels referenced it. Returned via the
    // same struct (BTreeMap kept deterministic). Callers that don't
    // need the cross-reference can ignore it — we don't add a separate
    // field for now since the per-BIN lists already encode it.
    let _xref: BTreeMap<String, Vec<String>> = BTreeMap::new(); // placeholder for future

    // Walk the mod root for an "unused files" diff. We only know what's
    // unused if we have a mod root — otherwise there's no fixed file set
    // to compare against.
    let (unused_files, disk_walked) = match &mod_root {
        Some(root) => (collect_unused(root, &bins), true),
        None => (Vec::new(), false),
    };

    Ok(BinAssetReport {
        root_label,
        mod_root: mod_root.map(|p| p.to_string_lossy().replace('\\', "/")),
        bins,
        unused_files,
        disk_walked,
    })
}

/// Walk `<root>/data` and `<root>/assets` recursively, returning every
/// file whose mod-root-relative path doesn't appear in any scanned BIN's
/// asset list. Comparison is case-insensitive and forward-slash
/// normalized, matching how BIN strings are emitted.
fn collect_unused(root: &Path, bins: &[BinAssetReportBin]) -> Vec<UnusedFile> {
    // Build the lowercase reference set from every BIN's asset list,
    // plus the BINs themselves — a `data/.../foo.bin` that's both a
    // dependency and on disk should NOT be flagged as unused just
    // because it appears in the "linked BINs" section instead of in
    // an asset list.
    let mut referenced: HashSet<String> = HashSet::new();
    for b in bins {
        for a in &b.assets {
            referenced.insert(a.to_ascii_lowercase().replace('\\', "/"));
        }
        // BIN label itself (already mod-root relative) — covers the
        // linked-BIN files so they don't show up as unused.
        referenced.insert(b.label.to_ascii_lowercase().replace('\\', "/"));
    }

    let mut out: Vec<UnusedFile> = Vec::new();
    for top in ["data", "assets"] {
        let start = root.join(top);
        if start.is_dir() {
            walk_dir(&start, root, &referenced, &mut out);
        }
    }
    // Sort by size descending so the biggest space wins float to the
    // top of the report. Ties broken by path for stable output.
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then_with(|| a.rel_path.cmp(&b.rel_path)));
    out
}

fn walk_dir(dir: &Path, root: &Path, referenced: &HashSet<String>, out: &mut Vec<UnusedFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip our own quarantine bucket if one ever appears at the
        // root — keeps re-runs of the cleanup tool from re-flagging
        // already-set-aside files. Cheap check, harmless if absent.
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("_jade-") { continue; }
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_dir(&path, root, referenced, out);
            continue;
        }
        if !ft.is_file() { continue; }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let lower = rel.to_ascii_lowercase();
        if referenced.contains(&lower) { continue; }
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(UnusedFile {
            rel_path: rel,
            abs_path: path.to_string_lossy().replace('\\', "/"),
            size_bytes,
        });
    }
}
