//! Manage tab backend — load a .fantome / .wad / wad-structured folder
//! mod, health-check it against the live game, apply fixes, and save a
//! repaired copy.
//!
//! A mod is loaded as one or more "WAD units". A unit is backed either
//! by a packed `.wad.client` file or by a loose directory tree whose
//! layout mirrors a WAD's contents (`data/…`, `assets/…`). Folder mods
//! and fantome-extracted folders both go through the same loose path —
//! a fantome is just unzipped to temp first and analyzed as a folder.
//!
//! Pipeline:
//!   `mod_open`  — directory → analyze as folder; .fantome/.zip → unzip
//!                 to temp then analyze; .wad.client → single packed
//!                 unit. Reads META/info.json + image, dates the mod
//!                 from file/zip mtimes.
//!   `mod_scan`  — compare against the live install: linked bins that
//!                 no longer exist (crash on load), chunk overrides
//!                 whose live path vanished (Riot renamed it), and bin
//!                 string refs pointing at nothing. Each issue carries
//!                 ranked replacement suggestions.
//!   `mod_apply_fixes` — rewrite linked lists / string refs across
//!                 every bin in a unit, rename or drop files. Edits
//!                 accumulate in the session; nothing touches disk.
//!   `mod_save`  — folder → write the repaired tree to a directory;
//!                 fantome → re-zip; raw WAD → rebuild the v3.3 file.
//!   `mod_close` — drop the session + temp extraction dir.
//!
//! Detection strategy follows the Topaz/Hematite school: a mod file
//! that exists in the live WAD is a healthy override; one that doesn't
//! but is referenced by the mod's own bins is a custom (repathed)
//! asset; one that is neither is stale. Suggestions come from basename
//! + bigram-similarity matching against the live WAD's resolved paths,
//! with the `.dds ↔ .tex` / `.sco ↔ .scb` alternates checked first.

