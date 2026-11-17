#![allow(unexpected_cfgs)] // objc 0.2 macros reference cfg(feature = "cargo-clippy")
//! macOS integrations: Trash with undo, Quick Look, Finder tags, Recents,
//! "Open With", AirDrop and a few Finder helpers.
//!
//! Everything AppKit-related runs inside an autorelease pool; calls that need
//! the main thread (Quick Look panel, sharing services) are dispatched with
//! `AppHandle::run_on_main_thread`. On other platforms the commands return an
//! error (except `restore_items`, which is plain file system work).

use crate::models;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::transfer_commands::{copy_recursive, remove_any, same_volume};

/// Result of moving one item to the Trash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrashResult {
    pub original: String,
    /// New location inside the Trash (for undo)
    pub trashed: Option<String>,
    pub error: Option<String>,
}

/// One move to perform for undo (`from` → `to`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MovePair {
    pub from: String,
    pub to: String,
}

/// A Finder tag. `color`: 0 none, 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tag {
    pub name: String,
    pub color: u8,
}

/// An application that can open a file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[cfg(not(target_os = "macos"))]
fn unsupported<T>() -> Result<T, String> {
    Err("This feature is only available on macOS".to_string())
}

// ---------------------------------------------------------------------------
// Shared helpers (entries in `open_directory` shape)
// ---------------------------------------------------------------------------

fn time_or_epoch(t: io::Result<std::time::SystemTime>) -> String {
    t.map_or("1970-01-01 00:00:00".to_string(), models::format_system_time)
}

/// Builds `{"directories":[…],"files":[…]}` for arbitrary paths. Missing paths are skipped.
fn entries_json(paths: &[PathBuf], files_only: bool) -> Result<String, String> {
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for path in paths {
        let Ok(metadata) = fs::metadata(path) else { continue };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let path_str = path.to_string_lossy().into_owned();
        let is_symlink = path.is_symlink();
        if metadata.is_dir() {
            if files_only {
                continue;
            }
            directories.push(models::Directory {
                name,
                path: path_str,
                is_symlink,
                access_rights_as_string: models::get_access_permission_string(metadata.permissions(), true),
                access_rights_as_number: models::get_access_permission_number(metadata.permissions(), true),
                size_in_bytes: 0,
                sub_file_count: 0,
                sub_dir_count: 0,
                created: time_or_epoch(metadata.created()),
                last_modified: time_or_epoch(metadata.modified()),
                accessed: time_or_epoch(metadata.accessed()),
                date_added: models::date_added_string(path, &metadata),
            });
        } else if metadata.is_file() {
            files.push(models::File {
                name,
                path: path_str,
                is_symlink,
                access_rights_as_string: models::get_access_permission_string(metadata.permissions(), false),
                access_rights_as_number: models::get_access_permission_number(metadata.permissions(), false),
                size_in_bytes: metadata.len(),
                created: time_or_epoch(metadata.created()),
                last_modified: time_or_epoch(metadata.modified()),
                accessed: time_or_epoch(metadata.accessed()),
                date_added: models::date_added_string(path, &metadata),
            });
        }
    }
    serde_json::to_string(&models::Entries { directories, files }).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Undo: restore_items (all platforms)
// ---------------------------------------------------------------------------

/// `rename` that fails instead of replacing an existing `to` (atomic on macOS).
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let invalid = |e| io::Error::new(io::ErrorKind::InvalidInput, e);
        let f = CString::new(from.as_os_str().as_bytes()).map_err(invalid)?;
        let t = CString::new(to.as_os_str().as_bytes()).map_err(invalid)?;
        if unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::rename(from, to)
    }
}

/// Moves `from` to `to` without ever overwriting.
pub fn restore_one(from: &Path, to: &Path) -> Result<(), String> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(format!("\"{}\" already exists", to.display()));
    }
    fs::symlink_metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let same = to.parent().map(|p| same_volume(from, p)).unwrap_or(false);
    if same {
        match rename_no_replace(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.raw_os_error() != Some(libc::EXDEV) => {
                return Err(format!("Could not move \"{}\": {e}", from.display()))
            }
            Err(_) => {}
        }
    }
    if let Err(e) = copy_recursive(from, to) {
        let _ = remove_any(to);
        return Err(format!("Could not copy \"{}\": {e}", from.display()));
    }
    remove_any(from).map_err(|e| format!("\"{}\" was restored but the copy could not be removed: {e}", from.display()))
}

