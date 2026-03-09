/// Extra commands: file association, autostart, updater, SKN reader
use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;
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

/// Register .bin file association in Windows registry (HKCU, no admin needed)
#[tauri::command]
pub async fn register_bin_association() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let exe_path = get_exe_path()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        let (class_key, _) = hkcu
            .create_subkey(r"Software\Classes\JadeBinFile")
            .map_err(|e| format!("Failed to create class key: {}", e))?;
        class_key.set_value("", &"Jade League Bin File")
            .map_err(|e| format!("Failed to set class name: {}", e))?;

        let (icon_key, _) = class_key
            .create_subkey("DefaultIcon")
            .map_err(|e| format!("Failed to create icon key: {}", e))?;
        icon_key.set_value("", &format!("{},0", exe_path))
            .map_err(|e| format!("Failed to set icon: {}", e))?;

        let (cmd_key, _) = class_key
            .create_subkey(r"shell\open\command")
            .map_err(|e| format!("Failed to create command key: {}", e))?;
        cmd_key.set_value("", &format!("\"{}\" \"%1\"", exe_path))
            .map_err(|e| format!("Failed to set open command: {}", e))?;

        let (ext_key, _) = hkcu
            .create_subkey(r"Software\Classes\.bin")
            .map_err(|e| format!("Failed to create .bin key: {}", e))?;
        ext_key.set_value("", &"JadeBinFile")
            .map_err(|e| format!("Failed to set .bin default: {}", e))?;

        notify_shell_change();
        println!("[FileAssoc] Registered .bin association for: {}", exe_path);
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

        if let Ok(ext_key) = hkcu.open_subkey(r"Software\Classes\.bin") {
            let current_val: Result<String, _> = ext_key.get_value("");
            if current_val.ok().as_deref() == Some("JadeBinFile") {
                let _ = hkcu.delete_subkey_all(r"Software\Classes\.bin");
            }
        }
        let _ = hkcu.delete_subkey_all(r"Software\Classes\JadeBinFile");

        notify_shell_change();
        println!("[FileAssoc] Unregistered .bin association");
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

const GITHUB_REPO: &str = "LeagueToolkit/Jade-League-Bin-Editor";
const RELEASES_URL: &str = "https://github.com/LeagueToolkit/Jade-League-Bin-Editor/releases/latest";
const INSTALLER_PATTERN: &str = "_x64-setup.exe";

/// Cached release JSON so we don't hit the API twice (check → download).
static CACHED_RELEASE: Lazy<Mutex<Option<serde_json::Value>>> =
    Lazy::new(|| Mutex::new(None));

/// Holds the path to the downloaded installer so it can be run separately.
static INSTALLER_PATH: Lazy<Mutex<Option<std::path::PathBuf>>> =
    Lazy::new(|| Mutex::new(None));

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
        .build()
        .unwrap_or_default()
}

async fn fetch_latest_release() -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = make_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("GitHub API rate limit reached — try again in a few minutes".to_string());
    }
    if !status.is_success() {
        return Err(format!("GitHub API returned {}", status));
    }

    resp.json().await.map_err(|e| format!("Failed to parse response: {}", e))
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
    // Also clean up the update bat script
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
/// Uses the cached release from check_for_update to avoid a second API call.
#[tauri::command]
pub async fn start_update_download(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use std::io::Write;

    // Use cached release, fall back to fetching if cache is empty
    let json = CACHED_RELEASE.lock().take()
        .ok_or(())
        .or_else(|_| futures::executor::block_on(fetch_latest_release()))?;

    let assets = json["assets"].as_array()
        .ok_or("No assets found in release")?;

    // Match specifically the NSIS x64 setup exe
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

    // Clean up old installers before downloading new one
    cleanup_old_installers(None);

    let resp = make_client()
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    // Stream directly to file instead of buffering in memory
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

    *INSTALLER_PATH.lock() = Some(installer_path);
    Ok(())
}

/// Run the previously downloaded installer.
///
/// - silent=true:  runs NSIS with /S, waits for it to finish, then relaunches Jade.
/// - silent=false: exits Jade first, then launches the installer normally so the
///                 user sees the wizard (which upgrades in-place without uninstalling).
#[tauri::command]
pub async fn run_installer(silent: bool, app: tauri::AppHandle) -> Result<(), String> {
    let path = INSTALLER_PATH.lock().clone()
        .ok_or("No installer has been downloaded yet")?;

    if !path.exists() {
        return Err("Installer file no longer exists on disk".to_string());
    }

    // Resolve the real install directory.
    // If running from a dev/debug build, don't pass /D so the installer
    // uses its own default (or the user's previous install location).
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
:wait\r
tasklist /FI \"IMAGENAME eq jade-rust.exe\" 2>NUL | find /I \"jade-rust.exe\" >NUL\r
if not errorlevel 1 (\r
    echo [%date% %time%] Waiting for Jade to exit... >> \"{log}\"\r
    timeout /t 1 /nobreak >nul\r
    goto wait\r
)\r
echo [%date% %time%] Jade exited, running installer >> \"{log}\"\r
{cmd}\r
echo [%date% %time%] Installer finished with errorlevel %errorlevel% >> \"{log}\"\r
{relaunch}del \"%~f0\"\r
",
        log = log_path.display(),
        cmd = installer_cmd,
        relaunch = relaunch_line,
    );

    std::fs::write(&bat_path, &bat_content)
        .map_err(|e| format!("Failed to write update script: {}", e))?;

    // Use /C with cmd directly — no start, so the script runs in its own process
    std::process::Command::new("cmd")
        .args(["/C", &bat_path.to_string_lossy()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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
    let minor = cur.read_u16::<LittleEndian>()
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
        cur.seek(SeekFrom::Current(16))
            .map_err(|_| "Failed to skip submesh header fields")?;

        // Version >= 4 has an extra u32 field (unique flag / startFace)
        if major >= 4 || (major == 2 && minor == 1) {
            cur.seek(SeekFrom::Current(4))
                .map_err(|_| "Failed to skip extra submesh field")?;
        }

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

    Ok(AutoMaterialResult {
        matches,
        skn_path: skn_resolved,
        unmatched,
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