use crate::core::bin::repath::{is_hud_icon_path, is_referenced_path, visit_strings, visit_strings_mut};
use crate::core::bin::{read_bin_ltk, write_bin_ltk};
use crate::core::hash::get_frogtools_hash_dir;
use crate::core::wad::extractor::chunk_io::{read_chunk_decompressed_bytes, read_chunk_raw};
use crate::core::wad::format::{WadChunk, WadCompression};
use crate::core::wad::lmdb_hashes::resolve_wad_bulk;
use crate::core::wad::reader::read_wad_toc;
use crate::core::wad::writer::{fresh_chunk, write_wad, OutChunk};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;
use std::io::{Read, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

// ── Session state ──────────────────────────────────────────────────────────

/// How a unit's bytes live on disk.
enum WadBacking {
    /// A packed `.wad.client` file at this path.
    Packed(PathBuf),
    /// A loose directory tree rooted here; each file is one entry.
    Folder(PathBuf),
}

/// One file in a mod unit — a chunk in a packed WAD, or a loose file.
#[derive(Clone)]
struct ModEntry {
    path_hash: u64,
    /// Packed-WAD record; `None` for loose files.
    chunk: Option<WadChunk>,
    /// Absolute path of the loose file; `None` for packed chunks.
    loose_path: Option<PathBuf>,
    /// Unit-relative path, original casing — only for loose files, used
    /// to write the file back out at save time.
    rel: Option<String>,
    uncompressed_size: u64,
}

struct ModWadState {
    /// Display name + live-WAD match key, e.g. `Yone.wad.client`.
    name: String,
    /// Where the unit sits relative to the mod root, for folder/fantome
    /// saves (e.g. `WAD/Yone.wad.client`). Empty for root-is-WAD and
    /// single-file sessions.
    mount_rel: String,
    backing: WadBacking,
    entries: Vec<ModEntry>,
    /// path_hash → resolved path (lowercased). Folder units know their
    /// paths directly; packed units resolve via the LMDB hashtable.
    resolved: HashMap<u64, String>,
    /// Chunk hashes confirmed to parse as bins (filled by scan).
    bin_chunks: HashSet<u64>,
    /// path_hash → new decompressed bytes (rewritten bins).
    replaced_data: HashMap<u64, Vec<u8>>,
    /// old path_hash → (new path_hash, new path string).
    renames: HashMap<u64, (u64, String)>,
    removed: HashSet<u64>,
}

impl ModWadState {
    fn has_edits(&self) -> bool {
        !self.replaced_data.is_empty() || !self.renames.is_empty() || !self.removed.is_empty()
    }

    fn packed_path(&self) -> Option<&PathBuf> {
        match &self.backing {
            WadBacking::Packed(p) => Some(p),
            WadBacking::Folder(_) => None,
        }
    }

    /// Effective entry-hash set with renames/removals applied.
    fn effective_hashes(&self) -> HashSet<u64> {
        self.entries
            .iter()
            .filter(|e| !self.removed.contains(&e.path_hash))
            .map(|e| {
                self.renames
                    .get(&e.path_hash)
                    .map(|(h, _)| *h)
                    .unwrap_or(e.path_hash)
            })
            .collect()
    }

    fn display_path(&self, entry: &ModEntry) -> String {
        if let Some((_, p)) = self.renames.get(&entry.path_hash) {
            return p.clone();
        }
        self.resolved
            .get(&entry.path_hash)
            .cloned()
            .unwrap_or_else(|| format!("{:016x}", entry.path_hash))
    }

    fn current_entry_bytes(&self, entry: &ModEntry) -> Result<Vec<u8>, String> {
        if let Some(d) = self.replaced_data.get(&entry.path_hash) {
            return Ok(d.clone());
        }
        if let Some(lp) = &entry.loose_path {
            return std::fs::read(lp).map_err(|e| e.to_string());
        }
        let chunk = entry.chunk.as_ref().ok_or("entry has no backing")?;
        let p = self.packed_path().ok_or("unit has no packed path")?;
        read_chunk_decompressed_bytes(p, chunk).map_err(|e| e.to_string())
    }

    /// First 4 decompressed bytes — bin magic sniffing without paying
    /// to decompress a whole texture.
    fn entry_magic(&self, entry: &ModEntry) -> Option<[u8; 4]> {
        if entry.uncompressed_size < 4 {
            return None;
        }
        if let Some(lp) = &entry.loose_path {
            let mut f = std::fs::File::open(lp).ok()?;
            let mut magic = [0u8; 4];
            f.read_exact(&mut magic).ok()?;
            return Some(magic);
        }
        let chunk = entry.chunk.as_ref()?;
        let p = self.packed_path()?;
        packed_chunk_magic(p, chunk)
    }
}

struct ModSession {
    source_path: PathBuf,
    kind: String, // "fantome" | "wad" | "folder"
    temp_dir: Option<PathBuf>,
    created_ms: Option<i64>,
    wads: Vec<ModWadState>,
}

static SESSIONS: OnceLock<RwLock<HashMap<u64, ModSession>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static RwLock<HashMap<u64, ModSession>> {
    SESSIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

// ── Small helpers ──────────────────────────────────────────────────────────

fn xxh64_lower(s: &str) -> u64 {
    let mut h = twox_hash::XxHash64::with_seed(0);
    h.write(s.to_ascii_lowercase().as_bytes());
    h.finish()
}

/// Unresolved hashes come back from the LMDB lookup as their own
/// 16-char hex spelling — treat those as "no name known".
fn is_hex_name(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn file_ext_lower(path: &str) -> Option<String> {
    path.rsplit('/').next()?.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())
}

fn basename_lower(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase()
}

/// `.dds ↔ .tex` and `.sco ↔ .scb` — Riot has flipped both directions
/// across patches; mods referencing the old spelling still render if
/// the ref is updated to whichever the live WAD actually contains.
fn alternate_ext_path(path_lower: &str) -> Option<String> {
    for (a, b) in [(".dds", ".tex"), (".tex", ".dds"), (".sco", ".scb"), (".scb", ".sco")] {
        if let Some(stem) = path_lower.strip_suffix(a) {
            return Some(format!("{}{}", stem, b));
        }
    }
    None
}

/// Character-bigram Dice coefficient — cheap fuzzy similarity for
/// ranking rename candidates. 1.0 = identical bigram sets.
fn dice(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let grams = |s: &str| -> HashSet<(u8, u8)> {
        let bytes = s.as_bytes();
        (0..bytes.len().saturating_sub(1))
            .map(|i| (bytes[i], bytes[i + 1]))
            .collect()
    };
    let (ga, gb) = (grams(a), grams(b));
    if ga.is_empty() || gb.is_empty() {
        return 0.0;
    }
    let common = ga.intersection(&gb).count() as f64;
    2.0 * common / (ga.len() + gb.len()) as f64
}

/// First decompressed bytes of a packed chunk.
fn packed_chunk_magic(disk_path: &Path, chunk: &WadChunk) -> Option<[u8; 4]> {
    if chunk.uncompressed_size < 4 {
        return None;
    }
    let raw = read_chunk_raw(disk_path, chunk).ok()?;
    let mut magic = [0u8; 4];
    match chunk.compression {
        WadCompression::None => magic.copy_from_slice(raw.get(0..4)?),
        WadCompression::GZip => {
            let mut dec = flate2::read::GzDecoder::new(&raw[..]);
            dec.read_exact(&mut magic).ok()?;
        }
        WadCompression::Zstd | WadCompression::ZstdMulti => {
            let mut dec = zstd::stream::read::Decoder::new(&raw[..]).ok()?;
            dec.read_exact(&mut magic).ok()?;
        }
        WadCompression::Satellite => return None,
    }
    Some(magic)
}

fn looks_like_locale_wad(stem_lower: &str) -> bool {
    // `aatrox.en_us` / `global.cs_cz` — a trailing `.xx_yy` segment.
    if stem_lower.len() < 7 {
        return false;
    }
    let tail = &stem_lower[stem_lower.len() - 6..];
    let b = tail.as_bytes();
    stem_lower.as_bytes()[stem_lower.len() - 7] == b'.'
        && b[0].is_ascii_alphabetic()
        && b[1].is_ascii_alphabetic()
        && b[2] == b'_'
        && b[3].is_ascii_alphabetic()
        && b[4].is_ascii_alphabetic()
        && !b.contains(&b'/')
}

fn wad_key_from_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    lower
        .strip_suffix(".wad.client")
        .or_else(|| lower.strip_suffix(".wad"))
        .unwrap_or(&lower)
        .to_string()
}

/// `data/characters/<champ>/…` → `<champ>` — the live WAD most likely
/// to own the path.
fn champion_key_of_path(path_lower: &str) -> Option<String> {
    let mut segs = path_lower.split('/');
    let root = segs.next()?;
    if root != "data" && root != "assets" {
        return None;
    }
    if segs.next()? != "characters" {
        return None;
    }
    let champ = segs.next()?;
    if champ.is_empty() {
        None
    } else {
        Some(champ.to_string())
    }
}

// ── Live game index ────────────────────────────────────────────────────────

struct LiveWadData {
    hashes: HashSet<u64>,
    /// Lowercased resolved paths — suggestion-search pool. Loaded on
    /// demand (LMDB bulk resolve is the expensive part).
    resolved: Option<Vec<String>>,
}

struct LiveIndex {
    /// lowercase stem (e.g. "yone", "global", "map11") → WAD path.
    files: HashMap<String, PathBuf>,
    loaded: HashMap<String, LiveWadData>,
}

impl LiveIndex {
    fn build(final_dir: &Path) -> Self {
        let mut files = HashMap::new();
        collect_live_wads(final_dir, 0, &mut files);
        LiveIndex { files, loaded: HashMap::new() }
    }

    fn ensure_loaded(&mut self, key: &str) -> Option<&LiveWadData> {
        if !self.loaded.contains_key(key) {
            let path = self.files.get(key)?;
            let toc = read_wad_toc(path).ok()?;
            let hashes = toc.chunks.iter().map(|c| c.path_hash).collect();
            self.loaded
                .insert(key.to_string(), LiveWadData { hashes, resolved: None });
        }
        self.loaded.get(key)
    }

    fn ensure_resolved(&mut self, key: &str) -> Option<&[String]> {
        self.ensure_loaded(key)?;
        let needs = self
            .loaded
            .get(key)
            .map(|d| d.resolved.is_none())
            .unwrap_or(false);
        if needs {
            let hashes: Vec<u64> = self.loaded[key].hashes.iter().copied().collect();
            let hash_dir = get_frogtools_hash_dir().ok()?;
            let resolved_map = resolve_wad_bulk(&hashes, &hash_dir);
            let names: Vec<String> = resolved_map
                .values()
                .filter(|p| !is_hex_name(p))
                .map(|p| p.to_ascii_lowercase())
                .collect();
            if let Some(d) = self.loaded.get_mut(key) {
                d.resolved = Some(names);
            }
        }
        self.loaded.get(key).and_then(|d| d.resolved.as_deref())
    }

    /// Does `path_lower` exist anywhere we'd reasonably look? Checks
    /// the path's own champion WAD first, then the caller's hint keys
    /// (mod counterparts), then the shared pools.
    fn contains_path(&mut self, path_lower: &str, hint_keys: &[String]) -> bool {
        let hash = xxh64_lower(path_lower);
        let mut keys: Vec<String> = Vec::new();
        if let Some(champ) = champion_key_of_path(path_lower) {
            keys.push(champ);
        }
        keys.extend(hint_keys.iter().cloned());
        for shared in ["global", "map11", "map12", "map21", "map22", "map30", "ui"] {
            keys.push(shared.to_string());
        }
        let mut seen = HashSet::new();
        for key in keys {
            if !seen.insert(key.clone()) {
                continue;
            }
            if let Some(data) = self.ensure_loaded(&key) {
                if data.hashes.contains(&hash) {
                    return true;
                }
            }
        }
        false
    }

    fn wad_mtime_ms(&self, key: &str) -> Option<i64> {
        let meta = std::fs::metadata(self.files.get(key)?).ok()?;
        let t = meta.modified().ok()?;
        Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
    }
}

fn collect_live_wads(dir: &Path, depth: u32, out: &mut HashMap<String, PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_live_wads(&path, depth + 1, out);
            continue;
        }
        let Some(name) = path.file_name().map(|s| s.to_string_lossy().to_ascii_lowercase())
        else {
            continue;
        };
        if !name.ends_with(".wad.client") {
            continue;
        }
        let stem = name.trim_end_matches(".wad.client").to_string();
        if looks_like_locale_wad(&stem) {
            continue;
        }
        out.entry(stem).or_insert(path);
    }
}

// ── Folder / fantome analysis ───────────────────────────────────────────────

/// A WAD unit discovered inside a mod directory tree.
struct FoundUnit {
    name: String,
    mount_rel: String,
    backing: WadBacking,
}

