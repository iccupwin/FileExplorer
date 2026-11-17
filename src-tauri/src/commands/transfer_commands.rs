//! Moving / copying items (drag and drop, paste, "Move to…").
//!
//! Finder semantics: in "auto" mode items are moved within the same volume and
//! copied across volumes. Name clashes are resolved by the `conflict` mode:
//! a numbered name ("photo 2.jpg", default), replacing the existing item (it is
//! moved to the Trash first) or skipping the item.
//!
//! Long transfers report progress through a Tauri channel and can be cancelled
//! with [`cancel_transfer`]: the running job stops between items or between
//! chunks of a large file, removes the partially written item and keeps the
//! items that were already finished.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Files bigger than this are copied in chunks (progress + cancellation mid-file).
const CHUNKED_COPY_THRESHOLD: u64 = 32 * 1024 * 1024;
/// Chunk size for large file copies.
const CHUNK_SIZE: usize = 8 * 1024 * 1024;
/// Minimum time between two progress messages (~10 per second).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// One transferred item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferResult {
    /// Path of the item before the transfer (as passed in)
    pub source: String,
    /// New path of the item (or of the copy)
    pub destination: String,
    /// "move" or "copy"
    pub operation: String,
}

/// Progress message sent through the `onProgress` channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TransferProgress {
    pub job_id: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_items: u64,
    pub total_items: u64,
    /// Source path of the top-level item currently being transferred
    pub current: String,
    pub finished: bool,
    pub cancelled: bool,
}

/// How items are transferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferMode {
    /// Move within the same volume, copy across volumes
    Auto,
    Copy,
    /// Always move (copy + delete source across volumes)
    Move,
}

impl TransferMode {
    pub fn parse(mode: Option<&str>) -> Result<Self, String> {
        match mode.unwrap_or("auto") {
            "auto" | "" => Ok(Self::Auto),
            "copy" => Ok(Self::Copy),
            "move" => Ok(Self::Move),
            other => Err(format!("Unknown transfer mode \"{other}\"")),
        }
    }
}

/// What happens when an item with the same name already exists in the target folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictMode {
    /// Give the new item a numbered name
    KeepBoth,
    /// Move the existing item to the Trash, then transfer
    Replace,
    /// Leave the existing item and don't transfer this one
    Skip,
}

impl ConflictMode {
    pub fn parse(conflict: Option<&str>) -> Result<Self, String> {
        match conflict.unwrap_or("keep_both") {
            "keep_both" | "" => Ok(Self::KeepBoth),
            "replace" => Ok(Self::Replace),
            "skip" => Ok(Self::Skip),
            other => Err(format!("Unknown conflict mode \"{other}\"")),
        }
    }
}

/// Cancellation flags of running transfers, by job id.
static JOBS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Returns a path inside `dir` for `name` that does not exist yet
/// ("name.ext", then "name 2.ext", "name 3.ext", ...).
pub fn unique_destination(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if fs::symlink_metadata(&candidate).is_err() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut n: u64 = 2;
    loop {
        let candidate = dir.join(format!("{stem} {n}{ext}"));
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
        n += 1;
    }
}

/// Copies a file, symlink or whole folder tree to `dst` (no progress, no cancellation).
pub fn copy_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(src)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, dst)?;
        #[cfg(not(unix))]
        fs::copy(src, dst).map(|_| ())?;
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        fs::set_permissions(dst, meta.permissions())?;
        set_times_from(dst, &meta);
        return Ok(());
    }
    // On macOS this uses clonefile/fcopyfile: instant on APFS, keeps metadata
    fs::copy(src, dst).map(|_| ())
}

