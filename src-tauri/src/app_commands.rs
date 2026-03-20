use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::env;
use tauri::Manager;

const ICON_PREF_KEY: &str = "custom_icon_path";
const BUILTIN_ICON_KEY: &str = "builtin_icon";

const BUILTIN_ICON_JADE: &[u8] = include_bytes!("../../public/media/jade.ico");
const BUILTIN_ICON_JADEJADE: &[u8] = include_bytes!("../../public/media/jadejade.ico");
const BUILTIN_ICON_NOBRAIN: &[u8] = include_bytes!("../../public/media/noBrain.ico");

// Default tile PNGs for restoring when icon is cleared
const DEFAULT_SQUARE150: &[u8] = include_bytes!("../icons/Square150x150Logo.png");
const DEFAULT_SQUARE71: &[u8] = include_bytes!("../icons/Square71x71Logo.png");

fn get_builtin_icon_data(name: &str) -> Option<&'static [u8]> {
    match name {
        "jade" => Some(BUILTIN_ICON_JADE),
        "jadejade" => Some(BUILTIN_ICON_JADEJADE),
        "noBrain" => Some(BUILTIN_ICON_NOBRAIN),
        _ => None,
    }
}

/// Update the Start Menu tile PNGs next to the exe so the VisualElementsManifest
/// reflects the current icon. Call this whenever the app icon changes.
#[cfg(target_os = "windows")]
fn update_tile_pngs(icon_path: &str) -> Result<(), String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .parent()
        .ok_or("Failed to get exe directory")?
        .to_path_buf();

    let img = image::open(icon_path)
        .map_err(|e| format!("Failed to open icon for tile: {}", e))?;

    // Check if the current icon is noBrain — it gets minimal padding
    let padding = if let Ok(config_dir) = get_config_dir() {
        let pref_file = config_dir.join("preferences.json");
        pref_file.exists()
            && fs::read_to_string(&pref_file).ok()
                .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                .and_then(|p| p.get(BUILTIN_ICON_KEY)?.as_str().map(|s| s.to_string()))
                .as_deref() == Some("noBrain")
    } else {
        false
    };

    // noBrain: 7px padding, others: ~27px padding on the 150 tile
    let (icon150, icon71) = if padding {
        (150 - 14, 71 - 14)  // 7px padding on each side
    } else {
        (96, 48)             // default: ~64% of tile
    };

    // Resize the icon smaller than the tile and center it on a transparent background
    let save_tile = |tile_size: u32, icon_size: u32, path: std::path::PathBuf| -> Result<(), String> {
        let resized = img.resize_exact(icon_size, icon_size, image::imageops::FilterType::Lanczos3);
        let mut canvas = image::RgbaImage::new(tile_size, tile_size);
        let offset = (tile_size - icon_size) / 2;
        image::imageops::overlay(&mut canvas, &resized.to_rgba8(), offset as i64, offset as i64);
        canvas.save(&path).map_err(|e| format!("Failed to save tile {:?}: {}", path, e))
    };

    save_tile(150, icon150, exe_dir.join("Square150x150Logo.png"))?;
    save_tile(71, icon71, exe_dir.join("Square71x71Logo.png"))?;

    println!("[Icon] Updated Start Menu tile PNGs");
    Ok(())
}

/// Restore the default tile PNGs by rendering the embedded default icon
/// with the same padding as update_tile_pngs uses.
#[cfg(target_os = "windows")]
fn restore_default_tile_pngs() {
    let exe_dir = match std::env::current_exe().map(|p| p.parent().unwrap_or(Path::new(".")).to_path_buf()) {
        Ok(d) => d,
        Err(_) => return,
    };

    // Load the default jade icon from embedded data
    let img = match image::load_from_memory(BUILTIN_ICON_JADE) {
        Ok(i) => i,
        Err(_) => {
            // Fallback: write the original embedded PNGs
            let _ = fs::write(exe_dir.join("Square150x150Logo.png"), DEFAULT_SQUARE150);
            let _ = fs::write(exe_dir.join("Square71x71Logo.png"), DEFAULT_SQUARE71);
            return;
        }
    };

    let save_tile = |tile_size: u32, icon_size: u32, path: std::path::PathBuf| {
        let resized = img.resize_exact(icon_size, icon_size, image::imageops::FilterType::Lanczos3);
        let mut canvas = image::RgbaImage::new(tile_size, tile_size);
        let offset = (tile_size - icon_size) / 2;
        image::imageops::overlay(&mut canvas, &resized.to_rgba8(), offset as i64, offset as i64);
        let _ = canvas.save(&path);
    };

    save_tile(150, 96, exe_dir.join("Square150x150Logo.png"));
    save_tile(71, 48, exe_dir.join("Square71x71Logo.png"));
    println!("[Icon] Restored default Start Menu tile PNGs");
}

/// Get the custom config directory: AppData\Roaming\LeagueToolkit\Jade
pub fn get_config_dir() -> Result<PathBuf, String> {
    let appdata = env::var("APPDATA").map_err(|e| format!("Failed to get APPDATA: {}", e))?;
    let path = PathBuf::from(appdata).join("LeagueToolkit").join("Jade");
    
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    Ok(path)
}

/// Migrate preferences from old txt format to new JSON format
fn migrate_txt_to_json(txt_path: &Path, json_path: &Path) -> Result<(), String> {
    println!("[Migrate] Reading old preferences.txt from {:?}", txt_path);
    
    let content = fs::read_to_string(txt_path)
        .map_err(|e| format!("Failed to read preferences.txt: {}", e))?;
    
    let mut json_prefs = serde_json::json!({});
    
    // Parse the txt file - assuming key=value format, one per line
    for line in content.lines() {
        let line = line.trim();
        
        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        
        // Parse key=value
        if let Some(eq_pos) = line.find('=') {
            let key = line[..eq_pos].trim();
            let value = line[eq_pos + 1..].trim();
            
            // Store as string in JSON
            json_prefs[key] = serde_json::Value::String(value.to_string());
            println!("[Migrate] Migrated: {} = {}", key, value);
        }
    }
    
    // Write to JSON file
    let json_content = serde_json::to_string_pretty(&json_prefs)
        .map_err(|e| format!("Failed to serialize to JSON: {}", e))?;
    
    write_file_atomic(json_path, &json_content)
        .map_err(|e| format!("Failed to write JSON: {}", e))?;
    
    println!("[Migrate] Successfully migrated {} preferences to JSON", json_prefs.as_object().map(|o| o.len()).unwrap_or(0));
    
    Ok(())
}