struct AnalyzedDir {
    units: Vec<ModWadState>,
    info: serde_json::Value,
    image_b64: Option<String>,
}

fn is_wad_name(name_lower: &str) -> bool {
    name_lower.ends_with(".wad.client") || name_lower.ends_with(".wad")
}

/// True if `dir` has a `data/` or `assets/` child — i.e. it looks like
/// the inside of a WAD rather than a container.
fn dir_has_wad_layout(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for e in entries.flatten() {
        if e.path().is_dir() {
            if let Some(n) = e.file_name().to_str() {
                let l = n.to_ascii_lowercase();
                if l == "data" || l == "assets" {
                    return true;
                }
            }
        }
    }
    false
}

/// Walk a mod root looking for WAD units: directories *or* files named
/// `*.wad.client`. Doesn't descend into a found folder-unit. Skips a
/// top-level `META` folder.
fn find_units(root: &Path, cur: &Path, depth: u32, out: &mut Vec<FoundUnit>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(cur) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        let name_lower = name.to_ascii_lowercase();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if path.is_dir() {
            if depth == 0 && name_lower == "meta" {
                continue;
            }
            if is_wad_name(&name_lower) {
                out.push(FoundUnit {
                    name: name.to_string(),
                    mount_rel: rel,
                    backing: WadBacking::Folder(path),
                });
            } else {
                find_units(root, &path, depth + 1, out);
            }
        } else if is_wad_name(&name_lower) {
            out.push(FoundUnit {
                name: name.to_string(),
                mount_rel: rel,
                backing: WadBacking::Packed(path),
            });
        }
    }
}

/// Collect every loose file under a folder-unit root. `skip_top_meta`
/// drops a `META/` folder at the unit root (only relevant when the unit
/// root *is* the mod root). Returns `(rel_path, abs_path, size, mtime_ms)`.
fn collect_loose(
    unit_root: &Path,
    cur: &Path,
    skip_top_meta: bool,
    out: &mut Vec<(String, PathBuf, u64)>,
    newest_ms: &mut Option<i64>,
) {
    let Ok(entries) = std::fs::read_dir(cur) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        if path.is_dir() {
            if skip_top_meta && cur == unit_root && name.eq_ignore_ascii_case("meta") {
                continue;
            }
            collect_loose(unit_root, &path, skip_top_meta, out, newest_ms);
        } else {
            let rel = path
                .strip_prefix(unit_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let meta = e.metadata().ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            if let Some(ms) = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
            {
                *newest_ms = Some(newest_ms.map_or(ms, |c: i64| c.max(ms)));
            }
            out.push((rel, path, size));
        }
    }
}

fn read_meta(root: &Path) -> (serde_json::Value, Option<String>) {
    let info = ["META/info.json", "meta/info.json", "info.json"]
        .iter()
        .map(|r| root.join(r))
        .find(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let image_b64 = ["META/image.png", "meta/image.png", "META/image.jpg", "meta/image.jpg"]
        .iter()
        .map(|r| root.join(r))
        .find(|p| p.is_file())
        .and_then(|p| std::fs::read(p).ok())
        .map(|b| B64.encode(b));
    (info, image_b64)
}

fn build_folder_unit(unit: FoundUnit, root: &Path, newest_ms: &mut Option<i64>) -> ModWadState {
    let WadBacking::Folder(unit_root) = &unit.backing else {
        unreachable!("build_folder_unit on packed backing");
    };
    let skip_top_meta = unit_root == root;
    let mut files = Vec::new();
    collect_loose(unit_root, unit_root, skip_top_meta, &mut files, newest_ms);

    let mut entries = Vec::with_capacity(files.len());
    let mut resolved = HashMap::with_capacity(files.len());
    for (rel, abs, size) in files {
        let rel_lower = rel.to_ascii_lowercase();
        let hash = xxh64_lower(&rel_lower);
        resolved.insert(hash, rel_lower);
        entries.push(ModEntry {
            path_hash: hash,
            chunk: None,
            loose_path: Some(abs),
            rel: Some(rel),
            uncompressed_size: size,
        });
    }

    ModWadState {
        name: unit.name,
        mount_rel: unit.mount_rel,
        backing: unit.backing,
        entries,
        resolved,
        bin_chunks: HashSet::new(),
        replaced_data: HashMap::new(),
        renames: HashMap::new(),
        removed: HashSet::new(),
    }
}

fn build_packed_unit(name: String, mount_rel: String, path: PathBuf) -> Result<ModWadState, String> {
    let toc = read_wad_toc(&path).map_err(|e| e.to_string())?;
    let hashes: Vec<u64> = toc.chunks.iter().map(|c| c.path_hash).collect();
    let resolved = match get_frogtools_hash_dir() {
        Ok(dir) => resolve_wad_bulk(&hashes, &dir),
        Err(_) => HashMap::new(),
    };
    let entries = toc
        .chunks
        .iter()
        .map(|c| ModEntry {
            path_hash: c.path_hash,
            chunk: Some(*c),
            loose_path: None,
            rel: None,
            uncompressed_size: c.uncompressed_size,
        })
        .collect();
    Ok(ModWadState {
        name,
        mount_rel,
        backing: WadBacking::Packed(path),
        entries,
        resolved,
        bin_chunks: HashSet::new(),
        replaced_data: HashMap::new(),
        renames: HashMap::new(),
        removed: HashSet::new(),
    })
}

/// Analyze a mod directory tree into units + metadata. Shared by folder
/// mods (root = the picked dir) and fantome mods (root = temp extract).
fn analyze_dir(root: &Path, newest_ms: &mut Option<i64>) -> Result<AnalyzedDir, String> {
    let (info, image_b64) = read_meta(root);

    let mut found = Vec::new();
    find_units(root, root, 0, &mut found);

    // No explicit WAD units, but the root itself looks like WAD content
    // → treat the whole folder as one unit.
    if found.is_empty() && dir_has_wad_layout(root) {
        let name = root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "mod".to_string());
        found.push(FoundUnit {
            name,
            mount_rel: String::new(),
            backing: WadBacking::Folder(root.to_path_buf()),
        });
    }

    if found.is_empty() {
        return Err("This folder doesn't look like a mod — no .wad.client files and no data/ or assets/ tree inside".to_string());
    }

    let mut units = Vec::with_capacity(found.len());
    for f in found {
        let unit = match &f.backing {
            WadBacking::Folder(_) => build_folder_unit(f, root, newest_ms),
            WadBacking::Packed(p) => {
                let p = p.clone();
                build_packed_unit(f.name, f.mount_rel, p)?
            }
        };
        units.push(unit);
    }

    Ok(AnalyzedDir { units, info, image_b64 })
}

// ── Open ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ModWadSummary {
    pub name: String,
    pub chunk_count: usize,
    pub size_bytes: u64,
    /// "packed" | "folder"
    pub backing: String,
}

#[derive(Serialize)]
pub struct ModOpenResult {
    pub id: u64,
    pub kind: String,
    pub file_name: String,
    pub name: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub image_b64: Option<String>,
    pub created_ms: Option<i64>,
    pub wads: Vec<ModWadSummary>,
}

