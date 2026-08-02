use std::sync::mpsc::Receiver;
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::Deserialize;

pub const CLIENT_ID: &str = "1533426617689309304";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    pub title: String,
    pub artist: String,
    pub cover: String,
    pub playing: bool,
}

pub enum DiscordMsg {
    Status(DiscordStatus),
    Clear,
}

pub fn spawn_worker(rx: Receiver<DiscordMsg>) {
    std::thread::spawn(move || {
        let mut client = DiscordIpcClient::new(CLIENT_ID).ok();
        let mut connected = false;
        while let Ok(msg) = rx.recv() {
            let Some(c) = client.as_mut() else {
                continue;
            };
            if !connected && c.connect().is_err() {
                continue;
            }
            connected = true;
            let res = match msg {
                DiscordMsg::Clear => c.clear_activity(),
                DiscordMsg::Status(s) => {
                    if s.title.trim().is_empty() && s.artist.trim().is_empty() {
                        c.clear_activity()
                    } else {
                        let mut act = activity::Activity::new()
                            .activity_type(activity::ActivityType::Listening)
                            .details(&s.title)
                            .state(&s.artist)
                            .assets(activity::Assets::new().large_image(&s.cover).large_text(&s.title))
                            .buttons(vec![activity::Button::new(
                                "Открыть релизы",
                                "https://github.com/XLEWDEST/Zvuk/releases",
                            )]);
                        if s.playing {
                            let start = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .map(|d| d.as_secs() as i64)
                                .unwrap_or(0);
                            act = act.timestamps(activity::Timestamps::new().start(start));
                        }
                        c.set_activity(act)
                    }
                }
            };
            if res.is_err() {
                connected = false;
            }
        }
        if let Some(mut c) = client {
            let _ = c.close();
        }
    });
}
