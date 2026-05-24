/// Extra commands: file association, autostart, updater, SKN reader
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use parking_lot::Mutex;
use futures::StreamExt;
use byteorder::{LittleEndian, ReadBytesExt};
use std::io::{Cursor, Seek, SeekFrom};

// ============================================================
// File Association (Windows Registry)
// ============================================================

#[cfg(windows)]
fn get_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get exe path: {}", e))
}

/// Notify Windows shell of association changes
#[cfg(windows)]
fn notify_shell_change() {
    // SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL)
    unsafe {
        type SHChangeNotifyFn = unsafe extern "system" fn(i32, u32, *const std::ffi::c_void, *const std::ffi::c_void);
        if let Ok(lib) = libloading::Library::new("shell32.dll") {
            if let Ok(func) = lib.get::<SHChangeNotifyFn>(b"SHChangeNotify") {
                func(0x08000000i32, 0x0000u32, std::ptr::null(), std::ptr::null());
            }
        }
    }
}

/// Default Jade icon bytes, embedded at compile time from src-tauri/icons/icon.ico.
/// This is the authoritative copy the file association registry points at so
/// Explorer always renders the current high-res version instead of a stale
/// cached render keyed to the exe path.
#[cfg(windows)]
const EMBEDDED_JADE_ICO: &[u8] = include_bytes!("../icons/icon.ico");

/// Ensure a standalone `jade.ico` exists in the config dir with the current
/// embedded icon bytes. Writes (or overwrites) the file only when its contents
/// differ from the embedded copy, so version bumps invalidate Windows' icon
/// cache via a changed file mtime without rewriting on every launch.
#[cfg(windows)]
pub fn ensure_default_icon_file() -> Result<std::path::PathBuf, String> {
    let config_dir = crate::app_commands::get_config_dir()?;
    let path = config_dir.join("jade.ico");

    let needs_write = match std::fs::read(&path) {
        Ok(existing) => existing != EMBEDDED_JADE_ICO,
        Err(_) => true,
    };

    if needs_write {
        std::fs::write(&path, EMBEDDED_JADE_ICO)
            .map_err(|e| format!("Failed to write jade.ico: {}", e))?;
        println!("[FileAssoc] Wrote default jade.ico to {:?}", path);
    }

    Ok(path)
}

/// Resolve the icon value for the file association DefaultIcon registry key.
/// If a custom or builtin icon .ico exists in the config dir, use that;
/// otherwise fall back to the standalone jade.ico we ship in the config dir;
/// as a last resort use the exe's embedded icon.
#[cfg(windows)]
fn resolve_association_icon() -> Result<String, String> {
    let exe_path = get_exe_path()?;

    // Check if there's a custom icon .ico in the config dir
    let config_dir = crate::app_commands::get_config_dir()?;
    let custom_ico = config_dir.join("custom_icon.ico");
    if custom_ico.exists() {
        return Ok(custom_ico.to_string_lossy().to_string());
    }

    // Check for builtin icon .ico files
    let prefs_path = config_dir.join("preferences.json");
    if prefs_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&prefs_path) {
            if let Ok(prefs) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(builtin_name) = prefs.get("builtin_icon").and_then(|v| v.as_str()) {
                    let builtin_ico = config_dir.join(format!("builtin_{}.ico", builtin_name));
                    if builtin_ico.exists() {
                        return Ok(builtin_ico.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // Prefer the standalone jade.ico in the config dir over the exe-embedded
    // icon. Explorer caches file-association icons per DefaultIcon string, so
    // pointing at a real file path (whose mtime changes when the embedded
    // bytes change) forces a re-render on upgrade.
    if let Ok(default_ico) = ensure_default_icon_file() {
        return Ok(default_ico.to_string_lossy().to_string());
    }

    // Last-resort fallback: exe-embedded icon.
    Ok(format!("{},0", exe_path))
}

/// Update the DefaultIcon registry value for .bin file association.
/// Called whenever the app icon changes so registered files reflect the new icon.
#[cfg(windows)]
pub fn update_association_icon() {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // Only update if the association is registered
    if let Ok(ext_key) = hkcu.open_subkey(r"Software\Classes\.bin") {
        let val: Result<String, _> = ext_key.get_value("");
        if val.ok().as_deref() != Some("JadeBinFile") {
            return;
        }
    } else {
        return;
    }

    if let Ok(icon_value) = resolve_association_icon() {
        if let Ok(class_key) = hkcu.open_subkey(r"Software\Classes\JadeBinFile") {
            if let Ok((icon_key, _)) = class_key.create_subkey("DefaultIcon") {
                let _ = icon_key.set_value("", &icon_value);
                notify_shell_change();
                println!("[FileAssoc] Updated DefaultIcon to: {}", icon_value);
            }
        }
    }
}

/// Register .bin file association in Windows registry (HKCU, no admin needed)
#[tauri::command]
pub async fn register_bin_association() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let exe_path = get_exe_path()?;
        let icon_value = resolve_association_icon()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        let (class_key, _) = hkcu
            .create_subkey(r"Software\Classes\JadeBinFile")
            .map_err(|e| format!("Failed to create class key: {}", e))?;
        class_key.set_value("", &"Jade League Bin File")
            .map_err(|e| format!("Failed to set class name: {}", e))?;

        let (icon_key, _) = class_key
            .create_subkey("DefaultIcon")
            .map_err(|e| format!("Failed to create icon key: {}", e))?;
        icon_key.set_value("", &icon_value)
            .map_err(|e| format!("Failed to set icon: {}", e))?;

        let (cmd_key, _) = class_key
            .create_subkey(r"shell\open\command")
            .map_err(|e| format!("Failed to create command key: {}", e))?;
        cmd_key.set_value("", &format!("\"{}\" \"%1\"", exe_path))
            .map_err(|e| format!("Failed to set open command: {}", e))?;

        // Register every extension Jade can open as the default
        // file type: `.bin` (Riot BIN), `.troybin` / `.inibin`
        // (legacy VFX source files the troybin convert pipeline
        // handles). All three point at the same `JadeBinFile` class
        // so they share the icon and open-command — the frontend
        // routes by extension.
        for ext in &[".bin", ".troybin", ".inibin"] {
            let (ext_key, _) = hkcu
                .create_subkey(format!(r"Software\Classes\{}", ext))
                .map_err(|e| format!("Failed to create {} key: {}", ext, e))?;
            ext_key.set_value("", &"JadeBinFile")
                .map_err(|e| format!("Failed to set {} default: {}", ext, e))?;
        }

        notify_shell_change();
        println!("[FileAssoc] Registered .bin/.troybin/.inibin association with icon: {}", icon_value);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("File association is only supported on Windows".to_string())
    }
}

/// Unregister .bin file association from Windows registry
#[tauri::command]
pub async fn unregister_bin_association() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for ext in &[".bin", ".troybin", ".inibin"] {
            let key_path = format!(r"Software\Classes\{}", ext);
            if let Ok(ext_key) = hkcu.open_subkey(&key_path) {
                let current_val: Result<String, _> = ext_key.get_value("");
                if current_val.ok().as_deref() == Some("JadeBinFile") {
                    let _ = hkcu.delete_subkey_all(&key_path);
                }
            }
        }
        let _ = hkcu.delete_subkey_all(r"Software\Classes\JadeBinFile");

        notify_shell_change();
        println!("[FileAssoc] Unregistered .bin/.troybin/.inibin association");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("File association is only supported on Windows".to_string())
    }
}