/// Migrate preferences from old locations to new LeagueToolkit\Jade\preferences.json
pub fn migrate_preferences_if_needed(app: &tauri::AppHandle) -> Result<(), String> {
    let new_config_dir = get_config_dir()?;
    let new_pref_json = new_config_dir.join("preferences.json");
    let old_pref_txt = new_config_dir.join("preferences.txt");
    
    // Priority 1: If new JSON already exists, check if we should merge txt into it
    if new_pref_json.exists() {
        println!("[Migrate] New preferences.json already exists at {:?}", new_pref_json);
        
        // Check if old txt file exists and has content we should merge
        if old_pref_txt.exists() {
            println!("[Migrate] Found preferences.txt, checking if merge needed");
            
            // Read existing JSON
            let json_content = fs::read_to_string(&new_pref_json)
                .map_err(|e| format!("Failed to read existing JSON: {}", e))?;
            
            let mut json_prefs: serde_json::Value = serde_json::from_str(&json_content)
                .unwrap_or_else(|_| serde_json::json!({}));
            
            // Read txt file
            let txt_content = fs::read_to_string(&old_pref_txt)
                .map_err(|e| format!("Failed to read txt: {}", e))?;
            
            let mut merged_count = 0;
            
            // Merge txt preferences that don't exist in JSON
            for line in txt_content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
                    continue;
                }
                
                if let Some(eq_pos) = line.find('=') {
                    let key = line[..eq_pos].trim();
                    let value = line[eq_pos + 1..].trim();
                    
                    // Only add if key doesn't exist in JSON
                    if json_prefs.get(key).is_none() {
                        json_prefs[key] = serde_json::Value::String(value.to_string());
                        merged_count += 1;
                        println!("[Migrate] Merged from txt: {} = {}", key, value);
                    }
                }
            }
            
            if merged_count > 0 {
                // Write updated JSON
                let content = serde_json::to_string_pretty(&json_prefs)
                    .map_err(|e| format!("Failed to serialize: {}", e))?;
                write_file_atomic(&new_pref_json, &content)
                    .map_err(|e| format!("Failed to write merged JSON: {}", e))?;
                println!("[Migrate] Merged {} preferences from txt to JSON", merged_count);
            }
            
            // Backup and remove old txt file
            let backup_path = old_pref_txt.with_extension("txt.backup");
            let _ = fs::rename(&old_pref_txt, &backup_path);
            println!("[Migrate] Backed up preferences.txt to {:?}", backup_path);
        }
        
        return Ok(());
    }
    
    // Priority 2: Check for old preferences.txt in the same folder
    if old_pref_txt.exists() {
        println!("[Migrate] Found preferences.txt, converting to JSON");
        migrate_txt_to_json(&old_pref_txt, &new_pref_json)?;
        
        // Backup and remove old txt file
        let backup_path = old_pref_txt.with_extension("txt.backup");
        let _ = fs::rename(&old_pref_txt, &backup_path);
        println!("[Migrate] Backed up old preferences.txt to {:?}", backup_path);
        
        return Ok(());
    }
    
    // Priority 3: Check for old JSON in Tauri default location
    if let Ok(old_config_dir) = app.path().app_config_dir() {
        let old_pref_json = old_config_dir.join("preferences.json");
        
        if old_pref_json.exists() {
            println!("[Migrate] Found old JSON preferences at {:?}, migrating to {:?}", old_pref_json, new_pref_json);
            
            // Copy the old preferences to new location
            match fs::copy(&old_pref_json, &new_pref_json) {
                Ok(_) => {
                    println!("[Migrate] Successfully migrated JSON preferences");
                    // Remove old file
                    let _ = fs::remove_file(&old_pref_json);
                    println!("[Migrate] Removed old JSON file");
                }
                Err(e) => {
                    eprintln!("[Migrate] Failed to copy preferences: {}", e);
                }
            }
            
            return Ok(());
        }
    }
    
    println!("[Migrate] No old preferences found to migrate");
    Ok(())
}

/// Write content to file atomically to prevent corruption.
///
/// On Windows `std::fs::rename` cannot overwrite an existing file, so we
/// use the Win32 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` which performs
/// an atomic replace.  The old delete-then-rename approach had a window
/// where the target file didn't exist — if the process was killed in that
/// gap (e.g. `app.exit(0)` during a silent update) the file was lost.
fn write_file_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    // Ensure parent directory exists (defensive: get_config_dir should already do this,
    // but guard against races or first-run situations)
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Write to a temporary file first
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, content)?;

    // Atomically replace the target file
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
        use windows::core::PCWSTR;

        let src: Vec<u16> = temp_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let dst: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

        unsafe {
            MoveFileExW(PCWSTR(src.as_ptr()), PCWSTR(dst.as_ptr()), MOVEFILE_REPLACE_EXISTING)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("MoveFileExW failed: {}", e)))?;
        }
    }

    #[cfg(not(windows))]
    {
        fs::rename(&temp_path, path)?;
    }

    Ok(())
}

/// If a previous write was interrupted, the `.tmp` sidecar may contain valid
/// data while the main file is missing or corrupt.  Call this once on startup.
pub fn recover_preferences_if_needed() {
    if let Ok(config_dir) = get_config_dir() {
        let pref_file = config_dir.join("preferences.json");
        let temp_file = config_dir.join("preferences.tmp");

        if temp_file.exists() && !pref_file.exists() {
            // The main file was deleted but the temp was never promoted — recover.
            eprintln!("[Prefs] Recovering preferences from leftover .tmp file");
            if let Err(e) = fs::rename(&temp_file, &pref_file) {
                eprintln!("[Prefs] Failed to recover from .tmp: {}", e);
            }
        } else if temp_file.exists() {
            // Main file exists; the .tmp is stale — clean it up.
            let _ = fs::remove_file(&temp_file);
        }
    }
}

const LAST_VERSION_KEY: &str = "last_app_version";

