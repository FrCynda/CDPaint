// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;
use serde::{Deserialize, Serialize};
use url::Url;

const MIN_WINDOW_WIDTH: u32 = 400;
const MIN_WINDOW_HEIGHT: u32 = 400;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(Debug, Clone, Serialize)]
struct UpdateCheckResponse {
    current_version: String,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    download_url: Option<String>,
}

#[tauri::command]
async fn updater_check(app: tauri::AppHandle) -> Result<UpdateCheckResponse, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(UpdateCheckResponse {
            current_version,
            available: false,
            version: None,
            notes: None,
            date: None,
            download_url: None,
        });
    };

    Ok(UpdateCheckResponse {
        current_version,
        available: true,
        version: Some(update.version),
        notes: update.body,
        date: update.date.map(|d| d.to_string()),
        download_url: Some(update.download_url.to_string()),
    })
}

#[tauri::command]
async fn updater_download_and_install(app: tauri::AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    update
        .download_and_install(|_chunk_len, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
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

fn minimum_window_size() -> tauri::Size {
    tauri::Size::Physical(tauri::PhysicalSize::new(
        MIN_WINDOW_WIDTH,
        MIN_WINDOW_HEIGHT,
    ))
}

fn enforce_min_window_size(window: &tauri::WebviewWindow) {
    let _ = window.set_min_size(Some(minimum_window_size()));
}

/// Returns true if the point (x, y) falls within any currently connected monitor.
fn position_on_visible_monitor(window: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let monitors = match window.available_monitors() {
        Ok(m) => m,
        // If we can't enumerate monitors, trust the saved value rather than
        // risk moving a perfectly good window.
        Err(_) => return true,
    };
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        x >= pos.x
            && y >= pos.y
            && x < pos.x + size.width as i32
            && y < pos.y + size.height as i32
    })
}

/// Move the window to the centre of the primary (or first available) monitor.
fn center_on_primary_monitor(window: &tauri::WebviewWindow) {
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.available_monitors().ok().and_then(|m| m.into_iter().next()));
    let monitor = match monitor {
        Some(m) => m,
        None => {
            let _ = window.center();
            return;
        }
    };
    let pos = monitor.position();
    let size = monitor.size();
    let win = window
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(1200u32, 800u32));
    let x = pos.x + ((size.width as i32 - win.width as i32) / 2).max(0);
    let y = pos.y + ((size.height as i32 - win.height as i32) / 2).max(0);
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
}

fn apply_startup_window_state(
    window: &tauri::WebviewWindow,
    saved: Option<&SavedWindowState>,
    default_maximized: bool,
) -> bool {
    if let Some(state) = saved {
        // A position saved while a now-disconnected monitor was attached would
        // otherwise be reapplied verbatim, placing the window off-screen
        // (invisible, but the process keeps running). Keep the window on a
        // visible monitor before restoring it.
        if state.maximized {
            if !position_on_visible_monitor(window, state.x, state.y) {
                center_on_primary_monitor(window);
            }
            // Apply maximized state after window creation to avoid a visible
            // resize frame on Windows when using frameless windows.
            let _ = window.maximize();
            return true;
        }
        if state.width > 0 && state.height > 0 {
            let width = state.width.max(MIN_WINDOW_WIDTH);
            let height = state.height.max(MIN_WINDOW_HEIGHT);
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                width,
                height,
            )));
        }
        if position_on_visible_monitor(window, state.x, state.y) {
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                state.x, state.y,
            )));
        } else {
            center_on_primary_monitor(window);
        }
        return false;
    }

    if default_maximized {
        let _ = window.maximize();
        return true;
    }

    false
}

fn install_maximized_resizable_guard(window: &tauri::WebviewWindow, _startup_maximized: bool) {
    // Keep maximized windows resizable so custom frameless title-bar interactions
    // (drag-to-restore, minimize/maximize buttons) stay functional on Windows.
    let _ = window.set_resizable(true);
}

