//! BIN converter hash table.
//!
//! **Hybrid strategy** (the user's compromise):
//! - **BIN names (FNV1a u32)** are loaded from the text hash files
//!   into a sorted `Vec<u32>` + packed string pool. Lookups are
//!   ~50 ns binary-search + slice — no mutex, no allocation, no
//!   syscall. This is what makes BIN conversion fast.
//! - **WAD paths (xxh64 u64)** stay on the shared LMDB env. They're
//!   only hit sporadically (preview pane resolution, WAD listing),
//!   so the per-call LMDB cost doesn't compound.
//!
//! Concretely: `get_fnv1a` only ever reads the in-RAM table and
//! returns `None` if BIN hashes haven't been loaded yet. `get_xxh64`
//! routes through `lookup_wad` (overlay → LMDB). The `is_bin_loaded`
//! flag lets command-layer guards refuse a conversion before names
//! are ready, so users never get a fully-hex-hashed text dump.

use parking_lot::RwLock;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::core::hash::{get_frogtools_hash_dir, get_frogtools_text_hash_dir};
use crate::core::wad::lookup_wad;

pub struct HashManager {
    /// FNV1a → packed `(offset << 16) | length` into [`Self::string_storage`].
    /// Populated from the text hash files; lookup path is binary
    /// search + slice. Empty until [`load`] runs.
    fnv_keys: Vec<u32>,
    fnv_data: Vec<u64>,
    string_storage: Vec<u8>,
    /// FrogTools hash dir — used by `get_xxh64` to route WAD-name
    /// lookups through LMDB.
    hash_dir: Option<PathBuf>,
}

impl HashManager {
    pub fn new() -> Self {
        Self {
            fnv_keys: Vec::new(),
            fnv_data: Vec::new(),
            string_storage: Vec::new(),
            hash_dir: None,
        }
    }

    /// Look up a BIN field-name hash. RAM-only — there's no LMDB
    /// fallback for BIN names anymore, by design. Returns `None`
    /// when the table isn't loaded or the hash isn't known; both are
    /// the same from the converter's POV (it'll skip the property),
    /// but [`is_bin_loaded`] lets the command layer refuse a
    /// conversion before that ever happens.
    pub fn get_fnv1a(&self, hash: u32) -> Option<Cow<'_, str>> {
        let idx = self.fnv_keys.binary_search(&hash).ok()?;
        let dat = self.fnv_data[idx];
        let offset = (dat >> 16) as usize;
        let length = (dat & 0xFFFF) as usize;
        std::str::from_utf8(&self.string_storage[offset..offset + length])
            .ok()
            .map(Cow::Borrowed)
    }

    /// Look up a WAD path hash via the shared LMDB env. WAD lookups
    /// are sporadic (preview pane, WAD listing) so the per-call LMDB
    /// cost doesn't pile up the way it does for BIN names.
    pub fn get_xxh64(&self, hash: u64) -> Option<Cow<'_, str>> {
        let dir = self.hash_dir.as_deref()?;
        let arc = lookup_wad(hash, dir)?;
        Some(Cow::Owned(arc.to_string()))
    }

    /// Load BIN hashes from text into RAM. Always RAM-backed for BIN
    /// names — LMDB is reserved for WAD lookups.
    ///
    /// `hash_dir` is the parent FrogTools hashes folder (where the
    /// shared LMDB env lives). The `.txt` files we walk for BIN names
    /// live in the `text/` subfolder underneath, isolated from Quartz.
    pub fn load(hash_dir: &Path) -> Self {
        if !hash_dir.exists() {
            eprintln!(
                "[jade::hash_manager] Hash directory does not exist: {}",
                hash_dir.display()
            );
            return Self::new();
        }
        Self::load_bin_text(hash_dir)
    }

    /// Walk every `.txt` file in the text-hashes dir, collecting only
    /// 8-char-hex (FNV1a u32) entries into the BIN table. 16-char-hex
    /// entries (xxh64 / WAD names) are skipped — those go through LMDB.
    fn load_bin_text(hash_dir: &Path) -> Self {
        let mut mgr = Self::new();
        // Keep the parent dir on the manager so WAD lookups (which
        // open the shared LMDB env) still point at the right place.
        mgr.hash_dir = Some(hash_dir.to_path_buf());

        // Text hashes live in `<hash_dir>/text/` after the Jade/Quartz
        // split — fall back to scanning `<hash_dir>` directly if the
        // text dir doesn't exist (early-startup ordering / a fresh
        // install where get_frogtools_text_hash_dir hasn't been
        // touched yet).
        let text_dir_owned;
        let text_dir: &Path = match get_frogtools_text_hash_dir() {
            Ok(p) => { text_dir_owned = p; &text_dir_owned }
            Err(_) => hash_dir,
        };

        let entries: Vec<_> = match std::fs::read_dir(text_dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
            Err(e) => {
                eprintln!("[jade::hash_manager] Failed to read hash dir: {}", e);
                return mgr;
            }
        };

        let mut files_to_load = Vec::new();
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip game-specific hashes (per-region, not used by BIN
            // conversion) — same exclusion the original loader did.
            if name.starts_with("hashes.game.") {
                continue;
            }
            // Skip files that are pure WAD-path lists (16-char hashes).
            // Conventional naming: `hashes.game.txt`, `hashes.lcu.txt`,
            // `hashes.rms.txt` are xxh64; the rest are FNV1a.
            // We cheap-check the file's first non-blank line at load
            // time anyway, so we keep the ext-only filter loose.
            if name.ends_with(".txt") {
                files_to_load.push(entry.path());
            }
        }

        // Pre-scan to size the string pool so we don't pay growth realloc
        // costs on a 100 MB load.
        let total_string_size: usize = files_to_load
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len() as usize)
            .sum();
        mgr.string_storage = Vec::with_capacity(total_string_size);

        for file in &files_to_load {
            mgr.load_text_bin_only(file);
        }

        sort_parallel(&mut mgr.fnv_keys, &mut mgr.fnv_data);

        println!(
            "[jade::hash_manager] Loaded {} BIN text hashes (FNV1a only). String pool: {} KB",
            mgr.fnv_keys.len(),
            mgr.string_storage.len() / 1024,
        );

        mgr
    }

    fn load_text_bin_only(&mut self, path: &Path) {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return,
        };

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let space = match line.find(' ') {
                Some(i) if i > 0 && i < line.len() - 1 => i,
                _ => continue,
            };
            let hex_part = &line[..space];
            // Only 8-char hex (FNV1a u32). 16-char hex (xxh64) is for
            // WAD names and goes through LMDB; loading both into RAM
            // would double our memory cost for no win.
            if hex_part.len() != 8 {
                continue;
            }
            let Ok(hash) = u32::from_str_radix(hex_part, 16) else {
                continue;
            };
            let name_part = &line[space + 1..];
            let name_bytes = name_part.as_bytes();
            let str_offset = self.string_storage.len();
            self.string_storage.extend_from_slice(name_bytes);
            self.fnv_keys.push(hash);
            self.fnv_data
                .push(((str_offset as u64) << 16) | (name_bytes.len() as u64 & 0xFFFF));
        }
    }

    /// Total number of BIN hashes loaded into RAM. WAD lookups go
    /// through LMDB and aren't counted here.
    pub fn total_count(&self) -> usize {
        self.fnv_keys.len()
    }

    /// Estimate of in-process bytes held by the BIN hash table.
    pub fn memory_bytes(&self) -> usize {
        self.fnv_keys.len() * std::mem::size_of::<u32>()
            + self.fnv_data.len() * std::mem::size_of::<u64>()
            + self.string_storage.len()
    }

    /// `true` once BIN hashes are populated in RAM. The convert
    /// commands gate on this so they never produce a fully-hashed
    /// text dump — the user always gets resolved field names or an
    /// explicit error.
    pub fn is_bin_loaded(&self) -> bool {
        !self.fnv_keys.is_empty()
    }
}