fn json_str(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn unit_summary(wad: &ModWadState) -> ModWadSummary {
    let size_bytes = wad
        .entries
        .iter()
        .map(|e| e.uncompressed_size)
        .sum::<u64>();
    ModWadSummary {
        name: wad.name.clone(),
        chunk_count: wad.entries.len(),
        size_bytes,
        backing: match wad.backing {
            WadBacking::Packed(_) => "packed",
            WadBacking::Folder(_) => "folder",
        }
        .to_string(),
    }
}

/// Recursively extract a zip into `dest`, guarding against `..` escapes.
fn extract_zip(source: &Path, dest: &Path) -> Result<Option<i64>, String> {
    let file = std::fs::File::open(source).map_err(|e| format!("Can't open file: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a readable fantome/zip archive: {}", e))?;
    let mut newest_ms: Option<i64> = None;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(safe) = entry.enclosed_name() else { continue };
        let out_path = dest.join(safe);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
        if let Some(ms) = zip_dt_to_ms(&entry.last_modified()) {
            newest_ms = Some(newest_ms.map_or(ms, |c: i64| c.max(ms)));
        }
    }
    Ok(newest_ms)
}

fn zip_dt_to_ms(dt: &zip::DateTime) -> Option<i64> {
    if dt.year() < 1990 {
        return None; // zip's 1980 epoch default = "no real timestamp"
    }
    let date = chrono::NaiveDate::from_ymd_opt(dt.year() as i32, dt.month() as u32, dt.day() as u32)?;
    let dtime = date.and_hms_opt(dt.hour() as u32, dt.minute() as u32, dt.second() as u32)?;
    Some(dtime.and_utc().timestamp_millis())
}

#[tauri::command]
pub async fn mod_open(path: String) -> Result<ModOpenResult, String> {
    let source = PathBuf::from(&path);
    let file_name = source
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let lower = file_name.to_ascii_lowercase();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    // ── Raw single WAD file ──
    if source.is_file() && (lower.ends_with(".wad.client") || lower.ends_with(".wad")) {
        let created_ms = std::fs::metadata(&source)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let unit = build_packed_unit(file_name.clone(), String::new(), source.clone())?;
        let summary = unit_summary(&unit);
        let result = ModOpenResult {
            id,
            kind: "wad".to_string(),
            file_name,
            name: None,
            author: None,
            version: None,
            description: None,
            image_b64: None,
            created_ms,
            wads: vec![summary],
        };
        sessions().write().insert(
            id,
            ModSession {
                source_path: source,
                kind: "wad".to_string(),
                temp_dir: None,
                created_ms,
                wads: vec![unit],
            },
        );
        return Ok(result);
    }

    // ── Folder mod, or fantome (unzip to temp then analyze as folder) ──
    let (kind, root, temp_dir, mut created_ms): (String, PathBuf, Option<PathBuf>, Option<i64>) =
        if source.is_dir() {
            ("folder".to_string(), source.clone(), None, None)
        } else {
            let temp = std::env::temp_dir().join(format!("jade-manage-{}", id));
            std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
            let zip_ms = extract_zip(&source, &temp).map_err(|e| {
                let _ = std::fs::remove_dir_all(&temp);
                e
            })?;
            ("fantome".to_string(), temp.clone(), Some(temp), zip_ms)
        };

    let mut newest_ms: Option<i64> = None;
    let analyzed = match analyze_dir(&root, &mut newest_ms) {
        Ok(a) => a,
        Err(e) => {
            if let Some(t) = &temp_dir {
                let _ = std::fs::remove_dir_all(t);
            }
            return Err(e);
        }
    };
    // Folder mods have no zip timestamp; use the newest member file.
    if created_ms.is_none() {
        created_ms = newest_ms;
    }

    let summaries: Vec<ModWadSummary> = analyzed.units.iter().map(|w| unit_summary(w)).collect();
    let info = &analyzed.info;
    let result = ModOpenResult {
        id,
        kind: kind.clone(),
        file_name,
        name: json_str(info, &["Name", "name"]),
        author: json_str(info, &["Author", "author"]),
        version: json_str(info, &["Version", "version"]),
        description: json_str(info, &["Description", "description"]),
        image_b64: analyzed.image_b64,
        created_ms,
        wads: summaries,
    };

    sessions().write().insert(
        id,
        ModSession {
            source_path: source,
            kind,
            temp_dir,
            created_ms,
            wads: analyzed.units,
        },
    );
    Ok(result)
}

// ── Scan ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ModSuggestion {
    pub path: String,
    /// "high" | "medium" | "low" — derived from `confidence_pct`.
    pub confidence: String,
    /// 1–99% match confidence, shown in the UI.
    pub confidence_pct: u8,
    pub reason: String,
}

#[derive(Serialize)]
pub struct ModIssue {
    pub id: u32,
    /// "missing_linked" | "stale_override" | "missing_asset" | "wrong_extension" | "parse_error"
    pub kind: String,
    /// "error" | "warning" | "info"
    pub severity: String,
    pub wad_name: String,
    /// The broken path (linked bin, asset ref, or chunk path).
    pub path: String,
    /// The bin that references it (empty for stale_override).
    pub owner: String,
    /// How many bins reference it.
    pub ref_count: u32,
    pub message: String,
    pub suggestions: Vec<ModSuggestion>,
    /// What Jade recommends doing: "update" (rewrite the bin ref),
    /// "rename" (re-target the override file), "remove" (drop a dead /
    /// duplicate file), or "none".
    pub recommended_action: String,
    /// Target path for "update" / "rename" actions.
    pub recommended_path: Option<String>,
    /// Whether the recommended action is safe to apply unattended (drives
    /// the "Apply N confident fixes" button).
    pub auto_fixable: bool,
}

#[derive(Serialize)]
pub struct ModWadScanInfo {
    pub name: String,
    pub live_wad: Option<String>,
    pub chunk_count: usize,
    pub bins_parsed: usize,
    pub bins_failed: usize,
}

#[derive(Serialize)]
pub struct ModScanResult {
    pub issues: Vec<ModIssue>,
    pub wads: Vec<ModWadScanInfo>,
    pub refs_checked: usize,
    pub game_newer_than_mod: bool,
    pub truncated: bool,
}

const MAX_ISSUES: usize = 800;

fn confidence_label(pct: u8) -> &'static str {
    if pct >= 80 {
        "high"
    } else if pct >= 62 {
        "medium"
    } else {
        "low"
    }
}

fn pct_of(score: f64) -> u8 {
    ((score * 100.0).round() as i64).clamp(1, 99) as u8
}

fn mk_suggestion(path: &str, pct: u8, reason: &str) -> ModSuggestion {
    ModSuggestion {
        path: path.to_string(),
        confidence: confidence_label(pct).to_string(),
        confidence_pct: pct,
        reason: reason.to_string(),
    }
}

/// File basename without its extension, lowercased.
fn stem_lower(path: &str) -> String {
    let base = basename_lower(path);
    match base.rsplit_once('.') {
        Some((s, _)) => s.to_string(),
        None => base,
    }
}

