// Hash module exports
pub mod hashtable;

pub use hashtable::Hashtable;

use std::path::PathBuf;
use crate::error::{Error, Result};

/// Get the RitoShark shared hash directory path
pub fn get_ritoshark_hash_dir() -> Result<PathBuf> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| Error::Hash("APPDATA environment variable not found".to_string()))?;
    
    let path = PathBuf::from(appdata)
        .join("RitoShark")
        .join("Requirements")
        .join("Hashes");
    
    // Ensure directory exists
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| Error::io_with_path(e, &path))?;
    }
    
    Ok(path)
}
