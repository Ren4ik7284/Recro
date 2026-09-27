use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct LyricsQuery {
    pub title: String,
    pub artist: Option<String>,
    #[allow(dead_code)]
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsResponse {
    pub synced: bool,
    pub lyrics: String,
    pub source: String,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub duration: Option<f64>,
}

pub type LyricsCache = Arc<Mutex<HashMap<String, (LyricsResponse, Instant)>>>;

pub fn clean_title(title: &str) -> String {
    let mut s = title.to_string();
    while let Some(open) = s.find('[') {
        if let Some(close) = s[open..].find(']') {
            s.replace_range(open..=open + close, " ");
        } else {
            break;
        }
    }
    while let Some(open) = s.find('(') {
        if let Some(close) = s[open..].find(')') {
            s.replace_range(open..=open + close, " ");
        } else {
            break;
        }
    }
    while let Some(open) = s.find('{') {
        if let Some(close) = s[open..].find('}') {
            s.replace_range(open..=open + close, " ");
        } else {
            break;
        }
    }
    if let Some(pipe) = s.find('|') {
        s.truncate(pipe);
    }
    let noise = [
        "official music video", "official video", "official audio", "official",
        "lyric video", "lyrics", "visualizer", "audio", "clip officiel",
        "remastered", "4k", "hd", "hq", "live", "full album", "премьера клипа",
        "премьера песни", "клип", "новинка", "хит", "slowed", "reverb", "speed up",
    ];
    let mut lower = s.to_lowercase();
    for word in noise {
        while let Some(idx) = lower.find(word) {
            s.replace_range(idx..idx + word.len(), " ");
            lower.replace_range(idx..idx + word.len(), " ");
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn clean_artist(artist: &str) -> String {
    let mut s = artist.to_string();
    let noise = ["topic", "vevo", "records", "music", "official", "channel"];
    let mut lower = s.to_lowercase();
    for word in noise {
        while let Some(idx) = lower.find(word) {
            s.replace_range(idx..idx + word.len(), " ");
            lower.replace_range(idx..idx + word.len(), " ");
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn fetch_lrclib(client: &reqwest::Client, title: &str, artist: &str) -> Option<LyricsResponse> {
    let mut queries = Vec::new();
    if !artist.is_empty() {
        queries.push(format!("track_name={}&artist_name={}", urlencoding::encode(title), urlencoding::encode(artist)));
    }
    queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", artist, title))));
    queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", title, artist))));
    queries.push(format!("q={}", urlencoding::encode(title)));

    for q in queries {
        let is_search = q.starts_with("q=");
        let url = if is_search {
            format!("https://lrclib.net/api/search?{}", q)
        } else {
            format!("https://lrclib.net/api/get?{}", q)
        };

        let req = client.get(&url).header("User-Agent", "RecroPlayer/1.0").timeout(std::time::Duration::from_millis(2500));
        if let Ok(res) = req.send().await {
            if res.status().is_success() {
                if is_search {
                    if let Ok(items) = res.json::<Vec<serde_json::Value>>().await {
                        for it in items {
                            if let Some(synced) = it["syncedLyrics"].as_str() {
                                if !synced.trim().is_empty() {
                                    return Some(LyricsResponse {
                                        synced: true,
                                        lyrics: synced.to_string(),
                                        source: "lrclib".to_string(),
                                        track_name: it["trackName"].as_str().map(|s| s.to_string()),
                                        artist_name: it["artistName"].as_str().map(|s| s.to_string()),
                                        duration: it["duration"].as_f64(),
                                    });
                                }
                            }
                        }
                    }
                } else if let Ok(it) = res.json::<serde_json::Value>().await {
                    if let Some(synced) = it["syncedLyrics"].as_str() {
                        if !synced.trim().is_empty() {
                            return Some(LyricsResponse {
                                synced: true,
                                lyrics: synced.to_string(),
                                source: "lrclib".to_string(),
                                track_name: it["trackName"].as_str().map(|s| s.to_string()),
                                artist_name: it["artistName"].as_str().map(|s| s.to_string()),
                                duration: it["duration"].as_f64(),
                            });
                        }
                    }
                }
            }
        }
    }
    None
}

async fn fetch_kugou(client: &reqwest::Client, title: &str, artist: &str) -> Option<LyricsResponse> {
    let query = if !artist.is_empty() {
        format!("{} {}", artist, title)
    } else {
        title.to_string()
    };

    let search_url = format!(
        "http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={}&page=1&pagesize=5",
        urlencoding::encode(&query)
    );

    let res = client
        .get(&search_url)
        .header("User-Agent", "Mozilla/5.0")
        .timeout(std::time::Duration::from_millis(3000))
        .send()
        .await
        .ok()?;

    let json: serde_json::Value = res.json().await.ok()?;
    let songs = json["data"]["info"].as_array()?;

    for song in songs {
        let hash = match song["hash"].as_str() {
            Some(h) if !h.is_empty() => h,
            _ => continue,
        };

        let lrc_search = format!(
            "http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash={}",
            hash
        );
        let cand_res = client
            .get(&lrc_search)
            .timeout(std::time::Duration::from_millis(2500))
            .send()
            .await
            .ok()?;

        let cand_json: serde_json::Value = cand_res.json().await.ok()?;
        let candidates = match cand_json["candidates"].as_array() {
            Some(c) if !c.is_empty() => c,
            _ => continue,
        };

        let cand = &candidates[0];
        let id = match cand["id"].as_str() {
            Some(i) => i.to_string(),
            None => cand["id"].as_i64()?.to_string(),
        };
        let accesskey = cand["accesskey"].as_str()?;

        let dl_url = format!(
            "http://lyrics.kugou.com/download?ver=1&client=pc&id={}&accesskey={}&fmt=lrc&charset=utf8",
            id, accesskey
        );

        let dl_res = client
            .get(&dl_url)
            .timeout(std::time::Duration::from_millis(2500))
            .send()
            .await
            .ok()?;

        let dl_json: serde_json::Value = dl_res.json().await.ok()?;
        if let Some(b64) = dl_json["content"].as_str() {
            // Base64 decode
            if let Ok(bytes) = base64_decode(b64) {
                if let Ok(text) = String::from_utf8(bytes) {
                    if text.contains('[') && text.contains(']') {
                        return Some(LyricsResponse {
                            synced: true,
                            lyrics: text,
                            source: "kugou".to_string(),
                            track_name: song["songname"].as_str().map(|s| s.to_string()),
                            artist_name: song["singername"].as_str().map(|s| s.to_string()),
                            duration: song["duration"].as_f64(),
                        });
                    }
                }
            }
        }
    }
    None
}

fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, &b) in TABLE.iter().enumerate() {
        map[b as usize] = i as u8;
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for &b in bytes {
        if b == b'=' || b == b'\r' || b == b'\n' || b == b' ' {
            continue;
        }
        let val = map[b as usize];
        if val == 255 {
            continue;
        }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

pub async fn get_lyrics(
    State(state): State<AppState>,
    Query(params): Query<LyricsQuery>,
) -> Result<Json<LyricsResponse>, StatusCode> {
    let mut raw_title = params.title.trim().to_string();
    let mut raw_artist = params.artist.unwrap_or_default().trim().to_string();

    let separators = [" - ", " – ", " — ", " | ", " // "];
    for sep in separators {
        if raw_title.contains(sep) {
            let parts: Vec<&str> = raw_title.split(sep).collect();
            if parts.len() >= 2 {
                raw_artist = parts[0].trim().to_string();
                raw_title = parts[1..].join(sep).trim().to_string();
                break;
            }
        }
    }

    let clean_t = clean_title(&raw_title);
    let clean_a = clean_artist(&raw_artist);

    let cache_key = format!("{}:{}", clean_a.to_lowercase(), clean_t.to_lowercase());
    if let Ok(cache) = state.lyrics_cache.lock() {
        if let Some((resp, _)) = cache.get(&cache_key) {
            return Ok(Json(resp.clone()));
        }
    }

    let client = reqwest::Client::new();

    // 1. Try LRCLIB
    if let Some(resp) = fetch_lrclib(&client, &clean_t, &clean_a).await {
        if let Ok(mut cache) = state.lyrics_cache.lock() {
            cache.insert(cache_key, (resp.clone(), Instant::now()));
        }
        return Ok(Json(resp));
    }

    // 2. Try Kugou (covers almost all Russian & Western tracks)
    if let Some(resp) = fetch_kugou(&client, &clean_t, &clean_a).await {
        if let Ok(mut cache) = state.lyrics_cache.lock() {
            cache.insert(cache_key, (resp.clone(), Instant::now()));
        }
        return Ok(Json(resp));
    }

    Err(StatusCode::NOT_FOUND)
}
