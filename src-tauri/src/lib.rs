mod api;
mod commands;
mod store;

use std::sync::Mutex;

pub struct AppState {
    pub api: Mutex<Option<api::ZvukApi>>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            api: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_anonymous_token,
            commands::set_token,
            commands::saved_token_exists,
            commands::clear_token,
            commands::open_token_page,
            commands::quick_search,
            commands::search,
            commands::get_stream,
            commands::get_tracks,
            commands::get_playlists,
            commands::get_releases,
            commands::user_collection,
            commands::user_tracks,
            commands::user_playlists,
            commands::add_to_collection,
            commands::remove_from_collection,
        ])
        .setup(|app| {
            commands::restore_session(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
