//! The user's preferred languages from macOS (System Settings → Language & Region).
//! WebKit only exposes the primary language to the page, so the UI asks here.

/// Parses the `defaults read -g AppleLanguages` output: `( "en-US", "ru-US" )`.
fn parse_apple_languages(output: &str) -> Vec<String> {
    output
        .split(|c| c == '\n' || c == ',')
        .map(|s| s.trim().trim_matches(|c| c == '(' || c == ')' || c == '"').trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Returns the preferred languages in order (e.g. ["en-US", "ru-US"]); empty if unknown.
#[tauri::command]
pub fn preferred_languages() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
        {
            if out.status.success() {
                return parse_apple_languages(&String::from_utf8_lossy(&out.stdout));
            }
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::parse_apple_languages;

    #[test]
    fn parses_defaults_output() {
        let out = "(\n    \"en-US\",\n    \"ru-US\"\n)\n";
        assert_eq!(parse_apple_languages(out), vec!["en-US", "ru-US"]);
        assert!(parse_apple_languages("").is_empty());
    }
}
