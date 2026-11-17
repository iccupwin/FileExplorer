use std::env;
use std::path::PathBuf;
use std::sync::LazyLock;

pub static VERSION: &str = "0.2.3";

/// Base folder for config and logs: the current dir (main() switches it to
/// ~/Library/Application Support/com.explr.app), or that folder directly if the
/// current dir is unavailable.
fn data_dir() -> PathBuf {
    env::current_dir().unwrap_or_else(|_| {
        env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support/com.explr.app"))
            .unwrap_or_else(env::temp_dir)
    })
}

pub static CONFIG_PATH: LazyLock<PathBuf> = LazyLock::new(|| data_dir().join("config"));

pub static META_DATA_CONFIG_ABS_PATH: LazyLock<PathBuf> =
    LazyLock::new(|| CONFIG_PATH.join(META_DATA_CONFIG_FILE_NAME));


pub static LOG_PATH: LazyLock<PathBuf> = LazyLock::new(|| data_dir().join("logs"));


pub static META_DATA_CONFIG_FILE_NAME: &str = "meta_data.json";

pub static LOG_FILE_NAME: &str = "app.log";
pub static ERROR_LOG_FILE_NAME: &str = "error.log";

pub static TEST_DATA_PATH: &str = "./test-data-for-fuzzy-search";

pub static LOG_FILE_ABS_PATH: LazyLock<PathBuf> = LazyLock::new(|| {
    LOG_PATH.join(LOG_FILE_NAME)
});

pub static ERROR_LOG_FILE_ABS_PATH: LazyLock<PathBuf> = LazyLock::new(|| {
    LOG_PATH.join(ERROR_LOG_FILE_NAME)
});

pub const MAX_NUMBER_OF_LOG_FILES: usize = 3;

pub static SETTINGS_CONFIG_ABS_PATH: LazyLock<PathBuf> =
    LazyLock::new(|| CONFIG_PATH.join(SETTINGS_CONFIG_FILE_NAME));
pub static SETTINGS_CONFIG_FILE_NAME: &str = "settings.json";

pub static TEMPLATES_ABS_PATH_FOLDER: LazyLock<PathBuf> =
    LazyLock::new(|| CONFIG_PATH.join(TEMPLATES_FOLDER));
pub static TEMPLATES_FOLDER: &str = "templates";
