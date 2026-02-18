/// Extra commands: file association, autostart, updater
use serde::{Deserialize, Serialize};
use std::env;

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

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub notes: String,
    pub download_url: String,
}

/// Check for available updates
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater_builder()
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
            download_url: update.download_url.to_string(),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: env!("CARGO_PKG_VERSION").to_string(),
            notes: String::new(),
            download_url: String::new(),
        }),
        Err(e) => Err(format!("Failed to check for updates: {}", e)),
    }
}

/// Download and install the available update
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater_builder()
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;

    if let Some(update) = updater.check().await.map_err(|e| format!("Failed to check: {}", e))? {
        update.download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| format!("Failed to install update: {}", e))?;
    }

    Ok(())
}