fn install_window_state_persistence(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let saved = read_saved_window_state(app);
    let should_restore_maximized = apply_startup_window_state(window, saved.as_ref(), true);
    install_maximized_resizable_guard(window, should_restore_maximized);

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
        // Fallback for non-standard "file://C:/..." style inputs where
        // url::Url::to_file_path() couldn't parse the path.
        // Normalize to file:///C:/... and re-parse through the url crate.
        let raw = input.trim_start_matches("file://");
        let bytes = raw.as_bytes();
        let looks_like_drive = bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':';
        if looks_like_drive {
            if let Ok(url2) = Url::parse(&format!("file:///{}", &raw[1..])) {
                if let Ok(path) = url2.to_file_path() {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }
        None
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

#[tauri::command]
fn get_pending_file(window: tauri::Window, state: tauri::State<'_, PendingFiles>) -> Option<String> {
    let mut guard = state.0.lock().ok()?;
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
        "png" | "jpg" | "jpeg" | "bmp" | "gif" | "webp" | "ora"
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
    let trimmed = path.trim();
    let normalized = if trimmed.starts_with("file://") {
        file_url_to_path(trimmed).ok_or_else(|| "invalid file URL".to_string())?
    } else {
        normalize_device_path(trimmed)
    };
    let p = PathBuf::from(normalized);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    // Resolve `.` and `..` components logically so the OS cannot be tricked into
    // writing/reading outside the directory implied by the (possibly malicious) string.
    // `..` at the root is dropped, so the path can never escape the absolute root.
    Ok(resolve_path_dots(&p))
}

/// Logically resolve `.` and `..` in an absolute path without touching the filesystem.
/// A `..` that would climb above the root is simply dropped, preventing traversal escape.
fn resolve_path_dots(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut stack: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                if let Some(Component::Normal(_)) = stack.last() {
                    stack.pop();
                }
            }
            Component::CurDir => {}
            other => stack.push(other),
        }
    }
    let mut out = PathBuf::new();
    for c in stack {
        out.push(c.as_os_str());
    }
    out
}

fn is_allowed_write_extension(ext: Option<&str>) -> bool {
    matches!(
        ext.unwrap_or("").to_ascii_lowercase().as_str(),
        // `.bin` is here so a retiled screen can write its tilemap back beside
        // its tiles. It is the only non-picture this app produces.
        "png" | "jpg" | "jpeg" | "bmp" | "gif" | "webp" | "pal" | "bin"
    )
}

#[tauri::command]
fn read_image_file(path: String) -> Result<Vec<u8>, String> {
    let p = normalize_to_absolute_path(&path)?;
    if !p.is_file() {
        return Err("path is not an existing file".into());
    }
    // `.bin` is here and not in `is_image_extension` on purpose: a tilemap is
    // graphics data this reader should hand over, but it is not something the
    // app should offer to *open* as a picture, and `is_image_path` decides that.
    let ext = p.extension().and_then(|e| e.to_str());
    let is_tilemap = ext.map(|e| e.eq_ignore_ascii_case("bin")).unwrap_or(false);
    if !is_image_extension(ext) && !is_tilemap {
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

#[derive(Debug, Clone, Serialize)]
struct ProjectNode {
    name: String,
    path: String,
    kind: String,
    ext: Option<String>,
    size: u64,
    children: Vec<ProjectNode>,
}

const MAX_SCAN_DEPTH: usize = 12;
const SCAN_DIR_DENYLIST: [&str; 6] = [".git", "node_modules", "target", ".vscode", ".idea", "dist"];

fn scan_dir(dir: &Path, depth: usize, out: &mut ProjectNode) -> std::io::Result<()> {
    let mut dir_entries: Vec<(String, PathBuf)> = Vec::new();
    let mut file_entries: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut entries = std::fs::read_dir(dir)?;
    while let Some(entry) = entries.next() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();
        let meta = match std::fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue;
        }
        let fname = entry.file_name().to_string_lossy().to_string();
        if meta.is_dir() {
            if depth >= MAX_SCAN_DEPTH {
                continue;
            }
            if SCAN_DIR_DENYLIST.iter().any(|d| d.eq_ignore_ascii_case(&fname)) {
                continue;
            }
            dir_entries.push((fname, p));
        } else if meta.is_file() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            /* `.bin` is a tilemap. The browser never draws a row for one, but a
               tiles.png cannot be recognised as a screen without seeing whether
               its map.bin is there — and a screen is what the editor opens
               assembled rather than as a jumbled sheet. */
            if matches!(ext.as_deref(), Some("png") | Some("pal") | Some("bin")) {
                file_entries.push((fname, p, meta.len()));
            }
        }
    }
    for (fname, p) in dir_entries {
        let mut node = ProjectNode {
            name: fname,
            path: p.to_string_lossy().to_string(),
            kind: "dir".to_string(),
            ext: None,
            size: 0,
            children: Vec::new(),
        };
        if scan_dir(&p, depth + 1, &mut node).is_ok() {
            if !node.children.is_empty() {
                out.children.push(node);
            }
        }
    }
    for (fname, p, size) in file_entries {
        out.children.push(ProjectNode {
            name: fname,
            path: p.to_string_lossy().to_string(),
            kind: "file".to_string(),
            ext: p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase()),
            size,
            children: Vec::new(),
        });
    }
    out.children.sort_by(|a, b| {
        if a.kind != b.kind {
            return a.kind.cmp(&b.kind);
        }
        a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase())
    });
    Ok(())
}