fn sort_parallel(keys: &mut Vec<u32>, data: &mut Vec<u64>) {
    let mut indices: Vec<usize> = (0..keys.len()).collect();
    indices.sort_by_key(|&i| keys[i]);
    let sorted_keys: Vec<u32> = indices.iter().map(|&i| keys[i]).collect();
    let sorted_data: Vec<u64> = indices.iter().map(|&i| data[i]).collect();
    *keys = sorted_keys;
    *data = sorted_data;
}

/// Check if the Jade hash manager is already loaded.
pub fn are_jade_hashes_loaded() -> bool {
    JADE_HASHES.get().is_some()
}

/// `true` once the BIN-name table is populated in RAM. Used by the
/// convert commands to refuse to run with an empty table — without
/// this gate the converter would happily emit a fully-hex-hashed
/// text dump (every property name as `0xdeadbeef = ...`) which is
/// never what the user wants.
pub fn are_bin_hashes_ready() -> bool {
    JADE_HASHES
        .get()
        .map(|lock| lock.read().is_bin_loaded())
        .unwrap_or(false)
}

/// Trigger the lazy load on a background thread if it hasn't run
/// yet. Returns immediately — caller polls `are_bin_hashes_ready`.
/// Safe to call repeatedly (idempotent via `OnceLock`).
pub fn kick_off_bin_hash_load() {
    if are_jade_hashes_loaded() {
        return;
    }
    std::thread::spawn(|| {
        // Force initialization. The `OnceLock` semantics ensure only
        // one thread does the actual work; later callers wait on the
        // same lock and see the populated manager.
        let _ = get_cached_hashes();
    });
}

fn get_default_hash_dir() -> Option<std::path::PathBuf> {
    get_frogtools_hash_dir().ok()
}

fn load_from_default_hash_dir() -> HashManager {
    if let Some(hash_dir) = get_default_hash_dir() {
        return HashManager::load(&hash_dir);
    }
    eprintln!("[jade::hash_manager] APPDATA not set");
    HashManager::new()
}

/// Global cached hash manager. Uses RwLock so it can be refreshed in-process.
static JADE_HASHES: OnceLock<RwLock<HashManager>> = OnceLock::new();

/// Get or initialize the cached hash manager.
pub fn get_cached_hashes() -> &'static RwLock<HashManager> {
    JADE_HASHES.get_or_init(|| RwLock::new(load_from_default_hash_dir()))
}

/// Reload cached hashes from disk and return total loaded count.
///
/// Loads from disk *before* acquiring the write lock so concurrent readers
/// (e.g. file opens that resolve hash names) only block during the brief
/// swap, not for the full multi-second disk read.
pub fn reload_cached_hashes() -> usize {
    let new_hashes = load_from_default_hash_dir();
    let count = new_hashes.total_count();
    let lock = get_cached_hashes();
    let mut guard = lock.write();
    *guard = new_hashes;
    count
}