/// Compare the running app version against the one stored in preferences.
/// If they differ (i.e. first launch after an update), stamp the new version
/// and return `true` so callers can run post-update fixups.
pub fn check_and_stamp_version() -> bool {
    let current = env!("CARGO_PKG_VERSION");

    let config_dir = match get_config_dir() {
        Ok(d) => d,
        Err(_) => return false,
    };
    let pref_file = config_dir.join("preferences.json");

    let mut prefs: serde_json::Value = if pref_file.exists() {
        fs::read_to_string(&pref_file)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let stored = prefs.get(LAST_VERSION_KEY)
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if stored == current {
        return false;
    }

    println!("[Setup] Version changed: {:?} -> {:?}, running post-update fixups", stored, current);
    prefs[LAST_VERSION_KEY] = serde_json::Value::String(current.to_string());

    if let Ok(content) = serde_json::to_string_pretty(&prefs) {
        let _ = write_file_atomic(&pref_file, &content);
    }

    true
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub author: String,
}

#[tauri::command]
pub async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn get_custom_icon_path(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(None);
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting custom icon: {}. Returning None.", e);
            return Ok(None);
        }
    };
    
    Ok(prefs.get(ICON_PREF_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

#[tauri::command]
pub async fn get_custom_icon_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let icon_path = get_custom_icon_path(app.clone()).await?;
    
    if let Some(path) = icon_path {
        // Read the icon file and convert to base64 data URL
        let icon_data = fs::read(&path)
            .map_err(|e| format!("Failed to read icon file: {}", e))?;
        
        // Determine MIME type based on file extension
        let mime_type = if path.to_lowercase().ends_with(".png") {
            "image/png"
        } else if path.to_lowercase().ends_with(".ico") {
            "image/x-icon"
        } else if path.to_lowercase().ends_with(".jpg") || path.to_lowercase().ends_with(".jpeg") {
            "image/jpeg"
        } else {
            "image/png" // default
        };
        
        // Convert to base64
        let base64_data = base64_encode(&icon_data);
        let data_url = format!("data:{};base64,{}", mime_type, base64_data);
        
        Ok(Some(data_url))
    } else {
        Ok(None)
    }
}

fn base64_encode(data: &[u8]) -> String {
    use base64::{Engine as _, engine::general_purpose};
    general_purpose::STANDARD.encode(data)
}

#[tauri::command]
pub async fn set_custom_icon(app: tauri::AppHandle, icon_path: String) -> Result<(), String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    
    // Read existing preferences or create new
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    // Update icon path and remove builtin selection
    prefs[ICON_PREF_KEY] = serde_json::Value::String(icon_path.clone());
    prefs.as_object_mut().map(|obj| obj.remove(BUILTIN_ICON_KEY));

    // Write back atomically
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;

    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;

    // Update window icon immediately
    update_window_icon(&app, &icon_path)?;

    // Update file association icon if registered
    #[cfg(windows)]
    crate::extra_commands::update_association_icon();

    Ok(())
}

pub fn update_window_icon(app: &tauri::AppHandle, icon_path: &str) -> Result<(), String> {
    // Load and decode the image
    let img = image::open(icon_path)
        .map_err(|e| format!("Failed to load icon image: {}", e))?;

    // Convert to RGBA8
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let rgba_data = rgba.into_raw();

    // Create Tauri Image
    let icon = tauri::image::Image::new_owned(rgba_data, width, height);

    // Update the Start Menu shortcut icon FIRST so the taskbar picks it up on refresh
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = update_shortcut_icon(Some(icon_path)) {
            eprintln!("[Icon] Failed to update shortcut icon: {}", e);
        }
        if let Err(e) = update_tile_pngs(icon_path) {
            eprintln!("[Icon] Failed to update tile PNGs: {}", e);
        }
    }

    // Update all windows
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon.clone())
            .map_err(|e| format!("Failed to set window icon: {}", e))?;

        // Also set the icon via Win32 API and refresh the taskbar
        #[cfg(target_os = "windows")]
        {
            if let Err(e) = set_native_window_icon(&window, icon_path) {
                eprintln!("[Icon] Failed to set native taskbar icon: {}", e);
            }
        }
    }

    // Update tray icon
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(icon));
    }

    Ok(())
}

/// Update the Start Menu shortcut's icon so the taskbar reflects the custom icon.
/// When installed via NSIS, Windows uses the shortcut's icon (tied to the AppUserModelID)
/// for the taskbar, ignoring WM_SETICON.
#[cfg(target_os = "windows")]
fn update_shortcut_icon(icon_path: Option<&str>) -> Result<(), String> {
    // Find the Start Menu shortcut
    let appdata = env::var("APPDATA").map_err(|e| format!("No APPDATA: {}", e))?;
    let shortcut_path = PathBuf::from(&appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Jade.lnk");

    if !shortcut_path.exists() {
        // Try with subfolder
        let alt_path = PathBuf::from(&appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Jade")
            .join("Jade.lnk");
        if !alt_path.exists() {
            println!("[Icon] No Start Menu shortcut found, skipping shortcut icon update");
            return Ok(());
        }
        return update_shortcut_icon_at(&alt_path, icon_path);
    }

    update_shortcut_icon_at(&shortcut_path, icon_path)
}

#[cfg(target_os = "windows")]
fn update_shortcut_icon_at(shortcut_path: &Path, icon_path: Option<&str>) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, Interface};
    use windows::Win32::UI::Shell::*;
    use windows::Win32::System::Com::*;

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // Create IShellLink instance
        let shell_link: IShellLinkW = CoCreateInstance(
            &ShellLink,
            None,
            CLSCTX_INPROC_SERVER,
        ).map_err(|e| format!("CoCreateInstance(ShellLink) failed: {}", e))?;

        // Load existing shortcut via IPersistFile
        let persist_file: IPersistFile = shell_link.cast()
            .map_err(|e| format!("QueryInterface(IPersistFile) failed: {}", e))?;

        let shortcut_wide = to_wide(&shortcut_path.to_string_lossy());
        persist_file.Load(PCWSTR(shortcut_wide.as_ptr()), STGM_READWRITE)
            .map_err(|e| format!("IPersistFile::Load failed: {}", e))?;

        // Set or clear the icon
        match icon_path {
            Some(path) => {
                // Convert the custom image to .ico and save it
                let ico_path = get_config_dir()?.join("custom_icon.ico");
                save_as_ico(path, &ico_path)?;

                let ico_wide = to_wide(&ico_path.to_string_lossy());
                shell_link.SetIconLocation(PCWSTR(ico_wide.as_ptr()), 0)
                    .map_err(|e| format!("SetIconLocation failed: {}", e))?;
            }
            None => {
                // Restore: point back to the exe's embedded icon (index 0)
                let exe_path = std::env::current_exe()
                    .map_err(|e| format!("current_exe failed: {}", e))?;
                let exe_wide = to_wide(&exe_path.to_string_lossy());
                shell_link.SetIconLocation(PCWSTR(exe_wide.as_ptr()), 0)
                    .map_err(|e| format!("SetIconLocation failed: {}", e))?;
            }
        }

        // Save the shortcut
        persist_file.Save(PCWSTR(shortcut_wide.as_ptr()), true)
            .map_err(|e| format!("IPersistFile::Save failed: {}", e))?;

        println!("[Icon] Updated shortcut icon at {:?}", shortcut_path);
    }

    Ok(())
}

