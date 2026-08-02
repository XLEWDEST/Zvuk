use std::collections::HashMap;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::api::ZvukApi;
use crate::discord::{self, DiscordMsg};
use crate::store;
use crate::AppState;

fn api_from_state(state: &State<'_, AppState>) -> Result<ZvukApi, String> {
    state
        .api
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Авторизация не выполнена".to_string())
}

#[tauri::command]
pub async fn get_anonymous_token() -> Result<String, String> {
    ZvukApi::anonymous_token().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_token(state: State<'_, AppState>, token: String) -> Result<Value, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Токен не должен быть пустым".into());
    }
    let api = ZvukApi::new(token.clone());
    api.verify().await.map_err(|e| e.to_string())?;
    store::save(&token)?;
    *state.api.lock().unwrap() = Some(api);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn verify_session(state: State<'_, AppState>) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.verify().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn saved_token_exists() -> bool {
    store::load().is_some()
}

#[tauri::command]
pub fn clear_token(state: State<'_, AppState>) -> Result<(), String> {
    store::clear()?;
    *state.api.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn open_token_page(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://zvuk.com/api/tiny/profile", None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_hotkeys(
    app: AppHandle,
    hotkeys: HashMap<String, Option<String>>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    let mut actions = state.shortcut_actions.lock().unwrap();
    actions.clear();
    for (action, combo) in hotkeys {
        let Some(combo) = combo else { continue };
        let combo = combo.trim();
        if combo.is_empty() {
            continue;
        }
        let sc: Shortcut = combo.parse().map_err(|_| "Некорректная комбинация клавиш")?;
        actions.insert(sc.id(), action);
        gs.register(sc).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn discord_update(
    state: State<'_, AppState>,
    status: discord::DiscordStatus,
) -> Result<(), String> {
    if let Some(tx) = state.discord_tx.lock().unwrap().as_ref() {
        let _ = tx.send(DiscordMsg::Status(status));
    }
    Ok(())
}

#[tauri::command]
pub fn discord_clear(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(tx) = state.discord_tx.lock().unwrap().as_ref() {
        let _ = tx.send(DiscordMsg::Clear);
    }
    Ok(())
}

#[tauri::command]
pub async fn quick_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.quick_search(&query, limit.unwrap_or(8))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.search(&query, limit.unwrap_or(10))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_stream(state: State<'_, AppState>, ids: Vec<String>) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.stream(&ids).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tracks(state: State<'_, AppState>, ids: Vec<String>) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.tracks(&ids).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_playlists(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.playlists(&ids).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_releases(
    state: State<'_, AppState>,
    ids: Vec<String>,
    with_tracks: Option<bool>,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.releases(&ids, with_tracks.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn user_collection(state: State<'_, AppState>) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.user_collection().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn user_tracks(state: State<'_, AppState>) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.user_tracks().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn user_playlists(state: State<'_, AppState>) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.user_playlists().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_to_collection(
    state: State<'_, AppState>,
    id: String,
    item_type: String,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.add_to_collection(&id, &item_type)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_from_collection(
    state: State<'_, AppState>,
    id: String,
    item_type: String,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.remove_from_collection(&id, &item_type)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_artists(
    state: State<'_, AppState>,
    ids: Vec<String>,
    with_releases: Option<bool>,
    with_pop_tracks: Option<bool>,
    with_related: Option<bool>,
    with_desc: Option<bool>,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.get_artists(
        &ids,
        with_releases.unwrap_or(false),
        with_pop_tracks.unwrap_or(false),
        with_related.unwrap_or(false),
        with_desc.unwrap_or(false),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn synthesis_build(
    state: State<'_, AppState>,
    first: String,
    second: String,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.synthesis_build(&first, &second).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_playlist(
    state: State<'_, AppState>,
    name: String,
    items: Vec<Value>,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.create_playlist(&name, &items).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_tracks_to_playlist(
    state: State<'_, AppState>,
    id: String,
    items: Vec<Value>,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.add_tracks_to_playlist(&id, &items).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_playlist(
    state: State<'_, AppState>,
    id: String,
    items: Vec<Value>,
    is_public: bool,
    name: String,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.update_playlist(&id, &items, is_public, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_playlist(
    state: State<'_, AppState>,
    id: String,
) -> Result<Value, String> {
    let api = api_from_state(&state)?;
    api.delete_playlist(&id).await.map_err(|e| e.to_string())
}

pub fn restore_session(app: &AppHandle) {
    if let Some(token) = store::load() {
        let api = ZvukApi::new(token);
        *app.state::<AppState>().api.lock().unwrap() = Some(api);
    }
}
