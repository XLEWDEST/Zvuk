mod api;
mod commands;
mod discord;
mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

pub struct AppState {
    pub api: Mutex<Option<api::ZvukApi>>,
    pub quitting: AtomicBool,
    pub shortcut_actions: Mutex<HashMap<u32, String>>,
    pub discord_tx: Mutex<Option<mpsc::Sender<discord::DiscordMsg>>>,
    pub hide_gen: AtomicU64,
    pub last_activity: AtomicU64,
    pub idle_low: AtomicBool,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn run() {
    let (discord_tx, discord_rx) = mpsc::channel();
    discord::spawn_worker(discord_rx);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            cancel_freeze(app);
            unfreeze_webview(app);
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
            hide_gen: AtomicU64::new(0),
            last_activity: AtomicU64::new(now_ms()),
            idle_low: AtomicBool::new(false),
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
            commands::user_active,
        ])
        .setup(|app| {
            commands::restore_session(app.handle());
            let _ = setup_tray(app.handle());
            spawn_idle_monitor(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let quitting = window.app_handle().state::<AppState>().quitting.load(Ordering::Relaxed);
                    if !quitting {
                        api.prevent_close();
                        let _ = window.hide();
                        schedule_freeze(&window.app_handle());
                    }
                }
                WindowEvent::Focused(focused) => {
                    let app = window.app_handle();
                    if *focused {
                        app.state::<AppState>().last_activity.store(now_ms(), Ordering::Relaxed);
                        set_soft_normal(&app);
                    } else {
                        set_soft_low(&app);
                    }
                }
                _ => {}
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
    cancel_freeze(app);
    app.state::<AppState>().last_activity.store(now_ms(), Ordering::Relaxed);
    set_soft_normal(app);
    unfreeze_webview(app);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

const FREEZE_DELAY_SECS: u64 = 180;
const IDLE_MS: u64 = 180_000;

#[cfg(target_os = "windows")]
pub(crate) fn apply_memory_level(app: &tauri::AppHandle, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL, ICoreWebView2_19,
    };
    use windows_core::Interface;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.with_webview(move |webview| {
            let controller = webview.controller();
            let level = if low { 1 } else { 0 };
            // SAFETY: COM calls on a valid WebView2 controller handle.
            unsafe {
                if let Ok(core) = controller.CoreWebView2() {
                    if let Ok(core) = core.cast::<ICoreWebView2_19>() {
                        let _ = core
                            .SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(level));
                    }
                }
            }
        });
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn apply_memory_level(_app: &tauri::AppHandle, _low: bool) {}

#[cfg(target_os = "windows")]
fn freeze_webview(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.with_webview(move |webview| {
            let controller = webview.controller();
            // SAFETY: COM call on a valid WebView2 controller handle.
            unsafe {
                let _ = controller.SetIsVisible(false);
            }
        });
    }
    apply_memory_level(app, true);
}

#[cfg(target_os = "windows")]
fn unfreeze_webview(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.with_webview(move |webview| {
            let controller = webview.controller();
            // SAFETY: COM call on a valid WebView2 controller handle.
            unsafe {
                let _ = controller.SetIsVisible(true);
            }
        });
    }
    apply_memory_level(app, false);
}

#[cfg(not(target_os = "windows"))]
fn freeze_webview(_app: &tauri::AppHandle) {}

#[cfg(not(target_os = "windows"))]
fn unfreeze_webview(_app: &tauri::AppHandle) {}

fn set_soft_low(app: &tauri::AppHandle) {
    app.state::<AppState>().idle_low.store(true, Ordering::Relaxed);
    apply_memory_level(app, true);
}

fn set_soft_normal(app: &tauri::AppHandle) {
    app.state::<AppState>().idle_low.store(false, Ordering::Relaxed);
    apply_memory_level(app, false);
}

fn spawn_idle_monitor(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let state = app.state::<AppState>();
        let visible = app
            .get_webview_window("main")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        if !visible {
            state.idle_low.store(false, Ordering::Relaxed);
            continue;
        }
        let idle = now_ms().saturating_sub(state.last_activity.load(Ordering::Relaxed)) >= IDLE_MS;
        if idle != state.idle_low.load(Ordering::Relaxed) {
            state.idle_low.store(idle, Ordering::Relaxed);
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || apply_memory_level(&app2, idle));
        }
    });
}

fn schedule_freeze(app: &tauri::AppHandle) {
    let gen = app
        .state::<AppState>()
        .hide_gen
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(FREEZE_DELAY_SECS));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if app2.state::<AppState>().hide_gen.load(Ordering::Relaxed) == gen {
                freeze_webview(&app2);
            }
        });
    });
}

fn cancel_freeze(app: &tauri::AppHandle) {
    app.state::<AppState>()
        .hide_gen
        .fetch_add(1, Ordering::Relaxed);
}
