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

/// The file a backup is being written to: the one the reader picked in the save dialog.
#[derive(Default)]
struct SaveTarget(Mutex<Option<(PathBuf, std::fs::File)>>);

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

/// Ask where to save a backup and open that file: its path, or null if the reader cancelled.
#[tauri::command]
async fn save_begin(
    app: tauri::AppHandle,
    name: String,
    target: tauri::State<'_, SaveTarget>,
) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        let Some(picked) = app
            .dialog()
            .file()
            .set_title("Save a Harmonarium backup")
            .set_file_name(&name)
            .add_filter("Harmonarium backup", &["zip"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let shown = path.to_string_lossy().into_owned();
        *target.0.lock().map_err(|e| e.to_string())? = Some((path, file));
        Ok(Some(shown))
    }
    #[cfg(mobile)]
    {
        let _ = (app, name, target);
        Err("files are saved another way on this device".into())
    }
}

/// The next piece of the backup, sent as raw bytes.
#[tauri::command]
fn save_chunk(request: tauri::ipc::Request<'_>, target: tauri::State<'_, SaveTarget>) -> Result<(), String> {
    use std::io::Write;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let mut guard = target.0.lock().map_err(|e| e.to_string())?;
    let Some((_, file)) = guard.as_mut() else {
        return Err("no file is being saved".into());
    };
    file.write_all(bytes).map_err(|e| e.to_string())
}

/// Finish the backup (keep = true), or throw the half-written file away.
#[tauri::command]
fn save_end(keep: bool, target: tauri::State<'_, SaveTarget>) -> Result<(), String> {
    let taken = target.0.lock().map_err(|e| e.to_string())?.take();
    let Some((path, file)) = taken else { return Ok(()) };
    if keep {
        file.sync_all().map_err(|e| e.to_string())?;
    } else {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Automatic backups: Documents/Harmonarium backups (made if missing).
#[cfg_attr(mobile, allow(dead_code))]
fn auto_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("Harmonarium backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Only automatic backups ("Harmonarium-auto-YYYY-MM-DD-HHMMSS.zip") are written or removed there.
fn auto_name_ok(name: &str) -> bool {
    let Some(mid) = name.strip_prefix("Harmonarium-auto-").and_then(|r| r.strip_suffix(".zip")) else {
        return false;
    };
    mid.len() == 17 && mid.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 || i == 10 { c == '-' } else { c.is_ascii_digit() })
}

#[tauri::command]
fn auto_where(app: tauri::AppHandle) -> Result<String, String> {
    Ok(auto_dir(&app)?.to_string_lossy().into_owned())
}

/// Start an automatic backup; its pieces then go through save_chunk / save_end.
#[tauri::command]
fn auto_begin(app: tauri::AppHandle, name: String, target: tauri::State<'_, SaveTarget>) -> Result<String, String> {
    if !auto_name_ok(&name) {
        return Err("not an automatic backup's name".into());
    }
    let dir = auto_dir(&app)?;
    let path = dir.join(&name);
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    *target.0.lock().map_err(|e| e.to_string())? = Some((path, file));
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn auto_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = auto_dir(&app)?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| auto_name_ok(n))
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
fn auto_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !auto_name_ok(&name) {
        return Err("not an automatic backup's name".into());
    }
    std::fs::remove_file(auto_dir(&app)?.join(name)).map_err(|e| e.to_string())
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
        .manage(SaveTarget::default())
        .invoke_handler(tauri::generate_handler![
            update_mode,
            pick_book_folder,
            read_book_file,
            save_begin,
            save_chunk,
            save_end,
            auto_where,
            auto_begin,
            auto_list,
            auto_remove
        ]);

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
