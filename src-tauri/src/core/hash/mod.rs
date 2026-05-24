// Hash module exports
pub mod hashtable;

pub use hashtable::Hashtable;

use std::path::PathBuf;
use crate::error::{Error, Result};

/// Get the shared FrogTools hash directory path used across Quartz/Jade.
///
/// This stays at the legacy `%APPDATA%/FrogTools/hashes` path because
/// it's a SHARED workspace — Quartz writes its LMDB store, hashtable
/// extractor outputs, and other artifacts here, and Jade reads them.
/// For Jade-specific text hash files, use [`get_frogtools_text_hash_dir`]
/// instead.
pub fn get_frogtools_hash_dir() -> Result<PathBuf> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| Error::Hash("APPDATA environment variable not found".to_string()))?;

    let path = PathBuf::from(appdata)
        .join("FrogTools")
        .join("hashes");

    // Ensure directory exists
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| Error::io_with_path(e, &path))?;
    }

    Ok(path)
}

/// Get Jade's text-hashes directory, isolated from Quartz.
///
/// Quartz writes the same `hashes.binentries.txt` / `hashes.binfields.txt`
/// / etc. file names into `%APPDATA%/FrogTools/hashes`, and our sync
/// would clobber theirs (and vice versa) if we kept everything in the
/// root. The `text/` subfolder gives Jade an isolated home for its
/// downloaded text hashes while still sharing the LMDB store + other
/// binary artifacts with Quartz at the parent level.
///
/// On first creation, MOVES any existing `hashes.*.txt` (+ the matching
/// `hashes-meta.json`) from the parent directory into the new subfolder
/// — so users who already downloaded hashes before this split keep
/// them rather than re-downloading on next sync.
pub fn get_frogtools_text_hash_dir() -> Result<PathBuf> {
    let parent = get_frogtools_hash_dir()?;
    let text_dir = parent.join("text");
    let needed_create = !text_dir.exists();
    if needed_create {
        std::fs::create_dir_all(&text_dir)
            .map_err(|e| Error::io_with_path(e, &text_dir))?;
        // One-time migration on first run after this split lands.
        // Only files matching the conventional pattern get moved so
        // we don't disturb anything Quartz writes at the root.
        let _ = migrate_text_files(&parent, &text_dir);
    }
    Ok(text_dir)
}

fn migrate_text_files(parent: &PathBuf, text_dir: &PathBuf) {
    let candidates = [
        "hashes.binentries.txt",
        "hashes.binfields.txt",
        "hashes.binhashes.txt",
        "hashes.bintypes.txt",
        "hashes.game.txt",
        "hashes.lcu.txt",
        "hashes-meta.json",
    ];
    for name in candidates.iter() {
        let src = parent.join(name);
        let dst = text_dir.join(name);
        if src.exists() && !dst.exists() {
            // Best-effort move; if the rename fails (cross-volume,
            // permissions) we skip and let the next sync re-download
            // into the new location.
            let _ = std::fs::rename(&src, &dst);
        }
    }
}

/// Backward-compatible alias used by existing call sites.
#[allow(dead_code)]
pub fn get_leaguetoolkit_hash_dir() -> Result<PathBuf> {
    get_frogtools_hash_dir()
}
