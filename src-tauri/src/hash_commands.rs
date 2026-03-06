use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use byteorder::{WriteBytesExt, LittleEndian};
use std::io::Write;
use tauri::Emitter;
use crate::core::hash::get_frogtools_hash_dir;
use crate::core::bin::{get_cached_bin_hashes, are_hashes_loaded, estimate_ltk_hash_memory, reload_cached_bin_hashes};
use crate::core::bin::jade::hash_manager as jade_hashes;

/// Check which converter engine is active (true = jade, false = ltk).
fn is_jade_engine() -> bool {
    let pref_file = if let Ok(appdata) = std::env::var("APPDATA") {
        std::path::PathBuf::from(appdata).join("LeagueToolkit").join("Jade").join("preferences.json")
    } else {
        return true;
    };
    if let Ok(content) = std::fs::read_to_string(&pref_file) {
        if let Ok(prefs) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(engine) = prefs.get("ConverterEngine").and_then(|v| v.as_str()) {
                return engine == "jade";
            }
        }
    }
    true // default to Jade Custom
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HashStatus {
    pub all_present: bool,
    pub missing: Vec<String>,
    pub format: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreloadStatus {
    pub loaded: bool,
    pub loading: bool,
    pub fnv_count: usize,
    pub xxh_count: usize,
    pub memory_bytes: usize,
}

const HASH_FILES: &[&str] = &[
    "hashes.binentries.txt",
    "hashes.binfields.txt",
    "hashes.binhashes.txt",
    "hashes.bintypes.txt",
    "hashes.lcu.txt",
];

const BASE_URL: &str = "https://raw.githubusercontent.com/CommunityDragon/Data/master/hashes/lol/";
const META_FILE_NAME: &str = "hashes-meta.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct HashFileMeta {
    url: String,
    etag: String,
    #[serde(rename = "lastModified")]
    last_modified: String,
    #[serde(rename = "lastCheckedAt")]
    last_checked_at: String,
    #[serde(rename = "localMtimeMs")]
    local_mtime_ms: u64,
    #[serde(rename = "localSize")]
    local_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct HashMetaFile {
    #[serde(rename = "updatedAt")]
    updated_at: String,
    files: HashMap<String, HashFileMeta>,
}

#[derive(Debug, Clone, Default)]
struct LocalFileState {
    mtime_ms: u64,
    size: u64,
}

#[derive(Debug, Clone, Default)]
struct RemoteProbe {
    not_modified: bool,
    etag: String,
    last_modified: String,
}

#[derive(Debug, Clone, Serialize)]
struct HashSyncProgressEvent {
    phase: String,
    current: usize,
    total: usize,
    downloaded: usize,
    skipped: usize,
    file: String,
    message: String,
}

fn emit_hash_progress(
    app: &tauri::AppHandle,
    phase: &str,
    current: usize,
    total: usize,
    downloaded: usize,
    skipped: usize,
    file: &str,
    message: &str,
) {
    let payload = HashSyncProgressEvent {
        phase: phase.to_string(),
        current,
        total,
        downloaded,
        skipped,
        file: file.to_string(),
        message: message.to_string(),
    };
    let _ = app.emit("hash-sync-progress", payload);
}

fn get_hash_dir() -> Result<PathBuf, String> {
    // Shared Quartz/Jade hash directory
    get_frogtools_hash_dir().map_err(|e| e.to_string())
}

fn read_hashes_meta(hash_dir: &PathBuf) -> HashMetaFile {
    let meta_path = hash_dir.join(META_FILE_NAME);
    if !meta_path.exists() {
        return HashMetaFile::default();
    }
    match fs::read_to_string(&meta_path) {
        Ok(content) => serde_json::from_str::<HashMetaFile>(&content).unwrap_or_default(),
        Err(_) => HashMetaFile::default(),
    }
}

fn write_hashes_meta(hash_dir: &PathBuf, mut meta: HashMetaFile) -> Result<(), String> {
    meta.updated_at = chrono::Utc::now().to_rfc3339();
    let meta_path = hash_dir.join(META_FILE_NAME);
    let payload = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("Failed to serialize {}: {}", META_FILE_NAME, e))?;
    fs::write(meta_path, payload)
        .map_err(|e| format!("Failed to write {}: {}", META_FILE_NAME, e))
}