/// Check if .bin file association is registered for Jade
#[tauri::command]
pub async fn get_bin_association_status() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(ext_key) = hkcu.open_subkey(r"Software\Classes\.bin") {
            let val: Result<String, _> = ext_key.get_value("");
            return val.ok().as_deref() == Some("JadeBinFile");
        }
        false
    }
    #[cfg(not(windows))]
    {
        false
    }
}

// ============================================================
// Autostart
// ============================================================

/// Enable or disable start at startup
#[tauri::command]
pub async fn toggle_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enable {
        autolaunch.enable().map_err(|e| format!("Failed to enable autostart: {}", e))?;
        println!("[Autostart] Enabled startup");
    } else {
        autolaunch.disable().map_err(|e| format!("Failed to disable autostart: {}", e))?;
        println!("[Autostart] Disabled startup");
    }
    crate::app_commands::set_preference(
        app,
        "StartAtStartup".to_string(),
        if enable { "True" } else { "False" }.to_string(),
    ).await
}

/// Check if autostart is currently enabled
#[tauri::command]
pub async fn get_autostart_status(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

// ============================================================
// Updater
// ============================================================

const GITHUB_REPO: &str = "RitoShark/Jade-League-Bin-Editor";
const RELEASES_URL: &str = "https://github.com/RitoShark/Jade-League-Bin-Editor/releases/latest";
const INSTALLER_PATTERN: &str = "_x64-setup.exe";

/// Cached release JSON so we don't hit the API twice (check → download).
static CACHED_RELEASE: LazyLock<Mutex<Option<serde_json::Value>>> =
    LazyLock::new(|| Mutex::new(None));

/// Holds the path to the downloaded installer so it can be run separately.
static INSTALLER_PATH: LazyLock<Mutex<Option<std::path::PathBuf>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub notes: String,
    pub release_url: String,
}

fn is_newer_version(remote: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.').filter_map(|p| p.parse().ok()).collect()
    };
    parse(remote) > parse(current)
}

fn make_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("jade-app")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_default()
}

/// Fetch the latest release from GitHub API with retry (up to 3 attempts).
async fn fetch_latest_release() -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let client = make_client();
    let mut last_err = String::new();

    for attempt in 0..3u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2u64.pow(attempt))).await;
        }

        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Network error: {}", e);
                continue;
            }
        };

        let status = resp.status();
        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("GitHub API rate limit reached — try again in a few minutes".to_string());
        }
        if !status.is_success() {
            last_err = format!("GitHub API returned {}", status);
            continue;
        }

        return resp.json().await.map_err(|e| format!("Failed to parse response: {}", e));
    }

    Err(last_err)
}