#[tauri::command]
fn scan_project(path: String) -> Result<ProjectNode, String> {
    let p = normalize_to_absolute_path(&path)?;
    if !p.is_dir() {
        return Err("path is not an existing directory".into());
    }
    let mut root = ProjectNode {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| p.to_string_lossy().to_string()),
        path: p.to_string_lossy().to_string(),
        kind: "dir".to_string(),
        ext: None,
        size: 0,
        children: Vec::new(),
    };
    scan_dir(&p, 0, &mut root).map_err(|e| format!("scan failed: {}", e))?;
    Ok(root)
}

/* The project's own C, for the asset model to read.
 *
 * A decomp declares three things nothing else can supply — the depth each slot
 * is built at, which palette a picture binds to, and where a sprite sits in its
 * frame — and all three live in `src/` and `include/`. Reading them one file at
 * a time over IPC would be a thousand round trips, so this is one call.
 *
 * Two filters keep it honest rather than merely small: only files whose text
 * actually contains a declaration we parse, and a hard byte ceiling so hooking
 * something that is not a decomp cannot pull the whole disk into a string. On
 * pokeemerald-expansion that is 173 files out of 996, 16MB out of 39MB. */
#[derive(Debug, Clone, Serialize)]
struct ProjectSource {
    path: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProjectSources {
    root: String,
    files: Vec<ProjectSource>,
    skipped: usize,
}

// Keep in step with SOURCE_MARKERS in src/js/project-browser.js — browser mode
// filters with its own copy, and a file only one of them keeps is a feature
// that works on the desktop and not in the browser, or the reverse.
const SOURCE_MARKERS: [&str; 10] = [
    "INCBIN_U",
    "INCGFX_U",
    "SpriteFrameImage",
    "ObjectEventGraphicsInfo",
    "OBJ_EVENT_PAL_TAG_",
    "PicYOffset",
    "y_offset",
    "#define P_",
    // The battle environment table. It names no files itself — the graphics
    // header does that — so none of the markers above reach it, and without it
    // the battle preview has no backdrops to offer. Matched by its entry
    // constant rather than its own name: the table has been called
    // gBattleEnvironmentInfo, sBattleEnvironmentTable and sBattleTerrainTable
    // across the projects this has to open, and a fork may rename it again.
    "BATTLE_ENVIRONMENT_",
    "BATTLE_TERRAIN_",
];
const MAX_SOURCE_BYTES: usize = 96 * 1024 * 1024;

/* The hooked folder is usually `graphics/`, and the declarations are two levels
   up. A repo root is the directory that has both `src` and `include` in it —
   true of pokeemerald, every fork of it, and of nothing else the user is likely
   to point at. Give up rather than guess if it is not within a few levels. */
fn find_project_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    for _ in 0..6 {
        let d = dir?;
        if d.join("src").is_dir() && d.join("include").is_dir() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

fn collect_sources(
    dir: &Path,
    root: &Path,
    depth: usize,
    out: &mut Vec<ProjectSource>,
    total: &mut usize,
    skipped: &mut usize,
) {
    if depth > MAX_SCAN_DEPTH || *total >= MAX_SOURCE_BYTES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let meta = match std::fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue;
        }
        let fname = entry.file_name().to_string_lossy().to_string();
        if meta.is_dir() {
            if SCAN_DIR_DENYLIST.iter().any(|d| d.eq_ignore_ascii_case(&fname))
                || fname.eq_ignore_ascii_case("build")
            {
                continue;
            }
            collect_sources(&p, root, depth + 1, out, total, skipped);
        } else if meta.is_file() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            if !matches!(ext.as_deref(), Some("c") | Some("h") | Some("inc")) {
                continue;
            }
            let text = match std::fs::read_to_string(&p) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if !SOURCE_MARKERS.iter().any(|m| text.contains(m)) {
                continue;
            }
            if *total + text.len() > MAX_SOURCE_BYTES {
                *skipped += 1;
                continue;
            }
            *total += text.len();
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(ProjectSource { path: rel, text });
        }
    }
}

