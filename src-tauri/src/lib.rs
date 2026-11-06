//! KosmicLitSync native shell.
//!
//! Almost everything lives in the web front end (library, reader, sync).
//! The Rust side only hosts the webview and provides the HTTP plugin, which
//! lets the app talk to the Google Apps Script endpoint without CORS trouble.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running KosmicLitSync");
}