/// Re-apply tile PNGs and Start Menu shortcut icon from a saved custom icon.
/// Called on startup to undo the NSIS installer overwriting these with defaults.
#[cfg(target_os = "windows")]
pub fn reapply_tile_and_shortcut_icon(icon_path: &str) -> Result<(), String> {
    update_tile_pngs(icon_path)?;
    update_shortcut_icon(Some(icon_path))?;
    println!("[Icon] Restored Start Menu tiles and shortcut icon on startup");
    Ok(())
}

/// Convert an image to .ico format and save it
#[cfg(target_os = "windows")]
fn save_as_ico(src_path: &str, ico_path: &Path) -> Result<(), String> {
    let img = image::open(src_path)
        .map_err(|e| format!("Failed to open image for ico conversion: {}", e))?;

    // Resize to 256x256 (max ico size)
    let resized = img.resize_exact(256, 256, image::imageops::FilterType::Lanczos3);
    let rgba = resized.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let raw = rgba.into_raw();

    // Write ICO file manually: header + one directory entry + PNG data
    let mut png_data = Vec::new();
    {
        use std::io::Cursor;
        use image::ImageEncoder;
        let mut cursor = Cursor::new(&mut png_data);
        let encoder = image::codecs::png::PngEncoder::new(&mut cursor);
        encoder.write_image(&raw, w, h, image::ExtendedColorType::Rgba8)
            .map_err(|e| format!("PNG encode failed: {}", e))?;
    }

    let mut ico = Vec::new();
    // ICO header: reserved(2) + type(2) + count(2)
    ico.extend_from_slice(&[0, 0]); // reserved
    ico.extend_from_slice(&1u16.to_le_bytes()); // type = 1 (icon)
    ico.extend_from_slice(&1u16.to_le_bytes()); // count = 1

    // Directory entry (16 bytes)
    ico.push(0); // width (0 = 256)
    ico.push(0); // height (0 = 256)
    ico.push(0); // color palette
    ico.push(0); // reserved
    ico.extend_from_slice(&1u16.to_le_bytes()); // color planes
    ico.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    ico.extend_from_slice(&(png_data.len() as u32).to_le_bytes()); // image size
    ico.extend_from_slice(&22u32.to_le_bytes()); // offset (6 header + 16 entry = 22)

    // Image data (PNG)
    ico.extend_from_slice(&png_data);

    fs::write(ico_path, ico)
        .map_err(|e| format!("Failed to write ico file: {}", e))?;

    Ok(())
}

/// Force the taskbar to refresh this window's icon by hiding and re-showing
/// the window. This forces Explorer to drop and recreate the taskbar button,
/// picking up the updated shortcut icon.
#[cfg(target_os = "windows")]
fn refresh_taskbar_icon(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::*;

    unsafe {
        // Hide the window — Explorer removes the taskbar button
        ShowWindow(hwnd, SW_HIDE);

        // Brief pause so Explorer processes the removal
        std::thread::sleep(std::time::Duration::from_millis(200));

        // Show it again — Explorer creates a fresh taskbar button with the current icon
        ShowWindow(hwnd, SW_SHOW);

        println!("[Icon] Refreshed taskbar icon via hide/show");
    }
}

/// Use Win32 API to explicitly set ICON_BIG (taskbar) and ICON_SMALL (title bar).
/// Tauri's set_icon may not update the taskbar icon in release builds on Windows.
#[cfg(target_os = "windows")]
pub fn set_native_window_icon(window: &tauri::WebviewWindow, icon_path: &str) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::Foundation::*;

    let img = image::open(icon_path)
        .map_err(|e| format!("Failed to load icon: {}", e))?;

    let hwnd = window.hwnd().map_err(|e| format!("Failed to get HWND: {}", e))?;
    let hwnd = HWND(hwnd.0);

    // Create and set big icon (used by taskbar, Alt+Tab)
    let big_size = unsafe { GetSystemMetrics(SM_CXICON) } as u32;
    let big_img = img.resize_exact(big_size, big_size, image::imageops::FilterType::Lanczos3).to_rgba8();
    let big_icon = create_hicon_from_rgba(&big_img, big_size, big_size)?;
    unsafe {
        SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_BIG as usize), LPARAM(big_icon.0 as isize));
    }

    // Create and set small icon (used by title bar)
    let small_size = unsafe { GetSystemMetrics(SM_CXSMICON) } as u32;
    let small_img = img.resize_exact(small_size, small_size, image::imageops::FilterType::Lanczos3).to_rgba8();
    let small_icon = create_hicon_from_rgba(&small_img, small_size, small_size)?;
    unsafe {
        SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_SMALL as usize), LPARAM(small_icon.0 as isize));
    }

    // Force taskbar to pick up the new icon (works around AUMID caching)
    refresh_taskbar_icon(hwnd);

    Ok(())
}

#[cfg(target_os = "windows")]
fn create_hicon_from_rgba(rgba: &image::RgbaImage, width: u32, height: u32) -> Result<windows::Win32::UI::WindowsAndMessaging::HICON, String> {
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::Graphics::Gdi::*;

    // Convert RGBA to BGRA (Windows bitmap format), flipped vertically (bottom-up)
    let mut bgra: Vec<u8> = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let pixel = rgba.get_pixel(x, y);
            let dst_idx = ((y * width + x) * 4) as usize;
            bgra[dst_idx] = pixel[2];     // B
            bgra[dst_idx + 1] = pixel[1]; // G
            bgra[dst_idx + 2] = pixel[0]; // R
            bgra[dst_idx + 3] = pixel[3]; // A
        }
    }

    unsafe {
        let color_bitmap = CreateBitmap(width as i32, height as i32, 1, 32, Some(bgra.as_ptr() as *const _));
        let mask_data = vec![0u8; ((width + 7) / 8 * height) as usize];
        let mask_bitmap = CreateBitmap(width as i32, height as i32, 1, 1, Some(mask_data.as_ptr() as *const _));

        let icon_info = ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask_bitmap,
            hbmColor: color_bitmap,
        };

        let hicon = CreateIconIndirect(&icon_info)
            .map_err(|e| format!("CreateIconIndirect failed: {}", e))?;

        let _ = DeleteObject(color_bitmap);
        let _ = DeleteObject(mask_bitmap);

        Ok(hicon)
    }
}