/// Clean up old Jade installer files from temp.
fn cleanup_old_installers(keep: Option<&std::path::Path>) {
    let temp = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&temp) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let lower = name.to_lowercase();
                if lower.starts_with("jade_") && lower.ends_with("_x64-setup.exe") {
                    if keep.map_or(true, |k| k != path) {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
    let _ = std::fs::remove_file(temp.join("jade_update.bat"));
}

/// Check GitHub releases API for a newer version.
/// Caches the release JSON for use by start_update_download.
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION");
    let json = fetch_latest_release().await?;

    let tag = json["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    let notes = json["body"].as_str().unwrap_or("").to_string();
    let release_url = json["html_url"].as_str().unwrap_or(RELEASES_URL).to_string();
    let available = is_newer_version(&tag, current);

    // Cache the release so download doesn't need another API call
    *CACHED_RELEASE.lock() = Some(json);

    Ok(UpdateInfo {
        available,
        version: tag,
        notes,
        release_url,
    })
}

/// Stream-download the installer to disk, emitting progress events.
/// Clones the cached release (preserving it for retries) or fetches fresh.
#[tauri::command]
pub async fn start_update_download(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use std::io::Write;

    // Clone the cache instead of taking it, so retries don't need a new API call
    let json = {
        let cached = CACHED_RELEASE.lock();
        cached.clone()
    };
    let json = match json {
        Some(val) => val,
        None => fetch_latest_release().await?,
    };

    let assets = json["assets"].as_array()
        .ok_or("No assets found in release")?;

    let installer = assets.iter()
        .find(|a| {
            let name = a["name"].as_str().unwrap_or("").to_lowercase();
            name.ends_with(INSTALLER_PATTERN)
        })
        .ok_or("No x64 NSIS installer found in the latest release")?;

    let download_url = installer["browser_download_url"].as_str()
        .ok_or("Installer asset has no download URL")?;
    let filename = installer["name"].as_str().unwrap_or("jade-setup.exe");
    let installer_path = std::env::temp_dir().join(filename);

    cleanup_old_installers(None);

    let resp = make_client()
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let mut file = std::fs::File::create(&installer_path)
        .map_err(|e| format!("Failed to create installer file: {}", e))?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        downloaded += chunk.len() as u64;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write to installer file: {}", e))?;
        let _ = app.emit("update-download-progress", DownloadProgress { downloaded, total });
    }

    file.flush().map_err(|e| format!("Failed to flush installer file: {}", e))?;
    drop(file);

    // Verify file size matches expected total (catch truncated downloads)
    if total > 0 {
        let actual = std::fs::metadata(&installer_path)
            .map(|m| m.len())
            .unwrap_or(0);
        if actual != total {
            let _ = std::fs::remove_file(&installer_path);
            return Err(format!(
                "Download incomplete: got {} of {} bytes",
                actual, total
            ));
        }
    }

    *INSTALLER_PATH.lock() = Some(installer_path);
    Ok(())
}