#[tauri::command]
fn read_project_sources(path: String) -> Result<ProjectSources, String> {
    let p = normalize_to_absolute_path(&path)?;
    if !p.is_dir() {
        return Err("path is not an existing directory".into());
    }
    let root = find_project_root(&p)
        .ok_or("no decomp found here — expected a folder with src/ and include/ in it")?;
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut skipped = 0usize;
    for sub in ["src", "include", "data"] {
        let dir = root.join(sub);
        if dir.is_dir() {
            collect_sources(&dir, &root, 0, &mut files, &mut total, &mut skipped);
        }
    }
    Ok(ProjectSources {
        root: root.to_string_lossy().to_string(),
        files,
        skipped,
    })
}

/* One value in one declaration, replaced.
 *
 * This is the only path by which CDPaint writes C, and it is deliberately the
 * narrowest one that does the job: a byte range, the text that is expected to
 * be there, and what to put in its place. If the file has changed since it was
 * read — someone edited it, or rebased — the expected text will not match and
 * nothing is written. A whole-file write would have no such check, and losing
 * somebody's species data to a stale offset is not a bug worth being able to
 * have. */
#[tauri::command]
fn patch_source_file(
    path: String,
    offset: usize,
    expect: String,
    replacement: String,
) -> Result<(), String> {
    let p = normalize_to_absolute_path(&path)?;
    if !p.is_file() {
        return Err("path is not an existing file".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("c") | Some("h") | Some("inc")) {
        return Err("only project source files can be patched".into());
    }
    if find_project_root(p.parent().unwrap_or(&p)).is_none() {
        return Err("that file is not inside a decomp".into());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("read failed: {}", e))?;
    let end = offset + expect.len();
    if end > text.len() || !text.is_char_boundary(offset) || !text.is_char_boundary(end) {
        return Err("the file has changed since it was read".into());
    }
    if &text[offset..end] != expect {
        return Err("the file has changed since it was read".into());
    }
    let mut next = String::with_capacity(text.len() + replacement.len());
    next.push_str(&text[..offset]);
    next.push_str(&replacement);
    next.push_str(&text[end..]);
    std::fs::write(&p, next).map_err(|e| format!("write failed: {}", e))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = normalize_to_absolute_path(&path)?;
    if !p.is_file() {
        return Err("path is not an existing file".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("pal") | Some("txt")) {
        return Err("only .pal and .txt files can be read".into());
    }
    std::fs::read_to_string(&p).map_err(|e| format!("read failed: {}", e))
}

#[derive(Debug, Deserialize)]
struct ExportFilePayload {
    name: String,
    data: Vec<u8>,
}

fn resolve_dialog_file_path(file_path: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    if let Ok(path) = file_path.clone().into_path() {
        if path.is_absolute() {
            return Ok(path);
        }
    }

    // Some backends may serialize the picked path as a URL string.
    let raw = file_path.to_string();
    normalize_to_absolute_path(&raw)
}

fn write_export_files_to_directory(dir: &Path, files: Vec<ExportFilePayload>) -> Result<(), String> {
    if !dir.is_dir() {
        return Err("target directory does not exist".into());
    }
    for file in files {
        let name = file.name.trim();
        if name.is_empty() {
            return Err("file name is empty".into());
        }
        if name.contains('\\') || name.contains('/') || name.contains(':') {
            return Err("file name must not contain path separators".into());
        }
        let out = dir.join(name);
        if !is_allowed_write_extension(out.extension().and_then(|e| e.to_str())) {
            return Err(format!("file extension not allowed: {}", name));
        }
        std::fs::write(&out, file.data).map_err(|e| format!("write failed ({}): {}", name, e))?;
    }
    Ok(())
}

#[tauri::command]
fn write_export_files(directory: String, files: Vec<ExportFilePayload>) -> Result<(), String> {
    let dir = normalize_to_absolute_path(&directory)?;
    write_export_files_to_directory(&dir, files)
}

#[tauri::command]
async fn write_export_files_with_dialog(app: tauri::AppHandle, files: Vec<ExportFilePayload>) -> Result<bool, String> {
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose Export Folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(folder) = folder else {
        return Ok(false);
    };
    let dir = resolve_dialog_file_path(folder)?;
    write_export_files_to_directory(&dir, files)?;
    Ok(true)
}

#[tauri::command]
async fn write_export_files_with_save_dialog(
    app: tauri::AppHandle,
    files: Vec<ExportFilePayload>,
    suggested_name: Option<String>,
) -> Result<bool, String> {
    let mut dialog = app.dialog().file().set_title("Save Export Location");
    if let Some(name) = suggested_name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            dialog = dialog.set_file_name(trimmed.to_string());
        }
    }

    let selection = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(selection) = selection else {
        return Ok(false);
    };
    let selected_path = resolve_dialog_file_path(selection)?;
    let dir = if selected_path.is_dir() {
        selected_path
    } else {
        selected_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "selected path has no parent directory".to_string())?
    };
    write_export_files_to_directory(&dir, files)?;
    Ok(true)
}