/// Removes a file, symlink or folder tree (best effort helper for cleanups).
pub fn remove_any(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Copies modification and access time of `meta` onto `path`.
fn set_times_from(path: &Path, meta: &fs::Metadata) {
    let mut times = fs::FileTimes::new();
    if let Ok(modified) = meta.modified() {
        times = times.set_modified(modified);
    }
    if let Ok(accessed) = meta.accessed() {
        times = times.set_accessed(accessed);
    }
    if let Ok(file) = fs::File::open(path) {
        let _ = file.set_times(times);
    }
}

/// True when both paths live on the same volume. `a` is not followed if it is a symlink.
#[cfg(unix)]
pub fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
pub fn same_volume(_a: &Path, _b: &Path) -> bool {
    false
}

/// Number of entries and bytes of regular files in a tree (symlinks are not followed).
pub fn tree_totals(path: &Path) -> (u64, u64) {
    let mut bytes = 0;
    let mut items = 0;
    for entry in walkdir::WalkDir::new(path).follow_links(false).into_iter().filter_map(Result::ok) {
        items += 1;
        if entry.file_type().is_file() {
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    (bytes, items)
}

/// Moves `path` to the Trash (used by the "replace" conflict mode).
fn trash_existing(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        super::macos_commands::trash_path(path).map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path).map_err(|e| format!("Could not move \"{}\" to the Trash: {e}", path.display()))
    }
}

/// Why an item was not finished.
#[derive(Debug)]
enum StepError {
    Cancelled,
    Failed(String),
}

/// Paths of a source item, resolved once before the transfer starts.
struct PlannedItem {
    /// Path as passed in by the caller
    given: String,
    /// Absolute path with resolved parent folder (the item itself is not followed if it is a symlink)
    resolved: PathBuf,
    name: String,
    in_target_dir: bool,
    is_move: bool,
    bytes: u64,
    items: u64,
}

/// A running transfer: settings, progress state and the cancellation flag.
pub struct TransferJob<'a> {
    pub mode: TransferMode,
    pub conflict: ConflictMode,
    cancel: Arc<AtomicBool>,
    on_progress: Option<Box<dyn FnMut(&TransferProgress) + 'a>>,
    trash: Box<dyn Fn(&Path) -> Result<(), String> + 'a>,
    progress: TransferProgress,
    last_emit: Option<Instant>,
    /// Tunables (tests use small values)
    pub chunk_threshold: u64,
    pub chunk_size: usize,
    pub progress_interval: Duration,
    /// Try an APFS clone before copying a large file in chunks
    pub allow_clone: bool,
}

/// What a finished job produced.
#[derive(Debug, Default)]
pub struct TransferOutcome {
    pub results: Vec<TransferResult>,
    pub errors: Vec<String>,
    pub cancelled: bool,
}

impl<'a> TransferJob<'a> {
    pub fn new(job_id: &str, mode: TransferMode, conflict: ConflictMode, cancel: Arc<AtomicBool>) -> Self {
        Self {
            mode,
            conflict,
            cancel,
            on_progress: None,
            trash: Box::new(trash_existing),
            progress: TransferProgress { job_id: job_id.to_string(), ..Default::default() },
            last_emit: None,
            chunk_threshold: CHUNKED_COPY_THRESHOLD,
            chunk_size: CHUNK_SIZE,
            progress_interval: PROGRESS_INTERVAL,
            allow_clone: true,
        }
    }

    pub fn with_progress(mut self, f: impl FnMut(&TransferProgress) + 'a) -> Self {
        self.on_progress = Some(Box::new(f));
        self
    }

    /// Replaces the Trash used by "replace" (tests use a temp folder).
    #[cfg(test)]
    pub fn with_trash(mut self, f: impl Fn(&Path) -> Result<(), String> + 'a) -> Self {
        self.trash = Box::new(f);
        self
    }

    fn emit(&mut self) {
        self.last_emit = Some(Instant::now());
        if let Some(cb) = self.on_progress.as_mut() {
            cb(&self.progress);
        }
    }

    fn maybe_emit(&mut self) {
        let due = match self.last_emit {
            None => true,
            Some(t) => t.elapsed() >= self.progress_interval,
        };
        if due {
            self.emit();
        }
    }

    fn advance(&mut self, bytes: u64, items: u64) {
        self.progress.done_bytes += bytes;
        self.progress.done_items += items;
        self.maybe_emit();
    }

