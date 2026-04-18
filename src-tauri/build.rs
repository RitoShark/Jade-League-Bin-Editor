fn main() {
    // On Windows, embed the three builtin icon groups (jade/jadejade/noBrain)
    // alongside Tauri's main app icon. Each lives at its own numeric resource
    // id per `icons/extra_icons.rc` so the runtime icon switcher can load them
    // via LoadImageW(hinstance, MAKEINTRESOURCE(id), ...). Must run before
    // tauri_build::build() so the linker sees both resource sets.
    #[cfg(target_os = "windows")]
    embed_resource::compile("icons/extra_icons.rc", embed_resource::NONE);

    tauri_build::build()
}
