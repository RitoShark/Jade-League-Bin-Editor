// Material Library commands.
//
// Handles fetching the jade-library index and individual materials from GitHub,
// caching them locally under %APPDATA%\LeagueToolkit\Jade\library\, and exposing
// management commands (list/update/delete) to the frontend.
//
// Cache layout mirrors the repo structure:
//   library/
//     meta.json                  ETags, timestamps, update mode settings
//     index.json                 cached catalog
//     materials/
//       <id>/
//         snippet.json
//         preview.png (or .jpg/.webp)
//         textures/

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

const REPO_BASE_URL: &str = "https://raw.githubusercontent.com/RitoShark/Jade-Library/master/";

/// Temporary local-development override. When `Some(path)`, the fetch helpers
/// treat URLs as relative paths under this folder and read straight from disk
/// instead of hitting GitHub. Set to `None` once jade-library is published.
const LOCAL_DEV_PATH: Option<&str> = None;

const INDEX_FILE: &str = "index.json";
const META_FILE: &str = "meta.json";
const USER_AGENT: &str = "Jade-Library/1.0";

// ─────────────────────────────────────────────────────────────────────────────
// Types mirroring the repo schema (see SCHEMA.md in jade-library)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryCategory {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryIndexEntry {
    /// Last-segment id (folder name) — used for display.
    pub id: String,
    /// Repo-relative path under materials/ — the canonical identifier the
    /// fetch/cache/delete commands operate on. Example:
    /// "ahri/skin77/ahri-tails-panner-fresnel-inst" or "general/toon-shading".
    #[serde(default)]
    pub path: String,
    pub name: String,
    pub category: String,
    /// First path segment (lowercase) when the material belongs to a champion.
    /// `None`/empty for curated "general/" entries.
    #[serde(default)]
    pub champion: Option<String>,
    /// `skin<N>` segment if this material came from a skin-specific bin.
    #[serde(default)]
    pub skin: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, rename = "hasPreview")]
    pub has_preview: bool,
    #[serde(default, rename = "userSlots")]
    pub user_slots: Vec<String>,
    #[serde(default)]
    pub featured: bool,
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: String,
    #[serde(default, rename = "materialName")]
    pub material_name: Option<String>,
}

