//! Harmonarium native shell.
//!
//! Almost everything lives in the web front end (library, reader, sync).
//! The Rust side only hosts the webview and provides the HTTP plugin, which
//! lets the app reach the Google Apps Script bridge, Open Library and Google Books
//! without CORS trouble. On desktop it also hosts the in-app updater (src/updater.js).

/// How this copy can update itself:
/// "install"  the updater plugin can replace it (Windows, or Linux running as an AppImage);
/// "page"     it was installed some other way (.deb, .rpm), so offer the releases page;
/// "none"     mobile (Android has its own native updater).
#[tauri::command]
fn update_mode(app: tauri::AppHandle) -> &'static str {
    #[cfg(desktop)]
    {
        let configured = app.config().plugins.0.contains_key("updater");
        let replaceable = cfg!(any(target_os = "windows", target_os = "macos"))
            || std::env::var_os("APPIMAGE").is_some();
        if configured && replaceable {
            "install"
        } else {
            "page"
        }
    }
    #[cfg(mobile)]
    {
        let _ = app;
        "none"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![update_mode]);

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if app.config().plugins.0.contains_key("updater") {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running Harmonarium");
}
