use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::core::bin::{read_bin_ltk, tree_to_text_cached, text_to_tree, write_bin_ltk, BinTree};
use crate::core::bin::jade;
use std::fs;

/// Check if the Jade Custom converter engine is selected.
fn use_jade_engine() -> bool {
    let pref_file = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("LeagueToolkit").join("Jade").join("preferences.json")
    } else {
        return false;
    };

    if let Ok(content) = fs::read_to_string(&pref_file) {
        if let Ok(prefs) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(engine) = prefs.get("ConverterEngine").and_then(|v| v.as_str()) {
                return engine == "jade";
            }
        }
    }
    true // default to Jade Custom
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BinInfo {
    pub success: bool,
    pub message: String,
    pub data: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchConvertResult {
    pub path: String,
    pub success: bool,
    pub content: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn convert_bin_to_text(input_path: String) -> Result<BinInfo, String> {
    let data = std::fs::read(&input_path)
        .map_err(|e| format!("Failed to read input file: {}", e))?;

    let text = if use_jade_engine() {
        jade::convert_bin_to_text(&data)?
    } else {
        convert_bin_data_to_text(&data)?
    };

    Ok(BinInfo {
        success: true,
        message: format!("Converted: {}", input_path),
        data: Some(text),
    })
}

#[tauri::command]
pub async fn convert_text_to_bin(text_content: String, output_path: String) -> Result<BinInfo, String> {
    let preview: String = text_content.chars().take(200).collect();
    println!("[convert_text_to_bin] Parsing {} bytes, preview:\n{}", text_content.len(), preview);

    let bin_data = if use_jade_engine() {
        println!("[convert_text_to_bin] Using Jade Custom engine");
        jade::convert_text_to_bin(&text_content)?
    } else {
        println!("[convert_text_to_bin] Using LTK engine");
        let tree = text_to_tree(&text_content)
            .map_err(|e| format!("Failed to parse ritobin text: {}", e))?;
        println!("[convert_text_to_bin] Parsed successfully: {} objects", tree.objects.len());
        write_bin_ltk(&tree)
            .map_err(|e| format!("Failed to write binary: {}", e))?
    };

    std::fs::write(&output_path, &bin_data)
        .map_err(|e| format!("Failed to write output file: {}", e))?;

    Ok(BinInfo {
        success: true,
        message: format!("Saved: {}", output_path),
        data: None,
    })
}

/// Batch convert multiple bin files to text.
/// Uses cached hash provider for fast conversion.
#[tauri::command]
pub async fn batch_convert_bins(input_paths: Vec<String>) -> Result<Vec<BatchConvertResult>, String> {
    if input_paths.is_empty() {
        return Ok(vec![]);
    }
    
    let start = std::time::Instant::now();
    let use_jade = use_jade_engine();
    println!("[BatchConvert] Converting {} files (engine: {})", input_paths.len(), if use_jade { "Jade Custom" } else { "LTK" });

    let mut results = Vec::with_capacity(input_paths.len());

    for path in input_paths {
        let result = convert_single_bin(&path, use_jade);
        results.push(result);
    }
    
    println!("[BatchConvert] Completed {} files in {:?}", results.len(), start.elapsed());
    
    Ok(results)
}

/// Convert a single bin file
fn convert_single_bin(input_path: &str, use_jade: bool) -> BatchConvertResult {
    let data = match std::fs::read(input_path) {
        Ok(d) => d,
        Err(e) => return BatchConvertResult {
            path: input_path.to_string(),
            success: false,
            content: None,
            error: Some(format!("Failed to read file: {}", e)),
        },
    };

    let result = if use_jade {
        jade::convert_bin_to_text(&data)
    } else {
        convert_bin_data_to_text(&data)
    };

    match result {
        Ok(text) => BatchConvertResult {
            path: input_path.to_string(),
            success: true,
            content: Some(text),
            error: None,
        },
        Err(e) => BatchConvertResult {
            path: input_path.to_string(),
            success: false,
            content: None,
            error: Some(e),
        },
    }
}

/// Convert bin data to text using ltk_meta/ltk_ritobin with cached hashes
fn convert_bin_data_to_text(bin_data: &[u8]) -> Result<String, String> {
    // Check if the data is UTF-8 text
    if let Ok(text) = std::str::from_utf8(bin_data) {
        let trimmed = text.trim_start();
        
        // Already in ritobin text format
        if trimmed.starts_with("#PROP") || trimmed.starts_with("#PTCH") {
            return Ok(text.to_string());
        }
        
        // JSON format (Bin serialized)
        if trimmed.starts_with('{') {
            let tree: BinTree = serde_json::from_str(text)
                .map_err(|e| format!("Failed to parse JSON: {}", e))?;
            return tree_to_text_cached(&tree)
                .map_err(|e| format!("Failed to convert to text: {}", e));
        }
        
        // Check for ritobin text format without header
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            if line.contains(':') && line.contains('=') {
                let tree = text_to_tree(text)
                    .map_err(|e| format!("Failed to parse text: {}", e))?;
                return tree_to_text_cached(&tree)
                    .map_err(|e| format!("Failed to convert to text: {}", e));
            }
            break;
        }
    }
    
    // Binary format - use ltk_bridge
    let tree = read_bin_ltk(bin_data)
        .map_err(|e| format!("Failed to parse BIN: {}", e))?;
    
    tree_to_text_cached(&tree)
        .map_err(|e| format!("Failed to convert to text: {}", e))
}

/// Searches for a bin file by name in the DATA folder hierarchy.
/// Starts from the given base directory and searches recursively.
#[tauri::command]
pub async fn find_linked_bin_file(base_directory: String, file_name: String) -> Result<Option<String>, String> {
    let base_path = Path::new(&base_directory);
    
    // Look for DATA folder in the path hierarchy
    let data_folder = find_data_folder(base_path);
    
    let search_root = data_folder.unwrap_or_else(|| base_path.to_path_buf());
    
    // Search for the file recursively
    match search_file_recursively(&search_root, &file_name, 0, 5) {
        Some(path) => Ok(Some(path.to_string_lossy().to_string())),
        None => Ok(None),
    }
}

/// Walks up the directory tree to find a DATA folder
fn find_data_folder(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start.to_path_buf());
    
    for _ in 0..10 {
        if let Some(ref dir) = current {
            // Check if there's a DATA subdirectory
            let potential_data = dir.join("DATA");
            if potential_data.exists() && potential_data.is_dir() {
                return Some(potential_data);
            }
            
            // Check if current folder IS the DATA folder
            if let Some(name) = dir.file_name() {
                if name.to_string_lossy().eq_ignore_ascii_case("DATA") {
                    return Some(dir.clone());
                }
            }
            
            // Check for lowercase 'data' as well
            let potential_data_lower = dir.join("data");
            if potential_data_lower.exists() && potential_data_lower.is_dir() {
                return Some(potential_data_lower);
            }
            
            current = dir.parent().map(|p| p.to_path_buf());
        } else {
            break;
        }
    }
    
    None
}

/// Recursively searches for a file by name
fn search_file_recursively(directory: &Path, file_name: &str, current_depth: u32, max_depth: u32) -> Option<PathBuf> {
    if current_depth > max_depth {
        return None;
    }
    
    // Check for file in current directory
    let file_path = directory.join(file_name);
    if file_path.exists() && file_path.is_file() {
        return Some(file_path);
    }
    
    // Search subdirectories
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = search_file_recursively(&path, file_name, current_depth + 1, max_depth) {
                    return Some(found);
                }
            }
        }
    }
    
    None
}