#[tauri::command]
async fn write_export_file_with_save_dialog(
    app: tauri::AppHandle,
    file: ExportFilePayload,
    suggested_name: Option<String>,
    default_directory: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("Save Export File");

    if let Some(dir) = default_directory {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            let p = normalize_to_absolute_path(trimmed)?;
            if p.is_dir() {
                dialog = dialog.set_directory(&p);
            }
        }
    }

    let mut suggested = suggested_name
        .unwrap_or_else(|| file.name.clone())
        .trim()
        .to_string();
    if suggested.is_empty() {
        suggested = file.name.trim().to_string();
    }
    if !suggested.is_empty() {
        dialog = dialog.set_file_name(suggested);
    }

    let selection = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(selection) = selection else {
        return Ok(None);
    };

    let selected_path = resolve_dialog_file_path(selection)?;
    let save_path = if selected_path.is_dir() {
        let base_name = file.name.trim();
        if base_name.is_empty() {
            return Err("file name is empty".into());
        }
        selected_path.join(base_name)
    } else {
        selected_path
    };

    let parent = save_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "selected path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err("target directory does not exist".into());
    }
    if !is_allowed_write_extension(save_path.extension().and_then(|e| e.to_str())) {
        return Err("file extension not allowed".into());
    }

    std::fs::write(&save_path, file.data).map_err(|e| format!("write failed: {}", e))?;
    Ok(Some(normalize_device_path(&parent.to_string_lossy())))
}

#[tauri::command]
fn show_current_window(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|e| format!("show failed: {}", e))
}

fn center_window_on_monitor(window: &tauri::Window) -> Result<(), String> {
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|e| format!("current_monitor failed: {}", e))?
    {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let win_size = window
            .outer_size()
            .map_err(|e| format!("outer_size failed: {}", e))?;
        let x = monitor_pos.x + ((monitor_size.width as i32 - win_size.width as i32) / 2).max(0);
        let y = monitor_pos.y + ((monitor_size.height as i32 - win_size.height as i32) / 2).max(0);
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
            .map_err(|e| format!("set_position failed: {}", e))?;
        return Ok(());
    }
    window.center().map_err(|e| format!("center failed: {}", e))
}

#[tauri::command]
fn toggle_current_window_fullscreen(window: tauri::Window) -> Result<bool, String> {
    let is_fullscreen = window
        .is_fullscreen()
        .map_err(|e| format!("is_fullscreen failed: {}", e))?;
    if is_fullscreen {
        window
            .set_fullscreen(false)
            .map_err(|e| format!("set_fullscreen failed: {}", e))?;
        center_window_on_monitor(&window)?;
        return Ok(false);
    }
    center_window_on_monitor(&window)?;
    window
        .set_fullscreen(true)
        .map_err(|e| format!("set_fullscreen failed: {}", e))?;
    Ok(true)
}