    fn check_cancel(&self) -> Result<(), StepError> {
        if self.cancel.load(Ordering::SeqCst) {
            Err(StepError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Resolves the sources and computes the totals. Items that need no work
    /// (already in the folder, or skipped because of a name clash) are left out.
    fn plan(&self, paths: &[String], target_canon: &Path) -> (Vec<PlannedItem>, Vec<String>) {
        let mut planned = Vec::new();
        let mut errors = Vec::new();
        for given in paths {
            let src = Path::new(given);
            let name = match src.file_name() {
                Some(n) => n.to_string_lossy().into_owned(),
                None => {
                    errors.push(format!("Invalid path: {given}"));
                    continue;
                }
            };
            // Resolve the parent only, so a symlink is moved as a link, not its target
            let parent = match src.parent() {
                Some(p) if !p.as_os_str().is_empty() => p,
                _ => Path::new("."),
            };
            let resolved = match fs::canonicalize(parent) {
                Ok(p) => p.join(&name),
                Err(e) => {
                    errors.push(format!("{given}: {e}"));
                    continue;
                }
            };
            if let Err(e) = fs::symlink_metadata(&resolved) {
                errors.push(format!("{given}: {e}"));
                continue;
            }

            let in_target_dir = resolved.parent() == Some(target_canon);
            let is_move = match self.mode {
                TransferMode::Copy => false,
                TransferMode::Move => true,
                TransferMode::Auto => same_volume(&resolved, target_canon),
            };
            if in_target_dir && is_move {
                continue; // dropped back onto its own folder
            }
            if target_canon.starts_with(&resolved) {
                let verb = if is_move { "move" } else { "copy" };
                errors.push(format!("Cannot {verb} \"{name}\" into itself"));
                continue;
            }
            if !in_target_dir
                && self.conflict == ConflictMode::Skip
                && fs::symlink_metadata(target_canon.join(&name)).is_ok()
            {
                continue;
            }
            let (bytes, items) = tree_totals(&resolved);
            planned.push(PlannedItem { given: given.clone(), resolved, name, in_target_dir, is_move, bytes, items });
        }
        (planned, errors)
    }

    /// Transfers `paths` into `target_dir`.
    pub fn run(&mut self, paths: &[String], target_dir: &Path) -> Result<TransferOutcome, String> {
        if !target_dir.is_dir() {
            return Err(format!("Not a folder: {}", target_dir.display()));
        }
        let target_canon =
            fs::canonicalize(target_dir).map_err(|e| format!("{}: {e}", target_dir.display()))?;

        let (planned, mut errors) = self.plan(paths, &target_canon);
        self.progress.total_bytes = planned.iter().map(|p| p.bytes).sum();
        self.progress.total_items = planned.iter().map(|p| p.items).sum();
        self.emit();

        let mut outcome = TransferOutcome::default();
        for item in &planned {
            if self.cancel.load(Ordering::SeqCst) {
                outcome.cancelled = true;
                break;
            }
            self.progress.current = item.given.clone();
            let base_bytes = self.progress.done_bytes;
            let base_items = self.progress.done_items;

            match self.transfer_item(item, target_dir, &target_canon) {
                Ok(Some(result)) => outcome.results.push(result),
                Ok(None) => {}
                Err(StepError::Cancelled) => {
                    outcome.cancelled = true;
                    self.progress.done_bytes = base_bytes;
                    self.progress.done_items = base_items;
                    break;
                }
                Err(StepError::Failed(e)) => errors.push(e),
            }
            // Keep the totals exact even if files changed size meanwhile
            self.progress.done_bytes = base_bytes + item.bytes;
            self.progress.done_items = base_items + item.items;
            self.maybe_emit();
        }

        self.progress.finished = true;
        self.progress.cancelled = outcome.cancelled;
        self.emit();
        outcome.errors = errors;
        Ok(outcome)
    }

    fn transfer_item(
        &mut self,
        item: &PlannedItem,
        target_dir: &Path,
        target_canon: &Path,
    ) -> Result<Option<TransferResult>, StepError> {
        let name = &item.name;
        let dst = if item.in_target_dir {
            // Copy into its own folder: Finder's "Duplicate"
            unique_destination(target_dir, name)
        } else {
            let candidate = target_dir.join(name);
            if fs::symlink_metadata(&candidate).is_ok() {
                match self.conflict {
                    ConflictMode::Skip => return Ok(None),
                    ConflictMode::KeepBoth => unique_destination(target_dir, name),
                    ConflictMode::Replace => {
                        if item.resolved.starts_with(target_canon.join(name)) {
                            return Err(StepError::Failed(format!(
                                "Cannot replace \"{name}\" with an item it contains"
                            )));
                        }
                        (self.trash)(&candidate).map_err(StepError::Failed)?;
                        candidate
                    }
                }
            } else {
                candidate
            }
        };

        let src = &item.resolved;
        let mut operation = "copy";
        if item.is_move {
            operation = "move";
            match fs::rename(src, &dst) {
                Ok(()) => {
                    self.advance(item.bytes, item.items);
                    return Ok(Some(self.result(item, &dst, operation)));
                }
                // Different volume (or rename not supported): copy, then delete
                Err(_) if !same_volume(src, target_canon) => {}
                Err(e) => return Err(StepError::Failed(format!("Could not move \"{name}\": {e}"))),
            }
        }

        if let Err(e) = self.copy_tree(src, &dst) {
            let _ = remove_any(&dst);
            return Err(match e {
                StepError::Cancelled => StepError::Cancelled,
                StepError::Failed(msg) => StepError::Failed(format!("Could not copy \"{name}\": {msg}")),
            });
        }

        if item.is_move {
            if let Err(e) = remove_any(src) {
                // The copy is complete; the original is still (partly) there
                return Err(StepError::Failed(format!(
                    "\"{name}\" was copied but the original could not be removed: {e}"
                )));
            }
        }
        Ok(Some(self.result(item, &dst, operation)))
    }

    fn result(&self, item: &PlannedItem, dst: &Path, operation: &str) -> TransferResult {
        TransferResult {
            source: item.given.clone(),
            destination: dst.to_string_lossy().into_owned(),
            operation: operation.to_string(),
        }
    }

    /// Copies a tree with progress and cancellation. Partial output is left for the caller to remove.
    fn copy_tree(&mut self, src: &Path, dst: &Path) -> Result<(), StepError> {
        self.check_cancel()?;
        let fail = |e: io::Error| StepError::Failed(e.to_string());
        let meta = fs::symlink_metadata(src).map_err(fail)?;
        let file_type = meta.file_type();

        if file_type.is_symlink() {
            let target = fs::read_link(src).map_err(fail)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, dst).map_err(fail)?;
            #[cfg(not(unix))]
            fs::copy(src, dst).map(|_| ()).map_err(fail)?;
            self.advance(0, 1);
            return Ok(());
        }

        if file_type.is_dir() {
            fs::create_dir(dst).map_err(fail)?;
            self.advance(0, 1);
            for entry in fs::read_dir(src).map_err(fail)? {
                let entry = entry.map_err(fail)?;
                self.copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
            }
            let _ = fs::set_permissions(dst, meta.permissions());
            set_times_from(dst, &meta);
            return Ok(());
        }

        if !file_type.is_file() {
            // Sockets, FIFOs, devices: nothing sensible to copy
            self.advance(0, 1);
            return Ok(());
        }

        if meta.len() > self.chunk_threshold {
            self.copy_large_file(src, dst, &meta)?;
        } else {
            // clonefile / fcopyfile on macOS: fast and keeps all metadata
            fs::copy(src, dst).map_err(fail)?;
            self.advance(meta.len(), 0);
        }
        self.advance(0, 1);
        Ok(())
    }

    fn copy_large_file(&mut self, src: &Path, dst: &Path, meta: &fs::Metadata) -> Result<(), StepError> {
        let fail = |e: io::Error| StepError::Failed(e.to_string());

        #[cfg(target_os = "macos")]
        if self.allow_clone && clone_file(src, dst) {
            self.advance(meta.len(), 0);
            return Ok(());
        }

        let mut input = fs::File::open(src).map_err(fail)?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(dst).map_err(fail)?;
        let mut buf = vec![0u8; self.chunk_size.max(4096)];
        loop {
            self.check_cancel()?;
            let n = match input.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(fail(e)),
            };
            output.write_all(&buf[..n]).map_err(fail)?;
            self.advance(n as u64, 0);
        }
        output.flush().map_err(fail)?;

        #[cfg(target_os = "macos")]
        copy_extended_metadata(&input, &output);
        let _ = fs::set_permissions(dst, meta.permissions());
        drop(output);
        set_times_from(dst, meta);
        Ok(())
    }
}

/// APFS clone (instant, no extra space). False when not possible (other volume, other FS).
#[cfg(target_os = "macos")]
fn clone_file(src: &Path, dst: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(s), Ok(d)) = (CString::new(src.as_os_str().as_bytes()), CString::new(dst.as_os_str().as_bytes()))
    else {
        return false;
    };
    // CLONE_NOFOLLOW = 1
    unsafe { libc::clonefile(s.as_ptr(), d.as_ptr(), 1) == 0 }
}

