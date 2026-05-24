use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use crate::core::hash::get_frogtools_text_hash_dir;
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
    // Jade-isolated text-hash directory (`<frogtools-root>/text/`).
    // Lives one level deeper than the shared FrogTools hashes folder
    // so our `hashes.*.txt` downloads don't clobber the same-named
    // files Quartz writes into the root. See
    // `core/hash/mod.rs::get_frogtools_text_hash_dir` for the
    // one-time migration that moves any pre-split downloads over.
    // Shared Quartz/Jade hash directory
    get_frogtools_text_hash_dir().map_err(|e| e.to_string())
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

async fn probe_remote_file(client: &reqwest::Client, url: &str, previous: Option<&HashFileMeta>) -> RemoteProbe {
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

    // The combined LMDB layout is the primary source today; legacy text
    // files only matter as a fallback for users without LMDB. Report
    // "LMDB" when the layout is present, otherwise list any missing
    // text files so the UI can prompt for a download.
    let lmdb_present = !matches!(
        crate::core::wad::detect_layout(&hash_dir),
        crate::core::wad::HashLayout::Missing,
    );

    if lmdb_present {
        return Ok(HashStatus {
            all_present: true,
            missing: Vec::new(),
            format: "LMDB".to_string(),
        });
    }

    let mut missing = Vec::new();
    let mut txt_count = 0;
    for filename in HASH_FILES {
        let txt_path = hash_dir.join(filename);
        if txt_path.exists() {
            txt_count += 1;
        } else {
            missing.push(filename.to_string());
        }
    }

    let format = if txt_count > 0 { "Text" } else { "None" };

    Ok(HashStatus {
        all_present: missing.is_empty(),
        missing,
        format: format.to_string(),
    })
}

#[tauri::command]
pub async fn download_hashes(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<Vec<String>, String> {
    let force = force.unwrap_or(false);
    let hash_dir = get_hash_dir()?;
    fs::create_dir_all(&hash_dir)
        .map_err(|e| format!("Failed to create hash dir {}: {}", hash_dir.display(), e))?;

    let mut metadata = read_hashes_meta(&hash_dir);
    let mut downloaded = Vec::new();
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

    let client = reqwest::Client::new();

    // Probe all remote files in parallel — 5 sequential HEADs were the slow path.
    let probes: Vec<(String, Option<HashFileMeta>, Option<LocalFileState>, RemoteProbe)> = {
        let futs = HASH_FILES.iter().map(|filename| {
            let url = format!("{}{}", BASE_URL, filename);
            let txt_path = hash_dir.join(filename);
            let previous = metadata.files.get(*filename).cloned();
            let local = local_file_state(&txt_path);
            let client_ref = &client;
            let prev_ref = previous.clone();
            async move {
                let remote = probe_remote_file(client_ref, &url, prev_ref.as_ref()).await;
                ((*filename).to_string(), previous, local, remote)
            }
        });
        futures::future::join_all(futs).await
    };

    // Decide which files need a real GET. The fast skip path: if the remote's
    // Last-Modified or ETag matches what we last saw and the file is on disk,
    // there is nothing to do — no bytes to fetch, no metadata churn.
    let mut to_download: Vec<(String, HashFileMeta, Option<LocalFileState>, RemoteProbe)> = Vec::new();
    let mut skipped_count = 0usize;

    for (filename, previous, local, remote) in probes {
        let txt_path = hash_dir.join(&filename);
        let prev = previous.clone().unwrap_or_default();
        let url = format!("{}{}", BASE_URL, &filename);

        let same_etag = !remote.etag.is_empty() && remote.etag == prev.etag;
        let same_last_modified = !remote.last_modified.is_empty() && remote.last_modified == prev.last_modified;
        let local_newer_or_equal = match (local.as_ref(), parse_http_time_millis(&remote.last_modified)) {
            (Some(state), Some(remote_mtime)) => state.mtime_ms >= remote_mtime,
            _ => false,
        };

        // `force = true` (manual "Download text hashes" button) skips
        // the smart-skip and re-fetches every file regardless of
        // ETag / Last-Modified. The schedule path leaves it false
        // so up-to-date files are no-ops with just one HEAD probe.
        let up_to_date = !force
            && txt_path.exists()
            && (remote.not_modified || same_etag || same_last_modified || local_newer_or_equal);

        if up_to_date {
            skipped_count += 1;
            metadata.files.insert(
                filename.clone(),
                HashFileMeta {
                    url: url.clone(),
                    etag: if !remote.etag.is_empty() { remote.etag.clone() } else { prev.etag.clone() },
                    last_modified: if !remote.last_modified.is_empty() { remote.last_modified.clone() } else { prev.last_modified.clone() },
                    last_checked_at: chrono::Utc::now().to_rfc3339(),
                    local_mtime_ms: local.as_ref().map(|s| s.mtime_ms).unwrap_or(prev.local_mtime_ms),
                    local_size: local.as_ref().map(|s| s.size).unwrap_or(prev.local_size),
                },
            );
            emit_hash_progress(
                &app,
                "downloading",
                skipped_count,
                total,
                0,
                skipped_count,
                &filename,
                &format!("Up to date: {}", filename),
            );
            continue;
        }

        to_download.push((filename, prev, local, remote));
    }

    // Sequentially fetch only the files that actually changed.
    for (idx, (filename, prev, _local, _remote)) in to_download.iter().enumerate() {
        let url = format!("{}{}", BASE_URL, filename);
        let txt_path = hash_dir.join(filename);

        emit_hash_progress(
            &app,
            "downloading",
            skipped_count + idx + 1,
            total,
            downloaded.len(),
            skipped_count,
            filename,
            &format!("Downloading {}", filename),
        );

        let response = client.get(&url).send().await
            .map_err(|e| {
                emit_hash_progress(
                    &app,
                    "error",
                    skipped_count + idx + 1,
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
                skipped_count + idx + 1,
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
        downloaded.push(filename.clone());
        metadata.files.insert(
            filename.clone(),
            HashFileMeta {
                url: url.clone(),
                etag: headers
                    .get(reqwest::header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(&prev.etag)
                    .to_string(),
                last_modified: headers
                    .get(reqwest::header::LAST_MODIFIED)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(&prev.last_modified)
                    .to_string(),
                last_checked_at: chrono::Utc::now().to_rfc3339(),
                local_mtime_ms: after.mtime_ms,
                local_size: after.size,
            },
        );
    }

    write_hashes_meta(&hash_dir, metadata)?;

    // Only reload caches if something actually changed. The reload takes
    // a brief write lock on the global hash maps and would otherwise stall
    // an in-progress file open even when there's no new data to apply.
    if !downloaded.is_empty() {
        let jade_count = jade_hashes::reload_cached_hashes();
        let ltk_count = reload_cached_bin_hashes();
        println!(
            "[HashCommands] Hash cache reload complete (jade={}, ltk={})",
            jade_count, ltk_count
        );
    }

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

/// Touch the active engine's cached hash manager so it's loaded.
///
/// In LMDB mode this is a near-noop (lookups are cheap enough that we
/// don't pre-drain the LMDB into RAM). In text-fallback mode it forces
/// the legacy in-memory parser to run, which keeps the first BIN open
/// from blocking on a multi-second text load.
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