/// Restore the default icon via Win32 API using Tauri's embedded default icon data
#[cfg(target_os = "windows")]
fn restore_native_default_icon(window: &tauri::WebviewWindow, app: &tauri::AppHandle) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::Foundation::*;

    let default_icon = app.default_window_icon()
        .ok_or("No default window icon found")?;

    let rgba_data = default_icon.rgba();
    let width = default_icon.width();
    let height = default_icon.height();

    let rgba_img = image::RgbaImage::from_raw(width, height, rgba_data.to_vec())
        .ok_or("Failed to create image from default icon data")?;

    let hwnd = window.hwnd().map_err(|e| format!("Failed to get HWND: {}", e))?;
    let hwnd = HWND(hwnd.0);

    let big_size = unsafe { GetSystemMetrics(SM_CXICON) } as u32;
    let big_img = image::imageops::resize(&rgba_img, big_size, big_size, image::imageops::FilterType::Lanczos3);
    let big_icon = create_hicon_from_rgba(&big_img, big_size, big_size)?;
    unsafe {
        SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_BIG as usize), LPARAM(big_icon.0 as isize));
    }

    let small_size = unsafe { GetSystemMetrics(SM_CXSMICON) } as u32;
    let small_img = image::imageops::resize(&rgba_img, small_size, small_size, image::imageops::FilterType::Lanczos3);
    let small_icon = create_hicon_from_rgba(&small_img, small_size, small_size)?;
    unsafe {
        SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_SMALL as usize), LPARAM(small_icon.0 as isize));
    }

    // Force taskbar to pick up the restored icon
    refresh_taskbar_icon(hwnd);

    Ok(())
}

#[tauri::command]
pub async fn clear_custom_icon(app: tauri::AppHandle) -> Result<(), String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");

    if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        let mut prefs: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
        prefs.as_object_mut().map(|obj| {
            obj.remove(ICON_PREF_KEY);
            obj.remove(BUILTIN_ICON_KEY);
        });
        let content = serde_json::to_string_pretty(&prefs)
            .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
        write_file_atomic(&pref_file, &content)
            .map_err(|e| format!("Failed to write preferences: {}", e))?;
    }

    // Clean up custom/builtin icon .ico files from config dir
    let _ = fs::remove_file(config_dir.join("custom_icon.ico"));

    // Restore the Start Menu shortcut icon and tile PNGs
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = update_shortcut_icon(None) {
            eprintln!("[Icon] Failed to restore shortcut icon: {}", e);
        }
        restore_default_tile_pngs();
    }

    // Restore default window icon + taskbar refresh
    if let Some(icon) = app.default_window_icon().cloned() {
        if let Some(window) = app.get_webview_window("main") {
            window.set_icon(icon.clone())
                .map_err(|e| format!("Failed to restore default icon: {}", e))?;

            #[cfg(target_os = "windows")]
            {
                if let Err(e) = restore_native_default_icon(&window, &app) {
                    eprintln!("[Icon] Failed to restore native taskbar icon: {}", e);
                }
            }
        }

        // Restore tray icon to default
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(Some(icon));
        }
    }

    // Update file association icon if registered
    #[cfg(windows)]
    crate::extra_commands::update_association_icon();

    Ok(())
}

#[tauri::command]
pub async fn set_builtin_icon(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let icon_data = get_builtin_icon_data(&name)
        .ok_or_else(|| format!("Unknown builtin icon: {}", name))?;

    // Write the embedded icon to the config directory
    let config_dir = get_config_dir()?;
    let icon_path = config_dir.join(format!("builtin_{}.ico", name));
    fs::write(&icon_path, icon_data)
        .map_err(|e| format!("Failed to write builtin icon: {}", e))?;

    let icon_path_str = icon_path.to_string_lossy().to_string();

    // Update preferences: set both custom_icon_path (so the icon system picks it up)
    // and builtin_icon (so the frontend knows which builtin is selected)
    let pref_file = config_dir.join("preferences.json");
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    prefs[ICON_PREF_KEY] = serde_json::Value::String(icon_path_str.clone());
    prefs[BUILTIN_ICON_KEY] = serde_json::Value::String(name);

    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;

    // Apply the icon
    update_window_icon(&app, &icon_path_str)?;

    // Update file association icon if registered
    #[cfg(windows)]
    crate::extra_commands::update_association_icon();

    Ok(())
}

#[tauri::command]
pub async fn get_builtin_icon_name(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");

    if !pref_file.exists() {
        // No preferences at all — default is jade
        return Ok(Some("jade".to_string()));
    }

    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(Some("jade".to_string())),
    };

    // If there's a custom icon path but no builtin_icon key, it's a custom icon
    if prefs.get(ICON_PREF_KEY).is_some() && prefs.get(BUILTIN_ICON_KEY).is_none() {
        return Ok(None);
    }

    // Return the builtin icon name, defaulting to "jade"
    Ok(Some(
        prefs.get(BUILTIN_ICON_KEY)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "jade".to_string())
    ))
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    opener::open(url)
        .map_err(|e| format!("Failed to open URL: {}", e))
}

