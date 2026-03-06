// Hash module exports
pub mod hashtable;

pub use hashtable::Hashtable;

use std::path::PathBuf;
use crate::error::{Error, Result};

/// Get the shared FrogTools hash directory path used across Quartz/Jade.
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

/// Backward-compatible alias used by existing call sites.
#[allow(dead_code)]
pub fn get_leaguetoolkit_hash_dir() -> Result<PathBuf> {
    get_frogtools_hash_dir()
}
