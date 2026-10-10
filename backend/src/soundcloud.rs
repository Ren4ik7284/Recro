use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::models::SearchTrack;

pub struct SoundCloudClient {
    client_id: RwLock<String>,
    is_refreshing: AtomicBool,
    http: reqwest::Client,
}

impl SoundCloudClient {
    pub fn new() -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_default();

        let client = Arc::new(Self {
            client_id: RwLock::new("BtYbFoM0mqN0NzaXzMgrbRx7UwdTAbmf".to_string()),
            is_refreshing: AtomicBool::new(false),
            http,
        });

        let client_clone = Arc::clone(&client);
        tokio::spawn(async move {
            client_clone.refresh_client_id().await;
        });

        client
    }

    pub async fn get_client_id(&self) -> String {
        self.client_id.read().await.clone()
    }

    pub async fn refresh_client_id(&self) {
        if self.is_refreshing.swap(true, Ordering::SeqCst) {
            return;
        }

        let res = self.fetch_fresh_client_id().await;
        if let Some(id) = res {
            let mut w = self.client_id.write().await;
            *w = id;
        }

        self.is_refreshing.store(false, Ordering::SeqCst);
    }

    async fn fetch_fresh_client_id(&self) -> Option<String> {
        let sc_html = self
            .http
            .get("https://soundcloud.com")
            .send()
            .await
            .ok()?
            .text()
            .await
            .ok()?;

        let mut script_urls: Vec<String> = Vec::new();
        for part in sc_html.split("https://a-v2.sndcdn.com/assets/") {
            if let Some(end) = part.find(".js") {
                let full = format!("https://a-v2.sndcdn.com/assets/{}.js", &part[..end]);
                if !script_urls.contains(&full) {
                    script_urls.push(full);
                }
            }
        }

        for script_url in script_urls.into_iter().rev() {
            if let Ok(resp) = self.http.get(&script_url).send().await {
                if let Ok(js) = resp.text().await {
                    if let Some(id) = Self::extract_client_id_from_js(&js) {
                        return Some(id);
                    }
                }
            }
        }

        None
    }

    fn extract_client_id_from_js(js: &str) -> Option<String> {
        let needle = "client_id";
        let mut idx = 0;
        while let Some(found) = js[idx..].find(needle) {
            let pos = idx + found + needle.len();
            let slice = &js[pos..std::cmp::min(pos + 60, js.len())];
            let trimmed = slice.trim_start();
            let remainder = if let Some(stripped) = trimmed.strip_prefix(':') {
                stripped.trim_start()
            } else if let Some(stripped) = trimmed.strip_prefix('=') {
                stripped.trim_start()
            } else {
                idx = pos;
                continue;
            };

            let quote_char = remainder.chars().next()?;
            if quote_char == '"' || quote_char == '\'' {
                let token = &remainder[1..];
                if let Some(end) = token.find(quote_char) {
                    let candidate = &token[..end];
                    if candidate.len() == 32 && candidate.chars().all(|c| c.is_ascii_alphanumeric()) {
                        return Some(candidate.to_string());
                    }
                }
            }

            idx = pos;
        }
        None
    }

    pub async fn search_tracks(&self, query: &str, limit: usize, base_url: &str) -> Vec<SearchTrack> {
        let client_id = self.get_client_id().await;
        let url = format!(
            "https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit={}&offset=0",
            urlencoding::encode(query),
            client_id,
            limit
        );

        let resp = match self.http.get(&url).send().await {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
            self.refresh_client_id().await;
            return Vec::new();
        }

        let json_val: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        Self::parse_collection(&json_val, base_url)
    }

    pub async fn get_related_tracks(&self, track_id: &str, limit: usize, base_url: &str) -> Vec<SearchTrack> {
        let sc_id = if let Some(stripped) = track_id.strip_prefix("sc-") {
            stripped
        } else {
            track_id
        };

        if !sc_id.chars().all(|c| c.is_ascii_digit()) {
            return Vec::new();
        }

        let client_id = self.get_client_id().await;
        let url = format!(
            "https://api-v2.soundcloud.com/tracks/{}/related?client_id={}&limit={}",
            sc_id, client_id, limit
        );

        let resp = match self.http.get(&url).send().await {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
            self.refresh_client_id().await;
            return Vec::new();
        }

        let json_val: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        Self::parse_collection(&json_val, base_url)
    }

    pub async fn resolve_stream_url(&self, track_id: &str) -> Option<String> {
        let sc_id = if let Some(stripped) = track_id.strip_prefix("sc-") {
            stripped
        } else {
            track_id
        };

        if !sc_id.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }

        let client_id = self.get_client_id().await;
        let track_api_url = format!(
            "https://api-v2.soundcloud.com/tracks/{}?client_id={}",
            sc_id, client_id
        );

        let resp = self.http.get(&track_api_url).send().await.ok()?;
        if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
            self.refresh_client_id().await;
            return None;
        }

        let track_json: serde_json::Value = resp.json().await.ok()?;
        Self::resolve_stream_from_track_json(&self.http, &track_json, &client_id).await
    }

    pub async fn resolve_stream_by_permalink(&self, permalink_url: &str) -> Option<String> {
        let client_id = self.get_client_id().await;
        let resolve_url = format!(
            "https://api-v2.soundcloud.com/resolve?url={}&client_id={}",
            urlencoding::encode(permalink_url),
            client_id
        );

        let resp = self.http.get(&resolve_url).send().await.ok()?;
        let track_json: serde_json::Value = resp.json().await.ok()?;
        Self::resolve_stream_from_track_json(&self.http, &track_json, &client_id).await
    }

    async fn resolve_stream_from_track_json(
        http: &reqwest::Client,
        track_json: &serde_json::Value,
        client_id: &str,
    ) -> Option<String> {
        let transcodings = track_json["media"]["transcodings"].as_array()?;
        let chosen = transcodings
            .iter()
            .find(|t| t["format"]["protocol"].as_str() == Some("progressive"))
            .or_else(|| {
                transcodings
                    .iter()
                    .find(|t| t["format"]["protocol"].as_str() == Some("hls"))
            })
            .or_else(|| transcodings.first())?;

        let stream_info_url = chosen["url"].as_str()?;
        let sep = if stream_info_url.contains('?') { "&" } else { "?" };
        let final_fetch = format!("{}{}client_id={}", stream_info_url, sep, client_id);

        let media_resp = http.get(&final_fetch).send().await.ok()?;
        let media_json: serde_json::Value = media_resp.json().await.ok()?;
        media_json["url"].as_str().map(|s| s.to_string())
    }

    fn parse_collection(data: &serde_json::Value, base_url: &str) -> Vec<SearchTrack> {
        let items = match data["collection"].as_array() {
            Some(arr) => arr,
            None => return Vec::new(),
        };

        let mut tracks = Vec::new();
        for item in items {
            if let Some(track) = Self::item_to_search_track(item, base_url) {
                tracks.push(track);
            }
        }
        tracks
    }

    fn item_to_search_track(item: &serde_json::Value, base_url: &str) -> Option<SearchTrack> {
        let id_val = item["id"].as_i64()?;
        let sc_id = format!("sc-{}", id_val);

        let raw_title = item["title"].as_str().unwrap_or("").trim();
        if raw_title.is_empty() {
            return None;
        }

        let user_name = item["user"]["username"]
            .as_str()
            .unwrap_or("SoundCloud Artist")
            .trim();

        let (title, artist) = Self::split_title_and_artist(raw_title, user_name);

        let duration_ms = item["duration"].as_f64().unwrap_or(0.0);
        let duration = duration_ms / 1000.0;
        if duration > 0.0 && (duration < 35.0 || duration > 660.0) {
            return None;
        }

        let is_snipped = item["policy"].as_str() == Some("SNIP") || item["snipped"].as_bool() == Some(true);
        if is_snipped {
            return None;
        }

        let cover_url = item["artwork_url"]
            .as_str()
            .or_else(|| item["user"]["avatar_url"].as_str())
            .map(|u| u.replace("-large.jpg", "-t500x500.jpg"));

        let permalink = item["permalink_url"].as_str().unwrap_or("");
        let audio_url = if !permalink.is_empty() {
            format!(
                "{}/api/stream?url={}&title={}&artist={}&id={}",
                base_url,
                urlencoding::encode(permalink),
                urlencoding::encode(&title),
                urlencoding::encode(&artist),
                urlencoding::encode(&sc_id)
            )
        } else {
            format!(
                "{}/api/stream?id={}&title={}&artist={}",
                base_url,
                urlencoding::encode(&sc_id),
                urlencoding::encode(&title),
                urlencoding::encode(&artist)
            )
        };

        Some(SearchTrack {
            id: sc_id,
            title,
            artist,
            duration,
            audio_url,
            cover_url,
            plays: item["playback_count"].as_i64(),
        })
    }

    fn split_title_and_artist(raw_title: &str, user_name: &str) -> (String, String) {
        let s = raw_title.to_string();
        let separators = [" - ", " – ", " — "];
        for sep in separators {
            if s.contains(sep) {
                let parts: Vec<&str> = s.split(sep).collect();
                if parts.len() >= 2 {
                    let cand_artist = parts[0].trim();
                    let cand_title = parts[1..].join(sep).trim().to_string();
                    if !cand_artist.is_empty() && !cand_title.is_empty() {
                        return (cand_title, cand_artist.to_string());
                    }
                }
            }
        }

        (s, user_name.to_string())
    }
}
