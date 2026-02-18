use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use rayon::prelude::*;
use crate::error::{Error, Result};

#[derive(Clone)]
pub struct Hashtable {
    mappings: HashMap<u64, String>,
    #[allow(dead_code)] // Kept for future reload functionality
    source_dir: PathBuf,
}

#[allow(dead_code)]
impl Hashtable {
    /// Creates an empty Hashtable (for fallback when loading fails or not needed)
    pub fn empty() -> Self {
        Self {
            mappings: HashMap::new(),
            source_dir: PathBuf::new(),
        }
    }
    
    /// Creates a new Hashtable by loading all .txt files from the specified directory
    /// 
    /// # Arguments
    /// * `dir` - Directory containing hash files in the format `<hash> <path>`
    /// 
    /// # Returns
    /// * `Result<Self>` - A new Hashtable with all mappings loaded
    /// 
    /// # Performance
    /// Uses parallel file loading with rayon for faster initialization.
    /// Pre-allocates HashMap capacity for ~4 million entries (typical hash file size).
    pub fn from_directory(dir: impl AsRef<Path>) -> Result<Self> {
        let dir_path = dir.as_ref().to_path_buf();
        
        // Check if directory exists
        if !dir_path.exists() {
            return Err(Error::Hash(format!(
                "Hash directory does not exist: {}",
                dir_path.display()
            )));
        }
        
        if !dir_path.is_dir() {
            return Err(Error::Hash(format!(
                "Path is not a directory: {}",
                dir_path.display()
            )));
        }
        
        // Collect all .txt file paths first
        let txt_files: Vec<PathBuf> = fs::read_dir(&dir_path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("txt"))
            .collect();
        
        println!("[Hashtable] Loading {} hash files in parallel", txt_files.len());
        
        // Load files in parallel using rayon
        let partial_maps: Vec<HashMap<u64, String>> = txt_files
            .par_iter()
            .filter_map(|path| {
                match Self::load_hash_file_to_map(path) {
                    Ok(map) => {
                        Some(map)
                    }
                    Err(e) => {
                        eprintln!("[Hashtable] Failed to load hash file {:?}: {}", path, e);
                        None
                    }
                }
            })
            .collect();
        
        // Pre-allocate HashMap with estimated capacity (~4 million entries typical)
        let total_estimate: usize = partial_maps.iter().map(|m| m.len()).sum();
        let mut mappings = HashMap::with_capacity(total_estimate);
        
        // Merge all partial maps
        for partial in partial_maps {
            mappings.extend(partial);
        }
        
        println!("[Hashtable] Loaded {} total hashes", mappings.len());
        
        Ok(Self {
            mappings,
            source_dir: dir_path,
        })
    }
    
    /// Loads a single hash file and returns its mappings as a new HashMap
    /// This variant is used for parallel loading.
    fn load_hash_file_to_map(path: &Path) -> Result<HashMap<u64, String>> {
        let content = fs::read_to_string(path)?;
        
        // Pre-allocate based on line count estimate (average ~50 chars per line)
        let estimated_lines = content.len() / 50;
        let mut mappings = HashMap::with_capacity(estimated_lines);
        
        Self::parse_hash_content(&content, path, &mut mappings)?;
        
        Ok(mappings)
    }

    /// Loads a single hash file and adds its mappings to the provided HashMap
    /// Used for sequential reload operations.
    #[allow(dead_code)] // Used by reload()
    fn load_hash_file(path: &Path, mappings: &mut HashMap<u64, String>) -> Result<()> {
        let content = fs::read_to_string(path)?;
        Self::parse_hash_content(&content, path, mappings)
    }
    
    /// Parses hash file content and adds mappings to the provided HashMap
    /// Shared parsing logic used by both parallel and sequential loading.
    fn parse_hash_content(content: &str, path: &Path, mappings: &mut HashMap<u64, String>) -> Result<()> {
        for (line_num, line) in content.lines().enumerate() {
            let line = line.trim();
            
            // Skip empty lines and comments
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            
            // Parse format: <hash> <path>
            // Some files (like hashes.binhashes.txt) only have hashes without paths - skip those
            let parts: Vec<&str> = line.splitn(2, ' ').collect();
            
            if parts.len() != 2 {
                // Skip lines that don't have a path (hash-only format for bloom filters)
                continue;
            }
            
            // Parse the hash value
            // CDragon format uses hex hashes (e.g., "e55245ad") without 0x prefix
            // Support: 0x prefix, plain hex, or decimal
            let hash_str = parts[0];
            let hash = if hash_str.starts_with("0x") || hash_str.starts_with("0X") {
                // Explicit hex with prefix
                u64::from_str_radix(&hash_str[2..], 16)
            } else if hash_str.chars().all(|c| c.is_ascii_hexdigit()) {
                // Plain hex (CDragon format) - try hex first
                u64::from_str_radix(hash_str, 16)
            } else {
                // Fall back to decimal
                hash_str.parse::<u64>()
            }
            .map_err(|e| Error::parse_with_path(
                line_num + 1,
                format!(
                    "Invalid hash value: '{}' - {}",
                    hash_str,
                    e
                ),
                path,
            ))?;
            
            let path_str = parts[1].to_string();
            mappings.insert(hash, path_str);
        }
        
        Ok(())
    }

    /// Resolves a hash value to its corresponding path
    /// 
    /// # Arguments
    /// * `hash` - The hash value to resolve
    /// 
    /// # Returns
    /// * `Cow<str>` - The resolved path if found, or hex representation if not found
    pub fn resolve(&self, hash: u64) -> std::borrow::Cow<'_, str> {
        self.mappings
            .get(&hash)
            .map(|s| std::borrow::Cow::Borrowed(s.as_str()))
            .unwrap_or_else(|| std::borrow::Cow::Owned(format!("{:016x}", hash)))
    }

    /// Reloads all hash files from the source directory
    /// 
    /// This method clears the current mappings and reloads all .txt files
    /// from the source directory, allowing the hashtable to pick up any
    /// changes made to the hash files on disk.
    /// 
    /// # Returns
    /// * `Result<()>` - Ok if reload succeeded, Err otherwise
    #[allow(dead_code)] // Kept for future use
    pub fn reload(&mut self) -> Result<()> {
        // Clear existing mappings
        self.mappings.clear();
        
        // Read all .txt files in the directory
        let entries = fs::read_dir(&self.source_dir)?;
        
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            
            // Only process .txt files
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("txt") {
                Self::load_hash_file(&path, &mut self.mappings)?;
            }
        }
        
        Ok(())
    }

    /// Returns the number of hash mappings currently loaded
    pub fn len(&self) -> usize {
        self.mappings.len()
    }

    /// Returns true if the hashtable contains no mappings
    #[allow(dead_code)] // Kept for API completeness
    pub fn is_empty(&self) -> bool {
        self.mappings.is_empty()
    }

    /// Returns an iterator over all hash mappings
    #[allow(dead_code)] // Kept for future use
    pub fn entries(&self) -> impl Iterator<Item = (u64, &String)> {
        self.mappings.iter().map(|(k, v)| (*k, v))
    }
}
