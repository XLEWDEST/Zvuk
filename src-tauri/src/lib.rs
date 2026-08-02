mod api;
mod commands;
mod discord;
mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

pub struct AppState {
    pub api: Mutex<Option<api::ZvukApi>>,
    pub quitting: AtomicBool,
    pub shortcut_actions: Mutex<HashMap<u32, String>>,
    pub discord_tx: Mutex<Option<mpsc::Sender<discord::DiscordMsg>>>,
}

pub fn run() {
    let (discord_tx, discord_rx) = mpsc::channel();
    discord::spawn_worker(discord_rx);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let action = app
                        .state::<AppState>()
                        .shortcut_actions
                        .lock()
                        .unwrap()
                        .get(&event.id)
                        .cloned();
                    if let Some(action) = action {
                        let _ = app.emit("hotkey", action);
                    }
                })
                .build(),
        )
        .manage(AppState {
            api: Mutex::new(None),
            quitting: AtomicBool::new(false),
            shortcut_actions: Mutex::new(HashMap::new()),
            discord_tx: Mutex::new(Some(discord_tx)),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_anonymous_token,
            commands::set_token,
            commands::verify_session,
            commands::saved_token_exists,
            commands::clear_token,
            commands::open_token_page,
            commands::set_hotkeys,
            commands::discord_update,
            commands::discord_clear,
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
            commands::get_artists,
            commands::synthesis_build,
            commands::create_playlist,
            commands::add_tracks_to_playlist,
            commands::update_playlist,
            commands::delete_playlist,
        ])
        .setup(|app| {
            commands::restore_session(app.handle());
            let _ = setup_tray(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let quitting = window
                    .app_handle()
                    .state::<AppState>()
                    .quitting
                    .load(Ordering::Relaxed);
                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
    let play_pause = MenuItem::with_id(app, "play-pause", "Пауза/Плей", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Предыдущее", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Следующее", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &play_pause,
            &prev,
            &next,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray_32.png"))?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Звук")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "play-pause" => {
                let _ = app.emit("tray-play-pause", ());
            }
            "prev" => {
                let _ = app.emit("tray-prev", ());
            }
            "next" => {
                let _ = app.emit("tray-next", ());
            }
            "quit" => {
                app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
