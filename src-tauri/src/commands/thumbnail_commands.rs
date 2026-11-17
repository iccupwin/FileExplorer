#![allow(unexpected_cfgs)] // objc 0.2 macros reference cfg(feature = "cargo-clippy")
//! Finder-style thumbnails, cached on disk.
//!
//! * Raster images (jpg, png, gif, webp, bmp, tiff, ico) are decoded and downscaled
//!   in-process with the `image` crate on a pool of blocking threads.
//! * Everything else (PDF, video, HEIC, ...) is rendered by macOS Quick Look
//!   (`/usr/bin/qlmanage -t`).
//!
//! Results are stored as PNG files in `~/Library/Caches/com.explr.app/thumbnails`,
//! keyed by path + mtime + size, so a file is only rendered again after it changes.

use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use tokio::sync::Semaphore;

/// Image formats decoded in-process.
const RASTER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "ico"];

/// Limits how many images are decoded at once (one per CPU core).
static DECODE_LIMIT: Lazy<Semaphore> = Lazy::new(|| {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    Semaphore::new(cores.clamp(2, 12))
});

/// Limits how many Quick Look processes run at once.
#[cfg(target_os = "macos")]
static QL_LIMIT: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(4));

fn cache_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let dir = PathBuf::from(home).join("Library/Caches/com.explr.app/thumbnails");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn is_raster(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| RASTER_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Decodes `src`, scales it to fit `size`×`size` and writes a PNG to `out` (atomically).
fn render_raster(src: &str, out: &Path, size: u32) -> Result<(), String> {
    let reader = image::ImageReader::open(src)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let img = reader.decode().map_err(|e| e.to_string())?;

    let thumb = if img.width() > size || img.height() > size {
        img.thumbnail(size, size)
    } else {
        img
    };

    let tmp = out.with_extension(format!("{}.tmp", std::process::id()));
    thumb
        .save_with_format(&tmp, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Returns the absolute path of a PNG thumbnail for `path`, generating it if needed.
///
/// # Arguments
/// * `path` - Absolute path of a local file
/// * `size` - Maximum thumbnail edge in pixels (default 256, clamped to 32..=1024)
#[tauri::command]
pub async fn get_thumbnail(path: String, size: Option<u32>) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::time::UNIX_EPOCH;

    let size = size.unwrap_or(256).clamp(32, 1024);
    let meta = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Not a file".to_string());
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = Sha256::new();
    hasher.update(format!("{}\0{}\0{}\0{}", path, mtime, meta.len(), size));
    let key = hex::encode(&hasher.finalize()[..16]);

    let dir = cache_dir()?;
    let out = dir.join(format!("{key}.png"));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }

    if is_raster(&path) {
        let _permit = DECODE_LIMIT.acquire().await.map_err(|e| e.to_string())?;
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let (src, dst) = (path.clone(), out.clone());
        let rendered = tokio::task::spawn_blocking(move || render_raster(&src, &dst, size))
            .await
            .map_err(|e| e.to_string())?;
        match rendered {
            Ok(()) => return Ok(out.to_string_lossy().into_owned()),
            // Unusual encodings: fall through to Quick Look on macOS
            Err(e) => {
                if !cfg!(target_os = "macos") {
                    return Err(e);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Stdio;
        use std::time::Duration;

        let _permit = QL_LIMIT.acquire().await.map_err(|e| e.to_string())?;
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }

        // qlmanage names the output after the source file, so render into a private temp dir
        let tmp = tempfile::tempdir_in(&dir).map_err(|e| e.to_string())?;
        let child = tokio::process::Command::new("/usr/bin/qlmanage")
            .arg("-t")
            .arg("-s")
            .arg(size.to_string())
            .arg("-o")
            .arg(tmp.path())
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status();

        match tokio::time::timeout(Duration::from_secs(20), child).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => return Err("Thumbnail generation timed out".to_string()),
        }

        let produced = std::fs::read_dir(tmp.path())
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "png").unwrap_or(false))
            .ok_or("No thumbnail available for this file")?;

        std::fs::rename(&produced, &out).map_err(|e| e.to_string())?;
        Ok(out.to_string_lossy().into_owned())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("No thumbnail available for this file".to_string())
    }
}

/// Folder names whose system icon differs from the generic folder icon.
#[cfg(target_os = "macos")]
const SPECIAL_DIR_EXTENSIONS: &[&str] = &["app", "bundle", "framework", "plugin", "appex", "kext", "prefPane", "xcodeproj", "xcworkspace", "photoslibrary", "musiclibrary", "rtfd", "pages", "numbers", "key"];

/// What a system icon is drawn from.
#[cfg(target_os = "macos")]
enum IconSource {
    /// The icon of this exact file or folder (apps, disks, special folders).
    Path(String),
    /// The generic icon of a type: a file extension or a UTI such as "public.folder".
    /// Used for shared cache entries so one unusual item can't change them.
    FileType(String),
}