/// Moves items back (undo of trash / move / rename). Never overwrites.
///
/// # Returns
/// The restored `to` paths. If some failed, an error with one line per failure
/// (the other items are still restored).
#[tauri::command]
pub async fn restore_items(moves: Vec<MovePair>) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut done = Vec::new();
        let mut errors = Vec::new();
        for m in &moves {
            match restore_one(Path::new(&m.from), Path::new(&m.to)) {
                Ok(()) => done.push(m.to.clone()),
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

// ---------------------------------------------------------------------------
// Tags: encoding (pure, testable)
// ---------------------------------------------------------------------------

/// Parses one entry of `_kMDItemUserTags` ("Red\n6", or just "Work").
pub fn parse_tag(raw: &str) -> Tag {
    match raw.rsplit_once('\n') {
        Some((name, color)) => match color.trim().parse::<u8>() {
            Ok(c) if c <= 7 => Tag { name: name.to_string(), color: c },
            _ => Tag { name: name.to_string(), color: 0 },
        },
        None => Tag { name: raw.to_string(), color: 0 },
    }
}

pub fn format_tag(tag: &Tag) -> String {
    format!("{}\n{}", tag.name, tag.color)
}

/// Adds (or recolours) / removes a tag by name, case-insensitively like Finder.
pub fn apply_tag_change(tags: &mut Vec<Tag>, name: &str, color: u8, add: bool) {
    let existing = tags.iter().position(|t| t.name.to_lowercase() == name.to_lowercase());
    match (add, existing) {
        (true, Some(i)) => tags[i].color = color,
        (true, None) => tags.push(Tag { name: name.to_string(), color }),
        (false, Some(i)) => {
            tags.remove(i);
        }
        (false, None) => {}
    }
}

#[cfg(target_os = "macos")]
pub fn decode_tags(data: &[u8]) -> Result<Vec<Tag>, String> {
    let value = plist::Value::from_reader(io::Cursor::new(data)).map_err(|e| e.to_string())?;
    let array = value.into_array().ok_or("Tag list is not an array")?;
    Ok(array.into_iter().filter_map(|v| v.into_string()).map(|s| parse_tag(&s)).collect())
}

#[cfg(target_os = "macos")]
pub fn encode_tags(tags: &[Tag]) -> Result<Vec<u8>, String> {
    let value = plist::Value::Array(tags.iter().map(|t| plist::Value::String(format_tag(t))).collect());
    let mut out = Vec::new();
    value.to_writer_binary(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// macOS implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSAutoreleasePool, NSString};
    use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};
    use objc::{class, msg_send, sel, sel_impl, Encode};
    use once_cell::sync::Lazy;
    use parking_lot::Mutex;
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    use tauri::AppHandle;

    #[link(name = "Quartz", kind = "framework")]
    extern "C" {}

    pub type NSInteger = isize;
    pub type NSUInteger = usize;

    /// Runs `f` inside an autorelease pool.
    pub fn with_pool<R>(f: impl FnOnce() -> R) -> R {
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let result = f();
            pool.drain();
            result
        }
    }

    /// Runs `f` on the main thread and waits for its result.
    pub async fn on_main<R: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce() -> R + Send + 'static,
    ) -> Result<R, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(with_pool(f));
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "The main thread did not answer".to_string())
    }

    /// Autoreleased NSString.
    pub unsafe fn ns_string(s: &str) -> id {
        let string = NSString::alloc(nil).init_str(s);
        msg_send![string, autorelease]
    }

    pub unsafe fn rust_string(s: id) -> Option<String> {
        if s == nil {
            return None;
        }
        let ptr: *const c_char = msg_send![s, UTF8String];
        if ptr.is_null() {
            return None;
        }
        Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }

    /// Autoreleased file NSURL.
    pub unsafe fn file_url(path: &str) -> id {
        msg_send![class!(NSURL), fileURLWithPath: ns_string(path)]
    }

    pub unsafe fn url_path(url: id) -> Option<String> {
        if url == nil {
            return None;
        }
        rust_string(msg_send![url, path])
    }

    pub unsafe fn error_text(error: id) -> String {
        if error == nil {
            return "Unknown error".to_string();
        }
        rust_string(msg_send![error, localizedDescription]).unwrap_or_else(|| "Unknown error".to_string())
    }

    /// Autoreleased NSArray of file URLs.
    pub unsafe fn url_array(paths: &[String]) -> id {
        let urls: Vec<id> = paths.iter().map(|p| file_url(p)).collect();
        NSArray::arrayWithObjects(nil, &urls)
    }

    // ----- Trash -----------------------------------------------------------

    /// Moves `path` to the Trash. Returns the item's new path inside the Trash.
    pub fn trash_path(path: &Path) -> Result<Option<String>, String> {
        let path_str = path.to_string_lossy().into_owned();
        if fs::symlink_metadata(path).is_err() {
            return Err(format!("\"{path_str}\" does not exist"));
        }
        with_pool(|| unsafe {
            let manager: id = msg_send![class!(NSFileManager), defaultManager];
            let url = file_url(&path_str);
            let mut resulting: id = nil;
            let mut error: id = nil;
            let ok: BOOL = msg_send![manager, trashItemAtURL: url
                                               resultingItemURL: &mut resulting as *mut id
                                               error: &mut error as *mut id];
            if ok == NO {
                return Err(format!("Could not move \"{path_str}\" to the Trash: {}", error_text(error)));
            }
            Ok(url_path(resulting))
        })
    }

    // ----- Quick Look --------------------------------------------------------

    struct QuickLookState {
        paths: Vec<String>,
        /// Retained NSArray of NSURLs (0 = none)
        urls: usize,
        /// Retained data source / delegate instance (0 = not created yet)
        source: usize,
    }

    static QUICK_LOOK: Lazy<Mutex<QuickLookState>> =
        Lazy::new(|| Mutex::new(QuickLookState { paths: Vec::new(), urls: 0, source: 0 }));

    fn current_urls() -> id {
        QUICK_LOOK.lock().urls as id
    }

    extern "C" fn ql_number_of_items(_this: &Object, _sel: Sel, _panel: id) -> NSInteger {
        let urls = current_urls();
        if urls == nil {
            return 0;
        }
        unsafe {
            let count: NSUInteger = msg_send![urls, count];
            count as NSInteger
        }
    }

    extern "C" fn ql_item_at(_this: &Object, _sel: Sel, _panel: id, index: NSInteger) -> id {
        let urls = current_urls();
        if urls == nil || index < 0 {
            return nil;
        }
        unsafe {
            let count: NSUInteger = msg_send![urls, count];
            if index as NSUInteger >= count {
                return nil;
            }
            msg_send![urls, objectAtIndex: index as NSUInteger]
        }
    }

    unsafe fn ql_step(panel: id, delta: NSInteger) {
        let count: NSInteger = ql_number_of_items_raw();
        if count == 0 {
            return;
        }
        let index: NSInteger = msg_send![panel, currentPreviewItemIndex];
        let next = (index + delta).clamp(0, count - 1);
        if next != index {
            let _: () = msg_send![panel, setCurrentPreviewItemIndex: next];
        }
    }

    unsafe fn ql_number_of_items_raw() -> NSInteger {
        let urls = current_urls();
        if urls == nil {
            return 0;
        }
        let count: NSUInteger = msg_send![urls, count];
        count as NSInteger
    }

    /// Keyboard handling while the panel is key: Space / Escape close it, arrows change the item.
    extern "C" fn ql_handle_event(_this: &Object, _sel: Sel, panel: id, event: id) -> BOOL {
        const KEY_DOWN: NSUInteger = 10;
        if event == nil || panel == nil {
            return NO;
        }
        unsafe {
            let event_type: NSUInteger = msg_send![event, type];
            if event_type != KEY_DOWN {
                return NO;
            }
            let key_code: u16 = msg_send![event, keyCode];
            match key_code {
                49 | 53 => {
                    let _: () = msg_send![panel, orderOut: nil];
                    YES
                }
                123 | 126 => {
                    ql_step(panel, -1);
                    YES
                }
                124 | 125 => {
                    ql_step(panel, 1);
                    YES
                }
                _ => NO,
            }
        }
    }

    // Controller methods added to the application object so the panel finds a
    // controller in the responder chain (required since macOS 10.6).
    extern "C" fn ql_accepts_control(_this: &Object, _sel: Sel, _panel: id) -> BOOL {
        YES
    }

    extern "C" fn ql_begin_control(_this: &Object, _sel: Sel, panel: id) {
        let source = QUICK_LOOK.lock().source as id;
        if panel != nil && source != nil {
            unsafe {
                let _: () = msg_send![panel, setDataSource: source];
                let _: () = msg_send![panel, setDelegate: source];
            }
        }
    }

    extern "C" fn ql_end_control(_this: &Object, _sel: Sel, _panel: id) {}

    /// Creates the data source class and instance and installs the controller
    /// methods on the application object (once). Main thread only.
    unsafe fn ensure_quick_look_setup() -> Result<id, String> {
        let existing = QUICK_LOOK.lock().source;
        if existing != 0 {
            return Ok(existing as id);
        }

        let class = match Class::get("ExplrQuickLookSource") {
            Some(c) => c,
            None => {
                let mut decl = objc::declare::ClassDecl::new("ExplrQuickLookSource", class!(NSObject))
                    .ok_or("Could not declare the Quick Look data source")?;
                decl.add_method(
                    sel!(numberOfPreviewItemsInPreviewPanel:),
                    ql_number_of_items as extern "C" fn(&Object, Sel, id) -> NSInteger,
                );
                decl.add_method(
                    sel!(previewPanel:previewItemAtIndex:),
                    ql_item_at as extern "C" fn(&Object, Sel, id, NSInteger) -> id,
                );
                decl.add_method(
                    sel!(previewPanel:handleEvent:),
                    ql_handle_event as extern "C" fn(&Object, Sel, id, id) -> BOOL,
                );
                for protocol in ["QLPreviewPanelDataSource", "QLPreviewPanelDelegate"] {
                    if let Some(p) = objc::runtime::Protocol::get(protocol) {
                        decl.add_protocol(p);
                    }
                }
                decl.register()
            }
        };
        let source: id = msg_send![class, new];
        if source == nil {
            return Err("Could not create the Quick Look data source".to_string());
        }

        // Controller methods on the application object and its delegate
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let delegate: id = if app != nil { msg_send![app, delegate] } else { nil };
        let bool_types = format!("{}@:@\0", BOOL::encode().as_str());
        for target in [app, delegate] {
            if target == nil {
                continue;
            }
            let cls = objc::runtime::object_getClass(target as *const Object) as *mut Class;
            let accepts: extern "C" fn(&Object, Sel, id) -> BOOL = ql_accepts_control;
            let begin: extern "C" fn(&Object, Sel, id) = ql_begin_control;
            let end: extern "C" fn(&Object, Sel, id) = ql_end_control;
            objc::runtime::class_addMethod(
                cls,
                sel!(acceptsPreviewPanelControl:),
                std::mem::transmute::<extern "C" fn(&Object, Sel, id) -> BOOL, objc::runtime::Imp>(accepts),
                bool_types.as_ptr() as *const c_char,
            );
            objc::runtime::class_addMethod(
                cls,
                sel!(beginPreviewPanelControl:),
                std::mem::transmute::<extern "C" fn(&Object, Sel, id), objc::runtime::Imp>(begin),
                b"v@:@\0".as_ptr() as *const c_char,
            );
            objc::runtime::class_addMethod(
                cls,
                sel!(endPreviewPanelControl:),
                std::mem::transmute::<extern "C" fn(&Object, Sel, id), objc::runtime::Imp>(end),
                b"v@:@\0".as_ptr() as *const c_char,
            );
        }

        QUICK_LOOK.lock().source = source as usize;
        Ok(source)
    }

    unsafe fn preview_panel(create: bool) -> Result<id, String> {
        let panel_class = Class::get("QLPreviewPanel").ok_or("Quick Look is not available")?;
        if !create {
            let exists: BOOL = msg_send![panel_class, sharedPreviewPanelExists];
            if exists == NO {
                return Ok(nil);
            }
        }
        let panel: id = msg_send![panel_class, sharedPreviewPanel];
        Ok(panel)
    }

    pub fn quick_look_show(paths: Vec<String>, index: usize) -> Result<(), String> {
        if paths.is_empty() {
            return Err("Nothing to preview".to_string());
        }
        let index = index.min(paths.len() - 1) as NSInteger;
        unsafe {
            let source = ensure_quick_look_setup()?;

            // Swap the item list
            let new_urls: id = msg_send![url_array(&paths), retain];
            let old_urls = {
                let mut state = QUICK_LOOK.lock();
                state.paths = paths;
                std::mem::replace(&mut state.urls, new_urls as usize)
            };

            let panel = preview_panel(true)?;
            if panel == nil {
                return Err("Quick Look is not available".to_string());
            }
            let visible: BOOL = msg_send![panel, isVisible];
            if visible == NO {
                let _: () = msg_send![panel, updateController];
            }
            let current: id = msg_send![panel, dataSource];
            if current != source {
                let _: () = msg_send![panel, setDataSource: source];
                let _: () = msg_send![panel, setDelegate: source];
            }
            let _: () = msg_send![panel, reloadData];
            let _: () = msg_send![panel, setCurrentPreviewItemIndex: index];
            if visible == NO {
                let _: () = msg_send![panel, makeKeyAndOrderFront: nil];
                let _: () = msg_send![panel, setCurrentPreviewItemIndex: index];
            }

            if old_urls != 0 {
                let _: () = msg_send![old_urls as id, release];
            }
        }
        Ok(())
    }

    pub fn quick_look_hide() -> Result<(), String> {
        unsafe {
            let panel = preview_panel(false)?;
            if panel != nil {
                let visible: BOOL = msg_send![panel, isVisible];
                if visible != NO {
                    let _: () = msg_send![panel, orderOut: nil];
                }
            }
        }
        Ok(())
    }

    pub fn quick_look_visible() -> Result<bool, String> {
        unsafe {
            let panel = preview_panel(false)?;
            if panel == nil {
                return Ok(false);
            }
            let visible: BOOL = msg_send![panel, isVisible];
            Ok(visible != NO)
        }
    }

    // ----- Open with / sharing -------------------------------------------------

    pub fn apps_for(path: &str) -> Result<Vec<AppInfo>, String> {
        if fs::symlink_metadata(path).is_err() {
            return Err(format!("\"{path}\" does not exist"));
        }
        with_pool(|| unsafe {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let manager: id = msg_send![class!(NSFileManager), defaultManager];
            let url = file_url(path);

            let display_name = |app_path: &str| -> String {
                let name = rust_string(msg_send![manager, displayNameAtPath: ns_string(app_path)])
                    .unwrap_or_else(|| {
                        Path::new(app_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                    });
                name.strip_suffix(".app").map(str::to_string).unwrap_or(name)
            };

            let default_url: id = msg_send![workspace, URLForApplicationToOpenURL: url];
            let default_path = url_path(default_url);

            let mut others: Vec<AppInfo> = Vec::new();
            let responds: BOOL = msg_send![workspace, respondsToSelector: sel!(URLsForApplicationsToOpenURL:)];
            if responds != NO {
                let list: id = msg_send![workspace, URLsForApplicationsToOpenURL: url];
                if list != nil {
                    let count: NSUInteger = msg_send![list, count];
                    for i in 0..count {
                        let app_url: id = msg_send![list, objectAtIndex: i];
                        let Some(app_path) = url_path(app_url) else { continue };
                        if Some(&app_path) == default_path.as_ref() || others.iter().any(|a| a.path == app_path) {
                            continue;
                        }
                        others.push(AppInfo { name: display_name(&app_path), path: app_path, is_default: false });
                    }
                }
            }
            others.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

            let mut apps = Vec::with_capacity(others.len() + 1);
            if let Some(p) = default_path {
                apps.push(AppInfo { name: display_name(&p), path: p, is_default: true });
            }
            apps.extend(others);
            Ok(apps)
        })
    }

    pub fn airdrop(paths: Vec<String>) -> Result<(), String> {
        unsafe {
            let service: id = msg_send![class!(NSSharingService),
                sharingServiceNamed: ns_string("com.apple.share.AirDrop.send")];
            if service == nil {
                return Err("AirDrop is not available".to_string());
            }
            let items = url_array(&paths);
            let can: BOOL = msg_send![service, canPerformWithItems: items];
            if can == NO {
                return Err("AirDrop cannot share these items".to_string());
            }
            let _: () = msg_send![service, performWithItems: items];
        }
        Ok(())
    }

    // ----- Tags (xattr) -------------------------------------------------------

    const TAGS_XATTR: &[u8] = b"com.apple.metadata:_kMDItemUserTags\0";

    fn c_path(path: &Path) -> io::Result<CString> {
        CString::new(path.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
    }

    /// Raw value of the tags attribute, None when the item has no tags.
    pub fn read_tags_xattr(path: &Path) -> io::Result<Option<Vec<u8>>> {
        let c = c_path(path)?;
        let name = TAGS_XATTR.as_ptr() as *const c_char;
        let mut buf = vec![0u8; 256];
        loop {
            let n = unsafe { libc::getxattr(c.as_ptr(), name, buf.as_mut_ptr() as *mut c_void, buf.len(), 0, 0) };
            if n >= 0 {
                buf.truncate(n as usize);
                return Ok(Some(buf));
            }
            let err = io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::ENOATTR) => return Ok(None),
                Some(libc::ERANGE) => {
                    let size = unsafe { libc::getxattr(c.as_ptr(), name, std::ptr::null_mut(), 0, 0, 0) };
                    if size < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    buf.resize(size as usize + 64, 0);
                }
                _ => return Err(err),
            }
        }
    }

    pub fn read_tags(path: &Path) -> Result<Vec<Tag>, String> {
        match read_tags_xattr(path) {
            Ok(Some(data)) => decode_tags(&data),
            Ok(None) => Ok(Vec::new()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn write_tags(path: &Path, tags: &[Tag]) -> Result<(), String> {
        let c = c_path(path).map_err(|e| e.to_string())?;
        let name = TAGS_XATTR.as_ptr() as *const c_char;
        let rc = if tags.is_empty() {
            let rc = unsafe { libc::removexattr(c.as_ptr(), name, 0) };
            if rc != 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOATTR) {
                0
            } else {
                rc
            }
        } else {
            let data = encode_tags(tags)?;
            unsafe { libc::setxattr(c.as_ptr(), name, data.as_ptr() as *const c_void, data.len(), 0, 0) }
        };
        if rc != 0 {
            return Err(format!("{}: {}", path.display(), io::Error::last_os_error()));
        }
        Ok(())
    }

    // ----- Spotlight helpers ----------------------------------------------------

    /// Runs `mdfind -onlyin <dir> <query>` and returns at most `max` paths within `timeout`.
    pub async fn mdfind(dir: &str, query: &str, timeout: std::time::Duration, max: usize) -> Result<Vec<String>, String> {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut child = tokio::process::Command::new("/usr/bin/mdfind")
            .arg("-onlyin")
            .arg(dir)
            .arg(query)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Spotlight is not available: {e}"))?;
        let stdout = child.stdout.take().ok_or("No output from Spotlight")?;
        let mut lines = BufReader::new(stdout).lines();
        let mut out = Vec::new();
        let read = async {
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    out.push(line);
                }
                if out.len() >= max {
                    break;
                }
            }
        };
        let _ = tokio::time::timeout(timeout, read).await;
        let _ = child.kill().await;
        Ok(out)
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn MDItemCreate(
            allocator: core_foundation_sys::base::CFAllocatorRef,
            path: core_foundation_sys::string::CFStringRef,
        ) -> core_foundation_sys::base::CFTypeRef;
        fn MDItemCopyAttribute(
            item: core_foundation_sys::base::CFTypeRef,
            name: core_foundation_sys::string::CFStringRef,
        ) -> core_foundation_sys::base::CFTypeRef;
        static kMDItemLastUsedDate: core_foundation_sys::string::CFStringRef;
    }

    /// Seconds since 1970 of the item's `kMDItemLastUsedDate`.
    pub fn last_used(path: &str) -> Option<f64> {
        use core_foundation_sys::base::{kCFAllocatorDefault, CFGetTypeID, CFRelease};
        use core_foundation_sys::date::{CFDateGetAbsoluteTime, CFDateGetTypeID};
        use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringCreateWithBytes};
        const CF_TO_UNIX: f64 = 978_307_200.0;

        with_pool(|| unsafe {
            let cf_path = CFStringCreateWithBytes(
                kCFAllocatorDefault,
                path.as_ptr(),
                path.len() as _,
                kCFStringEncodingUTF8,
                0,
            );
            if cf_path.is_null() {
                return None;
            }
            let item = MDItemCreate(kCFAllocatorDefault, cf_path);
            CFRelease(cf_path as _);
            if item.is_null() {
                return None;
            }
            let value = MDItemCopyAttribute(item, kMDItemLastUsedDate);
            CFRelease(item);
            if value.is_null() {
                return None;
            }
            let result = if CFGetTypeID(value) == CFDateGetTypeID() {
                Some(CFDateGetAbsoluteTime(value as _) + CF_TO_UNIX)
            } else {
                None
            };
            CFRelease(value);
            result
        })
    }
}