#[tauri::command]
pub async fn get_preferences_path(_app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    Ok(pref_file.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_preferences_folder(_app: tauri::AppHandle) -> Result<(), String> {
    let config_dir = get_config_dir()?;
    opener::open(config_dir)
        .map_err(|e| format!("Failed to open config folder: {}", e))
}

#[tauri::command]
pub async fn get_all_preferences(_app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(serde_json::json!({}));
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse preferences: {}", e))?;
    
    Ok(prefs)
}

const WINDOW_STATE_KEY: &str = "window_state";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

#[tauri::command]
pub async fn save_window_state(_app: tauri::AppHandle, state: WindowState) -> Result<(), String> {
    println!("[WindowState] Saving: {:?}", state);
    
    // Ensure minimum window size (default is 800x600)
    const MIN_WIDTH: f64 = 800.0;
    const MIN_HEIGHT: f64 = 600.0;
    
    let mut validated_state = state.clone();
    
    if validated_state.width < MIN_WIDTH {
        println!("[WindowState] Width {} is too small, enforcing minimum {}", validated_state.width, MIN_WIDTH);
        validated_state.width = MIN_WIDTH;
    }
    
    if validated_state.height < MIN_HEIGHT {
        println!("[WindowState] Height {} is too small, enforcing minimum {}", validated_state.height, MIN_HEIGHT);
        validated_state.height = MIN_HEIGHT;
    }
    
    // Validate position - don't save if it's the minimized position or way off-screen
    // Windows uses -32000 for minimized windows
    let position_valid = validated_state.x > -10000 && validated_state.y > -10000 
                        && validated_state.x < 10000 && validated_state.y < 10000;
    
    if !position_valid {
        println!("[WindowState] Position ({}, {}) is invalid (likely minimized or off-screen), will not save this state", 
                 validated_state.x, validated_state.y);
        // Don't save invalid positions
        return Ok(());
    }
    
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    println!("[WindowState] Preferences file: {:?}", pref_file);
    
    // Read existing preferences or create new
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    // Update window state with validated dimensions
    prefs[WINDOW_STATE_KEY] = serde_json::to_value(validated_state.clone())
        .map_err(|e| format!("Failed to serialize window state: {}", e))?;
    
    // Write back atomically
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;
    
    println!("[WindowState] Successfully saved window state");
    Ok(())
}

#[tauri::command]
pub async fn get_window_state(_app: tauri::AppHandle) -> Result<Option<WindowState>, String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    println!("[WindowState] Reading from: {:?}", pref_file);
    
    if !pref_file.exists() {
        println!("[WindowState] Preferences file doesn't exist");
        return Ok(None);
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting window state: {}. Returning None.", e);
            return Ok(None);
        }
    };
    
    let state = prefs.get(WINDOW_STATE_KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    
    println!("[WindowState] Loaded state: {:?}", state);
    Ok(state)
}

#[tauri::command]
pub async fn get_preference(_app: tauri::AppHandle, key: String, default_value: String) -> Result<String, String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(default_value);
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting '{}': {}. Using default value.", key, e);
            // Return default instead of failing
            return Ok(default_value);
        }
    };
    
    let value = prefs.get(&key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_value.clone());
    
    Ok(value)
}

#[tauri::command]
pub async fn set_preference(_app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    
    // Read existing preferences or create new
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    // Update preference
    prefs[key.clone()] = serde_json::Value::String(value.clone());
    
    // Write back atomically
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;
    
    Ok(())
}

const RECENT_FILES_KEY: &str = "recent_files";
const MAX_RECENT_FILES: usize = 10;

#[tauri::command]
pub async fn get_recent_files(_app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(Vec::new());
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting recent files: {}. Returning empty list.", e);
            return Ok(Vec::new());
        }
    };
    
    Ok(prefs.get(RECENT_FILES_KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn add_recent_file(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut recent = get_recent_files(app.clone()).await?;
    
    // Remove if already exists
    recent.retain(|p| p.to_lowercase() != path.to_lowercase());
    
    // Add to front
    recent.insert(0, path);
    
    // Keep only MAX_RECENT_FILES
    recent.truncate(MAX_RECENT_FILES);
    
    // Save back
    let config_dir = get_config_dir()?;
    let pref_file = config_dir.join("preferences.json");
    
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    prefs[RECENT_FILES_KEY] = serde_json::to_value(&recent)
        .map_err(|e| format!("Failed to serialize recent files: {}", e))?;
    
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;
    
    Ok(recent)
}

/// Return the last-modified timestamp (milliseconds since Unix epoch) for a file.
/// Used by the texture preview tab to detect external edits.
#[tauri::command]
pub async fn get_file_mtime(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path)
        .map_err(|e| format!("Cannot stat '{}': {}", path, e))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("Cannot read mtime: {}", e))?;
    let millis = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(millis)
}

/// Read a binary file and return its contents as a base64-encoded string.
#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path)
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes))
}