/// Copies extended attributes (Finder tags, colours, …) and ACLs between open files.
#[cfg(target_os = "macos")]
fn copy_extended_metadata(src: &fs::File, dst: &fs::File) {
    use std::os::unix::io::AsRawFd;
    unsafe {
        libc::fcopyfile(src.as_raw_fd(), dst.as_raw_fd(), std::ptr::null_mut(), libc::COPYFILE_METADATA);
    }
}

/// Names of the items in `paths` that already exist in `target_dir`
/// (items that are already located in `target_dir` are ignored).
pub fn find_conflicts(paths: &[String], target_dir: &Path) -> Result<Vec<String>, String> {
    let target_canon = fs::canonicalize(target_dir).map_err(|e| format!("{}: {e}", target_dir.display()))?;
    let mut names = Vec::new();
    for given in paths {
        let src = Path::new(given);
        let Some(name) = src.file_name() else { continue };
        let parent = src.parent().and_then(|p| fs::canonicalize(p).ok());
        if parent.as_deref() == Some(target_canon.as_path()) {
            continue;
        }
        if fs::symlink_metadata(target_canon.join(name)).is_ok() {
            let name = name.to_string_lossy().into_owned();
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    Ok(names)
}

/// Optional progress channel argument. Tauri's `Channel` only implements
/// `CommandArg` (not `Deserialize`), so `Option<Channel<T>>` can't be used as
/// a command argument directly; this accepts a missing / null `onProgress`.
pub struct OptionalChannel<T>(pub Option<tauri::ipc::Channel<T>>);

impl<'de, R: tauri::Runtime, T> tauri::ipc::CommandArg<'de, R> for OptionalChannel<T> {
    fn from_command(command: tauri::ipc::CommandItem<'de, R>) -> Result<Self, tauri::ipc::InvokeError> {
        use std::str::FromStr;
        let name = command.name;
        let key = command.key;
        let webview = command.message.webview();
        let value: Option<String> = Deserialize::deserialize(command)
            .map_err(|e| tauri::ipc::InvokeError::from(format!("invalid args `{key}` for command `{name}`: {e}")))?;
        match value {
            None => Ok(Self(None)),
            Some(v) => tauri::ipc::JavaScriptChannelId::from_str(&v)
                .map(|id| Self(Some(id.channel_on(webview))))
                .map_err(|_| tauri::ipc::InvokeError::from(format!("invalid channel value `{v}`"))),
        }
    }
}

/// Moves or copies items into a folder.
///
/// # Arguments
/// * `paths` - Absolute paths of the items
/// * `target_dir` - Destination folder
/// * `mode` - "auto" (default: move on the same volume, copy across volumes), "copy" or "move"
/// * `conflict` - "keep_both" (default, numbered name), "replace" (existing item goes to the Trash) or "skip"
/// * `job_id` - Id used by `cancel_transfer` and in progress messages
/// * `on_progress` - Channel receiving `TransferProgress` (at most ~10 per second, plus a final one)
///
/// # Returns
/// The transferred items. A cancelled job returns the items finished so far.
/// Fails with one line per failed item.
#[tauri::command]
pub async fn transfer_items(
    paths: Vec<String>,
    target_dir: String,
    mode: Option<String>,
    conflict: Option<String>,
    job_id: Option<String>,
    on_progress: OptionalChannel<TransferProgress>,
) -> Result<Vec<TransferResult>, String> {
    let mode = TransferMode::parse(mode.as_deref())?;
    let conflict = ConflictMode::parse(conflict.as_deref())?;
    let job_id = job_id.unwrap_or_default();

    let cancel = if job_id.is_empty() {
        Arc::new(AtomicBool::new(false))
    } else {
        // A cancel that arrived before the job started is kept
        JOBS.lock().entry(job_id.clone()).or_insert_with(|| Arc::new(AtomicBool::new(false))).clone()
    };

    let id = job_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let mut job = TransferJob::new(&id, mode, conflict, cancel);
        if let Some(channel) = on_progress.0 {
            job = job.with_progress(move |p| {
                let _ = channel.send(p.clone());
            });
        }
        job.run(&paths, Path::new(&target_dir))
    })
    .await;

    if !job_id.is_empty() {
        JOBS.lock().remove(&job_id);
    }

    let outcome = outcome.map_err(|e| e.to_string())??;
    if outcome.errors.is_empty() {
        Ok(outcome.results)
    } else {
        Err(outcome.errors.join("\n"))
    }
}

