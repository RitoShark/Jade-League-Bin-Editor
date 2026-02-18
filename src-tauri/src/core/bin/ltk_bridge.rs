//! Compatibility bridge to ltk_meta and ltk_ritobin for BIN file handling.
//!
//! This module provides a simplified interface to the League Toolkit libraries,
//! wrapping their APIs for use throughout the application.

use std::io::Cursor;
use std::sync::OnceLock;
use parking_lot::RwLock;
use ltk_meta::{BinTree, BinTreeObject};

/// Maximum allowed BIN file size (50MB - no legitimate BIN should be larger)
pub const MAX_BIN_SIZE: usize = 50 * 1024 * 1024;

/// Error type for BIN operations
#[derive(Debug)]
pub struct BinError(pub String);

impl std::fmt::Display for BinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for BinError {}

/// Result type for BIN operations
pub type Result<T> = std::result::Result<T, BinError>;

/// Read a binary BIN file from bytes.
///
/// # Arguments
/// * `data` - The binary data to parse
///
/// # Returns
/// A `BinTree` structure containing the parsed data
///
/// # Safety
/// This function validates file size and magic bytes to prevent memory issues
/// from corrupt files. Files larger than 50MB are rejected.
pub fn read_bin(data: &[u8]) -> Result<BinTree> {
    // DEFENSIVE: Log file info before parsing
    println!(
        "[ltk_bridge] read_bin: size={} bytes, magic={:02x?}",
        data.len(),
        &data[..std::cmp::min(8, data.len())]
    );

    // Reject obviously corrupt files (too large)
    if data.len() > MAX_BIN_SIZE {
        eprintln!(
            "[ltk_bridge] BIN file rejected: {} bytes exceeds max size of {} bytes",
            data.len(),
            MAX_BIN_SIZE
        );
        return Err(BinError(format!(
            "BIN file too large ({} bytes, max {} bytes) - likely corrupt",
            data.len(),
            MAX_BIN_SIZE
        )));
    }

    // Validate BIN magic bytes (PROP or PTCH)
    if data.len() >= 4 {
        let magic = &data[0..4];
        if magic != b"PROP" && magic != b"PTCH" {
            eprintln!(
                "[ltk_bridge] Invalid BIN magic bytes: {:02x?} (expected PROP or PTCH)",
                magic
            );
            return Err(BinError(format!(
                "Invalid BIN magic bytes: {:02x?} (expected PROP or PTCH)",
                magic
            )));
        }
    } else {
        eprintln!("[ltk_bridge] BIN file too small: {} bytes (minimum 4 bytes for magic)", data.len());
        return Err(BinError(format!(
            "BIN file too small ({} bytes, minimum 4 bytes for magic)",
            data.len()
        )));
    }

    // catch_unwind to handle OOM panics from ltk_meta
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // CRITICAL: Print right before the dangerous call - flush to ensure visibility before crash
        use std::io::Write;
        println!("[ltk_bridge] Calling BinTree::from_reader ({} bytes)...", data.len());
        let _ = std::io::stdout().flush();
        
        let mut cursor = Cursor::new(data);
        BinTree::from_reader(&mut cursor)
    }));

    match result {
        Ok(Ok(tree)) => {
            println!(
                "[ltk_bridge] Successfully parsed BIN: {} objects, {} dependencies",
                tree.objects.len(),
                tree.dependencies.len()
            );
            Ok(tree)
        }
        Ok(Err(e)) => {
            eprintln!("[ltk_bridge] BIN parse failed: {} (file was {} bytes)", e, data.len());
            Err(BinError(format!("Failed to parse bin: {}", e)))
        }
        Err(panic_info) => {
            let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            eprintln!(
                "[ltk_bridge] CRITICAL: Parser panicked on {} byte file: {}",
                data.len(),
                panic_msg
            );
            Err(BinError(format!(
                "Parser panicked (likely OOM or stack overflow): {}",
                panic_msg
            )))
        }
    }
}