fn local_file_state(path: &PathBuf) -> Option<LocalFileState> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let unix = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(LocalFileState {
        mtime_ms: unix.as_millis() as u64,
        size: meta.len(),
    })
}

async fn probe_remote_file(url: &str, previous: Option<&HashFileMeta>) -> RemoteProbe {
    let client = reqwest::Client::new();
    let mut req = client.head(url).header(reqwest::header::USER_AGENT, "Jade-HashManager/1.0");

    if let Some(prev) = previous {
        if !prev.etag.is_empty() {
            req = req.header(reqwest::header::IF_NONE_MATCH, prev.etag.clone());
        }
        if !prev.last_modified.is_empty() {
            req = req.header(reqwest::header::IF_MODIFIED_SINCE, prev.last_modified.clone());
        }
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(_) => return RemoteProbe::default(),
    };

    let status = response.status();
    if !(status.is_success() || status.as_u16() == 304) {
        return RemoteProbe::default();
    }

    RemoteProbe {
        not_modified: status.as_u16() == 304,
        etag: response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string(),
        last_modified: response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string(),
    }
}

fn parse_http_time_millis(value: &str) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    let dt = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let utc = dt.with_timezone(&chrono::Utc);
    Some(utc.timestamp_millis().max(0) as u64)
}

#[tauri::command]
pub async fn check_hashes() -> Result<HashStatus, String> {
    let hash_dir = get_hash_dir()?;
    
    let mut missing = Vec::new();
    let mut txt_count = 0;
    let mut bin_count = 0;

    for filename in HASH_FILES {
        let txt_path = hash_dir.join(filename);
        let bin_path = hash_dir.join(filename.replace(".txt", ".bin"));
        
        if bin_path.exists() {
            bin_count += 1;
        } else if txt_path.exists() {
            txt_count += 1;
        } else {
            missing.push(filename.to_string());
        }
    }

    let format = if bin_count > 0 && txt_count == 0 {
        "Binary"
    } else if txt_count > 0 && bin_count == 0 {
        "Text"
    } else if bin_count > 0 && txt_count > 0 {
        "Mixed"
    } else {
        "None"
    };

    Ok(HashStatus {
        all_present: missing.is_empty(),
        missing,
        format: format.to_string(),
    })
}

