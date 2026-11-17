use crate::models;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::Permissions;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::time::SystemTime;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Debug, Clone, Eq, PartialEq, Hash)]
pub struct Entries {
    pub(crate) directories: Vec<models::Directory>,
    pub(crate) files: Vec<models::File>,
}

/// This function retrieves the access permissions of a file or directory.
/// It returns the permissions as a number.
/// It takes into account the platform (Windows or Unix) and formats the permissions accordingly.
///
/// # Parameters
/// - `permissions`: The permissions of the file or directory.
/// - `is_directory`: A boolean indicating whether the entry is a directory or not.
///
/// # Returns
/// A u32 representing the access permissions.
///
/// # Example
/// ```rust
/// use crate::commands::fs_dir_loader_commands::get_access_permission_number;
/// use std::fs::Permissions;
/// use std::os::unix::fs::PermissionsExt;
///
/// fn main() {
///  let permissions = Permissions::from_mode(0o755);
///  let is_directory = true;
///  let permission_number = get_access_permission_number(permissions, is_directory);
///  println!("Access permissions number: {}", permission_number);
/// }
pub fn get_access_permission_number(permissions: Permissions, _is_directory: bool) -> u32 {
    #[cfg(windows)]
    {
        // Unix-like octal for Windows-permissions
        return if permissions.readonly() {
            0o444 // r--r--r--
        } else if _is_directory {
            0o755 // rwxr-xr-x
        } else {
            0o666 // rw-rw-rw-
        }
    }
    #[cfg(unix)]
    {
        let mode = permissions.mode();
        mode
    }
}

/// This function converts the access permissions of a file or directory into a human-readable string.
/// It takes into account the platform (Windows or Unix) and formats the permissions accordingly.
///
/// # Parameters
/// - `permissions`: The permissions of the file or directory.
/// - `is_directory`: A boolean indicating whether the entry is a directory or not.
///
/// # Returns
/// A string representing the access permissions in a human-readable format.
///
/// # Example
/// ```rust
/// use crate::commands::fs_dir_loader_commands::get_access_permission_string;
/// use std::fs::Permissions;
/// use std::os::unix::fs::PermissionsExt;
///
/// fn main() {
///   let permissions = Permissions::from_mode(0o755);
///   let is_directory = true;
///   let permission_string = get_access_permission_string(permissions, is_directory);
///   println!("Access permissions: {}", permission_string);
/// }
/// ```
#[allow(unused_variables)]
pub fn get_access_permission_string(permissions: Permissions, is_directory: bool) -> String {
    #[cfg(windows)]
    {
        access_permission_string_windows(permissions, is_directory)
    }
    #[cfg(unix)]
    {
        access_rights_to_string_unix(permissions)
    }
}

/// This function converts the access permissions of a file or directory into a human-readable string.
/// It takes into account the platform (Windows or Unix) and formats the permissions accordingly.
///
/// # Parameters
/// - `permissions`: The permissions of the file or directory.
/// - `is_directory`: A boolean indicating whether the entry is a directory or not.
///
/// # Returns
/// A string representing the access permissions in a human-readable format.
///
/// # Example
/// ```rust
/// use crate::commands::fs_dir_loader_commands::get_access_permission_string;
/// use std::fs::Permissions;
/// use std::os::unix::fs::PermissionsExt;
///
/// fn main() {
///  let permissions = Permissions::from_mode(0o755);
///  let is_directory = true;
///  let permission_string = get_access_permission_string(permissions, is_directory);
/// println!("Access permissions: {}", permission_string);
/// }
/// ```
#[allow(dead_code)]
pub fn access_permission_string_windows(permission: Permissions, is_directory: bool) -> String {
    // Standardmäßig Leserechte für alle
    let mut result = String::from("r--r--r--");

    // Wenn nicht schreibgeschützt, füge Schreibrechte für alle hinzu
    if !permission.readonly() {
        result = String::from("rw-rw-rw-");
    }

    // Wenn es sich um ein Verzeichnis handelt, füge Ausführungsrechte hinzu
    if is_directory {
        result = String::from("rwxr-xr-x");
    }

    result
}

