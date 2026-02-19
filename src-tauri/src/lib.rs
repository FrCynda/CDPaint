// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn first_file_path<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let mut candidates: Vec<String> = Vec::new();
    for arg in args {
        let mut s = arg.trim().trim_matches('"').to_string();
        if s.is_empty() {
            continue;
        }
        if s.starts_with("file://") {
            s = s.trim_start_matches("file://").to_string();
            if s.starts_with('/') {
                s = s.trim_start_matches('/').to_string();
            }
            s = s.replace('/', "\\");
        }
        candidates.push(s);
    }
    // Prefer existing image files.
    for s in &candidates {
        if is_current_exe(s) {
            continue;
        }
        let p = Path::new(s);
        if p.is_file() && is_image_path(s) {
            return Some(normalize_candidate(s));
        }
    }
    // Then any existing non-exe file.
    for s in &candidates {
        if is_current_exe(s) {
            continue;
        }
        let p = Path::new(s);
        if p.is_file() {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext != "exe" {
                return Some(normalize_candidate(s));
            }
        }
    }
    // Fallback: if it looks like an image path, accept it even if it doesn't exist yet.
    for s in &candidates {
        if is_current_exe(s) {
            continue;
        }
        if is_image_path(s) {
            return Some(s.to_string());
        }
    }
    None
}

fn is_current_exe(path: &str) -> bool {
    let cur = std::env::current_exe().ok();
    let cur = cur.and_then(|p| p.canonicalize().ok());
    let candidate = Path::new(path).canonicalize().ok();
    match (cur, candidate) {
        (Some(c), Some(p)) => c == p,
        _ => false,
    }
}

struct PendingFiles(Mutex<HashMap<String, String>>);
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
fn get_pending_file(window: tauri::Window, state: tauri::State<'_, PendingFiles>) -> Option<String> {
    let mut guard = state.0.lock().unwrap();
    let label = window.label().to_string();
    guard.remove(&label)
}

fn is_image_path(path: &str) -> bool {
    let p = Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "gif" | "webp")
}

fn normalize_candidate(path: &str) -> String {
    let p = Path::new(path);
    if let Ok(abs) = p.canonicalize() {
        abs.to_string_lossy().to_string()
    } else {
        path.to_string()
    }
}

fn next_window_label() -> String {
    let n = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "file-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        n
    )
}

fn collect_image_paths<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut out = Vec::new();
    for arg in args {
        let mut s = arg.trim().trim_matches('"').to_string();
        if s.is_empty() {
            continue;
        }
        if s.starts_with("file://") {
            s = s.trim_start_matches("file://").to_string();
            if s.starts_with('/') {
                s = s.trim_start_matches('/').to_string();
            }
            s = s.replace('/', "\\");
        }
        if is_current_exe(&s) {
            continue;
        }
        if is_image_path(&s) {
            out.push(normalize_candidate(&s));
        }
    }
    out
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingFiles(Mutex::new(HashMap::new())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = collect_image_paths(argv.into_iter());
            if paths.is_empty() {
                return;
            }
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                for path in paths {
                    let windows = app_handle.webview_windows();
                    if windows.is_empty() {
                        let _ = app_handle.emit("open-file", path);
                        continue;
                    }
                    let label = next_window_label();
                    if let Ok(mut guard) = app_handle.state::<PendingFiles>().0.lock() {
                        guard.insert(label.clone(), path);
                    }
                    let _ = tauri::WebviewWindowBuilder::new(
                        &app_handle,
                        label,
                        tauri::WebviewUrl::App("index.html".into()),
                    )
                    .title("cdpaint")
                    .decorations(false)
                    .shadow(true)
                    .resizable(true)
                    .inner_size(1920.0, 1057.0)
                    .maximized(true)
                    .build();
                }
            });
        }))
        .invoke_handler(tauri::generate_handler![greet, get_pending_file])
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = first_file_path(args.into_iter().skip(1)) {
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(500));
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.emit("open-file", path);
                    } else {
                        let _ = handle.emit("open-file", path);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