/// Write a BinTree to binary format.
///
/// # Arguments
/// * `tree` - The BinTree to serialize
///
/// # Returns
/// A Vec<u8> containing the binary data
pub fn write_bin(tree: &BinTree) -> Result<Vec<u8>> {
    let mut buffer = Cursor::new(Vec::new());
    tree.to_writer(&mut buffer)
        .map_err(|e| BinError(format!("Failed to write bin: {}", e)))?;
    Ok(buffer.into_inner())
}

/// Convert a BinTree to ritobin text format.
///
/// # Arguments
/// * `tree` - The BinTree to convert
///
/// # Returns
/// A String containing the ritobin text format
pub fn tree_to_text(tree: &BinTree) -> Result<String> {
    ltk_ritobin::write(tree)
        .map_err(|e| BinError(format!("Failed to convert to text: {}", e)))
}

/// Convert a BinTree to ritobin text format with hash name lookup.
///
/// # Arguments
/// * `tree` - The BinTree to convert
/// * `hashes` - Hash provider for name lookup
///
/// # Returns
/// A String containing the ritobin text format with resolved names
pub fn tree_to_text_with_hashes<H: ltk_ritobin::HashProvider>(
    tree: &BinTree,
    hashes: &H,
) -> Result<String> {
    ltk_ritobin::write_with_hashes(tree, hashes)
        .map_err(|e| BinError(format!("Failed to convert to text: {}", e)))
}

/// Load BIN-specific hash files into a HashMapProvider
///
/// Loads hashes from the RitoShark hash directory:
/// - hashes.bintypes (type names)
/// - hashes.binfields (field/property names)
/// - hashes.binentries (entry/object names)
/// - hashes.binhashes (generic hashes)
///
/// Prefers binary .bin files if available, falls back to .txt files.
///
/// # Returns
/// A HashMapProvider populated with all loaded hashes
pub fn load_bin_hashes() -> HashMapProvider {
    let mut hashes = HashMapProvider::new();

    // Get the RitoShark hash directory
    let hash_dir = if let Ok(appdata) = std::env::var("APPDATA") {
        std::path::PathBuf::from(appdata)
            .join("RitoShark")
            .join("Requirements")
            .join("Hashes")
    } else {
        eprintln!("[ltk_bridge] APPDATA not set, cannot load hash files");
        return hashes;
    };

    if !hash_dir.exists() {
        eprintln!("[ltk_bridge] Hash directory does not exist: {}", hash_dir.display());
        return hashes;
    }

    // Define hash files with their category mappings
    let hash_files = [
        ("hashes.binentries", "entries"),
        ("hashes.binfields", "fields"),
        ("hashes.binhashes", "hashes"),
        ("hashes.bintypes", "types"),
    ];

    let mut binary_count = 0;
    let mut text_count = 0;

    for (base_name, category) in &hash_files {
        let bin_path = hash_dir.join(format!("{}.bin", base_name));
        let txt_path = hash_dir.join(format!("{}.txt", base_name));

        // Prefer binary format if available
        if bin_path.exists() {
            match load_binary_hash_file(&bin_path, &mut hashes, category) {
                Ok(count) => {
                    println!("[ltk_bridge] Loaded {} hashes from binary file: {}.bin", count, base_name);
                    binary_count += 1;
                }
                Err(e) => {
                    eprintln!("[ltk_bridge] Failed to load binary hash file {}.bin: {}", base_name, e);
                    eprintln!("[ltk_bridge] Falling back to text file if available");

                    // Fall back to text file
                    if txt_path.exists() {
                        let result = match *category {
                            "entries" => hashes.load_entries(&txt_path),
                            "fields" => hashes.load_fields(&txt_path),
                            "hashes" => hashes.load_hashes(&txt_path),
                            "types" => hashes.load_types(&txt_path),
                            _ => {
                                eprintln!("[ltk_bridge] Unknown category: {}", category);
                                continue;
                            }
                        };
                        if result.is_ok() {
                            text_count += 1;
                        }
                    }
                }
            }
        } else if txt_path.exists() {
            // Load text file
            let result = match *category {
                "entries" => hashes.load_entries(&txt_path),
                "fields" => hashes.load_fields(&txt_path),
                "hashes" => hashes.load_hashes(&txt_path),
                "types" => hashes.load_types(&txt_path),
                _ => {
                    eprintln!("[ltk_bridge] Unknown category: {}", category);
                    continue;
                }
            };
            if result.is_ok() {
                text_count += 1;
            }
        } else {
            eprintln!("[ltk_bridge] Hash file not found: {} (neither .bin nor .txt)", base_name);
        }
    }

    let total = hashes.total_count();
    println!(
        "[ltk_bridge] Loaded {} total BIN hashes ({} from binary, {} from text files)",
        total, binary_count, text_count
    );

    hashes
}

