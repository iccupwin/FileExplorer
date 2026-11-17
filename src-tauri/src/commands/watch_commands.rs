//! Live refresh: watches the folder that is currently open and tells the UI
//! when its contents change on disk (downloads, Finder operations, etc.).

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Event sent to the frontend; payload is the watched folder path.
pub const DIRECTORY_CHANGED_EVENT: &str = "directory-changed";

/// Changes are collected for this long before the UI is notified once.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// Only one folder (the open one) is watched at a time.
static ACTIVE: Lazy<Mutex<Option<(PathBuf, RecommendedWatcher)>>> = Lazy::new(|| Mutex::new(None));

/// True when `event` touches a direct child of `dir` (or `dir` itself).
fn affects_folder(event: &Event, dir: &Path) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event
        .paths
        .iter()
        .any(|p| p == dir || p.parent().map(|parent| parent == dir).unwrap_or(false))
}

/// Starts watching `path` (replacing the previously watched folder).
/// Emits `directory-changed` with the folder path after changes settle.
#[tauri::command]
pub fn watch_directory(app: AppHandle, path: String) -> Result<(), String> {
    let mut active = ACTIVE.lock().map_err(|_| "Watcher lock poisoned")?;
    let dir = PathBuf::from(&path);

    if let Some((current, _)) = active.as_ref() {
        if *current == dir {
            return Ok(());
        }
    }
    // Dropping the old watcher also ends its debounce thread
    *active = None;

    if path.starts_with("sftp:") || !dir.is_dir() {
        return Ok(());
    }

    let (tx, rx) = channel::<()>();
    // FSEvents reports resolved paths (e.g. /private/var for /var)
    let watched = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if affects_folder(&event, &watched) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let payload = path.clone();
    std::thread::spawn(move || {
        // Wait for a change, then keep collecting until things are quiet
        while rx.recv().is_ok() {
            let deadline = Instant::now() + DEBOUNCE;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit(DIRECTORY_CHANGED_EVENT, &payload);
        }
    });

    *active = Some((dir, watcher));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, AccessKind};

    fn event(kind: EventKind, path: &str) -> Event {
        Event::new(kind).add_path(PathBuf::from(path))
    }

    #[test]
    fn direct_children_count_nested_do_not() {
        let dir = Path::new("/Users/a/Downloads");
        assert!(affects_folder(&event(EventKind::Create(CreateKind::File), "/Users/a/Downloads/x.zip"), dir));
        assert!(!affects_folder(&event(EventKind::Create(CreateKind::File), "/Users/a/Downloads/sub/x.zip"), dir));
        assert!(!affects_folder(&event(EventKind::Access(AccessKind::Read), "/Users/a/Downloads/x.zip"), dir));
    }

    #[test]
    fn real_file_creation_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(tmp.path()).unwrap();
        let (tx, rx) = channel::<()>();
        let watched = dir.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                if affects_folder(&ev, &watched) {
                    let _ = tx.send(());
                }
            }
        })
        .unwrap();
        watcher.watch(tmp.path(), RecursiveMode::NonRecursive).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(tmp.path().join("new.txt"), b"x").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok(), "no change event received");
    }
}