#[cfg(target_os = "macos")]
pub use mac::trash_path;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Moves items to the Trash, reporting where each one ended up (for undo).
#[tauri::command]
pub async fn trash_items(paths: Vec<String>) -> Result<Vec<TrashResult>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .map(|p| match mac::trash_path(Path::new(&p)) {
                    Ok(trashed) => TrashResult { original: p, trashed, error: None },
                    Err(e) => TrashResult { original: p, trashed: None, error: Some(e) },
                })
                .collect()
        })
        .await
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        unsupported()
    }
}

/// Shows the Quick Look panel for `paths`, starting at `index`
/// (updates the items if the panel is already open).
#[tauri::command]
pub async fn quick_look(app: tauri::AppHandle, paths: Vec<String>, index: usize) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::on_main(&app, move || mac::quick_look_show(paths, index)).await?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, paths, index);
        unsupported()
    }
}

/// Closes the Quick Look panel if it is open.
#[tauri::command]
pub async fn quick_look_close(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::on_main(&app, mac::quick_look_hide).await?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        unsupported()
    }
}

/// True while the Quick Look panel is visible.
#[tauri::command]
pub async fn quick_look_is_open(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        mac::on_main(&app, mac::quick_look_visible).await?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        unsupported()
    }
}

/// Finder tags of the given items. Items without tags are not in the map.
#[tauri::command]
pub async fn get_tags(paths: Vec<String>) -> Result<HashMap<String, Vec<Tag>>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || {
            let mut map = HashMap::new();
            for p in paths {
                if let Ok(tags) = mac::read_tags(Path::new(&p)) {
                    if !tags.is_empty() {
                        map.insert(p, tags);
                    }
                }
            }
            map
        })
        .await
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        unsupported()
    }
}