/// Global cache for BIN hash provider - loaded once, reused for all conversions
/// This eliminates the massive overhead of loading hash files for every BIN conversion
static BIN_HASHES_CACHE: OnceLock<RwLock<HashMapProvider>> = OnceLock::new();

/// Get or initialize the cached BIN hash provider
/// 
/// This is thread-safe and will only load hashes from disk once.
/// All subsequent calls return the cached version.
pub fn get_cached_bin_hashes() -> &'static RwLock<HashMapProvider> {
    BIN_HASHES_CACHE.get_or_init(|| {
        println!("[ltk_bridge] Initializing global BIN hash cache...");
        let hashes = load_bin_hashes();
        println!("[ltk_bridge] Global BIN hash cache initialized with {} hashes", hashes.total_count());
        RwLock::new(hashes)
    })
}

/// Convert a BinTree to ritobin text format using the cached hash provider
/// 
/// This is the preferred method for BIN conversion as it reuses the globally
/// cached hash provider instead of loading from disk each time.
pub fn tree_to_text_cached(tree: &BinTree) -> Result<String> {
    let hashes = get_cached_bin_hashes().read();
    tree_to_text_with_hashes(tree, &*hashes)
}

/// Convert a BinTree to ritobin text format with automatic hash loading
///
/// **DEPRECATED**: Use `tree_to_text_cached()` instead for better performance.
/// This function is kept for backwards compatibility but now uses the cache internally.
#[allow(dead_code)]
pub fn tree_to_text_with_resolved_names(tree: &BinTree) -> Result<String> {
    // Use cached version for performance
    tree_to_text_cached(tree)
}

/// Parse ritobin text format to BinTree.
///
/// # Arguments
/// * `text` - The ritobin text to parse
///
/// # Returns
/// A BinTree structure
pub fn text_to_tree(text: &str) -> Result<BinTree> {
    ltk_ritobin::parse_to_bin_tree(text)
        .map_err(|e| BinError(format!("Failed to parse text: {}", e)))
}

/// Get the list of linked/dependency BIN files from a BinTree.
#[allow(dead_code)]
pub fn get_dependencies(tree: &BinTree) -> &[String] {
    &tree.dependencies
}

/// Set the list of linked/dependency BIN files for a BinTree.
#[allow(dead_code)]
pub fn set_dependencies(tree: &mut BinTree, deps: Vec<String>) {
    tree.dependencies = deps;
}

/// Get an object from the tree by path hash.
#[allow(dead_code)]
pub fn get_object(tree: &BinTree, path_hash: u32) -> Option<&BinTreeObject> {
    tree.objects.get(&path_hash)
}

/// Get a mutable object from the tree by path hash.
#[allow(dead_code)]
pub fn get_object_mut(tree: &mut BinTree, path_hash: u32) -> Option<&mut BinTreeObject> {
    tree.objects.get_mut(&path_hash)
}

/// Insert an object into the tree.
#[allow(dead_code)]
pub fn insert_object(tree: &mut BinTree, object: BinTreeObject) {
    tree.objects.insert(object.path_hash, object);
}

/// Remove an object from the tree by path hash.
#[allow(dead_code)]
pub fn remove_object(tree: &mut BinTree, path_hash: u32) -> Option<BinTreeObject> {
    tree.objects.shift_remove(&path_hash)
}

// Re-export ltk_ritobin types for hash provider support
pub use ltk_ritobin::HashMapProvider;