/// Asks a running `transfer_items` job to stop.
#[tauri::command]
pub async fn cancel_transfer(job_id: String) -> Result<(), String> {
    if job_id.is_empty() {
        return Err("Missing job id".to_string());
    }
    JOBS.lock()
        .entry(job_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::SeqCst);
    Ok(())
}

/// Names of items that already exist in `target_dir` (to ask the user before a transfer).
#[tauri::command]
pub async fn check_conflicts(paths: Vec<String>, target_dir: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || find_conflicts(&paths, Path::new(&target_dir)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn job(mode: TransferMode, conflict: ConflictMode) -> TransferJob<'static> {
        TransferJob::new("test", mode, conflict, Arc::new(AtomicBool::new(false)))
    }

    /// Fake Trash: moves items into `trash_dir` instead of the user's Trash.
    fn fake_trash(trash_dir: PathBuf) -> impl Fn(&Path) -> Result<(), String> {
        move |p: &Path| {
            let name = p.file_name().ok_or("no name")?;
            fs::rename(p, unique_destination(&trash_dir, &name.to_string_lossy())).map_err(|e| e.to_string())
        }
    }

    fn transfer_one(src: &Path, target: &Path, mode: TransferMode) -> Option<PathBuf> {
        let outcome = job(mode, ConflictMode::KeepBoth).run(&[s(src)], target).unwrap();
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        outcome.results.first().map(|r| PathBuf::from(&r.destination))
    }

    #[test]
    fn numbered_names_on_clash() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"1").unwrap();
        fs::write(dir.path().join("a 2.txt"), b"2").unwrap();
        assert_eq!(unique_destination(dir.path(), "a.txt"), dir.path().join("a 3.txt"));
        assert_eq!(unique_destination(dir.path(), "b.txt"), dir.path().join("b.txt"));
        fs::create_dir(dir.path().join("folder")).unwrap();
        assert_eq!(unique_destination(dir.path(), "folder"), dir.path().join("folder 2"));
    }

    #[test]
    fn move_within_volume_and_skip_same_folder() {
        let root = tempfile::tempdir().unwrap();
        let src_dir = root.path().join("src");
        let dst_dir = root.path().join("dst");
        fs::create_dir_all(src_dir.join("tree/inner")).unwrap();
        fs::write(src_dir.join("tree/inner/f.txt"), b"x").unwrap();
        fs::create_dir(&dst_dir).unwrap();

        let outcome = job(TransferMode::Auto, ConflictMode::KeepBoth).run(&[s(&src_dir.join("tree"))], &dst_dir).unwrap();
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].operation, "move");
        assert_eq!(outcome.results[0].source, s(&src_dir.join("tree")));
        let moved = PathBuf::from(&outcome.results[0].destination);
        assert_eq!(moved, dst_dir.join("tree"));
        assert!(fs::read(moved.join("inner/f.txt")).is_ok());
        assert!(!src_dir.join("tree").exists(), "move must remove the original");

        // Dropping onto its own folder does nothing
        assert!(transfer_one(&moved, &dst_dir, TransferMode::Auto).is_none());
        assert!(transfer_one(&moved, &dst_dir, TransferMode::Move).is_none());
    }

    #[test]
    fn copy_keeps_original_and_renames() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("doc.pdf"), b"pdf").unwrap();
        let copy = transfer_one(&root.path().join("doc.pdf"), root.path(), TransferMode::Copy).unwrap();
        assert_eq!(copy.file_name().unwrap(), "doc 2.pdf");
        assert!(root.path().join("doc.pdf").exists());
        assert_eq!(fs::read(copy).unwrap(), b"pdf");
    }

    #[test]
    fn refuses_moving_folder_into_itself() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("p");
        fs::create_dir_all(parent.join("child")).unwrap();
        let outcome = job(TransferMode::Auto, ConflictMode::KeepBoth).run(&[s(&parent)], &parent.join("child")).unwrap();
        assert!(outcome.results.is_empty());
        assert_eq!(outcome.errors.len(), 1);
        assert!(parent.join("child").exists());
    }

    #[test]
    fn moves_symlink_itself_not_its_target() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("real.txt");
        fs::write(&target, b"x").unwrap();
        let link = root.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let dst_dir = root.path().join("dst");
        fs::create_dir(&dst_dir).unwrap();
        transfer_one(&link, &dst_dir, TransferMode::Move).unwrap();
        assert!(target.exists());
        assert!(fs::symlink_metadata(dst_dir.join("link.txt")).unwrap().file_type().is_symlink());
    }

    fn conflict_setup() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let src_dir = root.path().join("src");
        let dst_dir = root.path().join("dst");
        let trash_dir = root.path().join("trash");
        for d in [&src_dir, &dst_dir, &trash_dir] {
            fs::create_dir(d).unwrap();
        }
        fs::write(src_dir.join("a.txt"), b"new").unwrap();
        fs::write(src_dir.join("b.txt"), b"b").unwrap();
        fs::write(dst_dir.join("a.txt"), b"old").unwrap();
        (root, src_dir, dst_dir, trash_dir)
    }

    #[test]
    fn conflict_keep_both() {
        let (_root, src, dst, _trash) = conflict_setup();
        let outcome = job(TransferMode::Copy, ConflictMode::KeepBoth)
            .run(&[s(&src.join("a.txt")), s(&src.join("b.txt"))], &dst)
            .unwrap();
        assert!(outcome.errors.is_empty());
        let dests: Vec<_> = outcome.results.iter().map(|r| PathBuf::from(&r.destination)).collect();
        assert_eq!(dests, vec![dst.join("a 2.txt"), dst.join("b.txt")]);
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"old");
        assert_eq!(fs::read(dst.join("a 2.txt")).unwrap(), b"new");
    }

    #[test]
    fn conflict_replace_trashes_existing() {
        let (_root, src, dst, trash) = conflict_setup();
        let outcome = job(TransferMode::Move, ConflictMode::Replace)
            .with_trash(fake_trash(trash.clone()))
            .run(&[s(&src.join("a.txt"))], &dst)
            .unwrap();
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.results[0].destination, s(&dst.join("a.txt")));
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"new");
        assert_eq!(fs::read(trash.join("a.txt")).unwrap(), b"old");
        assert!(!src.join("a.txt").exists());
    }

    #[test]
    fn conflict_replace_never_trashes_the_source_itself() {
        let (_root, src, _dst, trash) = conflict_setup();
        // Copying into its own folder with "replace" must duplicate, not trash the original
        let outcome = job(TransferMode::Copy, ConflictMode::Replace)
            .with_trash(fake_trash(trash.clone()))
            .run(&[s(&src.join("a.txt"))], &src)
            .unwrap();
        assert_eq!(outcome.results[0].destination, s(&src.join("a 2.txt")));
        assert_eq!(fs::read(src.join("a.txt")).unwrap(), b"new");
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 0);
    }

    #[test]
    fn conflict_skip_leaves_existing() {
        let (_root, src, dst, _trash) = conflict_setup();
        let mut last = TransferProgress::default();
        let outcome = job(TransferMode::Move, ConflictMode::Skip)
            .with_progress(|p| last = p.clone())
            .run(&[s(&src.join("a.txt")), s(&src.join("b.txt"))], &dst)
            .unwrap();
        assert!(outcome.errors.is_empty());
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].destination, s(&dst.join("b.txt")));
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"old");
        assert!(src.join("a.txt").exists(), "skipped item stays where it was");
        // Skipped items are not part of the totals
        assert_eq!(last.total_items, 1);
        assert_eq!(last.total_bytes, 1);
        assert!(last.finished);
    }

    #[test]
    fn progress_totals_and_chunked_copy() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        let dst = root.path().join("dst");
        fs::create_dir_all(src.join("folder/sub")).unwrap();
        fs::create_dir(&dst).unwrap();
        fs::write(src.join("folder/one.txt"), vec![1u8; 1000]).unwrap();
        fs::write(src.join("folder/sub/two.txt"), vec![2u8; 500]).unwrap();
        let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(src.join("big.bin"), &big).unwrap();
        let mtime = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        fs::File::options().write(true).open(src.join("big.bin")).unwrap()
            .set_times(fs::FileTimes::new().set_modified(mtime)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(src.join("big.bin"), fs::Permissions::from_mode(0o640)).unwrap();
        }

        let mut messages = Vec::new();
        let mut j = job(TransferMode::Copy, ConflictMode::KeepBoth).with_progress(|p| messages.push(p.clone()));
        j.chunk_threshold = 100_000;
        j.chunk_size = 64 * 1024;
        j.allow_clone = false;
        j.progress_interval = Duration::ZERO;
        let outcome = j.run(&[s(&src.join("folder")), s(&src.join("big.bin"))], &dst).unwrap();
        drop(j);

        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.results.len(), 2);
        assert!(outcome.results.iter().all(|r| r.operation == "copy"));
        assert_eq!(fs::read(dst.join("big.bin")).unwrap(), big);
        assert_eq!(fs::read(dst.join("folder/sub/two.txt")).unwrap().len(), 500);
        let meta = fs::metadata(dst.join("big.bin")).unwrap();
        assert_eq!(meta.modified().unwrap(), mtime);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(meta.permissions().mode() & 0o777, 0o640);
        }

        let first = messages.first().unwrap();
        // folder, sub, one.txt, two.txt + big.bin
        assert_eq!(first.total_items, 5);
        assert_eq!(first.total_bytes, 1000 + 500 + 300_000);
        assert_eq!(first.done_bytes, 0);
        let last = messages.last().unwrap();
        assert!(last.finished && !last.cancelled);
        assert_eq!(last.done_bytes, last.total_bytes);
        assert_eq!(last.done_items, last.total_items);
        // Several progress messages while copying the big file in chunks
        assert!(messages.iter().filter(|m| m.current.ends_with("big.bin") && !m.finished).count() >= 4);
        // Monotonic
        assert!(messages.windows(2).all(|w| w[0].done_bytes <= w[1].done_bytes));
    }

    #[test]
    fn progress_is_throttled() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        let dst = root.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir(&dst).unwrap();
        let paths: Vec<String> = (0..200)
            .map(|i| {
                let p = src.join(format!("f{i}.txt"));
                fs::write(&p, b"x").unwrap();
                s(&p)
            })
            .collect();
        let mut count = 0;
        let outcome = job(TransferMode::Copy, ConflictMode::KeepBoth).with_progress(|_| count += 1).run(&paths, &dst).unwrap();
        assert_eq!(outcome.results.len(), 200);
        assert!(count < 20, "too many progress messages: {count}");
    }

    #[test]
    fn cancellation_mid_file_keeps_finished_items() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        let dst = root.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir(&dst).unwrap();
        fs::write(src.join("small.txt"), b"small").unwrap();
        fs::write(src.join("big.bin"), vec![7u8; 400_000]).unwrap();
        fs::write(src.join("later.txt"), b"later").unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let mut messages = Vec::new();
        let mut j = TransferJob::new("job-1", TransferMode::Copy, ConflictMode::KeepBoth, cancel).with_progress(|p| {
            messages.push(p.clone());
            // Cancel once part of the big file has been written
            if p.current.ends_with("big.bin") && p.done_bytes > 5 + 100_000 {
                flag.store(true, Ordering::SeqCst);
            }
        });
        j.chunk_threshold = 100_000;
        j.chunk_size = 50_000;
        j.allow_clone = false;
        j.progress_interval = Duration::ZERO;
        let outcome = j
            .run(&[s(&src.join("small.txt")), s(&src.join("big.bin")), s(&src.join("later.txt"))], &dst)
            .unwrap();
        drop(j);

        assert!(outcome.cancelled);
        assert!(outcome.errors.is_empty());
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].destination, s(&dst.join("small.txt")));
        assert!(dst.join("small.txt").exists(), "finished item is kept");
        assert!(!dst.join("big.bin").exists(), "partial item is removed");
        assert!(!dst.join("later.txt").exists(), "remaining items are not started");
        assert!(src.join("big.bin").exists());
        let last = messages.last().unwrap();
        assert!(last.finished && last.cancelled);
        assert_eq!(last.job_id, "job-1");
    }

    #[test]
    fn cancel_before_start_via_registry() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), b"a").unwrap();
        let dst = root.path().join("dst");
        fs::create_dir(&dst).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(cancel_transfer("pre-cancelled".into())).unwrap();
        let res = rt
            .block_on(transfer_items(
                vec![s(&root.path().join("a.txt"))],
                s(&dst),
                Some("copy".into()),
                None,
                Some("pre-cancelled".into()),
                OptionalChannel(None),
            ))
            .unwrap();
        assert!(res.is_empty());
        assert!(!dst.join("a.txt").exists());
        assert!(!JOBS.lock().contains_key("pre-cancelled"), "job entry is cleaned up");
    }

    #[test]
    fn check_conflicts_lists_names() {
        let (_root, src, dst, _trash) = conflict_setup();
        let names = find_conflicts(&[s(&src.join("a.txt")), s(&src.join("b.txt"))], &dst).unwrap();
        assert_eq!(names, vec!["a.txt".to_string()]);
        // Items already in the target folder are not conflicts
        let names = find_conflicts(&[s(&dst.join("a.txt"))], &dst).unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn parses_modes() {
        assert_eq!(TransferMode::parse(None).unwrap(), TransferMode::Auto);
        assert_eq!(TransferMode::parse(Some("move")).unwrap(), TransferMode::Move);
        assert!(TransferMode::parse(Some("teleport")).is_err());
        assert_eq!(ConflictMode::parse(None).unwrap(), ConflictMode::KeepBoth);
        assert_eq!(ConflictMode::parse(Some("skip")).unwrap(), ConflictMode::Skip);
        assert!(ConflictMode::parse(Some("x")).is_err());
    }
}
