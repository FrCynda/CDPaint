// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};
use serde::{Deserialize, Serialize};
use url::Url;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn window_state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("window-state.json"))
}

fn read_saved_window_state(app: &tauri::AppHandle) -> Option<SavedWindowState> {
    let path = window_state_path(app)?;
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice::<SavedWindowState>(&raw).ok()
}

fn write_saved_window_state(app: &tauri::AppHandle, state: &SavedWindowState) -> Result<(), String> {
    let path = window_state_path(app).ok_or_else(|| "no config path".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir failed: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| format!("serialize window state failed: {}", e))?;
    std::fs::write(path, bytes).map_err(|e| format!("write window state failed: {}", e))
}

fn current_window_state(window: &tauri::WebviewWindow) -> Option<SavedWindowState> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let maximized = window.is_maximized().ok().unwrap_or(false);
    Some(SavedWindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
    })
}

fn install_window_state_persistence(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let saved = read_saved_window_state(app);
    let should_restore_maximized = saved.as_ref().map(|s| s.maximized).unwrap_or(false);

    if let Some(state) = saved.clone() {
        if state.width > 0 && state.height > 0 {
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                state.width,
                state.height,
            )));
        }
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            state.x, state.y,
        )));
    }

    if should_restore_maximized {
        // Maximizing immediately in setup is flaky on some platforms.
        // Re-apply shortly after startup for reliable restore behavior.
        let win = window.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            let _ = win.maximize();
        });
    }

    let initial = saved
        .filter(|s| !s.maximized)
        .or_else(|| current_window_state(window))
        .unwrap_or(SavedWindowState {
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
            maximized: false,
        });
    let last_normal = std::sync::Arc::new(Mutex::new(initial));
    let last_maximized = std::sync::Arc::new(Mutex::new(should_restore_maximized));

    let app_handle = app.clone();
    let win = window.clone();
    let last_normal_state = last_normal.clone();
    let last_maximized_state = last_maximized.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(pos) => {
            let is_max = win.is_maximized().ok().unwrap_or(false);
            if let Ok(mut max_flag) = last_maximized_state.lock() {
                *max_flag = is_max;
            }
            if is_max {
                return;
            }
            if let Ok(mut state) = last_normal_state.lock() {
                state.x = pos.x;
                state.y = pos.y;
            }
        }
        tauri::WindowEvent::Resized(size) => {
            let is_max = win.is_maximized().ok().unwrap_or(false);
            if let Ok(mut max_flag) = last_maximized_state.lock() {
                *max_flag = is_max;
            }
            if is_max {
                return;
            }
            if let Ok(mut state) = last_normal_state.lock() {
                state.width = size.width;
                state.height = size.height;
            }
        }
        tauri::WindowEvent::Focused(_) => {
            let is_max = win.is_maximized().ok().unwrap_or(false);
            if let Ok(mut max_flag) = last_maximized_state.lock() {
                *max_flag = is_max;
            }
        }
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
            let maximized = win.is_maximized().ok().unwrap_or_else(|| {
                last_maximized_state
                    .lock()
                    .ok()
                    .map(|v| *v)
                    .unwrap_or(false)
            });
            let mut out = if let Ok(state) = last_normal_state.lock() {
                state.clone()
            } else {
                return;
            };
            if !maximized {
                if let Some(cur) = current_window_state(&win) {
                    out.x = cur.x;
                    out.y = cur.y;
                    out.width = cur.width;
                    out.height = cur.height;
                }
            }
            out.maximized = maximized;
            let _ = write_saved_window_state(&app_handle, &out);
        }
        _ => {}
    });
}

fn file_url_to_path(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    if url.scheme() != "file" {
        return None;
    }

    if let Ok(path) = url.to_file_path() {
        return Some(path.to_string_lossy().to_string());
    }

    #[cfg(windows)]
    {
        // Fallback for non-standard "file://C:/..." style inputs.
        let raw = input.trim_start_matches("file://");
        let bytes = raw.as_bytes();
        let looks_like_drive = bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':';
        let trimmed = if looks_like_drive { &raw[1..] } else { raw };
        return Some(trimmed.replace('/', "\\"));
    }

    #[cfg(not(windows))]
    {
        None
    }
}

fn normalize_launch_arg(arg: &str) -> Option<String> {
    let trimmed = arg.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }

    let path = if trimmed.starts_with("file://") {
        file_url_to_path(trimmed)?
    } else {
        trimmed.to_string()
    };

    Some(normalize_device_path(&path))
}

fn first_file_path<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let mut candidates: Vec<String> = Vec::new();
    for arg in args {
        if let Some(s) = normalize_launch_arg(&arg) {
            candidates.push(s);
        }
    }
    // Accept only existing image files passed on launch.
    for s in &candidates {
        if is_current_exe(s) {
            continue;
        }
        let p = Path::new(s);
        if p.is_file() && is_image_path(s) {
            return Some(normalize_candidate(s));
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
    is_image_extension(p.extension().and_then(|e| e.to_str()))
}

fn is_image_extension(ext: Option<&str>) -> bool {
    matches!(
        ext.unwrap_or("").to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "bmp" | "gif" | "webp"
    )
}

fn normalize_device_path(path: &str) -> String {
    let mut s = path.trim().to_string();
    if s.starts_with(r"\\?\UNC\") {
        s = format!(r"\\{}", &s[r"\\?\UNC\".len()..]);
    } else if s.starts_with(r"\\?\") {
        s = s[r"\\?\".len()..].to_string();
    }
    s
}

fn normalize_to_absolute_path(path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_device_path(path);
    let p = PathBuf::from(normalized);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    Ok(p)
}

fn is_allowed_write_extension(ext: Option<&str>) -> bool {
    matches!(
        ext.unwrap_or("").to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "bmp" | "gif" | "webp" | "pal"
    )
}

#[tauri::command]
fn read_image_file(path: String) -> Result<Vec<u8>, String> {
    let p = normalize_to_absolute_path(&path)?;
    if !p.is_file() {
        return Err("path is not an existing file".into());
    }
    if !is_image_extension(p.extension().and_then(|e| e.to_str())) {
        return Err("only image files can be read".into());
    }
    std::fs::read(&p).map_err(|e| format!("read failed: {}", e))
}

#[tauri::command]
fn write_allowed_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let p = normalize_to_absolute_path(&path)?;
    if !is_allowed_write_extension(p.extension().and_then(|e| e.to_str())) {
        return Err("file extension not allowed".into());
    }
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            return Err("target directory does not exist".into());
        }
    } else {
        return Err("invalid target path".into());
    }
    std::fs::write(&p, data).map_err(|e| format!("write failed: {}", e))
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
        let Some(s) = normalize_launch_arg(&arg) else { continue };
        if is_current_exe(&s) {
            continue;
        }
        if is_image_path(&s) && Path::new(&s).is_file() {
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
        .invoke_handler(tauri::generate_handler![
            greet,
            get_pending_file,
            read_image_file,
            write_allowed_file
        ])
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                install_window_state_persistence(&app.handle().clone(), &main_window);
            }
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = first_file_path(args.into_iter().skip(1)) {
                // Queue the startup file immediately so the frontend can pull it
                // on first boot without waiting for an artificial delay.
                if let Ok(mut guard) = app.state::<PendingFiles>().0.lock() {
                    guard.insert("main".to_string(), path.clone());
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("open-file", path);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