/// Given the path of the currently open file and a relative asset path (e.g.
/// "ASSETS/Characters/Ahri/...tex"), walk up the directory tree of the open
/// file looking for a parent that contains the asset and return the first
/// resolved absolute path that actually exists.
#[tauri::command]
pub async fn resolve_asset_path(base_file: String, asset_path: String) -> Result<Option<String>, String> {
    // Normalise to forward slashes for uniform handling
    let asset_norm = asset_path.replace('\\', "/");

    // 1. If the asset path is already absolute, check directly.
    let as_path = std::path::Path::new(&asset_norm);
    if as_path.is_absolute() {
        return Ok(if as_path.exists() { Some(asset_norm) } else { None });
    }

    let base = std::path::Path::new(&base_file);
    let start_dir = if base.is_file() {
        base.parent().map(|p| p.to_path_buf())
    } else {
        Some(base.to_path_buf())
    };

    // 2. Smart resolve: if the asset path has a known prefix (e.g. "ASSETS/Characters/Talon/..."),
    //    look for the prefix root in the ancestor directories. This avoids joining the full
    //    relative path at every level and instead finds the correct root in one shot.
    let asset_parts: Vec<&str> = asset_norm.split('/').collect();
    if let (Some(dir), Some(first_segment)) = (&start_dir, asset_parts.first()) {
        // Walk up looking for a directory that contains the first segment of the asset path
        let mut d = Some(dir.as_path());
        while let Some(current) = d {
            let candidate = current.join(&asset_norm);
            if candidate.exists() {
                return Ok(Some(candidate.to_string_lossy().replace('\\', "/")));
            }
            // Optimisation: if this directory contains the first segment as a child dir,
            // and the full path doesn't exist, the asset isn't here — stop early.
            let first_child = current.join(first_segment);
            if first_child.is_dir() {
                // The root is right but the specific file doesn't exist under it.
                // No point walking further up.
                return Ok(None);
            }
            d = current.parent();
        }
    }

    // 3. Fallback: simple walk up (for paths without directory prefixes, e.g. just "foo.tex")
    let mut dir = start_dir;
    while let Some(d) = dir {
        let candidate = d.join(&asset_norm);
        if candidate.exists() {
            return Ok(Some(candidate.to_string_lossy().replace('\\', "/")));
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }

    Ok(None)
}

// ─────────────────────────────────────────────────────────────────────────────
// Image editor detection + launch
// ─────────────────────────────────────────────────────────────────────────────

/// Try a list of candidate paths; return the first one that exists.
fn find_exe(candidates: &[&str]) -> Option<String> {
    for c in candidates {
        if !c.is_empty() && std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

/// Look up an App Paths entry in HKLM (Windows only).
#[cfg(windows)]
fn find_exe_via_registry(app_paths_key: &str) -> Option<String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let variants = [
        format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{}", app_paths_key),
        format!(r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{}", app_paths_key),
    ];
    for path in &variants {
        if let Ok(key) = hklm.open_subkey(path) {
            if let Ok(exe) = key.get_value::<String, _>("") {
                if std::path::Path::new(&exe).exists() {
                    return Some(exe);
                }
            }
        }
    }
    None
}

fn locate_paintnet() -> Option<String> {
    let r = find_exe(&[
        r"C:\Program Files\paint.net\paintdotnet.exe",
        r"C:\Program Files\paint.net\PaintDotNet.exe",
        r"C:\Program Files (x86)\paint.net\paintdotnet.exe",
        r"C:\Program Files (x86)\paint.net\PaintDotNet.exe",
    ]);
    if r.is_some() { return r; }
    #[cfg(windows)] { find_exe_via_registry("PaintDotNet.exe") }
    #[cfg(not(windows))] { None }
}

fn locate_photoshop() -> Option<String> {
    // Try common Adobe install paths (newest versions first)
    let common_bases = [
        r"C:\Program Files\Adobe",
        r"C:\Program Files (x86)\Adobe",
    ];
    for base in &common_bases {
        if let Ok(entries) = std::fs::read_dir(base) {
            let mut dirs: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name();
                    let n = name.to_string_lossy().to_lowercase();
                    n.starts_with("adobe photoshop")
                })
                .collect();
            // Sort descending so newest version is first
            dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
            for dir in dirs {
                let exe = dir.path().join("Photoshop.exe");
                if exe.exists() {
                    return Some(exe.to_string_lossy().into_owned());
                }
            }
        }
    }
    #[cfg(windows)] { find_exe_via_registry("Photoshop.exe") }
    #[cfg(not(windows))] { None }
}

fn locate_gimp() -> Option<String> {
    let r = find_exe(&[
        r"C:\Program Files\GIMP 3\bin\gimp-3.0.exe",
        r"C:\Program Files\GIMP 2\bin\gimp-2.10.exe",
        r"C:\Program Files\GIMP 2\bin\gimp-2.0.exe",
        r"C:\Program Files (x86)\GIMP 2\bin\gimp-2.10.exe",
    ]);
    if r.is_some() { return r; }
    // Try registry
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let search_keys = [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\GIMP_is1",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\GIMP_is1",
        ];
        for key_path in &search_keys {
            if let Ok(key) = hklm.open_subkey(key_path) {
                if let Ok(install_location) = key.get_value::<String, _>("InstallLocation") {
                    let exe = std::path::Path::new(&install_location).join("bin").join("gimp-2.10.exe");
                    if exe.exists() { return Some(exe.to_string_lossy().into_owned()); }
                    let exe3 = std::path::Path::new(&install_location).join("bin").join("gimp-3.0.exe");
                    if exe3.exists() { return Some(exe3.to_string_lossy().into_owned()); }
                }
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
pub struct ImageEditorStatus {
    pub paintnet: bool,
    pub photoshop: bool,
    pub gimp: bool,
}

/// Detect which image editors are installed and return their availability.
#[tauri::command]
pub async fn detect_image_editors() -> Result<ImageEditorStatus, String> {
    Ok(ImageEditorStatus {
        paintnet:  locate_paintnet().is_some(),
        photoshop: locate_photoshop().is_some(),
        gimp:      locate_gimp().is_some(),
    })
}

/// Open a .tex file for editing.
/// Reads the `TexEditorApp` preference (default|paintnet|photoshop|gimp) and
/// launches the appropriate application. Falls back to the OS default handler.
#[tauri::command]
pub fn show_in_explorer(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let native_path = file_path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", native_path))
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_tex_for_edit(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    let pref = get_preference(app, "TexEditorApp".to_string(), "default".to_string())
        .await
        .unwrap_or_else(|_| "default".to_string());

    let exe_path: Option<String> = match pref.as_str() {
        "paintnet"  => locate_paintnet(),
        "photoshop" => locate_photoshop(),
        "gimp"      => locate_gimp(),
        _           => None, // "default" or unknown → use OS default
    };

    if let Some(exe) = exe_path {
        std::process::Command::new(&exe)
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to launch image editor: {}", e))?;
        return Ok(());
    }

    // Open with OS default handler
    open_with_os_default(&file_path)
}

/// Open a file with the operating-system default handler.
///
/// On Windows we use `cmd /c start "" "path"` which is exactly what Windows
/// Explorer does when you double-click a file, so it honours whatever default
/// app the user has set — even for uncommon extensions like `.tex`.
fn open_with_os_default(file_path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Normalise to backslashes so cmd.exe is happy
        let win_path = file_path.replace('/', "\\");
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &win_path])
            .spawn()
            .map_err(|e| format!("Failed to open file with default handler: {}", e))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        opener::open(file_path)
            .map_err(|e| format!("Failed to open file with default handler: {}", e))?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteropHandoff {
    pub target_app: String,
    pub source_app: String,
    pub action: String,
    pub mode: Option<String>,
    pub bin_path: String,
    pub created_at_unix: u64,
}

fn get_interop_dir() -> Result<PathBuf, String> {
    let appdata = env::var("APPDATA").map_err(|e| format!("Failed to get APPDATA: {}", e))?;
    let dir = PathBuf::from(appdata)
        .join("LeagueToolkit")
        .join("Interop");

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create interop dir: {}", e))?;
    }
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Message-queue interop: each handoff is written as a separate timestamped
// file so rapid sends never overwrite each other.
// ---------------------------------------------------------------------------

const HANDOFF_STALE_SECONDS: u64 = 30;

static INTEROP_MSG_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn write_interop_message(handoff: &InteropHandoff) -> Result<(), String> {
    let dir = get_interop_dir()?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seq = INTEROP_MSG_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let pid = std::process::id();
    let filename = format!("handoff-{}-{}-{}.json", ts, pid, seq);
    let path = dir.join(filename);

    let content = serde_json::to_string_pretty(handoff)
        .map_err(|e| format!("Failed to serialize interop handoff: {}", e))?;
    fs::write(&path, content)
        .map_err(|e| format!("Failed to write interop message: {}", e))
}

/// Read and delete all pending handoff messages targeted at `target_app`.
/// Messages older than HANDOFF_STALE_SECONDS are silently discarded.
fn consume_interop_messages(target_app: &str) -> Result<Vec<InteropHandoff>, String> {
    let dir = get_interop_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read interop dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("handoff-") && name.ends_with(".json")
        })
        .collect();

    // Sort by filename (timestamp is embedded) so oldest is processed first.
    entries.sort_by_key(|e| e.file_name());

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut results = Vec::new();

    for entry in entries {
        let path = entry.path();
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                let _ = fs::remove_file(&path);
                continue;
            }
        };

        let handoff: InteropHandoff = match serde_json::from_str(&content) {
            Ok(h) => h,
            Err(_) => continue, // Malformed — skip.
        };

        if handoff.target_app.to_lowercase() != target_app.to_lowercase() {
            // Do not remove messages targeted at other apps.
            continue;
        }

        // Consume only messages targeted at this app.
        let _ = fs::remove_file(&path);

        // Staleness guard.
        if now_unix.saturating_sub(handoff.created_at_unix) > HANDOFF_STALE_SECONDS {
            continue;
        }

        results.push(handoff);
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// PID file helpers — fast process-alive checks without shelling to tasklist.
// ---------------------------------------------------------------------------

fn get_pid_file_path(app_name: &str) -> Result<PathBuf, String> {
    Ok(get_interop_dir()?.join(format!("{}.pid", app_name)))
}

pub fn write_jade_pid_file() -> Result<(), String> {
    let path = get_pid_file_path("jade")?;
    fs::write(&path, std::process::id().to_string())
        .map_err(|e| format!("Failed to write Jade PID file: {}", e))
}

pub fn remove_jade_pid_file() {
    if let Ok(path) = get_pid_file_path("jade") {
        let _ = fs::remove_file(path);
    }
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE
    }
}

#[cfg(windows)]
extern "system" {
    fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut std::ffi::c_void;
    fn GetExitCodeProcess(hProcess: *mut std::ffi::c_void, lpExitCode: *mut u32) -> i32;
    fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
}

fn is_quartz_running() -> bool {
    let pid_path = match get_pid_file_path("quartz") {
        Ok(p) => p,
        Err(_) => return false,
    };

    let pid_str = match fs::read_to_string(&pid_path) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let pid: u32 = match pid_str.trim().parse() {
        Ok(p) => p,
        Err(_) => return false,
    };

    #[cfg(windows)]
    { is_process_alive(pid) }

    #[cfg(not(windows))]
    { false }
}


#[tauri::command]
pub async fn file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read text file '{}': {}", path, e))
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content)
        .map_err(|e| format!("Failed to write text file '{}': {}", path, e))
}