/// Run the previously downloaded installer.
///
/// - silent=true:  runs NSIS with /S, waits for it to finish, then relaunches Jade.
/// - silent=false: exits Jade first, then launches the installer normally so the
///                 user sees the wizard (which upgrades in-place without uninstalling).
///
/// The batch script is spawned as a fully detached process
/// (CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS) so it survives Jade exiting.
#[tauri::command]
pub async fn run_installer(silent: bool, app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let path = INSTALLER_PATH.lock().clone()
        .ok_or("No installer has been downloaded yet")?;

    if !path.exists() {
        return Err("Installer file no longer exists on disk".to_string());
    }

    let current_dir = std::env::current_exe()
        .map(|p| p.parent().unwrap_or(std::path::Path::new(".")).to_path_buf())
        .unwrap_or_default();

    let is_dev_build = current_dir.to_string_lossy().contains("target\\debug")
        || current_dir.to_string_lossy().contains("target\\release")
        || current_dir.to_string_lossy().contains("target/debug")
        || current_dir.to_string_lossy().contains("target/release");

    let install_dir = if is_dev_build { None } else { Some(current_dir) };
    let exe_path = install_dir.as_ref()
        .map(|d| d.join("jade-rust.exe"))
        .unwrap_or_else(|| std::path::PathBuf::from("jade-rust.exe"));

    let bat_path = std::env::temp_dir().join("jade_update.bat");
    let log_path = std::env::temp_dir().join("jade_update.log");

    let dir_flag = install_dir.as_ref()
        .map(|d| format!(" /D={}", d.display()))
        .unwrap_or_default();

    let installer_cmd = if silent {
        format!("\"{}\" /S{}", path.display(), dir_flag)
    } else {
        format!("\"{}\"{}", path.display(), dir_flag)
    };

    let relaunch_line = if silent && !is_dev_build {
        format!("start \"\" \"{}\"\r\n", exe_path.display())
    } else {
        String::new()
    };

    let bat_content = format!(
"@echo off\r
echo [%date% %time%] Update script started > \"{log}\"\r
timeout /t 2 /nobreak >NUL\r
echo [%date% %time%] Running installer >> \"{log}\"\r
{cmd}\r
echo [%date% %time%] Installer finished >> \"{log}\"\r
{relaunch}del \"%~f0\"\r
",
        log = log_path.display(),
        cmd = installer_cmd,
        relaunch = relaunch_line,
    );

    std::fs::write(&bat_path, &bat_content)
        .map_err(|e| format!("Failed to write update script: {}", e))?;

    // CREATE_NEW_PROCESS_GROUP (0x200) | DETACHED_PROCESS (0x08)
    // Console briefly flashes — CREATE_NO_WINDOW triggers Defender and
    // powershell -WindowStyle Hidden is too slow / fragile to start.
    const DETACH_FLAGS: u32 = 0x00000200 | 0x00000008;

    std::process::Command::new("cmd")
        .args(["/C", &bat_path.to_string_lossy()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(DETACH_FLAGS)
        .spawn()
        .map_err(|e| format!("Failed to launch update script: {}", e))?;

    app.exit(0);

    Ok(())
}

// ============================================================
// SKN Reader — extract submesh material names
// ============================================================

const SKN_MAGIC: u32 = 0x00112233;

/// Read submesh material names from an SKN file.
fn read_skn_materials(skn_path: &std::path::Path) -> Result<Vec<String>, String> {
    let data = std::fs::read(skn_path)
        .map_err(|e| format!("Failed to read SKN file: {}", e))?;
    let mut cur = Cursor::new(&data);

    let magic = cur.read_u32::<LittleEndian>()
        .map_err(|_| "SKN too short: no magic")?;
    if magic != SKN_MAGIC {
        return Err(format!("Not a valid SKN file (magic: {:#010x})", magic));
    }

    let major = cur.read_u16::<LittleEndian>()
        .map_err(|_| "SKN too short: no version")?;
    let _minor = cur.read_u16::<LittleEndian>()
        .map_err(|_| "SKN too short: no minor version")?;

    if major == 0 {
        // Version 0: no submesh table, just index/vertex counts
        return Err("SKN version 0 has no submesh table".to_string());
    }

    let num_submeshes = cur.read_u32::<LittleEndian>()
        .map_err(|_| "Failed to read submesh count")? as usize;

    if num_submeshes == 0 || num_submeshes > 1000 {
        return Err(format!("Invalid submesh count: {}", num_submeshes));
    }

    let mut materials = Vec::with_capacity(num_submeshes);

    for _ in 0..num_submeshes {
        // Each submesh header starts with a 64-byte null-padded ASCII name
        let mut name_buf = [0u8; 64];
        std::io::Read::read_exact(&mut cur, &mut name_buf)
            .map_err(|_| "Failed to read submesh name")?;

        let name = std::str::from_utf8(&name_buf)
            .unwrap_or("")
            .trim_end_matches('\0')
            .to_string();

        // Skip rest of submesh header: startVertex(u32) + vertexCount(u32) + startIndex(u32) + indexCount(u32) = 16 bytes
        // Total per-submesh size is 80 bytes (64 name + 16 fields) for all
        // versions. The bin_hash that appears in .skn.json dumps is computed
        // from the name at parse time — it isn't stored in the binary.
        cur.seek(SeekFrom::Current(16))
            .map_err(|_| "Failed to skip submesh header fields")?;

        if !name.is_empty() {
            materials.push(name);
        }
    }

    Ok(materials)
}

#[derive(Debug, Serialize)]
pub struct MaterialMatch {
    pub material: String,
    pub texture: String,
}

#[derive(Debug, Serialize)]
pub struct AutoMaterialResult {
    pub matches: Vec<MaterialMatch>,
    pub skn_path: String,
    pub unmatched: Vec<String>,
    /// Every texture file found in the skin's texture folder, as game
    /// asset-relative paths. Used by the dialog's "manual match" mode so
    /// the user can pick any detected texture, not just the auto-matched one.
    pub textures: Vec<String>,
}

/// Given the bin file path and the simpleSkin asset path, resolve the SKN,
/// read its materials, and scan the texture folder for matching .tex/.dds files.
///
/// match_mode controls matching strictness:
///   3 = exact (material "Body2" only matches "Body2.tex")
///   2 = loose (strip trailing digits: "Body2" matches "Body.tex")
///   1 = fuzzy (best substring overlap if no better match exists)
#[tauri::command]
pub async fn auto_material_override(
    bin_file_path: String,
    simple_skin_path: String,
    texture_path: String,
    match_mode: Option<u32>,
) -> Result<AutoMaterialResult, String> {
    let mode = match_mode.unwrap_or(3).clamp(1, 3);

    // Resolve the SKN path relative to the bin file (walk up looking for the asset)
    let skn_resolved = crate::app_commands::resolve_asset_path(
        bin_file_path.clone(),
        simple_skin_path.clone(),
    ).await?
        .ok_or_else(|| format!("Could not find SKN file: {}", simple_skin_path))?;

    let skn_path = std::path::Path::new(&skn_resolved);
    let materials = read_skn_materials(skn_path)?;

    // Resolve the texture path to find the texture folder
    let tex_resolved = crate::app_commands::resolve_asset_path(
        bin_file_path,
        texture_path,
    ).await?;

    let tex_folder = tex_resolved
        .as_ref()
        .and_then(|p| std::path::Path::new(p).parent())
        .map(|p| p.to_path_buf())
        .ok_or("Could not resolve texture folder")?;

    // Scan the texture folder for .tex and .dds files
    let mut tex_files: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&tex_folder) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if ext_lower == "tex" || ext_lower == "dds" {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let stem_lower = stem.to_lowercase();
                        let asset_path = path.to_string_lossy().replace('\\', "/");
                        // Prefer .tex over .dds
                        if !tex_files.contains_key(&stem_lower) || ext_lower == "tex" {
                            tex_files.insert(stem_lower, asset_path);
                        }
                    }
                }
            }
        }
    }

    let tex_stems: Vec<String> = tex_files.keys().cloned().collect();

    let mut matches = Vec::new();
    let mut unmatched = Vec::new();

    for mat in &materials {
        let mat_lower = mat.to_lowercase();

        // Mode 3: exact match
        if let Some(tex_path) = tex_files.get(&mat_lower) {
            matches.push(MaterialMatch {
                material: mat.clone(),
                texture: extract_asset_relative(tex_path),
            });
            continue;
        }

        // Mode 2: strip trailing digits from material name
        if mode <= 2 {
            let stripped = mat_lower.trim_end_matches(|c: char| c.is_ascii_digit());
            if !stripped.is_empty() && stripped != mat_lower {
                if let Some(tex_path) = tex_files.get(stripped) {
                    matches.push(MaterialMatch {
                        material: mat.clone(),
                        texture: extract_asset_relative(tex_path),
                    });
                    continue;
                }
            }
            // Also try: texture stem contains material base or vice versa
            if let Some(tex_path) = find_contains_match(stripped, &tex_stems, &tex_files) {
                matches.push(MaterialMatch {
                    material: mat.clone(),
                    texture: extract_asset_relative(&tex_path),
                });
                continue;
            }
        }

        // Mode 1: fuzzy — find best common-character overlap
        if mode <= 1 {
            if let Some(tex_path) = find_fuzzy_match(&mat_lower, &tex_stems, &tex_files) {
                matches.push(MaterialMatch {
                    material: mat.clone(),
                    texture: extract_asset_relative(&tex_path),
                });
                continue;
            }
        }

        unmatched.push(mat.clone());
    }

    // All detected textures as asset-relative paths, sorted for stable UI.
    let mut all_textures: Vec<String> = tex_files
        .values()
        .map(|p| extract_asset_relative(p))
        .collect();
    all_textures.sort();

    Ok(AutoMaterialResult {
        matches,
        skn_path: skn_resolved,
        unmatched,
        textures: all_textures,
    })
}