/// This function converts the access permissions of a file or directory into a human-readable string.
/// It takes into account the platform (Windows or Unix) and formats the permissions accordingly.
///
/// # Parameters
/// - `permissions`: The permissions of the file or directory.
/// - `is_directory`: A boolean indicating whether the entry is a directory or not.
///
/// # Returns
/// A string representing the access permissions in a human-readable format.
///
/// # Example
/// ```rust
/// use crate::commands::fs_dir_loader_commands::get_access_permission_string;
/// use std::fs::Permissions;
/// use std::os::unix::fs::PermissionsExt;
///
/// fn main() {
///  let permissions = Permissions::from_mode(0o755);
///  let is_directory = true;
///  let permission_string = get_access_permission_string(permissions, is_directory);
///  println!("Access permissions: {}", permission_string);
/// }
/// ```
#[cfg(unix)]
pub fn access_rights_to_string_unix(permissions: Permissions) -> String {
    let mut result = String::new();
    let mode = permissions.mode();

    // User permissions
    result.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    result.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    result.push(if mode & 0o100 != 0 { 'x' } else { '-' });

    // Group permissions
    result.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    result.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    result.push(if mode & 0o010 != 0 { 'x' } else { '-' });

    // Others permissions
    result.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    result.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    result.push(if mode & 0o001 != 0 { 'x' } else { '-' });

    result
}

/// This function formats a SystemTime object into a human-readable string.
/// It converts the SystemTime into a DateTime<Utc> object and then formats it into a string.
///
/// # Parameters
/// - `system_time`: The SystemTime object to be formatted.
///
/// # Returns
/// A string representing the formatted date and time.
///
/// # Example
/// ```rust
/// use crate::commands::fs_dir_loader_commands::format_system_time;
/// use std::time::SystemTime;
///
/// fn main() {
///  let system_time = SystemTime::now();
///  let formatted_time = format_system_time(system_time);
///  println!("Formatted time: {}", formatted_time);
/// }
pub fn format_system_time(system_time: SystemTime) -> String {
    let datetime: DateTime<Utc> = system_time.into();
    datetime.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Reads the macOS "Date Added" attribute (ATTR_CMN_ADDEDTIME) of `path`.
#[cfg(target_os = "macos")]
fn read_date_added(path: &std::path::Path) -> Option<SystemTime> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::time::{Duration, UNIX_EPOCH};

    #[repr(C)]
    struct AttrList {
        bitmapcount: u16,
        reserved: u16,
        commonattr: u32,
        volattr: u32,
        dirattr: u32,
        fileattr: u32,
        forkattr: u32,
    }

    #[repr(C, packed(4))]
    struct AddedTimeBuf {
        length: u32,
        added: libc::timespec,
    }

    const ATTR_BIT_MAP_COUNT: u16 = 5;
    const ATTR_CMN_ADDEDTIME: u32 = 0x1000_0000;
    const FSOPT_NOFOLLOW: u32 = 0x0000_0001;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut attrs = AttrList {
        bitmapcount: ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: ATTR_CMN_ADDEDTIME,
        volattr: 0,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut buf: AddedTimeBuf = unsafe { std::mem::zeroed() };

    let rc = unsafe {
        libc::getattrlist(
            c_path.as_ptr(),
            &mut attrs as *mut AttrList as *mut libc::c_void,
            &mut buf as *mut AddedTimeBuf as *mut libc::c_void,
            std::mem::size_of::<AddedTimeBuf>(),
            FSOPT_NOFOLLOW,
        )
    };
    let length = buf.length as usize;
    if rc != 0 || length < std::mem::size_of::<AddedTimeBuf>() {
        return None; // attribute not available (e.g. some volumes)
    }
    let added = buf.added;
    if added.tv_sec <= 0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::new(added.tv_sec as u64, added.tv_nsec.max(0) as u32))
}

/// "Date Added" of `path` formatted like the other timestamps.
/// Falls back to the creation time when the attribute is not available.
pub fn date_added_string(path: &std::path::Path, metadata: &std::fs::Metadata) -> String {
    #[cfg(target_os = "macos")]
    if let Some(time) = read_date_added(path) {
        return format_system_time(time);
    }
    metadata
        .created()
        .map_or("1970-01-01 00:00:00".to_string(), format_system_time)
}