fn default_version() -> u32 { 1 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryIndex {
    #[serde(default = "default_schema_version", rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(default, rename = "lastUpdated")]
    pub last_updated: String,
    #[serde(default)]
    pub categories: Vec<LibraryCategory>,
    #[serde(default)]
    pub champions: Vec<String>,
    #[serde(default)]
    pub materials: Vec<LibraryIndexEntry>,
}

fn default_schema_version() -> u32 { 1 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSlot {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextureFileInfo {
    pub name: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialSnippet {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "userSlots")]
    pub user_slots: Vec<UserSlot>,
    #[serde(rename = "materialName")]
    pub material_name: String,
    #[serde(default, rename = "textureFiles")]
    pub texture_files: Vec<TextureFileInfo>,
    /// Filename of the sibling ritobin text file. Defaults to "snippet.txt" when
    /// not present in the JSON. Stored as a raw path segment (no directories).
    #[serde(default = "default_snippet_file", rename = "snippetFile")]
    pub snippet_file: String,
    /// Loaded at runtime from the sibling text file; never serialized back.
    /// Empty when metadata is read standalone (e.g. for listings).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub snippet: String,
}

fn default_snippet_file() -> String {
    "snippet.txt".to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Local meta file: tracks ETags, timestamps, update mode
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IndexMeta {
    #[serde(default)]
    pub etag: String,
    #[serde(default, rename = "lastModified")]
    pub last_modified: String,
    #[serde(default, rename = "lastCheckedAt")]
    pub last_checked_at: String,
    #[serde(default, rename = "lastUpdatedRemote")]
    pub last_updated_remote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateModeSettings {
    /// "timed" | "smart" | "startup"
    pub mode: String,
    /// Interval in hours for "timed" mode (1, 6, 12, 24, 72, 168)
    pub interval_hours: u32,
}

impl Default for UpdateModeSettings {
    fn default() -> Self {
        Self {
            mode: "smart".to_string(),
            interval_hours: 24,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LibraryMeta {
    #[serde(default)]
    pub index: IndexMeta,
    #[serde(default)]
    pub update_mode: UpdateModeSettings,
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

fn get_library_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|e| format!("APPDATA not set: {}", e))?;
    let dir = PathBuf::from(appdata)
        .join("LeagueToolkit")
        .join("Jade")
        .join("library");
    Ok(dir)
}

fn get_materials_dir() -> Result<PathBuf, String> {
    Ok(get_library_dir()?.join("materials"))
}

/// Resolve a material path relative to the materials cache root.
///
/// `path` is a forward-slash-separated repo path like
/// `ahri/skin77/ahri-tails-inst` or `general/toon-shading`. We allow the `/`
/// separator but block any `..` traversal, backslashes, absolute roots, or
/// empty segments so a repo-provided value can never escape the materials dir.
fn get_material_dir(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("Material path is empty".to_string());
    }
    if path.contains('\\') || path.contains("..") {
        return Err(format!("Invalid material path: {}", path));
    }
    let root = get_materials_dir()?;
    let mut out = root.clone();
    for seg in path.split('/') {
        if seg.is_empty() {
            return Err(format!("Empty segment in material path: {}", path));
        }
        if seg == "." || seg == ".." {
            return Err(format!("Invalid segment {:?} in material path", seg));
        }
        out = out.join(seg);
    }
    // Defense in depth: canonicalize target and ensure it stays under root
    // (only when the directory already exists — otherwise the segment checks
    // above are the only guarantee).
    if let (Ok(ro), Ok(oc)) = (root.canonicalize(), out.canonicalize()) {
        if !oc.starts_with(&ro) {
            return Err(format!("Material path escapes root: {}", path));
        }
    }
    Ok(out)
}

fn ensure_library_dir() -> Result<PathBuf, String> {
    let dir = get_library_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create library dir {}: {}", dir.display(), e))?;
    Ok(dir)
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta file I/O
// ─────────────────────────────────────────────────────────────────────────────

fn read_meta() -> LibraryMeta {
    let meta_path = match get_library_dir() {
        Ok(dir) => dir.join(META_FILE),
        Err(_) => return LibraryMeta::default(),
    };
    if !meta_path.exists() {
        return LibraryMeta::default();
    }
    match fs::read_to_string(&meta_path) {
        Ok(content) => serde_json::from_str::<LibraryMeta>(&content).unwrap_or_default(),
        Err(_) => LibraryMeta::default(),
    }
}

fn write_meta(meta: &LibraryMeta) -> Result<(), String> {
    let dir = ensure_library_dir()?;
    let meta_path = dir.join(META_FILE);
    let payload = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("Failed to serialize library meta: {}", e))?;
    fs::write(&meta_path, payload)
        .map_err(|e| format!("Failed to write library meta: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress events
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct LibraryProgressEvent {
    phase: String,
    current: usize,
    total: usize,
    message: String,
    material_id: String,
}

fn emit_progress(
    app: &tauri::AppHandle,
    phase: &str,
    current: usize,
    total: usize,
    message: &str,
    material_id: &str,
) {
    let payload = LibraryProgressEvent {
        phase: phase.to_string(),
        current,
        total,
        message: message.to_string(),
        material_id: material_id.to_string(),
    };
    let _ = app.emit("library-progress", payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// If `LOCAL_DEV_PATH` is set, strip the `REPO_BASE_URL` prefix and resolve the
/// remainder against the local folder instead of going over the network.
fn url_to_local_path(url: &str) -> Option<PathBuf> {
    let base = LOCAL_DEV_PATH?;
    let relative = url.strip_prefix(REPO_BASE_URL).unwrap_or(url);
    Some(PathBuf::from(base).join(relative))
}

async fn fetch_text(url: &str) -> Result<String, String> {
    if let Some(local) = url_to_local_path(url) {
        return fs::read_to_string(&local)
            .map_err(|e| format!("Local read {}: {}", local.display(), e));
    }
    let client = build_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Fetch {} failed: {}", url, e))?;
    if !response.status().is_success() {
        return Err(format!("Fetch {} returned status {}", url, response.status()));
    }
    response
        .text()
        .await
        .map_err(|e| format!("Failed to read body from {}: {}", url, e))
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    if let Some(local) = url_to_local_path(url) {
        return fs::read(&local)
            .map_err(|e| format!("Local read {}: {}", local.display(), e));
    }
    let client = build_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Fetch {} failed: {}", url, e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Fetch {} returned status {}", url, status));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read bytes from {}: {}", url, e))?;
    Ok(bytes.to_vec())
}

/// Returns true if the remote index.json is newer than what we have cached.
/// Falls back to true (proceed with download) on any error so we don't silently skip updates.
async fn is_remote_index_newer(meta: &LibraryMeta) -> bool {
    let url = format!("{}{}", REPO_BASE_URL, INDEX_FILE);
    let text = match fetch_text(&url).await {
        Ok(t) => t,
        Err(_) => return true,
    };
    let parsed: Result<LibraryIndex, _> = serde_json::from_str(&text);
    match parsed {
        Ok(index) => {
            if meta.index.last_updated_remote.is_empty() {
                return true;
            }
            index.last_updated > meta.index.last_updated_remote
        }
        Err(_) => true,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands: index
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn library_fetch_index(app: tauri::AppHandle) -> Result<LibraryIndex, String> {
    let dir = ensure_library_dir()?;
    let index_path = dir.join(INDEX_FILE);

    emit_progress(&app, "fetch-index", 0, 1, "Fetching library index...", "");

    let url = format!("{}{}", REPO_BASE_URL, INDEX_FILE);
    let text = fetch_text(&url).await?;
    let parsed: LibraryIndex = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse index.json: {}", e))?;

    // Write cache
    fs::write(&index_path, &text)
        .map_err(|e| format!("Failed to write cached index: {}", e))?;

    // Update meta
    let mut meta = read_meta();
    meta.index.last_checked_at = chrono::Utc::now().to_rfc3339();
    meta.index.last_updated_remote = parsed.last_updated.clone();
    write_meta(&meta)?;

    emit_progress(&app, "fetch-index", 1, 1, "Index fetched", "");
    Ok(parsed)
}

#[tauri::command]
pub async fn library_get_cached_index() -> Result<Option<LibraryIndex>, String> {
    let dir = match get_library_dir() {
        Ok(d) => d,
        Err(_) => return Ok(None),
    };
    let index_path = dir.join(INDEX_FILE);
    if !index_path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&index_path)
        .map_err(|e| format!("Failed to read cached index: {}", e))?;
    let parsed: LibraryIndex = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse cached index: {}", e))?;
    Ok(Some(parsed))
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands: materials
// ─────────────────────────────────────────────────────────────────────────────

/// Sanitize a snippet filename provided by the repo.
/// Only simple filenames are allowed — no subdirectories, no traversal.
fn validate_snippet_filename(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("Invalid snippet filename: {}", name));
    }
    Ok(name)
}

#[tauri::command]
pub async fn library_fetch_material(
    app: tauri::AppHandle,
    path: String,
) -> Result<MaterialSnippet, String> {
    let material_dir = get_material_dir(&path)?;
    fs::create_dir_all(material_dir.join("textures"))
        .map_err(|e| format!("Failed to create material dir: {}", e))?;

    emit_progress(&app, "fetch-material", 0, 5, &format!("Fetching {}", path), &path);

    // 1. Fetch snippet.json
    let snippet_url = format!("{}materials/{}/snippet.json", REPO_BASE_URL, path);
    let snippet_text = fetch_text(&snippet_url).await?;
    let mut snippet: MaterialSnippet = serde_json::from_str(&snippet_text)
        .map_err(|e| format!("Failed to parse snippet.json: {}", e))?;

    fs::write(material_dir.join("snippet.json"), &snippet_text)
        .map_err(|e| format!("Failed to write snippet.json: {}", e))?;

    emit_progress(&app, "fetch-material", 1, 5, "Fetched metadata", &path);

    // 2. Fetch the sibling ritobin text file (snippet.txt by default)
    let snippet_filename = validate_snippet_filename(&snippet.snippet_file)?.to_string();
    let text_url = format!("{}materials/{}/{}", REPO_BASE_URL, path, snippet_filename);
    let ritobin_text = fetch_text(&text_url).await
        .map_err(|e| format!("Failed to fetch {}: {}", snippet_filename, e))?;
    fs::write(material_dir.join(&snippet_filename), &ritobin_text)
        .map_err(|e| format!("Failed to write {}: {}", snippet_filename, e))?;
    snippet.snippet = ritobin_text;

    emit_progress(&app, "fetch-material", 2, 5, "Fetched ritobin text", &path);

    // 3. Fetch shader textures
    let tex_total = snippet.texture_files.len();
    for (idx, tex) in snippet.texture_files.iter().enumerate() {
        if tex.name.contains('/') || tex.name.contains('\\') || tex.name.contains("..") {
            eprintln!("[library] Skipping invalid texture filename: {}", tex.name);
            continue;
        }
        let url = format!("{}materials/{}/textures/{}", REPO_BASE_URL, path, tex.name);
        match fetch_bytes(&url).await {
            Ok(bytes) => {
                let target = material_dir.join("textures").join(&tex.name);
                fs::write(&target, &bytes)
                    .map_err(|e| format!("Failed to write texture {}: {}", tex.name, e))?;
            }
            Err(e) => {
                eprintln!("[library] Failed to fetch texture {}: {}", tex.name, e);
            }
        }
        emit_progress(
            &app,
            "fetch-material",
            3,
            5,
            &format!("Fetched texture {}/{}", idx + 1, tex_total),
            &path,
        );
    }

    // 4. Try to fetch preview image (try common extensions)
    for ext in &["png", "jpg", "jpeg", "webp"] {
        let url = format!("{}materials/{}/preview.{}", REPO_BASE_URL, path, ext);
        if let Ok(bytes) = fetch_bytes(&url).await {
            let target = material_dir.join(format!("preview.{}", ext));
            let _ = fs::write(&target, &bytes);
            break;
        }
    }

    emit_progress(&app, "fetch-material", 5, 5, "Material ready", &path);
    Ok(snippet)
}

/// Read a cached material's full snippet (metadata + ritobin text) from disk.
/// Used by the insert flow and by the detail view in the browser.
#[tauri::command]
pub async fn library_get_cached_material(path: String) -> Result<Option<MaterialSnippet>, String> {
    let material_dir = get_material_dir(&path)?;
    let snippet_path = material_dir.join("snippet.json");
    if !snippet_path.exists() {
        return Ok(None);
    }
    let json = fs::read_to_string(&snippet_path)
        .map_err(|e| format!("Failed to read snippet.json for {}: {}", path, e))?;
    let mut snippet: MaterialSnippet = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse snippet.json for {}: {}", path, e))?;

    let snippet_filename = validate_snippet_filename(&snippet.snippet_file)?.to_string();
    let text_path = material_dir.join(&snippet_filename);
    if text_path.exists() {
        snippet.snippet = fs::read_to_string(&text_path)
            .map_err(|e| format!("Failed to read {}: {}", snippet_filename, e))?;
    }
    Ok(Some(snippet))
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadedMaterialInfo {
    pub id: String,
    /// Repo-relative path (e.g. "ahri/skin77/ahri-tails-inst").
    pub path: String,
    pub name: String,
    pub category: String,
    pub version: u32,
    pub size_bytes: u64,
    pub has_preview: bool,
    pub preview_path: Option<String>,
}

#[tauri::command]
pub async fn library_list_downloaded() -> Result<Vec<DownloadedMaterialInfo>, String> {
    let materials_dir = match get_materials_dir() {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()),
    };
    if !materials_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    walk_downloaded(&materials_dir, &materials_dir, &mut result);
    result.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(result)
}

/// Recurse the cache tree looking for directories that contain a snippet.json.
/// Any such directory is a material; its path relative to `root` becomes the
/// identifier.
fn walk_downloaded(
    root: &PathBuf,
    dir: &PathBuf,
    out: &mut Vec<DownloadedMaterialInfo>,
) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut subdirs = Vec::new();
    let mut has_snippet = false;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            subdirs.push(p);
        } else if p.file_name().and_then(|n| n.to_str()) == Some("snippet.json") {
            has_snippet = true;
        }
    }
    if has_snippet {
        let snippet_path = dir.join("snippet.json");
        if let Ok(text) = fs::read_to_string(&snippet_path) {
            if let Ok(snippet) = serde_json::from_str::<MaterialSnippet>(&text) {
                let rel = dir.strip_prefix(root).ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();

                let mut preview_path: Option<String> = None;
                for ext in &["png", "jpg", "jpeg", "webp"] {
                    let p = dir.join(format!("preview.{}", ext));
                    if p.exists() {
                        preview_path = Some(p.to_string_lossy().replace('\\', "/"));
                        break;
                    }
                }

                let size_bytes = dir_size(dir).unwrap_or(0);

                out.push(DownloadedMaterialInfo {
                    id: snippet.id,
                    path: rel,
                    name: snippet.name,
                    category: snippet.category,
                    version: snippet.version,
                    size_bytes,
                    has_preview: preview_path.is_some(),
                    preview_path,
                });
            }
        }
        // Materials don't nest, so don't recurse further.
        return;
    }
    for sub in subdirs {
        walk_downloaded(root, &sub, out);
    }
}

fn dir_size(path: &PathBuf) -> std::io::Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_dir() {
            total += dir_size(&entry.path())?;
        } else {
            total += meta.len();
        }
    }
    Ok(total)
}

#[derive(Debug, Clone, Serialize)]
pub struct OutdatedMaterial {
    pub id: String,
    pub path: String,
    pub name: String,
    pub cached_version: u32,
    pub remote_version: u32,
}

#[tauri::command]
pub async fn library_list_outdated() -> Result<Vec<OutdatedMaterial>, String> {
    let cached = library_get_cached_index().await?;
    let Some(index) = cached else {
        return Ok(Vec::new());
    };

    let downloaded = library_list_downloaded().await?;
    // Key by repo-relative path — this uniquely identifies an entry even when
    // two materials in different champion folders happen to share a kebab id.
    let remote_map: HashMap<String, &LibraryIndexEntry> = index
        .materials
        .iter()
        .map(|m| (m.path.clone(), m))
        .collect();

    let mut outdated = Vec::new();
    for d in downloaded {
        if let Some(remote) = remote_map.get(&d.path) {
            if remote.version > d.version {
                outdated.push(OutdatedMaterial {
                    id: d.id,
                    path: d.path,
                    name: d.name,
                    cached_version: d.version,
                    remote_version: remote.version,
                });
            }
        }
    }
    Ok(outdated)
}

#[tauri::command]
pub async fn library_update_material(
    app: tauri::AppHandle,
    path: String,
) -> Result<MaterialSnippet, String> {
    let material_dir = get_material_dir(&path)?;
    if material_dir.exists() {
        fs::remove_dir_all(&material_dir)
            .map_err(|e| format!("Failed to clear old cache for {}: {}", path, e))?;
    }
    library_fetch_material(app, path).await
}

#[tauri::command]
pub async fn library_update_all_outdated(
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let outdated = library_list_outdated().await?;
    let total = outdated.len();
    let mut updated_paths = Vec::new();

    for (idx, mat) in outdated.iter().enumerate() {
        emit_progress(
            &app,
            "update-all",
            idx,
            total,
            &format!("Updating {}", mat.name),
            &mat.path,
        );
        match library_update_material(app.clone(), mat.path.clone()).await {
            Ok(_) => updated_paths.push(mat.path.clone()),
            Err(e) => eprintln!("[library] Failed to update {}: {}", mat.path, e),
        }
    }

    emit_progress(&app, "update-all", total, total, "Done", "");
    Ok(updated_paths)
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview resolution
// ─────────────────────────────────────────────────────────────────────────────
//
// A material can have zero, one, or many potential preview sources:
//   1. A local preview.(png|jpg|jpeg|webp) dropped into the material folder
//      (either in the curated repo copy or in the user's %APPDATA% cache).
//      These get returned as `data:image/...;base64,...` so the React side
//      can bind them directly without needing the Tauri asset protocol to
//      be scoped for the library folder.
//   2. For extracted champion materials, Data Dragon's skin splash art —
//      constructed from `<champion>_<skinNumber>.jpg`. We fall back to
//      skin 0 if no specific skin number is known.
//   3. Nothing — the React side will render a placeholder.
//
// The command inspects the cached snippet.json for `source.champion` and
// `source.skin` so the caller only has to pass the material path.

fn read_local_preview_as_data_url(dir: &PathBuf) -> Option<String> {
    // Accept any of the conventional filenames. `thumb.*` takes precedence
    // because that's what we ask curated-material authors to use.
    let candidates: &[(&str, &str)] = &[
        ("thumb.png",   "image/png"),
        ("thumb.jpg",   "image/jpeg"),
        ("thumb.jpeg",  "image/jpeg"),
        ("thumb.webp",  "image/webp"),
        ("preview.png", "image/png"),
        ("preview.jpg", "image/jpeg"),
        ("preview.jpeg","image/jpeg"),
        ("preview.webp","image/webp"),
    ];
    for (file, mime) in candidates {
        let p = dir.join(file);
        if let Ok(bytes) = fs::read(&p) {
            if !bytes.is_empty() {
                use base64::Engine;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                return Some(format!("data:{};base64,{}", mime, encoded));
            }
        }
    }
    None
}

/// Best-effort preview URL from a snippet's source metadata.
///
/// Targets Community Dragon's `champion-chroma-images` endpoint which
/// serves a tight 3D centered render png (same asset Quartz uses on chroma
/// hover). URL is:
///
///   .../v1/champion-chroma-images/{championId}/{championId}{skinNum:03}.png
///
/// If we can't resolve the champion's numeric id, fall back to Data Dragon
/// flat splash.
async fn splash_url_from_source(snippet_json: &serde_json::Value) -> Option<String> {
    let source = snippet_json.get("source")?;
    let champ = source.get("champion").and_then(|v| v.as_str())?.to_lowercase();

    // Try the source.skin field first. Older extractor runs wrote garbage
    // here (concatenated bin filename segments), so only accept a clean
    // `skin<N>` value. Otherwise parse the skin number out of entryKey
    // (e.g. "Characters/Ahri/Skins/Skin16/Materials/...").
    let skin_num = extract_clean_skin(source.get("skin").and_then(|v| v.as_str()))
        .or_else(|| extract_skin_from_entry_key(
            source.get("entryKey").and_then(|v| v.as_str()),
        ))
        .unwrap_or(0);

    if let Some(champ_id) = get_champion_numeric_id(&champ).await {
        let full_skin_id = champ_id * 1000 + skin_num;
        return Some(format!(
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-chroma-images/{}/{}.png",
            champ_id, full_skin_id
        ));
    }

    // Fallback: Data Dragon flat splash (champion-only, always available).
    let mut alias = champ;
    if let Some(c) = alias.get_mut(0..1) {
        c.make_ascii_uppercase();
    }
    Some(format!(
        "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/{}_{}.jpg",
        alias, skin_num
    ))
}

/// Parse a clean `skin<N>` string into its number. Rejects anything that
/// isn't exactly `skin<digits>` (case-insensitive) so garbage values like
/// `ahri_skins_skin18_skins_skin5_skins_skin56` never silently resolve.
fn extract_clean_skin(value: Option<&str>) -> Option<u32> {
    let s = value?.trim().to_lowercase();
    if !s.starts_with("skin") { return None; }
    let rest = &s[4..];
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    rest.parse::<u32>().ok()
}

/// Parse a skin number out of a StaticMaterialDef entryKey like
/// `Characters/Ahri/Skins/Skin16/Materials/MAT_Body_inst`.
fn extract_skin_from_entry_key(value: Option<&str>) -> Option<u32> {
    let s = value?;
    // Find "/Skins/Skin<N>/" (case-insensitive).
    let lower = s.to_lowercase();
    let idx = lower.find("/skins/skin")?;
    let tail = &s[idx + "/skins/skin".len()..];
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok()
}

const CHAMPION_SUMMARY_URL: &str =
    "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json";

/// Return the numeric Community Dragon champion id for a given alias (lower-
/// case). Caches the full summary under the library dir after first fetch so
/// subsequent lookups are free. Returns None on network/IO error.
async fn get_champion_numeric_id(alias_lower: &str) -> Option<u32> {
    let map = load_or_fetch_champion_map().await?;
    map.get(alias_lower).copied()
}

async fn load_or_fetch_champion_map() -> Option<HashMap<String, u32>> {
    let cache_path = get_library_dir().ok()?.join("champion-summary.json");

    // Try the disk cache first.
    if let Ok(text) = fs::read_to_string(&cache_path) {
        if let Some(map) = parse_champion_summary(&text) {
            return Some(map);
        }
    }

    // Fetch from Community Dragon and persist.
    let client = build_client().ok()?;
    let text = client
        .get(CHAMPION_SUMMARY_URL)
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let _ = fs::create_dir_all(cache_path.parent()?);
    let _ = fs::write(&cache_path, &text);
    parse_champion_summary(&text)
}

fn parse_champion_summary(text: &str) -> Option<HashMap<String, u32>> {
    let arr: serde_json::Value = serde_json::from_str(text).ok()?;
    let items = arr.as_array()?;
    let mut map = HashMap::new();
    for item in items {
        // Use i64 so the "None" placeholder (id = -1) parses and gets skipped
        // without aborting the rest of the loop. `as_u64()` here would have
        // returned None for -1 and poisoned the entire lookup.
        let id = match item.get("id").and_then(|v| v.as_i64()) {
            Some(n) if n > 0 => n as u32,
            _ => continue,
        };
        if let Some(alias) = item.get("alias").and_then(|v| v.as_str()) {
            map.insert(alias.to_lowercase(), id);
        }
        if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
            map.insert(name.to_lowercase(), id);
        }
    }
    if map.is_empty() { None } else { Some(map) }
}

#[tauri::command]
pub async fn library_get_champion_map() -> Result<HashMap<String, u32>, String> {
    Ok(load_or_fetch_champion_map().await.unwrap_or_default())
}

#[tauri::command]
pub async fn library_get_preview(path: String) -> Result<Option<String>, String> {
    // First, check the local %APPDATA% cache.
    if let Ok(cache_dir) = get_material_dir(&path) {
        if let Some(url) = read_local_preview_as_data_url(&cache_dir) {
            return Ok(Some(url));
        }
    }
    // Second, check the LOCAL_DEV_PATH copy of the repo if set (so curated
    // materials without a remote cache entry still get their preview).
    if let Some(dev) = LOCAL_DEV_PATH {
        let dev_dir = PathBuf::from(dev).join("materials").join(&path);
        if let Some(url) = read_local_preview_as_data_url(&dev_dir) {
            return Ok(Some(url));
        }
    }
    // Third, fall back to a Data Dragon splash URL built from the snippet's
    // source metadata. Read snippet.json from wherever it lives.
    let snippet_json = read_snippet_json_any(&path);
    if let Some(json) = snippet_json {
        if let Some(url) = splash_url_from_source(&json).await {
            return Ok(Some(url));
        }
    }
    Ok(None)
}

/// Try the local cache first, then the LOCAL_DEV_PATH repo copy.
fn read_snippet_json_any(path: &str) -> Option<serde_json::Value> {
    if let Ok(dir) = get_material_dir(path) {
        let p = dir.join("snippet.json");
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                return Some(v);
            }
        }
    }
    if let Some(dev) = LOCAL_DEV_PATH {
        let p = PathBuf::from(dev).join("materials").join(path).join("snippet.json");
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                return Some(v);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn library_delete_material(path: String) -> Result<(), String> {
    let material_dir = get_material_dir(&path)?;
    if material_dir.exists() {
        fs::remove_dir_all(&material_dir)
            .map_err(|e| format!("Failed to delete material {}: {}", path, e))?;
    }
    // After removing the material, walk upward and remove any now-empty
    // ancestor folders up to (but not including) the materials root. This
    // keeps the cache tree tidy when e.g. the last ahri/skin15 material is
    // removed — no stray empty skin15 / ahri folders are left behind.
    let root = get_materials_dir()?;
    let mut cur = material_dir.parent().map(|p| p.to_path_buf());
    while let Some(dir) = cur {
        // Stop when we've walked above the materials root.
        if dir == root || !dir.starts_with(&root) {
            break;
        }
        // Only remove the directory if it's empty.
        let is_empty = match fs::read_dir(&dir) {
            Ok(mut it) => it.next().is_none(),
            Err(_) => break,
        };
        if !is_empty {
            break;
        }
        if fs::remove_dir(&dir).is_err() {
            break;
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    Ok(())
}

#[tauri::command]
pub async fn library_clear_all() -> Result<(), String> {
    let materials_dir = get_materials_dir()?;
    if materials_dir.exists() {
        fs::remove_dir_all(&materials_dir)
            .map_err(|e| format!("Failed to clear materials: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn library_open_folder() -> Result<(), String> {
    let dir = ensure_library_dir()?;
    opener::open(&dir)
        .map_err(|e| format!("Failed to open library folder: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands: mod folder detection
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ModFolderDetection {
    pub detected: bool,
    pub assets_path: Option<String>,
    pub mod_root: Option<String>,
}

/// Walk up the parent directories of the given bin file looking for a
/// proper League mod root. A proper mod has EITHER `META/info.json` (cslol
/// / Fantome convention) OR a `WAD/` directory. Just finding an `assets/`
/// folder isn't enough — someone could have a random bin in Downloads with
/// an unrelated `assets/` folder nearby, and we don't want to drop texture
/// files into an arbitrary location.
#[tauri::command]
pub async fn library_detect_mod_folder(bin_path: String) -> Result<ModFolderDetection, String> {
    let path = std::path::Path::new(&bin_path);
    let mut dir = if path.is_file() {
        path.parent().map(|p| p.to_path_buf())
    } else {
        Some(path.to_path_buf())
    };

    while let Some(current) = dir {
        if is_mod_root(&current) {
            // Optional: also surface the assets/ path for display purposes
            let assets = find_assets_child(&current);
            return Ok(ModFolderDetection {
                detected: true,
                assets_path: assets.map(|p| p.to_string_lossy().replace('\\', "/")),
                mod_root: Some(current.to_string_lossy().replace('\\', "/")),
            });
        }
        dir = current.parent().map(|p| p.to_path_buf());
    }

    Ok(ModFolderDetection {
        detected: false,
        assets_path: None,
        mod_root: None,
    })
}

fn is_mod_root(dir: &std::path::Path) -> bool {
    // META/info.json — cslol-manager / Fantome format
    let meta_info = dir.join("META").join("info.json");
    if meta_info.is_file() {
        return true;
    }
    let meta_info_lower = dir.join("meta").join("info.json");
    if meta_info_lower.is_file() {
        return true;
    }
    // Look through the directory for signal folders. A proper mod has:
    //   - a WAD/ subdirectory (cslol working tree), OR
    //   - both DATA/ and ASSETS/ at the same level (raw wad-extract output)
    // Just having an assets folder alone isn't enough — that could be any
    // random folder. The paired DATA + ASSETS signal uniquely identifies
    // a League mod tree.
    let mut has_wad = false;
    let mut has_data = false;
    let mut has_assets = false;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() { continue; }
            if let Some(name) = entry.file_name().to_str() {
                let lower = name.to_ascii_lowercase();
                match lower.as_str() {
                    "wad"    => has_wad = true,
                    "data"   => has_data = true,
                    "assets" => has_assets = true,
                    _ => {}
                }
            }
        }
    }
    has_wad || (has_data && has_assets)
}

fn find_assets_child(dir: &std::path::Path) -> Option<PathBuf> {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.eq_ignore_ascii_case("assets") {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Copy every texture from a cached library material into the user's mod
/// folder at `assets/jadelib/<id>/<filename>` — matching the texture paths
/// embedded in the material's snippet.txt so the mod's references resolve.
///
/// Idempotent: skips files that already exist at the target with the same
/// size. Returns the list of filenames actually copied.
#[tauri::command]
pub async fn library_copy_textures_to_mod(
    material_path: String,
    mod_root: String,
) -> Result<Vec<String>, String> {
    let cache_dir = get_material_dir(&material_path)?;
    let snippet_path = cache_dir.join("snippet.json");

    // Read the snippet metadata to find the material's id and texture list.
    let snippet_text = fs::read_to_string(&snippet_path)
        .map_err(|e| format!("Failed to read {}: {}", snippet_path.display(), e))?;
    let snippet: MaterialSnippet = serde_json::from_str(&snippet_text)
        .map_err(|e| format!("Failed to parse snippet.json: {}", e))?;

    if snippet.texture_files.is_empty() {
        return Ok(Vec::new());
    }

    // Target directory mirrors the repather's convention:
    //   <mod_root>/assets/jadelib/<id>/
    let target_dir = PathBuf::from(&mod_root)
        .join("assets")
        .join("jadelib")
        .join(&snippet.id);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create {}: {}", target_dir.display(), e))?;

    let mut copied = Vec::new();
    let src_textures = cache_dir.join("textures");

    for tex in &snippet.texture_files {
        // Guard against path traversal via crafted filenames
        if tex.name.contains('/') || tex.name.contains('\\') || tex.name.contains("..") {
            continue;
        }
        let src = src_textures.join(&tex.name);
        if !src.exists() {
            // Try case-insensitive match for cross-platform safety
            if let Ok(entries) = fs::read_dir(&src_textures) {
                let lower = tex.name.to_lowercase();
                let mut found: Option<PathBuf> = None;
                for entry in entries.flatten() {
                    if let Some(name) = entry.file_name().to_str() {
                        if name.to_lowercase() == lower {
                            found = Some(entry.path());
                            break;
                        }
                    }
                }
                if found.is_none() { continue; }
                let dst = target_dir.join(&tex.name);
                fs::copy(found.unwrap(), &dst)
                    .map_err(|e| format!("Copy {} → {}: {}", tex.name, dst.display(), e))?;
                copied.push(tex.name.clone());
                continue;
            }
            continue;
        }
        let dst = target_dir.join(&tex.name);

        // Skip if already present at the same size — avoids pointless I/O
        // when the user re-inserts the same material.
        if let (Ok(sm), Ok(dm)) = (fs::metadata(&src), fs::metadata(&dst)) {
            if sm.len() == dm.len() {
                continue;
            }
        }
        fs::copy(&src, &dst)
            .map_err(|e| format!("Copy {} → {}: {}", tex.name, dst.display(), e))?;
        copied.push(tex.name.clone());
    }

    Ok(copied)
}

/// Remove a previously-inserted library material's texture folder from
/// the user's mod at `<mod_root>/assets/jadelib/<id>/`. Used when the
/// user closes a bin without saving so we don't leave orphan textures
/// the game will never read. Safe: only touches the specific jadelib
/// subfolder, never walks outside it.
#[tauri::command]
pub async fn library_remove_inserted_textures(
    mod_root: String,
    id: String,
) -> Result<bool, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("Invalid id: {}", id));
    }
    let target = PathBuf::from(&mod_root)
        .join("assets")
        .join("jadelib")
        .join(&id);
    if !target.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&target)
        .map_err(|e| format!("Failed to remove {}: {}", target.display(), e))?;

    // If the parent `jadelib` folder is now empty, remove it too so we
    // don't leave a dangling empty folder in the mod.
    let jadelib_dir = PathBuf::from(&mod_root).join("assets").join("jadelib");
    if let Ok(mut entries) = fs::read_dir(&jadelib_dir) {
        if entries.next().is_none() {
            let _ = fs::remove_dir(&jadelib_dir);
        }
    }
    Ok(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands: update mode settings
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn library_get_update_mode() -> Result<UpdateModeSettings, String> {
    Ok(read_meta().update_mode)
}

#[tauri::command]
pub async fn library_set_update_mode(
    mode: String,
    interval_hours: u32,
) -> Result<(), String> {
    if !["timed", "smart", "startup"].contains(&mode.as_str()) {
        return Err(format!("Invalid mode: {}", mode));
    }
    let mut meta = read_meta();
    meta.update_mode = UpdateModeSettings { mode, interval_hours };
    write_meta(&meta)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryStatus {
    pub mode: String,
    pub interval_hours: u32,
    pub last_checked_at: String,
    pub last_updated_remote: String,
    pub downloaded_count: usize,
    pub outdated_count: usize,
    pub total_size_bytes: u64,
}

#[tauri::command]
pub async fn library_get_status() -> Result<LibraryStatus, String> {
    let meta = read_meta();
    let downloaded = library_list_downloaded().await.unwrap_or_default();
    let outdated = library_list_outdated().await.unwrap_or_default();
    let total_size: u64 = downloaded.iter().map(|d| d.size_bytes).sum();

    Ok(LibraryStatus {
        mode: meta.update_mode.mode,
        interval_hours: meta.update_mode.interval_hours,
        last_checked_at: meta.index.last_checked_at,
        last_updated_remote: meta.index.last_updated_remote,
        downloaded_count: downloaded.len(),
        outdated_count: outdated.len(),
        total_size_bytes: total_size,
    })
}

/// Kicks off a background update check based on the configured mode.
/// Non-blocking — returns immediately after spawning the task.
#[tauri::command]
pub async fn library_trigger_background_update(app: tauri::AppHandle) -> Result<(), String> {
    let meta = read_meta();
    let mode = meta.update_mode.mode.clone();

    tauri::async_runtime::spawn(async move {
        let should_fetch_index = match mode.as_str() {
            "smart" => is_remote_index_newer(&read_meta()).await,
            _ => true,
        };

        if should_fetch_index {
            if let Err(e) = library_fetch_index(app.clone()).await {
                eprintln!("[library] Background index fetch failed: {}", e);
                return;
            }
        }

        // After fetching the index, refresh any outdated materials
        if let Err(e) = library_update_all_outdated(app.clone()).await {
            eprintln!("[library] Background update-all failed: {}", e);
        }
    });

    Ok(())
}