/// Mode 2 helper: find a texture whose stem contains the material base or vice versa.
fn find_contains_match(
    mat_base: &str,
    tex_stems: &[String],
    tex_files: &std::collections::HashMap<String, String>,
) -> Option<String> {
    // Prefer textures that contain the material name
    for stem in tex_stems {
        if stem.contains(mat_base) || mat_base.contains(stem.as_str()) {
            if let Some(path) = tex_files.get(stem) {
                return Some(path.clone());
            }
        }
    }
    None
}

/// Mode 1 helper: find the texture with the most character overlap.
fn find_fuzzy_match(
    mat_lower: &str,
    tex_stems: &[String],
    tex_files: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let mut best_score = 0usize;
    let mut best_path: Option<String> = None;

    for stem in tex_stems {
        let score = common_char_score(mat_lower, stem);
        if score > best_score {
            best_score = score;
            if let Some(path) = tex_files.get(stem) {
                best_path = Some(path.clone());
            }
        }
    }

    // Only accept if at least 1 character matches
    if best_score > 0 { best_path } else { None }
}

/// Count how many characters from `a` appear in `b` (order-independent).
fn common_char_score(a: &str, b: &str) -> usize {
    let mut score = 0;
    let b_chars: Vec<char> = b.chars().collect();
    let mut used = vec![false; b_chars.len()];
    for ac in a.chars() {
        for (i, &bc) in b_chars.iter().enumerate() {
            if !used[i] && ac == bc {
                used[i] = true;
                score += 1;
                break;
            }
        }
    }
    score
}

/// Try to extract the "ASSETS/..." portion from an absolute path.
fn extract_asset_relative(path: &str) -> String {
    let lower = path.to_lowercase();
    if let Some(idx) = lower.find("assets/") {
        return path[idx..].to_string();
    }
    // Fallback: return the full path
    path.to_string()
}

// ============================================================
// File Browser commands (Welcome screen Extract Files view)
// ============================================================

/// One item inside a directory listing — used by the welcome screen's
/// extract-files browser to render rows. Sizes are bytes, modified is a
/// unix-seconds timestamp (0 if metadata couldn't be read).
#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub extension: String,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let mut out: Vec<DirEntry> = Vec::new();
    let read = std::fs::read_dir(p).map_err(|e| e.to_string())?;
    for entry in read.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        // Skip hidden / system entries on Windows by leading dot or
        // attribute. Cheap filter — we don't need to be exhaustive.
        if name.starts_with('.') {
            continue;
        }
        let metadata = entry.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = if is_dir { 0 } else { metadata.as_ref().map(|m| m.len()).unwrap_or(0) };
        let modified = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let extension = entry_path
            .extension()
            .map(|e| e.to_string_lossy().into_owned().to_lowercase())
            .unwrap_or_default();
        out.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            size,
            modified,
            extension,
        });
    }
    // Folders first, then alphabetical within each group.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// A single entry in the explorer's recursive index — used by the
/// filter row to fuzzy-match against every file/folder under the
/// root without paying the cost of a full `list_directory` per
/// folder. Keeps the payload tight: just the relative path, the
/// kind, and the extension.
#[derive(Serialize)]
pub struct RecursiveEntry {
    pub rel_path: String,
    pub is_dir: bool,
    pub extension: String,
}