/// Score for one stem being a prefix/suffix-extension of the other —
/// catches Riot adding `_sona` to make `gq` → `gq_sona`. Boundary-aware
/// (the extension must sit across a `_`/`-`/`.`) so `gq` doesn't
/// spuriously match `gquery`. `None` if there's no real containment.
fn containment_score(a: &str, b: &str) -> Option<f64> {
    if a.len() < 2 || b.len() < 2 {
        return None;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let is_sep = |c: char| c == '_' || c == '-' || c == '.';
    let starts = long.starts_with(short) && long[short.len()..].starts_with(is_sep);
    let ends = long.ends_with(short) && long[..long.len() - short.len()].ends_with(is_sep);
    let ratio = short.len() as f64 / long.len() as f64;
    if starts || ends {
        return Some((0.66 + 0.20 * ratio + 0.12).min(0.95));
    }
    if long.contains(short) && ratio > 0.5 {
        return Some((0.60 + 0.20 * ratio).min(0.85));
    }
    None
}

/// Rank live-game paths as replacements for a missing/renamed `target`.
/// The pool is the live WAD's resolved path list. Matching, best first:
/// exact alt-extension swap, same basename elsewhere, prefix/suffix
/// rename, then general bigram similarity.
fn suggest(target_lower: &str, pool: &[String], allow_alt_ext: bool) -> Vec<ModSuggestion> {
    let target_base = basename_lower(target_lower);
    let target_stem = stem_lower(target_lower);
    let target_ext = file_ext_lower(target_lower);
    let alt = alternate_ext_path(target_lower);
    let mut scored: Vec<(f64, ModSuggestion)> = Vec::new();

    for cand in pool {
        let cand_ext = file_ext_lower(cand);
        if allow_alt_ext {
            if let Some(alt_path) = &alt {
                if cand == alt_path {
                    scored.push((
                        0.97,
                        mk_suggestion(cand, 97, "Same file, Riot flipped the texture format extension"),
                    ));
                    continue;
                }
            }
        }
        let ext_ok = cand_ext == target_ext
            || (allow_alt_ext
                && match (&cand_ext, &target_ext) {
                    (Some(a), Some(b)) => matches!(
                        (a.as_str(), b.as_str()),
                        ("dds", "tex") | ("tex", "dds") | ("sco", "scb") | ("scb", "sco")
                    ),
                    _ => false,
                });
        if !ext_ok {
            continue;
        }
        let cand_base = basename_lower(cand);
        if cand_base == target_base {
            let s = (0.90 + 0.08 * dice(cand, target_lower)).min(0.99);
            scored.push((s, mk_suggestion(cand, pct_of(s), "Same file name at a different path — likely moved")));
            continue;
        }
        if let Some(s) = containment_score(&target_stem, &stem_lower(cand)) {
            scored.push((s, mk_suggestion(cand, pct_of(s), "Riot added or removed a prefix/suffix on the name")));
            continue;
        }
        let s = dice(&cand_base, &target_base) * 0.6 + dice(cand, target_lower) * 0.4;
        if s > 0.5 {
            scored.push((s, mk_suggestion(cand, pct_of(s), "Similar name — possible rename")));
        }
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (_, s) in scored {
        if seen.insert(s.path.clone()) {
            out.push(s);
            if out.len() >= 6 {
                break;
            }
        }
    }
    out
}

/// Recommendation for a bin-ref rewrite (missing linked/asset): pick the
/// top suggestion, auto-fixable only when it's high confidence.
fn recommend_update(suggestions: &[ModSuggestion]) -> (String, Option<String>, bool) {
    match suggestions.first() {
        Some(s) => ("update".to_string(), Some(s.path.clone()), s.confidence_pct >= 80),
        None => ("none".to_string(), None, false),
    }
}

#[tauri::command]
pub async fn mod_scan(id: u64, league_final_path: String) -> Result<ModScanResult, String> {
    let final_dir = PathBuf::from(&league_final_path);
    if !final_dir.exists() {
        return Err("League install folder not found — set it up in Extract Files first".to_string());
    }
    let mut live = LiveIndex::build(&final_dir);
    if live.files.is_empty() {
        return Err("No .wad.client files under the League DATA/FINAL folder".to_string());
    }

    let mut guard = sessions().write();
    let session = guard.get_mut(&id).ok_or("Mod session not found — reopen the mod")?;

    let counterpart_keys: Vec<String> =
        session.wads.iter().map(|w| wad_key_from_name(&w.name)).collect();

    let mod_hashes: HashSet<u64> = session
        .wads
        .iter()
        .flat_map(|w| w.effective_hashes())
        .collect();

    let mut issues: Vec<ModIssue> = Vec::new();
    let mut wad_infos: Vec<ModWadScanInfo> = Vec::new();
    let mut next_issue_id: u32 = 1;
    let mut refs_checked: usize = 0;
    let mut truncated = false;
    let mut game_newer = false;

    let created_ms = session.created_ms;

    // ── Pass 1: parse every bin, collect deps + refs per unit ──
    struct ParsedBin {
        display: String,
        deps: Vec<String>,
        refs: Vec<String>,
    }
    let mut parsed_per_wad: Vec<Vec<ParsedBin>> = Vec::new();
    let mut parse_failures: Vec<Vec<String>> = Vec::new();

    for wad in session.wads.iter_mut() {
        let mut parsed = Vec::new();
        let mut failures = Vec::new();
        let mut new_bin_hashes = Vec::new();
        let entries = wad.entries.clone();
        for entry in &entries {
            if wad.removed.contains(&entry.path_hash) {
                continue;
            }
            let display = wad.display_path(entry);
            let is_named_bin = display.to_ascii_lowercase().ends_with(".bin");
            let maybe_bin = is_named_bin
                || (is_hex_name(&display)
                    && entry.uncompressed_size <= 16 * 1024 * 1024
                    && matches!(
                        wad.entry_magic(entry),
                        Some(m) if &m == b"PROP" || &m == b"PTCH"
                    ));
            if !maybe_bin {
                continue;
            }
            let data = match wad.current_entry_bytes(entry) {
                Ok(d) => d,
                Err(_) => {
                    failures.push(display);
                    continue;
                }
            };
            match read_bin_ltk(&data) {
                Ok(tree) => {
                    let mut refs: Vec<String> = Vec::new();
                    visit_strings(&tree, &mut |s| {
                        if is_referenced_path(s) && s.contains('.') {
                            refs.push(s.to_string());
                        }
                    });
                    new_bin_hashes.push(entry.path_hash);
                    parsed.push(ParsedBin {
                        display,
                        deps: tree.dependencies.clone(),
                        refs,
                    });
                }
                Err(_) => {
                    if is_named_bin {
                        failures.push(display);
                    }
                }
            }
        }
        for h in new_bin_hashes {
            wad.bin_chunks.insert(h);
        }
        parsed_per_wad.push(parsed);
        parse_failures.push(failures);
    }

    let referenced_hashes: HashSet<u64> = parsed_per_wad
        .iter()
        .flatten()
        .flat_map(|b| b.deps.iter().chain(b.refs.iter()))
        .map(|s| xxh64_lower(s))
        .collect();

    // ── Pass 2: issues per unit ──
    for (wi, wad) in session.wads.iter().enumerate() {
        let counterpart_key = wad_key_from_name(&wad.name);
        let live_wad_path = live
            .files
            .get(&counterpart_key)
            .map(|p| p.to_string_lossy().into_owned());

        if let (Some(created), Some(live_mtime)) = (created_ms, live.wad_mtime_ms(&counterpart_key)) {
            if live_mtime > created + 24 * 3600 * 1000 {
                game_newer = true;
            }
        }

        let pool: Vec<String> = live
            .ensure_resolved(&counterpart_key)
            .map(|p| p.to_vec())
            .unwrap_or_default();

        let parsed = &parsed_per_wad[wi];
        // A unit with no parseable bins is treated as a plain asset
        // override pack — we compare files to the game but never
        // auto-nuke "unreferenced" files (there are no refs to go by).
        let unit_has_bins = !parsed.is_empty();
        let mut seen_missing: HashMap<String, usize> = HashMap::new();

        // 2a. Linked-list entries that resolve nowhere → load crash.
        for bin in parsed {
            for dep in &bin.deps {
                refs_checked += 1;
                let dep_lower = dep.to_ascii_lowercase();
                let in_mod = mod_hashes.contains(&xxh64_lower(&dep_lower));
                if in_mod || live.contains_path(&dep_lower, &counterpart_keys) {
                    continue;
                }
                if let Some(&idx) = seen_missing.get(&dep_lower) {
                    issues[idx].ref_count += 1;
                    continue;
                }
                if issues.len() >= MAX_ISSUES {
                    truncated = true;
                    continue;
                }
                let mut dep_pool = pool.clone();
                if let Some(champ) = champion_key_of_path(&dep_lower) {
                    if champ != counterpart_key {
                        if let Some(extra) = live.ensure_resolved(&champ) {
                            dep_pool.extend(extra.iter().cloned());
                        }
                    }
                }
                seen_missing.insert(dep_lower.clone(), issues.len());
                let suggestions = suggest(&dep_lower, &dep_pool, false);
                let (recommended_action, recommended_path, auto_fixable) = recommend_update(&suggestions);
                issues.push(ModIssue {
                    id: next_issue_id,
                    kind: "missing_linked".to_string(),
                    severity: "error".to_string(),
                    wad_name: wad.name.clone(),
                    path: dep.clone(),
                    owner: bin.display.clone(),
                    ref_count: 1,
                    message: "Linked bin no longer exists in the game — loading this mod will crash"
                        .to_string(),
                    suggestions,
                    recommended_action,
                    recommended_path,
                    auto_fixable,
                });
                next_issue_id += 1;
            }
        }

        // 2b. Asset string refs that point at nothing.
        for bin in parsed {
            for r in &bin.refs {
                refs_checked += 1;
                let r_lower = r.to_ascii_lowercase();
                if r_lower.ends_with(".bin") {
                    continue;
                }
                let in_mod = mod_hashes.contains(&xxh64_lower(&r_lower));
                if in_mod || live.contains_path(&r_lower, &counterpart_keys) {
                    continue;
                }
                if let Some(&idx) = seen_missing.get(&r_lower) {
                    issues[idx].ref_count += 1;
                    continue;
                }
                let alt_hit = alternate_ext_path(&r_lower).filter(|alt| {
                    mod_hashes.contains(&xxh64_lower(alt)) || live.contains_path(alt, &counterpart_keys)
                });
                if issues.len() >= MAX_ISSUES {
                    truncated = true;
                    continue;
                }
                seen_missing.insert(r_lower.clone(), issues.len());
                if let Some(alt) = alt_hit {
                    issues.push(ModIssue {
                        id: next_issue_id,
                        kind: "wrong_extension".to_string(),
                        severity: "warning".to_string(),
                        wad_name: wad.name.clone(),
                        path: r.clone(),
                        owner: bin.display.clone(),
                        ref_count: 1,
                        message: "File exists with a different extension — Riot swapped the format"
                            .to_string(),
                        suggestions: vec![mk_suggestion(&alt, 97, "Exact match with swapped extension")],
                        recommended_action: "update".to_string(),
                        recommended_path: Some(alt),
                        auto_fixable: true,
                    });
                } else {
                    let suggestions = suggest(&r_lower, &pool, true);
                    let (recommended_action, recommended_path, auto_fixable) =
                        recommend_update(&suggestions);
                    issues.push(ModIssue {
                        id: next_issue_id,
                        kind: "missing_asset".to_string(),
                        severity: "warning".to_string(),
                        wad_name: wad.name.clone(),
                        path: r.clone(),
                        owner: bin.display.clone(),
                        ref_count: 1,
                        message: "Referenced file isn't in the mod or the live game".to_string(),
                        suggestions,
                        recommended_action,
                        recommended_path,
                        auto_fixable,
                    });
                }
                next_issue_id += 1;
            }
        }

        // 2c. Stale overrides — files whose live path vanished and that
        // nothing in the mod references (so not a custom asset).
        let counterpart_loaded = live.ensure_loaded(&counterpart_key).is_some();
        if counterpart_loaded {
            for entry in &wad.entries {
                if wad.removed.contains(&entry.path_hash) {
                    continue;
                }
                let effective_hash = wad
                    .renames
                    .get(&entry.path_hash)
                    .map(|(h, _)| *h)
                    .unwrap_or(entry.path_hash);
                let display = wad.display_path(entry);
                if is_hex_name(&display) {
                    continue;
                }
                let display_lower = display.to_ascii_lowercase();
                if live.contains_path(&display_lower, &counterpart_keys) {
                    continue;
                }
                if referenced_hashes.contains(&effective_hash) {
                    continue;
                }
                if issues.len() >= MAX_ISSUES {
                    truncated = true;
                    break;
                }
                let is_bin = display_lower.ends_with(".bin");
                // HUD icons under /hud/icons2d/ are resolved by hash
                // through the HUD layer, so they're legitimately absent
                // from bin refs — never auto-remove them.
                let is_icons = is_hud_icon_path(&display_lower);
                let raw = suggest(&display_lower, &pool, true);
                // Would the rename collide with a file the mod already
                // ships (e.g. icon.dds → icon.tex when icon.tex exists)?
                let alt_twin_in_mod = alternate_ext_path(&display_lower)
                    .map(|a| mod_hashes.contains(&xxh64_lower(&a)))
                    .unwrap_or(false);
                let any_collision =
                    alt_twin_in_mod || raw.iter().any(|s| mod_hashes.contains(&xxh64_lower(&s.path)));
                // Only offer renames to targets the mod doesn't already
                // have — colliding renames would just error.
                let free: Vec<ModSuggestion> = raw
                    .into_iter()
                    .filter(|s| !mod_hashes.contains(&xxh64_lower(&s.path)))
                    .collect();
                // Safe to drop if it's not a HUD icon AND either the mod
                // uses bins (so "no ref" really means orphaned) or it's a
                // clear duplicate of a file already in the mod.
                let removable = !is_icons && (unit_has_bins || any_collision);
                let (recommended_action, recommended_path, auto_fixable) =
                    if let Some(best) = free.first() {
                        // A live counterpart exists at a new path —
                        // re-target the override there.
                        ("rename".to_string(), Some(best.path.clone()), best.confidence_pct >= 80)
                    } else if removable {
                        ("remove".to_string(), None, true)
                    } else {
                        ("none".to_string(), None, false)
                    };
                let message = if recommended_action == "remove" && any_collision {
                    "A copy already exists in the mod at the live path — this is a leftover duplicate, safe to remove"
                        .to_string()
                } else if recommended_action == "remove" {
                    "Not referenced by any bin and gone from the live game — safe to remove".to_string()
                } else if recommended_action == "rename" {
                    "The live counterpart was renamed — re-target the override so it applies again"
                        .to_string()
                } else if is_bin {
                    "The game no longer ships a bin at this path — this part of the mod is dead"
                        .to_string()
                } else {
                    "This file no longer exists in the live game, so it overrides nothing".to_string()
                };
                issues.push(ModIssue {
                    id: next_issue_id,
                    kind: "stale_override".to_string(),
                    severity: if is_bin { "error" } else { "warning" }.to_string(),
                    wad_name: wad.name.clone(),
                    path: display,
                    owner: String::new(),
                    ref_count: 0,
                    message,
                    suggestions: free,
                    recommended_action,
                    recommended_path,
                    auto_fixable,
                });
                next_issue_id += 1;
            }
        }

        // 2d. Unparseable bins.
        for failure in &parse_failures[wi] {
            if issues.len() >= MAX_ISSUES {
                truncated = true;
                break;
            }
            issues.push(ModIssue {
                id: next_issue_id,
                kind: "parse_error".to_string(),
                severity: "info".to_string(),
                wad_name: wad.name.clone(),
                path: failure.clone(),
                owner: String::new(),
                ref_count: 0,
                message: "Couldn't parse this bin — it may be corrupt or use an unknown layout"
                    .to_string(),
                suggestions: Vec::new(),
                recommended_action: "none".to_string(),
                recommended_path: None,
                auto_fixable: false,
            });
            next_issue_id += 1;
        }

        wad_infos.push(ModWadScanInfo {
            name: wad.name.clone(),
            live_wad: live_wad_path,
            chunk_count: wad.entries.len(),
            bins_parsed: parsed.len(),
            bins_failed: parse_failures[wi].len(),
        });
    }

    Ok(ModScanResult {
        issues,
        wads: wad_infos,
        refs_checked,
        game_newer_than_mod: game_newer,
        truncated,
    })
}

// ── Fixes ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModFix {
    UpdateLinked { wad_name: String, old_path: String, new_path: String },
    UpdateStringRef { wad_name: String, old_path: String, new_path: String },
    RenameChunk { wad_name: String, chunk_path: String, new_path: String },
    RemoveChunk { wad_name: String, chunk_path: String },
}

#[derive(Serialize)]
pub struct ApplyFixesResult {
    pub applied: u32,
    pub bins_rewritten: u32,
    pub errors: Vec<String>,
}

/// Rewrite `old → new` across every bin entry of the unit — both the
/// dependency list and string leaves. Returns how many bins changed.
fn rewrite_path_in_wad(wad: &mut ModWadState, old_path: &str, new_path: &str) -> Result<u32, String> {
    let mut rewritten = 0u32;
    let bin_hashes: Vec<u64> = if wad.bin_chunks.is_empty() {
        wad.entries
            .iter()
            .filter(|e| {
                wad.resolved
                    .get(&e.path_hash)
                    .map(|p| p.to_ascii_lowercase().ends_with(".bin"))
                    .unwrap_or(false)
            })
            .map(|e| e.path_hash)
            .collect()
    } else {
        wad.bin_chunks.iter().copied().collect()
    };

    for hash in bin_hashes {
        if wad.removed.contains(&hash) {
            continue;
        }
        let Some(entry) = wad.entries.iter().find(|e| e.path_hash == hash).cloned() else {
            continue;
        };
        let data = wad.current_entry_bytes(&entry)?;
        let mut tree = match read_bin_ltk(&data) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let mut changed = false;
        for dep in tree.dependencies.iter_mut() {
            if dep.eq_ignore_ascii_case(old_path) {
                *dep = new_path.to_string();
                changed = true;
            }
        }
        visit_strings_mut(&mut tree, &mut |s| {
            if s.eq_ignore_ascii_case(old_path) {
                *s = new_path.to_string();
                changed = true;
            }
        });
        if changed {
            let bytes = write_bin_ltk(&tree).map_err(|e| e.to_string())?;
            wad.replaced_data.insert(hash, bytes);
            rewritten += 1;
        }
    }
    Ok(rewritten)
}

#[tauri::command]
pub async fn mod_apply_fixes(id: u64, fixes: Vec<ModFix>) -> Result<ApplyFixesResult, String> {
    let mut guard = sessions().write();
    let session = guard.get_mut(&id).ok_or("Mod session not found — reopen the mod")?;

    let mut applied = 0u32;
    let mut bins_rewritten = 0u32;
    let mut errors: Vec<String> = Vec::new();

    for fix in fixes {
        let (wad_name, outcome): (String, Result<u32, String>) = match &fix {
            ModFix::UpdateLinked { wad_name, old_path, new_path }
            | ModFix::UpdateStringRef { wad_name, old_path, new_path } => {
                let res = session
                    .wads
                    .iter_mut()
                    .find(|w| w.name == *wad_name)
                    .ok_or_else(|| format!("WAD {} not in this mod", wad_name))
                    .and_then(|w| rewrite_path_in_wad(w, old_path, new_path));
                (wad_name.clone(), res)
            }
            ModFix::RenameChunk { wad_name, chunk_path, new_path } => {
                let res = session
                    .wads
                    .iter_mut()
                    .find(|w| w.name == *wad_name)
                    .ok_or_else(|| format!("WAD {} not in this mod", wad_name))
                    .and_then(|w| {
                        let old_hash = xxh64_lower(chunk_path);
                        let new_hash = xxh64_lower(new_path);
                        if !w.entries.iter().any(|e| e.path_hash == old_hash) {
                            return Err(format!("Chunk {} not found in {}", chunk_path, wad_name));
                        }
                        if w.effective_hashes().contains(&new_hash) {
                            return Err(format!(
                                "{} already exists in {} — rename would collide",
                                new_path, wad_name
                            ));
                        }
                        w.renames.insert(old_hash, (new_hash, new_path.clone()));
                        w.resolved.insert(new_hash, new_path.to_ascii_lowercase());
                        Ok(0)
                    });
                (wad_name.clone(), res)
            }
            ModFix::RemoveChunk { wad_name, chunk_path } => {
                let res = session
                    .wads
                    .iter_mut()
                    .find(|w| w.name == *wad_name)
                    .ok_or_else(|| format!("WAD {} not in this mod", wad_name))
                    .map(|w| {
                        w.removed.insert(xxh64_lower(chunk_path));
                        0
                    });
                (wad_name.clone(), res)
            }
        };
        match outcome {
            Ok(n) => {
                applied += 1;
                bins_rewritten += n;
            }
            Err(e) => errors.push(format!("[{}] {}", wad_name, e)),
        }
    }

    Ok(ApplyFixesResult { applied, bins_rewritten, errors })
}

// ── Save ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ModSaveResult {
    pub out_path: String,
    pub wads_rebuilt: usize,
    pub total_bytes: u64,
}