#[tauri::command]
pub async fn consume_interop_handoff(_app: tauri::AppHandle) -> Result<Vec<InteropHandoff>, String> {
    consume_interop_messages("jade")
}

/// Guard against rapid duplicate spawns.  Stores the last time we spawned
/// Quartz so we don't launch it again within a short window.
static LAST_QUARTZ_SPAWN: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
const SPAWN_DEBOUNCE_SECS: u64 = 3;

#[derive(Serialize)]
pub struct QuartzInstallStatus {
    pub installed: bool,
    pub executable_path: Option<String>,
}

async fn resolve_quartz_executable_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let pref_path = get_preference(
        app.clone(),
        "QuartzExecutablePath".to_string(),
        "".to_string(),
    )
    .await
    .unwrap_or_default();

    let mut candidates: Vec<PathBuf> = Vec::new();
    if !pref_path.trim().is_empty() {
        candidates.push(PathBuf::from(pref_path.trim()));
    }

    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(&local_app_data)
                .join("Programs")
                .join("Quartz")
                .join("Quartz.exe"),
        );
    }

    if let Ok(user_profile) = env::var("USERPROFILE") {
        let desktop = PathBuf::from(&user_profile).join("Desktop");
        candidates.push(
            desktop
                .join("Quartz")
                .join("Quartz")
                .join("dist")
                .join("win-unpacked")
                .join("Quartz.exe"),
        );
        candidates.push(desktop.join("Quartz").join("Quartz").join("Quartz.exe"));
        candidates.push(desktop.join("Quartz.lnk"));
    }

    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
pub async fn get_quartz_install_status(app: tauri::AppHandle) -> Result<QuartzInstallStatus, String> {
    let executable = resolve_quartz_executable_path(&app).await;
    Ok(QuartzInstallStatus {
        installed: executable.is_some(),
        executable_path: executable.map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn send_bin_to_quartz(app: tauri::AppHandle, bin_path: String, mode: String) -> Result<(), String> {
    if !Path::new(&bin_path).exists() {
        return Err(format!("Bin path does not exist: {}", bin_path));
    }

    let created_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    write_interop_message(&InteropHandoff {
        target_app: "quartz".to_string(),
        source_app: "jade".to_string(),
        action: "open-bin".to_string(),
        mode: Some(mode),
        bin_path: bin_path.clone(),
        created_at_unix,
    })?;

    // If Quartz is already running (via PID file), no need to launch.
    if is_quartz_running() {
        return Ok(());
    }

    // Debounce: don't spawn again if we just did recently — the previous
    // spawn may not have written its PID file yet.
    {
        let mut last = LAST_QUARTZ_SPAWN.lock().unwrap();
        if let Some(ts) = *last {
            if ts.elapsed().as_secs() < SPAWN_DEBOUNCE_SECS {
                return Ok(());
            }
        }
        *last = Some(std::time::Instant::now());
    }

    let executable = resolve_quartz_executable_path(&app).await.ok_or_else(|| {
        "Could not find Quartz executable. Set preference QuartzExecutablePath in preferences.json.".to_string()
    })?;

    let exe_str = executable.to_string_lossy().to_string();
    if exe_str.to_lowercase().ends_with(".lnk") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &exe_str])
            .spawn()
            .map_err(|e| format!("Failed to launch Quartz shortcut '{}': {}", exe_str, e))?;
    } else {
        spawn_detached(&exe_str)?;
    }

    Ok(())
}

/// Spawn a process fully detached from Jade (own process group, null stdio)
/// so it survives Jade shutting down cleanly.
#[cfg(windows)]
fn spawn_detached(exe: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    std::process::Command::new(exe)
        .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch '{}': {}", exe, e))?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn_detached(exe: &str) -> Result<(), String> {
    std::process::Command::new(exe)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch '{}': {}", exe, e))?;
    Ok(())
}

#[tauri::command]
pub async fn notify_quartz_bin_updated(bin_path: String, mode: String) -> Result<(), String> {
    if !Path::new(&bin_path).exists() {
        return Err(format!("Bin path does not exist: {}", bin_path));
    }

    let created_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let normalized_mode = match mode.to_lowercase().as_str() {
        "port" => "port".to_string(),
        "bineditor" => "bineditor".to_string(),
        "vfxhub" => "vfxhub".to_string(),
        _ => "paint".to_string(),
    };

    write_interop_message(&InteropHandoff {
        target_app: "quartz".to_string(),
        source_app: "jade".to_string(),
        action: "reload-bin".to_string(),
        mode: Some(normalized_mode),
        bin_path,
        created_at_unix,
    })?;

    Ok(())
}