/// Renders a Finder icon at `size`×`size` pixels and writes it as PNG.
#[cfg(target_os = "macos")]
fn render_system_icon(source: &IconSource, out: &Path, size: u32) -> Result<(), String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::c_void;

    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let icon: id = match source {
                IconSource::Path(path) => {
                    let ns_path: id = NSString::alloc(nil).init_str(path);
                    let _: id = msg_send![ns_path, autorelease];
                    msg_send![workspace, iconForFile: ns_path]
                }
                IconSource::FileType(file_type) => {
                    let ns_type: id = NSString::alloc(nil).init_str(file_type);
                    let _: id = msg_send![ns_type, autorelease];
                    msg_send![workspace, iconForFileType: ns_type]
                }
            };
            if icon == nil {
                return Err("No icon".to_string());
            }

            let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size as f64, size as f64));
            let cg_image: *mut c_void = msg_send![icon,
                CGImageForProposedRect: &mut rect as *mut NSRect
                context: nil
                hints: nil];
            if cg_image.is_null() {
                return Err("Could not render icon".to_string());
            }

            let rep: id = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: id = msg_send![rep, initWithCGImage: cg_image];
            if rep == nil {
                return Err("Could not create bitmap".to_string());
            }
            let _: id = msg_send![rep, autorelease];

            let props: id = msg_send![class!(NSDictionary), dictionary];
            // NSBitmapImageFileTypePNG = 4
            let data: id = msg_send![rep, representationUsingType: 4usize properties: props];
            if data == nil {
                return Err("Could not encode icon".to_string());
            }
            let len: usize = msg_send![data, length];
            let bytes: *const u8 = msg_send![data, bytes];
            if bytes.is_null() || len == 0 {
                return Err("Empty icon data".to_string());
            }
            Ok(std::slice::from_raw_parts(bytes, len).to_vec())
        })();
        let _: () = msg_send![pool, drain];

        let mut png = result?;
        // AppKit may return a larger representation (e.g. 256 px); scale to the exact
        // size so drag images and cache entries have the requested dimensions.
        if let Ok(img) = image::load_from_memory_with_format(&png, image::ImageFormat::Png) {
            if img.width() != size || img.height() != size {
                let resized = img.resize_exact(size, size, image::imageops::FilterType::Lanczos3);
                let mut buf = std::io::Cursor::new(Vec::new());
                if resized.write_to(&mut buf, image::ImageFormat::Png).is_ok() {
                    png = buf.into_inner();
                }
            }
        }
        let tmp = out.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&tmp, &png).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, out).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
    }
}

/// Limits concurrent icon rendering.
#[cfg(target_os = "macos")]
static ICON_LIMIT: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(4));

/// Returns the absolute path of a PNG with the Finder icon for `path`.
///
/// Icons are cached per file extension (and per path for special folders such as
/// app bundles and the home-folder shortcuts), so most calls are a cache hit.
///
/// # Arguments
/// * `path` - Absolute path of a local file or folder
/// * `is_directory` - Whether `path` is a folder
/// * `size` - Icon edge in pixels (default 128, clamped to 16..=512)
#[tauri::command]
pub async fn get_file_icon(path: String, is_directory: bool, size: Option<u32>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use sha2::{Digest, Sha256};

        let size = size.unwrap_or(128).clamp(16, 512);
        let p = Path::new(&path);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();

        let home = std::env::var("HOME").unwrap_or_default();
        let parent_is_home = p.parent().map(|d| d.to_string_lossy() == home).unwrap_or(false);
        // A folder is a mount point (disk root) when it sits on another device than its parent
        let is_mount_point = || {
            use std::os::unix::fs::MetadataExt;
            match (std::fs::metadata(p), p.parent().map(std::fs::metadata)) {
                (Ok(m), Some(Ok(parent))) => m.dev() != parent.dev(),
                (Ok(_), None) => true, // "/"
                _ => false,
            }
        };
        let is_special_dir = is_directory
            && (parent_is_home
                || path == home
                || path == "/"
                || path == "/Applications"
                || path.starts_with("/Volumes/")
                || SPECIAL_DIR_EXTENSIONS.iter().any(|s| s.eq_ignore_ascii_case(&ext))
                || p.join("Icon\r").exists() // custom folder icon
                || is_mount_point());

        let (key_source, source) = if is_special_dir || (!is_directory && ext.is_empty()) || ext == "app" {
            (format!("path\0{path}"), IconSource::Path(path.clone()))
        } else if is_directory {
            ("folder".to_string(), IconSource::FileType("public.folder".to_string()))
        } else {
            (format!("ext\0{ext}"), IconSource::FileType(ext.clone()))
        };

        let mut hasher = Sha256::new();
        hasher.update(format!("icon\0{key_source}\0{size}"));
        let key = hex::encode(&hasher.finalize()[..16]);

        // v2: shared entries are drawn from the type, not from the first item seen
        let base = cache_dir()?;
        let _ = std::fs::remove_dir_all(base.join("icons")); // old, possibly wrong entries
        let dir = base.join("icons-v2");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(format!("{key}.png"));
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }

        let _permit = ICON_LIMIT.acquire().await.map_err(|e| e.to_string())?;
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let dst = out.clone();
        tokio::task::spawn_blocking(move || render_system_icon(&source, &dst, size))
            .await
            .map_err(|e| e.to_string())??;
        Ok(out.to_string_lossy().into_owned())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, is_directory, size);
        Err("System icons are only supported on macOS".to_string())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod icon_tests {
    use super::*;

    #[test]
    fn generic_icons_render_from_type() {
        let dir = tempfile::tempdir().unwrap();
        for (name, ty) in [("folder.png", "public.folder"), ("pdf.png", "pdf")] {
            let out = dir.path().join(name);
            render_system_icon(&IconSource::FileType(ty.to_string()), &out, 64).unwrap();
            let img = image::open(&out).unwrap();
            assert_eq!((img.width(), img.height()), (64, 64));
            if let Ok(dest) = std::env::var("EXPLR_ICON_TEST_OUT") {
                std::fs::copy(&out, std::path::Path::new(&dest).join(name)).unwrap();
            }
        }
    }
}