/// Adds (`add = true`) or removes a tag (by name) on every item.
#[tauri::command]
pub async fn set_tag(paths: Vec<String>, name: String, color: u8, add: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let name = name.trim().to_string();
        if name.is_empty() || name.contains('\n') {
            return Err("Invalid tag name".to_string());
        }
        if color > 7 {
            return Err(format!("Invalid tag colour {color} (0–7)"));
        }
        tokio::task::spawn_blocking(move || {
            let errors: Vec<String> = paths
                .iter()
                .filter_map(|p| {
                    let path = Path::new(p);
                    let mut tags = match mac::read_tags(path) {
                        Ok(t) => t,
                        Err(e) => return Some(e),
                    };
                    apply_tag_change(&mut tags, &name, color, add);
                    mac::write_tags(path, &tags).err()
                })
                .collect();
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("\n"))
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (paths, name, color, add);
        unsupported()
    }
}

/// Items in the home folder that have a tag of `color`, in `open_directory` JSON shape.
#[tauri::command]
pub async fn files_with_tag_color(color: u8) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        const MAX_RESULTS: usize = 2000;
        let home = std::env::var("HOME").map_err(|_| "HOME is not set")?;
        let candidates =
            mac::mdfind(&home, "kMDItemUserTags == *", std::time::Duration::from_secs(10), 50_000).await?;
        tokio::task::spawn_blocking(move || {
            let mut matches = Vec::new();
            for p in candidates {
                let path = PathBuf::from(p);
                if let Ok(tags) = mac::read_tags(&path) {
                    if tags.iter().any(|t| t.color == color) {
                        matches.push(path);
                        if matches.len() >= MAX_RESULTS {
                            break;
                        }
                    }
                }
            }
            entries_json(&matches, false)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = color;
        unsupported()
    }
}