/// Rebuild a packed unit into v3.3 WAD bytes, applying edits.
fn rebuild_packed_bytes(wad: &ModWadState) -> Result<Vec<u8>, String> {
    let packed = wad.packed_path().ok_or("not a packed unit")?;
    let mut out_chunks: Vec<OutChunk> = Vec::with_capacity(wad.entries.len());
    for entry in &wad.entries {
        if wad.removed.contains(&entry.path_hash) {
            continue;
        }
        let Some(chunk) = &entry.chunk else { continue };
        let hash = wad
            .renames
            .get(&entry.path_hash)
            .map(|(h, _)| *h)
            .unwrap_or(entry.path_hash);
        if let Some(data) = wad.replaced_data.get(&entry.path_hash) {
            out_chunks.push(fresh_chunk(hash, data));
            continue;
        }
        match chunk.compression {
            WadCompression::ZstdMulti => {
                let data =
                    read_chunk_decompressed_bytes(packed, chunk).map_err(|e| e.to_string())?;
                out_chunks.push(fresh_chunk(hash, &data));
            }
            WadCompression::Satellite => {
                return Err(format!(
                    "{}: satellite-compressed chunk {:016x} can't be rebuilt",
                    wad.name, entry.path_hash
                ));
            }
            _ => {
                let raw = read_chunk_raw(packed, chunk).map_err(|e| e.to_string())?;
                out_chunks.push(OutChunk {
                    path_hash: hash,
                    compression: chunk.compression,
                    compressed: raw,
                    uncompressed_size: chunk.uncompressed_size,
                    checksum: chunk.checksum,
                });
            }
        }
    }
    write_wad(&out_chunks).map_err(|e| e.to_string())
}

