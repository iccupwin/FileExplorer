//! Moving / copying items dropped onto a folder (drag and drop).
//!
//! Finder semantics: within the same volume items are moved, across volumes
//! they are copied. Name clashes get a numbered name ("photo 2.jpg") instead
//! of overwriting anything.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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
    (2..)
        .map(|n| dir.join(format!("{stem} {n}{ext}")))
        .find(|p| fs::symlink_metadata(p).is_err())
        .expect("unbounded search always finds a free name")
}

/// Copies a file, symlink or whole folder tree to `dst`.
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
        return Ok(());
    }
    // On macOS this uses clonefile/fcopyfile: instant on APFS, keeps metadata
    fs::copy(src, dst).map(|_| ())
}

#[cfg(unix)]
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_volume(_a: &Path, _b: &Path) -> bool {
    false
}

/// Moves or copies one item into `target_dir`. Returns the new path, or None
/// when nothing had to be done (item already in that folder).
pub fn transfer_one(src: &Path, target_dir: &Path, force_copy: bool) -> Result<Option<PathBuf>, String> {
    let name = src
        .file_name()
        .ok_or_else(|| format!("Invalid path: {}", src.display()))?
        .to_string_lossy()
        .to_string();

    let src_canon = fs::canonicalize(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let dir_canon = fs::canonicalize(target_dir).map_err(|e| format!("{}: {e}", target_dir.display()))?;

    if !force_copy && src_canon.parent() == Some(dir_canon.as_path()) {
        return Ok(None); // dropped back onto its own folder
    }
    if dir_canon.starts_with(&src_canon) {
        return Err(format!("Cannot move \"{name}\" into itself"));
    }

    let dst = unique_destination(&dir_canon, &name);
    if !force_copy && same_volume(&src_canon, &dir_canon) {
        fs::rename(&src_canon, &dst).map_err(|e| format!("Could not move \"{name}\": {e}"))?;
    } else {
        copy_recursive(&src_canon, &dst).map_err(|e| {
            let _ = if dst.is_dir() { fs::remove_dir_all(&dst) } else { fs::remove_file(&dst) };
            format!("Could not copy \"{name}\": {e}")
        })?;
    }
    Ok(Some(dst))
}

/// Moves (same volume) or copies (other volume, or `mode == "copy"`) items into a folder.
///
/// # Arguments
/// * `paths` - Absolute paths of the dropped items
/// * `target_dir` - Folder they were dropped on
/// * `mode` - "auto" (default, Finder behaviour) or "copy"
///
/// # Returns
/// New paths of the transferred items. Fails with a message listing every item that failed.
#[tauri::command]
pub async fn transfer_items(paths: Vec<String>, target_dir: String, mode: Option<String>) -> Result<Vec<String>, String> {
    let force_copy = mode.as_deref() == Some("copy");
    tokio::task::spawn_blocking(move || {
        let target = PathBuf::from(&target_dir);
        if !target.is_dir() {
            return Err(format!("Not a folder: {target_dir}"));
        }
        let mut done = Vec::new();
        let mut errors = Vec::new();
        for p in &paths {
            match transfer_one(Path::new(p), &target, force_copy) {
                Ok(Some(dst)) => done.push(dst.to_string_lossy().into_owned()),
                Ok(None) => {}
                Err(e) => errors.push(e),
            }
        }
        if errors.is_empty() {
            Ok(done)
        } else {
            Err(errors.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let moved = transfer_one(&src_dir.join("tree"), &dst_dir, false).unwrap().unwrap();
        assert!(moved.ends_with("tree"));
        assert!(fs::read(moved.join("inner/f.txt")).is_ok());
        assert!(!src_dir.join("tree").exists(), "move must remove the original");

        // Dropping onto its own folder does nothing
        assert!(transfer_one(&moved, &dst_dir, false).unwrap().is_none());
    }

    #[test]
    fn copy_keeps_original_and_renames() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("doc.pdf"), b"pdf").unwrap();
        let copy = transfer_one(&root.path().join("doc.pdf"), root.path(), true).unwrap().unwrap();
        assert_eq!(copy.file_name().unwrap(), "doc 2.pdf");
        assert!(root.path().join("doc.pdf").exists());
    }

    #[test]
    fn refuses_moving_folder_into_itself() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("p");
        fs::create_dir_all(parent.join("child")).unwrap();
        assert!(transfer_one(&parent, &parent.join("child"), false).is_err());
    }
}
