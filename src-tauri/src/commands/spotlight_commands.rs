//! Instant global search backed by the macOS Spotlight index (`mdfind`).
//!
//! The built-in search engine has to crawl the whole home folder after every
//! launch (its index lives only in memory). On macOS the system already keeps
//! an up-to-date index, so global search queries Spotlight instead: no crawl,
//! no CPU/disk load at startup and results in milliseconds.

use std::path::Path;

/// One search hit: absolute path and a relevance score (higher is better).
/// Same shape as the built-in engine so the UI can use either.
type SearchResult = Vec<(String, f32)>;

/// Scores a hit by how well its file name matches `query`.
fn score(path: &str, query_lower: &str) -> f32 {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let stem = name.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| name.clone());

    let mut score = if stem == query_lower || name == query_lower {
        1.0
    } else if name.starts_with(query_lower) {
        0.85
    } else if name.split(|c: char| !c.is_alphanumeric()).any(|w| w.starts_with(query_lower)) {
        0.7
    } else {
        0.5
    };

    // Prefer shallow paths and penalise noise folders
    let depth = path.matches('/').count() as f32;
    score -= (depth * 0.005).min(0.1);
    if path.contains("/Library/") || path.contains("/node_modules/") || path.contains("/.") {
        score -= 0.2;
    }
    score
}

/// Searches file and folder names with Spotlight.
///
/// # Arguments
/// * `query` - Part of a file name (case-insensitive)
/// * `extensions` - Optional list of extensions to keep (without dots)
/// * `limit` - Maximum number of results (default 200)
#[tauri::command]
pub async fn spotlight_search(
    query: String,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<SearchResult, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Stdio;
        use std::time::Duration;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let query = query.trim().to_string();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.unwrap_or(200).clamp(1, 2000);
        let home = std::env::var("HOME").map_err(|_| "HOME is not set")?;
        let wanted_ext: Vec<String> = extensions
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            .collect();

        let mut child = tokio::process::Command::new("/usr/bin/mdfind")
            .arg("-onlyin")
            .arg(&home)
            .arg("-name")
            .arg(&query)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Spotlight is not available: {e}"))?;

        let stdout = child.stdout.take().ok_or("No output from Spotlight")?;
        let mut lines = BufReader::new(stdout).lines();
        let query_lower = query.to_lowercase();
        // Read more than `limit` so ranking can pick the best ones
        let max_read = limit * 5;
        let mut hits: SearchResult = Vec::new();

        let read_all = async {
            let mut read = 0usize;
            while let Ok(Some(line)) = lines.next_line().await {
                read += 1;
                if !wanted_ext.is_empty() {
                    let ext = Path::new(&line)
                        .extension()
                        .map(|e| e.to_string_lossy().to_ascii_lowercase())
                        .unwrap_or_default();
                    if !wanted_ext.contains(&ext) {
                        continue;
                    }
                }
                let s = score(&line, &query_lower);
                hits.push((line, s));
                if read >= max_read {
                    break;
                }
            }
        };
        // Spotlight is normally instant; never let a stuck query block the UI
        let _ = tokio::time::timeout(Duration::from_secs(5), read_all).await;
        let _ = child.kill().await;

        hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(limit);
        Ok(hits)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (query, extensions, limit);
        Err("Spotlight search is only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::score;

    #[test]
    fn exact_match_ranks_above_partial() {
        let exact = score("/Users/a/Documents/report.pdf", "report");
        let prefix = score("/Users/a/Documents/report-final.pdf", "report");
        let inner = score("/Users/a/Documents/my_report.pdf", "report");
        let contains = score("/Users/a/Documents/xreportx.pdf", "report");
        assert!(exact > prefix && prefix > inner && inner > contains);
    }

    #[test]
    fn library_paths_rank_lower() {
        let normal = score("/Users/a/Documents/notes.txt", "notes");
        let library = score("/Users/a/Library/Caches/notes.txt", "notes");
        assert!(normal > library);
    }
}