/// Recursively walk `root` collecting every visible entry as a flat
/// list. Bounded at 200_000 entries to keep huge content trees from
/// pinning the IPC channel for tens of seconds — the filter row
/// uses this for fuzzy matching, and 200k matches is already past
/// the point where the UI is useful. Hidden / dotted entries are
/// skipped to match `list_directory`'s behaviour.
#[tauri::command]
pub fn list_directory_recursive(path: String) -> Result<Vec<RecursiveEntry>, String> {
    const LIMIT: usize = 200_000;
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let mut out: Vec<RecursiveEntry> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel_prefix)) = stack.pop() {
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue, // permission denied, skip
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let entry_path = entry.path();
            let metadata = entry.metadata().ok();
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let rel = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_prefix, name)
            };
            let extension = if is_dir {
                String::new()
            } else {
                entry_path
                    .extension()
                    .map(|e| e.to_string_lossy().into_owned().to_lowercase())
                    .unwrap_or_default()
            };
            out.push(RecursiveEntry {
                rel_path: rel.clone(),
                is_dir,
                extension,
            });
            if out.len() >= LIMIT {
                return Ok(out);
            }
            if is_dir {
                stack.push((entry_path, rel));
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn get_home_directory() -> Option<String> {
    if let Some(home) = std::env::var_os("USERPROFILE") {
        return Some(home.to_string_lossy().into_owned());
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Some(home.to_string_lossy().into_owned());
    }
    None
}

/// Read the parent directory of `path`, or return the same path when it
/// has no parent (drive root). Helps the file browser implement "go up".
#[tauri::command]
pub fn parent_directory(path: String) -> String {
    let p = std::path::Path::new(&path);
    p.parent()
        .map(|pp| pp.to_string_lossy().into_owned())
        .unwrap_or(path)
}

/// Create a new empty directory at `parent_path/name`. Errors if the
/// parent doesn't exist or the target already exists. Used by the file
/// explorer pane's "New Folder" action.
#[tauri::command]
pub fn fs_create_directory(parent_path: String, name: String) -> Result<String, String> {
    let parent = std::path::Path::new(&parent_path);
    if !parent.is_dir() {
        return Err(format!("Parent is not a directory: {}", parent_path));
    }
    if name.trim().is_empty() || name.contains('/') || name.contains('\\') {
        return Err("Invalid folder name".to_string());
    }
    let target = parent.join(&name);
    if target.exists() {
        return Err(format!("Already exists: {}", target.display()));
    }
    std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Create an empty file at `parent_path/name`. Same error semantics as
/// `fs_create_directory`.
#[tauri::command]
pub fn fs_create_file(parent_path: String, name: String) -> Result<String, String> {
    let parent = std::path::Path::new(&parent_path);
    if !parent.is_dir() {
        return Err(format!("Parent is not a directory: {}", parent_path));
    }
    if name.trim().is_empty() || name.contains('/') || name.contains('\\') {
        return Err("Invalid file name".to_string());
    }
    let target = parent.join(&name);
    if target.exists() {
        return Err(format!("Already exists: {}", target.display()));
    }
    std::fs::File::create(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Rename `path` to a sibling with `new_name`. Returns the new path.
#[tauri::command]
pub fn fs_rename_entry(path: String, new_name: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if new_name.trim().is_empty() || new_name.contains('/') || new_name.contains('\\') {
        return Err("Invalid name".to_string());
    }
    let parent = p.parent().ok_or_else(|| "Cannot rename root".to_string())?;
    let target = parent.join(&new_name);
    if target.exists() && target != p {
        return Err(format!("Already exists: {}", target.display()));
    }
    std::fs::rename(p, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Delete a file or directory (recursively). The explorer pane warns
/// the user before invoking this.
#[tauri::command]
pub fn fs_delete_entry(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a directory in Windows Explorer. Different from
/// `show_in_explorer`, which uses `/select` to highlight a single file
/// inside its parent — here we want to open the folder itself so the
/// user sees its contents.
#[tauri::command]
pub fn open_folder_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let native = path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            // 0x08000000 = CREATE_NO_WINDOW — no flash of cmd window.
            .raw_arg(format!("\"{}\"", native))
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Best-effort cross-platform: rely on `xdg-open` / `open`.
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    Ok(())
}

/// Find a League install by first asking the Riot Client where it put
/// the games it manages, then falling back to a hardcoded list of
/// common locations. Returns `<install>/Game/DATA/FINAL` (where every
/// moddable champion WAD lives) when that subfolder exists, otherwise
/// the install root.
///
/// The Riot Client maintains `%ProgramData%\Riot Games\RiotClientInstalls.json`
/// with the canonical path of every Riot game on the machine —
/// reading that catches custom drives / custom folder names that the
/// hardcoded probe list would miss entirely (M:\Games\League etc.).
#[tauri::command]
pub fn detect_league_install() -> Option<String> {
    if let Some(p) = riot_client_install_paths()
        .into_iter()
        .find(|p| !is_pbe_path(p))
    {
        if let Some(resolved) = resolve_install_root(&p) {
            return Some(resolved);
        }
    }
    detect_riot_install(&[
        r"C:\Riot Games\League of Legends",
        r"D:\Riot Games\League of Legends",
        r"E:\Riot Games\League of Legends",
        r"F:\Riot Games\League of Legends",
        r"C:\Program Files\Riot Games\League of Legends",
        r"C:\Program Files (x86)\Riot Games\League of Legends",
    ])
}

/// PBE counterpart of [`detect_league_install`]. Same JSON-first
/// cascade — we just filter for the entry whose path contains a PBE
/// marker (`(PBE)` or `PBE` segment) instead of skipping it.
#[tauri::command]
pub fn detect_league_pbe_install() -> Option<String> {
    if let Some(p) = riot_client_install_paths()
        .into_iter()
        .find(|p| is_pbe_path(p))
    {
        if let Some(resolved) = resolve_install_root(&p) {
            return Some(resolved);
        }
    }
    detect_riot_install(&[
        r"C:\Riot Games\League of Legends (PBE)",
        r"D:\Riot Games\League of Legends (PBE)",
        r"E:\Riot Games\League of Legends (PBE)",
        r"F:\Riot Games\League of Legends (PBE)",
        r"C:\Riot Games\League of Legends PBE",
        r"D:\Riot Games\League of Legends PBE",
        r"E:\Riot Games\League of Legends PBE",
        r"F:\Riot Games\League of Legends PBE",
        r"C:\Program Files\Riot Games\League of Legends (PBE)",
        r"C:\Program Files (x86)\Riot Games\League of Legends (PBE)",
    ])
}

/// Read `%ProgramData%\Riot Games\RiotClientInstalls.json` and return
/// every League install path the Riot Client tracks. Each entry is
/// returned with native separators + no trailing slash. Empty / missing
/// JSON returns an empty vec — caller falls back to a hardcoded probe.
fn riot_client_install_paths() -> Vec<String> {
    let program_data = std::env::var("ProgramData")
        .or_else(|_| std::env::var("PROGRAMDATA"))
        .unwrap_or_else(|_| "C:\\ProgramData".to_string());
    let json_path = std::path::Path::new(&program_data)
        .join("Riot Games")
        .join("RiotClientInstalls.json");
    let Ok(bytes) = std::fs::read(&json_path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    // `associated_client` maps `<game install path>` →
    // `<RiotClientServices.exe path>`. The keys are what we want.
    // Riot writes them with forward slashes and a trailing slash; we
    // normalise both before handing back.
    let mut out: Vec<String> = Vec::new();
    if let Some(obj) = value.get("associated_client").and_then(|v| v.as_object()) {
        for key in obj.keys() {
            let lower = key.to_lowercase();
            if !lower.contains("league of legends") {
                continue;
            }
            let mut path = key.replace('/', "\\");
            while path.ends_with('\\') || path.ends_with('/') {
                path.pop();
            }
            if !path.is_empty() {
                out.push(path);
            }
        }
    }
    out
}

/// Heuristic: does this path look like a PBE install? Matches the
/// `(PBE)` parenthesised tag (Riot's canonical form) and the bare
/// trailing `PBE` segment some users rename to.
fn is_pbe_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    if lower.contains("(pbe)") {
        return true;
    }
    // Bare ` pbe` token at the tail — matches `League of Legends PBE`
    // but not `League of Legends Public Build Environment` style.
    lower.ends_with(" pbe") || lower.ends_with("\\pbe") || lower.ends_with("/pbe")
}

/// Validate an install root and return either `<root>/Game/DATA/FINAL`
/// (when present — the canonical mod-relevant subdir) or the install
/// root itself. None when the path doesn't pass the basic sanity
/// check (`Game/` folder or `League of Legends.exe` at the root).
fn resolve_install_root(install_path: &str) -> Option<String> {
    let p = std::path::Path::new(install_path);
    if !p.is_dir() {
        return None;
    }
    if !(p.join("Game").is_dir() || p.join("League of Legends.exe").exists()) {
        return None;
    }
    let final_path = p.join("Game").join("DATA").join("FINAL");
    if final_path.is_dir() {
        return Some(final_path.to_string_lossy().into_owned());
    }
    Some(install_path.to_string())
}

/// One champion WAD found in the user's install — enough info for the
/// Viewer's stage-1 gallery (which mounts nothing — it just lists what's
/// available). The `id` is the WAD's filename stem (e.g. `Aatrox`,
/// `Chogath`); the front-end uses it to look up portraits on CDragon.
#[derive(Serialize)]
pub struct ChampionEntry {
    pub id: String,
    pub wad_path: String,
}

/// Enumerate per-champion WAD files under `<final_path>/Champions/`,
/// excluding sub-mode WADs (Ruby = Arena, Strawberry = Swarm) and any
/// locale-specific variants like `Aatrox.en_US.wad.client` (we only want
/// the canonical base WAD per champion). Does **not** mount anything —
/// the gallery is a pure list view; mounts happen lazily when the user
/// clicks a tile.
#[tauri::command]
pub fn viewer_list_champions(final_path: String) -> Result<Vec<ChampionEntry>, String> {
    let champs_dir = std::path::Path::new(&final_path).join("Champions");
    if !champs_dir.is_dir() {
        return Err(format!(
            "Champions folder not found at {}",
            champs_dir.display()
        ));
    }

    // Sub-mode + non-playable WADs to filter out. Matched case-insensitively
    // against either the whole stem (`Ruby`, `Strawberry`) or as a prefix
    // (`Ruby_Sentinel`, `Strawberry_Briar`, `TFTChampion_*`). All garbage
    // we don't want appearing in the gallery.
    const EXCLUDED_EXACT: &[&str] = &["Ruby", "Strawberry"];
    const EXCLUDED_PREFIXES: &[&str] = &["Ruby_", "Strawberry_", "TFTChampion"];

    let mut entries: Vec<ChampionEntry> = Vec::new();
    let read = std::fs::read_dir(&champs_dir)
        .map_err(|e| format!("Failed to read {}: {}", champs_dir.display(), e))?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        // Match base WADs (`<Champion>.wad.client`) — skip locale variants
        // (`<Champion>.en_US.wad.client`) by requiring no extra dot in the stem.
        let stem = match name.strip_suffix(".wad.client") {
            Some(s) => s,
            None => continue,
        };
        if stem.is_empty() || stem.contains('.') {
            continue;
        }
        let stem_lower = stem.to_ascii_lowercase();
        if EXCLUDED_EXACT
            .iter()
            .any(|x| x.eq_ignore_ascii_case(stem))
        {
            continue;
        }
        if EXCLUDED_PREFIXES
            .iter()
            .any(|p| stem_lower.starts_with(&p.to_ascii_lowercase()))
        {
            continue;
        }
        entries.push(ChampionEntry {
            id: stem.to_string(),
            wad_path: path.to_string_lossy().into_owned(),
        });
    }

    entries.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    Ok(entries)
}

/// Walk a list of candidate Riot install dirs and return the deepest
/// mod-relevant subdirectory found — `<install>/Game/DATA/FINAL` if it
/// exists, the install root otherwise. Pulled out as a helper so the
/// Live and PBE probes don't drift apart.
fn detect_riot_install(candidates: &[&str]) -> Option<String> {
    for path in candidates {
        let p = std::path::Path::new(path);
        if !p.is_dir() {
            continue;
        }
        // Confirm it's a real install — Game folder or League exe.
        if !(p.join("Game").is_dir() || p.join("League of Legends.exe").exists()) {
            continue;
        }
        let final_path = p.join("Game").join("DATA").join("FINAL");
        if final_path.is_dir() {
            return Some(final_path.to_string_lossy().into_owned());
        }
        return Some(path.to_string());
    }
    None
}

// ============================================================
// BIN asset scanner — walks a root BIN plus every dependency BIN
// it references on disk, returning a deduped per-BIN asset list.
// Frontend turns this into a markdown report with the
// `jade-asset-list: true` frontmatter the gallery view keys off.
// ============================================================

#[tauri::command]
pub fn scan_bin_assets(path: String) -> Result<crate::core::bin::asset_scan::BinAssetReport, String> {
    crate::core::bin::asset_scan::scan_bin_assets(std::path::Path::new(&path))
}

// ============================================================
// Troybin → BIN conversion. Reads a `.troybin` / `.inibin` source,
// runs it through the full troybin pipeline (Stage 1-5) to produce
// ritobin text, then compiles the text via `text_to_tree` +
// `write_bin_ltk` to a binary `.bin` file written next to the
// source. Returns the output path so the frontend can open the
// resulting BIN in a regular editor tab.
// ============================================================

#[derive(Serialize)]
pub struct TroybinConvertResult {
    pub output_path: String,
}

/// Convert a single troybin source file to a binary `.bin` written
/// next to the source. Returns the absolute output path.
#[tauri::command]
pub fn troybin_convert_to_bin(path: String) -> Result<TroybinConvertResult, String> {
    crate::core::troybin::values::try_values()
        .map_err(|e| format!("values.json: {e}"))?;
    let output = convert_troybin_to_bin_path(std::path::Path::new(&path))?;
    Ok(TroybinConvertResult {
        output_path: output.to_string_lossy().into_owned(),
    })
}

/// Cut off everything after the BIN structure's final closing brace.
/// Used to drop the "Troygrade was unable to translate the following
/// properties: …" free-text trailer the Python tool appends, which
/// `text_to_tree` rejects as content after the last `}`. Returns the
/// slice up to and including the final `}` followed by its line
/// terminator(s); leaves a stem that's a valid ritobin document.
fn strip_post_bin_trailer(text: &str) -> &str {
    // The closing brace is the last `}` in the document — find it
    // and keep up to the newline that follows. If there's no
    // trailing newline (one-liner BINs would be weird but possible),
    // keep through the brace itself.
    if let Some(brace_idx) = text.rfind('}') {
        // Include any immediately-following \r\n / \n so the
        // text_to_tree input still terminates with a newline.
        let after = brace_idx + 1;
        let bytes = text.as_bytes();
        let mut end = after;
        if end < bytes.len() && bytes[end] == b'\r' { end += 1; }
        if end < bytes.len() && bytes[end] == b'\n' { end += 1; }
        &text[..end]
    } else {
        text
    }
}

/// Run Stages 1-5 and return the ritobin text without any compile
/// or disk side effects.
fn troybin_pipeline_text(input: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(input)
        .map_err(|e| format!("read {}: {}", input.display(), e))?;
    let entries = crate::core::troybin::read_troybin_binary(&bytes)
        .map_err(|e| format!("parse {}: {}", input.display(), e))?;
    let ini = crate::core::troybin::resolve_and_write_ini(&entries);
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("troybin")
        .to_string();
    let mut data = crate::core::troybin::read_troybin(
        "Assets/Particles",
        false,
        &ini,
        &format!("{stem}.txt"),
        true,
    );
    data.emitters = crate::core::troybin::update_emitters(&data.emitters);
    let bin_struct = crate::core::troybin::create_bin(&data, "");
    Ok(crate::core::troybin::write_bin(&bin_struct, ""))
}

/// Shared per-file conversion: troybin → ritobin text → ltk_meta
/// `BinTree` → binary bytes → `<source-dir>/<stem>.bin`. Returns the
/// output path on success.
///
/// On `text_to_tree` failure we write the intermediate text to a
/// sidecar `<stem>.troybin-debug.txt` next to the source so the user
/// can diagnose which line the compiler rejected. The error message
/// references the sidecar path.
fn convert_troybin_to_bin_path(input: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let text = troybin_pipeline_text(input)?;
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("troybin")
        .to_string();

    // The Python tool appends a free-text trailer ("Troygrade was
    // unable to translate the following properties: …") AFTER the
    // closing `}` of the BIN structure. Riot's strict ritobin
    // grammar (which `text_to_tree` implements) rejects anything
    // past the last brace, so strip the trailer before compiling.
    // The trailer stays in the corpus-diff baseline because we
    // didn't change `write_bin` itself.
    let compile_text = strip_post_bin_trailer(&text);
    let tree = match crate::core::bin::text_to_tree(compile_text) {
        Ok(t) => t,
        Err(e) => {
            // Dump the intermediate ritobin text so the user can see
            // which line the compiler rejected — without it the
            // failure reads as opaque "compile error" with no recourse.
            let sidecar = input.with_file_name(format!("{stem}.troybin-debug.txt"));
            let _ = std::fs::write(&sidecar, text.as_bytes());
            return Err(format!(
                "compile {}: {} (intermediate text saved to {})",
                input.display(),
                e,
                sidecar.display()
            ));
        }
    };
    let out_bytes = crate::core::bin::write_bin_ltk(&tree)
        .map_err(|e| format!("write_bin {}: {}", input.display(), e))?;

    let output = input.with_file_name(format!("{stem}.bin"));
    std::fs::write(&output, &out_bytes)
        .map_err(|e| format!("write {}: {}", output.display(), e))?;
    Ok(output)
}

#[derive(Serialize)]
pub struct DeleteFilesResult {
    /// Number of files successfully removed.
    pub deleted: u32,
    /// Per-file failure reasons. Empty on a clean run.
    pub failed: Vec<(String, String)>,
}

/// Delete a batch of files. The frontend (asset gallery's unused-files
/// bulk delete) already resolved each path against the scan report's
/// mod root and asked the user to confirm — we keep the safety bar
/// here by requiring every target to live inside `mod_root` (also passed
/// in) so a stray path can't escape it. Errors are collected per-file
/// rather than failing the whole batch; the UI surfaces the failures
/// so the user can decide what to do with them.
#[tauri::command]
pub fn delete_files(mod_root: String, paths: Vec<String>) -> Result<DeleteFilesResult, String> {
    let root = std::path::Path::new(&mod_root);
    if !root.is_dir() {
        return Err(format!("mod_root is not a directory: {}", mod_root));
    }
    let canonical_root = match root.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("canonicalize mod_root: {}", e)),
    };

    let mut deleted: u32 = 0;
    let mut failed: Vec<(String, String)> = Vec::new();
    for raw in paths {
        let p = std::path::Path::new(&raw);
        // Canonicalize to defeat ".." path traversal. We require the
        // resolved path to live under the canonical mod root before
        // touching it.
        let canonical = match p.canonicalize() {
            Ok(c) => c,
            Err(e) => { failed.push((raw, format!("not found: {}", e))); continue; }
        };
        if !canonical.starts_with(&canonical_root) {
            failed.push((raw, "outside mod root — refused".to_string()));
            continue;
        }
        match std::fs::remove_file(&canonical) {
            Ok(_) => { deleted += 1; }
            Err(e) => { failed.push((raw, e.to_string())); }
        }
    }
    Ok(DeleteFilesResult { deleted, failed })
}