/// True for paths that Recents should not show (hidden items, ~/Library).
pub fn is_hidden_or_library(path: &Path, home: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(home) else { return true };
    if rel.starts_with("Library") {
        return true;
    }
    rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// Files in the home folder used in the last 30 days, newest first (`open_directory` JSON shape).
#[tauri::command]
pub async fn list_recents(limit: Option<usize>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let limit = limit.unwrap_or(100).clamp(1, 2000);
        let home = std::env::var("HOME").map_err(|_| "HOME is not set")?;
        let candidates = mac::mdfind(
            &home,
            "kMDItemLastUsedDate >= $time.today(-30)",
            std::time::Duration::from_secs(5),
            20_000,
        )
        .await?;
        tokio::task::spawn_blocking(move || {
            let home = PathBuf::from(home);
            let mut dated: Vec<(f64, PathBuf)> = candidates
                .into_iter()
                .map(PathBuf::from)
                .filter(|p| !is_hidden_or_library(p, &home))
                .filter(|p| fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
                .filter_map(|p| mac::last_used(&p.to_string_lossy()).map(|t| (t, p)))
                .collect();
            dated.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            dated.truncate(limit);
            let paths: Vec<PathBuf> = dated.into_iter().map(|(_, p)| p).collect();
            entries_json(&paths, true)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = limit;
        unsupported()
    }
}

/// Applications that can open `path`: the default first, then the others by name.
#[tauri::command]
pub async fn open_with_apps(path: String) -> Result<Vec<AppInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || mac::apps_for(&path)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        unsupported()
    }
}

/// Runs `/usr/bin/open` with the given arguments (no shell).
#[cfg(target_os = "macos")]
async fn run_open(args: Vec<String>) -> Result<(), String> {
    let output = tokio::process::Command::new("/usr/bin/open")
        .args(&args)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Could not run open: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() { format!("open failed ({})", output.status) } else { stderr })
    }
}

