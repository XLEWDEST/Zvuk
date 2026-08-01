use std::path::PathBuf;

const SERVICE: &str = "app.zvuk.desktop";
const ACCOUNT: &str = "default";
const FALLBACK_FILE: &str = "token.txt";

fn fallback_path() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("ZvukDesktop")
        .join(FALLBACK_FILE)
}

pub fn save(token: &str) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, ACCOUNT) {
        Ok(entry) => match entry.set_password(token) {
            Ok(()) => Ok(()),
            Err(_) => write_fallback(token),
        },
        Err(_) => write_fallback(token),
    }
}

fn write_fallback(token: &str) -> Result<(), String> {
    let path = fallback_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, token).map_err(|e| e.to_string())
}

pub fn load() -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        if let Ok(token) = entry.get_password() {
            return Some(token);
        }
    }
    std::fs::read_to_string(fallback_path()).ok().map(|s| s.trim().to_string())
}

pub fn clear() -> Result<(), String> {
    let mut cleared = false;
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        if entry.delete_credential().is_ok() {
            cleared = true;
        }
    }
    let _ = std::fs::remove_file(fallback_path());
    let _ = cleared;
    Ok(())
}