#[tauri::command]
pub async fn download_hashes(app: tauri::AppHandle, use_binary: bool) -> Result<Vec<String>, String> {
    let hash_dir = get_hash_dir()?;
    fs::create_dir_all(&hash_dir)
        .map_err(|e| format!("Failed to create hash dir {}: {}", hash_dir.display(), e))?;

    let mut metadata = read_hashes_meta(&hash_dir);
    let mut downloaded = Vec::new();
    let mut skipped_count = 0usize;
    let total = HASH_FILES.len();

    emit_hash_progress(
        &app,
        "checking",
        0,
        total,
        0,
        0,
        "",
        "Checking hash updates...",
    );
    
    for (idx, filename) in HASH_FILES.iter().enumerate() {
        let url = format!("{}{}", BASE_URL, filename);
        let txt_path = hash_dir.join(filename);

        let previous = metadata.files.get(*filename).cloned();
        let local = local_file_state(&txt_path);
        let remote = probe_remote_file(&url, previous.as_ref()).await;

        let mut up_to_date = false;
        if let Some(local_state) = &local {
            if remote.not_modified {
                up_to_date = true;
            } else if let Some(remote_mtime) = parse_http_time_millis(&remote.last_modified) {
                if local_state.mtime_ms >= remote_mtime {
                    up_to_date = true;
                }
            }
        }

        if up_to_date && txt_path.exists() {
            let p = previous.unwrap_or_default();
            skipped_count += 1;
            metadata.files.insert(
                filename.to_string(),
                HashFileMeta {
                    url: url.clone(),
                    etag: if !remote.etag.is_empty() { remote.etag } else { p.etag },
                    last_modified: if !remote.last_modified.is_empty() { remote.last_modified } else { p.last_modified },
                    last_checked_at: chrono::Utc::now().to_rfc3339(),
                    local_mtime_ms: local.as_ref().map(|s| s.mtime_ms).unwrap_or(0),
                    local_size: local.as_ref().map(|s| s.size).unwrap_or(0),
                },
            );
            emit_hash_progress(
                &app,
                "downloading",
                idx + 1,
                total,
                downloaded.len(),
                skipped_count,
                filename,
                &format!(
                    "Up to date: {} ({}/{})",
                    filename,
                    downloaded.len() + skipped_count,
                    total
                ),
            );
            continue;
        }

        emit_hash_progress(
            &app,
            "downloading",
            idx + 1,
            total,
            downloaded.len(),
            skipped_count,
            filename,
            &format!(
                "Downloading {} ({}/{})",
                filename,
                downloaded.len() + skipped_count + 1,
                total
            ),
        );

        let response = reqwest::get(&url).await
            .map_err(|e| {
                emit_hash_progress(
                    &app,
                    "error",
                    idx + 1,
                    total,
                    downloaded.len(),
                    skipped_count,
                    filename,
                    &format!("Failed to request {}: {}", filename, e),
                );
                format!("Failed to request {}: {}", filename, e)
            })?;
        if !response.status().is_success() {
            emit_hash_progress(
                &app,
                "error",
                idx + 1,
                total,
                downloaded.len(),
                skipped_count,
                filename,
                &format!("Failed to request {}: HTTP {}", filename, response.status()),
            );
            return Err(format!("Failed to request {}: HTTP {}", filename, response.status()));
        }

        let headers = response.headers().clone();
        let bytes = response.bytes().await
             .map_err(|e| format!("Failed to get bytes {}: {}", filename, e))?;

        fs::write(&txt_path, bytes)
             .map_err(|e| format!("Failed to write {}: {}", filename, e))?;

        let after = local_file_state(&txt_path).unwrap_or_default();
        downloaded.push(filename.to_string());
        let old = previous.unwrap_or_default();
        metadata.files.insert(
            filename.to_string(),
            HashFileMeta {
                url: url.clone(),
                etag: headers
                    .get(reqwest::header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(&old.etag)
                    .to_string(),
                last_modified: headers
                    .get(reqwest::header::LAST_MODIFIED)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(&old.last_modified)
                    .to_string(),
                last_checked_at: chrono::Utc::now().to_rfc3339(),
                local_mtime_ms: after.mtime_ms,
                local_size: after.size,
            },
        );
    }
    
    if use_binary {
        for filename in HASH_FILES {
             let txt_path = hash_dir.join(filename);
             let bin_path = hash_dir.join(filename.replace(".txt", ".bin"));
             
             if txt_path.exists() {
                 convert_text_to_binary(&txt_path, &bin_path).map_err(|e| e.to_string())?;
                 // C# behavior: Delete text file if binary conversion succeeds
                 let _ = fs::remove_file(txt_path);
             }
        }
    }

    write_hashes_meta(&hash_dir, metadata)?;

    // Refresh both caches so changed hashes apply immediately without app restart.
    let jade_count = jade_hashes::reload_cached_hashes();
    let ltk_count = reload_cached_bin_hashes();
    println!(
        "[HashCommands] Hash cache reload complete (jade={}, ltk={})",
        jade_count, ltk_count
    );

    emit_hash_progress(
        &app,
        "success",
        total,
        total,
        downloaded.len(),
        skipped_count,
        "",
        &format!(
            "Hashes ready (downloaded {}, skipped {})",
            downloaded.len(),
            skipped_count
        ),
    );
    
    Ok(downloaded)
}

#[tauri::command]
pub async fn open_hashes_folder() -> Result<(), String> {
    let hash_dir = get_hash_dir()?;
    opener::open(hash_dir)
        .map_err(|e| format!("Failed to open folder: {}", e))
}

fn convert_text_to_binary(txt_path: &PathBuf, bin_path: &PathBuf) -> std::io::Result<()> {
    let content = fs::read_to_string(txt_path)?;
    let mut fnv1a = Vec::new();
    let mut xxh64 = Vec::new();
    
    for line in content.lines() {
         if line.trim().is_empty() { continue; }
         if let Some((hash_part, value_part)) = line.split_once(' ') {
             let hash_hex = hash_part;
             if hash_hex.len() == 16 {
                 if let Ok(h) = u64::from_str_radix(hash_hex, 16) {
                     xxh64.push((h, value_part.to_string()));
                 }
             } else if hash_hex.len() == 8 {
                 if let Ok(h) = u32::from_str_radix(hash_hex, 16) {
                     fnv1a.push((h, value_part.to_string()));
                 }
             }
         }
    }
    
    let mut file = fs::File::create(bin_path)?;
    file.write_all(b"HHSH")?;
    file.write_i32::<LittleEndian>(1)?; // version
    file.write_i32::<LittleEndian>(fnv1a.len() as i32)?;
    file.write_i32::<LittleEndian>(xxh64.len() as i32)?;
    
    for (hash, val) in fnv1a {
        file.write_u32::<LittleEndian>(hash)?;
        write_string(&mut file, &val)?;
    }
    
    for (hash, val) in xxh64 {
        file.write_u64::<LittleEndian>(hash)?;
        write_string(&mut file, &val)?;
    }
    
    Ok(())
}

fn write_string(writer: &mut impl Write, value: &str) -> std::io::Result<()> {
    let bytes = value.as_bytes();
    let mut val = bytes.len() as u32;
    
    // Write 7-bit encoded int
    loop {
        let mut byte = (val & 0x7F) as u8;
        val >>= 7;
        if val != 0 {
            byte |= 0x80;
        }
        writer.write_u8(byte)?;
        if val == 0 { break; }
    }
    
    writer.write_all(bytes)?;
    Ok(())
}

/// Preload hashes into RAM for instant bin file conversion.
/// Only loads the active engine's cache to avoid double memory usage.
#[tauri::command]
pub async fn preload_hashes() -> Result<PreloadStatus, String> {
    if is_jade_engine() {
        let jade_lock = jade_hashes::get_cached_hashes();
        let jade = jade_lock.read();
        Ok(PreloadStatus {
            loaded: true,
            loading: false,
            fnv_count: jade.total_count(),
            xxh_count: 0,
            memory_bytes: jade.memory_bytes(),
        })
    } else {
        let count = {
            let hashes = get_cached_bin_hashes().read();
            hashes.total_count()
        };
        Ok(PreloadStatus {
            loaded: true,
            loading: false,
            fnv_count: count,
            xxh_count: 0,
            memory_bytes: estimate_ltk_hash_memory(),
        })
    }
}

/// Check if hashes are preloaded — does NOT trigger loading.
/// Only reports the active engine's cache to avoid confusion.
#[tauri::command]
pub async fn get_preload_status() -> PreloadStatus {
    if is_jade_engine() {
        if !jade_hashes::are_jade_hashes_loaded() {
            return PreloadStatus { loaded: false, loading: false, fnv_count: 0, xxh_count: 0, memory_bytes: 0 };
        }
        let jade_lock = jade_hashes::get_cached_hashes();
        let jade = jade_lock.read();
        PreloadStatus {
            loaded: true,
            loading: false,
            fnv_count: jade.total_count(),
            xxh_count: 0,
            memory_bytes: jade.memory_bytes(),
        }
    } else {
        if !are_hashes_loaded() {
            return PreloadStatus { loaded: false, loading: false, fnv_count: 0, xxh_count: 0, memory_bytes: 0 };
        }
        let count = {
            let hashes = get_cached_bin_hashes().read();
            hashes.total_count()
        };
        PreloadStatus {
            loaded: true,
            loading: false,
            fnv_count: count,
            xxh_count: 0,
            memory_bytes: estimate_ltk_hash_memory(),
        }
    }
}

/// Unload preloaded hashes from memory
/// Note: With OnceLock cache, hashes can't be truly unloaded without restart
#[tauri::command]
pub async fn unload_hashes() -> Result<(), String> {
    // OnceLock doesn't support unloading - just return success
    println!("[HashCommands] Note: Hashes are cached globally and cannot be unloaded without restart");
    Ok(())
}

/// Convert existing text hash files to binary format
#[tauri::command]
pub async fn convert_hashes_to_binary() -> Result<Vec<String>, String> {
    let hash_dir = get_hash_dir()?;
    let mut converted = Vec::new();
    
    for filename in HASH_FILES {
        let txt_path = hash_dir.join(filename);
        let bin_path = hash_dir.join(filename.replace(".txt", ".bin"));
        
        // Only convert if text file exists and binary doesn't
        if txt_path.exists() && !bin_path.exists() {
            convert_text_to_binary(&txt_path, &bin_path)
                .map_err(|e| format!("Failed to convert {}: {}", filename, e))?;
            
            // Delete text file after successful conversion
            fs::remove_file(&txt_path)
                .map_err(|e| format!("Failed to delete text file {}: {}", filename, e))?;
            
            converted.push(filename.to_string());
        }
    }
    
    Ok(converted)
}
