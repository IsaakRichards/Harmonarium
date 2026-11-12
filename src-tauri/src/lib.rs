//! Harmonarium native shell.
//!
//! Almost everything lives in the web front end (library, reader, sync).
//! The Rust side only hosts the webview and provides the HTTP plugin, which
//! lets the app reach the Google Apps Script bridge, Open Library and Google Books
//! without CORS trouble. On desktop it also hosts the in-app updater (src/updater.js).

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Folders the reader chose with "Add a whole folder"; only books inside them may be read.
#[derive(Default)]
struct ChosenFolders(Mutex<Vec<PathBuf>>);

/// Every EPUB and PDF under `dir` (subfolders too, hidden ones and links skipped).
#[cfg_attr(mobile, allow(dead_code))]
fn scan_books(root: &Path, dir: &Path, depth: u32, out: &mut Vec<serde_json::Value>) {
    if depth > 16 || out.len() >= 50_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_dir() {
            if !name.starts_with('.') {
                scan_books(root, &path, depth + 1, out);
            }
        } else if kind.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext == "epub" || ext == "pdf" {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let folder = path
                    .parent()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                out.push(serde_json::json!({
                    "ref": path.to_string_lossy(), "name": name, "folder": folder, "size": size,
                }));
            }
        }
    }
}

/// Ask for a folder and list the books in it: { folder, books: [{ ref, name, folder, size }] },
/// or null if the reader cancelled.
#[tauri::command]
async fn pick_book_folder(
    app: tauri::AppHandle,
    chosen: tauri::State<'_, ChosenFolders>,
) -> Result<Option<serde_json::Value>, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        let Some(picked) = app.dialog().file().set_title("Choose a folder of books").blocking_pick_folder() else {
            return Ok(None);
        };
        let root = picked.into_path().map_err(|e| e.to_string())?;
        let mut books = Vec::new();
        scan_books(&root, &root, 0, &mut books);
        chosen.0.lock().map_err(|e| e.to_string())?.push(root.clone());
        let folder = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string_lossy().into_owned());
        Ok(Some(serde_json::json!({ "folder": folder, "books": books })))
    }
    #[cfg(mobile)]
    {
        let _ = (app, chosen);
        Err("folders are chosen another way on this device".into())
    }
}

/// Read one of the books found by pick_book_folder, as raw bytes.
#[tauri::command]
fn read_book_file(path: String, chosen: tauri::State<'_, ChosenFolders>) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    let inside = !p.components().any(|c| matches!(c, Component::ParentDir))
        && chosen.0.lock().map_err(|e| e.to_string())?.iter().any(|root| p.starts_with(root));
    if !inside {
        return Err("that file isn't in a folder you chose".into());
    }
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

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
        .manage(ChosenFolders::default())
        .invoke_handler(tauri::generate_handler![update_mode, pick_book_folder, read_book_file]);

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
