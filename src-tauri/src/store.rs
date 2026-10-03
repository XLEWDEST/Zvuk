use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

#[cfg(not(target_os = "linux"))]
const SERVICE: &str = "app.zvuk.desktop";
#[cfg(not(target_os = "linux"))]
const ACCOUNT: &str = "default";
const FALLBACK_FILE: &str = "token.txt";
const LEGACY_DIR_NAME: &str = "ZvukDesktop";

fn fallback_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| legacy_fallback_dir())
}

fn legacy_fallback_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(LEGACY_DIR_NAME)
}

fn fallback_path(app: &AppHandle) -> PathBuf {
    fallback_dir(app).join(FALLBACK_FILE)
}

fn legacy_fallback_path() -> PathBuf {
    legacy_fallback_dir().join(FALLBACK_FILE)
}

pub fn save(app: &AppHandle, token: &str) -> Result<(), String> {
    // On Linux the system keyring is unreliable (writes may succeed into a
    // non-persistent store while later reads fail), so the token is kept
    // in the app data file only.
    #[cfg(target_os = "linux")]
    {
        save_to(&fallback_dir(app), token)
    }
    #[cfg(not(target_os = "linux"))]
    {
        match keyring::Entry::new(SERVICE, ACCOUNT) {
            Ok(entry) => match entry.set_password(token) {
                Ok(()) => Ok(()),
                Err(_) => save_to(&fallback_dir(app), token),
            },
            Err(_) => save_to(&fallback_dir(app), token),
        }
    }
}

fn save_to(dir: &Path, token: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(FALLBACK_FILE);
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .and_then(|mut f| f.write_all(token.as_bytes()))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, token).map_err(|e| e.to_string())
    }
}

pub fn load(app: &AppHandle) -> Option<String> {
    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
            if let Ok(token) = entry.get_password() {
                return Some(token);
            }
        }
    }
    load_from(&fallback_dir(app)).or_else(|| migrate_legacy(app))
}

fn load_from(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(FALLBACK_FILE))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn migrate_legacy(app: &AppHandle) -> Option<String> {
    let legacy = legacy_fallback_path();
    if legacy == fallback_path(app) {
        return None;
    }
    let token = std::fs::read_to_string(&legacy)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let _ = save_to(&fallback_dir(app), &token);
    let _ = std::fs::remove_file(&legacy);
    Some(token)
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }
    clear_in(&fallback_dir(app))?;
    let legacy = legacy_fallback_dir();
    if legacy != fallback_dir(app) {
        clear_in(&legacy)?;
    }
    Ok(())
}

fn clear_in(dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(dir.join(FALLBACK_FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("zvuk-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn file_roundtrip() {
        let dir = test_dir();
        let token = "test-token-xyz";
        save_to(&dir, token).expect("save");
        assert_eq!(load_from(&dir).as_deref(), Some(token));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(FALLBACK_FILE))
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        clear_in(&dir).expect("clear");
        assert_eq!(load_from(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