/// Paths must be absolute so they can never be read as options.
#[cfg(target_os = "macos")]
fn absolute_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No items given".to_string());
    }
    match paths.iter().find(|p| !p.starts_with('/')) {
        Some(p) => Err(format!("Not an absolute path: {p}")),
        None => Ok(()),
    }
}

/// Opens the items with a specific application.
#[tauri::command]
pub async fn open_with(paths: Vec<String>, app_path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        absolute_paths(&paths)?;
        absolute_paths(std::slice::from_ref(&app_path))?;
        let mut args = vec!["-a".to_string(), app_path];
        args.extend(paths);
        run_open(args).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (paths, app_path);
        unsupported()
    }
}

/// Selects the items in a Finder window.
#[tauri::command]
pub async fn reveal_in_finder(paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        absolute_paths(&paths)?;
        let mut args = vec!["-R".to_string()];
        args.extend(paths);
        run_open(args).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        unsupported()
    }
}

/// Opens Terminal in `path`.
#[tauri::command]
pub async fn open_terminal_here(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        absolute_paths(std::slice::from_ref(&path))?;
        run_open(vec!["-a".to_string(), "Terminal".to_string(), path]).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        unsupported()
    }
}

/// Opens the AirDrop sharing sheet for the items.
#[tauri::command]
pub async fn share_airdrop(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        absolute_paths(&paths)?;
        mac::on_main(&app, move || mac::airdrop(paths)).await?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, paths);
        unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tags() {
        assert_eq!(parse_tag("Red\n6"), Tag { name: "Red".into(), color: 6 });
        assert_eq!(parse_tag("Work"), Tag { name: "Work".into(), color: 0 });
        assert_eq!(parse_tag("Odd\n99"), Tag { name: "Odd".into(), color: 0 });
        assert_eq!(format_tag(&Tag { name: "Blue".into(), color: 4 }), "Blue\n4");
    }

    #[test]
    fn tag_changes() {
        let mut tags = vec![Tag { name: "Red".into(), color: 6 }];
        apply_tag_change(&mut tags, "work", 0, true);
        apply_tag_change(&mut tags, "red", 2, true); // recolour, no duplicate
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].color, 2);
        apply_tag_change(&mut tags, "RED", 0, false);
        assert_eq!(tags, vec![Tag { name: "work".into(), color: 0 }]);
        apply_tag_change(&mut tags, "missing", 0, false);
        assert_eq!(tags.len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tags_round_trip_on_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tagged.txt");
        fs::write(&file, b"x").unwrap();
        let c = std::ffi::CString::new(file.to_str().unwrap()).unwrap();
        let other = b"com.example.other\0";
        let rc = unsafe {
            libc::setxattr(c.as_ptr(), other.as_ptr() as *const _, b"keep".as_ptr() as *const _, 4, 0, 0)
        };
        assert_eq!(rc, 0);

        let rt = tokio::runtime::Runtime::new().unwrap();
        let p = file.to_string_lossy().into_owned();
        rt.block_on(set_tag(vec![p.clone()], "Red".into(), 6, true)).unwrap();
        rt.block_on(set_tag(vec![p.clone()], "Project X".into(), 0, true)).unwrap();

        // Binary plist with Finder's "Name\nColour" strings
        let raw = mac::read_tags_xattr(&file).unwrap().unwrap();
        assert!(raw.starts_with(b"bplist00"));
        let value = plist::Value::from_reader(std::io::Cursor::new(&raw)).unwrap();
        let strings: Vec<String> =
            value.into_array().unwrap().into_iter().map(|v| v.into_string().unwrap()).collect();
        assert_eq!(strings, vec!["Red\n6".to_string(), "Project X\n0".to_string()]);

        let map = rt.block_on(get_tags(vec![p.clone(), dir.path().to_string_lossy().into_owned()])).unwrap();
        assert_eq!(map.len(), 1, "untagged items are left out");
        assert_eq!(map[&p][0], Tag { name: "Red".into(), color: 6 });

        rt.block_on(set_tag(vec![p.clone()], "red".into(), 0, false)).unwrap();
        rt.block_on(set_tag(vec![p.clone()], "Project X".into(), 0, false)).unwrap();
        assert!(mac::read_tags_xattr(&file).unwrap().is_none(), "attribute removed when empty");

        // Other attributes untouched
        let mut buf = [0u8; 16];
        let n = unsafe {
            libc::getxattr(c.as_ptr(), other.as_ptr() as *const _, buf.as_mut_ptr() as *mut _, buf.len(), 0, 0)
        };
        assert_eq!(&buf[..n as usize], b"keep");

        assert!(rt.block_on(set_tag(vec![p.clone()], "X".into(), 9, true)).is_err());
        assert!(rt.block_on(set_tag(vec![p], " ".into(), 1, true)).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_tags_written_by_finder_format() {
        // Large list exercises the ERANGE path of the xattr reader
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("many.txt");
        fs::write(&file, b"x").unwrap();
        let tags: Vec<Tag> = (0..60).map(|i| Tag { name: format!("Tag number {i}"), color: (i % 8) as u8 }).collect();
        mac::write_tags(&file, &tags).unwrap();
        assert_eq!(mac::read_tags(&file).unwrap(), tags);
    }

    #[test]
    fn restore_items_moves_back_without_overwriting() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.txt");
        let moved = root.path().join("sub/a.txt");
        fs::create_dir(root.path().join("sub")).unwrap();
        fs::write(&moved, b"a").unwrap();
        let blocked_from = root.path().join("b-moved.txt");
        let blocked_to = root.path().join("b.txt");
        fs::write(&blocked_from, b"new").unwrap();
        fs::write(&blocked_to, b"existing").unwrap();
        let nested_to = root.path().join("gone/deeper/c.txt");
        let nested_from = root.path().join("c.txt");
        fs::write(&nested_from, b"c").unwrap();

        let s = |p: &Path| p.to_string_lossy().into_owned();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(restore_items(vec![
                MovePair { from: s(&moved), to: s(&a) },
                MovePair { from: s(&blocked_from), to: s(&blocked_to) },
                MovePair { from: s(&nested_from), to: s(&nested_to) },
            ]))
            .unwrap_err();
        assert_eq!(err.lines().count(), 1, "{err}");
        assert!(err.contains("already exists"));
        assert_eq!(fs::read(&a).unwrap(), b"a");
        assert!(!moved.exists());
        assert_eq!(fs::read(&blocked_to).unwrap(), b"existing", "never overwritten");
        assert!(blocked_from.exists());
        assert_eq!(fs::read(&nested_to).unwrap(), b"c", "missing parent folders are recreated");

        let ok = rt
            .block_on(restore_items(vec![MovePair { from: s(&a), to: s(&root.path().join("a2.txt")) }]))
            .unwrap();
        assert_eq!(ok, vec![s(&root.path().join("a2.txt"))]);
    }

    #[test]
    fn hidden_and_library_paths_are_filtered() {
        let home = Path::new("/Users/me");
        assert!(is_hidden_or_library(Path::new("/Users/me/Library/Caches/x"), home));
        assert!(is_hidden_or_library(Path::new("/Users/me/.config/x"), home));
        assert!(is_hidden_or_library(Path::new("/Users/me/Documents/.git/x"), home));
        assert!(is_hidden_or_library(Path::new("/tmp/x"), home));
        assert!(!is_hidden_or_library(Path::new("/Users/me/Documents/report.pdf"), home));
        assert!(!is_hidden_or_library(Path::new("/Users/me/Library Notes/a.txt"), home));
    }

    #[test]
    fn entries_json_has_open_directory_shape() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), b"abc").unwrap();
        fs::create_dir(dir.path().join("d")).unwrap();
        let paths = vec![dir.path().join("f.txt"), dir.path().join("d"), dir.path().join("missing")];
        let json: serde_json::Value = serde_json::from_str(&entries_json(&paths, false).unwrap()).unwrap();
        assert_eq!(json["files"][0]["name"], "f.txt");
        assert_eq!(json["files"][0]["size_in_bytes"], 3);
        assert!(json["files"][0]["date_added"].as_str().unwrap().len() == 19);
        assert_eq!(json["directories"][0]["name"], "d");
        let files_only: serde_json::Value = serde_json::from_str(&entries_json(&paths, true).unwrap()).unwrap();
        assert_eq!(files_only["directories"].as_array().unwrap().len(), 0);
    }

    /// Uses the real Trash; the trashed file is deleted again afterwards.
    #[cfg(target_os = "macos")]
    #[test]
    fn trash_items_reports_new_location() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("explr-trash-test-{}.txt", std::process::id());
        let file = dir.path().join(&name);
        fs::write(&file, b"x").unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let p = file.to_string_lossy().into_owned();
        let missing = dir.path().join("missing.txt").to_string_lossy().into_owned();
        let results = rt.block_on(trash_items(vec![p.clone(), missing.clone()])).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].original, p);
        assert!(results[0].error.is_none(), "{:?}", results[0].error);
        let trashed = PathBuf::from(results[0].trashed.clone().unwrap());
        assert!(!file.exists());
        assert!(trashed.exists());
        assert!(trashed.file_name().unwrap().to_string_lossy().starts_with("explr-trash-test-"));
        assert!(results[1].error.is_some() && results[1].trashed.is_none());

        // Undo puts it back
        let restored = rt
            .block_on(restore_items(vec![MovePair { from: trashed.to_string_lossy().into_owned(), to: p.clone() }]))
            .unwrap();
        assert_eq!(restored, vec![p]);
        assert!(file.exists());
    }

    /// Smoke test against the real Spotlight index / Launch Services
    /// (machine dependent): `cargo test --release -- --ignored smoke_`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "depends on the local Spotlight index and installed apps"]
    fn smoke_spotlight_and_launch_services() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let recents: serde_json::Value =
            serde_json::from_str(&rt.block_on(list_recents(Some(10))).unwrap()).unwrap();
        println!("recents: {}", recents["files"].as_array().unwrap().len());
        for f in recents["files"].as_array().unwrap() {
            println!("  {}", f["path"]);
        }
        let tagged: serde_json::Value =
            serde_json::from_str(&rt.block_on(files_with_tag_color(6)).unwrap()).unwrap();
        println!("red tagged: {} files, {} dirs", tagged["files"].as_array().unwrap().len(), tagged["directories"].as_array().unwrap().len());
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        fs::write(&f, b"x").unwrap();
        let apps = rt.block_on(open_with_apps(f.to_string_lossy().into_owned())).unwrap();
        println!("apps: {:?}", apps.iter().take(5).collect::<Vec<_>>());
        assert!(apps.first().map(|a| a.is_default).unwrap_or(false));
    }
}