/// Read a 7-bit encoded integer (compatible with .NET BinaryWriter)
fn read_7bit_encoded_int(data: &[u8], offset: &mut usize) -> std::io::Result<usize> {
    let mut result = 0usize;
    let mut shift = 0;

    loop {
        if *offset >= data.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Unexpected end of data while reading 7-bit encoded int"
            ));
        }

        let byte = data[*offset];
        *offset += 1;

        result |= ((byte & 0x7F) as usize) << shift;

        if (byte & 0x80) == 0 {
            break;
        }

        shift += 7;
    }

    Ok(result)
}

/// Load binary hash file in HHSH format into a HashMapProvider
///
/// Binary format:
/// - Magic: "HHSH" (4 bytes)
/// - Version: i32 (4 bytes)
/// - FNV1a count: i32 (4 bytes)
/// - XXH64 count: i32 (4 bytes)
/// - FNV1a entries: [u32 hash, 7-bit encoded string length, string bytes]
/// - XXH64 entries: [u64 hash, 7-bit encoded string length, string bytes]
fn load_binary_hash_file(
    path: &std::path::Path,
    hashes: &mut HashMapProvider,
    category: &str
) -> std::io::Result<usize> {
    use byteorder::{ReadBytesExt, LittleEndian};
    use std::io::Cursor;

    let data = std::fs::read(path)?;
    let mut cursor = Cursor::new(&data);

    // Read and validate magic
    let mut magic = [0u8; 4];
    std::io::Read::read_exact(&mut cursor, &mut magic)?;
    if &magic != b"HHSH" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Invalid magic bytes: expected HHSH, got {:?}", magic)
        ));
    }

    // Read version
    let version = cursor.read_i32::<LittleEndian>()?;
    if version != 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Unsupported version: {}", version)
        ));
    }

    // Read counts
    let fnv1a_count = cursor.read_i32::<LittleEndian>()? as usize;
    let xxh64_count = cursor.read_i32::<LittleEndian>()? as usize;

    let mut offset = cursor.position() as usize;
    let mut loaded = 0;

    // Read FNV1a entries (32-bit hashes)
    for _ in 0..fnv1a_count {
        if offset + 4 > data.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Unexpected end while reading FNV1a hash"
            ));
        }

        let hash = u32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
        offset += 4;

        let str_len = read_7bit_encoded_int(&data, &mut offset)?;

        if offset + str_len > data.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Unexpected end while reading string"
            ));
        }

        let value = String::from_utf8_lossy(&data[offset..offset + str_len]).to_string();
        offset += str_len;

        // Insert into appropriate category
        match category {
            "entries" => { hashes.insert_entry(hash, value); },
            "fields" => { hashes.insert_field(hash, value); },
            "hashes" => { hashes.insert_hash(hash, value); },
            "types" => { hashes.insert_type(hash, value); },
            _ => eprintln!("[ltk_bridge] Unknown category: {}", category),
        }
        loaded += 1;
    }

    // Read XXH64 entries (64-bit hashes)
    for _ in 0..xxh64_count {
        if offset + 8 > data.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Unexpected end while reading XXH64 hash"
            ));
        }

        let hash_bytes: [u8; 8] = data[offset..offset+8].try_into().unwrap();
        let hash64 = u64::from_le_bytes(hash_bytes);
        offset += 8;

        let str_len = read_7bit_encoded_int(&data, &mut offset)?;

        if offset + str_len > data.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Unexpected end while reading string"
            ));
        }

        let value = String::from_utf8_lossy(&data[offset..offset + str_len]).to_string();
        offset += str_len;

        // XXH64 hashes are also 64-bit, but we need to convert to u32 for the category system
        // Split into two u32 values or use lower 32 bits
        let hash32 = (hash64 & 0xFFFFFFFF) as u32;
        match category {
            "entries" => { hashes.insert_entry(hash32, value); },
            "fields" => { hashes.insert_field(hash32, value); },
            "hashes" => { hashes.insert_hash(hash32, value); },
            "types" => { hashes.insert_type(hash32, value); },
            _ => eprintln!("[ltk_bridge] Unknown category: {}", category),
        }
        loaded += 1;
    }

    Ok(loaded)
}