/// This function calculates the size of a directory in bytes.
/// It uses the WalkDir crate to recursively walk through the directory and sum up the sizes of all files.
///
/// # Parameters
/// - `path`: The path of the directory to calculate the size for.
///
/// # Returns
/// The total size of the directory in bytes.
///
/// # Example
/// ```rust
/// use crate::commands::fs_dir_loader_commands::get_directory_size_in_bytes;
/// use std::fs;
///
/// fn main() {
///  let path = "/path/to/directory";
///  let size = get_directory_size_in_bytes(path);
///  println!("Directory size: {} bytes", size);
/// }
#[allow(dead_code)]
pub fn get_directory_size_in_bytes(path: &str) -> u64 {
    WalkDir::new(path)
        .into_iter()
        .filter_map(Result::ok) // Ignore errors
        .filter(|entry| entry.path().is_file()) // Only count files
        .map(|entry| {
            fs::metadata(entry.path())
                .map(|meta| meta.len())
                .unwrap_or(0)
        }) // Get file sizes
        .sum()
}

/// This function counts the number of files and directories in a given path.
/// It uses the WalkDir crate to recursively walk through the directory and count the entries.
///
/// # Parameters
/// - `path`: The path of the directory to count the entries for.
///
/// # Returns
/// A tuple containing the number of files and directories. Where the first is the number of files and the second is the number of directories.
///
/// # Example
/// ```rust
/// use crate::commands::fs_dir_loader_commands::count_subfiles_and_directories;
/// use std::env;
///
/// fn main() {
///  let path = env::current_dir().unwrap().to_str().unwrap().to_string();
///  let (file_count, dir_count) = count_subfiles_and_directories(&path);
///  println!("Files: {}, Directories: {}", file_count, dir_count);
/// }
#[allow(dead_code)]
pub fn count_subfiles_and_subdirectories(path: &str) -> (usize, usize) {
    let mut file_count = 0;
    let mut dir_count = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.filter_map(Result::ok) {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    file_count += 1;
                } else if file_type.is_dir() {
                    dir_count += 1;
                }
            }
        }
    }

    (file_count, dir_count)
}

/// This function counts only the number of files in a given path.
/// It only counts immediate files in the directory (non-recursive).
///
/// # Parameters
/// - `path`: The path of the directory to count the files for.
///
/// # Returns
/// The number of files in the directory.
///
/// # Example
/// ```rust
/// use crate::models::directory_entries_helper::count_subfiles;
///
/// fn main() {
///   let path = "/path/to/directory";
///   let file_count = count_subfiles(path);
///   println!("Files: {}", file_count);
/// }
/// ```
pub fn count_subfiles(path: &str) -> usize {
    let mut file_count = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.filter_map(Result::ok) {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    file_count += 1;
                }
            }
        }
    }

    file_count
}

/// This function counts only the number of directories in a given path.
/// It only counts immediate subdirectories (non-recursive).
///
/// # Parameters
/// - `path`: The path of the directory to count the subdirectories for.
///
/// # Returns
/// The number of subdirectories in the directory.
///
/// # Example
/// ```rust
/// use crate::models::directory_entries_helper::count_subdirectories;
///
/// fn main() {
///   let path = "/path/to/directory";
///   let dir_count = count_subdirectories(path);
///   println!("Directories: {}", dir_count);
/// }
/// ```
pub fn count_subdirectories(path: &str) -> usize {
    let mut dir_count = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.filter_map(Result::ok) {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    dir_count += 1;
                }
            }
        }
    }

    dir_count
}

#[cfg(test)]
mod date_added_tests {
    use super::*;

    #[test]
    fn date_added_is_set_for_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("added.txt");
        std::fs::write(&path, b"x").unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let added = date_added_string(&path, &metadata);
        assert_eq!(added.len(), "2026-01-01 00:00:00".len());
        assert!(!added.starts_with("1970"), "unexpected date: {added}");
        // Freshly created file: added time equals creation time (same second)
        let created = format_system_time(metadata.created().unwrap());
        assert_eq!(added[..16], created[..16]);
    }
}