#[tauri::command]
async fn pick_export_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose Export Folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(folder) = folder else {
        return Ok(None);
    };
    let path = resolve_dialog_file_path(folder)?;
    Ok(Some(normalize_device_path(&path.to_string_lossy())))
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
    format!("file-{}", uuid::Uuid::new_v4())
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

fn spawn_additional_window(
    app_handle: &tauri::AppHandle,
    saved_window_state: Option<&SavedWindowState>,
    pending_path: Option<String>,
) {
    let label = next_window_label();
    if let Some(path) = pending_path {
        if let Ok(mut guard) = app_handle.state::<PendingFiles>().0.lock() {
            guard.insert(label.clone(), path);
        }
    }
    if let Ok(window) = tauri::WebviewWindowBuilder::new(
        app_handle,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("cdpaint")
    .visible(false)
    .decorations(false)
    .shadow(true)
    .resizable(true)
    .inner_size(1920.0, 1057.0)
    .min_inner_size(MIN_WINDOW_WIDTH as f64, MIN_WINDOW_HEIGHT as f64)
    .build()
    {
        enforce_min_window_size(&window);
        let should_restore_maximized =
            apply_startup_window_state(&window, saved_window_state, true);
        install_maximized_resizable_guard(&window, should_restore_maximized);
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingFiles(Mutex::new(HashMap::new())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = collect_image_paths(argv.into_iter());
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let saved_window_state = read_saved_window_state(&app_handle);
                if paths.is_empty() {
                    // Relaunch from desktop/taskbar shortcut without file args:
                    // open a fresh blank window in the running instance.
                    spawn_additional_window(&app_handle, saved_window_state.as_ref(), None);
                    return;
                }
                for path in paths {
                    let windows = app_handle.webview_windows();
                    if windows.is_empty() {
                        let _ = app_handle.emit("open-file", path);
                        continue;
                    }
                    spawn_additional_window(&app_handle, saved_window_state.as_ref(), Some(path));
                }
            });
        }))
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_version,
            updater_check,
            updater_download_and_install,
            get_pending_file,
            read_image_file,
            write_allowed_file,
            write_export_files,
            write_export_files_with_dialog,
            write_export_files_with_save_dialog,
            write_export_file_with_save_dialog,
            show_current_window,
            toggle_current_window_fullscreen,
            pick_export_folder,
            scan_project,
            read_project_sources,
            patch_source_file,
            read_text_file
        ])
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                enforce_min_window_size(&main_window);
                install_window_state_persistence(&app.handle().clone(), &main_window);
            }
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = first_file_path(args.into_iter().skip(1)) {
                // Queue the startup file immediately so the frontend can pull it
                // on first boot without waiting for an artificial delay.
                if let Ok(mut guard) = app.state::<PendingFiles>().0.lock() {
                    guard.insert("main".to_string(), path);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_path_dots_removes_dot_and_dotdot() {
        let p = Path::new(r"C:\Users\me\Pictures\..\..\evil.png");
        let resolved = resolve_path_dots(p);
        assert_eq!(resolved, Path::new(r"C:\Users\evil.png"));
    }

    #[test]
    fn resolve_path_dots_cannot_climb_above_root() {
        // All `..` that would climb above the drive root are dropped, so the
        // path can never escape the absolute root via traversal.
        let p = Path::new(r"C:\a\b\c\..\..\..\..\evil.png");
        let resolved = resolve_path_dots(p);
        assert_eq!(resolved, Path::new(r"C:\evil.png"));
        assert!(resolved.is_absolute());
        assert!(!resolved.to_string_lossy().contains(".."));
    }

    #[test]
    fn normalize_to_absolute_path_blocks_traversal() {
        let p = normalize_to_absolute_path(r"C:\Users\me\Pictures\..\..\evil.png")
            .expect("should normalize");
        assert_eq!(p, Path::new(r"C:\Users\evil.png"));
    }
}