/// Output relative path for a loose entry — the rename target if it was
/// renamed, else its original path.
fn entry_out_rel(wad: &ModWadState, entry: &ModEntry) -> String {
    if let Some((_, new_path)) = wad.renames.get(&entry.path_hash) {
        return new_path.replace('\\', "/");
    }
    entry
        .rel
        .clone()
        .or_else(|| wad.resolved.get(&entry.path_hash).cloned())
        .unwrap_or_else(|| format!("{:016x}", entry.path_hash))
}

/// Write the repaired mod tree under `stage`. Returns units rebuilt.
/// Used for both folder saves (stage = out dir) and fantome saves
/// (stage = temp dir that then gets zipped).
fn stage_mod_tree(session: &ModSession, stage: &Path) -> Result<usize, String> {
    // Roots/paths owned by units — used to skip them when copying the
    // mod's "extra" files (META, readmes) verbatim.
    let mut folder_roots: Vec<(PathBuf, bool)> = Vec::new(); // (root, is_mod_root)
    let mut packed_paths: HashSet<PathBuf> = HashSet::new();
    for w in &session.wads {
        match &w.backing {
            WadBacking::Folder(root) => folder_roots.push((root.clone(), w.mount_rel.is_empty())),
            WadBacking::Packed(p) => {
                packed_paths.insert(p.clone());
            }
        }
    }

    // 1. Copy extras (anything not part of a unit's WAD content). For a
    // fantome the source tree is the temp extraction dir, not the .fantome
    // file; for a folder mod it's the picked directory.
    let src_root = session.temp_dir.as_deref().unwrap_or(&session.source_path);
    copy_extras(src_root, src_root, stage, &folder_roots, &packed_paths)?;

    // 2. Write each unit.
    let mut rebuilt = 0;
    for wad in &session.wads {
        let unit_out = if wad.mount_rel.is_empty() {
            stage.to_path_buf()
        } else {
            stage.join(&wad.mount_rel)
        };
        match &wad.backing {
            WadBacking::Packed(src) => {
                let bytes = if wad.has_edits() {
                    rebuilt += 1;
                    rebuild_packed_bytes(wad)?
                } else {
                    std::fs::read(src).map_err(|e| e.to_string())?
                };
                if let Some(parent) = unit_out.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&unit_out, &bytes).map_err(|e| e.to_string())?;
            }
            WadBacking::Folder(_) => {
                if wad.has_edits() {
                    rebuilt += 1;
                }
                for entry in &wad.entries {
                    if wad.removed.contains(&entry.path_hash) {
                        continue;
                    }
                    let rel = entry_out_rel(wad, entry);
                    let dest = unit_out.join(rel_to_native(&rel));
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let bytes = wad.current_entry_bytes(entry)?;
                    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(rebuilt)
}

fn rel_to_native(rel: &str) -> PathBuf {
    let mut p = PathBuf::new();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        p.push(seg);
    }
    p
}

/// Copy every file under `src_root` to `stage` (mirroring relative
/// layout) EXCEPT files that belong to a WAD unit (those are written by
/// the unit logic). For a mod-root folder unit, its `META/` is an extra.
fn copy_extras(
    src_root: &Path,
    cur: &Path,
    stage: &Path,
    folder_roots: &[(PathBuf, bool)],
    packed_paths: &HashSet<PathBuf>,
) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(cur) else { return Ok(()) };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_dir() {
            copy_extras(src_root, &path, stage, folder_roots, packed_paths)?;
            continue;
        }
        if packed_paths.contains(&path) {
            continue;
        }
        // Belongs to a folder unit's WAD content?
        let mut is_unit_content = false;
        for (root, is_mod_root) in folder_roots {
            if path.starts_with(root) {
                if *is_mod_root {
                    // Mod-root unit: META/ at the root is an extra, the
                    // rest is WAD content.
                    let rel = path.strip_prefix(root).unwrap_or(&path);
                    let top = rel.components().next().and_then(|c| c.as_os_str().to_str());
                    if top.map(|t| t.eq_ignore_ascii_case("meta")).unwrap_or(false) {
                        break; // extra → copy
                    }
                }
                is_unit_content = true;
                break;
            }
        }
        if is_unit_content {
            continue;
        }
        let rel = path.strip_prefix(src_root).unwrap_or(&path);
        let dest = stage.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&path, &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Zip a staged directory tree into `out_path`. WAD files are stored
/// (already compressed); everything else is deflated.
fn zip_dir(stage: &Path, out_path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(out_path)
        .map_err(|e| format!("Couldn't create {}: {}", out_path.display(), e))?;
    let mut zw = zip::ZipWriter::new(file);
    let mut stack = vec![stage.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(stage)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let lower = rel.to_ascii_lowercase();
            let method = if lower.ends_with(".wad.client") || lower.ends_with(".wad") {
                zip::CompressionMethod::Stored
            } else {
                zip::CompressionMethod::Deflated
            };
            let opts = zip::write::FileOptions::default().compression_method(method);
            zw.start_file(rel, opts).map_err(|e| e.to_string())?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            zw.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    zw.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mod_save(id: u64, out_path: String) -> Result<ModSaveResult, String> {
    let guard = sessions().read();
    let session = guard.get(&id).ok_or("Mod session not found — reopen the mod")?;

    match session.kind.as_str() {
        // Single raw WAD → rebuild (or copy) one file.
        "wad" => {
            let wad = &session.wads[0];
            let (bytes, rebuilt) = if wad.has_edits() {
                (rebuild_packed_bytes(wad)?, 1)
            } else {
                (std::fs::read(wad.packed_path().unwrap()).map_err(|e| e.to_string())?, 0)
            };
            std::fs::write(&out_path, &bytes)
                .map_err(|e| format!("Couldn't write {}: {}", out_path, e))?;
            Ok(ModSaveResult {
                out_path,
                wads_rebuilt: rebuilt,
                total_bytes: bytes.len() as u64,
            })
        }
        // Folder → write the repaired tree to the chosen directory.
        "folder" => {
            let dest = PathBuf::from(&out_path);
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            let rebuilt = stage_mod_tree(session, &dest)?;
            let total_bytes = dir_size(&dest);
            Ok(ModSaveResult { out_path, wads_rebuilt: rebuilt, total_bytes })
        }
        // Fantome → stage to temp, then zip.
        _ => {
            let stage = std::env::temp_dir().join(format!("jade-manage-save-{}", id));
            let _ = std::fs::remove_dir_all(&stage);
            std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
            let rebuilt = stage_mod_tree(session, &stage).map_err(|e| {
                let _ = std::fs::remove_dir_all(&stage);
                e
            })?;
            let result = zip_dir(&stage, &PathBuf::from(&out_path));
            let _ = std::fs::remove_dir_all(&stage);
            result?;
            let total_bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
            Ok(ModSaveResult { out_path, wads_rebuilt: rebuilt, total_bytes })
        }
    }
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

// ── Close ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn mod_close(id: u64) -> Result<(), String> {
    let session = sessions().write().remove(&id);
    if let Some(s) = session {
        if let Some(tmp) = s.temp_dir {
            let _ = std::fs::remove_dir_all(tmp);
        }
    }
    Ok(())
}
